// The demo bundle: everything demo mode shows, precomputed and hosted as static files, so the
// deployed app needs no API keys, no model calls and no private/ data.
//
// The bundle is one committed directory, public/demo/course/ (BUNDLE_DIR): course.json
// (DemoBundleFile, below) and the slide images it names. scripts/demo/export-demo.ts writes it
// from the real COP3530 pipeline output, keeping only the allowlisted fields (lib/demo/export.ts).
// The approved hosted clips are separate: public/demo/media/<questionId>.mp4 (MEDIA_DIR), one per
// hosted question, dropped in by John. A hosted question whose file isn't there plays nothing: it
// shows the slide and the clip's transcript, the same as every other question without hosted media.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChoiceLabel, TranscriptSegment } from "../schema.ts";
import { parseTopicStats, TOPIC_STATS_FILE, type TopicStatsFile } from "./topic-stats.ts";
import type { PracticeSeed, SeedQuestion } from "./types.ts";

/** The bundle directory under public/: the only place real course text may be committed. */
export const BUNDLE_DIR = "demo/course";
/** The hosted clips, one file per hosted question: public/demo/media/<questionId>.mp4, starting at its clip start. */
export const MEDIA_DIR = "demo/media";
export const BUNDLE_FORMAT = "rewind-demo/3";
export const PERMISSION_LABEL = "Demo course, materials used with Professor Kapoor's permission";

/** One question, only the allowlisted fields (lib/demo/export.ts QUESTION_KEYS). */
export interface DemoQuestionFile {
  id: string;
  /** What it's about, from its slide's title (scripts/demo/demo-topics.json): one Course tape stop per lecture and topic. */
  topic: string;
  stem: string;
  code: { language: string; lines: string[] } | null;
  choices: { label: ChoiceLabel; text: string }[];
  answer: ChoiceLabel;
  explanation: string;
  quote: string;
  /**
   * The slide (or document page) the answer is on; image is relative to the bundle directory.
   * revealsAnswer: a poll or answer slide (it shows the answer), never shown before the student answers (lib/tutor/poll.ts).
   * quoteDeck and quotePage: where the quote's words are, when that isn't this slide (a lecture question shows its
   * lecture's own deck; its quote may be from a Discussion deck the lecture never opened).
   */
  slide: { deck: string; page: number; kind: "slide" | "page"; image: string; revealsAnswer?: true; quoteDeck?: string; quotePage?: number };
  /** The lecture moment that explains it, in seconds of its lecture, and the grounded setup line. */
  clip: { start: number; end: number; setup: string | null };
  /** The lecturer's lines inside the clip, word for word. */
  lines: { start: number; end: number; text: string }[];
}

/** A lecture's practice set: its questions, the hosted-clip ones first. */
export interface DemoSetFile {
  /** The lecture's date, YYYY-MM-DD. */
  id: string;
  title: string;
  lecture: string;
  /** The questions with a hosted clip (public/demo/media/<id>.mp4, starting at clip.start): the set's first questions, in order. */
  hosted: string[];
  questions: DemoQuestionFile[];
}

export interface DemoBundleFile {
  format: typeof BUNDLE_FORMAT;
  label: string;
  course: { code: string; name: string };
  lecturer: { name: string; short: string };
  sets: DemoSetFile[];
}

/** A hosted clip that is there: its URL, and the lecture second the file starts at. */
export interface HostedClip {
  questionId: string;
  src: string;
  offset: number;
  /** The lecture second its clip ends. */
  end: number;
}

export interface DemoSet {
  id: string;
  title: string;
  lecture: string;
  seed: PracticeSeed;
  /** The hosted questions whose file is in public/demo/media/, in set order. */
  hosted: HostedClip[];
  /** Every hosted-clip question, file there or not (the set's first questions). */
  hostedIds: string[];
}

export interface DemoBundle {
  label: string;
  course: { code: string; name: string };
  lecturer: { name: string; short: string };
  sets: DemoSet[];
  /** topic-stats.json when it's there (lib/demo/topic-stats.ts): minutes and flags per stop from the full recordings. */
  stats?: TopicStatsFile;
}

