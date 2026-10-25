// Pure helpers for the rewind: cut a transcript into overlapping windows and
// rank them against a query embedding. No I/O, no Gemini.

import type { TranscriptSegment } from "./schema.ts";

export interface TranscriptWindow {
  index: number;
  /** Start of the first segment in the window, seconds. */
  start: number;
  /** End of the last segment in the window, seconds. */
  end: number;
  segments: TranscriptSegment[];
  text: string;
}

/**
 * Windows of `size` seconds every `step` seconds (40 s overlapping by 20 s by default).
 * A segment belongs to a window if it starts inside it. Empty windows are dropped.
 */
export function makeWindows(
  segments: TranscriptSegment[],
  size = 40,
  step = 20,
): TranscriptWindow[] {
  if (!segments.length) return [];
  const last = segments[segments.length - 1].start;
  const windows: TranscriptWindow[] = [];
  for (let t = Math.floor(segments[0].start); t <= last; t += step) {
    const inside = segments.filter((s) => s.start >= t && s.start < t + size);
    if (!inside.length) continue;
    const prev = windows[windows.length - 1];
    if (prev && prev.segments[0] === inside[0] && prev.segments.length === inside.length) continue;
    windows.push({
      index: windows.length,
      start: inside[0].start,
      end: inside[inside.length - 1].end,
      segments: inside,
      text: inside.map((s) => s.text).join(" "),
    });
  }
  return windows;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/**
 * Top `k` items by cosine similarity to `query`. With `minGap`, an item is skipped
 * when its start is within `minGap` seconds of one already picked, so candidates
 * are distinct moments rather than neighbouring overlaps of the same one.
 */
export function topK<T extends { start: number }>(
  query: number[],
  items: T[],
  vectors: number[][],
  k: number,
  minGap = 0,
): Ranked<T>[] {
  const ranked = items
    .map((item, i) => ({ item, score: cosine(query, vectors[i]) }))
    .sort((a, b) => b.score - a.score);
  const picked: Ranked<T>[] = [];
  for (const r of ranked) {
    if (picked.length >= k) break;
    if (minGap && picked.some((p) => Math.abs(p.item.start - r.item.start) < minGap)) continue;
    picked.push(r);
  }
  return picked;
}

/** The segment start at or just before `sec`, so playback begins on a sentence boundary. */
export function snapToSegment(segments: TranscriptSegment[], sec: number): number {
  let best = segments[0]?.start ?? sec;
  for (const s of segments) {
    if (s.start <= sec + 0.5) best = s.start;
    else break;
  }
  return best;
}

const STOPWORDS = new Set(
  "about after again also among another because been before being between both could does doing down during each every from have having here into just like more most much only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your he's she's they're it's".split(" "),
);

/** Framing words a summary needs ("he's walking through…") that state no fact about the lecture. */
const FRAME_WORDS = new Set(
  "walk walking walks going goes discuss discussing discusses explain explaining explains show showing shows work working works look looking looks consider considering considers start starting started talk talking talks cover covering covers review reviewing reviews trace tracing traces describe describing describes set setting sets ask asking asks answer answering answers happen happens happening middle example problem question professor student students determine determining determines find finding finds using uses present presenting presents gone walked discussed explained showed shown worked looked considered talked covered reviewed traced described asked answered happened determined found used presented".split(" "),
);

const NUMBER_WORDS: Record<string, string> = Object.fromEntries(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    .split(" ")
    .map((w, i) => [w, String(i)]),
);

/** Content words, with number words as digits. Numbers are facts, so they always count, whatever their length. */
function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? [])
    .map((w) => NUMBER_WORDS[w] ?? w)
    .filter((w) => /^\d+$/.test(w) || (w.length >= 4 && !STOPWORDS.has(w)));
}

/**
 * How much of a setup line is backed by its source lines: the share of its content words
 * (4+ letters, not stopwords or framing words like "walking through") whose first 4 letters
 * start a source word ("hashing" matches "hash"). A faithful summary scores near 1; invented
 * details (an unmentioned "whiteboard", a number) pull it down.
 */
export function setupGrounding(setup: string, sources: string[]): { score: number; unsupported: string[] } {
  const words = contentWords(setup).filter((w) => !FRAME_WORDS.has(w));
  const stem = (w: string) => (/^\d+$/.test(w) ? w : w.slice(0, 4));
  const stems = new Set(sources.flatMap(contentWords).map(stem));
  const unsupported = words.filter((w) => !stems.has(stem(w)));
  return { score: words.length ? 1 - unsupported.length / words.length : 0, unsupported };
}

/**
 * Numbers in a setup line, as digits or number words. Setups state none: a lecturer often says a
 * number and corrects it inside the clip (Oct 22 Q1: "0 to 10, total 11 values", corrected to 13),
 * and a setup must describe what he's doing, not repeat a figure he takes back.
 */
export function setupNumbers(setup: string): string[] {
  const words = setup.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return words.filter((w) => /^\d+$/.test(w) || w in NUMBER_WORDS);
}

/** A setup is shown only if every content word is backed by the lines (one invented "screen" is too many). */
export const MIN_GROUNDING = 1;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
