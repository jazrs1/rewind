// Runs the whole course pipeline (T20) on a real export, every stage cached and resumable:
//   download → extract → chunk → embed → exams → generate (+ check) → retrieve → output
// Inputs: private/<COURSE>.course.json, private/import/<COURSE>.roles.json (T15), the student's
// Files-tab download in private/files/<COURSE>/ (T17 path B, matched by name and size to any
// version of an item), and the lecture transcripts: --transcripts a,b,c (.transcript.json or a
// saved Zoom page .html), else private/pipeline/<COURSE>/transcripts/*.transcript.json, else (COP3530)
// private/fixtures/zoom-recording.html and private/lectures/*.transcript.json.
// Writes private/pipeline/<COURSE>/*.json (run.json records which stages finished), output.json
// and transcripts.json, which /practice reads in dev (app/practice/pipeline-seed.ts); slide images
// for the practice set are rendered to private/demo/slides/.
//
// Downloads: local copies are used first; files already in files/ count as present, and --seed <dir>
// copies PDFs there by exact Canvas name first (default: private/spike only when there is no local
// folder). Network downloads are OFF unless --download or REWIND_ENABLE_DOWNLOAD=1 (and the
// export's links aren't signed anyway, T17); every failure is recorded and the run says so.
// Every write (stage files, reports, downloads, slide images in private/demo/slides/) goes through
// lib/pipeline/private-fs.ts's guarded helpers, inside the pinned real private folder.
//
// npm run pipeline -- --course COP3530 [--slides-only] [--from generate] [--yes] [--seed private/spike | --seed none] [--per-group 3] [--transcripts a,b] [--download]
// Before anything runs it prints the plan (each stage: run, or reuse <file> (saved <time>)). If any stage
// would be reused, it says so loudly and stops (exit 2, no model calls) unless --yes is given.
// (usage logs and caches default to the main checkout's .cache, so the Claude and Gemini caps see
// every worktree's spend; LLM_USAGE_LOG / GEMINI_USAGE_LOG / REWIND_CACHE_DIR override, lib/spend.ts)
// Terminal output is counts only: course text, file names and quotes stay in private/pipeline/.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { extractText } from "unpdf";
import { geminiUsagePath, MODELS } from "../../lib/gemini.ts";
import { classify } from "../../lib/import/normalize.ts";
import { createLLM, LLM_MODELS, type UsageRecord } from "../../lib/llm.ts";
import type { PlanItem } from "../../lib/pipeline/download.ts";
import { downloadStage } from "../../lib/pipeline/download-stage.ts";
import { checkCourseCode, ensureDirInside, guardedFileDeps, readInside, realPrivateRoot, writeInside } from "../../lib/pipeline/private-fs.ts";
import { findExams } from "../../lib/pipeline/exams.ts";
import { canvasPageRole, extractCourse } from "../../lib/pipeline/extract.ts";
import { generatePracticeSet } from "../../lib/pipeline/generate.ts";
import { defaultTranscriptPaths, loadTranscripts } from "../../lib/pipeline/local-adapter.ts";
import { buildIndex, retrieveAll } from "../../lib/pipeline/retrieve.ts";
import type { PipelineOutput } from "../../lib/pipeline/types.ts";
import { formatPlan, MANIFEST_FILE, pageKindOfPng, parsePageKinds, parseRenderedManifest, planRun, readManifest, runPipeline, slideNeedsRender, STAGE_FILES, STAGES, toPracticeSeed, type RunExport, type Stage } from "../../lib/pipeline/run.ts";
import { loadLocalFolder } from "./local-folder.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const exists = (p: string) => stat(p).then(() => true, () => false);
async function readJSON<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// The course code becomes a path under private/: letters and digits only.
const code = checkCourseCode(arg("course") ?? "COP3530");
const from = arg("from") as Stage | undefined;
if (from && !STAGES.includes(from)) throw new Error(`--from must be one of ${STAGES.join(", ")}`);
// Every write goes through lib/pipeline/private-fs.ts: private/ must resolve to the pinned real
// private folder, output folders are made one segment at a time (a symlinked one is refused), and
// files are created with O_EXCL | O_NOFOLLOW after a re-check that their folder is inside it.
const privateLink = resolve("private");
const realRoot = await realPrivateRoot(privateLink);
const out = await ensureDirInside(realRoot, ["pipeline", code]);
const filesDir = await ensureDirInside(realRoot, ["pipeline", code, "files"]);
const saveText = (name: string, text: string) => writeInside(realRoot, out, name, text, { replace: true });
const save = (name: string, data: unknown) => saveText(name, JSON.stringify(data, null, 2));

