// The course pipeline, end to end (T20):
//   download → extract → chunk → embed → exams → generate (+ check) → retrieve → output
// Every stage writes its result under private/pipeline/<COURSE>/ and records it in run.json.
// A rerun loads a stage from its file only when run.json says this runner wrote it and no earlier
// stage ran again (so a file left by another script, or one older than its inputs, is redone).
// `from` reruns a stage and everything after it. All I/O and model calls are injected, so tests
// run with fakes; scripts/pipeline/run.ts wires the real ones. Model calls are cached on disk by
// lib/llm.ts and lib/gemini.ts, so a rerun with the same inputs costs nothing.

import { toQuoteSource } from "../questions/quote-source.ts";
import type { PracticeSeed, SeedQuestion } from "../demo/types.ts";
import type { TranscriptSegment } from "../schema.ts";
import { chunkDocs, type ChunkExport } from "./chunk.ts";
import { planDownloads, type DownloadResult, type DownloadTarget, type ExportFile, type PlanItem } from "./download.ts";
import { examKey, type ExamExport, type FindExamsResult, type FoundExam } from "./exams.ts";
import type { ExtractExport } from "./extract.ts";
import type { PracticeSetInput } from "./generate.ts";
import { dominantSpeaker, shownSlide } from "./retrieve.ts";
import type { ExtractedDoc, PipelineChunk, PipelineOutput, PipelineTranscript, PracticeQuestion } from "./types.ts";

export const STAGES = ["download", "extract", "chunk", "embed", "exams", "generate", "retrieve", "output"] as const;
export type Stage = (typeof STAGES)[number];

/** File each stage writes (relative to the course's pipeline directory). */
export const STAGE_FILES: Record<Stage, string> = {
  download: "downloads.json",
  extract: "docs.json",
  chunk: "chunks.json",
  embed: "embed.json",
  exams: "exams.json",
  generate: "generated.json",
  retrieve: "questions.json",
  output: "output.json",
};

/** Which stages this runner finished, and when (private/pipeline/<COURSE>/run.json). */
export const MANIFEST_FILE = "run.json";
export interface RunManifest {
  stages: Partial<Record<Stage, { at: string }>>;
}

export type RunExport = ExtractExport & ChunkExport & ExamExport & { files: ExportFile[] };

export interface GenerateStageResult {
  questions: PracticeQuestion[];
  /** Per generated question: kept or dropped (with the reason), for the report. */
  results: { group: string; status: "kept" | "dropped"; reason?: string; attempts: number }[];
  /** The exams the practice was written for. */
  examIds: string[];
}

export interface RunDeps {
  /** Reads a stage file; null when it doesn't exist. */
  read: (file: string) => Promise<string | null>;
  write: (file: string, text: string) => Promise<void>;
  download: (targets: DownloadTarget[]) => Promise<DownloadResult[]>;
  extract: (exp: RunExport, downloads: DownloadResult[]) => Promise<ExtractedDoc[]>;
  /** Embeds what generate and retrieve will ask for, so they hit the cache. Returns how many texts. */
  embed: (chunks: PipelineChunk[], transcripts: PipelineTranscript[]) => Promise<{ texts: number }>;
  findExams: (input: { docs: ExtractedDoc[]; exp: RunExport }) => Promise<FindExamsResult>;
  generate: (input: PracticeSetInput) => Promise<{ questions: PracticeQuestion[]; results: GenerateStageResult["results"] }>;
  retrieve: (questions: PracticeQuestion[], transcripts: PipelineTranscript[], chunks: PipelineChunk[]) => Promise<PracticeQuestion[]>;
  /** Cost of the paid calls made since `since` (from the usage logs). */
  cost: (since: string) => Promise<PipelineOutput["cost"]>;
  now: () => Date;
  log?: (msg: string) => void;
}

export interface RunInput {
  exp: RunExport;
  /** Import items with roles and versions (lib/import, or private/import/<COURSE>.roles.json). */
  items: PlanItem[];
  transcripts: PipelineTranscript[];
  /** Rerun this stage and every later one; earlier stages load from their files. */
  from?: Stage;
  /** Questions per exam or topic group (generate). */
  perGroup?: number;
}

/**
 * Which exams get a practice set: the upcoming exams (date today or later, or not found);
 * if any of them is a main exam (Exam N, Midterm N, Final Exam), only those.
 */
export function examsForPractice(exams: FoundExam[], now: Date): FoundExam[] {
  const today = now.toISOString().slice(0, 10);
  const upcoming = exams.filter((e) => !e.date.value || e.date.value.slice(0, 10) >= today);
  const main = upcoming.filter((e) => /^(exam|midterm)-\d+$|^final-exam$/.test(examKey(String(e.name.value ?? ""))));
  return main.length ? main : upcoming;
}

