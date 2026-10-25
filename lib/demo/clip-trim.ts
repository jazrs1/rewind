// Trimming the demo's hosted clips from raw OBS captures (scripts/demo/trim-clips.ts does the reading, ffmpeg and
// writing). Pure: the picks from private/demo-clips.md, where each raw file's clip starts, the ffmpeg arguments, and
// the checks on what came out (under 5 MB, the clip's length within ±0.5 s).

/** One hosted clip as private/demo-clips.md lists it. */
export interface ClipPick {
  id: string;
  start: number;
  end: number;
}

/** A raw capture and where the clip starts in it. */
export interface RawSource {
  file: string;
  /**
   * Seconds into the raw file where the capture's lecture second `clip.start - lead` is: the OBS steps start recording
   * `lead` (5) seconds before the clip start, so the clip starts `lead` seconds in. Ignored when `full`.
   */
  lead?: number;
  /** The raw file is the whole recording (its 0:00 is the lecture's 0:00): the clip starts at clip.start. */
  full?: boolean;
  /** A manual correction, in seconds (negative = earlier), on top of the above. */
  offset?: number;
}

export const DEFAULT_LEAD = 5;
export const MAX_BYTES = 5 * 1024 * 1024;
export const DURATION_TOLERANCE = 0.5;

/** The "| # | `<id>.mp4` | … | **start** | **end** | …" rows of the clips table, in order. */
export function parsePicks(markdown: string): ClipPick[] {
  const out: ClipPick[] = [];
  for (const m of markdown.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9-]+)\.mp4`\s*\|[^|\n]*\|\s*\**(\d+(?:\.\d+)?)\**\s*\|\s*\**(\d+(?:\.\d+)?)\**\s*\|/gm)) {
    if (!out.some((p) => p.id === m[1])) out.push({ id: m[1], start: Number(m[2]), end: Number(m[3]) });
  }
  return out;
}

/** Where to seek in the raw file: the clip start in it, with the manual offset. */
export function seekOf(src: RawSource, clipStart: number): number {
  const at = (src.full ? clipStart : (src.lead ?? DEFAULT_LEAD)) + (src.offset ?? 0);
  if (!(at >= 0)) throw new Error(`${src.file}: the clip would start before the file does (seek ${at} s); check its lead and offset`);
  return Math.round(at * 1000) / 1000;
}

/**
 * ffmpeg arguments for one clip: from `seek`, exactly `length` seconds, 720p H.264 (CRF 28 unless a size retry raises
 * it, capped at 600k as in private/demo-clips.md), AAC 64k mono, faststart,
 * no metadata carried over (the capture's title or a path in it never ships).
 */
export function ffmpegArgs(input: string, output: string, seek: number, length: number, crf = 28): string[] {
  return [
    "-y", "-v", "error",
    "-ss", String(seek), "-i", input, "-t", String(length),
    "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-maxrate", "600k", "-bufsize", "1200k", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k", "-ac", "1",
    "-movflags", "+faststart",
    output,
  ];
}

export interface ClipResult {
  id: string;
  /** Seconds, from ffprobe; null when there is no file. */
  duration: number | null;
  bytes: number | null;
  expected: number;
  ok: boolean;
  why: string[];
}

/** The checks on one written clip. */
export function checkClip(id: string, expected: number, duration: number | null, bytes: number | null, why: string[] = []): ClipResult {
  const problems = [...why];
  if (duration === null || bytes === null) problems.push("no output");
  else {
    if (Math.abs(duration - expected) > DURATION_TOLERANCE) problems.push(`duration ${duration.toFixed(2)} s, expected ${expected} s ±${DURATION_TOLERANCE}`);
    if (bytes >= MAX_BYTES) problems.push(`${(bytes / 1048576).toFixed(2)} MB is not under 5 MB (re-run with --crf 30)`);
  }
  return { id, duration, bytes, expected, ok: problems.length === 0, why: problems };
}

/** The result table: id, duration, size, ok. */
export function resultTable(rows: ClipResult[]): string {
  const head = ["id", "duration", "size", "ok"];
  const cells = rows.map((r) => [
    r.id,
    r.duration === null ? "-" : `${r.duration.toFixed(2)} s (want ${r.expected})`,
    r.bytes === null ? "-" : `${(r.bytes / 1048576).toFixed(2)} MB`,
    r.ok ? "ok" : `NO: ${r.why.join("; ")}`,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((x, i) => (i === c.length - 1 ? x : x.padEnd(w[i]))).join("  ");
  return [line(head), line(w.map((n) => "-".repeat(n))), ...cells.map(line)].join("\n");
}
