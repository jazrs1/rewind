// Turns long Zoom chunks into sentence segments with estimated times.
// The rule is part of the shared format in AGENT_TASKS.md; the worker's
// extractor implements the same rule in plain JS, so keep them in step.

import type { Transcript, TranscriptChunk, TranscriptSegment } from "./schema.ts";

export const SPLIT_OVER_SEC = 20;
const MIN_PIECE_CHARS = 20;
/** Speech is assumed no slower than this, so silence after a short item doesn't stretch it. */
export const MIN_CHARS_PER_SEC = 5;

function sentences(text: string): string[] {
  const pieces = text.split(/(?<=[.?!])\s+/).filter(Boolean);
  const merged: string[] = [];
  let carry = "";
  for (const p of pieces) {
    const piece = carry ? `${carry} ${p}` : p;
    if (piece.length < MIN_PIECE_CHARS) carry = piece;
    else {
      merged.push(piece);
      carry = "";
    }
  }
  if (carry) {
    if (merged.length) merged[merged.length - 1] += ` ${carry}`;
    else merged.push(carry);
  }
  return merged;
}

/**
 * Splits one chunk into sentences, placing each by its character position within the
 * chunk's speech span: the chunk's duration, capped at text length / 5 chars per second.
 */
export function splitChunk(chunk: TranscriptChunk): TranscriptSegment[] {
  const text = chunk.text.replace(/\s+/g, " ").trim();
  const base = { speaker: chunk.speaker };
  if (chunk.end - chunk.start <= SPLIT_OVER_SEC) return [{ ...base, start: chunk.start, end: chunk.end, text }];
  const parts = sentences(text);
  if (parts.length < 2) return [{ ...base, start: chunk.start, end: chunk.end, text }];

  const span = Math.min(chunk.end - chunk.start, text.length / MIN_CHARS_PER_SEC);
  const starts: number[] = [];
  let before = 0;
  for (const p of parts) {
    starts.push(before === 0 ? chunk.start : Math.round((chunk.start + (span * before) / text.length) * 10) / 10);
    before += p.length + 1; // the space that followed it
  }
  return parts.map((p, i) => ({
    ...base,
    start: starts[i],
    end: starts[i + 1] ?? chunk.end,
    text: p,
    ...(i > 0 ? { estimated: true } : {}),
  }));
}

/**
 * Makes sure segments are sentence-sized: any segment over 20 s is split, and the
 * originals are kept in `chunks`. Transcripts that are already fine come back unchanged.
 */
export function ensureSentences(t: Transcript): Transcript {
  if (!t.segments.some((s) => s.end - s.start > SPLIT_OVER_SEC)) return t;
  const chunks: TranscriptChunk[] = t.chunks ?? t.segments.map(({ start, end, speaker, text }) => ({ start, end, speaker, text }));
  return { ...t, segments: t.segments.flatMap((s) => (s.end - s.start > SPLIT_OVER_SEC ? splitChunk(s) : [s])), chunks };
}
