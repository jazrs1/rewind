// Turns a Zoom .vtt download, text copied from Zoom's Audio Transcript panel, or a
// saved Zoom recording page (.html) into the shared Transcript format, with
// sentence-sized segments (long chunks are split with estimated times).
// Run: npm run spike:parse -- <file.vtt|transcript.txt|page.html> [--out f] [--title t] [--url u] [--duration h:mm:ss]

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { Transcript, TranscriptSegment } from "../../lib/schema.ts";
import { ensureSentences } from "../../lib/transcript.ts";

/** "43:40", "1:02:15", "00:43:40.120" → seconds. */
export function parseTime(label: string): number {
  const parts = label.trim().split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Bad time label: ${label}`);
  }
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// A "Name: text" prefix counts as a speaker only if it recurs, so "Note: ..." in speech isn't one.
function splitSpeakers(raw: { start: number; end: number; text: string }[]): TranscriptSegment[] {
  const prefix = /^([^:]{2,60}?):\s+([\s\S]*)$/;
  const counts = new Map<string, number>();
  for (const r of raw) {
    const m = r.text.match(prefix);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return raw.map((r) => {
    const m = r.text.match(prefix);
    return m && (counts.get(m[1]) ?? 0) >= 3
      ? { start: r.start, end: r.end, speaker: m[1].trim(), text: m[2].trim() }
      : { start: r.start, end: r.end, speaker: null, text: r.text.trim() };
  });
}

export function parseVtt(src: string): TranscriptSegment[] {
  const cues: { start: number; end: number; text: string }[] = [];
  const blocks = src.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->").map((s) => s.trim().split(/\s+/)[0]);
    const text = lines.slice(i + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) cues.push({ start: parseTime(a), end: parseTime(b), text });
  }
  return splitSpeakers(cues);
}

/**
 * Text copied from Zoom's transcript panel: optionally the recording URL on line 1, then
 * chunks run together as "<Speaker Name><hh:mm:ss><text>" with no separators.
 * Copying also picks up the panel's UI ("Resume autoscrolling", "Edit", ...) and the chat
 * ("Name  18:02  AB message0 Replies"). Both are cut off: chat isn't lecture speech and
 * carries other students' names.
 */
export function parsePanel(src: string, durationSec?: number): { segments: TranscriptSegment[]; recordingUrl?: string } {
  const lines = src.replace(/\r/g, "").split("\n");
  const recordingUrl = /^https?:\/\//.test(lines[0].trim()) ? lines.shift()!.trim() : undefined;
  let body = lines.join("\n");

  const ends = [/Resume autoscrolling/, /\S {2,}\d{1,2}:\d{2}(?::\d{2})? {2,}[A-Z]{1,3} /, /\d+ Repl(?:y|ies)\b/]
    .map((re) => body.search(re))
    .filter((i) => i >= 0);
  if (ends.length) body = body.slice(0, Math.min(...ends));

  // A header is a time label glued to the letter before it: "...stuck.Firstname Kapoor00:29:24Okay".
  const times = [...body.matchAll(/(?<=\p{L})\d{2}:\d{2}:\d{2}/gu)];
  const nameWord = "[A-Z][^\\s\\d.?!,:;]*";
  // Speaker names come from headers where the name clearly starts (after a sentence end or at the start).
  const clean = new RegExp(`(?:^|[.?!"”)\\]]\\s*)(${nameWord}(?: ${nameWord}){0,3})$`, "u");
  const trailing = new RegExp(`(${nameWord}(?: ${nameWord}){0,2})$`, "u");
  const pre = times.map((m, i) => body.slice(i ? times[i - 1].index + 8 : 0, m.index));
  const speakers = new Set(pre.map((p) => p.match(clean)?.[1]).filter((n): n is string => !!n));
  const names = pre.map((p) => [...speakers].filter((n) => p.endsWith(n)).sort((a, b) => b.length - a.length)[0] ?? p.match(trailing)?.[1] ?? "");

  const chunks = times.map((m, i) => ({
    start: parseTime(m[0]),
    speaker: names[i] || null,
    text: body
      .slice(m.index + 8, i + 1 < times.length ? times[i + 1].index - names[i + 1].length : undefined)
      .replace(/\s+/g, " ")
      .trim(),
  }));
  const kept = chunks.filter((c) => c.text);
  if (!kept.length) throw new Error("No timestamped chunks found. Is this the Zoom transcript panel text?");
  return {
    recordingUrl,
    segments: kept.map((c, i) => ({
      start: c.start,
      end: kept[i + 1]?.start ?? durationSec ?? c.start,
      speaker: c.speaker,
      text: c.text,
    })),
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * A saved Zoom recording page. Every transcript item has an aria-label like
 * "Speaker, 0 hours 7 minutes 22 seconds, text"; those times match the visible labels.
 */
export function parseZoomHtml(src: string): { segments: TranscriptSegment[]; durationSec?: number } {
  const label = /^(.*?), (\d+) hours? (\d+) minutes? (\d+) seconds?, ([\s\S]*)$/;
  const items: { start: number; speaker: string | null; text: string }[] = [];
  for (const m of src.matchAll(/<li\b[^>]*\baria-label="([^"]*)"/g)) {
    const a = decodeEntities(m[1]).match(label);
    if (!a) continue;
    items.push({ start: +a[2] * 3600 + +a[3] * 60 + +a[4], speaker: a[1].trim() || null, text: a[5].trim() });
  }
  if (!items.length) throw new Error("No transcript items with aria-label times found in this page.");
  const d = src.match(/class="vjs-time-range-duration">([\d:]+)</);
  const durationSec = d ? parseTime(d[1]) : undefined;
  const segments = items.map((it, i) => ({
    start: it.start,
    end: items[i + 1]?.start ?? durationSec ?? it.start,
    speaker: it.speaker,
    text: it.text,
  }));
  return { segments, durationSec };
}

export function toTranscript(
  src: string,
  opts: { filename: string; title?: string; url?: string; durationSec?: number },
): Transcript {
  let segments: TranscriptSegment[];
  let durationSec = opts.durationSec;
  let recordingUrl = opts.url;
  if (/\.html?$/i.test(opts.filename)) {
    const page = parseZoomHtml(src);
    segments = page.segments;
    durationSec ??= page.durationSec;
  } else if (/^\uFEFF?WEBVTT/.test(src) || opts.filename.endsWith(".vtt")) {
    segments = parseVtt(src);
  } else {
    const panel = parsePanel(src, durationSec);
    segments = panel.segments;
    recordingUrl ??= panel.recordingUrl;
    if (durationSec === undefined) {
      // Without it the last chunk (often most of the lecture) has no end and can't be split or searched.
      throw new Error("Panel text needs --duration (the recording's length, e.g. 1:41:21) so the last chunk has an end.");
    }
  }
  segments.sort((a, b) => a.start - b.start);
  return ensureSentences({
    source: "zoom",
    recordingUrl: recordingUrl ?? "",
    title: opts.title ?? basename(opts.filename).replace(/\.[^.]+$/, ""),
    recordedAt: null,
    durationSec: durationSec ?? Math.max(0, ...segments.map((s) => s.end)),
    segments,
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const input = process.argv[2];
  if (!input || input.startsWith("--")) {
    console.error("Usage: npm run spike:parse -- <file.vtt|transcript.txt|page.html> [--out f] [--title t] [--url u] [--duration h:mm:ss]");
    process.exit(2);
  }
  const duration = arg("duration");
  const t = toTranscript(await readFile(input, "utf8"), {
    filename: input,
    title: arg("title"),
    url: arg("url"),
    durationSec: duration ? parseTime(duration) : undefined,
  });
  const out = arg("out") ?? input.replace(/\.[^.]+$/, "") + ".transcript.json";
  await writeFile(out, JSON.stringify(t, null, 2));
  const speakers = new Map<string, number>();
  for (const s of t.segments) speakers.set(s.speaker ?? "(none)", (speakers.get(s.speaker ?? "(none)") ?? 0) + 1);
  const estimated = t.segments.filter((s) => s.estimated).length;
  console.log(`${t.segments.length} segments (${estimated} with estimated times), ${Math.round(t.durationSec / 60)} min -> ${out}`);
  for (const [name, n] of speakers) console.log(`  ${name}: ${n}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