function parseManifest(text: string | null): RunManifest {
  try {
    const m = text ? (JSON.parse(text) as RunManifest) : null;
    return m && typeof m.stages === "object" && m.stages ? m : { stages: {} };
  } catch {
    return { stages: {} };
  }
}

export interface StagePlan {
  stage: Stage;
  /** reuse: its saved file is loaded as is (no model calls for it); run: it runs. */
  action: "run" | "reuse";
  file: string;
  /** When run.json says this runner saved it (reuse only). */
  savedAt: string | null;
}

/**
 * What a run will do, stage by stage, before it does anything (runPipeline follows the same plan): a stage
 * is reused only when it is before `from`, run.json says this runner saved it, its file is there, and no
 * earlier stage runs; once one stage runs, every later one runs too.
 */
export function planRun(manifest: RunManifest, from: Stage | undefined, has: (file: string) => boolean): StagePlan[] {
  const fromIndex = from ? STAGES.indexOf(from) : STAGES.length;
  let running = false;
  return STAGES.map((stage, i) => {
    const file = STAGE_FILES[stage];
    const saved = manifest.stages[stage];
    const reuse = !running && i < fromIndex && !!saved && has(file);
    if (!reuse) running = true;
    return { stage, action: reuse ? "reuse" : "run", file, savedAt: reuse ? saved!.at : null };
  });
}

/** The plan as terminal lines: a loud warning first when anything is reused, then one line per stage. */
export function formatPlan(plan: StagePlan[], confirmed: boolean): string[] {
  const reused = plan.filter((p) => p.action === "reuse");
  const lines: string[] = [];
  if (reused.length) {
    lines.push(`!!! REUSING ${reused.length} SAVED STAGE${reused.length === 1 ? "" : "S"}: ${reused.map((p) => p.stage).join(", ")}`);
    lines.push("!!! Their saved files are used as they are. To redo a stage, pass --from <stage>.");
    if (!confirmed) lines.push("!!! Nothing has run. Check the plan below, then run again with --yes to go ahead.");
  }
  lines.push("Plan:");
  for (const p of plan) lines.push(`  ${p.stage.padEnd(9)} ${p.action === "run" ? "run" : `reuse ${p.file} (saved ${p.savedAt})`}`);
  return lines;
}

/** Read run.json's text into a manifest (an unreadable one means nothing is saved). */
export function readManifest(text: string | null): RunManifest {
  return parseManifest(text);
}

export interface RunResult {
  output: PipelineOutput;
  /** Which stages ran this time (the rest loaded from their files). */
  ran: Stage[];
  docs: ExtractedDoc[];
  chunks: PipelineChunk[];
  downloads: DownloadResult[];
  generated: GenerateStageResult;
}

