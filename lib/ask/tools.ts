// The Ask tab's tools, run in the browser over the courses on this device (and, on the demo route, again on the
// server over the public demo bundle, so a visitor can't put their own text in the prompt as a "tool result"). Each
// returns the text the model gets (only what that turn needs: no answer keys, no links) and what the page draws from
// it (the cards: deadline rows, practice cards, chips), so a card never comes from the model's own words.

import { deadlinesForModel, listDeadlines, type DeadlineResult } from "./deadlines.ts";
import { normName, resolveCourse } from "./nicknames.ts";
import { getQuestions, questionsForModel, type QuestionsResult } from "./questions.ts";
import { searchCourse, searchForModel, type Guarded, type SearchHit } from "./search.ts";
import type { AskCourse, DeadlineKind, ToolCall } from "./types.ts";
import { DEADLINE_KINDS, TOOL_NAMES } from "./types.ts";
import type { TapeAttempt } from "../course/attempts.ts";

export interface StudyLink {
  code: string;
  shell: 1 | 2 | 3 | 4;
  title: string;
  href: string;
  graded: boolean;
}

export type ToolDisplay =
  | { kind: "deadlines"; result: DeadlineResult }
  | { kind: "questions"; result: QuestionsResult }
  | { kind: "search"; hits: SearchHit[] }
  | { kind: "study"; link: StudyLink }
  | { kind: "none" };

export interface ToolContext {
  courses: AskCourse[];
  now: number;
  /** The student's message this turn: a date the model writes is used only when it is named here. */
  studentText: string;
  attemptsOf?: (courseId: string) => (TapeAttempt & { correct?: boolean })[];
  /** Makes search passage ids unique in a turn ("r1c2"). */
  idPrefix?: string;
  /** Question cards still open in the chat (unanswered): search never returns what explains their answers. */
  openIds?: string[];
}

/** The questions search must not explain: the open cards (clip, slide, anything revealing) and graded ones (anything revealing). */
export function guardedOf(courses: AskCourse[], openIds: string[] = []): Guarded[] {
  const open = new Set(openIds);
  return courses.flatMap((c) =>
    (c.bank?.seed.questions ?? []).filter((q) => open.has(q.id) || c.bank!.gradedIds.includes(q.id)).map((q) => ({ q, date: c.bank!.moments[q.id]?.date ?? null, open: open.has(q.id) })),
  );
}

/** A call as the model sent it, with every field in its type (anything else dropped or emptied). */
export function cleanCall(raw: unknown): ToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!TOOL_NAMES.includes(r.tool as ToolCall["tool"])) return null;
  const s = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6).map((x) => x.slice(0, 80)) : []);
  return {
    tool: r.tool as ToolCall["tool"],
    course: s(r.course, 80),
    courses: list(r.courses),
    query: s(r.query),
    from: s(r.from, 40),
    to: s(r.to, 40),
    kinds: list(r.kinds).filter((k): k is DeadlineKind => DEADLINE_KINDS.includes(k as DeadlineKind)),
    topics: list(r.topics),
    n: typeof r.n === "number" && Number.isFinite(r.n) ? Math.round(r.n) : 0,
    exam: s(r.exam, 120),
  };
}

const json = (o: object) => JSON.stringify(o);

export function runTool(call: ToolCall, ctx: ToolContext): { result: string; display: ToolDisplay } {
  const { courses } = ctx;
  switch (call.tool) {
    case "list_courses":
      return {
        result: json({
          courses: courses.map((c) => ({
            code: c.code,
            title: c.title,
            nicknames: c.nicknames,
            lecturer: c.lecturer,
            question_bank: c.bank ? `${c.bank.seed.questions.length} practice questions` : "none yet",
            dated_deadlines: c.deadlines.filter((d) => d.at).length,
          })),
        }),
        display: { kind: "none" },
      };
    case "list_deadlines": {
      const r = listDeadlines(courses, call, ctx.now, ctx.studentText);
      if ("error" in r) return { result: json({ error: r.error }), display: { kind: "none" } };
      return { result: json(deadlinesForModel(r)), display: { kind: "deadlines", result: r } };
    }
    case "search_course": {
      const r = searchCourse(courses, call, undefined, ctx.idPrefix, guardedOf(courses, ctx.openIds));
      const lecturer = (id: string) => courses.find((c) => c.id === id)?.lecturer ?? null;
      return { result: json(searchForModel(r, lecturer)), display: { kind: "search", hits: r.hits } };
    }
    case "get_questions": {
      const r = getQuestions(courses, call, ctx.attemptsOf);
      return { result: json(questionsForModel(r)), display: { kind: "questions", result: r } };
    }
    case "open_study": {
      const r = resolveCourse(call.course, courses);
      if (!("course" in r)) return { result: json({ error: `no single course matches "${call.course}"`, courses: courses.map((c) => c.code) }), display: { kind: "none" } };
      const c = r.course;
      const want = normName(call.exam);
      const d = want ? c.deadlines.find((x) => normName(x.title) === want) ?? c.deadlines.find((x) => normName(x.title).includes(want) || want.includes(normName(x.title))) : undefined;
      const href = d?.href ?? c.studyHref;
      if (!href) return { result: json({ error: `${c.code} has no study session yet (no question bank)` }), display: { kind: "none" } };
      const link: StudyLink = { code: c.code, shell: c.shell, title: d ? d.title : `${c.code} study session`, href, graded: !!d?.graded };
      return { result: json({ opened: link.title, course: c.code, graded: link.graded, note: "The page shows a button that opens it." }), display: { kind: "study", link } };
    }
  }
}
