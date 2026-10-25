// The demo course's deadlines file (public/demo/course/deadlines.json), built by scripts/demo/export-demo.ts from the
// pipeline's exam finder output (private/pipeline/COP3530/exams.json). Pure and deterministic. The shape is the one the
// Ask tab reads (lib/ask/demo-deadlines.ts on ask-tab-2): one row per quiz or exam, its title, kind, when, and where
// that came from. Nothing else: no quotes, descriptions, rooms, URLs or Canvas ids.

export const DEADLINES_FILE = "deadlines.json";
export const DEADLINE_KINDS = ["quiz", "programming-quiz", "exam"] as const;
export const DEADLINE_SOURCES = ["Announcement", "Syllabus", "Canvas due date"] as const;
/** The only keys a row has (the unit test holds the committed file to these). */
export const DEADLINE_KEYS = ["id", "title", "kind", "at", "source"] as const;

export interface DeadlineRow {
  id: string;
  title: string;
  kind: (typeof DEADLINE_KINDS)[number];
  /** ISO date-time with its offset, or null when the course gives no date. */
  at: string | null;
  source: (typeof DEADLINE_SOURCES)[number];
}

export interface DeadlinesFile {
  course: string;
  deadlines: DeadlineRow[];
}

/** One exams.json entry, as much of it as this reads. */
interface FoundExam {
  id: string;
  name: { value: string; itemId: string | null };
  date: { value: string | null; itemId: string | null };
}

/** "Exam 1", "common make-up for both exams" → exam; "Programming Quiz 8", "PQ2A" → programming-quiz; else quiz. */
export function kindOf(title: string): DeadlineRow["kind"] {
  if (/\bexams?\b|\bmake-?up\b|\bfinal\b|\bmidterm\b/i.test(title)) return "exam";
  if (/\bprogramming quiz\b|^PQ\d/i.test(title)) return "programming-quiz";
  return "quiz";
}

/**
 * Where the row came from, by the Canvas item it was found in: an announcement, the syllabus (a file), or the
 * assignment itself (an assignment, or a module page linking to it).
 */
export function sourceOf(itemId: string | null, syllabusFiles: string[]): DeadlineRow["source"] {
  if (itemId?.startsWith("announcement:")) return "Announcement";
  if (itemId?.startsWith("file:") && syllabusFiles.includes(itemId)) return "Syllabus";
  return "Canvas due date";
}

/** The America/New_York offset ("-04:00" or "-05:00") at noon UTC on a date: the course's time zone. */
export function easternOffset(date: string): string {
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  return tz.replace(/^GMT/, "") || "+00:00";
}

/**
 * The row's time. A date-time keeps its own offset. A bare date ("due Aug 28") is due at 11:59 pm Eastern that day,
 * Canvas's default due time: the Ask tab reads only date-times with an offset. No date stays null.
 */
export function atOf(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T23:59:00${easternOffset(value)}`;
  return null;
}

/** The deadlines file from the exam finder's output; `syllabusFiles` are the itemIds of the syllabus PDFs. */
export function buildDeadlines(course: string, exams: FoundExam[], syllabusFiles: string[]): DeadlinesFile {
  const seen = new Set<string>();
  const deadlines: DeadlineRow[] = [];
  for (const e of exams) {
    const title = e.name.value.trim().replace(/^./, (c) => c.toUpperCase());
    const id = e.id.replace(/^exam:/, "");
    if (!title || !id || seen.has(id)) continue;
    seen.add(id);
    deadlines.push({ id, title, kind: kindOf(title), at: atOf(e.date.value), source: sourceOf(e.date.itemId ?? e.name.itemId, syllabusFiles) });
  }
  return { course, deadlines };
}
