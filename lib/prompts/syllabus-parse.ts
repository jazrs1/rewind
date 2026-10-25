// Syllabus-parse prompt (T17): every exam and quiz a course announces, with each field tied to
// a word-for-word quote from one of the given sources. The answer is checked in code
// (lib/pipeline/exams.ts): a field whose quote isn't in its source becomes null ("not found").

export const VERSION = "syllabus-parse@2";

export interface ExamSourceText {
  /** Item id the model must cite, e.g. "syllabus:424244" or "announcement:123". */
  id: string;
  /** What kind of source and, for announcements, when it was posted. */
  label: string;
  text: string;
}

export interface QuotedField<T> {
  value: T | null;
  quote: string | null;
  sourceId: string | null;
}

export interface ParsedExam {
  name: QuotedField<string>;
  /** ISO 8601 with the Eastern offset, e.g. 2026-11-05T20:00:00-05:00; date only if no time is given. */
  date: QuotedField<string>;
  location: QuotedField<string>;
  format: QuotedField<string>;
  notesRule: QuotedField<"printed" | "handwritten" | "none">;
  topics: QuotedField<string[]>;
}

export interface SyllabusParseReply {
  exams: ParsedExam[];
}

const field = (value: object) => ({
  type: "object",
  properties: { value, quote: { type: ["string", "null"] }, sourceId: { type: ["string", "null"] } },
  required: ["value", "quote", "sourceId"],
});

export const SYLLABUS_PARSE_SCHEMA = {
  type: "object",
  properties: {
    exams: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: field({ type: ["string", "null"] }),
          date: field({ type: ["string", "null"] }),
          location: field({ type: ["string", "null"] }),
          format: field({ type: ["string", "null"] }),
          notesRule: field({ type: ["string", "null"], enum: ["printed", "handwritten", "none", null] }),
          topics: field({ type: ["array", "null"], items: { type: "string" } }),
        },
        required: ["name", "date", "location", "format", "notesRule", "topics"],
      },
    },
  },
  required: ["exams"],
};

export const SYLLABUS_PARSE_SYSTEM =
  "You read course documents and list exams exactly as the documents state them. You never guess: " +
  "a field you can't support with a quote copied character for character from one source is null.";

export function syllabusParsePrompt(courseName: string, sources: ExamSourceText[]): string {
  const blocks = sources.map((s) => `<source id="${s.id}" kind="${s.label}">\n${s.text}\n</source>`).join("\n\n");
  return `Course: ${courseName}

List every exam, midterm, final and quiz these sources announce. For each one give these fields, each as { value, quote, sourceId }:

- name: as the source names it (e.g. "Exam 2", "Quiz 8").
- date: the date and time it is held, as ISO 8601 in US Eastern time with its offset (e.g. "2026-11-05T20:00:00-05:00"); just "YYYY-MM-DD" if no time is given. For a quiz taken online by a deadline, the deadline its text gives counts (e.g. "CQ6 - Heaps due Oct 16" gives "2026-10-16"). Only dates written in a source's text count: a source's kind attribute (e.g. "submission window closes …") is metadata, never a date or a quote.
- location: the room or place, or "online".
- format: what it is like (e.g. "multiple choice on Canvas", "paper, 75 minutes").
- notesRule: "printed" if a printed or typed notes sheet is allowed, "handwritten" if only a handwritten one, "none" if no notes; null if not stated.
- topics: the topics or modules it covers.

Rules:
1. quote is a short passage (at most about 200 characters) copied exactly, character for character, from the source named by sourceId. It must contain the information the value comes from. Do not fix typos, reorder or join pieces from different places.
2. If a field isn't stated, value, quote and sourceId are all null. Never infer a date from a week number or a pattern.
3. If two sources disagree (e.g. an announcement moves a date), list the exam once per source with that source's own quote; don't decide between them.
4. Don't list homework, projects or labs.

Sources:

${blocks}`;
}
