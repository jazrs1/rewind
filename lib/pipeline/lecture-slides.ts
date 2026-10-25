// The slide a lecture question may show (pure). John, Oct 24: the lecturer never opens the Discussion slides in
// lecture (they're for the TA sections), so a question from a lecture shows a page of that lecture's own numbered
// deck ("6 - Sorting"), never a Discussion, Review or game deck. retrieve.ts applies it when it picks the slide;
// scripts/demo/repick-lecture-slides.ts applied it once to the COP3530 output. No model calls here: pages are ranked
// by the embeddings the index already has.

import { cosine } from "../rewind.ts";

/** A numbered lecture deck ("6 - Sorting", "8a - Graph Terminology…"): never a Discussion, Review or game deck. */
export const isLectureDeck = (deck: string) => /^\s*\d{1,2}[a-z]?\s*[-–]\s*\S/.test(deck) && !/review|jeopardy|jeapordy/i.test(deck);

/**
 * A page shown beside a lecture question must score at least this: the slide timeline's "on this slide" line
 * (lib/demo/topic-stats.ts OFF_SLIDES, a lecturer window against its closest page). Under it, no slide.
 */
export const LECTURE_SLIDE_MIN = 0.68;

/** The evidence a page is ranked by: the clip's lecturer windows (what he says there) and the quote's own page. */
export interface PageSignals {
  /** Vectors of the index windows the clip overlaps (empty: no clip). */
  windowVecs: number[][];
  /** Vector of the page the quote is from (null: the quote isn't from an indexed page). */
  quoteVec: number[] | null;
}

/**
 * Candidate pages (indexes into pageVecs), best first. A page's score is the mean of the signals there are: its mean
 * similarity to the clip's windows, and its similarity to the quote's page. No signal, no ranking.
 */
export function rankLecturePages(pageVecs: number[][], candidates: number[], s: PageSignals): { page: number; score: number; clip: number | null; quote: number | null }[] {
  if (!s.windowVecs.length && !s.quoteVec) return [];
  return candidates
    .map((page) => {
      const v = pageVecs[page];
      const clip = s.windowVecs.length ? s.windowVecs.reduce((a, w) => a + cosine(w, v), 0) / s.windowVecs.length : null;
      const quote = s.quoteVec ? cosine(s.quoteVec, v) : null;
      const parts = [clip, quote].filter((x): x is number => x !== null);
      return { page, score: parts.reduce((a, b) => a + b, 0) / parts.length, clip, quote };
    })
    .sort((a, b) => b.score - a.score || a.page - b.page);
}

const STOP = new Set(["and", "the", "of", "for", "in", "on", "to", "a", "an", "module", "discussion", "review", "exam", "lecture", "intro", "introduction"]);
/** A title's topic words: lowercased, the number and stop words gone, a plural "s" and an "-ic" ending dropped ("Algorithmic" ~ "Algorithm"). */
export function titleWords(title: string): Set<string> {
  const words = title
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^\s*(?:discussion|module)?\s*\d+[a-z]?\s*[-–_:]?\s*/, "")
    .match(/[a-z]{2,}/g) ?? [];
  return new Set(words.filter((w) => !STOP.has(w)).map((w) => w.replace(/(?<=..)s$/, "").replace(/(?<=....)ic$/, "")));
}

/** The deck among `decks` whose title shares the most topic words with `title` (Jaccard), or null on none or a tie. */
export function closestDeck(title: string, decks: string[]): string | null {
  const a = titleWords(title);
  const scored = decks
    .map((d) => {
      const b = titleWords(d);
      const shared = [...a].filter((w) => b.has(w)).length;
      return { d, j: shared / (a.size + b.size - shared || 1) };
    })
    .filter((x) => x.j > 0)
    .sort((x, y) => y.j - x.j);
  if (!scored.length || scored[1]?.j === scored[0].j) return null;
  return scored[0].d;
}

/**
 * The numbered deck of a non-lecture deck's module, for a question with no lecture: "Discussion 8 - Sorting" is in
 * Module 8 ("Sorting"), whose numbered deck is "6 - Sorting". The module's topic picks the deck; when the module
 * isn't known or names no deck (a review week), the deck's own title does; null when neither picks one.
 */
export function moduleDeck(deck: string, modules: { position: number; topic: string }[], numbered: string[]): string | null {
  const n = deck.match(/^\s*discussion\s+(\d+)/i)?.[1];
  const mod = n ? modules.find((m) => m.position === Number(n)) : undefined;
  return (mod && closestDeck(mod.topic, numbered)) || closestDeck(deck, numbered);
}