export async function runPipeline(input: RunInput, deps: RunDeps): Promise<RunResult> {
  const { exp } = input;
  const started = deps.now().toISOString();
  const ran: Stage[] = [];
  const manifest = parseManifest(await deps.read(MANIFEST_FILE));
  // The plan (planRun): the files a reuse needs are read once, here.
  const saved = new Map<string, string>();
  for (const s of STAGES.slice(0, input.from ? STAGES.indexOf(input.from) : STAGES.length)) {
    const text = manifest.stages[s] ? await deps.read(STAGE_FILES[s]) : null;
    if (text === null) break; // this stage runs, and so does every later one
    saved.set(STAGE_FILES[s], text);
  }
  const plan = new Map(planRun(manifest, input.from, (f) => saved.has(f)).map((p) => [p.stage, p]));

  async function stage<T>(name: Stage, make: () => Promise<T>): Promise<T> {
    // Once a stage runs, every later stage runs too: its inputs may have changed.
    if (plan.get(name)!.action === "reuse" && ran.length === 0) {
      deps.log?.(`${name}: loaded ${STAGE_FILES[name]}`);
      return JSON.parse(saved.get(STAGE_FILES[name])!) as T;
    }
    deps.log?.(`${name}: running`);
    const value = await make();
    await deps.write(STAGE_FILES[name], JSON.stringify(value, null, 2));
    ran.push(name);
    // Later stages are no longer valid until they run again.
    for (const later of STAGES.slice(STAGES.indexOf(name) + 1)) delete manifest.stages[later];
    manifest.stages[name] = { at: deps.now().toISOString() };
    await deps.write(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    return value;
  }

  const downloads = await stage("download", () => deps.download(planDownloads(exp.files, input.items)));
  const docs = await stage("extract", () => deps.extract(exp, downloads));
  const chunks = await stage("chunk", async () => chunkDocs(docs, exp));
  await stage("embed", () => deps.embed(chunks, input.transcripts));
  const { exams } = await stage("exams", () => deps.findExams({ docs, exp }));
  const generated = await stage<GenerateStageResult>("generate", async () => {
    const target = examsForPractice(exams, deps.now());
    const course = { code: exp.course.course_code ?? String(exp.course.id), name: exp.course.name ?? "" };
    const g = await deps.generate({ course, exams: target, chunks, perGroup: input.perGroup });
    return { ...g, examIds: target.map((e) => e.id) };
  });
  const questions = await stage("retrieve", () => deps.retrieve(generated.questions, input.transcripts, chunks));
  const output = await stage<PipelineOutput>("output", async () => ({
    course: { id: exp.course.id, code: exp.course.course_code ?? String(exp.course.id), name: exp.course.name ?? "" },
    generatedAt: deps.now().toISOString(),
    counts: {
      docs: docs.length,
      chunks: chunks.length,
      exams: exams.length,
      questions: questions.length,
      withClip: questions.filter((q) => q.retrieval.clip).length,
      withSlide: questions.filter((q) => q.retrieval.slide).length,
    },
    exams,
    questions,
    transcripts: input.transcripts.map((t) => ({ id: t.id, title: t.title, recordingUrl: t.recordingUrl, recordedAt: t.recordedAt })),
    cost: await deps.cost(started),
  }));
  return { output, ran, docs, chunks, downloads, generated };
}

// ---------- the practice page's seed (lib/demo/types.ts) from the pipeline's output ----------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** Lecturer lines kept after the clip, for the transcript panel. */
const AFTER_SEC = 20;

/** FNV-1a, 32-bit, as 8 hex digits (no node:crypto: this module is also read by the practice page's loader). */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(s)) h = Math.imul(h ^ ch, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Readable part of a slide image name; the hash makes the name unique and keeps it short. */
const SLIDE_SLUG_CHARS = 60;

/**
 * The slide image's file name, as the dev route serves it (private/demo/slides/<name>, matching
 * /^[a-z0-9-]+\.png$/): a short slug of the deck, a hash of the deck's file id and name (two decks
 * whose names slug alike never share an image), and the page. At most about 90 bytes.
 */
export function slideImageName(deck: string, page: number, fileId: number): string {
  const readable = slug(deck).slice(0, SLIDE_SLUG_CHARS).replace(/-+$/, "") || "deck";
  return `${readable}-${shortHash(`${fileId}:${deck}`)}-p${page}.png`;
}

/** What a rendered page looks like, from its PNG header: landscape is a slide, anything else a document page. */
export function pageKindOfPng(png: Uint8Array): "slide" | "page" | null {
  // PNG signature, then the IHDR chunk: width and height are big-endian at bytes 16 and 20.
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50 || png[12] !== 0x49 || png[13] !== 0x48) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  return w && h ? (w > h * 1.1 ? "slide" : "page") : null;
}

/** The slide images' page kinds (slides-kinds.json, image name → "slide" | "page"); bad entries are dropped. */
export function parsePageKinds(text: string): Record<string, "slide" | "page"> {
  const out: Record<string, "slide" | "page"> = {};
  for (const [k, v] of Object.entries(parseRenderedManifest(text) ?? {})) if (v === "slide" || v === "page") out[k] = v;
  return out;
}

/**
 * The older name of a slide image ("<slug>-p<page>.png", before the hash was added), for a
 * new-style name ("<slug>-<8 hex>-p<page>.png"); null for any other name. The dev route serves the
 * older render while the new one hasn't been made (a deck whose name slugs to over 60 characters
 * has no older match).
 */
export function legacySlideName(name: string): string | null {
  const m = name.match(/^([a-z0-9-]+)-[0-9a-f]{8}-p(\d+)\.png$/);
  return m ? `${m[1]}-p${m[2]}.png` : null;
}

/**
 * The slide renders' manifest (image name → the deck key it was rendered from), or null when it
 * isn't a JSON object of strings (a damaged file then means "render everything again", never a crash).
 */
export function parseRenderedManifest(text: string): Record<string, string> | null {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
    return out;
  } catch {
    return null;
  }
}

/**
 * Whether a slide image must be (re)rendered: it's missing, or the deck it was rendered from has
 * changed since (its key, e.g. the PDF's size and hash, differs from the one recorded then).
 */
export function slideNeedsRender(rendered: Record<string, string>, image: string, sourceKey: string, imageExists: boolean): boolean {
  return !imageExists || rendered[image] !== sourceKey;
}

