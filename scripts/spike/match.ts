// THE REWIND SPIKE: for each practice question, find the ~40 s of lecture where
// the professor explains it, and the matching slide (deck and page).
// Run: npm run spike:match [-- --dir private/spike] [--transcript file] [--duration h:mm:ss]
//                          [--speaker all|<name>] [--audio lecture.m4a] [--tag name]
//                          [--questions file] [--slides dir] [--deck "7 - Sets"] [--out results.md]
//
// Reads from the folder: the transcript (lecture.transcript.json, *.vtt, transcript.txt or a
// saved Zoom page .html; or --transcript), every slide PDF, and questions.txt (one per line).
// Only the lecturer's segments are searched (by default the speaker with the most text), and a
// clip never runs into another speaker's section (e.g. a guest). With --audio, starts are refined
// to word-level times from Gemini Transcribe.
// Writes results-<tag>.json and results.md (start, console seconds, clip text) to the folder.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { extractText } from "unpdf";
import { embed, generateJSON, MODELS } from "../../lib/gemini.ts";
import { formatTime } from "../../lib/format.ts";
import { makeWindows, MIN_GROUNDING, setupGrounding, setupNumbers, snapToSegment, topK, wordCount } from "../../lib/rewind.ts";
import type { Transcript, TranscriptSegment } from "../../lib/schema.ts";
import { ensureSentences } from "../../lib/transcript.ts";
import { SETUP_LINE_SCHEMA, SETUP_MAX_WORDS, setupLinePrompt, type SetupLineReply } from "../../lib/prompts/setup-line.ts";
import { locate } from "./align.ts";
import { audioWords } from "./audio.ts";
import { parseTime, toTranscript } from "./parse.ts";

const CANDIDATES = 5;
const CONTEXT_SEC = 20;
const CLIP_SEC = 40;
/** A clip runs to the end of the thought, but never longer than this. */
const MAX_CLIP_SEC = 75;
/** Lines shown to Flash after a window's start, so it can see where the thought ends. */
const LOOKAHEAD_SEC = 95;
/** How far back the example's start can be. */
const SETUP_LOOKBACK_SEC = 300;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export async function loadTranscript(path: string, durationSec?: number): Promise<Transcript> {
  const src = await readFile(path, "utf8");
  if (path.endsWith(".transcript.json")) return ensureSentences(JSON.parse(src) as Transcript);
  return toTranscript(src, { filename: path, durationSec });
}

async function findTranscript(dir: string, files: string[]): Promise<string> {
  const order = [
    (f: string) => f.endsWith(".transcript.json"),
    (f: string) => f.endsWith(".vtt"),
    (f: string) => f === "transcript.txt",
    (f: string) => /\.html?$/i.test(f),
  ];
  for (const test of order) {
    const found = files.filter(test);
    if (found.length > 1) throw new Error(`More than one transcript in ${dir}: ${found.join(", ")}. Use --transcript.`);
    if (found.length === 1) return join(dir, found[0]);
  }
  throw new Error(`No transcript in ${dir} (.transcript.json, .vtt, transcript.txt or .html).`);
}

interface SlidePage {
  deck: string;
  page: number;
  text: string;
}

async function loadSlides(dir: string, files: string[]): Promise<SlidePage[]> {
  const pdfs = files.filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  if (!pdfs.length) throw new Error(`No slide PDFs in ${dir}`);
  const pages: SlidePage[] = [];
  for (const f of pdfs) {
    const { text } = await extractText(new Uint8Array(await readFile(join(dir, f))), { mergePages: false });
    const deck = f.replace(/\.pdf$/i, "");
    text.forEach((t, i) => pages.push({ deck, page: i + 1, text: t.replace(/\s+/g, " ").trim() }));
    const blank = text.filter((t) => t.trim().length < 15).length;
    console.log(`Slides: ${deck}: ${text.length} pages (${blank} with almost no text)`);
  }
  return pages;
}

/** The speaker with the most transcript text. */
function dominantSpeaker(segments: TranscriptSegment[]): string | null {
  const chars = new Map<string, number>();
  for (const s of segments) if (s.speaker) chars.set(s.speaker, (chars.get(s.speaker) ?? 0) + s.text.length);
  return [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function lines(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${formatTime(s.start)}] ${s.text}`).join("\n");
}

// ---------- Gemini steps (all cached by lib/gemini.ts) ----------

interface Rewrite {
  concept: string;
  explanation: string;
}

function rewrite(question: string) {
  return generateJSON<Rewrite>(
    MODELS.flash,
    `A student is practicing with this question from a data structures and algorithms course (COP3530):

${question}

Write the explanation a professor would give in lecture for the concept this question tests: 3 to 5 sentences in a spoken, classroom style, using the key terms a professor would say out loud. Explain the concept; don't just state the answer to this specific question.`,
    {
      type: "object",
      properties: {
        concept: { type: "string", description: "The concept tested, in a few words" },
        explanation: { type: "string" },
      },
      required: ["concept", "explanation"],
    },
  );
}

