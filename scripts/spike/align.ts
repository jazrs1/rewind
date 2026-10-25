// Finds where a sentence really starts in a timed reference: Zoom's per-item times
// or word-level timestamps from Gemini Transcribe.

import type { TranscriptSegment } from "../../lib/schema.ts";

export interface TimedWord {
  word: string;
  start: number;
}

/** Lowercase word tokens. Splits words Zoom glued together ("valuesOkay?") and drops punctuation. */
export function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9][.?!,]?)([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Words of each segment, spread evenly across the segment's time. */
export function wordsFromSegments(segments: TranscriptSegment[]): TimedWord[] {
  return segments.flatMap((s) => {
    const ws = tokens(s.text);
    const span = Math.max(0, s.end - s.start);
    return ws.map((word, i) => ({ word, start: s.start + (span * i) / ws.length }));
  });
}

/**
 * Start time of `text` in `ref`: matches its first `n` tokens in order within a
 * window of 2n reference words. Returns null if under 60% of the tokens match.
 */
export function locate(text: string, ref: TimedWord[], n = 8): { start: number; score: number } | null {
  const target = tokens(text).slice(0, n);
  if (!target.length) return null;
  let best: { start: number; score: number } | null = null;
  for (let i = 0; i < ref.length; i++) {
    if (ref[i].word !== target[0] && ref[i].word !== target[1]) continue;
    let k = i;
    let matched = 0;
    let first = -1;
    for (const t of target) {
      for (let j = k; j < Math.min(ref.length, i + 2 * target.length); j++) {
        if (ref[j].word === t) {
          if (first < 0) first = j;
          matched++;
          k = j + 1;
          break;
        }
      }
    }
    const score = matched / target.length;
    if (first >= 0 && (!best || score > best.score)) best = { start: ref[first].start, score };
  }
  return best && best.score >= 0.6 ? best : null;
}