/** A path from course.json as a URL under /<dir>/; never one that climbs out. */
export function resolveAsset(dir: string, path: string): string {
  const clean = path.replace(/^\.?\//, "");
  if (!clean || /^[a-z]+:/i.test(clean) || clean.split("/").some((p) => p === ".." || p === "" || p === ".")) throw new Error(`Bad asset path in the demo bundle: "${path}"`);
  return `/${dir}/${clean}`;
}

const LABELS: ChoiceLabel[] = ["A", "B", "C", "D"];
/** A question id that can name a media file. */
const MEDIA_ID = /^[a-z0-9-]{1,32}$/;

/**
 * Checks course.json and turns it into the practice seeds the demo pages show. `hasMedia` says
 * whether a hosted question's file is there. Throws with what's wrong, so a bad bundle fails the build.
 */
export function parseBundle(raw: unknown, hasMedia: (questionId: string) => boolean = () => false): DemoBundle {
  const fail = (msg: string): never => {
    throw new Error(`Demo bundle public/${BUNDLE_DIR}/course.json: ${msg}`);
  };
  const b = raw as Partial<DemoBundleFile> | null;
  if (!b || typeof b !== "object") fail("not an object");
  if (b!.format !== BUNDLE_FORMAT) fail(`format must be "${BUNDLE_FORMAT}"`);
  if (typeof b!.label !== "string" || !b!.label.trim()) fail("label is required");
  if (!b!.course?.code || !b!.course?.name) fail("course needs code and name");
  if (!b!.lecturer?.name || !b!.lecturer?.short) fail("lecturer needs name and short");
  if (!Array.isArray(b!.sets) || b!.sets.length === 0) fail("sets is empty");

  const sets = b!.sets!.map((set): DemoSet => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(set.id) || !set.title || !set.lecture) fail(`set ${set.id}: id (a date), title and lecture are required`);
    if (!Array.isArray(set.questions) || !set.questions.length) fail(`set ${set.id}: no questions`);
    const questions = set.questions.map((q, i): SeedQuestion => {
      const at = `set ${set.id} question ${i + 1} (${q?.id ?? "no id"})`;
      if (!q.id || !q.stem) fail(`${at}: id and stem are required`);
      if (typeof q.topic !== "string" || !q.topic.trim()) fail(`${at}: topic is required`);
      if (!Array.isArray(q.choices) || q.choices.length < 2) fail(`${at}: needs at least two choices`);
      if (q.choices.some((c) => !LABELS.includes(c.label) || !c.text)) fail(`${at}: choices are A to D with text`);
      if (!q.choices.some((c) => c.label === q.answer)) fail(`${at}: answer ${q.answer} is not a choice`);
      const c = q.clip;
      if (!c || !(c.start >= 0) || !(c.end > c.start)) fail(`${at}: clip needs 0 <= start < end`);
      if (!q.slide?.image || !q.slide.deck || !(q.slide.page > 0)) fail(`${at}: slide needs deck, page and image`);
      if (q.slide.revealsAnswer !== undefined && q.slide.revealsAnswer !== true) fail(`${at}: slide.revealsAnswer is true or absent`);
      const quoteAt = q.slide.quoteDeck !== undefined || q.slide.quotePage !== undefined;
      if (quoteAt && (typeof q.slide.quoteDeck !== "string" || !q.slide.quoteDeck || !(Number(q.slide.quotePage) > 0))) fail(`${at}: slide.quoteDeck and quotePage come together`);
      if (!Array.isArray(q.lines) || !q.lines.length) fail(`${at}: lines are required`);
      for (let k = 0; k < q.lines.length; k++) {
        const l = q.lines[k];
        if (l.start < c.start - 1 || l.start >= c.end) fail(`${at}: line at ${l.start} s is outside the clip`);
        if (k && l.start < q.lines[k - 1].start) fail(`${at}: lines out of order`);
      }
      const segments: TranscriptSegment[] = q.lines.map((l) => ({ start: l.start, end: l.end, speaker: null, text: l.text }));
      return {
        id: q.id,
        n: i + 1,
        topic: q.topic,
        stem: q.stem,
        ...(q.code?.lines.length ? { code: q.code } : {}),
        choices: q.choices,
        answer: q.answer,
        explanation: q.explanation,
        source: { quote: q.quote, where: quoteAt ? { kind: "slide", deck: q.slide.quoteDeck!, page: q.slide.quotePage! } : { kind: "slide", deck: q.slide.deck, page: q.slide.page } },
        match: {
          start: c.start,
          end: c.end,
          exampleStart: null,
          setup: c.setup,
          sourceLines: [],
          slide: { deck: q.slide.deck, page: q.slide.page, image: resolveAsset(BUNDLE_DIR, q.slide.image), ...(q.slide.kind === "page" ? { kind: "page" as const } : {}), ...(q.slide.revealsAnswer ? { revealsAnswer: true } : {}) },
        },
        segments,
      };
    });
    if (!Array.isArray(set.hosted)) fail(`set ${set.id}: hosted must be a list of question ids`);
    const hosted: HostedClip[] = [];
    set.hosted.forEach((id, k) => {
      if (!MEDIA_ID.test(id)) fail(`set ${set.id}: hosted id "${id}" must be lowercase letters, digits and dashes`);
      const q = questions.find((x) => x.id === id);
      if (!q) fail(`set ${set.id}: hosted question ${id} isn't in the set`);
      if (questions[k].id !== id) fail(`set ${set.id}: the hosted-clip questions come first, in order (${id} is question ${q!.n})`);
      if (hasMedia(id)) hosted.push({ questionId: id, src: `/${MEDIA_DIR}/${id}.mp4`, offset: q!.match.start, end: q!.match.end });
    });
    return {
      id: set.id,
      title: set.title,
      lecture: set.lecture,
      hosted,
      hostedIds: [...set.hosted],
      seed: {
        course: b!.course!,
        set: set.title,
        lecturer: b!.lecturer!,
        recordingUrl: "",
        questions,
        questionSet: "generated",
        lectureTitle: set.lecture,
      },
    };
  });

  return { label: b!.label!.trim(), course: b!.course!, lecturer: b!.lecturer!, sets };
}

