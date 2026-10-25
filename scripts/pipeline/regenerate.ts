// Regenerates one question of a finished run with a reviewer's reason, through the normal path:
// generate (+ the rules and the blind check, at most 2 retries, else dropped) → retrieve (its own
// lecture, a new setup line) → written into generated.json, questions.json and output.json.
// Real keys: run it from the main checkout. Writes only through lib/pipeline/private-fs.ts.
//
// node --env-file=.env.local scripts/pipeline/regenerate.ts --course COP3530 --question <id> --reason "..."
// Terminal output is counts only (no course text).

import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { embed } from "../../lib/gemini.ts";
import { createLLM } from "../../lib/llm.ts";
import { generateQuestion, materialOf } from "../../lib/pipeline/generate.ts";
import { checkCourseCode, ensureDirInside, readInside, realPrivateRoot, writeInside } from "../../lib/pipeline/private-fs.ts";
import { buildIndex, questionLecture, retrieveOne } from "../../lib/pipeline/retrieve.ts";
import type { PipelineChunk, PipelineOutput, PipelineTranscript, PracticeQuestion } from "../../lib/pipeline/types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const code = checkCourseCode(arg("course") ?? "COP3530");
const id = arg("question");
const reason = arg("reason");
if (!id || !reason) throw new Error("--question <id> and --reason <text> are required");

const realRoot = await realPrivateRoot(resolve("private"));
const out = await ensureDirInside(realRoot, ["pipeline", code]);
const read = async <T>(name: string): Promise<T> => {
  if (!(await lstat(join(out, name)).catch(() => null))?.isFile()) throw new Error(`${name} not found: run the pipeline first`);
  return JSON.parse(new TextDecoder().decode(await readInside(out, join(out, name)))) as T;
};
const save = (name: string, data: unknown) => writeInside(realRoot, out, name, JSON.stringify(data, null, 2), { replace: true });

const chunks = await read<PipelineChunk[]>("chunks.json");
const transcripts = await read<PipelineTranscript[]>("transcripts.json");
const generated = await read<{ questions: PracticeQuestion[]; results: { group: string; status: string; attempts: number; reason?: string }[]; examIds: string[] }>("generated.json");
const questions = await read<PracticeQuestion[]>("questions.json");
const output = await read<PipelineOutput>("output.json");

const old = questions.find((q) => q.id === id);
if (!old) throw new Error(`no question ${id}`);
const qs = old.quoteSource;
const anchor = chunks.find((c) => (c.source.kind === "slide" || c.source.kind === "document") && c.source.itemId === qs.itemId && "page" in qs && c.source.page === qs.page);
if (!anchor) throw new Error("the question's quote isn't on a slide or page in chunks.json; can't rebuild its material");

const llm = createLLM();
const reviews = chunks.filter((c) => c.role === "review" && c.text.trim());
const reviewVecs = reviews.length ? await embed(reviews.map((c) => c.text), { taskType: "SEMANTIC_SIMILARITY" }) : [];
const examName = output.exams.find((e) => e.id === old.examId)?.name.value ?? null;
const material = await materialOf(anchor, { topic: old.topic, examId: old.examId, examName }, chunks, { reviews, reviewVecs }, embed);
const avoid = questions.filter((q) => q.topic === old.topic && q.id !== id).map((q) => q.stem);
const course = { code: output.course.code, name: output.course.name };
const r = await generateQuestion(material, { course, id, avoid, llm, reason });

let next: PracticeQuestion | null = null;
let lecture: string | null = null;
if (r.status === "kept") {
  const index = await buildIndex(transcripts, chunks);
  const own = questionLecture(r.question, index);
  lecture = own.reason;
  const rr = await retrieveOne(r.question, index, { courseCode: code, llm, lecture: own.t });
  next = { ...r.question, retrieval: rr.retrieval, prompts: { ...r.question.prompts, ...rr.prompts } };
}

const swap = (list: PracticeQuestion[]) => (next ? list.map((q) => (q.id === id ? next! : q)) : list.filter((q) => q.id !== id));
generated.questions = swap(generated.questions);
generated.results.push({ group: old.topic, status: r.status, attempts: r.attempts.length, ...(r.status === "dropped" ? { reason: r.reason } : {}), regenerated: id, why: reason } as (typeof generated.results)[number]);
const kept = swap(questions);
output.questions = swap(output.questions);
output.counts = { ...output.counts, questions: output.questions.length, withClip: output.questions.filter((q) => q.retrieval.clip).length, withSlide: output.questions.filter((q) => q.retrieval.slide).length };
await save("generated.json", generated);
await save("questions.json", kept);
await save("output.json", output);
await save(`regenerate-${id}.json`, { at: new Date().toISOString(), id, reason, status: r.status, attempts: r.attempts.map((a) => ({ rejected: a.rejected, failures: a.failures.map((f) => f.rule) })), lecture, clip: next?.retrieval.clip ?? null, setup: next?.retrieval.clip?.setup ?? null });
console.log(JSON.stringify({ id, status: r.status, attempts: r.attempts.length, rejectedBy: r.attempts.flatMap((a) => a.failures.map((f) => f.rule)), clip: !!next?.retrieval.clip, setupLine: !!next?.retrieval.clip?.setup, questions: output.questions.length }));
