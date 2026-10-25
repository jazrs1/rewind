// The demo tutor's saved replies (the part the page uses; no server code): for each demo question a Hint 1, Hint 2, a Socratic follow-up, a confirm and the
// answer, written ahead of time by scripts/demo/precompute-tutor.ts (same prompt, same integrity and quote checks
// as the live tutor) into public/demo/course/tutor.json. The page plays one of them when the live tutor is capped,
// errors, or is slower than 8 seconds, so the demo never breaks.

import type { SavedQuestion, SavedReply } from "../../components/tutor/types.ts";
import type { SimilarCard } from "../tutor/similar.ts";

export const SAVED_FORMAT = "rewind-demo-tutor/1";
export const SAVED_URL = "/demo/course/tutor.json";
/** The live tutor gets this long to start answering before the saved reply is played. */
export const FIRST_TOKEN_MS = 8000;

export interface SavedFile {
  format: typeof SAVED_FORMAT;
  /** The model that wrote them ("claude-sonnet-5-5", or "fake" in tests). */
  model: string;
  questions: Record<string, SavedQuestion>;
}

/** What to say when there is no saved entry for a question (or the file isn't there): honest, and no course claim. */
export const GENERIC_SAVED: SavedReply = {
  text: "The live tutor is busy right now. Look at the slide and the lecture clip for this question, say in your own words what it asks, and try again in a minute.",
  grounded: [],
};

export const NEEDS_ANSWER = "Mark your answer and check it first, and then I can show you the answer.";

export type SavedKind = "hint" | "reply" | "answer";
export type Picked = { kind: SavedKind; reply: SavedReply } | { refuse: string };

/**
 * Which saved reply answers this request. A hint: the first, then the second. A typed message: the Socratic
 * follow-up first, then the confirm. The answer (asked for, or a third hint) only once the student has checked one.
 */
export function pickSaved(entry: SavedQuestion | undefined, o: { request: "hint" | "answer" | "reply"; hintsUsed: number; repliesUsed: number; marked: boolean }): Picked {
  if (o.request === "answer" || (o.request === "hint" && o.hintsUsed >= 2)) {
    return o.marked ? { kind: "answer", reply: entry?.answer ?? GENERIC_SAVED } : { refuse: NEEDS_ANSWER };
  }
  if (o.request === "hint") return { kind: "hint", reply: (o.hintsUsed === 0 ? entry?.hint1 : entry?.hint2) ?? GENERIC_SAVED };
  return { kind: "reply", reply: (o.repliesUsed === 0 ? entry?.socratic : entry?.confirm) ?? GENERIC_SAVED };
}


/** No saved similar question for this one: said plainly, with no course claim and no card. */
export const NO_SAVED_SIMILAR = "The live tutor is busy, and I don't have a new question saved for this one. Try the hint, or ask again in a minute.";
/** The live similar question failed its checks (shared numbers, the same answer, an ungrounded source). */
export const SIMILAR_DROPPED = "I couldn't make a good new version of this one. Try a hint, or ask what confuses you.";
/** A daily cap (per visitor, per IP or for the whole site): never "busy". */
export const CAP_REACHED = "The live tutor has hit today's limit. Try a hint.";
const CAPS = new Set(["visitor", "ip-day", "day-calls", "day-budget"]);

/** What to say when there is nothing saved to play, matched to why the live call didn't answer. "Busy" only when it was. */
export function fallbackCopy(why: string | null, request: "hint" | "answer" | "reply" | "similar"): string {
  if (why && CAPS.has(why)) return CAP_REACHED;
  if (why === "similar") return SIMILAR_DROPPED;
  return request === "similar" ? NO_SAVED_SIMILAR : GENERIC_SAVED.text;
}

/** The saved similar question to play after `asked` earlier ones (they take turns), or null when there is none. */
export function pickSavedSimilar(entry: SavedQuestion | undefined, asked: number): SimilarCard | null {
  const list = entry?.similar ?? [];
  return list.length ? list[asked % list.length] : null;
}
