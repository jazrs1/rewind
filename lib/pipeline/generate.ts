// Pipeline stage: generate + check. For each exam (or, when no exams are known yet, each topic
// group: one lecture deck; a course with no slides or files falls back to its Canvas pages'
// text), a practice set in the style of the course's past reviews (style
// examples = review-role chunks), each question citing the passage its quote (and code) comes from.
// Every question then goes through John's quality rules: the deterministic half in code
// (lib/questions/rules.ts, quote and code found word for word), then the answer-check pass
// (lib/prompts/answer-check.ts, Opus answering blind). Only agreed, quote-verified questions are
// kept; a rejected question is regenerated with the reason up to 2 times, then dropped with it.
// All model calls go through lib/llm.ts (cached; spend in $LLM_USAGE_LOG).

import { quoteAppears, quoteWords } from "../../scripts/eval/quote.ts";
import { MIN_ANCHOR_CHARS } from "./chunk.ts";
import { formatTime } from "../format.ts";
import { embed as geminiEmbed, type EmbedOptions } from "../gemini.ts";
import { ClaudeRefusalError, createLLM, LLM_MODELS, type LLMOptions, type ModelRef } from "../llm.ts";
import { ANSWER_CHECK_SCHEMA, answerCheckPrompt, type AnswerCheckReply, VERSION as CHECK_VERSION } from "../prompts/answer-check.ts";
import { type Passage, QUESTION_GEN_SCHEMA, questionGenPrompt, type QuestionGenReply, VERSION as GEN_VERSION } from "../prompts/question-gen.ts";
import { deterministicChecks, type RuleFailure, type RuleId } from "../questions/rules.ts";
import { cosine } from "../rewind.ts";
import type { ChoiceLabel } from "../schema.ts";
import type { PipelineChunk, PipelineExam, PracticeQuestion, SourceRef } from "./types.ts";

export const LABELS: ChoiceLabel[] = ["A", "B", "C", "D"];
/** One attempt plus up to 2 retries. */
export const MAX_ATTEMPTS = 3;

/** The slice of lib/llm.ts the stage needs, so tests can pass an instance with a fake client. */
export interface JSONGenerator {
  generateJSON<T>(ref: ModelRef, prompt: string, schema: object, options?: LLMOptions): Promise<T>;
}

export type Embedder = (texts: string[], options?: EmbedOptions) => Promise<number[][]>;

/** A passage with where it comes from. Lecture passages carry their timed lines. */
export interface SourcedPassage extends Passage {
  source: SourceRef;
}

export interface QuestionMaterial {
  topic: string;
  examId: string | null;
  examName?: string | null;
  passages: SourcedPassage[];
  /** Questions from review-role chunks, with the item they come from. */
  style: { itemId: string; text: string }[];
  /** The passages are a student's own text (Quick build): the prompts fence them as data. */
  fence?: boolean;
}

export interface Attempt {
  question: Omit<PracticeQuestion, "id" | "check" | "retrieval" | "prompts"> | null;
  check: AnswerCheckReply | null;
  failures: RuleFailure[];
  /** Why it was rejected; null if kept. */
  rejected: string | null;
}

export type GenerateResult =
  | { status: "kept"; question: PracticeQuestion; check: AnswerCheckReply; attempts: Attempt[] }
  | { status: "dropped"; reason: string; failures: RuleFailure[]; attempts: Attempt[] };

const CHECK_OPTIONS: LLMOptions = { effort: "high" };

export function passageText(p: Passage): string {
  return p.lines ? p.lines.map((l) => l.text).join(" ") : (p.text ?? "");
}

/** Where a quote sits in a passage: for a lecture passage, narrowed to the line it starts on. */
export function locateInPassage(quote: string, p: SourcedPassage): SourceRef | null {
  if (!quoteAppears(quote, [passageText(p)])) return null;
  if (p.lines && p.source.kind === "lecture") {
    const texts = p.lines.map((l) => l.text);
    for (let i = texts.length - 1; i >= 0; i--) {
      if (quoteAppears(quote, [texts.slice(i).join(" ")])) return { ...p.source, start: p.lines[i].start };
    }
  }
  return p.source;
}

