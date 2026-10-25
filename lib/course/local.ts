// Builds the course tape from the local private/ folder. Dev only, like lib/demo/load.ts: real
// course data never goes into a production build. Reads what we have now:
// - lectures: private/fixture.transcript.json (Oct 22; parsed from private/fixtures/zoom-recording.html
//   if missing) and private/lectures/*.transcript.json;
// - the exam radar over them (scripts/radar/scan.mjs, lecturer only);
// - practice questions (spike sets) with their rewinds; the student's attempts stay in the
//   browser (lib/attempts/store.ts) and app/course/tape/TapeView.tsx merges them in;
// - the Canvas export private/<CODE>.course.json when there is one (modules, files, grades,
//   announcements, exams); without it, modules come from the lectures' openings.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { FIXTURE_LECTURE_RECORDED_AT } from "../fixture-lecture.ts";
import { normalizeCourse } from "../import/normalize.ts";
import type { CourseExport } from "../import/types.ts";
import { isDemoMode } from "../demo/guard.ts";
import { parseQuestionLine } from "../demo/types.ts";
import type { PracticeQuestion } from "../pipeline/types.ts";
import type { Transcript } from "../schema.ts";
import { ensureSentences } from "../transcript.ts";
// The worker's radar scan (plain JS module), the same phrase list the CLI uses.
import { loadPhrases, scanTranscript } from "../../scripts/radar/scan.mjs";
import { buildCourseTape, modulesFromCanvas, modulesFromLectures } from "./build.ts";
import { keywords } from "./topics.ts";
import type {
  AnnouncementInput,
  ClipContext,
  CourseTape,
  CourseTapeInputs,
  ExamInput,
  GradeInput,
  LectureInput,
  NextExamInput,
  PracticeInput,
  RadarInput,
} from "./types.ts";

const COURSE = "COP3530";
const PRIVATE = () => join(process.cwd(), "private");

/** The saved Zoom page has no date in it; it is the Oct 22 lecture (lib/fixture-lecture.ts). */
const FIXTURE_DATE = FIXTURE_LECTURE_RECORDED_AT;

/** Practice sets on disk: questions, the matcher's results (optional), and which lecture they're from. */
const PRACTICE_SETS = [
  { tag: "oct22", questions: "spike/questions.txt", results: "spike/results-exact.json", lectureDate: "2026-10-22" },
  { tag: "oct20", questions: "lectures/questions-oct20.txt", results: "lectures/results-oct20.json", lectureDate: "2026-10-20" },
  { tag: "oct13", questions: "lectures/questions-oct13.txt", results: "lectures/results-oct13.json", lectureDate: "2026-10-13" },
];

/** Conceptual quizzes and exams: what paper practice prepares for (programming quizzes are coding). */
const EXAM_LIKE = /\bexam\b|\bmidterm\b|\bfinal exam\b|^\s*CQ\s*\d+|\bconceptual quiz\b/i;
const NOT_EXAM = /\bpractice exam\b|\breview\b|resubmission|participation|jeopardy/i;

export async function loadLocalCourseTape(now: string): Promise<CourseTape | null> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  const inputs = await loadLocalInputs(now);
  return inputs ? buildCourseTape(inputs) : null;
}

export type { ClipContext };

/** Seconds of lecturer lines kept around a clip, for captions and the transcript. */
const CONTEXT_SEC = 30;

/**
 * The tape plus, for every clip a stop would play first (the route plays a stop's first clip), the
 * lecturer's lines around it. Dev only, like loadLocalCourseTape.
 */
export async function loadLocalTapeScreen(now: string): Promise<{ tape: CourseTape; clips: Record<string, ClipContext> } | null> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  const inputs = await loadLocalInputs(now);
  if (!inputs) return null;
  const tape = buildCourseTape(inputs);
  return { tape, clips: clipContexts(tape, inputs.lectures) };
}

