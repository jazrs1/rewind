// Guard against real course text in committed files: any run of RUN words that also
// appears in a private/**/*.transcript.json lecture, or a real Canvas course id from
// private/*.course.json. Reports file:line only, never the text.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_DIR } from "./demo/bundle.ts";

export const RUN = 8;

/** Lowercase words with apostrophes dropped ("there's" -> "theres"). */
export function words(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, "").match(/[a-z0-9]+/g) ?? [];
}

function transcriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return transcriptFiles(p);
    return f.endsWith(".transcript.json") ? [p] : [];
  });
}

/** Every RUN-word run in the transcripts' segment text (runs may cross segments). */
export function transcriptRuns(texts: string[]): Set<string> {
  const runs = new Set<string>();
  for (const text of texts) {
    const w = words(text);
    for (let i = 0; i + RUN <= w.length; i++) runs.add(w.slice(i, i + RUN).join(" "));
  }
  return runs;
}

/** Lines (1-based) of `content` where a run from `runs` starts. Runs may cross lines. */
export function hitLines(content: string, runs: Set<string>): number[] {
  const toks: { w: string; line: number }[] = [];
  content.split("\n").forEach((l, i) => {
    for (const w of words(l)) toks.push({ w, line: i + 1 });
  });
  const lines = new Set<number>();
  for (let i = 0; i + RUN <= toks.length; i++) {
    if (runs.has(toks.slice(i, i + RUN).map((t) => t.w).join(" "))) lines.add(toks[i].line);
  }
  return [...lines];
}

/**
 * The one place real lecture text may be committed: the demo bundle (public/demo/course/), exported
 * from the pipeline with Professor Kapoor's permission (scripts/demo/export-demo.ts). Course ids are
 * still refused there.
 */
export const REAL_TEXT_ALLOWED = [`public/${BUNDLE_DIR}/`];

/** file:line for every committed file outside private/ that quotes a real lecture; null without private/. */
export function realTextHits(root: string, allowed: string[] = REAL_TEXT_ALLOWED): string[] | null {
  const priv = join(root, "private");
  if (!existsSync(priv)) return null;
  const texts = transcriptFiles(priv).map((f) => {
    const t = JSON.parse(readFileSync(f, "utf8")) as { segments?: { text: string }[] };
    return (t.segments ?? []).map((s) => s.text).join(" ");
  });
  const runs = transcriptRuns(texts);
  // Real Canvas course ids, from private/<CODE>.course.json.
  const ids = readdirSync(priv)
    .filter((f) => f.endsWith(".course.json"))
    .map((f) => String((JSON.parse(readFileSync(join(priv, f), "utf8")) as { course?: { id?: number } }).course?.id ?? ""))
    .filter((id) => /^\d{4,}$/.test(id))
    .map((id) => new RegExp(`(?<!\\d)${id}(?!\\d)`));
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter((f) => f && !f.startsWith("private/"));
  const hits: string[] = [];
  for (const f of files) {
    const p = join(root, f);
    if (!existsSync(p) || statSync(p).size > 2_000_000) continue;
    const buf = readFileSync(p);
    if (buf.includes(0)) continue; // binary
    const content = buf.toString("utf8");
    const lines = new Set(allowed.some((a) => f.startsWith(a)) ? [] : hitLines(content, runs));
    content.split("\n").forEach((l, i) => {
      if (ids.some((re) => re.test(l))) lines.add(i + 1);
    });
    for (const line of [...lines].sort((a, b) => a - b)) hits.push(`${f}:${line}`);
  }
  return hits;
}
