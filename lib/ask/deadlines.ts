// Deadlines for the Ask tab: built once from the course's Canvas export (assignments, quizzes, calendar events) and
// the pipeline's exams (only dates with a word-for-word quote: lib/home/local.ts checkedExams), then listed by
// list_deadlines over an Eastern-time range computed in code (lib/ask/dates.ts). Nothing here guesses a date: an item
// without one is listed as "No date for X in your Canvas data", with where we looked.

import { daysBetween, daysLeftLabel, easternDay, inRange, resolveRange, timeLabel, weekdayLabel, type DayRange } from "./dates.ts";
import { resolveCourse } from "./nicknames.ts";
import type { AskCourse, AskDeadline, DeadlineKind } from "./types.ts";
import { DEADLINE_KINDS } from "./types.ts";

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const EXAM = /\b(?:exams?|midterms?|finals?|tests?)\b/i;
const QUIZ = /\bquiz(?:zes)?\b|^\s*CQ\s*\d+/i;
const NOT_EXAM = /\bpractice\b|\breview\b|\bcorrections?\b|\bextra credit\b/i;

export function kindOfTitle(title: string, fallback: DeadlineKind): DeadlineKind {
  if (EXAM.test(title) && !NOT_EXAM.test(title)) return "exam";
  if (QUIZ.test(title)) return "quiz";
  return fallback;
}

/** Canvas: graded when it carries points and isn't "not graded". */
const gradedInCanvas = (a: Raw) => a.grading_type !== "not_graded" && (num(a.points_possible) ?? 0) > 0;

export interface DeadlineSources {
  assignments?: Raw[];
  quizzes?: Raw[];
  calendar_events?: Raw[];
  /** The pipeline's exams, each field already checked against its quote. */
  exams?: { id: string; name: string | null; date: string | null; quote: string | null; source: string | null; searched: string[] }[];
  /** An exam's study session (?exam=<id>), and the course's own links. */
  hrefOf?: (d: Omit<AskDeadline, "href">, examId: string | null) => string | null;
}

/** Every deadline item a course has, and where we looked. */
export function buildDeadlines(src: DeadlineSources): { deadlines: AskDeadline[]; searched: string[] } {
  const out: AskDeadline[] = [];
  const searched: string[] = [];
  const href = (d: Omit<AskDeadline, "href">, examId: string | null = null) => src.hrefOf?.(d, examId) ?? null;
  const push = (d: Omit<AskDeadline, "href">, examId: string | null = null) => out.push({ ...d, href: href(d, examId) });
  const seenTitles = new Set<string>();
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

  // Exams with a quoted date win over the same exam's Canvas assignment (whose due_at is a submission window).
  for (const e of src.exams ?? []) {
    if (!e.name) continue;
    seenTitles.add(key(e.name));
    push(
      { id: `exam:${e.id}`, kind: kindOfTitle(e.name, "exam"), title: e.name, at: e.date, source: e.date ? (e.source ?? "course material") : "not found", quote: e.date ? e.quote : null, graded: true },
      e.id,
    );
    if (!e.date) for (const s of e.searched) if (!searched.includes(s)) searched.push(s);
  }
  if (src.assignments) searched.push("Canvas assignments");
  for (const a of src.assignments ?? []) {
    const title = str(a.name);
    if (!title || seenTitles.has(key(title))) continue;
    seenTitles.add(key(title));
    const kind = a.is_quiz_assignment === true ? "quiz" : kindOfTitle(title, "assignment");
    push({ id: `assignment:${String(a.id)}`, kind, title, at: str(a.due_at), source: "Canvas due date", quote: null, graded: gradedInCanvas(a) || kind === "exam" });
  }
  if (src.quizzes) searched.push("Canvas quizzes");
  for (const q of src.quizzes ?? []) {
    const title = str(q.title);
    if (!title || seenTitles.has(key(title))) continue;
    seenTitles.add(key(title));
    push({ id: `quiz:${String(q.id)}`, kind: kindOfTitle(title, "quiz"), title, at: str(q.due_at), source: "Canvas due date", quote: null, graded: (num(q.points_possible) ?? 0) > 0 });
  }
  if (src.calendar_events) searched.push("Canvas calendar events");
  for (const ev of src.calendar_events ?? []) {
    const title = str(ev.title);
    if (!title || seenTitles.has(key(title))) continue;
    seenTitles.add(key(title));
    const kind = kindOfTitle(title, "event");
    push({ id: `event:${String(ev.id)}`, kind, title, at: str(ev.start_at), source: "Canvas calendar", quote: null, graded: kind === "exam" });
  }
  return { deadlines: out, searched };
}

/** A deadline row as the card draws it (from the tool result, never from the model's words). */
export interface DeadlineRow {
  courseId: string;
  code: string;
  shell: 1 | 2 | 3 | 4;
  title: string;
  kind: DeadlineKind;
  day: string;
  /** "Sat, Oct 24 · 11:59 pm". */
  date: string;
  daysLeft: number;
  /** "in 6 days". */
  left: string;
  graded: boolean;
  source: string;
  /** An ungraded row's practice (or study session); null for a graded row, which opens guide mode instead. */
  href: string | null;
}

