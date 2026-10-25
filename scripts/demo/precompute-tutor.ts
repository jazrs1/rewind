// Writes the demo tutor's saved replies (public/demo/course/tutor.json): for each demo question a Hint 1, Hint 2, a
// Socratic follow-up, a confirm and the answer, and up to two similar questions ("Give me a similar one": new values,
// a word-for-word source), all checked against the bundle. The public demo plays them when the
// live tutor is capped, errors or is slow.
//
//   node --env-file-if-exists=.env.local scripts/demo/precompute-tutor.ts            real: Claude Sonnet through lib/llm.ts
//   node scripts/demo/precompute-tutor.ts --fake [--out <file>]                       the fake model: no key, no network, $0
//   ... --similar-attempts <n> [--max-usd <d>]   only more tries at the saved similar questions (below)
//
// From another directory (the main checkout, with its key), pointing at the checkout whose bundle and output to use:
//   node --env-file=.env.local <checkout>/scripts/demo/precompute-tutor.ts --root <checkout>
// --root is the checkout holding public/demo/course/course.json; the file is written to <root>/public/demo/course/tutor.json
// (or --out). The path it wrote is printed.
//
// The real run uses the main key from .env.local (never deployed); it is cached and capped by lib/llm.ts, so a second
// run costs nothing. Counts only are printed.
//
// --similar-attempts <n> reads the tutor.json that is there and leaves every saved reply in it alone. For each question
// with fewer than 2 kept similar questions it makes up to n more tries, each numbered in the prompt so the cache can't
// return the one it dropped, and adds what passes the checks after the kept ones (never replacing one). Re-running with
// the same n is free (cached); a larger n pays only for the new tries. The run stops calling once the next call's worst
// case (lib/llm.ts claudeWorstCost; cache hits count too) would pass --max-usd, default $2.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_DIR, readDemoBundle } from "../../lib/demo/bundle.ts";
import { fakeSimilar, fakeTutor } from "../../lib/tutor/fake.ts";
import { precomputeTutor, retrySimilar } from "../../lib/demo/tutor-precompute.ts";
import type { SavedFile } from "../../lib/demo/tutor-pick.ts";
import { validateSaved } from "../../lib/demo/tutor-saved.ts";
import type { Generate } from "../../lib/tutor/service.ts";
import type { GenerateSimilar } from "../../lib/tutor/similar.ts";

const args = process.argv.slice(2);
const fake = args.includes("--fake");
const outArg = args.indexOf("--out");
const rootArg = args.indexOf("--root");
const root = rootArg >= 0 ? args[rootArg + 1] : process.cwd();
const attemptsArg = args.indexOf("--similar-attempts");
const attempts = attemptsArg >= 0 ? Number(args[attemptsArg + 1]) : 0;
if (attemptsArg >= 0 && !(Number.isInteger(attempts) && attempts > 0)) {
  console.error("--similar-attempts takes a whole number of tries, 1 or more.");
  process.exit(1);
}
const maxArg = args.indexOf("--max-usd");
const maxUsd = maxArg >= 0 ? Number(args[maxArg + 1]) : 2;
if (!(maxUsd > 0)) {
  console.error("--max-usd takes a dollar amount above 0.");
  process.exit(1);
}
const out = outArg >= 0 ? args[outArg + 1] : join(root, "public", BUNDLE_DIR, "tutor.json");

const bundle = await readDemoBundle(root);
if (!bundle) {
  console.error("No demo bundle (public/demo/course/course.json).");
  process.exit(1);
}

let model = "fake";
let worstCost: (prompt: string) => number = () => 0;
let generateFor: (q: import("../../lib/demo/types.ts").SeedQuestion) => Generate;
let similarFor: (q: import("../../lib/demo/types.ts").SeedQuestion) => GenerateSimilar;
if (fake) {
  generateFor = (q) => fakeTutor(q, { delayMs: 0 });
  similarFor = (q) => fakeSimilar(q, { delayMs: 0 });
} else {
  const { claudeWorstCost, generateJSON, LLM_MODELS } = await import("../../lib/llm.ts");
  model = LLM_MODELS.tutor.model;
  worstCost = (prompt) => claudeWorstCost(prompt.length, 900);
  generateFor = () => (prompt, schema) => generateJSON(LLM_MODELS.tutor, prompt, schema, { maxTokens: 700, effort: "low" });
  similarFor = () => (prompt, schema) => generateJSON(LLM_MODELS.tutor, prompt, schema, { maxTokens: 900, effort: "low" });
}

// precomputeTutor takes one model; the fake needs the question it is answering, so route by the prompt's question text.
const questions = new Map(bundle.sets.flatMap((s) => s.seed.questions.map((q) => [q.stem, q] as const)));
const generate: Generate = (prompt, schema) => {
  const q = [...questions.entries()].find(([stem]) => prompt.includes(stem))?.[1];
  if (!q) throw new Error("A prompt without a demo question in it.");
  return generateFor(q)(prompt, schema);
};

const questionOf = (prompt: string) => {
  const q = [...questions.entries()].find(([stem]) => prompt.includes(stem))?.[1];
  if (!q) throw new Error("A prompt without a demo question in it.");
  return q;
};
const generateSimilar: GenerateSimilar = (prompt, schema) => similarFor(questionOf(prompt))(prompt, schema);

if (attempts) {
  const saved = JSON.parse(readFileSync(out, "utf8")) as SavedFile;
  let spent = 0;
  const canSpend = (prompt: string) => {
    const cost = worstCost(prompt);
    if (spent + cost > maxUsd) return false;
    spent += cost;
    return true;
  };
  const { file, report } = await retrySimilar(bundle, saved, generateSimilar, attempts, canSpend);
  const errors = validateSaved(file, bundle);
  if (errors.length) {
    console.error(`${errors.length} problems, nothing written (first: ${errors[0]})`);
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
  const dropped = Object.entries(report.dropped).map(([why, n]) => `${why} ${n}`).join(", ") || "none";
  console.log(
    `wrote ${out}\nsimilar retries: ${report.retried} questions, ${report.attempts} tries, ${report.added} added, dropped: ${dropped}; ${report.stillShort} still under 2` +
      `${report.skippedForCap ? ` (${report.skippedForCap} not tried: the $${maxUsd} cap)` : ""}; worst case $${spent.toFixed(2)} (${model})`,
  );
  process.exit(0);
}

const { file, report } = await precomputeTutor(bundle, generate, model, generateSimilar);
const errors = validateSaved(file, bundle);
if (errors.length) {
  console.error(`${errors.length} problems, nothing written (first: ${errors[0]})`);
  process.exit(1);
}
writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
console.log(`wrote ${out}\ntutor.json: ${report.questions} questions, ${report.replies} replies, ${report.grounded} with a checked quote, ${report.rewritten} replaced by the integrity check, ${report.similar} similar questions (${report.similarDropped} dropped) (${model})`);
