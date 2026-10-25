// Quick build (beta), in the browser: picked PDFs that look like graded work or submissions never go (Q-SEC 2). A PDF
// is left out when its file name or its first page with text says "submission", "submitted", "graded" or "rubric",
// or shows a score ("Score: 18/20", "Grade: B+", "Points: 7/10"). It is also left out when it names the student, but
// only when the export carries the student's own name: today's extension export doesn't (no top-level user, and
// submissions come without include[]=user), so that check is off for it and the words and score checks still apply.
// Names found here are used only on this device; they are never sent.

/** The words of graded work. Whole words, any case. */
import { isAssignmentSpec } from "./logistics.ts";

const GRADED_WORDS = /\b(submission|submissions|submitted|graded|rubric)\b/i;
/** A score: a label, then a fraction ("18/20", "7.5 / 10"), a percentage or points, or a letter grade after a colon. */
const SCORE = [
  /\b(score|grade|points?|pts|marks?)\s*[:=]?\s*\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?\b/i,
  /\b(score|grade)\s*[:=]\s*\d+(\.\d+)?\s*%/i,
  /\b[Gg]rade\s*[:=]\s*[A-F][+-]?(?![A-Za-z])/,
];

export type GradedWhy = "words" | "score" | "name";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Why this file looks like graded work or a submission, or null. `names` are the student's own (full names only). */
export function gradedWhy(fileName: string, firstPage: string, names: string[] = []): GradedWhy | null {
  const text = `${fileName}\n${firstPage}`;
  if (GRADED_WORDS.test(text.replace(/[_-]+/g, " "))) return "words";
  if (SCORE.some((re) => re.test(text))) return "score";
  // The instructions for graded work (a programming assignment's spec) are graded work too.
  if (isAssignmentSpec(text)) return "words";
  for (const n of names) {
    const parts = n.trim().split(/\s+/).filter(Boolean);
    // A full name only ("Jordan Avery" or "Avery, Jordan"): a lone surname could be a theorem ("Lee's algorithm").
    if (parts.length < 2) continue;
    const re = new RegExp(`(^|[^\\p{L}])${parts.map(escape).join("[\\s_,.-]+")}($|[^\\p{L}])`, "iu");
    if (re.test(text.replace(/_/g, " "))) return "name";
  }
  return null;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const nameOf = (u: unknown): string[] =>
  isObject(u) ? [u.name, u.short_name, u.sortable_name, u.display_name].filter((s): s is string => typeof s === "string" && s.trim().length > 2) : [];

/**
 * The student's own name, when a course export carries it: its user field and its submissions' users. Comment
 * authors are NOT read: they are mostly the instructor or a TA, whose name on a slide must not make it "graded work"
 * (M2), nor become "a student" in lecture lines (M3). Used on this device only, never sent. "Avery, Jordan" is also
 * read as "Jordan Avery".
 */
export function peopleOf(json: unknown): string[] {
  if (!isObject(json)) return [];
  const out = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!t) return;
    out.add(t);
    const m = /^([^,]+),\s*(.+)$/.exec(t);
    if (m) out.add(`${m[2]} ${m[1]}`.trim());
  };
  nameOf(json.user).forEach(add);
  for (const s of Array.isArray(json.submissions) ? json.submissions : []) {
    if (!isObject(s)) continue;
    nameOf(s.user).forEach(add);
  }
  return [...out];
}
