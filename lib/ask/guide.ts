// Integrity on the Ask tab, decided in code from the course data (never by the model or a flag): a message that names
// one of the student's open graded items ("help me with Homework 5", "CQ8 question 2", "Exam 2"; quizzes and exams
// always count as graded: docs/briefs/ask-tab-notes.md), or a tap on its Graded deadline row, puts the turn in guide
// mode: the banner, the prompt's graded rule (guide with questions, no solutions, no similar problem) and no practice
// set, for the rest of the conversation (the student's earlier turns are read again each time). An item is open until
// the end of its Eastern due day; one with no date counts as open. A typo in its name still counts ("qiuz 4"). On the demo the server
// decides it again from its own copy of the deadlines (lib/demo/ask-route.ts); the request can't turn it off.

import { easternDay } from "./dates.ts";
import { normName } from "./nicknames.ts";
import type { AskCourse } from "./types.ts";

export interface GuideItem {
  courseId: string;
  code: string;
  title: string;
  /** Its Eastern due day, or null. */
  due: string | null;
}

/**
 * "Quiz 4 - Hashing" is named by "quiz 4"; "Conceptual Quiz 8 - Graphs 1" by "quiz 8", "conceptual quiz 8" or "CQ8";
 * "Homework 5: Heaps" by "homework 5" or "hw5"; and each by its whole title.
 */
export function namesOf(title: string): string[] {
  const out = [normName(title)];
  const m = title.match(/^\s*((?:[A-Za-z]+\s+){0,2}[A-Za-z]+)\s*#?\s*(\d+)/);
  if (m) {
    const words = m[1].trim().split(/\s+/);
    const n = m[2];
    out.push(normName(`${words.join("")}${n}`), normName(`${words[words.length - 1]}${n}`));
    if (words.length > 1) out.push(`${words.map((w) => w[0]).join("").toLowerCase()}${n}`);
    const last = words[words.length - 1].toLowerCase();
    if (last === "homework") out.push(`hw${n}`);
    if (last === "exam") out.push(`midterm${n}`);
  }
  return [...new Set(out)].filter((x) => x.length >= 3);
}

/** Damerau-Levenshtein distance, capped: is `a` within one edit (a typo, a swap: "qiuz") of `b`? */
function withinOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length] <= 1;
}

/** The "word number" pairs a student wrote: "qiuz 4" → [["qiuz", "4"]]; "hw5" → [["hw", "5"]]. */
const pairsIn = (text: string) => [...text.toLowerCase().matchAll(/([a-z]+)\s*#?\s*(\d+)/g)].map((m) => [m[1], m[2]] as const);

/**
 * Does the message name this item? Its whole title or a short name (namesOf) inside the words; or a "word number" pair
 * whose number is the item's and whose word is within one typo of the item's ("qiuz 4" for Quiz 4; never "quiz 5").
 */
function names(message: string, title: string): boolean {
  const said = normName(message);
  if (namesOf(title).some((n) => said.includes(n))) return true;
  const m = title.match(/^\s*((?:[A-Za-z]+\s+){0,2}[A-Za-z]+)\s*#?\s*(\d+)/);
  if (!m) return false;
  const word = m[1].trim().split(/\s+/).pop()!.toLowerCase();
  if (word.length < 4) return false;
  return pairsIn(message).some(([w, n]) => n === m[2] && w.length >= 4 && withinOne(w, word));
}

/**
 * The open graded item the conversation is about: named in this message or in an earlier student turn (`earlier`, most
 * recent last), so "help with Quiz 4" then "just give me the answer to question 2" stays in guide mode.
 */
export function gradedMention(message: string, courses: AskCourse[], now: number, earlier: string[] = []): GuideItem | null {
  const today = easternDay(now)!;
  for (const said of [message, ...[...earlier].reverse()]) {
    for (const c of courses) {
      for (const d of c.deadlines) {
        if (!d.graded || d.kind === "event") continue;
        const due = d.at ? easternDay(d.at) : null;
        if (due && due < today) continue;
        if (names(said, d.title)) return { courseId: c.id, code: c.code, title: d.title, due };
      }
    }
  }
  return null;
}
