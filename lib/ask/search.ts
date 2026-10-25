// search_course: the course's lecture lines, slides and pages ranked by the query's key terms, in the browser. The
// pipeline's own retrieval ranks with Gemini embeddings on the server (lib/pipeline/retrieve.ts); here only the words
// are at hand, so this is its keyword side (the same distinctive-word rule as keyTerms / termCoverage), plus a bonus
// for the query's words said together. Poll and answer slides are never returned (lib/tutor/poll.ts).

import type { SeedQuestion } from "../demo/types.ts";
import { revealsAnswer } from "../tutor/integrity.ts";
import { isAnswerSlide } from "../tutor/poll.ts";
import { dayLabel } from "./dates.ts";
import { resolveCourse } from "./nicknames.ts";
import type { AskCourse, AskPassage } from "./types.ts";

/** Words too common to tell two passages apart (lib/pipeline/retrieve.ts COMMON, plus question words). */
const COMMON = new Set(
  "about above after again also always another answer based because before being below between both called case cases code could does doing done each else every example first following given goes going have here into just know like look make many more most much need next only other over right same should show since some something still such than that their them then there these they thing think this those through time used using value values very want what when where which while will with would your explain help said tell talk talked lecture slide slides professor behind topic".split(" "),
);
export const termWords = (s: string) =>
  (s.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? [])
    .filter((w) => !COMMON.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => !COMMON.has(w) && w.length >= 3);

export interface SearchHit {
  /** "r1c1p1": what a claim cites (round, call, passage), unique in a turn. */
  id: string;
  courseId: string;
  code: string;
  passage: AskPassage;
  score: number;
}

const textOf = (p: AskPassage) => (p.kind === "lecture" ? p.lines.map((l) => l.text).join(" ") : p.text);

export function scorePassage(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const have = termWords(text);
  const set = new Set(have);
  const hit = terms.filter((t) => set.has(t)).length;
  if (!hit) return 0;
  // Said together ("load factor"): a phrase of the query's words in order counts extra.
  const joined = ` ${have.join(" ")} `;
  let phrase = 0;
  for (let i = 0; i + 1 < terms.length; i++) if (joined.includes(` ${terms[i]} ${terms[i + 1]} `)) phrase++;
  return hit / terms.length + 0.5 * phrase;
}

/** The lecturer's lines as 40-second windows (stepping 20 s), so a hit is one moment, not a whole lecture. */
export function lectureWindows(lecture: string, date: string | null, lines: { start: number; end: number; text: string }[], size = 40, step = 20): AskPassage[] {
  if (!lines.length) return [];
  const out: AskPassage[] = [];
  let prevFirst = -1;
  let prevLen = -1;
  const last = lines[lines.length - 1].start;
  for (let t = Math.floor(lines[0].start); t <= last; t += step) {
    const inside = lines.filter((l) => l.start >= t && l.start < t + size);
    if (!inside.length) continue;
    const first = lines.indexOf(inside[0]);
    if (first === prevFirst && inside.length === prevLen) continue;
    [prevFirst, prevLen] = [first, inside.length];
    out.push({ kind: "lecture", lecture, date, lines: inside });
  }
  return out;
}

/**
 * A question card still open in the chat (or graded work), with its lecture's date: passages that explain its answer
 * never reach the model while it is open, or the model could state the answer in its words (only chips are checked
 * on the page).
 */
export interface Guarded {
  q: SeedQuestion;
  date: string | null;
  /** An open card (its clip and slide are held back too); false for graded work not on screen (only what reveals it). */
  open: boolean;
}

/**
 * Would this passage hand the model a guarded question's answer: one that reveals it, or, for an open card, anything
 * inside its explaining clip or its own slide?
 */
export function explainsGuarded(p: AskPassage, g: Guarded[]): boolean {
  return g.some(({ q, date, open }) => {
    if (revealsAnswer(textOf(p), q)) return true;
    if (!open) return false;
    if (p.kind === "slide") return p.deck === q.match.slide.deck && p.page === q.match.slide.page;
    if (p.kind !== "lecture") return false;
    const m = q.match as { start: number | null; end: number | null; exampleStart?: number | null };
    if (typeof m.start !== "number" || typeof m.end !== "number") return false;
    if (date && p.date && date !== p.date) return false;
    const from = Math.min(m.start, m.exampleStart ?? m.start) - 1;
    const to = m.end + 1;
    // Any line of the window inside the clip.
    return p.lines.some((l) => l.end > from && l.start < to);
  });
}

export const SEARCH_LIMIT = 5;
const CHARS = 700;

/** search_course over one course (or every course when the name is empty or matches none). */
export function searchCourse(courses: AskCourse[], args: { course: string; query: string }, limit = SEARCH_LIMIT, prefix = "", guarded: Guarded[] = []): { hits: SearchHit[]; searched: string[]; unknownCourse?: string } {
  let pool = courses;
  let unknownCourse: string | undefined;
  if (args.course?.trim()) {
    const r = resolveCourse(args.course, courses);
    if ("course" in r) pool = [r.course];
    else unknownCourse = args.course;
  }
  const terms = [...new Set(termWords(args.query ?? ""))];
  const scored: Omit<SearchHit, "id">[] = [];
  for (const c of pool) {
    for (const p of c.material) {
      if (p.kind === "slide" && isAnswerSlide({}, p.text)) continue;
      if (guarded.length && explainsGuarded(p, guarded)) continue;
      const s = scorePassage(terms, textOf(p));
      if (s > 0) scored.push({ courseId: c.id, code: c.code, passage: p, score: s });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  // One hit per moment: overlapping windows of the same lecture are the same place.
  const kept: Omit<SearchHit, "id">[] = [];
  for (const h of scored) {
    if (kept.length >= limit) break;
    const p = h.passage;
    if (
      p.kind === "lecture" &&
      kept.some((k) => k.passage.kind === "lecture" && k.passage.lecture === p.lecture && Math.abs(k.passage.lines[0].start - p.lines[0].start) < 40)
    )
      continue;
    kept.push(h);
  }
  return { hits: kept.map((h, i) => ({ ...h, id: `${prefix}p${i + 1}` })), searched: pool.map((c) => c.code), ...(unknownCourse ? { unknownCourse } : {}) };
}

const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** What the model gets: each passage's words (cut to fit) and where it is from. */
export function searchForModel(r: ReturnType<typeof searchCourse>, lecturerOf: (courseId: string) => string | null): object {
  return {
    passages: r.hits.map((h) => {
      const p = h.passage;
      const where =
        p.kind === "lecture"
          ? `${lecturerOf(h.courseId) ?? "the lecturer"}, the ${p.date ? dayLabel(p.date) : "undated"} lecture at ${stamp(p.lines[0].start)}`
          : p.kind === "slide"
            ? `${p.deck}, ${p.pageKind} ${p.page}`
            : `Canvas page "${p.title}"`;
      return { id: h.id, course: h.code, where, text: textOf(p).slice(0, CHARS) };
    }),
    ...(r.hits.length ? {} : { nothing_found: `Nothing about that in ${r.searched.join(", ") || "the courses on this device"} (lecture transcripts, slides and pages).` }),
    ...(r.unknownCourse ? { unknown_course: r.unknownCourse } : {}),
  };
}