export interface DeadlineResult {
  range: DayRange;
  rows: DeadlineRow[];
  /** Items of the asked kinds with no date: "No date for X in your Canvas data". */
  undated: { code: string; title: string; kind: DeadlineKind }[];
  /** Per course, where we looked. */
  searched: { code: string; where: string[] }[];
  /** A course name that matched nothing (or more than one). */
  unknownCourse?: string;
}

const ALL: DeadlineKind[] = DEADLINE_KINDS;

/** list_deadlines: items in the range (by Eastern day), soonest first; undated ones named, never guessed. */
export function listDeadlines(
  courses: AskCourse[],
  args: { from: string; to: string; kinds: DeadlineKind[]; course: string },
  now: number,
  studentText: string,
): DeadlineResult | { error: string } {
  const range = resolveRange(args.from, args.to, now, studentText);
  if ("error" in range) return range;
  const kinds = args.kinds?.length ? args.kinds.filter((k) => ALL.includes(k)) : ALL;
  let pool = courses;
  let unknownCourse: string | undefined;
  if (args.course?.trim()) {
    const r = resolveCourse(args.course, courses);
    if ("course" in r) pool = [r.course];
    else unknownCourse = args.course;
  }
  const today = easternDay(now)!;
  const rows: DeadlineRow[] = [];
  const undated: DeadlineResult["undated"] = [];
  for (const c of pool) {
    for (const d of c.deadlines) {
      if (!kinds.includes(d.kind)) continue;
      if (!d.at) {
        if (d.kind !== "event") undated.push({ code: c.code, title: d.title, kind: d.kind });
        continue;
      }
      if (!inRange(d.at, range)) continue;
      const day = easternDay(d.at)!;
      const time = timeLabel(d.at);
      const daysLeft = daysBetween(today, day);
      rows.push({ courseId: c.id, code: c.code, shell: c.shell, title: d.title, kind: d.kind, day, date: `${weekdayLabel(day)}${time ? ` · ${time}` : ""}`, daysLeft, left: daysLeftLabel(daysLeft), graded: d.graded, source: d.source, href: d.graded ? null : (d.href ?? c.practiceHref) });
    }
  }
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.code.localeCompare(b.code) || a.title.localeCompare(b.title));
  return { range, rows, undated, searched: pool.map((c) => ({ code: c.code, where: c.searched })), ...(unknownCourse ? { unknownCourse } : {}) };
}

/** "No date for Exam 3 in your Canvas data (looked in: …)." The honest answer, written in code. */
export function noDateLine(title: string, code: string, where: string[]): string {
  return `No date for ${title} in your ${code} Canvas data${where.length ? ` (looked in: ${where.join(", ")})` : ""}.`;
}

/** "Mon Nov 2". */
const shortDay = (day: string) => weekdayLabel(day).replace(",", "");

/**
 * The answer's first line, written in code (never by the model): exams first, then how many other items are due.
 * "1 exam: Exam 2, Mon Nov 2, in 9 days. Also due: 3 graded items and 1 more."
 */
export function examSummary(r: Pick<DeadlineResult, "rows" | "range">): string {
  const exams = r.rows.filter((x) => x.kind === "exam");
  const others = r.rows.filter((x) => x.kind !== "exam");
  const lead = exams.length
    ? `${exams.length} exam${exams.length === 1 ? "" : "s"}: ${exams.map((e) => `${e.title}, ${shortDay(e.day)}, ${e.left}`).join("; ")}.`
    : `No exams ${r.range.label}.`;
  if (!others.length) return lead;
  const graded = others.filter((x) => x.graded).length;
  const rest = others.length - graded;
  const parts = [graded ? `${graded} graded item${graded === 1 ? "" : "s"}` : null, rest ? `${rest} ${graded ? "more" : `item${rest === 1 ? "" : "s"}`}` : null].filter(Boolean);
  return `${lead} Also due: ${parts.join(" and ")}.`;
}

/** What the model gets back: the rows' words and numbers, no links, no ids. */
export function deadlinesForModel(r: DeadlineResult): object {
  return {
    summary: examSummary(r),
    range: r.range.label,
    items: r.rows.map((x) => ({ course: x.code, title: x.title, kind: x.kind, date: x.date, days_left: x.daysLeft, graded: x.graded })),
    no_date: r.undated.map((u) => noDateLine(u.title, u.code, r.searched.find((s) => s.code === u.code)?.where ?? [])),
    ...(r.rows.length ? {} : { nothing_found: r.searched.map((s) => `Nothing dated ${r.range.label} in your ${s.code} Canvas data (looked in: ${s.where.join(", ") || "nothing: no Canvas export on this device"}).`) }),
    ...(r.unknownCourse ? { unknown_course: r.unknownCourse } : {}),
    note: "Start your answer with summary, word for word. The page shows the rows as a card under it (exams first, then Also due); don't repeat them, and never write a date that isn't here.",
  };
}
