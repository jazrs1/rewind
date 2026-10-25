// Scores rewind picks against John's ground truth (private/spike/truth.json):
//   { "Q1": [[918, 990], [1123, 1150]], ... }  ranges in seconds; a question can have several good moments.
// A pick is right if it starts inside a range or up to 10 s before one.
// Run: npm run spike:score [-- --results private/spike/results-exact.json --truth private/spike/truth.json]

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { formatTime } from "../../lib/format.ts";

export type Truth = Record<string, [number, number][]>;
export const LEAD_SEC = 10;

export function isRight(start: number, ranges: [number, number][], leadSec = LEAD_SEC): boolean {
  return ranges.some(([a, b]) => start >= a - leadSec && start <= b);
}

export interface Scored {
  n: number;
  start: number | null;
  verdict: "right" | "wrong" | "unscored";
}

export function score(results: { n: number; start: number | null; playFrom?: number | null }[], truth: Truth): Scored[] {
  return results.map((r) => {
    const ranges = truth[`Q${r.n}`];
    const start = r.playFrom ?? r.start;
    if (!ranges) return { n: r.n, start, verdict: "unscored" };
    return { n: r.n, start, verdict: start !== null && isRight(start, ranges) ? "right" : "wrong" };
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const resultsPath = arg("results") ?? "private/spike/results-exact.json";
  const truthPath = arg("truth") ?? "private/spike/truth.json";
  const { results } = JSON.parse(await readFile(resultsPath, "utf8"));
  const truth: Truth = JSON.parse(await readFile(truthPath, "utf8"));
  const scored = score(results, truth);
  console.log(`${basename(resultsPath)} against ${basename(truthPath)} (right = inside a range or up to ${LEAD_SEC} s before one)\n`);
  for (const s of scored) {
    const ranges = truth[`Q${s.n}`]?.map(([a, b]) => `${formatTime(a)}-${formatTime(b)}`).join(", ") ?? "no truth yet";
    console.log(`  Q${s.n}: ${s.start === null ? "none" : formatTime(s.start)}  ${s.verdict.toUpperCase().padEnd(8)}  truth: ${ranges}`);
  }
  const marked = scored.filter((s) => s.verdict !== "unscored");
  const right = marked.filter((s) => s.verdict === "right").length;
  console.log(`\n${right} of ${marked.length} scored questions right${marked.length < scored.length ? ` (${scored.length - marked.length} not in truth.json yet)` : ""}. Pass is 3 of 5.`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
