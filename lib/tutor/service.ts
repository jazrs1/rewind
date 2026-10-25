// The tutor's reply: build the prompt (lib/prompts/tutor.ts), call the model through `generate`, then check
// what came back before the student sees any of it:
//   - integrity: a hint, or anything on graded work, that gives the answer away is replaced (integrity.ts);
//   - grounding: each claim's quote must be word for word in the course material (claims.ts); the ones that
//     aren't are dropped, and a reply with none left is shown without "From your course".
// `generate` is lib/llm.ts's generateJSON for the tutor model in the app and a fake in tests.

import { TUTOR_SCHEMA, tutorPrompt, type TutorScope, type LectureLine, type TutorInput, type TutorMode, type TutorReplyJSON, type TutorRequest } from "../prompts/tutor.ts";
import { quoteSourceLabel, type QuoteSource } from "../questions/quote-source.ts";
import type { PracticeSeed, SeedQuestion } from "../demo/types.ts";
import type { ChoiceLabel } from "../schema.ts";
import { groundClaims, type Grounded, type Material } from "./claims.ts";
import { explanationWindow, isAnswerSlide, safeChips } from "./poll.ts";
import { mentionsAnswer, mustNotReveal, reusesValues, revealsAnswer, safeReply, statesConclusion } from "./integrity.ts";

export type Generate = (prompt: string, schema: object) => Promise<TutorReplyJSON>;

export interface TutorTurnIn {
  role: "student" | "tutor";
  text: string;
  /** A tutor turn that was a hint counts against the limit. */
  kind?: "hint" | "reply" | "answer";
}

export interface TutorCall {
  seed: PracticeSeed;
  question: SeedQuestion;
  /** Graded work: Socratic only. */
  graded: boolean;
  /** "Programming Quiz 8 · BFS and DFS": what a graded assignment is. */
  assignment?: string;
  request: TutorRequest;
  message?: string;
  /** Only turns the server vouches for keep role "tutor" and a kind (the route downgrades the rest to student text). */
  history: TutorTurnIn[];
  marked: ChoiceLabel | null;
  /** Hints the server has counted itself for this visit and question; the history can't lower it. */
  hintFloor?: number;
  /** What the tutor stays on, set by the route (default: this question; the demo route never sets it). */
  scope?: TutorScope;
}

export interface TutorResult {
  mode: TutorMode;
  text: string;
  grounded: Grounded[];
  /** The model's reply gave the answer away (or wasn't usable) and was replaced. */
  rewritten: boolean;
  /** The student reasoned out the answer and the tutor confirmed it. */
  confirmed: boolean;
  /** Hints used so far, this one included. */
  hintsUsed: number;
}

/** How many lecturer lines go to the model, around the question's clip. */
const LECTURE_LINES = 40;

/** The course material a claim may quote: the lecturer's lines around the clip, and the question's own quote. */
export function materialOf(q: SeedQuestion): Material {
  const { start, end } = q.match as { start: number | null; end: number | null };
  // Lecturer lines only (the seed already keeps just his; this keeps a guest's or a student's out if one slips in).
  const counts = new Map<string | null, number>();
  for (const s of q.segments) counts.set(s.speaker, (counts.get(s.speaker) ?? 0) + 1);
  const lecturer = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const lines: LectureLine[] =
    typeof start === "number" && typeof end === "number"
      ? q.segments.filter((s) => s.speaker === lecturer).filter((s) => s.end >= start - 90 && s.start <= end + 30).slice(0, LECTURE_LINES).map((s) => ({ start: s.start, text: s.text }))
      : [];
  const where = q.source?.where;
  if (q.source && where?.kind === "lecture" && !lines.some((l) => l.start === where.start)) lines.unshift({ start: where.start, text: q.source.quote });
  // A slide chip opens the slide on screen, so the quote is a slide claim only when it is from that slide (a lecture
  // question can show its lecture's deck while its quote is from a Discussion deck: no chip then).
  const slide =
    q.source && where?.kind === "slide" && where.deck === q.match.slide.deck && where.page === q.match.slide.page
      ? {
          quote: q.source.quote,
          deck: where.deck,
          page: where.page,
          kind: (q.match.slide.kind ?? "slide") as "slide" | "page",
          ...(isAnswerSlide(q.match.slide, q.source.quote) ? { revealsAnswer: true } : {}),
        }
      : null;
  return { lecture: lines, slide };
}

/** The question as the prompt shows it: stem, code, choices, the key, its explanation and its course quote. */
export function questionInput(q: SeedQuestion): TutorInput["question"] {
  const where: QuoteSource | undefined = q.source?.where;
  return {
    stem: q.stem,
    code: q.code,
    choices: q.choices,
    answer: q.answer,
    explanation: q.explanation ?? "",
    quote: q.source?.quote ?? "",
    quoteSource: where ? quoteSourceLabel(where) : "",
  };
}

/** What is sent to the model for this call. Exported so the data-flow list and its test read the same thing. */
export function inputOf(c: TutorCall): TutorInput {
  const q = c.question;
  return {
    course: c.seed.course,
    graded: c.graded,
    assignment: c.graded ? c.assignment : undefined,
    question: questionInput(q),
    lecture: materialOf(q).lecture,
    studentChoice: c.marked,
    hintsGiven: hintsList(c),
    history: c.history.map((t) => ({ role: t.role, text: t.text })),
    request: c.request,
    studentMessage: c.message,
    scope: c.scope,
  };
}

/**
 * The lecture moment that explains the question, found by retrieval (the clip's start, q.match.start): the lecturer's
 * line playing then, or the first one after it long enough to quote. Grounded like any claim, so it is word for word.
 */
