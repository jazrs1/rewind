// Runs the pipeline's front half (T17) on a real course export:
//   download → extract → chunk → exams
// Reads private/<COURSE>.course.json and private/import/<COURSE>.roles.json (T15's roles; the
// rules alone if it's missing). Writes private/pipeline/<COURSE>/{files/, downloads.json,
// docs.json, chunks.json, exams.json, front-half-report.json}. Real course data: private/ only.
//
// Local files first: private/files/<COURSE>/ may hold the student's download of the Files tab,
// loose or as Canvas's .zip (unpacked next to it into <name>.unzipped/, safe paths only: no
// absolute paths, `..`, symlinks or files over the cap). Files are matched to the export by
// display name (then size) and saved as files/<fileId>.<ext>, counted as "local".
//
// --seed <dir>: before downloading, copy PDFs from <dir> whose name matches a planned file's
// Canvas name exactly into files/ (slides John already saved by hand), so they count as present.
//
// Network downloads (signed links) are OFF by default: only with --download or
// REWIND_ENABLE_DOWNLOAD=1; otherwise files not already present or local are "download disabled".
//
// Run: node --env-file=.env.local scripts/pipeline/front-half.ts --course COP3530 [--seed private/spike] [--download]

import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractText } from "unpdf";
import { MODELS, generateJSON, geminiUsagePath } from "../../lib/gemini.ts";
import { classify, normalizeCourse } from "../../lib/import/normalize.ts";
import type { CourseExport } from "../../lib/import/types.ts";
import { chunkDocs, type ChunkExport } from "../../lib/pipeline/chunk.ts";
import { planDownloads, type ExportFile, type PlanItem } from "../../lib/pipeline/download.ts";
import { downloadStage } from "../../lib/pipeline/download-stage.ts";
import { checkCourseCode, ensureDirInside, guardedFileDeps, readInside, realPrivateRoot, writeInside } from "../../lib/pipeline/private-fs.ts";
import { findExams, type ExamExport } from "../../lib/pipeline/exams.ts";
import { canvasPageRole, extractCourse, type ExtractExport } from "../../lib/pipeline/extract.ts";
import { loadLocalFolder } from "./local-folder.ts";

/** The export as each stage reads it (raw Canvas objects with the fields they use). */
type StageExport = ExtractExport & ChunkExport & ExamExport & { files: ExportFile[] };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function readJSON<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// The course code becomes a path under private/: letters and digits only.
const code = checkCourseCode(arg("course") ?? "COP3530");
const seed = arg("seed");
// Every write goes through lib/pipeline/private-fs.ts: private/ must resolve to the pinned real
// private folder (a worker worktree's private/ symlink to the main checkout's is fine), the output
// folders are made one segment at a time (a symlinked one is refused), and files are created with
// O_EXCL | O_NOFOLLOW after a re-check that their folder's real path is inside it.
const privateLink = resolve("private");
const realRoot = await realPrivateRoot(privateLink);
const out = await ensureDirInside(realRoot, ["pipeline", code]);
const filesDir = await ensureDirInside(realRoot, ["pipeline", code, "files"]);
const localDir = resolve("private", "files", code);
const files = guardedFileDeps(realRoot, filesDir, localDir);
const save = (name: string, data: unknown) => writeInside(realRoot, out, name, JSON.stringify(data, null, 2), { replace: true });

const exp = await readJSON<StageExport>(join("private", `${code}.course.json`));
if (!exp) throw new Error(`private/${code}.course.json not found`);
const roles = await readJSON<PlanItem[]>(join("private", "import", `${code}.roles.json`));
const items: PlanItem[] = roles ?? normalizeCourse(exp as unknown as CourseExport).items;

