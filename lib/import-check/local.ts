// Feeds the import check from the course pipeline's own report data in private/pipeline/<CODE>/
// (run-report.json or front-half-report.json, downloads.json, docs.json, exams.json, output.json or
// questions.json, generated.json) and the Canvas export. Dev only, like the course home: real course
// data never goes into a production build or demo mode. Missing files leave their parts "not found".

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDemoMode } from "../demo/guard.ts";
import { HOME_COURSE, modulesFromExport, type CourseExportLite } from "../home/local.ts";
import type { ExtractedDoc, PipelineExam, PracticeQuestion } from "../pipeline/types.ts";
import { buildImportCheck, type ImportCheck } from "./build.ts";

const PRIVATE = () => join(process.cwd(), "private");

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface DownloadReport {
  downloads?: { localFolder?: { unmatched?: number } };
  generated?: { kept: number; dropped: number };
}

type ExamFile = PipelineExam & { windowCloses?: { value: string; itemId: string } | null };
type ExportWithCounts = CourseExportLite & { pages?: unknown[]; announcements?: unknown[] };

export async function loadLocalImportCheck(now: string, code = HOME_COURSE): Promise<ImportCheck | null> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  const dir = join(PRIVATE(), "pipeline", code);
  const [run, front, downloads, docs, examsFile, output, questionsFile, generated, exp] = await Promise.all([
    readJson<DownloadReport>(join(dir, "run-report.json")),
    readJson<DownloadReport>(join(dir, "front-half-report.json")),
    readJson<{ role: string; status: string; reason?: string | null; ext?: string | null }[]>(join(dir, "downloads.json")),
    readJson<(ExtractedDoc & { problem?: string })[]>(join(dir, "docs.json")),
    readJson<ExamFile[] | { exams: ExamFile[] }>(join(dir, "exams.json")),
    readJson<{ generatedAt?: string; questions?: PracticeQuestion[]; transcripts?: unknown[] }>(join(dir, "output.json")),
    readJson<PracticeQuestion[]>(join(dir, "questions.json")),
    readJson<{ results?: { status: string }[] }>(join(dir, "generated.json")),
    readJson<ExportWithCounts>(join(PRIVATE(), `${code}.course.json`)),
  ]);
  if (!run && !front && !downloads && !docs && !examsFile && !exp) return null;
  const report = run ?? front;
  const questions = output?.questions?.length ? output.questions : (questionsFile ?? []);
  const tally = generated?.results?.length
    ? { kept: generated.results.filter((r) => r.status === "kept").length, dropped: generated.results.filter((r) => r.status === "dropped").length }
    : (report?.generated ?? null);
  return buildImportCheck({
    course: { code: exp?.course.course_code ?? code, name: exp?.course.name ?? null, importedAt: exp?.exportedAt ?? null },
    ranAt: output?.generatedAt ?? null,
    now,
    recordings: output?.transcripts ? output.transcripts.length : null,
    downloads: downloads ?? [],
    localUnmatched: report?.downloads?.localFolder?.unmatched ?? null,
    docs: (docs ?? []).map((d) => {
      const text = d.problem ? "" : d.pages.map((p) => p.text).join("\n");
      return { name: d.name, role: d.role, hasText: !!text.trim(), problem: d.problem ?? null, text };
    }),
    canvas: { pages: exp?.pages?.length ?? null, announcements: exp?.announcements?.length ?? null, assignments: exp?.assignments?.length ?? null },
    // The exams stage keeps a Canvas assignment's due_at as windowCloses (metadata, not a quote).
    exams: Array.isArray(examsFile) ? examsFile : (examsFile?.exams ?? []),
    modules: modulesFromExport(exp),
    questions: questions.map((q) => ({
      topic: q.topic,
      source: q.quoteSource && "deck" in q.quoteSource ? q.quoteSource.deck : q.quoteSource && "name" in q.quoteSource ? q.quoteSource.name : "",
      clip: !!q.retrieval?.clip,
      slide: q.retrieval?.slide ? (q.retrieval.slide.kind === "slide" ? "slide" : "document") : null,
      fallback: q.retrieval?.fallback ?? null,
    })),
    generated: tally,
  });
}