/** The cited passage first, then any other (a model sometimes cites the wrong ID for a true quote). */
function findQuote(quote: string, cited: string, passages: SourcedPassage[]): SourceRef | null {
  const order = [...passages.filter((p) => p.id === cited), ...passages.filter((p) => p.id !== cited)];
  for (const p of order) {
    const at = locateInPassage(quote, p);
    if (at) return at;
  }
  return null;
}

/**
 * Code lines are copied from a passage: each line's words appear word for word (quoteAppears'
 * normalization), in order. Words between lines may be skipped, since slide text puts inline
 * comments and line numbers between the code's lines. Brace-only lines carry no words.
 */
export function codeAppearsInOrder(lines: string[], text: string): boolean {
  const hay = quoteWords(text);
  let pos = 0;
  let matched = 0;
  for (const line of lines) {
    const w = quoteWords(line);
    if (!w.length) continue;
    let found = -1;
    for (let i = pos; i + w.length <= hay.length && found < 0; i++) if (w.every((x, k) => hay[i + k] === x)) found = i;
    if (found < 0) return false;
    pos = found + w.length;
    matched += w.length;
  }
  return matched >= 3;
}

/** Where the code is: the cited passage first, then any other. For a lecture passage, the line its first words are on. */
function findCode(lines: string[], cited: string, passages: SourcedPassage[]): SourceRef | null {
  const order = [...passages.filter((p) => p.id === cited), ...passages.filter((p) => p.id !== cited)];
  for (const p of order) {
    if (!codeAppearsInOrder(lines, passageText(p))) continue;
    if (p.lines && p.source.kind === "lecture") {
      for (let i = p.lines.length - 1; i >= 0; i--) {
        if (codeAppearsInOrder(lines, p.lines.slice(i).map((l) => l.text).join(" "))) return { ...p.source, start: p.lines[i].start };
      }
    }
    return p.source;
  }
  return null;
}

export function sourceLabel(s: SourceRef): string {
  switch (s.kind) {
    case "slide":
      return `slide ${s.page} of "${s.deck}"`;
    case "document":
      return `page ${s.page} of "${s.name}"`;
    case "lecture":
      return `lecture ${formatTime(s.start)}`;
    case "page":
      return `page "${s.title}"`;
    case "announcement":
      return `announcement "${s.title}"`;
    case "assignment":
      return `assignment "${s.name}"`;
    case "syllabus":
      return "syllabus";
  }
}

