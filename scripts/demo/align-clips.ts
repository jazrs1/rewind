// Finds where each raw OBS capture's clip starts, from the Zoom captions burned into it, and writes a map for
// scripts/demo/trim-clips.ts (--map). The captions are the recording's transcript cues, so every caption change in
// the capture is a segment boundary in private/pipeline/COP3530/transcripts.json: the capture's offset is the shift
// that lines the changes up with the boundaries best. Deterministic, no model calls, no network.
//
//   node scripts/demo/align-clips.ts --raw <folder of <questionId>.mp4> [--out .cache/clips-map.json]
//                                    [--transcripts private/pipeline/COP3530/transcripts.json]

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { alignClock, alignOffset, captionChanges } from "../../lib/demo/clip-align.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string | null = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const rawDir = resolve(opt("raw") ?? "private/video/clips-raw");
const outFile = resolve(opt("out", ".cache/clips-map.json")!);
const bundle = JSON.parse(readFileSync(resolve(opt("bundle", "public/demo/course/course.json")!), "utf8")) as { sets: { questions: { id: string; clip: { start: number; end: number } }[] }[] };
const clipOf = new Map(bundle.sets.flatMap((s) => s.questions.map((q) => [q.id, q.clip] as const)));
const transcripts = JSON.parse(readFileSync(resolve(opt("transcripts", "private/pipeline/COP3530/transcripts.json")!), "utf8")) as {
  recordedAt: string;
  segments: { start: number; end: number }[];
}[];

/** The lecture of a question id (l20261013-q1 → the recording made on 2026-10-13). */
const lectureOf = (id: string) => {
  const d = /^l(\d{4})(\d{2})(\d{2})-/.exec(id);
  return d ? transcripts.find((t) => t.recordedAt.startsWith(`${d[1]}-${d[2]}-${d[3]}`)) : undefined;
};

/** The caption strip (above the bottom-right logo and clock) as tiny grayscale frames, 10 a second. */
const FPS = 10;
const W = 340;
const H = 38;
function stripFrames(file: string): Buffer[] {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `fps=${FPS},crop=1700:190:0:820,scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${r.stderr.toString().trim()}`);
  const frames: Buffer[] = [];
  for (let i = 0; i + W * H <= r.stdout.length; i += W * H) frames.push(r.stdout.subarray(i, i + W * H));
  return frames;
}

// --clocks: question id → the burned-in wall clock at the capture's 0:00 ("14:00:20.00", read off a frame, with the
// sub-second from the frame where it ticks). With it, all captures of a lecture are fitted together on that clock,
// and a lecture with no captions (or too few) takes its zero from --zero <yyyymmdd>=<clock>.
const clockFile = opt("clocks");
const toSec = (s: string) => s.split(":").reduce((a, x) => a * 60 + Number(x), 0);
const clocks = new Map<string, number>(clockFile ? Object.entries(JSON.parse(readFileSync(resolve(clockFile), "utf8")) as Record<string, string>).map(([k, v]) => [k, toSec(v)]) : []);
const zeros = new Map<string, number>(args.flatMap((a, i) => (args[i - 1] === "--zero" ? [[a.split("=")[0], toSec(a.split("=")[1])] as [string, number]] : [])));

const map: Record<string, { file: string; lead: number }> = {};
const lines: string[] = [];
const byLecture = new Map<string, { id: string; file: string; clip: { start: number; end: number }; changes: number[]; fit: ReturnType<typeof alignOffset> }[]>();
for (const f of readdirSync(rawDir).filter((x) => /^l\d{8}-q\d+\.mp4$/.test(x)).sort()) {
  const id = f.replace(/\.mp4$/, "");
  const clip = clipOf.get(id);
  const lecture = lectureOf(id);
  if (!clip || !lecture) {
    lines.push(`${id}: ${clip ? "no transcript for its lecture" : "not in the bundle"}`);
    continue;
  }
  const changes = captionChanges(stripFrames(join(rawDir, f)), FPS);
  const a = alignOffset(changes, lecture.segments, clip.start);
  const day = id.slice(1, 9);
  byLecture.set(day, [...(byLecture.get(day) ?? []), { id, file: join(rawDir, f), clip, changes, fit: a }]);
  if (!a) {
    lines.push(`${id}: alone, no alignment (${changes.length} caption changes)`);
    continue;
  }
  if (!clocks.size) map[id] = { file: join(rawDir, f), lead: a.lead };
  lines.push(`${id}: alone, lead ${a.lead.toFixed(2)} s (capture 0:00 = lecture ${a.offset.toFixed(2)} s), ${a.matched}/${a.changes} changes on a boundary, spread ${a.spread.toFixed(2)} s`);
}

for (const [day, caps] of clocks.size ? byLecture : []) {
  const lecture = lectureOf(caps[0].id)!;
  const timed = caps.filter((c) => clocks.has(c.id));
  let zero = zeros.get(day) ?? null;
  if (zero === null) {
    // Guess from the capture that fitted best alone, then fit the whole lecture's changes together.
    const best = timed.filter((c) => c.fit).sort((x, y) => y.fit!.matched / y.fit!.changes - x.fit!.matched / x.fit!.changes || y.fit!.matched - x.fit!.matched)[0];
    if (!best) {
      lines.push(`${day}: no captions to fit and no --zero; its captures are not aligned`);
      continue;
    }
    const guess = clocks.get(best.id)! - best.fit!.offset;
    const pooled = alignClock(timed.flatMap((c) => c.changes.map((x) => clocks.get(c.id)! + x)), lecture.segments, guess, 15);
    if (!pooled) {
      lines.push(`${day}: the pooled fit failed`);
      continue;
    }
    zero = pooled.zero;
    lines.push(`${day}: lecture 0:00 at clock ${zero.toFixed(2)} (pooled ${pooled.matched}/${pooled.changes} changes on a boundary, spread ${pooled.spread.toFixed(2)} s; guess from ${best.id} ${guess.toFixed(2)})`);
  } else lines.push(`${day}: lecture 0:00 at clock ${zero.toFixed(2)} (given)`);
  for (const c of timed) {
    const lead = Math.round((c.clip.start - (clocks.get(c.id)! - zero)) * 100) / 100;
    map[c.id] = { file: c.file, lead };
    lines.push(`  ${c.id}: lead ${lead.toFixed(2)} s (capture 0:00 = lecture ${(clocks.get(c.id)! - zero).toFixed(2)} s)`);
  }
}
writeFileSync(outFile, JSON.stringify(map, null, 2) + "\n");
console.log(lines.join("\n"));
console.log(`map: ${outFile}`);
