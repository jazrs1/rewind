// The demo course's exams file (public/demo/course/exams.json), built by scripts/demo/export-demo.ts from the
// pipeline's exam finder output (private/pipeline/COP3530/exams.json), for the exam card behind
// NEXT_PUBLIC_REWIND_DEMO_EXAMS (lib/demo/exam-card.ts). Pure and deterministic. Exams only (not quizzes), and four
// fields each: the title, the date, what it covers, and the one word-for-word quote they come from. A title, date or
// coverage the quote doesn't say is dropped (null), so the card never shows a field the quote under it doesn't back.
// Nothing else: no rooms, URLs, Canvas ids, formats, notes rules or other announcement text.

import { kindOf } from "./deadlines.ts";

export const EXAMS_FILE = "exams.json";
/** The only keys an exam has (the unit test holds the committed file to these). */
export const EXAM_KEYS = ["date", "title", "coverage", "quote"] as const;

export interface DemoExam {
  /** "YYYY-MM-DD", or an ISO date-time with its offset when the quote gives the time and no other source disputes it. */
  date: string | null;
  title: string | null;
  /** What the exam covers, as the quote words it ("all modules"). */
  coverage: string[] | null;
  /** The sentence the fields come from, word for word. */
  quote: string;
}

export interface DemoExamsFile {
  course: string;
  exams: DemoExam[];
}

interface Field<T> {
  value: T | null;
  quote: string | null;
  itemId: string | null;
}

/** One exams.json entry, as much of it as this reads. */
export interface FoundExamInput {
  name: Field<string>;
  date: Field<string>;
  topics: Field<string[]>;
  conflicts?: { field: string; other: { value: unknown } }[];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Lower case, one space, plain dashes and quotes: for "does the quote say this". */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Only whitespace evened out: the quote must be in its source exactly as written. */
const spaced = (s: string) => s.replace(/\s+/g, " ").trim();

/** The quote names the date's day: "Nov 18", "November 18", "Nov. 18". */
export function saysDay(quote: string, day: string): boolean {
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const name = MONTHS[m - 1];
  if (!name) return false;
  return new RegExp(`\\b(?:${name}|${name.slice(0, 3)})\\.?\\s+${d}(?!\\d)`, "i").test(quote);
}

/** The quote gives the date-time's clock time, "8:20" (12-hour), read in its own offset. */
export function saysTime(quote: string, value: string): boolean {
  const t = value.match(/T(\d{2}):(\d{2})/);
  if (!t) return false;
  const h = Number(t[1]) % 12 || 12;
  return new RegExp(`(?<![\\d:])${h}:${t[2]}(?!\\d)`).test(quote);
}

/** A quote that may not ship as it is: a link, a long id, a room, or a name the redact list holds. */
export function quoteProblem(quote: string, hasName: (text: string) => boolean = () => false): string | null {
  if (/https?:|www\.|instructure|zoom\.us/i.test(quote)) return "a link in the quote";
  if (/\b\d{6,}\b/.test(quote)) return "an id in the quote";
  if (/\b(?:room|hall|building|bldg)\b/i.test(quote) || /\b[A-Z]{3,4}\s+[A-Z]?\d{3,4}\b/.test(quote)) return "a room in the quote";
  if (hasName(quote)) return "a name in the quote";
  return null;
}

/**
 * The exams file. `sourceText(itemId)` is the text of the course item a quote is from (null when it isn't known):
 * a quote that isn't in it word for word throws, so the file can't ship one. `hasName`: the quote carries a name the
 * redact list holds (lib/demo/export.ts redact); that exam is left out, since a quote can't be edited.
 */
export function buildDemoExams(course: string, exams: FoundExamInput[], sourceText: (itemId: string) => string | null, hasName: (text: string) => boolean = () => false): { file: DemoExamsFile; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const out: DemoExam[] = [];
  for (const e of exams) {
    const name = e.name.value?.trim() ?? "";
    if (!name || kindOf(name) !== "exam") {
      skip("not an exam");
      continue;
    }
    // The date's sentence when there is one (it drives the countdown), else the name's.
    const from = e.date.value && e.date.quote ? e.date : e.name;
    const quote = from.quote?.trim();
    if (!quote || !from.itemId) {
      skip("no quote");
      continue;
    }
    const text = sourceText(from.itemId);
    if (text === null || !spaced(text).includes(spaced(quote))) throw new Error(`exams: the quote for "${name}" isn't word for word in ${from.itemId}`);
    const problem = quoteProblem(quote, hasName);
    if (problem) {
      skip(problem);
      continue;
    }

    const title = e.name.quote && norm(quote).includes(norm(name)) ? name.replace(/^./, (c) => c.toUpperCase()) : null;

    let date: string | null = null;
    const value = e.date.value;
    if (value && e.date.quote && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      const day = value.slice(0, 10);
      if (saysDay(quote, day)) {
        // The time only when the quote gives it and no other source gives the same day another time.
        const disputed = (e.conflicts ?? []).some((c) => c.field === "date" && String(c.other.value ?? "").slice(0, 10) === day && c.other.value !== value);
        date = value.length > 10 && saysTime(quote, value) && !disputed ? value : day;
      }
    }

    const topics = e.topics.value?.filter((t) => t.trim()) ?? [];
    const coverage = topics.length && e.topics.quote && topics.every((t) => norm(quote).includes(norm(t))) ? topics.map((t) => t.trim()) : null;

    if (!title && !date) {
      skip("the quote says neither its name nor its date");
      continue;
    }
    out.push({ date, title, coverage, quote });
  }
  return { file: { course, exams: out }, skipped };
}