const exp = await readJSON<RunExport>(join("private", `${code}.course.json`));
if (!exp) throw new Error(`private/${code}.course.json not found`);
const items = (await readJSON<PlanItem[]>(join("private", "import", `${code}.roles.json`))) ?? [];
if (!items.length) console.warn(`No private/import/${code}.roles.json: run lib/import/run-roles.ts first; no files will be planned.`);

// Transcripts: --transcripts, else the course's own folder, else (COP3530) the lectures on disk.
async function transcriptPaths(): Promise<string[]> {
  const given = arg("transcripts");
  if (given) return given.split(",").map((p) => p.trim()).filter(Boolean);
  const dir = join(out, "transcripts");
  if (await exists(dir)) return (await readdir(dir)).filter((x) => x.endsWith(".transcript.json")).sort().map((f) => join(dir, f));
  return code === "COP3530" ? defaultTranscriptPaths("private") : [];
}
const tPaths = await transcriptPaths();
const transcripts = await loadTranscripts(tPaths, "private");
if (transcripts.length < tPaths.length) console.warn(`Transcripts: ${tPaths.length - transcripts.length} of ${tPaths.length} input(s) couldn't be read.`);
// The transcript panel's lines for /practice (the output keeps only each recording's title and link).
await saveText("transcripts.json", JSON.stringify(transcripts));

// The student's own Files-tab download, matched to the export by name and size.
const localFolder = await loadLocalFolder(code, privateLink);
const files = guardedFileDeps(realRoot, filesDir, localFolder.dir);
let localReport: { files: number; matchedTargets: number; matchedByRole: Record<string, number>; otherVersion: number; ambiguous: number; unmatched: number } | null = null;

