// Quick build (beta): a batch of the student's own course text in, up to 5 checked questions out. Nothing is kept here.
//
//   - The questions come from lib/pipeline/generate.ts (generateQuestion: the existing prompt, rules and retry loop),
//     with the course text fenced as data in both prompts (`fence`) and every course string escaped with asData.
//   - Before each model call its worst-case cost is reserved against Quick build's own day ($4, 1,500 calls; lib/quick/limits.ts); a store that
//     fails or a spent budget stops the batch, and no further call is made.
//   - A question is kept only if its quote is word for word in the chunk it cites (quoteIn, lib/pipeline/exams.ts).
//     For a lecture chunk its time is the start of the first line holding the quote; a PDF chunk keeps its file and page.
//   - The reasons given for a question that was left out are fixed words, never text.

import { formatTime } from "../format.ts";
import { aboutCourseLogistics } from "./logistics.ts";
import { actualMicro, estimateMicro } from "../demo/tutor-llm.ts";
import type { CounterStore } from "../demo/tutor-store.ts";
import { quoteIn } from "../pipeline/exams.ts";
import { generateQuestion, type JSONGenerator, MIN_ANCHOR_CHARS, type QuestionMaterial, type SourcedPassage } from "../pipeline/generate.ts";
import { ANSWER_CHECK_SCHEMA } from "../prompts/answer-check.ts";
import { asData } from "../prompts/tutor.ts";
import { BudgetStop, reserveCall, settleCall } from "./limits.ts";
import type { SourceRef } from "../pipeline/types.ts";
import type { QuickChunk, QuickQuestion, QuickRequest, QuickResponse } from "./types.ts";

/** The model call: the demo tutor's wrapper (lib/demo/tutor-llm.ts) or a fake. The reply is whatever JSON the schema asks for. */
export type QuickModel = (prompt: string, schema: object, opts: { maxTokens: number }) => Promise<{ reply: unknown; inputTokens: number; outputTokens: number }>;

/** Output tokens per call: a question (stem, code, four choices, a quote) and the blind check's verdicts. */
export const QUESTION_MAX_TOKENS = 900;
export const CHECK_MAX_TOKENS = 400;

/** The JSONGenerator generateQuestion calls: every call reserves its cost first, stops at the deadline, and settles after. */
export function quickLLM(o: { model: QuickModel; store: CounterStore; now: () => number; deadline?: AbortSignal; onCall?: () => void }): JSONGenerator {
  return {
    async generateJSON<T>(_ref: unknown, prompt: string, schema: object): Promise<T> {
      const maxTokens = schema === ANSWER_CHECK_SCHEMA ? CHECK_MAX_TOKENS : QUESTION_MAX_TOKENS;
      if (o.deadline?.aborted) throw new Error("deadline");
      const estimate = estimateMicro(prompt.length, maxTokens);
      await reserveCall(o.store, estimate, o.now());
      o.onCall?.();
      const r = await o.model(prompt, schema, { maxTokens });
      await settleCall(o.store, { estimateMicro: estimate, actualMicro: actualMicro(r.inputTokens, r.outputTokens), now: o.now() }).catch(() => {});
      return r.reply as T;
    },
  };
}

/** n items spread evenly over the list. */
function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(((i + 0.5) * xs.length) / n)]);
}

const ws = (s: string) => s.replace(/\s+/g, " ").trim();

/** Start of the first line holding the quote: where the quote's first character falls in the lines joined by spaces. */
export function quoteSec(segments: { start: number; text: string }[], quote: string): number | null {
  const lines = segments.map((s) => ws(s.text));
  const at = lines.join(" ").indexOf(ws(quote));
  if (at < 0) return null;
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    if (at < pos + lines[i].length) return segments[i].start;
    pos += lines[i].length + 1;
  }
  return null;
}

function passageOf(c: QuickChunk, id: string): SourcedPassage {
  if (c.kind === "lecture" && c.lecture) {
    const segs = c.lecture.segments;
    return {
      id,
      label: `lecture ${formatTime(segs[0].start)} to ${formatTime(segs[segs.length - 1].end)}`,
      lines: segs.map((s) => ({ start: s.start, text: s.text })),
      source: { kind: "lecture", itemId: c.id, recordingUrl: c.lecture.recordingUrl, start: segs[0].start, end: segs[segs.length - 1].end, title: c.title },
    };
  }
  if ((c.kind === "slide" || c.kind === "document") && c.doc) {
    const label = `${c.kind === "slide" ? "slide" : "page"} ${c.doc.page} of ${JSON.stringify(asData(c.doc.deck))}`;
    const source: SourceRef = c.kind === "slide" ? { kind: "slide", itemId: c.id, fileId: 0, page: c.doc.page, deck: c.doc.deck } : { kind: "document", itemId: c.id, fileId: 0, page: c.doc.page, name: c.doc.deck };
    return { id, label, text: c.text, source };
  }
  return { id, label: `page ${JSON.stringify(asData(c.title))}`, text: c.text, source: { kind: "page", itemId: c.id, pageUrl: c.id, title: c.title } };
}

