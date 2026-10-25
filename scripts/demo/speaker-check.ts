// Speaker check of the demo's hosted clips: transcribes each trimmed public/demo/media/<questionId>.mp4 with
// diarization (lib/gemini.ts transcribe, cached by the audio's hash; gemini-3.5-transcribe) and lists, per clip, the
// speakers found and any line that sounds like a student (a question from the room, a name, "can you repeat").
// A clip with a second speaker or such a line stays out of the bundle (scripts/demo/trim-clips.ts writes it; delete
// it after a human listen). Spend is logged to .cache/gemini/usage.jsonl and capped at --cap dollars on top of what
// that log already holds.
//
//   node --env-file=.env.local scripts/demo/speaker-check.ts [--cap 0.5] [--only id,id]
//        [--media public/demo/media] [--out .cache/clips-qa/speakers]

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createGemini, geminiLineCost } from "../../lib/gemini.ts";
import { studentLines } from "../../lib/demo/speaker-check.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string | null = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const media = resolve(opt("media", "public/demo/media")!);
const out = resolve(opt("out", ".cache/clips-qa/speakers")!);
const cap = Number(opt("cap", "0.5"));
const only = opt("only")?.split(",") ?? null;
const cacheDir = resolve(".cache/gemini");
const usagePath = join(cacheDir, "usage.jsonl");

const logged = () =>
  readFileSync(usagePath, { encoding: "utf8", flag: "a+" })
    .split("\n")
    .filter(Boolean)
    .reduce((s, l) => s + geminiLineCost(JSON.parse(l)), 0);
const before = logged();
const gemini = createGemini({ cacheDir, usagePath, budgetUsd: before + cap });
mkdirSync(out, { recursive: true });

const names = readFileSync("private/demo-clips.md", "utf8").split("## Names to redact")[1]?.match(/^- (\S.*)$/gm)?.map((l) => l.slice(2).trim()) ?? [];
const rows: string[] = [];
for (const f of readdirSync(media).filter((x) => /^l\d{8}-q\d+\.mp4$/.test(x)).sort()) {
  const id = f.replace(/\.mp4$/, "");
  if (only && !only.includes(id)) continue;
  // Audio only, 16 kHz mono: smaller to send, same words.
  const wav = join(out, `${id}.wav`);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", join(media, f), "-vn", "-ac", "1", "-ar", "16000", wav]);
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${f}: ${r.stderr.toString()}`);
  // Sequential on purpose: one call in flight, so the cap's worst-case reservation never stacks.
  const t = await gemini.transcribe(wav, { diarization: true });
  // The transcribe model allows 10 requests a minute on this key's tier.
  await new Promise((r) => setTimeout(r, 7000));
  writeFileSync(join(out, `${id}.json`), JSON.stringify(t, null, 2) + "\n");
  const speakers = [...new Set(t.turns.map((x) => x.speaker ?? "?"))];
  const flags = studentLines(t.turns, names);
  rows.push(`| ${id} | ${speakers.length} (${speakers.join(", ")}) | ${flags.length ? flags.map((x) => `${x.why}: "${x.text.slice(0, 80)}"`).join("; ") : "none"} |`);
}
console.log("| id | speakers | student-like lines |\n|---|---|---|\n" + rows.join("\n"));
console.log(`spend this run: $${(logged() - before).toFixed(4)} (cap $${cap})`);