// 1. Download: local copies, then signed links only with --download (no cookies).
const targets = planDownloads(exp.files, items);
let seeded = 0;
if (seed) {
  const local = new Set((await readdir(seed)).filter((f) => f.toLowerCase().endsWith(".pdf")));
  for (const t of targets) {
    if (t.ext === "pdf" && local.has(t.name)) {
      await writeInside(realRoot, filesDir, `${t.fileId}.pdf`, await readInside(await realpath(seed), join(seed, t.name)), { replace: true });
      seeded++;
    }
  }
}
// Local copies first: private/files/<COURSE>/ (the student's Files-tab download, loose or zipped).
const { files: localFiles, unzip } = await loadLocalFolder(code, privateLink);
// Local matches (ambiguous ones reported, not guessed), then signed links only with --download.
const stage = await downloadStage(targets, localFiles, { fetch: (url, init) => fetch(url, init), ...files }, { argv: process.argv, env: process.env });
const { downloads, local, matchedByRole, ambiguous: ambiguousLocal, unmatched: unmatchedLocal, network: download } = stage;
// For the report: which local files matched (by role) and which didn't (paths only, never contents).
const usedPaths = new Set([...local.values()].map((f) => f.path));
const reasons: Record<string, number> = {};
for (const d of downloads) if (d.status === "failed") reasons[d.reason ?? "?"] = (reasons[d.reason ?? "?"] ?? 0) + 1;
const tally = { planned: targets.length, downloaded: 0, local: 0, present: 0, failed: 0 };
for (const d of downloads) tally[d.status]++;

// 2. Extract.
const docs = await extractCourse(exp, downloads, {
  read: (f) => readInside(filesDir, join(filesDir, f)),
  pdfText: async (bytes) => (await extractText(bytes, { mergePages: false })).text,
}, { pageRole: (title) => canvasPageRole(classify(title, []).role) });
const withText = docs.filter((d) => d.pages.some((p) => p.text.trim().length >= 15));

// 3. Chunk.
const chunks = chunkDocs(docs, exp);
const byKind: Record<string, number> = {};
for (const c of chunks) byKind[c.source.kind] = (byKind[c.source.kind] ?? 0) + 1;

// 4. Exams (Gemini Flash, cached by lib/gemini.ts).
const started = new Date().toISOString();
const { exams, checked } = await findExams({ docs, exp }, {
  generateJSON: (m, p, s, o) => generateJSON(m, p, s, o),
  model: MODELS.flash,
});

await save("downloads.json", downloads);
await save("docs.json", docs);
await save("chunks.json", chunks);
await save("exams.json", exams);

// Gemini usage this run (uncached calls only).
const usage = ((await readFile(geminiUsagePath(), "utf8").catch(() => "")) as string)
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; model: string; usage: Record<string, number> | null })
  .filter((u) => u.at >= started);
const sum = (k: string) => usage.reduce((n, u) => n + (u.usage?.[k] ?? 0), 0);
const report = {
  course: code,
  roles: roles ? "private/import roles.json (T15)" : "rules only",
  downloads: { ...tally, network: download ? "enabled" : "download disabled", seededFromLocal: seeded, localFolder: { files: localFiles.length, matchedTargets: local.size, matchedFiles: usedPaths.size, matchedByRole, otherVersion: [...local.values()].filter((f) => f.version).length, unmatched: unmatchedLocal.length, ambiguous: ambiguousLocal.length, unzip }, failedBy: reasons },
  docs: { total: docs.length, withText: withText.length, problems: docs.filter((d) => d.problem).length },
  chunks: { total: chunks.length, byKind },
  exams: {
    found: exams.length,
    withDate: exams.filter((e) => e.date.value).length,
    withWindowCloses: exams.filter((e) => e.windowCloses).length,
    conflicts: exams.reduce((n, e) => n + e.conflicts.length, 0),
    modelProposed: checked.proposed,
    refusedFields: checked.refusedFields,
    prompt: checked.prompt,
  },
  gemini: { paidCalls: usage.length, promptTokens: sum("promptTokenCount"), outputTokens: sum("candidatesTokenCount"), thinkingTokens: sum("thoughtsTokenCount") },
};
await save("front-half-report.json", report);
await save("local-unmatched.json", unmatchedLocal);
await save("local-ambiguous.json", ambiguousLocal);
// Counts only on the terminal: real course text (names, quotes) stays in private/pipeline/.
console.log(JSON.stringify(report, null, 2));
const fields = ["name", "date", "location", "format", "notesRule", "topics"] as const;
exams.forEach((e, i) => {
  const quoted = fields.filter((f) => e[f].quote).length;
  console.log(`exam ${i + 1}: date ${e.date.value ? (e.date.value.length > 10 ? "date+time" : "date only") : "not found"}, window closes ${e.windowCloses ? "yes" : "no"}, quoted fields ${quoted}/${fields.length}, conflicts ${e.conflicts.length}`);
});
