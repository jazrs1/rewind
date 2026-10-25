// Record-a-lecture pipeline (T11): phone recording chunks -> a tape with only the lecturer's
// voice, real word-level times, and the slides it covers. Pure functions plus one entry point;
// transcription is injected (lib/gemini.ts transcribe in the app, a fake in tests).

import type { Transcription } from "../gemini.ts";
import type { TranscriptSegment } from "../schema.ts";
import { matchSlides } from "./slides.ts";
import type { LectureTape, RecordingChunk, SkippedChunk, SlidePage, TimedWord, TranscribeFn } from "./types.ts";

export const PAUSE_SPLIT_SEC = 1.5;
export const SENTENCE_SPLIT_AFTER_SEC = 12;
export const LECTURER = "Lecturer";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Diarization label for each word. Words carry no speaker, only the turns do, so a word takes
 * the turn its midpoint falls in (or the nearest turn). If the turns have no times, they are
 * matched in order by word count.
 */
export function labelWords(t: Transcription): (string | null)[] {
  const turns = t.turns ?? [];
  if (!turns.length) return t.words.map(() => null);
  const timed = turns.every((u) => typeof u.start === "number" && typeof u.end === "number");
  if (timed) {
    return t.words.map((w) => {
      const mid = (w.start + w.end) / 2;
      let best = turns[0];
      let bestDist = Infinity;
      for (const u of turns) {
        const s = u.start as number;
        const e = u.end as number;
        const dist = mid < s ? s - mid : mid > e ? mid - e : 0;
        if (dist < bestDist) {
          best = u;
          bestDist = dist;
        }
      }
      return best.speaker;
    });
  }
  const labels: (string | null)[] = [];
  for (const u of turns) {
    const n = u.text.split(/\s+/).filter(Boolean).length;
    for (let i = 0; i < n && labels.length < t.words.length; i++) labels.push(u.speaker);
  }
  while (labels.length < t.words.length) labels.push(turns[turns.length - 1].speaker);
  return labels;
}

