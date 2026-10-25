// Re-runs retrieval (clip, setup line, slide) for some questions of a finished run, with the
// current retrieval rules, without regenerating the questions. For a reviewer's clip check.
// Real keys: run it from the main checkout. Writes only through lib/pipeline/private-fs.ts.
//
// node --env-file=.env.local scripts/pipeline/reclip.ts --course COP3530 --questions id1,id2
// Terminal output: ids, times and yes/no only (no course text).

import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createLLM } from "../../lib/llm.ts";
import { checkCourseCode, ensureDirInside, readInside, realPrivateRoot, writeInside } from "../../lib/pipeline/private-fs.ts";
import { buildIndex, questionLecture, retrieveOne } from "../../lib/pipeline/retrieve.ts";
import type { PipelineChunk, PipelineOutput, PipelineTranscript, PracticeQuestion } from "../../lib/pipeline/types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const code = checkCourseCode(arg("course") ?? "COP3530");
const ids = (arg("questions") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!ids.length) throw new Error("--questions id1,id2 is required");

const realRoot = await realPrivateRoot(resolve("private"));
const out = await ensureDirInside(realRoot, ["pipeline", code]);
const read = async <T>(name: string): Promise<T> => {
  if (!(await lstat(join(out, name)).catch(() => null))?.isFile()) throw new Error(`${name} not found: run the pipeline first`);
  return JSON.parse(new TextDecoder().decode(await readInside(out, join(out, name)))) as T;
};
const save = (name: string, data: unknown) => writeInside(realRoot, out, name, JSON.stringify(data, null, 2), { replace: true });

const chunks = await read<PipelineChunk[]>("chunks.json");
const transcripts = await read<PipelineTranscript[]>("transcripts.json");
const questions = await read<PracticeQuestion[]>("questions.json");
const output = await read<PipelineOutput>("output.json");
const index = await buildIndex(transcripts, chunks);
const llm = createLLM();

const changes: { id: string; before: unknown; after: unknown }[] = [];
const updated = new Map<string, PracticeQuestion>();
for (const id of ids) {
  const q = questions.find((x) => x.id === id);
  if (!q) {
    console.log(`${id}: not found`);
    continue;
  }
  const own = questionLecture(q, index);
  const r = await retrieveOne(q, index, { courseCode: code, llm, lecture: own.t });
  const sum = (c: PracticeQuestion["retrieval"]["clip"]) => (c ? { start: Math.round(c.start), end: Math.round(c.end), exampleStart: c.exampleStart === null ? null : Math.round(c.exampleStart), setup: !!c.setup } : null);
  const before = sum(q.retrieval.clip);
  const after = sum(r.retrieval.clip);
  changes.push({ id, before, after });
  updated.set(id, { ...q, retrieval: r.retrieval, prompts: { ...q.prompts, ...r.prompts } });
  console.log(`${id}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
}

const swap = (list: PracticeQuestion[]) => list.map((q) => updated.get(q.id) ?? q);
output.questions = swap(output.questions);
output.counts = { ...output.counts, withClip: output.questions.filter((q) => q.retrieval.clip).length, withSlide: output.questions.filter((q) => q.retrieval.slide).length };
await save("questions.json", swap(questions));
await save("output.json", output);
await save("reclip-report.json", { at: new Date().toISOString(), changes });
