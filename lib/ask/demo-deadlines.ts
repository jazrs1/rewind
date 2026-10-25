// The demo course's deadlines: public/demo/course/deadlines.json (docs/briefs/ask-tab-notes.md), one row per item:
//   { "course": "COP3530", "deadlines": [ { "id", "title", "kind": "quiz" | "programming-quiz" | "exam",
//     "at": ISO date-time with its offset, or null, "source": "Announcement" | "Syllabus" | "Canvas due date" } ] }
// Checked here field by field; a row that doesn't fit the shape is left out (and named by validateDeadlinesFile). Quizzes
// and exams are graded work: their rows carry the Graded tag and open the tutor in guide mode. Decided here, on the
// server, from the file's kind, never by the page or the model.

import type { AskDeadline, DeadlineKind } from "./types.ts";

export const DEADLINES_FILE = "deadlines.json";
export const DEADLINE_SOURCES = ["Announcement", "Syllabus", "Canvas due date"] as const;
const KINDS: DeadlineKind[] = ["quiz", "programming-quiz", "exam"];
/** An ISO date-time carrying its offset (Z or ±hh:mm): read in Eastern time. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface DeadlinesFile {
  course: string;
  deadlines: { id: string; title: string; kind: DeadlineKind; at: string | null; source: (typeof DEADLINE_SOURCES)[number] }[];
}

/** Every problem with a deadlines file (empty when it is sound). */
export function validateDeadlinesFile(raw: unknown, course?: string): string[] {
  const f = raw as Partial<DeadlinesFile> | null;
  if (!f || typeof f !== "object" || typeof f.course !== "string" || !Array.isArray(f.deadlines)) return ["not a deadlines file ({ course, deadlines: [] })"];
  const errors: string[] = [];
  if (course && f.course.replace(/\s+/g, "").toUpperCase() !== course.replace(/\s+/g, "").toUpperCase()) errors.push(`course is ${f.course}, not ${course}`);
  const ids = new Set<string>();
  f.deadlines.forEach((d, i) => {
    const at = `deadlines[${i}]`;
    if (!d || typeof d !== "object") return errors.push(`${at}: not an object`);
    if (typeof d.id !== "string" || !d.id) errors.push(`${at}: no id`);
    else if (ids.has(d.id)) errors.push(`${at}: id ${d.id} twice`);
    else ids.add(d.id);
    if (typeof d.title !== "string" || !d.title.trim()) errors.push(`${at}: no title`);
    if (!KINDS.includes(d.kind)) errors.push(`${at}: kind ${String(d.kind)} is not quiz, programming-quiz or exam`);
    if (d.at !== null && (typeof d.at !== "string" || !ISO_WITH_OFFSET.test(d.at) || Number.isNaN(Date.parse(d.at)))) errors.push(`${at}: at must be an ISO date-time with its offset, or null`);
    if (!DEADLINE_SOURCES.includes(d.source)) errors.push(`${at}: source must be one of ${DEADLINE_SOURCES.join(", ")}`);
    const extra = Object.keys(d).filter((k) => !["id", "title", "kind", "at", "source"].includes(k));
    if (extra.length) errors.push(`${at}: unexpected ${extra.join(", ")}`);
  });
  return errors;
}

/** The file's rows as the Ask tab's deadlines: sound rows only; quizzes and exams graded. */
export function deadlinesFromFile(raw: unknown): AskDeadline[] {
  const f = raw as Partial<DeadlinesFile> | null;
  if (!f || !Array.isArray(f.deadlines)) return [];
  return f.deadlines.flatMap((d) => {
    if (!d || typeof d.id !== "string" || typeof d.title !== "string" || !KINDS.includes(d.kind) || !DEADLINE_SOURCES.includes(d.source)) return [];
    const at = d.at === null || (typeof d.at === "string" && ISO_WITH_OFFSET.test(d.at) && !Number.isNaN(Date.parse(d.at))) ? d.at : undefined;
    if (at === undefined) return [];
    // Graded work (the notes: quizzes and exams count as graded); the row opens the tutor in guide mode, no link.
    return [{ id: `demo:${d.id}`, kind: d.kind, title: d.title.trim(), at, source: d.source, quote: null, graded: true, href: null }];
  });
}

/** Where the file's dates came from, for "No date for X (looked in: …)". */
export const DEMO_DEADLINES_SEARCHED = ["Canvas due dates", "announcements", "the syllabus"];
export const DEMO_NO_DEADLINES = ["the demo's deadlines file (not in this build yet)"];
