// Matches the lecturer's words to the day's slide pages by keyword overlap (no Gemini), so a
// tape knows which slides it covers and when.

import type { TranscriptSegment } from "../schema.ts";
import type { SlidePage, SlideSpan } from "./types.ts";

/** A segment counts for a page only with this many shared keywords... */
export const MIN_SHARED = 2;
/** ...and this many more than the next-best page ("matches clearly"). */
export const MIN_MARGIN = 1;

const STOP = new Set(
  ("about above after again also because been before being between both could does doing down during each " +
    "from further have having here into just like more most much only other over same should some such than " +
    "that their them then there these they this those through under until very want were what when where " +
    "which while will with would your okay right yeah gonna kind sort thing things going know think").split(" "),
);

/** Lowercase keywords of 4+ letters, minus stopwords, with a plural "s" dropped. */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

export function matchSlides(
  segments: TranscriptSegment[],
  slides: SlidePage[],
  opts: { minShared?: number; minMargin?: number } = {},
): SlideSpan[] {
  const minShared = opts.minShared ?? MIN_SHARED;
  const minMargin = opts.minMargin ?? MIN_MARGIN;
  const pages = slides.map((s) => keywords(s.text));
  // Words on more than half the pages (with 3+ pages) can't tell pages apart.
  const df = new Map<string, number>();
  for (const p of pages) for (const k of p) df.set(k, (df.get(k) ?? 0) + 1);
  const common = (k: string) => slides.length >= 3 && (df.get(k) ?? 0) > slides.length / 2;

  const spans = new Map<number, { from: number; to: number }>();
  for (const seg of segments) {
    const words = keywords(seg.text);
    let best = -1;
    let bestScore = 0;
    let second = 0;
    pages.forEach((p, i) => {
      let score = 0;
      for (const k of words) if (p.has(k) && !common(k)) score++;
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        best = i;
      } else if (score > second) {
        second = score;
      }
    });
    if (best < 0 || bestScore < minShared || bestScore - second < minMargin) continue;
    const cur = spans.get(best);
    spans.set(best, cur ? { from: Math.min(cur.from, seg.start), to: Math.max(cur.to, seg.end) } : { from: seg.start, to: seg.end });
  }
  return [...spans]
    .map(([i, t]) => ({ deck: slides[i].deck, page: slides[i].page, from: t.from, to: t.to }))
    .sort((a, b) => a.from - b.from || a.page - b.page);
}