const seedArg = arg("seed") ?? (localFolder.files.length ? "none" : join("private", "spike"));
const seedDir = seedArg === "none" || !(await exists(seedArg)) ? null : seedArg;
/** The practice set /practice shows, and its slide images (rendered from the PDFs we have). */
async function renderSlides(output: PipelineOutput) {
  const { seed, slides } = toPracticeSeed(output, transcripts);
  const slideDir = await ensureDirInside(realRoot, ["demo", "slides"]);
  // Which deck (size and hash) each image was rendered from, so a changed deck is rendered again.
  const RENDERED = "slides-rendered.json";
  let renderedFrom: Record<string, string> = {};
  if ((await lstat(join(slideDir, RENDERED)).catch(() => null))?.isFile()) {
    const parsed = parseRenderedManifest(new TextDecoder().decode(await readInside(slideDir, join(slideDir, RENDERED)).catch(() => new Uint8Array())));
    if (!parsed) console.warn(`${RENDERED} couldn't be read; every slide image is rendered again.`);
    renderedFrom = parsed ?? {};
  }
  let rendered = 0;
  const slideFailures: string[] = [];
  // Slide or document page, by the rendered page's shape (a PDF of slides is a slide deck whatever its name).
  const KINDS = "slides-kinds.json";
  const kinds: Record<string, "slide" | "page"> = (await lstat(join(slideDir, KINDS)).catch(() => null))?.isFile()
    ? parsePageKinds(new TextDecoder().decode(await readInside(slideDir, join(slideDir, KINDS)).catch(() => new Uint8Array())))
    : {};
  for (const s of slides) {
    // One slide never stops the run: a failure is counted and the next slide goes on.
    try {
      const pdf = join(filesDir, `${s.fileId}.pdf`);
      if (!(await lstat(pdf).catch(() => null))?.isFile()) continue;
      const bytes = await readInside(filesDir, pdf);
      const key = `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}:p${s.page}`;
      const have = (await lstat(join(slideDir, s.image)).catch(() => null))?.isFile() ?? false;
      if (!slideNeedsRender(renderedFrom, s.image, key, have)) {
        if (!kinds[s.image]) {
          const kind = pageKindOfPng(await readInside(slideDir, join(slideDir, s.image)));
          if (kind) kinds[s.image] = kind;
        }
        continue;
      }
      // The PNG comes back on stdout and is saved through the guarded write (no other file is written).
      const { stdout } = await promisify(execFile)("swift", ["scripts/spike/render-page.swift", pdf, String(s.page), "-", "1600"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      const png = new Uint8Array(stdout);
      await writeInside(realRoot, slideDir, s.image, png, { replace: true });
      renderedFrom[s.image] = key;
      const kind = pageKindOfPng(png);
      if (kind) kinds[s.image] = kind;
      rendered++;
    } catch (e) {
      slideFailures.push(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  }
  await writeInside(realRoot, slideDir, RENDERED, JSON.stringify(renderedFrom, null, 2), { replace: true });
  await writeInside(realRoot, slideDir, KINDS, JSON.stringify(kinds, null, 2), { replace: true });
  return { seed, slides: slides.length, rendered, slideFailures };
}

// --slides-only: render the slide images for the finished run's output.json (no stage runs, no model calls).
if (process.argv.includes("--slides-only")) {
  const text = (await lstat(join(out, "output.json")).catch(() => null))?.isFile() ? new TextDecoder().decode(await readInside(out, join(out, "output.json"))) : null;
  if (!text) throw new Error("no output.json yet: run the pipeline first");
  const r = await renderSlides(JSON.parse(text) as PipelineOutput);
  console.log(JSON.stringify({ slides: r.slides, rendered: r.rendered, failures: r.slideFailures.length }));
  process.exit(0);
}

// The plan, before any stage or model call, by the same rule runPipeline follows (planRun). Reusing a
// saved stage is never silent: it needs --yes, else exit 2 with nothing run.
const isFileHere = async (f: string) => (await lstat(join(out, f)).catch(() => null))?.isFile() ?? false;
const manifestText = (await isFileHere(MANIFEST_FILE)) ? new TextDecoder().decode(await readInside(out, join(out, MANIFEST_FILE))) : null;
const here = new Set<string>();
for (const f of Object.values(STAGE_FILES)) if (await isFileHere(f)) here.add(f);
const plan = planRun(readManifest(manifestText), from, (f) => here.has(f));
const confirmed = process.argv.includes("--yes");
for (const line of formatPlan(plan, confirmed)) console.log(line);
if (plan.some((p) => p.action === "reuse") && !confirmed) process.exit(2);

const llm = createLLM();
const started = new Date().toISOString();

const result = await runPipeline(
  { exp, items, transcripts, from, perGroup: Number(arg("per-group") ?? 3) },
  {
    read: async (f) => (await lstat(join(out, f)).catch(() => null))?.isFile() ? new TextDecoder().decode(await readInside(out, join(out, f))) : null,
    write: (f, t) => saveText(f, t),
    download: async (targets) => {
      if (seedDir) {
        const local = new Set((await readdir(seedDir)).filter((f) => f.toLowerCase().endsWith(".pdf")));
        const realSeed = await realpath(seedDir);
        for (const t of targets) if (t.ext === "pdf" && local.has(t.name)) await writeInside(realRoot, filesDir, `${t.fileId}.pdf`, await readInside(realSeed, join(seedDir, t.name)), { replace: true });
      }
      // Local matches (ambiguous ones reported, not guessed), then signed links only with --download.
      const s = await downloadStage(targets, localFolder.files, { fetch: (url, init) => fetch(url, init), ...files }, { argv: process.argv, env: process.env });
      // Paths only (never contents), for the summary; private/ only.
      await save("local-unmatched.json", s.unmatched);
      await save("local-ambiguous.json", s.ambiguous);
      localReport = { files: localFolder.files.length, matchedTargets: s.local.size, matchedByRole: s.matchedByRole, otherVersion: [...s.local.values()].filter((f) => f.version).length, ambiguous: s.ambiguous.length, unmatched: s.unmatched.length };
      return s.downloads;
    },
    extract: (e, downloads) =>
      extractCourse(e, downloads, {
        read: (f) => readInside(filesDir, join(filesDir, f)),
        pdfText: async (bytes) => (await extractText(bytes, { mergePages: false })).text,
      }, { pageRole: (title) => canvasPageRole(classify(title, []).role) }),
    embed: async (chunks, ts) => {
      // The same embeddings retrieve's index asks for (cached by lib/gemini.ts).
      const index = await buildIndex(ts, chunks);
      return { texts: index.windows.length + index.pages.length };
    },
    findExams: (input) =>
      findExams(input, {
        generateJSON: (m, p, s, o) => llm.generateJSON({ provider: "gemini", model: m }, p, s, { system: o?.system }),
        model: MODELS.flash,
      }),
    generate: async (input) => {
      const set = await generatePracticeSet(input, {
        llm,
        onResult: (r) => console.log(r.status === "kept" ? `  kept after ${r.attempts.length} attempt(s)` : `  dropped (${[...new Set(r.failures.map((f) => f.rule))].join(", ")})`),
      });
      return {
        questions: set.questions,
        results: set.results.map(({ group, result }) => ({ group, status: result.status, attempts: result.attempts.length, ...(result.status === "dropped" ? { reason: result.reason } : {}) })),
      };
    },
    retrieve: async (qs, ts, chunks) => (await retrieveAll(qs, ts, chunks, { courseCode: code, llm })).questions,
    cost: async (since) => {
      const lines = ((await readFile(llm.usagePath, "utf8").catch(() => "")) as string).split("\n").filter(Boolean).map((l) => JSON.parse(l) as UsageRecord).filter((u) => u.at >= since);
      const sum = (p: string) => Number(lines.filter((u) => u.provider === p).reduce((n, u) => n + (u.costUsd ?? 0), 0).toFixed(4));
      return { geminiUsd: sum("gemini"), claudeUsd: sum("anthropic") };
    },
    now: () => new Date(),
    log: (m) => console.log(m),
  },
);

const { seed, rendered, slideFailures } = await renderSlides(result.output);

// Embedding usage isn't priced in the LLM log; report its tokens from lib/gemini's log.
const embedTokens = ((await readFile(geminiUsagePath(), "utf8").catch(() => "")) as string)
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; kind: string; usage: Record<string, number> | null })
  .filter((u) => u.at >= started && u.kind === "embed")
  .reduce((n, u) => n + (u.usage?.promptTokenCount ?? u.usage?.totalTokenCount ?? 0), 0);

const o = result.output;
const pct = (n: number) => (o.counts.questions ? `${Math.round((100 * n) / o.counts.questions)}%` : "-");
const report = {
  course: code,
  ran: result.ran,
  downloads: {
    planned: result.downloads.length,
    downloaded: result.downloads.filter((d) => d.status === "downloaded").length,
    local: result.downloads.filter((d) => d.status === "local").length,
    presentLocally: result.downloads.filter((d) => d.status === "present").length,
    failed: result.downloads.filter((d) => d.status === "failed").length,
    byRole: Object.fromEntries(
      [...new Set(result.downloads.map((d) => d.role))].sort().map((r) => {
        const of = result.downloads.filter((d) => d.role === r);
        return [r, { planned: of.length, downloaded: of.filter((d) => d.status === "downloaded").length, local: of.filter((d) => d.status === "local").length, present: of.filter((d) => d.status === "present").length, failed: of.filter((d) => d.status === "failed").length }];
      }),
    ),
    failedBy: Object.fromEntries(
      [...new Set(result.downloads.filter((d) => d.status === "failed").map((d) => d.reason ?? "?"))].map((r) => [r, result.downloads.filter((d) => d.status === "failed" && (d.reason ?? "?") === r).length]),
    ),
    localFolder: localReport,
  },
  docsWithText: result.docs.filter((d) => d.pages.some((p) => p.text.trim().length >= 15)).length,
  counts: o.counts,
  withClipPct: pct(o.counts.withClip),
  withSlidePct: pct(o.counts.withSlide),
  practiceFor: result.generated.examIds,
  generated: { kept: result.generated.results.filter((r) => r.status === "kept").length, dropped: result.generated.results.filter((r) => r.status === "dropped").length },
  transcripts: transcripts.length,
  practiceSeed: { questions: seed.questions.length, recording: seed.recordingUrl ? "yes" : "none", slidesRendered: rendered, slideFailures: slideFailures.length },
  cost: { ...o.cost, embedTokensUnpriced: embedTokens, note: "LLM log since this run's start; Gemini embeddings aren't priced there" },
  claudeModels: [LLM_MODELS.questions.model, LLM_MODELS.answerCheck.model],
};
await save("run-report.json", report);
// Counts only on the terminal (the report holds no course text either).
console.log(JSON.stringify(report, null, 2));

const unsigned = result.downloads.filter((d) => d.status === "failed" && /signed|login|expired|download disabled/i.test(d.reason ?? "")).length;
if (unsigned) console.log(`\nDownloads: ${unsigned} of ${result.downloads.length} files weren't fetched (network download is off unless --download; when on, the export's unsigned links get a Canvas login page). The run used ${report.downloads.local} local and ${report.downloads.presentLocally} already-present file(s).`);
if (!o.counts.questions) console.log("No questions: generate writes from slides and course files with text, else from Canvas pages with role \"page\", and this run had none (announcements and assignments are read for exams only).");
const fields = ["name", "date", "location", "format", "notesRule", "topics"] as const;
o.exams.forEach((e, i) => {
  const quoted = fields.filter((f) => e[f].quote).length;
  console.log(`exam ${i + 1}: date ${e.date.value ? "found" : "not found"}, quoted fields ${quoted}/${fields.length}, conflicts ${e.conflicts?.length ?? 0}, questions ${o.questions.filter((q) => q.examId === e.id).length}`);
});
