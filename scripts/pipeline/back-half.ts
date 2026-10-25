// Runs the pipeline's back half end to end: generate → check → retrieve, on the course files we
// already have (lib/pipeline/local-adapter.ts stands in for T17's download/extract/chunk), or on
// private/pipeline/<COURSE>/chunks.json + exams.json when T17 has written them.
// Writes private/pipeline/<COURSE>/questions.json (PracticeQuestion[]) and back-half-report.json.
//
// Run: LLM_USAGE_LOG=/abs/usage.jsonl node --env-file=.env.local scripts/pipeline/back-half.ts \
//        [--course COP3530] [--per-group 2] [--groups "7 - Sets, Maps, HashTables,8a - Graph Terminology and Implementation"]

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatTime } from "../../lib/format.ts";
import { generatePracticeSet, ruleTally, sourceLabel } from "../../lib/pipeline/generate.ts";
import { loadLocalCourse } from "../../lib/pipeline/local-adapter.ts";
import { checkCourseCode, ensureDirInside, realPrivateRoot, writeInside } from "../../lib/pipeline/private-fs.ts";
import { retrieveAll } from "../../lib/pipeline/retrieve.ts";
import type { PipelineChunk, PipelineExam } from "../../lib/pipeline/types.ts";

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

const code = checkCourseCode(arg("course") ?? "COP3530");
// Writes go through lib/pipeline/private-fs.ts: inside the pinned real private folder, folders made
// one segment at a time (a symlinked one is refused), files created with O_EXCL | O_NOFOLLOW.
const realRoot = await realPrivateRoot(resolve("private"));
const out = await ensureDirInside(realRoot, ["pipeline", code]);
const save = (name: string, data: unknown) => writeInside(realRoot, out, name, JSON.stringify(data, null, 2), { replace: true });
const local = await loadLocalCourse({ courseCode: code });
const t17Chunks = await readJSON<PipelineChunk[]>(join(out, "chunks.json"));
const exams = (await readJSON<PipelineExam[]>(join(out, "exams.json"))) ?? [];
const chunks = t17Chunks ?? local.chunks;
console.log(`${code}: ${chunks.length} chunks (${t17Chunks ? "T17 chunks.json" : "local adapter"}), ${exams.length} exams, ${local.transcripts.length} transcripts`);

const groups = arg("groups")?.split(",").map((s) => s.trim());
const course = { code, name: local.course.name };
const set = await generatePracticeSet(
  { course, exams, chunks, perGroup: Number(arg("per-group") ?? 2), groups },
  {
    onResult: (r, g) =>
      console.log(r.status === "kept" ? `kept (${r.attempts.length} attempts) [${g.topic}]: ${r.question.stem}` : `dropped [${g.topic}]: ${r.reason}`),
  },
);
const { questions, debug } = await retrieveAll(set.questions, local.transcripts, chunks, { courseCode: code });
for (const q of questions) {
  const c = q.retrieval.clip;
  console.log(`\n${q.id}: ${q.stem}`);
  console.log(`  quote: ${sourceLabel(q.quoteSource)}; code: ${q.code ? `${q.code.lines.length} lines from ${sourceLabel(q.code.source)}` : "none"}`);
  console.log(`  clip: ${c ? `${c.transcriptId} ${formatTime(c.start)}-${formatTime(c.end)}, example ${c.exampleStart === null ? "-" : formatTime(c.exampleStart)}, setup ${c.setup ?? "(none)"}` : `none (fallback ${q.retrieval.fallback})`}`);
  console.log(`  slide: ${q.retrieval.slide ? sourceLabel(q.retrieval.slide) : "none"}`);
}
await save("questions.json", questions);
const tally = ruleTally(set.results.map((r) => r.result));
await save("back-half-report.json", { tally, results: set.results, retrieval: debug });
console.log(`\nKept ${tally.kept}, dropped ${tally.dropped} (${tally.attempts} attempts). Rejected by rule: ${JSON.stringify(tally.rejectedBy)}`);
console.log(`Wrote private/pipeline/${code}/questions.json`);
