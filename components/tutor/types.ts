// What the practice page tells the tutor panel.

import type { SeedQuestion } from "@/lib/demo/types";
import type { ChoiceLabel } from "@/lib/schema";
import type { Grounded } from "@/lib/tutor/claims";
import type { SimilarCard } from "@/lib/tutor/similar";

/** The graded assignment this practice is for (the course home's next quiz). */
export interface TutorAssignment {
  id: string;
  name: string;
  topics: string | null;
  /** "Oct 30", or null. */
  due: string | null;
}

/** A reply saved ahead of time for a demo question (public/demo/course/tutor.json), quote-checked when it was made. */
export interface SavedReply {
  text: string;
  grounded: Grounded[];
}
export interface SavedQuestion {
  hint1: SavedReply;
  hint2: SavedReply;
  socratic: SavedReply;
  confirm: SavedReply;
  answer: SavedReply;
  /** "Give me a similar one": new questions on the same idea, checked like a live one (new values, a word-for-word source). */
  similar?: SimilarCard[];
}

export interface TutorConfig {
  /** Where a turn is posted: /api/tutor (dev, local course data) or /api/demo/tutor (the public demo). */
  endpoint: string;
  /** The public demo: there is no graded work, and a saved reply stands in when the live tutor can't answer. */
  demo?: boolean;
  /** The practice set's query value (the dev API loads the same set). */
  set?: string;
  /** The open assignment, when there is one; the banner and header show it on the graded questions. */
  graded: TutorAssignment | null;
  /** The questions that are graded work, decided by the server. Everything else is practice. */
  gradedIds: string[];
  /** Per question id: the lecture's date (YYYY-MM-DD) and its tape shell, for the mini-tape chips. */
  moments: Record<string, { date: string | null; shell: 1 | 2 | 3 | 4 | null }>;
  /** The server-signed page-visit token (lib/tutor/sign.ts); sent with every dev request. */
  session: string;
}

export interface TutorTurn {
  id: number;
  role: "student" | "tutor";
  text: string;
  /** A request button ("Hint", "Show the answer") shown as a pill, not a bubble. */
  pill?: boolean;
  kind?: "hint" | "reply" | "answer";
  /** The server's signature on a tutor reply; sent back with the history so it is known to be the tutor's. */
  sig?: string;
  grounded?: Grounded[];
  streaming?: boolean;
  error?: boolean;
  /** A saved reply (the live tutor couldn't answer): labelled "Saved reply". */
  saved?: boolean;
  /** A new question on the same idea, answered in the chat (SimilarCard). */
  similar?: SimilarCard;
  /** What this turn stands for in the history, when that isn't its text (a similar question: the question too). */
  said?: string;
  /** A line the page added itself (not the model's): shown, never sent back. */
  note?: boolean;
  /** The question this turn was about (its signature is for that question). */
  qid?: string;
  /** The study session: the topic in focus when the turn was made. Its clips, chips and slides come from that topic only. */
  topic?: string;
  /** The study session's greeting after a topic switch (replaced, not stacked, when the student switches again first). */
  greeting?: boolean;
  /** The study session: a thin divider naming the topic switched to, after a conversation. */
  divider?: string;
  /** The study session: a practice question put in the chat by "Quiz me" (answered in place, no model call). */
  quiz?: string;
  /** The study session: a lecture moment put in the chat by a chip (played in place). */
  moment?: { questionId: string; start: number; quote: string };
}

export interface TutorQuestionContext {
  id: string;
  n: number;
  /** The deck's display name: what the question is about. */
  topic: string;
  marked: ChoiceLabel | null;
  /** The marked choice's text, for "Why is 3 wrong?". Null when right or unmarked. */
  wrongText: string | null;
  /** The slide link a "Slide N" chip opens. */
  slideHref: string;
  /** The moment the rewind landed on and its slide, shown as chips under the greeting so the empty panel points somewhere. */
  start?: number | null;
  slide?: { page: number; kind: "slide" | "page" } | null;
  /** The student has checked their answer (chips that show the answer may show from then on: lib/tutor/poll.ts). */
  answered: boolean;
  /** The question itself, which the page already has: its chips are checked against it (lib/tutor/poll.ts safeChips). */
  question: SeedQuestion;
}
