// What the Ask tab knows about the courses on this device, and the tool calls between the model and the browser.
// The page is given AskCourse[] (built on the server from the local course data in dev, from the demo bundle on the
// demo route); the tools (lib/ask/tools.ts) run over it in the browser, and only their results go to the model.

import type { PracticeSeed } from "../demo/types.ts";
import type { CourseTape } from "../course/types.ts";

export type DeadlineKind = "exam" | "quiz" | "programming-quiz" | "assignment" | "event";
export const DEADLINE_KINDS: DeadlineKind[] = ["exam", "quiz", "programming-quiz", "assignment", "event"];

/** One dated (or undated) item from the course's Canvas export or the pipeline's exams. */
export interface AskDeadline {
  id: string;
  kind: DeadlineKind;
  title: string;
  /** An ISO instant (Canvas due_at, an exam's date-time) or a bare YYYY-MM-DD; null when no date was found. */
  at: string | null;
  /** Where the date is from: "Canvas due date", or the quote's source ("syllabus"). */
  source: string;
  /** The word-for-word quote behind an exam's date, when it has one. */
  quote: string | null;
  /** Graded work (points in Canvas; every quiz and exam): its row opens the tutor in guide mode. Decided on the server. */
  graded: boolean;
  /** Where an ungraded row opens (that item's practice or study session); a graded row opens guide mode instead. */
  href: string | null;
}

/** A passage the search tool can return: a lecture window, a slide or document page, or a Canvas page. */
export type AskPassage =
  | { kind: "lecture"; lecture: string; date: string | null; lines: { start: number; end: number; text: string }[] }
  | { kind: "slide"; deck: string; page: number; pageKind: "slide" | "page"; text: string; href: string | null; image?: string }
  | { kind: "page"; title: string; text: string; href: string | null };

export interface AskBank {
  seed: PracticeSeed;
  /** Questions that are graded work (lib/tutor/graded.ts on the server): never in a practice set. */
  gradedIds: string[];
  /** The Course tape, for ranking topics by stressed × missed (null: rank by the student's misses only). */
  tape: CourseTape | null;
  /** Per question: its lecture's date and tape shell, for the rewind chip. */
  moments: Record<string, { date: string | null; shell: 1 | 2 | 3 | 4 | null }>;
  /** Hosted clips by question id (the demo's). */
  media: Record<string, { src: string; offset: number; end?: number }>;
}

export interface AskCourse {
  /** The course code, as the attempt store keys it ("COP3530"). */
  id: string;
  code: string;
  title: string;
  /** What the student calls it: "dsa", "data structures", "kapoor" (lib/ask/nicknames.ts). */
  nicknames: string[];
  lecturer: string | null;
  /** Its colour (1..4, the tape shells), by course order on this device. */
  shell: 1 | 2 | 3 | 4;
  deadlines: AskDeadline[];
  /** Where dates were looked for, for the honest "No date for X" answer. */
  searched: string[];
  material: AskPassage[];
  bank: AskBank | null;
  /** The course's study session and practice, for open_study and a deadline row without its own link. */
  studyHref: string | null;
  practiceHref: string | null;
}

export const TOOL_NAMES = ["list_courses", "list_deadlines", "search_course", "get_questions", "open_study"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** A tool call as the model writes it: every field present (unused ones empty), so the schema stays strict. */
export interface ToolCall {
  tool: ToolName;
  course: string;
  courses: string[];
  query: string;
  from: string;
  to: string;
  kinds: DeadlineKind[];
  topics: string[];
  n: number;
  exam: string;
}

/** One tool round of a turn: what the model asked for, and the results the browser sends back (JSON text each). */
export interface ToolRound {
  calls: ToolCall[];
  results: string[];
}

export const MAX_TOOL_ROUNDS = 3;
export const MAX_CALLS_PER_ROUND = 4;