export function clipContexts(tape: CourseTape, lectures: LectureInput[]): Record<string, ClipContext> {
  const byId = new Map(lectures.map((l) => [l.id, l]));
  const out: Record<string, ClipContext> = {};
  for (const s of tape.stops) {
    const c = s.clips[0];
    const l = c ? byId.get(c.lectureId) : undefined;
    if (!c || !l) continue;
    out[c.id] = {
      segments: l.segments.filter((g) => (!l.lecturer || g.speaker === l.lecturer) && g.end >= c.start - CONTEXT_SEC && g.start <= c.end + CONTEXT_SEC),
      lecturer: l.lecturer?.trim().split(/\s+/).pop() ?? "the lecturer",
    };
  }
  return out;
}

/**
 * `includeGrades` (default false): pass the student's Canvas grades to the builder so they count in
 * "missed". Off until John approves reading grades (Tier 2); missed then comes from practice attempts only.
 */
export async function loadLocalInputs(now: string, { includeGrades = false }: { includeGrades?: boolean } = {}): Promise<CourseTapeInputs | null> {
  const notes: string[] = [];
  const lectures = await loadLectures(notes);
  const exp = await loadExport();
  if (!lectures.length && !exp) return null;

  const radar = lectures.flatMap(radarFor);
  const practice = await loadPractice(lectures);
  // Practice answers live in the student's browser (lib/attempts/store.ts); the page merges them in.
  if (!practice.some((p) => p.attempts)) notes.push("\"Missed\" comes only from the practice answers saved in this browser, on this device; Canvas grades aren't counted.");

  let modules = exp ? modulesFromCanvas(exp.modules ?? []) : [];
  if (!modules.length) {
    modules = modulesFromLectures(lectures);
    notes.push(
      exp
        ? "The Canvas export has no modules, so modules come from the lectures' openings (\"Module 8, which is Sorting\")."
        : `No Canvas export (private/${COURSE}.course.json), so modules come from the lectures' openings ("Module 8, which is Sorting"); no grades, slides or announcements.`,
    );
  }

  const { grades, exams, nextExam } = exp ? assessments(exp, now) : { grades: [], exams: [], nextExam: null };
  return {
    course: { code: exp?.course.course_code ?? COURSE, name: exp?.course.name ?? null },
    now,
    term: { firstLectureAt: null, finalExamAt: null },
    modules,
    items: exp ? normalizeCourse(exp).items : [],
    lectures,
    radar,
    practice,
    grades: includeGrades ? grades : [],
    includeGrades,
    announcements: exp ? announcementsOf(exp) : [],
    exams: examsForTape(exams, includeGrades),
    nextExam,
    notes,
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function loadExport(): Promise<CourseExport | null> {
  return readJson<CourseExport>(join(PRIVATE(), `${COURSE}.course.json`));
}

/** The speaker with the most words: the lecturer. */
function lecturerOf(t: Transcript): string | null {
  const chars = new Map<string, number>();
  for (const s of t.segments) if (s.speaker) chars.set(s.speaker, (chars.get(s.speaker) ?? 0) + s.text.length);
  return [...chars].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function toLecture(id: string, t: Transcript): LectureInput {
  return {
    id,
    title: t.title || id,
    recordedAt: t.recordedAt,
    recordingUrl: t.recordingUrl,
    durationSec: t.durationSec,
    // The slide timeline, when one was made for this recording (a separate job): minutes then follow the slides.
    ...(Array.isArray((t as { slideTimeline?: unknown }).slideTimeline) ? { slideTimeline: (t as unknown as { slideTimeline: NonNullable<LectureInput["slideTimeline"]> }).slideTimeline } : {}),
    lecturer: lecturerOf(t),
    segments: t.segments,
  };
}

async function loadLectures(notes: string[]): Promise<LectureInput[]> {
  const out: LectureInput[] = [];
  const fixture = join(PRIVATE(), "fixture.transcript.json");
  const html = join(PRIVATE(), "fixtures/zoom-recording.html");
  if (existsSync(fixture)) {
    const t = ensureSentences((await readJson<Transcript>(fixture))!);
    out.push(toLecture("lecture-2026-10-22", { ...t, recordedAt: t.recordedAt ?? FIXTURE_DATE }));
  } else if (existsSync(html)) {
    const { toTranscript } = await import("../../scripts/spike/parse.ts");
    const t = toTranscript(await readFile(html, "utf8"), { filename: html, title: "Lecture" });
    out.push(toLecture("lecture-2026-10-22", { ...t, recordedAt: FIXTURE_DATE }));
  }
  const dir = join(PRIVATE(), "lectures");
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".transcript.json")).sort() : [];
  for (const f of files) {
    const t = await readJson<Transcript>(join(dir, f));
    if (!t?.segments?.length) continue;
    const date = (t.recordedAt ?? f).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? basename(f, ".transcript.json");
    out.push(toLecture(`lecture-${date}`, ensureSentences(t)));
  }
  if (!out.length) notes.push("No lecture transcripts in private/, so there are no lecture minutes, radar flags or clips.");
  return out;
}

interface Hit {
  start: number;
  kind: string | null;
  phrase: string;
  text: string;
}

/** Radar hits from the lecturer, one per moment; moments under 15 s apart merge (as in the seed). */
function radarFor(l: LectureInput): RadarInput[] {
  const transcript = { segments: l.segments };
  const hits = scanTranscript(transcript, l.id, loadPhrases(join(process.cwd(), "scripts/radar/phrases.json")), {
    speaker: l.lecturer ?? undefined,
  }) as Hit[];
  const byStart = new Map<number, RadarInput>();
  for (const h of hits) {
    const m = byStart.get(h.start) ?? { lectureId: l.id, start: h.start, kinds: [], phrases: [], text: h.text };
    if (h.kind && !m.kinds.includes(h.kind)) m.kinds.push(h.kind);
    if (!m.phrases.includes(h.phrase)) m.phrases.push(h.phrase);
    byStart.set(h.start, m);
  }
  const out: RadarInput[] = [];
  for (const m of [...byStart.values()].sort((a, b) => a.start - b.start)) {
    const prev = out[out.length - 1];
    if (prev && m.start - prev.start < 15) {
      for (const k of m.kinds) if (!prev.kinds.includes(k)) prev.kinds.push(k);
      for (const p of m.phrases) if (!prev.phrases.includes(p)) prev.phrases.push(p);
    } else out.push(m);
  }
  return out;
}

interface MatchResult {
  n: number;
  playFrom: number | null;
  end: number | null;
  slide?: { deck: string; page: number } | null;
}

async function loadPractice(lectures: LectureInput[]): Promise<PracticeInput[]> {
  const out: PracticeInput[] = [];
  for (const set of PRACTICE_SETS) {
    let text: string;
    try {
      text = await readFile(join(PRIVATE(), set.questions), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const results = (await readJson<{ results: MatchResult[] }>(join(PRIVATE(), set.results)))?.results ?? [];
    const lecture = lectures.find((l) => l.id === `lecture-${set.lectureDate}`) ?? null;
    lines.forEach((line, i) => {
      const r = results.find((x) => x.n === i + 1);
      out.push({
        id: `${set.tag}-q${i + 1}`,
        text: parseQuestionLine(line).stem,
        lectureId: lecture?.id ?? null,
        clip: lecture && r && r.playFrom !== null && r.end !== null ? { start: r.playFrom, end: r.end, slide: r.slide ? { deck: r.slide.deck, page: r.slide.page } : null } : null,
        attempts: null,
      });
    });
  }
  return [...out, ...(await loadPipelinePractice(lectures))];
}

/**
 * Generated questions from the course pipeline (private/pipeline/<COURSE>/): the finished run's
 * output.json / questions.json, plus any in generated.json whose retrieval already has a clip (the
 * run may still be going). Only questions the answer check kept. Each brings its real rewind clip.
 */
async function loadPipelinePractice(lectures: LectureInput[]): Promise<PracticeInput[]> {
  const dir = join(PRIVATE(), "pipeline", COURSE);
  const list = <T,>(v: T[] | { questions?: T[] } | null): T[] => (Array.isArray(v) ? v : (v?.questions ?? []));
  const [output, questions, generated] = await Promise.all([
    readJson<{ questions?: PracticeQuestion[] }>(join(dir, "output.json")),
    readJson<PracticeQuestion[]>(join(dir, "questions.json")),
    readJson<{ questions?: PracticeQuestion[] }>(join(dir, "generated.json")),
  ]);
  const byId = new Map<string, PracticeQuestion>();
  const offer = (q: PracticeQuestion, needsClip: boolean) => {
    if (!q?.id || !q.stem || q.check?.agreed === false) return;
    if (needsClip && !q.retrieval?.clip) return;
    const cur = byId.get(q.id);
    if (!cur || (!cur.retrieval?.clip && q.retrieval?.clip)) byId.set(q.id, q);
  };
  for (const q of [...list(output), ...list(questions)]) offer(q, false);
  for (const q of list(generated)) offer(q, true);
  return [...byId.values()].map((q) => pipelinePractice(q, lectures));
}

export function pipelinePractice(q: PracticeQuestion, lectures: LectureInput[]): PracticeInput {
  const c = q.retrieval?.clip ?? null;
  const day = (s: string | null | undefined) => s?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const lecture = c
    ? (lectures.find((l) => l.recordingUrl && l.recordingUrl === c.recordingUrl) ??
      lectures.find((l) => day(c.transcriptId) && day(l.recordedAt) === day(c.transcriptId)) ??
      null)
    : null;
  const slide = q.retrieval?.slide ?? (q.quoteSource?.kind === "slide" ? q.quoteSource : null);
  return {
    id: q.id,
    text: q.stem,
    topic: q.topic,
    lectureId: lecture?.id ?? null,
    clip: lecture && c ? { start: c.start, end: c.end, slide: slide && "deck" in slide ? { deck: slide.deck, page: slide.page } : null, setup: c.setup, exampleStart: c.exampleStart } : null,
    attempts: null,
  };
}

/** Exam markers keep their scores only with includeGrades, so no Canvas grade reaches the page data while it's off. */
export function examsForTape(exams: ExamInput[], includeGrades: boolean): ExamInput[] {
  return includeGrades ? exams : exams.map((e) => ({ ...e, score: null, possible: null }));
}

function assessments(exp: CourseExport, now: string): { grades: GradeInput[]; exams: ExamInput[]; nextExam: NextExamInput | null } {
  const subs = new Map(exp.submissions.map((s) => [Number(s.assignment_id), s]));
  const grades: GradeInput[] = [];
  const exams: ExamInput[] = [];
  const upcoming: { a: Record<string, unknown>; due: string }[] = [];
  for (const a of exp.assignments) {
    const id = Number(a.id);
    const name = String(a.name ?? "").trim();
    const possible = typeof a.points_possible === "number" ? a.points_possible : null;
    const sub = subs.get(id);
    const score = typeof sub?.score === "number" && sub.workflow_state === "graded" && !sub.excused ? sub.score : null;
    const href = typeof a.html_url === "string" ? a.html_url : undefined;
    if (score !== null && possible) {
      grades.push({ id: String(id), name, score, possible, gradedAt: typeof sub?.graded_at === "string" ? sub.graded_at : null, href });
    }
    if (EXAM_LIKE.test(name) && !NOT_EXAM.test(name)) {
      const due = typeof a.due_at === "string" ? a.due_at : null;
      exams.push({ id: String(id), name, at: due, score, possible, href });
      const done = sub && (sub.workflow_state === "graded" || sub.workflow_state === "submitted" || sub.workflow_state === "pending_review");
      if (due && due > now && !done) upcoming.push({ a, due });
    }
  }
  upcoming.sort((x, y) => x.due.localeCompare(y.due) || String(x.a.name).localeCompare(String(y.a.name)));
  const next = upcoming[0];
  let nextExam: NextExamInput | null = null;
  if (next) {
    const name = String(next.a.name).trim();
    // Coverage only when the title itself names topics ("Quiz 8 - Graphs 1"); "Exam 2" says nothing.
    nextExam = { id: String(next.a.id), name, at: next.due, coverage: keywords(name).length ? { quote: name, source: "Canvas assignment title" } : null };
  }
  return { grades, exams, nextExam };
}

function htmlLines(html: string): string[] {
  return html
    .replace(/<(?:br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 2);
}

function announcementsOf(exp: CourseExport): AnnouncementInput[] {
  return exp.announcements.map((a) => ({
    id: String(a.id),
    title: String(a.title ?? ""),
    postedAt: typeof a.posted_at === "string" ? a.posted_at : null,
    lines: htmlLines(typeof a.message === "string" ? a.message : ""),
    href: typeof a.html_url === "string" ? a.html_url : undefined,
  }));
}
