import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkClip, ffmpegArgs, MAX_BYTES, parsePicks, resultTable, seekOf } from "./clip-trim.ts";

const TABLE = `| # | file to make | lecture recording | start (s) | end (s) | start–end (mm:ss) | length | the question it answers |
|---|---|---|---|---|---|---|---|
| 1 | \`l20261013-q1.mp4\` | Some lecture, **Oct 13** | **100** | **106** | 1:40–1:46 | 6 s | An invented question |
| 2 | \`l20261013-q2.mp4\` | Oct 13 | **200** | **204** | 3:20–3:24 | 4 s | Another invented question |
`;

describe("clip trimming (pure)", () => {
  it("reads the picks table: id, start and end, in order", () => {
    expect(parsePicks(`# Clips\n\n${TABLE}\n| clip | voice only |\n|---|---|\n| oct13 | |`)).toEqual([
      { id: "l20261013-q1", start: 100, end: 106 },
      { id: "l20261013-q2", start: 200, end: 204 },
    ]);
  });

  const md = join(process.cwd(), "private", "demo-clips.md");
  it.skipIf(!existsSync(md))("the real picks still exported are the bundle's hosted clips, at the bundle's times", () => {
    const bundle = JSON.parse(readFileSync("public/demo/course/course.json", "utf8")) as { sets: { hosted: string[]; questions: { id: string; clip: { start: number; end: number } }[] }[] };
    // A pick whose question was later left out of the bundle by hand (export-demo.ts EXCLUDE, e.g. l20261020-q5) doesn't count.
    const shipped = new Set(bundle.sets.flatMap((s) => s.questions.map((q) => q.id)));
    const picks = parsePicks(readFileSync(md, "utf8")).filter((p) => shipped.has(p.id));
    expect(picks.map((p) => p.id).sort()).toEqual(bundle.sets.flatMap((s) => s.hosted).sort());
    for (const p of picks) {
      const q = bundle.sets.flatMap((s) => s.questions).find((x) => x.id === p.id)!;
      expect([p.start, p.end], p.id).toEqual([q.clip.start, q.clip.end]);
    }
  });

  it("seeks to the lead (5 s by default), the lecture second for a full recording, plus the manual offset", () => {
    expect(seekOf({ file: "a" }, 2284)).toBe(5);
    expect(seekOf({ file: "a", lead: 4.25, offset: -0.5 }, 2284)).toBe(3.75);
    expect(seekOf({ file: "a", full: true, offset: 1 }, 2284)).toBe(2285);
    expect(() => seekOf({ file: "a", lead: 1, offset: -2 }, 2284)).toThrow(/before the file/);
  });

  it("encodes 720p H.264 CRF 28, AAC 64k mono, faststart, exactly the length, no metadata", () => {
    const a = ffmpegArgs("in.mp4", "out.mp4", 5, 40).join(" ");
    for (const s of ["-ss 5 -i in.mp4 -t 40", "scale=-2:720", "-c:v libx264", "-crf 28", "-c:a aac -b:a 64k -ac 1", "-movflags +faststart", "-map_metadata -1"]) expect(a).toContain(s);
    expect(ffmpegArgs("in.mp4", "out.mp4", 5, 40, 30).join(" ")).toContain("-crf 30");
  });

  it("a clip is ok under 5 MB and within ±0.5 s of its length", () => {
    expect(checkClip("x", 40, 40.4, 1000).ok).toBe(true);
    expect(checkClip("x", 40, 40.6, 1000).why[0]).toMatch(/duration/);
    expect(checkClip("x", 40, 40, MAX_BYTES).why[0]).toMatch(/under 5 MB/);
    expect(checkClip("x", 40, null, null, ["no raw capture"]).why).toEqual(["no raw capture", "no output"]);
    expect(resultTable([checkClip("x", 40, 40, 1048576)])).toMatch(/^id\s+duration\s+size\s+ok\n.*\nx\s+40\.00 s \(want 40\)\s+1\.00 MB\s+ok$/);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("scripts/demo/trim-clips.ts on a synthetic capture", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rewind-trim-"));
    mkdirSync(join(dir, "raw"));
    writeFileSync(join(dir, "picks.md"), TABLE);
    writeFileSync(join(dir, "course.json"), JSON.stringify({ sets: [{ questions: [{ id: "l20261013-q1", clip: { start: 100, end: 106 } }, { id: "l20261013-q2", clip: { start: 200, end: 204 } }] }] }));
    // A 13 s capture whose clip starts 5 s in (the OBS steps): a test pattern and a tone.
    const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=13", "-f", "lavfi", "-i", "sine=frequency=440:duration=13", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", join(dir, "raw", "l20261013-q1-raw.mp4")]);
    expect(r.status).toBe(0);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...extra: string[]) =>
    spawnSync("node", ["scripts/demo/trim-clips.ts", "--picks", join(dir, "picks.md"), "--bundle", join(dir, "course.json"), "--out", join(dir, "media"), ...extra], { encoding: "utf8" });

  it("trims to the clip's length at 720p with mono AAC, prints the table, and fails a pick with no capture", () => {
    const r = run("--raw", join(dir, "raw"));
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toMatch(/^id\s+duration\s+size\s+ok/);
    expect(r.stdout).toMatch(/l20261013-q1\s+6\.\d\d s \(want 6\)\s+0\.\d\d MB\s+ok/);
    expect(r.stdout).toMatch(/l20261013-q2\s+-\s+-\s+NO: no raw capture/);
    const out = join(dir, "media", "l20261013-q1.mp4");
    expect(statSync(out).size).toBeLessThan(MAX_BYTES);
    const p = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,height,channels:format=duration", "-of", "json", out], { encoding: "utf8" });
    const info = JSON.parse(p.stdout) as { streams: { codec_name: string; height?: number; channels?: number }[]; format: { duration: string } };
    expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThanOrEqual(0.5);
    expect(info.streams.find((s) => s.codec_name === "h264")?.height).toBe(720);
    expect(info.streams.find((s) => s.codec_name === "aac")?.channels).toBe(1);
    // faststart: the moov atom comes before the media data.
    const head = readFileSync(out).subarray(0, 4096).toString("latin1");
    expect(head.indexOf("moov")).toBeGreaterThan(-1);
    expect(head.indexOf("moov")).toBeLessThan(head.indexOf("mdat") === -1 ? Infinity : head.indexOf("mdat"));
  }, 120_000);

  it("takes a mapping file with a manual offset per file, and refuses a capture too short for its clip", () => {
    writeFileSync(join(dir, "map.json"), JSON.stringify({ "l20261013-q1": { file: "raw/l20261013-q1-raw.mp4", offset: -1 }, "l20261013-q2": { file: "raw/l20261013-q1-raw.mp4", lead: 10 } }));
    const r = run("--map", join(dir, "map.json"));
    expect(r.stdout).toMatch(/l20261013-q1\s+6\.\d\d s \(want 6\)\s+\S+ MB\s+ok/);
    expect(r.stdout).toMatch(/l20261013-q2 .*NO: the raw file is 13\.0 s, too short for 10 \+ 4 s/);
    expect(r.status).toBe(1);
  }, 120_000);
});