/** The anchor and the chunk after it from the same page, recording or PDF page (an example often runs on), as passages. */
function materialOf(anchor: QuickChunk, all: QuickChunk[]): QuestionMaterial {
  const next = all.find((c, i) => i === all.indexOf(anchor) + 1 && c.kind === anchor.kind && c.title === anchor.title && c.doc?.page === anchor.doc?.page && c.text.length >= 40);
  const pieces = next ? [anchor, next] : [anchor];
  return { topic: asData(anchor.title), examId: null, passages: pieces.map((c, i) => passageOf(c, `P${i + 1}`)), style: [], fence: true };
}

/** How many questions a request can ask for: one per chunk long enough to write from, at most the batch size. */
export function wantFor(req: QuickRequest, max: number): number {
  return Math.min(max, req.chunks.filter((c) => c.text.length >= MIN_ANCHOR_CHARS).length);
}

export interface ServiceResult extends QuickResponse {
  /** A budget or store stop: the batch ended early and made no further call. */
  stopped: "budget" | "store" | null;
}

export async function writeQuestions(req: QuickRequest, o: { llm: JSONGenerator; count: number; id?: () => string }): Promise<ServiceResult> {
  const course = { code: asData(req.course.code), name: asData(req.course.name) };
  const anchors = spread(req.chunks.filter((c) => c.text.length >= MIN_ANCHOR_CHARS), o.count);
  const byId = new Map(req.chunks.map((c) => [c.id, c]));
  const newId = o.id ?? (() => `qb-${Math.random().toString(36).slice(2, 10)}`);
  const refused: { reason: string }[] = [];
  let stopped: ServiceResult["stopped"] = null;

  const settled = await Promise.all(
    anchors.map(async (anchor) => {
      try {
        return await generateQuestion(materialOf(anchor, req.chunks), { course, id: newId(), llm: o.llm });
      } catch (e) {
        if (e instanceof BudgetStop) stopped ??= "budget";
        else if ((e as Error)?.name === "StoreDown") stopped ??= "store";
        return e instanceof BudgetStop ? ("budget" as const) : (e as Error)?.name === "StoreDown" ? ("store" as const) : ("error" as const);
      }
    }),
  );

  const questions: QuickQuestion[] = [];
  const stems = new Set<string>();
  for (const r of settled) {
    if (typeof r === "string") {
      refused.push({ reason: r });
      continue;
    }
    if (r.status !== "kept") {
      refused.push({ reason: "checks" });
      continue;
    }
    const q = r.question;
    const chunk = byId.get(q.quoteSource.itemId);
    // The word-for-word check, against the chunk it cites, on the text the browser sent.
    if (!chunk || !quoteIn(chunk.text, q.quote)) {
      refused.push({ reason: "quote" });
      continue;
    }
    // About how the course runs (grading, what's graded, policies), not the subject: never kept.
    if (aboutCourseLogistics([q.stem, ...q.choices.map((c) => c.text), q.quote].join("\n"))) {
      refused.push({ reason: "checks" });
      continue;
    }
    const key = q.stem.toLowerCase();
    if (stems.has(key)) {
      refused.push({ reason: "duplicate" });
      continue;
    }
    stems.add(key);
    const source: QuickQuestion["source"] = { kind: chunk.kind, title: chunk.title };
    if (chunk.kind === "lecture" && chunk.lecture) {
      const sec = quoteSec(chunk.lecture.segments, q.quote);
      if (sec === null) {
        refused.push({ reason: "quote" });
        continue;
      }
      source.sec = sec;
      source.recordingUrl = chunk.lecture.recordingUrl;
      source.lines = chunk.lecture.segments.map((s) => ({ start: s.start, text: s.text }));
    }
    if (chunk.doc) {
      source.deck = chunk.doc.deck;
      source.page = chunk.doc.page;
    }
    questions.push({
      id: q.id,
      stem: q.stem,
      code: q.code ? { language: q.code.language, lines: q.code.lines } : null,
      choices: q.choices,
      answer: q.answer,
      explanation: q.explanation,
      quote: q.quote.trim(),
      source,
    });
  }
  return { questions, refused, stopped };
}