export function explanationMoment(q: SeedQuestion): Grounded | null {
  const m = materialOf(q);
  const start = (q.match as { start: number | null }).start;
  const where = q.source?.where;
  // The question's own quote from the lecture is the best line there is.
  if (q.source && where?.kind === "lecture") {
    const [g] = groundClaims([{ quote: q.source.quote }], m);
    if (g) return g;
  }
  if (typeof start !== "number") return null;
  const segs = q.segments.filter((s) => s.end > start).sort((a, b) => a.start - b.start);
  for (const s of segs.slice(0, 4)) {
    const [g] = groundClaims([{ quote: s.text }], m);
    if (g) return g;
  }
  return null;
}

/**
 * Before the student answers, the moment a hint may link: an earlier line where he introduces the idea, before the
 * explanation window (the nearest one that is grounded and doesn't give the answer away). Null when there is none.
 */
export function introMoment(q: SeedQuestion): Grounded | null {
  const w = explanationWindow(q);
  if (!w) return null;
  const m = materialOf(q);
  const earlier = m.lecture.filter((l) => l.start < w.start).sort((a, b) => b.start - a.start);
  for (const l of earlier.slice(0, 6)) {
    if (revealsAnswer(l.text, q)) continue;
    const [g] = groundClaims([{ quote: l.text }], m);
    if (g && g.kind === "lecture" && g.start < w.start) return g;
  }
  return null;
}

/**
 * Every hint tries for one lecture chip and one slide chip, each only when grounded and allowed (lib/tutor/poll.ts).
 * Before the student answers: the model's own chips that pass, else an earlier moment where he introduces the idea
 * (introMoment); no slide of the question's own. After: the explanation moment and the question's slide.
 */
export function hintChips(grounded: Grounded[], q: SeedQuestion, answered = false): Grounded[] {
  const ok = safeChips(grounded, q, { answered, graded: false, hint: true });
  const out = [...ok];
  if (!out.some((g) => g.kind === "lecture")) {
    const moment = answered ? explanationMoment(q) : introMoment(q);
    if (moment) out.unshift(moment);
  }
  const slide = materialOf(q).slide;
  if (answered && !out.some((g) => g.kind === "slide") && slide) out.push(...groundClaims([{ quote: slide.quote }], { lecture: [], slide }));
  return out;
}

/** Hints used before this call: the larger of the verified ones in the history and what the server counted. */
export const hintsBefore = (history: TutorTurnIn[], floor = 0) => Math.max(floor, history.filter((t) => t.role === "tutor" && t.kind === "hint").length);

/** The earlier hints for the prompt; one the browser's history left out is a placeholder, so the count holds. */
function hintsList(c: TutorCall): string[] {
  const own = c.history.filter((t) => t.role === "tutor" && t.kind === "hint").map((t) => t.text);
  while (own.length < (c.hintFloor ?? 0)) own.push("(an earlier hint)");
  return own;
}

/** Said without asking the model: no answer on graded work, and none before the student has marked one. */
export function refusal(c: TutorCall, mode: TutorMode): string | null {
  if (c.graded && c.request === "answer") return safeReply("socratic", true);
  if (mode !== "answer") return null;
  if (!c.marked) return "Mark your answer and check it first, and then I can show you the answer.";
  return null;
}

export async function tutorReply(c: TutorCall, generate: Generate): Promise<TutorResult> {
  const input = inputOf(c);
  const { mode, prompt } = tutorPrompt(input);
  const used = hintsBefore(c.history, c.hintFloor);
  const refused = refusal(c, mode);
  if (refused) return { mode: "socratic", text: refused, grounded: [], rewritten: true, confirmed: false, hintsUsed: used };
  // A refusal, an offline error or a spend cap throws to the caller, which shows its own message; nothing is invented here.
  const reply = await generate(prompt, TUTOR_SCHEMA);
  const text = typeof reply.text === "string" ? reply.text.trim().slice(0, 1200) : "";
  // "The student reasoned it out": believed only as far as what they (or an earlier verified turn) already said contains
  // the answer. Otherwise the reply is checked like any other, so a model can't state the answer by calling it a confirm.
  const said = [c.message ?? "", ...c.history.map((t) => t.text)].join("\n");
  const confirms = reply.confirms === true && !c.graded && mode === "socratic" && mentionsAnswer(said, c.question);
  const claims = Array.isArray(reply.claims) ? reply.claims.filter((x) => x && typeof x.quote === "string") : [];
  const bad =
    !text ||
    (mustNotReveal(mode, c.graded, confirms) && revealsAnswer(text, c.question)) ||
    (c.graded && (statesConclusion(text) || reusesValues(text, c.question)));
  // The chips that may show (lib/tutor/poll.ts): never one that gives the answer away before the student answers or on
  // graded work, never a poll or answer slide before answering; graded work never gets hint chips.
  const hint = mode === "hint";
  const answered = c.marked !== null;
  const shown = (g: Grounded[]) => safeChips(hint && !c.graded ? hintChips(g, c.question, answered) : g, c.question, { answered, graded: c.graded, hint });
  // A reply replaced for giving the answer away gets no chips at all.
  if (bad) return { mode, text: safeReply(mode, c.graded), grounded: [], rewritten: true, confirmed: false, hintsUsed: used + (hint ? 1 : 0) };
  return {
    mode,
    text,
    grounded: shown(groundClaims(claims, materialOf(c.question))),
    rewritten: false,
    confirmed: confirms,
    hintsUsed: used + (mode === "hint" ? 1 : 0),
  };
}
