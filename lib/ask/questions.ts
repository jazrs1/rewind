// get_questions: a mixed practice set from several courses' question banks, in the browser. Each course's practice
// questions, never a graded one (gradedIds, decided on the server from the Canvas data: lib/tutor/graded.ts), ranked
// by the study session's priority: the topic's stressed × missed (lib/study/topics.ts, the student's own practice
// merged in), then the student's own misses on the question, then questions not tried yet. The courses take turns, so
// "DSA and MAS" gets both. A course with no question bank is named, with what it does have.

import { mergeAttempts, type TapeAttempt } from "../course/attempts.ts";
import type { SeedQuestion } from "../demo/types.ts";
import { studyTopics } from "../study/topics.ts";
import { resolveCourse } from "./nicknames.ts";
import { termWords } from "./search.ts";
import type { AskCourse } from "./types.ts";

export const DEFAULT_N = 6;

/** "Hash tables" and "HashTables" alike: letters only, each word's plural s dropped. */
const compact = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join("");
export const MAX_N = 10;

export interface PickedQuestion {
  courseId: string;
  code: string;
  shell: 1 | 2 | 3 | 4;
  topic: string;
  question: SeedQuestion;
  priority: number;
}

export interface QuestionsResult {
  picked: PickedQuestion[];
  /** Courses asked for that have no question bank yet, with what they do have. */
  noBank: { code: string; has: string[] }[];
  unknown: string[];
  /** Graded questions left out (counted, never shown). */
  gradedLeftOut: number;
}

type Attempt = TapeAttempt & { questionId?: string; correct?: boolean };

/** What a course without a bank still offers the student. */
export function whatItHas(c: AskCourse): string[] {
  const lectures = new Set(c.material.filter((p) => p.kind === "lecture").map((p) => (p.kind === "lecture" ? p.lecture : ""))).size;
  const slides = c.material.filter((p) => p.kind === "slide").length;
  const pages = c.material.filter((p) => p.kind === "page").length;
  const dated = c.deadlines.filter((d) => d.at).length;
  return [
    lectures ? `${lectures} lecture transcript${lectures === 1 ? "" : "s"}` : null,
    slides ? `${slides} slide or document page${slides === 1 ? "" : "s"}` : null,
    pages ? `${pages} Canvas page${pages === 1 ? "" : "s"}` : null,
    dated ? `${dated} dated deadline${dated === 1 ? "" : "s"}` : null,
  ].filter((x): x is string => !!x);
}

export function getQuestions(
  courses: AskCourse[],
  args: { courses: string[]; topics: string[]; n: number },
  attemptsOf: (courseId: string) => Attempt[] = () => [],
): QuestionsResult {
  const names = args.courses?.length ? args.courses : courses.map((c) => c.code);
  const chosen: AskCourse[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const r = resolveCourse(name, courses);
    if ("course" in r) {
      if (!chosen.includes(r.course)) chosen.push(r.course);
    } else unknown.push(name);
  }
  const n = Math.max(1, Math.min(MAX_N, Math.round(args.n) || DEFAULT_N));
  // Each topic asked for ("graphs", "hash tables") is a group; a question is in the first group it's about.
  const wanted = (args.topics ?? []).map((t) => ({ words: termWords(t), compact: compact(t) })).filter((t) => t.words.length || t.compact.length >= 4);
  const groupOf = (text: string) => {
    if (!wanted.length) return 0;
    const have = new Set(termWords(text));
    const flat = compact(text);
    return wanted.findIndex((t) => (t.words.length && t.words.every((w) => have.has(w))) || (t.compact.length >= 4 && flat.includes(t.compact)));
  };
  const noBank: QuestionsResult["noBank"] = [];
  let gradedLeftOut = 0;
  const lists: PickedQuestion[][] = [];
  for (const c of chosen) {
    const bank = c.bank;
    if (!bank?.seed.questions.length) {
      noBank.push({ code: c.code, has: whatItHas(c) });
      continue;
    }
    const graded = new Set(bank.gradedIds);
    const attempts = attemptsOf(c.id);
    const tape = bank.tape ? mergeAttempts(bank.tape, attempts) : null;
    const ids = bank.seed.questions.map((q) => q.id);
    const topics = tape ? studyTopics(tape, ids, bank.gradedIds) : [];
    const topicOf = new Map<string, { name: string; priority: number; stressed: number }>();
    for (const t of topics) for (const id of t.questionIds) if (!topicOf.has(id)) topicOf.set(id, { name: t.name, priority: t.priority, stressed: t.stressed });
    const missed = (id: string) => attempts.filter((a) => a.questionId === id && a.correct === false).length;
    const tried = (id: string) => attempts.some((a) => a.questionId === id);
    const list = bank.seed.questions
      .filter((q) => {
        if (graded.has(q.id)) {
          gradedLeftOut++;
          return false;
        }
        return true;
      })
      .map((q) => {
        const t = topicOf.get(q.id);
        const name = t?.name ?? q.match.slide.deck;
        return { q, t, name };
      })
      .map((x) => ({ ...x, group: groupOf(`${x.name} ${x.q.stem} ${x.q.match.slide.deck}`) }))
      .filter((x) => x.group >= 0)
      .sort(
        (a, b) =>
          (b.t?.priority ?? 0) - (a.t?.priority ?? 0) ||
          missed(b.q.id) - missed(a.q.id) ||
          Number(tried(a.q.id)) - Number(tried(b.q.id)) ||
          (b.t?.stressed ?? 0) - (a.t?.stressed ?? 0) ||
          a.q.n - b.q.n,
      )
      .map(({ q, t, name, group }) => ({ courseId: c.id, code: c.code, shell: c.shell, topic: name, question: q, priority: t?.priority ?? 0, group }));
    // Several topics in one course take turns too ("graphs and hash tables"), each in priority order.
    const groups = wanted.length ? wanted.map((_, g) => list.filter((x) => x.group === g)) : [list];
    const mixed: (PickedQuestion & { group: number })[] = [];
    for (let i = 0; groups.some((g) => g.length > i); i++) for (const g of groups) if (g[i]) mixed.push(g[i]);
    lists.push(mixed.map((p) => ({ courseId: p.courseId, code: p.code, shell: p.shell, topic: p.topic, question: p.question, priority: p.priority })));
  }
  // The courses take turns, each in its own priority order.
  const picked: PickedQuestion[] = [];
  for (let i = 0; picked.length < n && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i] && picked.length < n) picked.push(l[i]);
  return { picked, noBank, unknown, gradedLeftOut };
}

/** What the model gets: which questions (course, topic, the stem's start), never the answers. */
export function questionsForModel(r: QuestionsResult): object {
  return {
    questions: r.picked.map((p) => ({ id: p.question.id, course: p.code, topic: p.topic, stem: p.question.stem.slice(0, 140) })),
    no_question_bank: r.noBank.map((b) => `${b.code} has no question bank yet${b.has.length ? `; it has ${b.has.join(", ")}` : ""}.`),
    ...(r.unknown.length ? { unknown_courses: r.unknown } : {}),
    ...(r.gradedLeftOut ? { graded_left_out: `${r.gradedLeftOut} graded question${r.gradedLeftOut === 1 ? " was" : "s were"} left out (graded work is never practice).` } : {}),
    note: "The page shows these questions as cards the student answers in place. Don't repeat them or their choices.",
  };
}