/** Generates one question from the material, checks it, and regenerates up to 2 times with the reason. */
export async function generateQuestion(
  material: QuestionMaterial,
  opts: {
    course: { code: string; name: string };
    id?: string;
    avoid?: string[];
    llm?: JSONGenerator;
    /** Why an earlier version was rejected (a reviewer's reason): the first attempt already writes past it. */
    reason?: string;
  },
): Promise<GenerateResult> {
  const llm = opts.llm ?? createLLM();
  const styleExamples = material.style.map((s) => s.text);
  const attempts: Attempt[] = [];
  let reason: string | undefined = opts.reason;
  let failures: RuleFailure[] = [];
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const prompt = questionGenPrompt({
      course: opts.course,
      topic: material.topic,
      exam: material.examName ?? null,
      passages: material.passages,
      styleExamples,
      avoid: opts.avoid,
      retryReason: reason,
      fence: material.fence,
    });
    let raw: QuestionGenReply;
    try {
      raw = await llm.generateJSON<QuestionGenReply>(LLM_MODELS.questions, prompt, QUESTION_GEN_SCHEMA);
    } catch (err) {
      if (!(err instanceof ClaudeRefusalError)) throw err;
      failures = [{ rule: "format", reason: `the request was declined (${err.category ?? "no category"})` }];
      reason = failures[0].reason;
      attempts.push({ question: null, check: null, failures, rejected: reason });
      continue;
    }

    failures = [];
    const choices = LABELS.map((label) => ({ label, text: (raw.choices?.[label] ?? "").trim() }));
    const stem = (raw.stem ?? "").trim();
    const quote = (raw.quote ?? "").trim();
    const codeLines = (raw.code?.lines ?? []).map((l) => l.replace(/\s+$/, "")).filter((l, j, all) => l.trim() || (j > 0 && j < all.length - 1));
    if (!stem || choices.some((c) => !c.text) || !LABELS.includes(raw.answer)) failures.push({ rule: "format", reason: "the question was incomplete (missing stem, a choice or the answer)" });
    else if (new Set(choices.map((c) => c.text.toLowerCase())).size < 4) failures.push({ rule: "format", reason: "two choices were the same" });

    const quoteSource = findQuote(quote, raw.quotePassage, material.passages);
    if (!quoteSource) failures.push({ rule: "quote", reason: `the quote was not found word for word in the material: "${quote}"` });

    let code: PracticeQuestion["code"] = null;
    if (codeLines.length) {
      const codeSource = findCode(codeLines, raw.code.passage, material.passages);
      if (!codeSource) failures.push({ rule: "code", reason: `the code lines were not found word for word, in order, in the material: ${JSON.stringify(codeLines)}` });
      else code = { language: raw.code.language?.trim() || "code", lines: codeLines, source: codeSource };
    }

    const draft = { stem, code: codeLines.length ? { language: raw.code.language ?? "", lines: codeLines } : null, choices, answer: raw.answer };
    if (!failures.some((f) => f.rule === "format")) failures.push(...deterministicChecks(draft, { styleExamples }));

    let check: AnswerCheckReply | null = null;
    if (!failures.length) {
      try {
        check = await llm.generateJSON<AnswerCheckReply>(
          LLM_MODELS.answerCheck,
          answerCheckPrompt({ course: opts.course, passages: material.passages, styleExamples, fence: material.fence, question: { stem, code: draft.code, choices, quote } }),
          ANSWER_CHECK_SCHEMA,
          CHECK_OPTIONS,
        );
      } catch (err) {
        if (!(err instanceof ClaudeRefusalError)) throw err;
        failures.push({ rule: "check", reason: `the answer check was declined (${err.category ?? "no category"}), so the question is unchecked` });
      }
    }
    if (check) failures.push(...checkFailures(check, raw.answer));

    const question = quoteSource
      ? {
          examId: material.examId,
          topic: material.topic,
          stem,
          code,
          choices,
          answer: raw.answer,
          explanation: (raw.explanation ?? "").trim(),
          quote,
          quoteSource,
          styleItemId: material.style[0]?.itemId ?? null,
        }
      : null;
    const rejected = failures.length ? failures.map((f) => f.reason).join("; ") : null;
    attempts.push({ question, check, failures, rejected });
    if (!rejected && question && check) {
      return {
        status: "kept",
        question: {
          id: opts.id ?? `q-${Math.random().toString(36).slice(2, 10)}`,
          ...question,
          check: { agreed: true, attempts: attempts.length, reason: null },
          retrieval: { clip: null, slide: null, fallback: null },
          prompts: { "question-gen": GEN_VERSION, "answer-check": CHECK_VERSION },
        },
        check,
        attempts,
      };
    }
    reason = rejected!;
  }
  return { status: "dropped", reason: reason!, failures, attempts };
}

/** The model check's verdicts as rule failures. */
export function checkFailures(check: AnswerCheckReply, key: ChoiceLabel): RuleFailure[] {
  const out: RuleFailure[] = [];
  const why = check.problems?.trim() ? ` (${check.problems.trim()})` : "";
  if (check.answer !== key) out.push({ rule: "check", reason: `an independent check answered ${check.answer}, but the key says ${key}${why}` });
  if (!check.unambiguous || !check.uniqueUnderDefinition) out.push({ rule: "unique", reason: `the check found more than one defensible answer under the problem's definition, or an unclear stem${why}` });
  if (!check.standsAlone) out.push({ rule: "standalone", reason: `the check found it refers to something not shown in the question${why}` });
  if (!check.optionsParallel) out.push({ rule: "options", reason: `the check found the options aren't short and parallel${why}` });
  if (!check.soundsLikeCourse) out.push({ rule: "style", reason: `the check found it doesn't sound like the course's own questions${why}` });
  if (!check.quoteSupports) out.push({ rule: "quote", reason: `the check found the quote doesn't support the answer${why}` });
  return out;
}

