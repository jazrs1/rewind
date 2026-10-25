// Dev only (like lib/demo/load.ts loadLocalSeed): the practice set /practice shows. The course
// pipeline's output (npm run pipeline → private/pipeline/<COURSE>/output.json, plus the
// transcripts.json the run wrote for the transcript panel), converted to the practice page's seed,
// when a run has finished with questions; else the local seed (private/demo/seed.json).
// ?set=seed always picks the local seed (the e2e tests pin it). The course home's practice index
// (lib/home/local.ts) reads the same set, so ?modules= and ?lecture= select from what's shown.
// Real course data: never read in production or demo mode.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDemoMode } from "../demo/guard.ts";
import { loadLocalSeed } from "../demo/load.ts";
import type { PracticeSeed } from "../demo/types.ts";
import { fixtureOutput, fixtureTranscripts } from "./fixtures/practice-real.ts";
import { parsePageKinds, toPracticeSeed } from "./run.ts";
import type { PipelineOutput, PipelineTranscript } from "./types.ts";

async function readJSON<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The pipeline's practice set for a course; null when there is no finished run with questions. */
export async function loadPipelineSeed(course = process.env.REWIND_COURSE ?? "COP3530"): Promise<PracticeSeed | null> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  if (!/^[A-Z0-9]{1,32}$/.test(course)) return null;
  const dir = join(process.cwd(), "private", "pipeline", course);
  const output = await readJSON<PipelineOutput>(join(dir, "output.json"));
  if (!output?.questions?.length) return null;
  const transcripts = (await readJSON<PipelineTranscript[]>(join(dir, "transcripts.json"))) ?? [];
  // Slide or document page, by each rendered page's shape (scripts/pipeline/run.ts writes it with the renders).
  const kinds = parsePageKinds(await readFile(join(process.cwd(), "private", "demo", "slides", "slides-kinds.json"), "utf8").catch(() => "{}"));
  const { seed } = toPracticeSeed(output, transcripts, kinds);
  return seed.questions.length ? seed : null;
}

/** The e2e fixture (invented text in the real output shape), through the same conversion. Dev only. */
export function fixtureSeed(): PracticeSeed | null {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  return toPracticeSeed(fixtureOutput, fixtureTranscripts).seed;
}

/**
 * What /practice shows: the pipeline's set, else the local seed. `set`: "seed" forces the local
 * seed; "e2e-fixture" the invented pipeline output the e2e tests use (lib/pipeline/fixtures/).
 */
export async function loadPracticeSeed(set?: string | string[]): Promise<PracticeSeed | null> {
  if (set === "e2e-fixture" || set === "e2e-graded" || set === "e2e-mixed") return fixtureSeed();
  return (set === "seed" ? null : await loadPipelineSeed()) ?? (await loadLocalSeed());
}
