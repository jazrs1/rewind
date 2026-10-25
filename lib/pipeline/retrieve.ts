// Pipeline stage: retrieve. For each practice question, the best lecture moment and the best
// slide, with the rewind spike's rules (scripts/spike/match.ts, 5/5 by ear on COP3530):
// - only the lecturer's lines are searched (per transcript, the speaker with the most text), in
//   40 s windows overlapping by 20 s that never span another speaker; embedded with Gemini
//   Embedding 2;
// - Flash rewrites the question as a lecture-style explanation (the query), then picks the moment
//   among the top 5 windows and its start and end lines; the clip is at most 75 s, starts on a
//   real line and never runs into another speaker;
// - exampleStart and the setup line come from the setup-line prompt (lib/prompts/setup-line.ts),
//   checked in code: grounded in the lines before the clip, no numbers, at most 35 words;
// - the slide: pages ranked by the query plus the clip, Flash picks among the top 3;
// - no recording (or no moment explains it): the slide alone, else a reading, else nothing.
// Model calls go through lib/llm.ts (Flash and the setup line) and lib/gemini.ts (embeddings).

import { formatTime } from "../format.ts";
import { embed as geminiEmbed } from "../gemini.ts";
import { createLLM, LLM_MODELS, type ModelRef } from "../llm.ts";
import { SETUP_LINE_SCHEMA, SETUP_MAX_WORDS, setupLinePrompt, type SetupLineReply, VERSION as SETUP_VERSION } from "../prompts/setup-line.ts";
import { cosine, makeWindows, MIN_GROUNDING, setupGrounding, setupNumbers, snapToSegment, topK, type TranscriptWindow, wordCount } from "../rewind.ts";
import type { TranscriptSegment } from "../schema.ts";
import type { Embedder, JSONGenerator } from "./generate.ts";
import { isLectureDeck, LECTURE_SLIDE_MIN, rankLecturePages } from "./lecture-slides.ts";
import type { PipelineChunk, PipelineTranscript, PracticeQuestion, Retrieval, SourceRef } from "./types.ts";

const CANDIDATES = 5;
const CONTEXT_SEC = 20;
const CLIP_SEC = 40;
/** A clip runs to the end of the thought, but never longer than this. */
export const MAX_CLIP_SEC = 75;
/** Lines shown to Flash after a window's start, so it can see where the thought ends. */
const LOOKAHEAD_SEC = 95;
/** How far back the example's start can be. */
const SETUP_LOOKBACK_SEC = 300;

export interface RetrieveDeps {
  llm?: JSONGenerator;
  embed?: Embedder;
  /** Model for Flash picks (rewrite, moment, slide). */
  flashModel?: ModelRef;
  /** Model for the setup line (docs/BRIEF.md: claude-sonnet-5-5). */
  setupModel?: ModelRef;
}

// ---------- pure helpers (from the spike) ----------

