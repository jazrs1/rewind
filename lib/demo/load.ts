// Loads what the practice pages show.
// - loadLocalSeed: the local practice seed (private/demo/seed.json). Dev only: real course data
//   never goes into a production build, and demo mode (lib/demo/guard.ts) never reads it.
// - loadDemoBundle: the precomputed demo bundle under public/ (lib/demo/bundle.ts), cached so the
//   demo pages prerender at build time with no keys and no private/ data.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheLife } from "next/cache";
import { readDemoAskSaved, readDemoBundle, readDemoDeadlines, readDemoExams, type DemoBundle, type DemoSet } from "./bundle.ts";
import { isDemoMode } from "./guard.ts";
import { buildDemoTape, type DemoTape } from "./tape.ts";
import type { PracticeSeed } from "./types.ts";

export async function loadLocalSeed(): Promise<PracticeSeed | null> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  try {
    return JSON.parse(await readFile(join(process.cwd(), "private/demo/seed.json"), "utf8")) as PracticeSeed;
  } catch {
    return null;
  }
}

export async function loadDemoBundle(): Promise<DemoBundle | null> {
  "use cache";
  cacheLife("max");
  return readDemoBundle();
}

export async function loadDemoTape(): Promise<DemoTape | null> {
  "use cache";
  cacheLife("max");
  const bundle = await readDemoBundle();
  return bundle ? buildDemoTape(bundle) : null;
}

/** /demo/practice: the latest lecture's set (Oct 22, whose hosted clip is scored against truth). */
export function defaultSet(bundle: DemoBundle | null): DemoSet | null {
  return bundle ? ([...bundle.sets].sort((a, b) => b.id.localeCompare(a.id))[0] ?? null) : null;
}

/** The hosted clips of a set, by question id, for PracticeFlow. */
export function setMedia(set: DemoSet): { clips: Record<string, { src: string; offset: number }> } {
  return { clips: Object.fromEntries(set.hosted.map((h) => [h.questionId, { src: h.src, offset: h.offset }])) };
}

export async function loadDemoDeadlines(): Promise<unknown> {
  "use cache";
  cacheLife("max");
  return readDemoDeadlines();
}

export async function loadDemoExams(): Promise<unknown> {
  "use cache";
  cacheLife("max");
  return readDemoExams();
}

export async function loadDemoAskSaved(): Promise<unknown> {
  "use cache";
  cacheLife("max");
  return readDemoAskSaved();
}