/** How many attempts each rule rejected, and how many questions were kept/dropped. */
export function ruleTally(results: GenerateResult[]): { attempts: number; kept: number; dropped: number; rejectedBy: Record<RuleId, number> } {
  const rejectedBy = { unique: 0, standalone: 0, options: 0, style: 0, quote: 0, code: 0, format: 0, check: 0 } as Record<RuleId, number>;
  let attempts = 0;
  for (const r of results)
    for (const a of r.attempts) {
      attempts++;
      for (const rule of new Set(a.failures.map((f) => f.rule))) rejectedBy[rule]++;
    }
  return { attempts, kept: results.filter((r) => r.status === "kept").length, dropped: results.filter((r) => r.status === "dropped").length, rejectedBy };
}

// ---------- practice sets ----------

export interface PracticeSetInput {
  course: { code: string; name: string };
  exams: PipelineExam[];
  chunks: PipelineChunk[];
  /** Questions per exam or topic group. Default 5. */
  perGroup?: number;
  /** Only these topic groups (deck names) when there are no exams. */
  groups?: string[];
}

export interface PracticeGroup {
  examId: string | null;
  examName: string | null;
  topic: string;
  anchors: PipelineChunk[];
}

export { MIN_ANCHOR_CHARS };
const STYLE_PER_QUESTION = 3;

export function isContent(c: PipelineChunk): boolean {
  return (c.source.kind === "slide" || c.source.kind === "document") && (c.role === "lecture" || c.role === "practice");
}

/**
 * What questions are written from: slides and course files. A course with none of those (only
 * Canvas pages of text, e.g. no Files-tab download) falls back to its pages with role "page"
 * (not admin, syllabus or review by their title).
 */
export function contentChunks(chunks: PipelineChunk[]): PipelineChunk[] {
  const long = (c: PipelineChunk) => c.text.trim().length >= MIN_ANCHOR_CHARS;
  const files = chunks.filter((c) => isContent(c) && long(c));
  return files.length ? files : chunks.filter((c) => c.source.kind === "page" && c.role === "page" && long(c));
}

function pageOf(c: PipelineChunk): number {
  return c.source.kind === "slide" || c.source.kind === "document" ? c.source.page : 0;
}

export function groupName(c: PipelineChunk): string {
  return c.source.kind === "slide" ? c.source.deck : c.source.kind === "document" ? c.source.name : c.source.kind === "page" ? c.source.title : c.source.itemId;
}

/** n items spread evenly over the list. */
function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(((i + 0.5) * xs.length) / n)]);
}

/** Exams with topics get one group each (anchors ranked by similarity to each topic); otherwise one group per deck. */
export async function practiceGroups(input: PracticeSetInput, embed: Embedder): Promise<PracticeGroup[]> {
  const n = input.perGroup ?? 5;
  const content = contentChunks(input.chunks);
  const withTopics = input.exams.filter((e) => e.topics.value?.length);
  if (withTopics.length) {
    const vecs = await embed(content.map((c) => c.text), { taskType: "RETRIEVAL_DOCUMENT" });
    const groups: PracticeGroup[] = [];
    for (const exam of withTopics) {
      const topics = exam.topics.value!;
      const tvecs = await embed(topics, { taskType: "RETRIEVAL_QUERY" });
      const ranked = tvecs.map((t) => content.map((c, i) => ({ c, s: cosine(t, vecs[i]) })).sort((a, b) => b.s - a.s).map((x) => x.c));
      const anchors: PipelineChunk[] = [];
      for (let depth = 0; anchors.length < n && depth < content.length; depth++)
        for (const list of ranked) if (anchors.length < n && list[depth] && !anchors.includes(list[depth])) anchors.push(list[depth]);
      groups.push({ examId: exam.id, examName: exam.name.value, topic: topics.join(", "), anchors });
    }
    return groups;
  }
  const byDeck = new Map<string, PipelineChunk[]>();
  for (const c of content) byDeck.set(groupName(c), [...(byDeck.get(groupName(c)) ?? []), c]);
  return [...byDeck]
    .filter(([name]) => !input.groups || input.groups.includes(name))
    .map(([name, cs]) => ({ examId: null, examName: null, topic: name, anchors: spread(cs.sort((a, b) => pageOf(a) - pageOf(b)), n) }));
}