/** Same-origin files the demo shows: every slide image and every hosted clip that's there (for the offline cache). */
export function bundleAssets(bundle: DemoBundle): string[] {
  const urls = bundle.sets.flatMap((s) => [...s.hosted.map((h) => h.src), ...s.seed.questions.map((q) => q.match.slide.image)]);
  return [...new Set(urls)].sort();
}

/**
 * Reads public/demo/course/course.json under `root`, and checks which hosted clips are in
 * public/demo/media/. null when the bundle isn't there (the demo pages say so); throws when it is
 * there but malformed. Never reads anything outside public/.
 */
export async function readDemoBundle(root: string = process.cwd()): Promise<DemoBundle | null> {
  let text: string;
  try {
    text = await readFile(join(root, "public", BUNDLE_DIR, "course.json"), "utf8");
  } catch {
    return null;
  }
  const bundle = parseBundle(JSON.parse(text), (id) => existsSync(join(root, "public", MEDIA_DIR, `${id}.mp4`)));
  const statsPath = join(root, "public", BUNDLE_DIR, TOPIC_STATS_FILE);
  return existsSync(statsPath) ? { ...bundle, stats: parseTopicStats(JSON.parse(await readFile(statsPath, "utf8"))) } : bundle;
}

/** public/demo/course/deadlines.json (lib/ask/demo-deadlines.ts), parsed; null while it isn't in the bundle. */
export async function readDemoDeadlines(root: string = process.cwd()): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(root, "public", BUNDLE_DIR, "deadlines.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** public/demo/course/exams.json (lib/demo/exams.ts), read as is (lib/demo/exam-card.ts parses it); null when it isn't there. */
export async function readDemoExams(root: string = process.cwd()): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(root, "public", BUNDLE_DIR, "exams.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** public/demo/course/ask.json (lib/ask/saved.ts), parsed; null when it isn't there. */
export async function readDemoAskSaved(root: string = process.cwd()): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(root, "public", BUNDLE_DIR, "ask.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
}
