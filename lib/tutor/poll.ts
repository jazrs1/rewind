// Which chips may show (coordinator reviews on PR #3, and John's rules). A chip carries its quote in its title, label and
// data, a slide chip opens the slide and a lecture chip plays the moment, so a chip can give the answer away as surely
// as the reply's words:
//   - graded work: no chips at all, on every path (live, saved, answered or not);
//   - before the student answers, in every mode: no chip whose quote gives the answer away (revealsAnswer); no poll or
//     answer slide (`revealsAnswer: true` on the slide, or its own words); never the question's own slide; and never a
//     lecture moment inside the question's explanation window (where he explains this question's answer). A hint may
//     link an earlier moment where he introduces the idea instead (lib/tutor/service.ts introMoment). The explanation
//     moment and the question's own slide unlock once the student has answered.
// A hint replaced for leaking gets no chips (lib/tutor/service.ts).

import type { SeedQuestion } from "../demo/types.ts";
import type { Grounded } from "./claims.ts";
import { revealsAnswer } from "./integrity.ts";

export const POLL_WORDS = /\bpoll(?:\s+(?:question|results?))?\b|\banswer\s*(?:key|slide|reveal)\b|\banswers?\s*:|\bsolutions?\b|\bcorrect answer\b/i;

/** A poll or answer slide: marked as one, or saying so in its own words. */
export function isAnswerSlide(slide: { revealsAnswer?: boolean }, text = ""): boolean {
  return slide.revealsAnswer === true || POLL_WORDS.test(text);
}

/** The slide's page render (a URL the page can show), or undefined for a Canvas page of text. */
export function slideImageOf(q: SeedQuestion): string | undefined {
  const image = q.match.slide.image;
  if (!image) return undefined;
  return /^(\/|https?:\/\/)/.test(image) ? image : `/api/dev-slides/${image}`;
}

/** Where a slide chip opens: the deck in Canvas when the export has it, else the slide image. */
export function slideLinkOf(q: SeedQuestion): string | undefined {
  const s = q.match.slide;
  if (s.canvasUrl) return s.canvasUrl;
  if (!s.image) return undefined;
  return /^(\/|https?:\/\/)/.test(s.image) ? s.image : `/api/dev-slides/${s.image}`;
}

export interface ChipContext {
  /** The student has answered the question (marked and checked). */
  answered: boolean;
  graded: boolean;
  /** The chips are for a hint. */
  hint: boolean;
}

/** Is this chip the question's own slide (the slide its quote is from, or its matched slide). */
export function ownSlide(g: Grounded, q: SeedQuestion): boolean {
  if (g.kind !== "slide") return false;
  const w = q.source?.where;
  return (w?.kind === "slide" && w.deck === g.deck && w.page === g.page) || (q.match.slide.deck === g.deck && q.match.slide.page === g.page);
}

/**
 * Where he explains this question's answer, in seconds of the lecture: the retrieved clip (match.start to match.end),
 * widened to take in the question's own lecture quote. Null when the question has neither.
 */
export function explanationWindow(q: SeedQuestion): { start: number; end: number } | null {
  const { start, end } = q.match as { start: number | null; end: number | null };
  const w = q.source?.where;
  const quote = q.source && w?.kind === "lecture" ? { start: w.start, end: (w as { end?: number }).end ?? w.start } : null;
  const starts = [typeof start === "number" ? start : null, quote?.start ?? null].filter((x): x is number => x !== null);
  const ends = [typeof end === "number" ? end : null, quote?.end ?? null].filter((x): x is number => x !== null);
  if (!starts.length) return null;
  return { start: Math.min(...starts), end: Math.max(...ends, ...starts) };
}

/** A lecture moment inside the explanation window. */
export function inExplanation(g: Grounded, q: SeedQuestion): boolean {
  if (g.kind !== "lecture") return false;
  const w = explanationWindow(q);
  return !!w && g.start >= w.start && g.start <= w.end;
}

/** A slide chip opens the slide on screen (slideLinkOf), so it may only carry that slide's deck and page. */
export function onShownSlide(g: Grounded, q: SeedQuestion): boolean {
  return g.kind !== "slide" || (q.match.slide.deck === g.deck && q.match.slide.page === g.page);
}

/** The chips that may show, in order. */
export function safeChips(grounded: Grounded[], q: SeedQuestion, c: ChipContext): Grounded[] {
  if (c.graded) return [];
  const shown = grounded.filter((g) => onShownSlide(g, q));
  if (c.answered) return shown;
  return shown.filter((g) => {
    if (revealsAnswer(g.quote, q)) return false;
    if (g.kind === "slide" && (g.revealsAnswer || ownSlide(g, q) || isAnswerSlide({}, g.quote))) return false;
    if (inExplanation(g, q)) return false;
    return true;
  });
}