interface Pick {
  candidate: number;
  startLabel: string;
  endLabel: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

function pickMoment(question: string, concept: string, candidates: { segments: TranscriptSegment[] }[]) {
  const blocks = candidates.map((c, i) => `Candidate ${i + 1}:\n${lines(c.segments)}`).join("\n\n");
  return generateJSON<Pick>(
    MODELS.flash,
    `A student missed this practice question (concept: ${concept}):

${question}

Below are candidate passages from the professor's lecture transcript. Each line starts with its timestamp.
Pick the passage where the professor best explains what the student needs to answer this question correctly. Prefer an explanation over a passing mention. If none of them explains it, answer candidate 0.

Then pick two lines in that passage:
- Start: the line where he begins explaining the specific point the question tests. For a worked problem, that's where he works out the answer (for example, finds the collisions), not where he first introduces the problem.
- End: the last line of that thought, including any self-correction or conclusion that follows ("actually, did we do this correctly?" and the fix). The clip may run at most ${MAX_CLIP_SEC} seconds from the start.

${blocks}`,
    {
      type: "object",
      properties: {
        candidate: { type: "integer", description: "1-based candidate number, or 0 if none explains it" },
        startLabel: { type: "string", description: "The timestamp exactly as shown at the start of the start line, e.g. 43:40" },
        endLabel: { type: "string", description: "The timestamp exactly as shown at the start of the end line" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        reason: { type: "string", description: "One sentence" },
      },
      required: ["candidate", "startLabel", "endLabel", "confidence", "reason"],
    },
    { temperature: 0 },
  );
}

type SetupPick = SetupLineReply;

/** `lines` are the lecturer's lines before the clip (same speaker run), tagged with their line IDs. */
function pickSetup(question: string, clipText: string, lines: { id: number; seg: TranscriptSegment }[], avoid: string[] = []) {
  return generateJSON<SetupPick>(MODELS.flash, setupLinePrompt({ question, clipText, lines, avoid }), SETUP_LINE_SCHEMA, { temperature: 0 });
}

interface SlidePick {
  option: number;
  reason: string;
}

function pickSlide(question: string, clipText: string, options: SlidePage[]) {
  return generateJSON<SlidePick>(
    MODELS.flash,
    `A student missed this practice question:

${question}

The professor explains it in this part of the lecture:
${clipText}

Which of these slides should the student see beside that clip? Choose the one that best helps them answer this question: prefer a slide whose example or comparison matches the question itself over one that only matches the lecture's wording. Answer with its option number.

${options.map((p, i) => `Option ${i + 1} (deck "${p.deck}", page ${p.page}):\n${p.text.slice(0, 1500)}`).join("\n\n")}`,
    {
      type: "object",
      properties: {
        option: { type: "integer" },
        reason: { type: "string", description: "One sentence" },
      },
      required: ["option", "reason"],
    },
    { temperature: 0 },
  );
}

// ---------- Main ----------

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** Splits the transcript into unbroken runs of the lecturer's speech (other speakers end a run). */
function lecturerRuns(all: TranscriptSegment[], lecturer: string | null): TranscriptSegment[][] {
  const runs: TranscriptSegment[][] = [];
  let run: TranscriptSegment[] = [];
  for (const s of all) {
    if (!lecturer || s.speaker === lecturer) run.push(s);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** A time label as Flash returns it: "1:37:59", or copied with the transcript's brackets, "[1:37:59]". */
export function labelTime(label: string): number | null {
  const m = label.match(/\d{1,2}(?::\d{2}){1,2}/);
  if (!m) return null;
  try {
    return parseTime(m[0]);
  } catch {
    return null;
  }
}

async function main() {
  const dir = arg("dir") ?? "private/spike";
  const files = await readdir(dir);
  const duration = arg("duration");
  const transcriptPath = arg("transcript") ?? (await findTranscript(dir, files));
  const transcript = await loadTranscript(transcriptPath, duration ? parseTime(duration) : undefined);
  const tag = arg("tag") ?? basename(transcriptPath).replace(/(\.transcript)?\.[^.]+$/, "");
  const audio = arg("audio");
  const questions = (await readFile(arg("questions") ?? join(dir, "questions.txt"), "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const speakerArg = arg("speaker");
  const lecturer = speakerArg === "all" ? null : (speakerArg ?? dominantSpeaker(transcript.segments));
  const runs = lecturerRuns(transcript.segments, lecturer);
  const segments = runs.flat();
  const lineId = new Map(transcript.segments.map((s, i) => [s, i]));
  const estimated = transcript.segments.filter((s) => s.estimated).length;
  console.log(`Transcript: ${transcriptPath}: ${transcript.segments.length} segments (${estimated} estimated), ${formatTime(transcript.durationSec)}`);
  // Clips stop before anyone else speaks, so they never play a guest or a student.
  const otherStarts = transcript.segments.filter((s) => lecturer && s.speaker !== lecturer).map((s) => s.start);
  const stopBefore = (t: number) => Math.min(transcript.durationSec, ...otherStarts.filter((x) => x > t));
  if (lecturer) {
    const others = new Map<string, { n: number; from: number; to: number }>();
    for (const s of transcript.segments) {
      if (s.speaker === lecturer) continue;
      const k = s.speaker ?? "(no speaker)";
      const o = others.get(k) ?? { n: 0, from: s.start, to: s.end };
      others.set(k, { n: o.n + 1, from: Math.min(o.from, s.start), to: Math.max(o.to, s.end) });
    }
    console.log(`Searching only "${lecturer}" (${segments.length} segments). Left out of search and clips:`);
    for (const [k, o] of others) console.log(`  ${k}: ${o.n} segments, ${formatTime(o.from)} to ${formatTime(o.to)}`);
  }

  // Windows never span another speaker's section.
  const windows = runs.flatMap((r) => makeWindows(r)).map((w, index) => ({ ...w, index }));
  const windowVecs = await embed(windows.map((w) => w.text), { taskType: "RETRIEVAL_DOCUMENT" });
  console.log(`Windows: ${windows.length} (40 s, overlapping by 20 s)`);

  const slidesDir = arg("slides") ?? dir;
  const deck = arg("deck");
  const slideFiles = (slidesDir === dir ? files : await readdir(slidesDir)).filter((f) => !deck || f.includes(deck));
  const pages = await loadSlides(slidesDir, slideFiles);
  const pageVecs = await embed(
    pages.map((p) => `${p.deck}, slide ${p.page}: ${p.text || "(no text)"}`),
    { taskType: "RETRIEVAL_DOCUMENT" },
  );
  console.log(`Questions: ${questions.length}${audio ? `; refining starts with word-level times from ${audio}` : ""}\n`);

  const results = [];
  for (const [qi, question] of questions.entries()) {
    const rw = await rewrite(question);
    const [queryVec] = await embed([`${rw.concept}. ${rw.explanation}`], { taskType: "RETRIEVAL_QUERY" });

    // Top windows, kept 40 s apart so the candidates are different moments.
    const top = topK(queryVec, windows, windowVecs, CANDIDATES, CLIP_SEC);
    const candidates = top.map((r) => {
      const until = Math.min(r.item.start + LOOKAHEAD_SEC, stopBefore(r.item.start));
      return {
        window: r.item,
        score: r.score,
        segments: segments.filter((s) => s.start >= r.item.start - CONTEXT_SEC && s.start < until),
      };
    });

    const pick = await pickMoment(question, rw.concept, candidates);
    const chosen = pick.candidate >= 1 && pick.candidate <= candidates.length ? candidates[pick.candidate - 1] : null;
    let start: number | null = null;
    let end: number | null = null;
    if (chosen) {
      const s = labelTime(pick.startLabel);
      const startOk = s !== null && chosen.segments.some((x) => Math.abs(x.start - s) < 1);
      start = snapToSegment(segments, startOk ? s! : chosen.window.start);
      // End: the end of the line Flash marked as the end of the thought, capped and stopped before other speakers.
      const e = labelTime(pick.endLabel);
      const endSeg = e === null ? undefined : chosen.segments.find((x) => Math.abs(x.start - e) < 1 && x.start >= start!);
      const cap = Math.min(start + MAX_CLIP_SEC, stopBefore(start));
      end = Math.min(endSeg ? endSeg.end : start + CLIP_SEC, cap);
      if (end - start < 15) end = Math.min(start + CLIP_SEC, cap);
    }
    const clip = start === null ? [] : segments.filter((s) => s.start >= start && s.start < end!);
    const clipText = clip.map((s) => s.text).join(" ");
    const startSeg = clip[0] ?? null;

    // Setup line: what he's in the middle of, from the lines before the clip (same speaker run, up to 5 min).
    let exampleStart: number | null = null;
    let setup: string | null = null;
    let sourceLines: number[] = [];
    let setupCheck: { words: number; grounding: number; unsupported: string[]; shown: boolean } | null = null;
    const run = startSeg ? runs.find((r) => r.includes(startSeg)) : undefined;
    const before = run && start !== null
      ? run.filter((s) => s.start < start && s.start >= start - SETUP_LOOKBACK_SEC).map((seg) => ({ id: lineId.get(seg)!, seg }))
      : [];
    if (before.length) {
      // Checked against every line from the example's start to the clip; sourceLines are the citation.
      const check = (sp: SetupPick) => {
        const example = before.find((l) => l.id === sp.exampleLine);
        const span = before.filter((l) => l.id >= (example?.id ?? before[0].id));
        const cited = [...new Set(sp.sourceLines)].filter((id) => span.some((l) => l.id === id)).sort((a, b) => a - b);
        const g = setupGrounding(sp.setup, span.map((l) => l.seg.text));
        // No numbers at all: he may say one and correct it within the clip.
        const nums = setupNumbers(sp.setup);
        if (nums.length) g.unsupported.push(...nums.map((n) => `the number ${n}`));
        const words = wordCount(sp.setup);
        const ok = sp.setup.trim() !== "" && cited.length > 0 && words <= SETUP_MAX_WORDS && g.score >= MIN_GROUNDING && nums.length === 0;
        return { sp, example, cited, g, words, ok };
      };
      let c = check(await pickSetup(question, clipText, before));
      if (!c.ok && c.g.unsupported.length) c = check(await pickSetup(question, clipText, before, c.g.unsupported));
      exampleStart = c.example ? c.example.seg.start : null;
      setupCheck = { words: c.words, grounding: Number(c.g.score.toFixed(2)), unsupported: c.g.unsupported, shown: c.ok };
      setup = c.ok ? c.sp.setup.trim() : null;
      sourceLines = c.ok ? c.cited : [];
    }

    // Word-level refinement: where the clip's first words really start in the audio.
    let audioStart: number | null = null;
    if (audio && start !== null) {
      const hit = locate(clipText, await audioWords(audio, start));
      audioStart = hit ? Math.round(hit.start * 10) / 10 : null;
    }

    // Slide: rank pages from every deck against the explanation plus the clip, then Flash picks among the top 3.
    const [clipVec] = clipText ? await embed([clipText], { taskType: "RETRIEVAL_QUERY" }) : [queryVec];
    const slideQuery = normalize(normalize(queryVec).map((x, i) => x + normalize(clipVec)[i]));
    const topPages = topK(slideQuery, pages.map((p, i) => ({ ...p, start: i })), pageVecs, 3);
    const options = topPages.map((r) => r.item);
    const sp = await pickSlide(question, clipText || rw.explanation, options);
    const slide = options[sp.option - 1] ?? options[0];

    const playFrom = audioStart ?? start;
    const runnerUps = candidates.filter((c) => c !== chosen);
    const result = {
      n: qi + 1,
      question,
      concept: rw.concept,
      start,
      startLabel: start === null ? null : formatTime(start),
      startEstimated: startSeg?.estimated ?? false,
      audioStart,
      playFrom,
      consoleSeconds: playFrom === null ? null : Math.floor(playFrom),
      end,
      clipSec: start === null || end === null ? null : Math.round(end - start),
      windowStart: chosen?.window.start ?? null,
      offsetFromWindowSec: chosen && start !== null ? Math.round(start - chosen.window.start) : null,
      speaker: startSeg?.speaker ?? null,
      exampleStart,
      setup,
      sourceLines,
      setupCheck,
      pickedStartLabel: pick.startLabel,
      pickedEndLabel: pick.endLabel,
      confidence: pick.confidence,
      reason: pick.reason,
      clipText,
      runnerUps: runnerUps.map((c) => ({ start: c.window.start, label: formatTime(c.window.start), score: Number(c.score.toFixed(3)) })),
      slide: { deck: slide.deck, page: slide.page, text: slide.text.slice(0, 120), reason: sp.reason },
      slideRunnerUps: options.filter((o) => o !== slide).map((o) => ({ deck: o.deck, page: o.page })),
    };
    results.push(result);

    console.log(`Q${result.n}. ${question}`);
    console.log(`  Concept:     ${rw.concept}`);
    if (start === null) {
      console.log(`  Rewind to:   none (Flash says no candidate explains it: ${pick.reason})`);
    } else {
      const where = `window starts ${formatTime(chosen!.window.start)}, pick is ${result.offsetFromWindowSec! >= 0 ? "+" : ""}${result.offsetFromWindowSec} s from it`;
      console.log(`  Rewind to:   ${result.startLabel}${result.startEstimated ? " (estimated time)" : ""} to ${formatTime(end!)} (${result.clipSec} s; ${where})`);
      if (audio) console.log(`  Audio:       ${audioStart === null ? "sentence not found in the audio" : `${formatTime(audioStart)} (${(audioStart - start).toFixed(1)} s from the transcript time)`}`);
      console.log(`  Why:         [${pick.confidence}] ${pick.reason}`);
      console.log(`  Clip text:   ${clipText}`);
      console.log(`  Example:     ${exampleStart === null ? "clip starts at its beginning" : `starts ${formatTime(exampleStart)} (${Math.round(start - exampleStart)} s before the clip)`}`);
      console.log(`  Setup:       ${setup ?? "(not shown)"}${setupCheck ? `  [${setupCheck.words} words, grounding ${setupCheck.grounding}${setupCheck.unsupported.length ? `, unsupported: ${setupCheck.unsupported.join(", ")}` : ""}]` : ""}`);
    }
    console.log(`  Runner-ups:  ${result.runnerUps.map((r) => `${r.label} (${r.score})`).join(", ")}`);
    console.log(`  Slide:       "${slide.deck}" page ${slide.page}: "${result.slide.text}"`);
    console.log(`               runner-ups: ${result.slideRunnerUps.map((o) => `"${o.deck}" p${o.page}`).join(", ")}`);
    console.log();
  }

  await writeFile(join(dir, `results-${tag}.json`), JSON.stringify({ transcript: transcriptPath, lecturer, audio: audio ?? null, results }, null, 2));
  const md = [
    "# Rewind spike: check each clip by ear",
    "",
    `Transcript: \`${transcriptPath}\`${audio ? `; starts refined with word-level times from \`${audio}\`` : ""}. Only ${lecturer ?? "all speakers"} is searched; clips stop before anyone else speaks.`,
    "",
    "To jump: in the Zoom recording tab, open the DevTools console and run `document.querySelector('audio, video').currentTime = <seconds>`.",
    "",
    "Right = he explains what the question needs. A match in the guest section is wrong. Pass = 3 of 5 right.",
    "",
    ...results.flatMap((r) => [
      `## Q${r.n}. ${r.question}`,
      "",
      r.playFrom === null
        ? "- Rewind to: **none** (no candidate explains it)"
        : `- Rewind to **${formatTime(r.playFrom)}**, console seconds **${r.consoleSeconds}**, clip ${r.clipSec} s (to ${formatTime(r.end!)})${r.startEstimated ? ", estimated time" : ""}`,
      `- Slide: "${r.slide.deck}" page ${r.slide.page}`,
      `- Example starts: ${r.exampleStart === null ? "at the clip (no earlier start)" : `**${formatTime(r.exampleStart)}** (console seconds ${Math.floor(r.exampleStart)}, ${Math.round(r.playFrom! - r.exampleStart)} s before the clip)`}`,
      `- Setup: ${r.setup ? `"${r.setup}"` : "(not shown)"}${r.setupCheck ? ` (${r.setupCheck.words} words, grounding ${r.setupCheck.grounding}${r.setupCheck.unsupported.length ? `; unsupported words: ${r.setupCheck.unsupported.join(", ")}` : ""})` : ""}`,
      ...(r.sourceLines.length
        ? ["- Setup source lines:", ...r.sourceLines.map((id) => `  - #${id} [${formatTime(transcript.segments[id].start)}] ${transcript.segments[id].text}`)]
        : []),
      `- Runner-ups: ${r.runnerUps.map((x) => x.label).join(", ")}`,
      "",
      `> ${r.clipText || "(no clip)"}`,
      "",
      "- [ ] right  - [ ] wrong",
      "- Notes:",
      "",
    ]),
  ].join("\n");
  const mdPath = arg("out") ?? join(dir, "results.md");
  await writeFile(mdPath, md);
  console.log(`Wrote ${join(dir, `results-${tag}.json`)} and ${mdPath}`);
  console.log(`Gemini usage log: .cache/gemini/usage.jsonl`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
