// More questions on each lecture's topic, added to a finished run (overnight item 18): anchors from
// lib/pipeline/more.ts (pages of the decks a lecture teaches, closest to what was said, not yet
// used), then the normal path for each: generate (rules + blind check, at most 2 retries, else
// dropped) → retrieve in its own lecture → appended to generated.json, questions.json, output.json.
// Real keys: run it from the main checkout. Writes only through lib/pipeline/private-fs.ts.
//
// node --env-file=.env.local scripts/pipeline/more.ts --course COP3530 --counts 2026-10-13=8,2026-10-20=8,2026-10-22=14
// (a lecture is named by its recording date; then `run.ts --slides-only` renders the new slides).
// Terminal output is counts only (no course text).

import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { embed } from "../../lib/gemini.ts";
import { createLLM } from "../../lib/llm.ts";
import { generateQuestion, materialOf } from "../../lib/pipeline/generate.ts";
import { lectureAnchors } from "../../lib/pipeline/more.ts";
import { checkCourseCode, ensureDirInside, readInside, realPrivateRoot, writeInside } from "../../lib/pipeline/private-fs.ts";
import { buildIndex, questionLecture, retrieveOne } from "../../lib/pipeline/retrieve.ts";
import type { PipelineChunk, PipelineOutput, PipelineTranscript, PracticeQuestion } from "../../lib/pipeline/types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const code = checkCourseCode(arg("course") ?? "COP3530");
const countsArg = arg("counts");
if (!countsArg) throw new Error("--counts YYYY-MM-DD=n,... is required");
const wanted = new Map(countsArg.split(",").map((p) => p.split("=")).map(([d, n]) => [d.trim(), Number(n)]));

const realRoot = await realPrivateRoot(resolve("private"));
const out = await ensureDirInside(realRoot, ["pipeline", code]);
const read = async <T>(name: string): Promise<T> => {
  if (!(await lstat(join(out, name)).catch(() => null))?.isFile()) throw new Error(`${name} not found: run the pipeline first`);
  return JSON.parse(new TextDecoder().decode(await readInside(out, join(out, name)))) as T;
};
const save = (name: string, data: unknown) => writeInside(realRoot, out, name, JSON.stringify(data, null, 2), { replace: true });

const chunks = await read<PipelineChunk[]>("chunks.json");
const transcripts = await read<PipelineTranscript[]>("transcripts.json");
type Result = { group: string; status: string; attempts: number; reason?: string; added?: string };
const generated = await read<{ questions: PracticeQuestion[]; results: Result[]; examIds: string[] }>("generated.json");
const questions = await read<PracticeQuestion[]>("questions.json");
const output = await read<PipelineOutput>("output.json");

const index = await buildIndex(transcripts, chunks);
const dateOf = (t: number) => (index.transcripts[t].t.recordedAt ?? "").slice(0, 10);
const counts = index.transcripts.map((_, t) => wanted.get(dateOf(t)) ?? 0);
const anchors = lectureAnchors(index, chunks, questions, counts);

const llm = createLLM();
const reviews = chunks.filter((c) => c.role === "review" && c.text.trim());
const reviewVecs = reviews.length ? await embed(reviews.map((c) => c.text), { taskType: "SEMANTIC_SIMILARITY" }) : [];
const course = { code: output.course.code, name: output.course.name };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const tally: Record<string, { anchors: number; kept: number; dropped: number; withClip: number; clipOwnLecture: number }> = {};
const added: PracticeQuestion[] = [];

for (const [k, a] of anchors.entries()) {
  const date = dateOf(a.lecture);
  const row = (tally[date] ??= { anchors: 0, kept: 0, dropped: 0, withClip: 0, clipOwnLecture: 0 });
  row.anchors++;
  const material = await materialOf(a.anchor, { topic: a.deck, examId: null, examName: null }, chunks, { reviews, reviewVecs }, embed);
  const avoid = [...questions, ...added].filter((q) => q.topic === a.deck).map((q) => q.stem);
  const id = `${slug(a.deck)}-l${date.replace(/-/g, "")}-${k + 1}`;
  const r = await generateQuestion(material, { course, id, avoid, llm });
  generated.results.push({ group: a.deck, status: r.status, attempts: r.attempts.length, ...(r.status === "dropped" ? { reason: r.reason } : {}), added: date });
  if (r.status !== "kept") {
    row.dropped++;
    console.log(`  ${date}: dropped (${[...new Set(r.failures.map((f) => f.rule))].join(", ")})`);
    continue;
  }
  row.kept++;
  const own = questionLecture(r.question, index);
  const rr = await retrieveOne(r.question, index, { courseCode: code, llm, lecture: own.t });
  const q: PracticeQuestion = { ...r.question, retrieval: rr.retrieval, prompts: { ...r.question.prompts, ...rr.prompts } };
  if (q.retrieval.clip) {
    row.withClip++;
    if (q.retrieval.clip.recordingUrl === index.transcripts[a.lecture].t.recordingUrl) row.clipOwnLecture++;
  }
  added.push(q);
  console.log(`  ${date}: kept after ${r.attempts.length} attempt(s), clip ${q.retrieval.clip ? "yes" : "no"}`);
}

generated.questions.push(...added);
const all = [...questions, ...added];
output.questions = [...output.questions, ...added];
output.counts = { ...output.counts, questions: output.questions.length, withClip: output.questions.filter((q) => q.retrieval.clip).length, withSlide: output.questions.filter((q) => q.retrieval.slide).length };
await save("generated.json", generated);
await save("questions.json", all);
await save("output.json", output);
await save("more-report.json", { at: new Date().toISOString(), counts: Object.fromEntries(wanted), tally });
console.log(JSON.stringify({ tally, questions: output.questions.length, withClip: output.counts.withClip }));
