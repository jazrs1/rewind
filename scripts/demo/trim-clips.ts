// Trims the demo's hosted clips from Abid's and William's raw OBS captures into public/demo/media/<questionId>.mp4.
// For each of the 10 picks in private/demo-clips.md: the clip's start and length from public/demo/course/course.json
// (the bundle is what the player plays against), the raw file's clip start (its lead, 5 s by the OBS steps, or a
// manual offset per file), trimmed to exactly the clip length at 720p, H.264 CRF 28, AAC 64k mono, faststart. Then each
// file is checked (under 5 MB, duration within ±0.5 s) and a table printed: id, duration, size, ok. Exit 1 if any
// isn't ok. No network; raw files stay in private/.
//
//   node scripts/demo/trim-clips.ts [--raw private/video/raw] [--map clips.json] [--lead 5] [--crf 28] [--only id,id]
//                                   [--out public/demo/media] [--bundle public/demo/course/course.json] [--picks private/demo-clips.md]
//
// --raw: a folder of captures named by question id (<id>.mp4, <id>-raw.mp4, .mov or .mkv).
// --map: a JSON file, question id → "path" or { "file": "path", "lead": 4.2, "offset": -0.5, "full": false }
//        ("full": the file is the whole recording, so the clip starts at its lecture second). Paths are relative to the map.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkClip, DEFAULT_LEAD, ffmpegArgs, parsePicks, resultTable, seekOf, type ClipResult, type RawSource } from "../../lib/demo/clip-trim.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string | null = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const ROOT = process.cwd();
const picksFile = resolve(ROOT, opt("picks", "private/demo-clips.md")!);
const bundleFile = resolve(ROOT, opt("bundle", "public/demo/course/course.json")!);
const outDir = resolve(ROOT, opt("out", "public/demo/media")!);
const rawDir = opt("raw") ?? (opt("map") ? null : "private/video/raw");
const mapFile = opt("map");
const lead = Number(opt("lead", String(DEFAULT_LEAD)));
const crf = Number(opt("crf", "28"));
const only = opt("only")?.split(",").filter(Boolean) ?? null;

const picks = parsePicks(readFileSync(picksFile, "utf8")).filter((p) => !only || only.includes(p.id));
if (!picks.length) throw new Error(`No clip picks in ${picksFile}${only ? ` for ${only.join(", ")}` : ""}`);
const bundle = JSON.parse(readFileSync(bundleFile, "utf8")) as { sets: { questions: { id: string; clip: { start: number; end: number } }[] }[] };
const clipOf = new Map(bundle.sets.flatMap((s) => s.questions.map((q) => [q.id, q.clip] as const)));

// Where each raw capture is.
const sources = new Map<string, RawSource>();
if (mapFile) {
  const map = JSON.parse(readFileSync(resolve(ROOT, mapFile), "utf8")) as Record<string, string | RawSource>;
  const base = dirname(resolve(ROOT, mapFile));
  for (const [id, v] of Object.entries(map)) {
    const src = typeof v === "string" ? { file: v } : v;
    sources.set(id, { lead, ...src, file: resolve(base, src.file) });
  }
}
if (rawDir && existsSync(resolve(ROOT, rawDir))) {
  const files = readdirSync(resolve(ROOT, rawDir));
  for (const p of picks) {
    if (sources.has(p.id)) continue;
    const f = files.find((x) => new RegExp(`^${p.id}(?:-raw)?\\.(?:mp4|mov|mkv)$`, "i").test(x));
    if (f) sources.set(p.id, { file: join(resolve(ROOT, rawDir), f), lead });
  }
}

const probe = (file: string): number | null => {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const d = Number(r.stdout.trim());
  return r.status === 0 && Number.isFinite(d) ? d : null;
};

mkdirSync(outDir, { recursive: true });
const rows: ClipResult[] = [];
const notes: string[] = [];
for (const p of picks) {
  const clip = clipOf.get(p.id);
  if (!clip) {
    rows.push(checkClip(p.id, p.end - p.start, null, null, ["not in the bundle"]));
    continue;
  }
  const length = Math.round((clip.end - clip.start) * 1000) / 1000;
  if (Math.abs(clip.start - p.start) > 0.5 || Math.abs(clip.end - p.end) > 0.5) notes.push(`${p.id}: demo-clips.md says ${p.start}–${p.end}, the bundle ${clip.start}–${clip.end}; the bundle's is used`);
  const src = sources.get(p.id);
  if (!src || !existsSync(src.file)) {
    rows.push(checkClip(p.id, length, null, null, [src ? `no raw file ${src.file}` : "no raw capture"]));
    continue;
  }
  let seek: number;
  try {
    seek = seekOf(src, clip.start);
  } catch (e) {
    rows.push(checkClip(p.id, length, null, null, [(e as Error).message]));
    continue;
  }
  const rawLen = probe(src.file);
  if (rawLen !== null && rawLen < seek + length - 0.05) {
    // Nothing is written: a short file in media/ would play as if it were the clip.
    rows.push(checkClip(p.id, length, null, null, [`the raw file is ${rawLen.toFixed(1)} s, too short for ${seek} + ${length} s`]));
    continue;
  }
  const out = join(outDir, `${p.id}.mp4`);
  const r = spawnSync("ffmpeg", ffmpegArgs(src.file, out, seek, length, crf), { encoding: "utf8" });
  if (r.status !== 0) {
    rows.push(checkClip(p.id, length, null, null, [`ffmpeg failed: ${(r.stderr || "").trim().split("\n").at(-1)}`]));
    continue;
  }
  rows.push(checkClip(p.id, length, probe(out), existsSync(out) ? statSync(out).size : null));
}

console.log(resultTable(rows));
for (const n of notes) console.log(`note: ${n}`);
const bad = rows.filter((r) => !r.ok).length;
console.log(bad ? `${bad} of ${rows.length} not ok` : `all ${rows.length} ok`);
process.exit(bad ? 1 : 0);