/** The speaker with the most transcript text. */
export function dominantSpeaker(segments: TranscriptSegment[]): string | null {
  const chars = new Map<string, number>();
  for (const s of segments) if (s.speaker) chars.set(s.speaker, (chars.get(s.speaker) ?? 0) + s.text.length);
  return [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Unbroken runs of the lecturer's speech (other speakers end a run). A null lecturer keeps everyone. */
export function lecturerRuns(all: TranscriptSegment[], lecturer: string | null): TranscriptSegment[][] {
  const runs: TranscriptSegment[][] = [];
  let run: TranscriptSegment[] = [];
  for (const s of all) {
    if (!lecturer || s.speaker === lecturer) run.push(s);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** A time label as Flash returns it: "1:37:59", or copied with brackets, "[1:37:59]". */
export function labelTime(label: string): number | null {
  const m = label.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])];
  return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

const timed = (segs: TranscriptSegment[]) => segs.map((s) => `[${formatTime(s.start)}] ${s.text}`).join("\n");

/** "stem (A) … (B) …", with the code when there is some: what the spike's prompts call the question. */
export function questionText(q: Pick<PracticeQuestion, "stem" | "choices" | "code">): string {
  const code = q.code?.lines.length ? `\n${q.code.lines.join("\n")}\n` : " ";
  return `${q.stem}${code}${q.choices.map((c) => `(${c.label}) ${c.text}`).join(" ")}`;
}

/** Words too common in a lecture or a question to tell two passages apart. */
const COMMON = new Set(
  "about above after again also always another answer based because before being below between both called case cases code could does doing done each else every example first following given goes going have here into just know like look make many more most much need next only other over right same should show since some something still such than that their them then there these they thing think this those through time used using value values very want what when where which while will with would your".split(" "),
);
const termWords = (s: string) => (s.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((w) => !COMMON.has(w)).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).filter((w) => !COMMON.has(w));

/** The question's key terms: the stem's, the right answer's and its quote's distinctive words (deduplicated). */
export function keyTerms(q: { stem: string; choices: { label: string; text: string }[]; answer?: string; quote?: string }): string[] {
  const right = q.choices.find((c) => c.label === q.answer)?.text ?? "";
  return [...new Set(termWords(`${q.stem} ${right} ${q.quote ?? ""}`))];
}

/** The share of the key terms a passage says (0 to 1). */
export function termCoverage(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const have = new Set(termWords(text));
  return terms.filter((t) => have.has(t)).length / terms.length;
}

/** How much a window's key-term coverage counts next to its embedding similarity when ranking candidates. */
export const TERM_WEIGHT = 0.15;
/** A line starting at most this long after the clip's end can still finish its thought. */
export const EXTEND_GAP_SEC = 20;

/**
 * The clip's end, run on through the lines right after it that still state at least two of the
 * question's key terms (each starting within EXTEND_GAP_SEC of the current end), never past `cap`.
 */
export function extendEnd(segs: TranscriptSegment[], end: number, cap: number, terms: string[]): number {
  const need = Math.min(2, terms.length);
  if (!need) return end;
  let out = end;
  for (const s of segs) {
    if (s.start < out - 0.5) continue;
    if (s.start > out + EXTEND_GAP_SEC || s.end > cap) break;
    const have = new Set(termWords(s.text));
    if (terms.filter((t) => have.has(t)).length >= need) out = s.end;
  }
  return out;
}

/**
 * Is `a` (a setup line) about what `b` (the clip and the question) is about? At least a third of
 * its distinctive words are in `b`: "he shares his screen and talks about selection and bubble
 * sort" shares only "sort" with a clip on insertion sort, so it isn't.
 */
export const sharesTerm = (a: string, b: string) => {
  const bw = new Set(termWords(b));
  const aw = [...new Set(termWords(a))];
  return aw.length > 0 && aw.filter((w) => bw.has(w)).length * 3 >= aw.length;
};

/** Checks a setup reply against every line from the example's start to the clip (sourceLines are the citation). */
export function checkSetup(sp: SetupLineReply, before: { id: number; seg: TranscriptSegment }[]) {
  const example = before.find((l) => l.id === sp.exampleLine);
  const span = before.filter((l) => l.id >= (example?.id ?? before[0].id));
  const cited = [...new Set(sp.sourceLines)].filter((id) => span.some((l) => l.id === id)).sort((a, b) => a - b);
  const g = setupGrounding(sp.setup, span.map((l) => l.seg.text));
  const nums = setupNumbers(sp.setup);
  if (nums.length) g.unsupported.push(...nums.map((n) => `the number ${n}`));
  const words = wordCount(sp.setup);
  const ok = sp.setup.trim() !== "" && cited.length > 0 && words <= SETUP_MAX_WORDS && g.score >= MIN_GROUNDING && nums.length === 0;
  return { example, cited, grounding: g, words, ok };
}

// ---------- index ----------

interface Win extends TranscriptWindow {
  t: number;
  /** For topK's minimum gap: transcripts far apart, so windows in different lectures never shadow each other. */
  key: number;
}

export interface RetrieveIndex {
  transcripts: { t: PipelineTranscript; lecturer: string | null; runs: TranscriptSegment[][]; lineId: Map<TranscriptSegment, number> }[];
  windows: Win[];
  windowVecs: number[][];
  pages: { chunk: PipelineChunk; source: Extract<SourceRef, { kind: "slide" | "document" }> }[];
  pageVecs: number[][];
}

function pageLabel(s: Extract<SourceRef, { kind: "slide" | "document" }>): string {
  return s.kind === "slide" ? `${s.deck}, slide ${s.page}` : `${s.name}, page ${s.page}`;
}

const deckName = (s: Extract<SourceRef, { kind: "slide" | "document" }>) => (s.kind === "slide" ? s.deck : s.name);

/**
 * How close a lecture is to a deck: for each of the deck's pages its best window in that lecture,
 * averaged over the deck's best quarter of pages (a lecture covers part of a deck, not all of it).
 */
export function deckLectureScores(index: RetrieveIndex, deck: string): number[] {
  const pages = index.pages.map((p, i) => (deckName(p.source) === deck ? i : -1)).filter((i) => i >= 0);
  if (!pages.length) return index.transcripts.map(() => 0);
  return index.transcripts.map((_, t) => {
    const ws = index.windows.flatMap((w, i) => (w.t === t ? [i] : []));
    if (!ws.length) return 0;
    const best = pages.map((p) => Math.max(...ws.map((w) => cosine(index.pageVecs[p], index.windowVecs[w])))).sort((a, b) => b - a);
    const top = best.slice(0, Math.max(1, Math.ceil(best.length / 4)));
    return top.reduce((a, b) => a + b, 0) / top.length;
  });
}

/**
 * A deck is taught in a lecture when that lecture's score reaches TAUGHT and beats every other
 * lecture by MARGIN. Calibrated on COP3530 (Oct 24, Gemini Embedding 2): the decks each lecture
 * taught scored 0.74 to 0.80 with a lead of 0.03 or more; decks no lecture taught stayed under 0.735.
 */
export const TAUGHT = 0.74;
export const MARGIN = 0.03;

/** The lecture (transcript index) that teaches this deck, or null when none clearly does. */
export function lectureForDeck(scores: number[]): number | null {
  if (!scores.length) return null;
  const order = scores.map((s, t) => ({ s, t })).sort((a, b) => b.s - a.s);
  const [best, second] = order;
  if (best.s < TAUGHT) return null;
  if (second && best.s - second.s < MARGIN) return null;
  return best.t;
}

/**
 * Per transcript, the numbered lecture decks it teaches (lectureForDeck), sorted; null when the course has no
 * numbered deck at all (then the lecture-deck rule doesn't apply).
 */
export function lectureDecks(index: RetrieveIndex): string[][] | null {
  const decks = [...new Set(index.pages.map((p) => deckName(p.source)))].filter(isLectureDeck).sort();
  if (!decks.length) return null;
  const out: string[][] = index.transcripts.map(() => []);
  for (const d of decks) {
    const t = lectureForDeck(deckLectureScores(index, d));
    if (t !== null) out[t].push(d);
  }
  return out;
}

/** The index windows of lecture `t` that overlap [start, end). */
export const windowsIn = (index: RetrieveIndex, t: number, start: number, end: number) => index.windows.flatMap((w, i) => (w.t === t && w.start < end && w.end > start ? [i] : []));

/** The index page a source points to, or -1. */
export const pageIndexOf = (index: RetrieveIndex, s: Extract<SourceRef, { kind: "slide" | "document" }>) =>
  index.pages.findIndex((p) => p.source.itemId === s.itemId && p.source.page === s.page);

/** The slide (or page) a question shows: the retriever's pick. Only a question retrieval never ran on shows its quote's page. */
export function shownSlide(q: Pick<PracticeQuestion, "quoteSource" | "retrieval">): Extract<SourceRef, { kind: "slide" | "document" }> | null {
  if (q.retrieval && "slide" in q.retrieval) return q.retrieval.slide;
  const qs = q.quoteSource;
  return qs && (qs.kind === "slide" || qs.kind === "document") ? qs : null;
}

/**
 * Which lecture a question's clip may come from: the lecture its quote is from, else the one that
 * teaches its source deck (the quote's deck, else the group's), else none: no clip beats a clip
 * from a lecture on another topic.
 */
export function questionLecture(q: Pick<PracticeQuestion, "quoteSource" | "topic">, index: RetrieveIndex, cache: Map<string, number | null> = new Map()): { t: number | null; reason: string } {
  const qs = q.quoteSource;
  if (qs?.kind === "lecture") {
    const t = index.transcripts.findIndex((x) => x.t.recordingUrl === qs.recordingUrl);
    return t >= 0 ? { t, reason: "the quote's lecture" } : { t: null, reason: "the quote's lecture isn't loaded" };
  }
  const deck = qs && (qs.kind === "slide" || qs.kind === "document") ? deckName(qs) : q.topic;
  if (!cache.has(deck)) cache.set(deck, lectureForDeck(deckLectureScores(index, deck)));
  const t = cache.get(deck)!;
  return t === null ? { t: null, reason: `no lecture clearly teaches "${deck}"` } : { t, reason: `the lecture that teaches "${deck}"` };
}

export async function buildIndex(transcripts: PipelineTranscript[], chunks: PipelineChunk[], deps: RetrieveDeps = {}): Promise<RetrieveIndex> {
  const embed = deps.embed ?? geminiEmbed;
  const ts = transcripts.map((t) => {
    const lecturer = t.source === "phone" ? null : dominantSpeaker(t.segments);
    return { t, lecturer, runs: lecturerRuns(t.segments, lecturer), lineId: new Map(t.segments.map((s, i) => [s, i])) };
  });
  const windows: Win[] = ts.flatMap((x, t) => x.runs.flatMap((r) => makeWindows(r)).map((w) => ({ ...w, t, key: t * 1e7 + w.start })));
  windows.forEach((w, i) => (w.index = i));
  const windowVecs = windows.length ? await embed(windows.map((w) => w.text), { taskType: "RETRIEVAL_DOCUMENT" }) : [];
  const pages = chunks.flatMap((chunk) =>
    (chunk.source.kind === "slide" || chunk.source.kind === "document") && chunk.role !== "review" ? [{ chunk, source: chunk.source }] : [],
  );
  const pageVecs = pages.length ? await embed(pages.map((p) => `${pageLabel(p.source)}: ${p.chunk.text || "(no text)"}`), { taskType: "RETRIEVAL_DOCUMENT" }) : [];
  return { transcripts: ts, windows, windowVecs, pages, pageVecs };
}

// ---------- Flash prompts (the spike's, unchanged) ----------

const REWRITE_SCHEMA = {
  type: "object",
  properties: {
    concept: { type: "string", description: "The concept tested, in a few words" },
    explanation: { type: "string" },
  },
  required: ["concept", "explanation"],
};

export function rewritePrompt(question: string, courseCode: string): string {
  return `A student is practicing with this question from ${courseCode}:

${question}

Write the explanation a professor would give in lecture for the concept this question tests: 3 to 5 sentences in a spoken, classroom style, using the key terms a professor would say out loud. Explain the concept; don't just state the answer to this specific question.`;
}

const PICK_SCHEMA = {
  type: "object",
  properties: {
    candidate: { type: "integer", description: "1-based candidate number, or 0 if none explains it" },
    startLabel: { type: "string", description: "The timestamp exactly as shown at the start of the start line, e.g. 43:40" },
    endLabel: { type: "string", description: "The timestamp exactly as shown at the start of the end line" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string", description: "One sentence" },
  },
  required: ["candidate", "startLabel", "endLabel", "confidence", "reason"],
};

export function pickMomentPrompt(question: string, concept: string, candidates: { segments: TranscriptSegment[] }[]): string {
  const blocks = candidates.map((c, i) => `Candidate ${i + 1}:\n${timed(c.segments)}`).join("\n\n");
  return `A student missed this practice question (concept: ${concept}):

${question}

Below are candidate passages from the professor's lecture transcript. Each line starts with its timestamp.
Pick the passage where the professor best explains what the student needs to answer this question correctly. Prefer an explanation over a passing mention. If none of them explains it, answer candidate 0.

Then pick two lines in that passage:
- Start: the line where he begins explaining the specific point the question tests. For a worked problem, that's where he works out the answer (for example, finds the collisions), not where he first introduces the problem.
- End: the last line of that thought, including any self-correction or conclusion that follows ("actually, did we do this correctly?" and the fix). The clip may run at most ${MAX_CLIP_SEC} seconds from the start.

${blocks}`;
}

const SLIDE_SCHEMA = {
  type: "object",
  properties: { option: { type: "integer" }, reason: { type: "string", description: "One sentence" } },
  required: ["option", "reason"],
};

export function pickSlidePrompt(question: string, context: string, options: { label: string; text: string }[]): string {
  return `A student missed this practice question:

${question}

The professor explains it in this part of the lecture:
${context}

Which of these slides should the student see beside that clip? Choose the one that best helps them answer this question: prefer a slide whose example or comparison matches the question itself over one that only matches the lecture's wording. Answer with its option number.

${options.map((p, i) => `Option ${i + 1} (${p.label}):\n${p.text.slice(0, 1500)}`).join("\n\n")}`;
}

// ---------- retrieve ----------

export interface RetrieveDebug {
  concept: string;
  pick: { candidate: number; confidence: string; reason: string } | null;
  setupCheck: { words: number; grounding: number; unsupported: string[]; shown: boolean } | null;
  slideReason: string | null;
  /** The lecture the clip was searched in (retrieveAll), and why. */
  lecture?: string | null;
  lectureReason?: string;
}

/** The best lecture moment and slide for one question, or the no-recording fallback. */
export async function retrieveOne(
  q: Pick<PracticeQuestion, "stem" | "choices" | "code"> & Partial<Pick<PracticeQuestion, "quoteSource" | "answer" | "quote">>,
  index: RetrieveIndex,
  opts: {
    courseCode: string;
    /** Only this lecture's windows (questionLecture); null: no clip at all; undefined: every lecture. */
    lecture?: number | null;
    /**
     * The question's lecture's numbered decks (lectureDecks): the slide comes only from these, never a Discussion,
     * Review or game deck or another lecture's deck; no page passing LECTURE_SLIDE_MIN, no slide. Undefined: no rule.
     */
    lectureDecks?: string[];
  } & RetrieveDeps,
): Promise<{ retrieval: Retrieval; debug: RetrieveDebug; prompts: Record<string, string> }> {
  const llm = opts.llm ?? createLLM();
  const embed = opts.embed ?? geminiEmbed;
  const flash = opts.flashModel ?? LLM_MODELS.geminiFlash;
  const setupModel = opts.setupModel ?? LLM_MODELS.setupLines;
  const question = questionText(q);

  const rw = await llm.generateJSON<{ concept: string; explanation: string }>(flash, rewritePrompt(question, opts.courseCode), REWRITE_SCHEMA);
  const [queryVec] = await embed([`${rw.concept}. ${rw.explanation}`], { taskType: "RETRIEVAL_QUERY" });

  let clip: Retrieval["clip"] = null;
  let clipT: number | null = null;
  let clipText = "";
  let pickInfo: RetrieveDebug["pick"] = null;
  let setupCheck: RetrieveDebug["setupCheck"] = null;
  // Only the windows of the question's own lecture (when it's known); none when no lecture teaches it.
  const allowed = index.windows.map((w, i) => ({ w, i })).filter(({ w }) => opts.lecture === undefined || (opts.lecture !== null && w.t === opts.lecture));
  const terms = keyTerms(q);
  if (allowed.length) {
    // A wider pool by meaning, then the candidates where the question's own key terms come up
    // together first (a window that only shares the topic loses to the one working the example).
    const pool = topK(queryVec, allowed.map(({ w }) => ({ ...w, start: w.key })), allowed.map(({ i }) => index.windowVecs[i]), CANDIDATES * 2, CLIP_SEC);
    const candidates = pool
      .map((r) => {
        const w = index.windows[r.item.index];
        const tr = index.transcripts[w.t];
        const segments = tr.runs.flat();
        const until = Math.min(w.start + LOOKAHEAD_SEC, stopBefore(tr, w.start));
        const near = segments.filter((s) => s.start >= w.start - CONTEXT_SEC && s.start < until);
        return { w, tr, segments: near, score: r.score + TERM_WEIGHT * termCoverage(terms, w.text) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES);
    const pick = await llm.generateJSON<{ candidate: number; startLabel: string; endLabel: string; confidence: string; reason: string }>(
      flash,
      pickMomentPrompt(question, rw.concept, candidates),
      PICK_SCHEMA,
    );
    pickInfo = { candidate: pick.candidate, confidence: pick.confidence, reason: pick.reason };
    const chosen = pick.candidate >= 1 && pick.candidate <= candidates.length ? candidates[pick.candidate - 1] : null;
    if (chosen) {
      const lecturerSegs = chosen.tr.runs.flat();
      const s = labelTime(pick.startLabel);
      const startOk = s !== null && chosen.segments.some((x) => Math.abs(x.start - s) < 1);
      const start = snapToSegment(lecturerSegs, startOk ? s! : chosen.w.start);
      const e = labelTime(pick.endLabel);
      const endSeg = e === null ? undefined : chosen.segments.find((x) => Math.abs(x.start - e) < 1 && x.start >= start);
      const cap = Math.min(start + MAX_CLIP_SEC, stopBefore(chosen.tr, start));
      let end = Math.min(endSeg ? endSeg.end : start + CLIP_SEC, cap);
      if (end - start < 15) end = Math.min(start + CLIP_SEC, cap);
      // Run on to the end of the explanation: a line just after the end that still states the
      // question's key terms belongs to the same thought (the conclusion often comes a beat later).
      end = extendEnd(lecturerSegs, end, cap, terms);
      const clipSegs = lecturerSegs.filter((x) => x.start >= start && x.start < end);
      clipText = clipSegs.map((x) => x.text).join(" ");

      // Setup line: what he's in the middle of, from the lines before the clip (same speaker run, up to 5 min).
      let exampleStart: number | null = null;
      let setup: string | null = null;
      let sourceLines: number[] = [];
      const run = clipSegs[0] ? chosen.tr.runs.find((r) => r.includes(clipSegs[0])) : undefined;
      const before = run ? run.filter((x) => x.start < start && x.start >= start - SETUP_LOOKBACK_SEC).map((seg) => ({ id: chosen.tr.lineId.get(seg)!, seg })) : [];
      // A setup is kept only if it is grounded in its lines and about what the clip is about
      // (shares a key word with the clip or the question): a summary of the previous topic isn't.
      const relevant = (s: string) => sharesTerm(s, `${clipText} ${terms.join(" ")}`);
      const trySetup = async (lines: { id: number; seg: TranscriptSegment }[]) => {
        const ask = (avoid: string[] = []) => llm.generateJSON<SetupLineReply>(setupModel, setupLinePrompt({ question, clipText, lines, avoid }), SETUP_LINE_SCHEMA);
        let sp = await ask();
        let c = checkSetup(sp, lines);
        if (!c.ok && c.grounding.unsupported.length) {
          sp = await ask(c.grounding.unsupported);
          c = checkSetup(sp, lines);
        }
        return { sp, c, ok: c.ok && relevant(sp.setup) };
      };
      let got = before.length ? await trySetup(before) : null;
      // No usable setup from the lines before: one from the clip's own opening lines (where the
      // example is already under way), so the student still hears what he's in the middle of.
      let fromClip = false;
      if (!got?.ok) {
        const opening = clipSegs.slice(0, 6).map((seg) => ({ id: chosen.tr.lineId.get(seg)!, seg }));
        if (opening.length) {
          const again = await trySetup(opening);
          if (again.ok || !got) [got, fromClip] = [again, again.ok];
        }
      }
      if (got) {
        const { sp, c, ok } = got;
        exampleStart = ok && !fromClip && c.example ? c.example.seg.start : null;
        setupCheck = { words: c.words, grounding: Number(c.grounding.score.toFixed(2)), unsupported: c.grounding.unsupported, shown: ok };
        setup = ok ? sp.setup.trim() : null;
        sourceLines = ok ? c.cited : [];
      }
      clip = { recordingUrl: chosen.tr.t.recordingUrl, start, end, exampleStart, setup, sourceLines, transcriptId: chosen.tr.t.id };
      clipT = chosen.w.t;
    }
  }

  // Slide: the page the question's quote is from, when it's from a slide or page (the student sees
  // the slide their answer is on); else pages ranked against the explanation plus the clip, and Flash
  // picks among the top 3. A lecture question (lectureDecks) only ever shows its lecture's numbered
  // deck: a quote from another deck gets that deck's closest page to the clip and the quote, if one passes.
  let slide: Retrieval["slide"] = null;
  let slideReason: string | null = null;
  const qs = q.quoteSource;
  const quotePage = qs && (qs.kind === "slide" || qs.kind === "document") ? qs : null;
  const rule = opts.lectureDecks;
  if (quotePage && (!rule || rule.includes(deckName(quotePage)))) {
    slide = quotePage;
    slideReason = "the page the quote is from";
  } else if (rule) {
    const candidates = index.pages.flatMap((p, i) => (rule.includes(deckName(p.source)) ? [i] : []));
    const qp = quotePage ? pageIndexOf(index, quotePage) : -1;
    const signals = {
      windowVecs: clip && clipT !== null ? windowsIn(index, clipT, clip.start, clip.end).map((i) => index.windowVecs[i]) : [],
      quoteVec: qp >= 0 ? index.pageVecs[qp] : null,
    };
    const options = rankLecturePages(index.pageVecs, candidates, signals)
      .filter((r) => r.score >= LECTURE_SLIDE_MIN)
      .slice(0, 3)
      .map((r) => index.pages[r.page]);
    if (options.length) {
      const sp = await llm.generateJSON<{ option: number; reason: string }>(
        flash,
        pickSlidePrompt(question, clipText || rw.explanation, options.map((o) => ({ label: pageLabel(o.source), text: o.chunk.text }))),
        SLIDE_SCHEMA,
      );
      slide = (options[sp.option - 1] ?? options[0]).source;
      slideReason = sp.reason;
    } else {
      slideReason = `no page of ${rule.length ? rule.join(", ") : "this lecture's numbered decks"} reaches ${LECTURE_SLIDE_MIN}`;
    }
  } else if (qs?.kind !== "page" && index.pages.length) {
    const [clipVec] = clipText ? await embed([clipText], { taskType: "RETRIEVAL_QUERY" }) : [queryVec];
    const query = normalize(normalize(queryVec).map((x, i) => x + normalize(clipVec)[i]));
    const top = topK(query, index.pages.map((p, i) => ({ ...p, start: i })), index.pageVecs, 3);
    const options = top.map((r) => r.item);
    const sp = await llm.generateJSON<{ option: number; reason: string }>(
      flash,
      pickSlidePrompt(question, clipText || rw.explanation, options.map((o) => ({ label: o.source.kind === "slide" ? `deck "${o.source.deck}", page ${o.source.page}` : `"${o.source.name}", page ${o.source.page}`, text: o.chunk.text }))),
      SLIDE_SCHEMA,
    );
    slide = (options[sp.option - 1] ?? options[0]).source;
    slideReason = sp.reason;
  }

  // A quote from a Canvas page (a course with no slides or files) carries that page, shown as text.
  const page = qs?.kind === "page" ? qs : null;
  const fallback: Retrieval["fallback"] = clip ? null : slide ? (slide.kind === "slide" ? "slide" : "reading") : page ? "reading" : "none";
  return {
    retrieval: { clip, slide, ...(page ? { page } : {}), fallback },
    debug: { concept: rw.concept, pick: pickInfo, setupCheck, slideReason },
    prompts: clip ? { "setup-line": SETUP_VERSION } : {},
  };
}

/** Where the clip must stop: the next line by anyone other than the lecturer (or the recording's end). */
function stopBefore(tr: RetrieveIndex["transcripts"][number], t: number): number {
  const next = tr.t.segments.find((s) => tr.lecturer && s.speaker !== tr.lecturer && s.start > t);
  return Math.min(tr.t.durationSec, next ? next.start : Infinity);
}

/** Fills `retrieval` on every question. */
export async function retrieveAll(
  questions: PracticeQuestion[],
  transcripts: PipelineTranscript[],
  chunks: PipelineChunk[],
  opts: { courseCode: string } & RetrieveDeps,
): Promise<{ questions: PracticeQuestion[]; debug: Record<string, RetrieveDebug> }> {
  const index = await buildIndex(transcripts, chunks, opts);
  const out: PracticeQuestion[] = [];
  const debug: Record<string, RetrieveDebug> = {};
  const decks = new Map<string, number | null>();
  const taught = lectureDecks(index);
  for (const q of questions) {
    const lecture = questionLecture(q, index, decks);
    const r = await retrieveOne(q, index, { ...opts, lecture: lecture.t, ...(taught && lecture.t !== null ? { lectureDecks: taught[lecture.t] } : {}) });
    out.push({ ...q, retrieval: r.retrieval, prompts: { ...q.prompts, ...r.prompts } });
    debug[q.id] = { ...r.debug, lecture: lecture.t === null ? null : index.transcripts[lecture.t].t.id, lectureReason: lecture.reason };
  }
  return { questions: out, debug };
}