/**
 * PipelineOutput → PracticeSeed for /practice. The set's recording is the one most clips come
 * from; a question whose clip is in another lecture names that recording (`match.recordingUrl`),
 * and its captions come from that lecture's transcript. A clip whose transcript isn't loaded falls
 * back to its slide. A question with neither a clip nor a slide can't be shown and is left out.
 */
export function toPracticeSeed(output: PipelineOutput, transcripts: PipelineTranscript[], pageKinds: Record<string, "slide" | "page"> = {}): { seed: PracticeSeed; slides: { deck: string; page: number; fileId: number; image: string }[] } {
  const counts = new Map<string, number>();
  for (const q of output.questions) if (q.retrieval.clip) counts.set(q.retrieval.clip.recordingUrl, (counts.get(q.retrieval.clip.recordingUrl) ?? 0) + 1);
  const recordingUrl = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const transcript = transcripts.find((t) => t.recordingUrl === recordingUrl) ?? null;
  const lecturer = transcript ? dominantSpeaker(transcript.segments) : null;
  const slides: { deck: string; page: number; fileId: number; image: string }[] = [];
  const questions: SeedQuestion[] = [];
  for (const q of output.questions) {
    // The slide (or page) retrieval picked (retrieve.ts shownSlide): the page the quote is from, unless a lecture
    // question's quote is from a deck the lecture never shows (lib/pipeline/lecture-slides.ts).
    const qs = q.quoteSource;
    const s = shownSlide(q);
    // A quote from a Canvas page (a course with only pages of text): the page itself, shown as its
    // words (the quote), with no image; such a question has no rewind screen, so no clip either.
    const canvasPage = !s ? (qs?.kind === "page" ? qs : (q.retrieval.page ?? null)) : null;
    if (!s && !canvasPage) continue;
    // The clip's own lecture: its transcript gives the captions (its lecturer's lines only).
    const own = q.retrieval.clip && s ? (transcripts.find((t) => !!t.recordingUrl && t.recordingUrl === q.retrieval.clip!.recordingUrl) ?? null) : null;
    const clip = own ? q.retrieval.clip : null;
    const deck = s ? (s.kind === "slide" ? s.deck : s.name) : canvasPage!.title;
    const image = s ? slideImageName(deck, s.page, s.fileId) : "";
    if (s && !slides.some((x) => x.image === image)) slides.push({ deck, page: s.page, fileId: s.fileId, image });
    const slide: SeedQuestion["match"]["slide"] = s
      ? { deck, page: s.page, image, ...(s.href ? { canvasUrl: s.href } : {}), ...((pageKinds[image] ?? (s.kind === "document" ? "page" : "slide")) === "page" ? { kind: "page" as const } : {}) }
      : { deck, page: 0, image: "", kind: "page", excerpt: q.quote, ...(canvasPage!.href ? { canvasUrl: canvasPage!.href } : {}) };
    let segments: TranscriptSegment[] = [];
    if (clip && own) {
      const speaker = own === transcript ? lecturer : dominantSpeaker(own.segments);
      const from = Math.min(clip.exampleStart ?? clip.start, clip.start) - 5;
      segments = own.segments.filter((x) => (!speaker || x.speaker === speaker) && x.start >= from && x.start < clip.end + AFTER_SEC);
    }
    const where = toQuoteSource(q.quoteSource);
    questions.push({
      id: q.id,
      n: questions.length + 1,
      stem: q.stem,
      ...(q.code ? { code: { language: q.code.language, lines: q.code.lines } } : {}),
      choices: q.choices,
      answer: q.answer,
      explanation: q.explanation,
      ...(where ? { source: { quote: q.quote, where } } : {}),
      match: {
        // No clip: start and end null, and the player shows the slide (PracticeFlow's clipOf).
        start: clip ? clip.start : (null as unknown as number),
        end: clip ? clip.end : (null as unknown as number),
        exampleStart: clip ? clip.exampleStart : null,
        setup: clip ? clip.setup : null,
        sourceLines: clip ? clip.sourceLines : [],
        ...(clip && clip.recordingUrl !== recordingUrl ? { recordingUrl: clip.recordingUrl } : {}),
        slide,
      },
      segments,
    });
  }
  const name = lecturer ?? "the lecturer";
  const examNames = output.exams.filter((e) => output.questions.some((q) => q.examId === e.id)).map((e) => e.name.value).filter(Boolean);
  return {
    seed: {
      course: { code: output.course.code, name: output.course.name },
      set: examNames.length ? `Practice for ${examNames.join(", ")}` : "Practice from the course slides",
      lecturer: { name, short: name.split(/\s+/).pop() ?? name },
      recordingUrl,
      questions,
      questionSet: "generated",
      ...(transcript ? { lectureTitle: transcript.title } : {}),
    },
    slides,
  };
}