/** Puts every chunk's words on the recording's timeline (chunk startSec + word time). */
export function stitch(chunks: RecordingChunk[], transcriptions: Transcription[]): TimedWord[] {
  const out: TimedWord[] = [];
  chunks.forEach((c, i) => {
    const t = transcriptions[i];
    const labels = labelWords(t);
    t.words.forEach((w, j) => {
      out.push({ word: w.word, start: round2(c.startSec + w.start), end: round2(c.startSec + w.end), chunk: c.index, label: labels[j] });
    });
  });
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Labels restart per chunk, so they are linked by one rule: in each chunk, the label with the
 * most speech (sum of word durations) is the lecturer. Ties go to the label that speaks first.
 */
export function lecturerLabels(words: TimedWord[]): Map<number, string | null> {
  const talk = new Map<number, Map<string | null, { seconds: number; first: number }>>();
  for (const w of words) {
    const byLabel = talk.get(w.chunk) ?? new Map();
    talk.set(w.chunk, byLabel);
    const cur = byLabel.get(w.label) ?? { seconds: 0, first: w.start };
    cur.seconds += Math.max(0, w.end - w.start);
    byLabel.set(w.label, cur);
  }
  const out = new Map<number, string | null>();
  for (const [chunk, byLabel] of talk) {
    let best: string | null = null;
    let bestTalk: { seconds: number; first: number } | null = null;
    for (const [label, t] of byLabel) {
      if (!bestTalk || t.seconds > bestTalk.seconds + 1e-9 || (Math.abs(t.seconds - bestTalk.seconds) <= 1e-9 && t.first < bestTalk.first)) {
        best = label;
        bestTalk = t;
      }
    }
    out.set(chunk, best);
  }
  return out;
}

/** A chunk's top speaker is the lecturer only with at least this share of its speech. */
export const LECTURER_MAJORITY = 0.6;
/** With continuity across the chunk boundary, this share is enough. */
export const CONTINUITY_MIN_SHARE = 0.4;
/** "Continuous" = the lecturer's last words and the next chunk's first words within this of the boundary. */
export const CONTINUITY_WINDOW_SEC = 2;

export interface LecturerDecision {
  /** Chunk index -> the lecturer's label in that chunk. Chunks not in the map have no lecturer. */
  lecturer: Map<number, string | null>;
  skipped: SkippedChunk[];
}

/**
 * Privacy guard (T11b): who is the lecturer in each chunk, or drop the chunk. UF policy: other
 * students' voices are never stored, so when unsure, drop.
 * - The top speaker counts only with at least 60% of the chunk's speech.
 * - Otherwise, continuity: if the previous chunk's lecturer spoke within 2 s before the boundary
 *   and this chunk's first words are within 2 s after it, that first speaker is the lecturer,
 *   provided they have at least 40% and are also this chunk's top speaker.
 * - Otherwise the whole chunk is skipped ("unclear speaker").
 */
export function decideLecturers(words: TimedWord[], chunks: RecordingChunk[]): LecturerDecision {
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  const lecturer = new Map<number, string | null>();
  const skipped: SkippedChunk[] = [];
  ordered.forEach((c, i) => {
    const mine = words.filter((w) => w.chunk === c.index);
    if (!mine.length) return; // silence: nothing to keep or skip
    const talk = new Map<string | null, number>();
    for (const w of mine) talk.set(w.label, (talk.get(w.label) ?? 0) + Math.max(0, w.end - w.start));
    const total = [...talk.values()].reduce((a, b) => a + b, 0);
    const top = lecturerLabels(mine).get(c.index) ?? null;
    const share = (label: string | null) => (total > 0 ? (talk.get(label) ?? 0) / total : 0);

    if (share(top) >= LECTURER_MAJORITY) {
      lecturer.set(c.index, top);
      return;
    }
    const prev = ordered[i - 1];
    if (prev && prev.index === c.index - 1 && lecturer.has(prev.index)) {
      const prevLabel = lecturer.get(prev.index);
      const prevEnd = Math.max(...words.filter((w) => w.chunk === prev.index && w.label === prevLabel).map((w) => w.end));
      const first = mine[0];
      const boundary = c.startSec;
      const continuous = boundary - prevEnd <= CONTINUITY_WINDOW_SEC && first.start - boundary <= CONTINUITY_WINDOW_SEC;
      if (continuous && first.label === top && share(top) >= CONTINUITY_MIN_SHARE) {
        lecturer.set(c.index, top);
        return;
      }
    }
    const next = ordered[i + 1];
    const endSec =
      typeof c.durationSec === "number" ? c.startSec + c.durationSec : next ? next.startSec : Math.max(...mine.map((w) => w.end));
    skipped.push({ index: c.index, startSec: c.startSec, endSec: round2(endSec), reason: "unclear speaker" });
  });
  return { lecturer, skipped };
}

const SENTENCE_END = /[.?!]["')\]]*$/;

/**
 * Words -> segments. A new segment starts at a speaker change, after a pause over 1.5 s, or
 * after a sentence end once the segment has passed 12 s. Times are the words' own (real).
 */
export function buildSegments(words: { word: string; start: number; end: number; speaker: string }[]): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  let cur: { start: number; end: number; speaker: string; words: string[]; closed: boolean } | null = null;
  const flush = () => {
    if (cur) segs.push({ start: cur.start, end: cur.end, speaker: cur.speaker, text: cur.words.join(" ") });
    cur = null;
  };
  for (const w of words) {
    if (cur && (cur.closed || cur.speaker !== w.speaker || w.start - cur.end > PAUSE_SPLIT_SEC)) flush();
    if (!cur) cur = { start: w.start, end: w.end, speaker: w.speaker, words: [], closed: false };
    cur.words.push(w.word);
    cur.end = Math.max(cur.end, w.end);
    if (SENTENCE_END.test(w.word) && cur.end - cur.start > SENTENCE_SPLIT_AFTER_SEC) cur.closed = true;
  }
  flush();
  return segs;
}

/** The whole pipeline: transcribe each chunk, stitch, keep the lecturer, match slides. */
export async function processRecording(
  chunks: RecordingChunk[],
  slides: SlidePage[],
  opts: { transcribe: TranscribeFn; title?: string },
): Promise<LectureTape> {
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  const transcriptions: Transcription[] = [];
  for (const c of ordered) transcriptions.push(await opts.transcribe(c.path, { diarization: true }));

  const stitched = stitch(ordered, transcriptions);
  const { lecturer, skipped } = decideLecturers(stitched, ordered);
  // Skipped chunks are dropped whole, lecturer included; nothing from them is kept or measured.
  const words = stitched.filter((w) => lecturer.has(w.chunk));
  const isLecturer = (w: TimedWord) => lecturer.has(w.chunk) && lecturer.get(w.chunk) === w.label;
  // Other speakers keep a chunk-local key only so their speech is segmented and measured.
  const all = buildSegments(
    words.map((w) => ({ ...w, speaker: isLecturer(w) ? LECTURER : `other:${w.chunk}:${w.label}` })),
  );
  // Never keep a segment from anyone but the linked lecturer.
  const segments = all.filter((s) => s.speaker === LECTURER);
  const dropped = all.filter((s) => s.speaker !== LECTURER);

  // Labels can't be linked across chunks for students, so count the most seen in any one chunk.
  const othersPerChunk = new Map<number, Set<string | null>>();
  for (const w of words) {
    if (isLecturer(w)) continue;
    const set = othersPerChunk.get(w.chunk) ?? new Set();
    set.add(w.label);
    othersPerChunk.set(w.chunk, set);
  }

  const last = ordered[ordered.length - 1];
  const lastWordEnd = Math.max(last ? last.startSec : 0, ...stitched.filter((w) => last && w.chunk === last.index).map((w) => w.end));
  const durationSec = last && typeof last.durationSec === "number" ? round2(last.startSec + last.durationSec) : round2(lastWordEnd);

  return {
    source: "phone",
    recordingUrl: "",
    title: opts.title ?? "Recorded lecture",
    recordedAt: ordered[0]?.recordedAt ?? null,
    durationSec,
    segments,
    dropped: {
      speakers: Math.max(0, ...[...othersPerChunk.values()].map((s) => s.size)),
      seconds: round1(dropped.reduce((sum, s) => sum + (s.end - s.start), 0)),
    },
    skipped,
    slides: matchSlides(segments, slides),
  };
}