function passageFor(c: PipelineChunk, id: string): SourcedPassage {
  const s = c.source;
  const label = s.kind === "slide" ? `slide ${s.page} of "${s.deck}"` : s.kind === "document" ? `page ${s.page} of "${s.name}"` : sourceLabel(s);
  return { id, label, text: c.text, source: s };
}

/** An anchor page and the next page of the same item (slides often continue an example); for a Canvas page, its next chunk. */
export function materialFor(anchor: PipelineChunk, chunks: PipelineChunk[]): PipelineChunk[] {
  const next =
    anchor.source.kind === "page"
      ? chunks.slice(chunks.indexOf(anchor) + 1).find((c) => c.source.itemId === anchor.source.itemId && c.text.trim().length >= 40)
      : chunks.find((c) => c.source.itemId === anchor.source.itemId && pageOf(c) === pageOf(anchor) + 1 && c.text.trim().length >= 40);
  return next ? [anchor, next] : [anchor];
}

/**
 * One question's material: the anchor page and the next one, and the past reviews' questions
 * nearest to it as style examples (what generatePracticeSet and scripts/pipeline/regenerate.ts use).
 */
export async function materialOf(
  anchor: PipelineChunk,
  group: Pick<PracticeGroup, "topic" | "examId" | "examName">,
  chunks: PipelineChunk[],
  reviews: { reviews: PipelineChunk[]; reviewVecs: number[][] },
  embed: Embedder,
): Promise<QuestionMaterial> {
  const pieces = materialFor(anchor, chunks);
  let style: QuestionMaterial["style"] = [];
  if (reviews.reviews.length) {
    const [av] = await embed([pieces.map((p) => p.text).join(" ")], { taskType: "SEMANTIC_SIMILARITY" });
    style = reviews.reviews
      .map((c, i) => ({ c, s: cosine(av, reviews.reviewVecs[i]) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, STYLE_PER_QUESTION)
      .map(({ c }) => ({ itemId: c.source.itemId, text: c.text.trim() }));
  }
  return { topic: group.topic, examId: group.examId, examName: group.examName, passages: pieces.map((c, i) => passageFor(c, `P${i + 1}`)), style };
}

/** Generates and checks a practice set for every exam (or topic group). */
export async function generatePracticeSet(
  input: PracticeSetInput,
  deps: { llm?: JSONGenerator; embed?: Embedder; onResult?: (r: GenerateResult, group: PracticeGroup) => void } = {},
): Promise<{ questions: PracticeQuestion[]; results: { group: string; result: GenerateResult }[] }> {
  const llm = deps.llm ?? createLLM();
  const embed = deps.embed ?? geminiEmbed;
  const groups = await practiceGroups(input, embed);
  // Style examples are past questions: review files, not a review page's own text (links, an answer key).
  const reviews = input.chunks.filter((c) => c.role === "review" && c.source.kind !== "page" && c.text.trim());
  const reviewVecs = reviews.length ? await embed(reviews.map((c) => c.text), { taskType: "SEMANTIC_SIMILARITY" }) : [];
  const questions: PracticeQuestion[] = [];
  const results: { group: string; result: GenerateResult }[] = [];
  for (const g of groups) {
    const avoid: string[] = [];
    for (const [k, anchor] of g.anchors.entries()) {
      const material = await materialOf(anchor, g, input.chunks, { reviews, reviewVecs }, embed);
      const id = `${(g.examId ?? g.topic).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${k + 1}`;
      const r = await generateQuestion(material, { course: input.course, id, avoid: [...avoid], llm });
      results.push({ group: g.topic, result: r });
      deps.onResult?.(r, g);
      if (r.status === "kept") {
        questions.push(r.question);
        avoid.push(r.question.stem);
      }
    }
  }
  return { questions, results };
}
