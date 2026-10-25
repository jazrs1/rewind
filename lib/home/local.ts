// Feeds the course home (and /practice's module and lecture links) from the local private/ folder.
// Dev only, like lib/demo/load.ts: real course data never goes into a production build or demo mode.
// Reads what we have now:
// - exams: private/pipeline/<CODE>/exams.json (the T17 exams stage: PipelineExam[], or its
//   { exams } result), each field re-checked against its source in docs.json (checkedExams);
// - modules and course name: the Canvas export private/<CODE>.course.json;
// - lectures: private/fixture.transcript.json (Oct 22; parsed from private/fixtures/zoom-recording.html
//   if missing) and private/lectures/*.transcript.json;
// - the practice questions /practice serves: the pipeline's output.json when a run has finished,
//   else private/demo/seed.json (lib/pipeline/practice-seed.ts), indexed by lecture and module
//   (loadLocalPracticeIndex).

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURE_LECTURE_RECORDED_AT } from "../fixture-lecture.ts";
import { deckDisplayName } from "../format.ts";
import { isDemoMode } from "../demo/guard.ts";
import type { PracticeSeed } from "../demo/types.ts";
import { loadPipelineSeed } from "../pipeline/practice-seed.ts";
import { checkField, easternIso, examSources, type ExamExport } from "../pipeline/exams.ts";
import type { ExtractedDoc, PipelineExam } from "../pipeline/types.ts";
import type { Sourced, Transcript } from "../schema.ts";
import { buildHome, easternDate, modulesForLecture } from "./build.ts";
import { questionModule } from "./practice.ts";
import type { HomeExamInput, HomeLectureInput, HomeModel, HomeModuleInput, PracticeIndexQuestion } from "./types.ts";

export const HOME_COURSE = "COP3530";
/** The saved Zoom page has no date in it; it is the Oct 22 lecture (lib/fixture-lecture.ts). */
const FIXTURE_DATE = FIXTURE_LECTURE_RECORDED_AT;

const PRIVATE = () => join(process.cwd(), "private");

interface CanvasModule {
  id: number;
  name?: string;
  position?: number;
  items?: { title?: string; type?: string; content_id?: number }[];
}

export interface CourseExportLite {
  exportedAt?: string;
  course: { name?: string | null; course_code?: string | null };
  modules?: CanvasModule[];
  assignments?: { id: number; due_at?: string | null }[];
}

type LoadedLecture = HomeLectureInput & { recordingUrl: string };

const sameCode = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();
const dev = () => process.env.NODE_ENV === "development" && !isDemoMode();
/** The set /practice serves by default: the pipeline's practice set, else the local seed. */
const servedSeed = async (code: string): Promise<PracticeSeed | null> => (await loadPipelineSeed(code)) ?? (await readJson<PracticeSeed>(join(PRIVATE(), "demo/seed.json")));

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function loadLocalHome(now: string, code = HOME_COURSE): Promise<HomeModel | null> {
  if (!dev()) return null;
  const [examsFile, exp, lectures, seed, docs] = await Promise.all([
    readJson<PipelineExam[] | { exams: PipelineExam[] }>(join(PRIVATE(), "pipeline", code, "exams.json")),
    readJson<CourseExportLite>(join(PRIVATE(), `${code}.course.json`)),
    loadLectures(),
    servedSeed(code),
    readJson<ExtractedDoc[]>(join(PRIVATE(), "pipeline", code, "docs.json")),
  ]);
  const exams = checkedExams(Array.isArray(examsFile) ? examsFile : (examsFile?.exams ?? []), docs ?? [], exp);
  if (!examsFile && !exp && !lectures.length) return null;
  const modules = (exp?.modules ?? []).map((m, i) => toModule(m, i, dueDates(exp)));
  return buildHome({
    course: {
      code: exp?.course.course_code ?? code,
      // Canvas's name is often the code and term ("COP3530 - Fa26"); the practice seed carries the course's full name.
      name: (sameCode(seed?.course?.code, exp?.course.course_code ?? code) && seed?.course?.name) || exp?.course.name || null,
      importedAt: exp?.exportedAt ?? null,
    },
    now,
    exams,
    modules,
    lectures,
    practice: practiceIndex(seed, lectures, modules),
  });
}

type ExportForExams = { course: { id?: number; name?: string | null; course_code?: string | null }; announcements?: ExamExport["announcements"]; assignments?: ExamExport["assignments"] };

/**
 * exams.json's exams, with every field checked again against its source text (the extracted docs)
 * the way the exams stage checks a model's quote: the quote is in the cited source word for word
 * and supports the value (quoteIn, supportedValue). A field that fails is shown as "not found",
 * as is a windowCloses that isn't its assignment's due_at.
 */
export function checkedExams(exams: PipelineExam[], docs: ExtractedDoc[], exp: ExportForExams | null): HomeExamInput[] {
  const sources = new Map(
    examSources(docs, { course: { id: exp?.course.id ?? 0, name: exp?.course.name ?? null, course_code: exp?.course.course_code ?? null }, announcements: exp?.announcements, assignments: exp?.assignments }).map((s) => [s.id, s]),
  );
  const check = <T>(f: Sourced<T> | undefined, name: "name" | "date" | "location" | "topics") =>
    checkField(f && f.itemId ? { value: f.value, quote: f.quote, sourceId: f.itemId } : undefined, name, sources) as Sourced<T>;
  const dueAt = new Map((exp?.assignments ?? []).map((a) => [`assignment:${a.id}`, a.due_at ? easternIso(a.due_at) : null]));
  return exams.map((e) => {
    // The exams stage keeps a Canvas assignment's due_at as "windowCloses" (metadata, not a quote).
    const w = (e as PipelineExam & { windowCloses?: { value: string; itemId: string } | null }).windowCloses ?? null;
    return {
      id: e.id,
      name: check(e.name, "name"),
      date: check(e.date, "date"),
      location: check(e.location, "location"),
      topics: check(e.topics, "topics"),
      searched: e.searched ?? [],
      windowCloses: w && dueAt.get(w.itemId) === w.value ? w : null,
    };
  });
}

/**
 * The questions /practice serves, by lecture and module (for ?modules= and ?lecture= links).
 * `shown`: the set /practice is showing (default: the served set, pipeline output else seed).
 */
export async function loadLocalPracticeIndex(code = HOME_COURSE, shown?: PracticeSeed | null): Promise<PracticeIndexQuestion[]> {
  if (!dev()) return [];
  const [exp, lectures, seed] = await Promise.all([readJson<CourseExportLite>(join(PRIVATE(), `${code}.course.json`)), loadLectures(), shown === undefined ? servedSeed(code) : shown]);
  return practiceIndex(seed, lectures, (exp?.modules ?? []).map((m, i) => toModule(m, i, dueDates(exp))));
}

/**
 * The seed's questions with the lecture they're from (same recording URL, or, for a share link vs a
 * play link, its clips' lines are in that lecture) and the module each is on: among the modules that
 * lecture covers, the one its stem, slide deck and clip lines name most (null when it can't be told).
 */
export function practiceIndex(seed: PracticeSeed | null, lectures: LoadedLecture[], modules: HomeModuleInput[]): PracticeIndexQuestion[] {
  if (!seed?.questions?.length) return [];
  const seedLines = new Set(seed.questions.flatMap((q) => q.segments ?? []).map((s) => s.text).filter((t) => t.length >= 40));
  const lecture =
    lectures.find((l) => !!seed.recordingUrl && l.recordingUrl === seed.recordingUrl) ??
    lectures.find((l) => seedLines.size > 0 && l.lines.filter((x) => seedLines.has(x)).length >= Math.min(3, seedLines.size)) ??
    null;
  const candidatesFor = (l: LoadedLecture | null) => {
    const covered = l ? modulesForLecture(l.lines, modules) : [];
    return covered.length ? modules.filter((m) => covered.includes(m.position)) : modules;
  };
  const generated = seed.questionSet === "generated";
  const hasClip = (q: PracticeSeed["questions"][number]) => typeof (q.match as { start: number | null } | undefined)?.start === "number";
  /** The lecture whose lines the question's captions are (a share link and a play link of one recording differ). */
  const byLines = (q: PracticeSeed["questions"][number]) => {
    const mine = new Set((q.segments ?? []).map((s) => s.text).filter((t) => t.length >= 40));
    let best: LoadedLecture | null = null;
    let most = 0;
    for (const l of lectures) {
      const k = l.lines.filter((x) => mine.has(x)).length;
      if (k > most) [best, most] = [l, k];
    }
    return best;
  };
  const fromOf = (q: PracticeSeed["questions"][number]) => {
    // A generated set spans lectures: a question is from the lecture its clip is in (its own
    // recording, else the set's; else the lecture its caption lines are from), and a question with
    // no clip is from no lecture (slides only).
    if (!generated) return lecture;
    if (!hasClip(q)) return null;
    const url = q.match?.recordingUrl ?? seed.recordingUrl;
    return lectures.find((l) => !!url && l.recordingUrl === url) ?? byLines(q);
  };
  const textModule = (q: PracticeSeed["questions"][number]) =>
    questionModule([q.stem, q.match?.slide?.deck ?? "", ...(q.segments ?? []).map((s) => s.text)].join(" "), candidatesFor(fromOf(q)));
  // Generated questions come from a deck, so a deck's questions share its module: the module its
  // name names, else the one most of its questions' text names (a strict majority), else none.
  const deckModules = new Map<string, number | null>();
  const deckModule = (deck: string) => {
    if (!deckModules.has(deck)) {
      let m = questionModule(deckDisplayName(deck), modules);
      if (m === null) {
        const votes = new Map<number, number>();
        const of = seed.questions.filter((x) => x.match?.slide?.deck === deck);
        for (const x of of) {
          const v = textModule(x);
          if (v !== null) votes.set(v, (votes.get(v) ?? 0) + 1);
        }
        const [top] = [...votes].sort((a, b) => b[1] - a[1]);
        m = top && top[1] * 2 > of.length ? top[0] : null;
      }
      deckModules.set(deck, m);
    }
    return deckModules.get(deck)!;
  };
  return seed.questions.map((q) => ({
    id: q.id,
    lectureDate: fromOf(q)?.date ?? null,
    module: generated && q.match?.slide?.deck ? deckModule(q.match.slide.deck) : textModule(q),
    clip: hasClip(q),
  }));
}

const GENERIC = /^(?:module|week|unit|chapter|lesson|topic)\s*\d+[a-z]?$/i;
const PREFIXED = /^(?:module|week|unit|chapter|lesson|topic)\s*\d+[a-z]?\s*[:\-–]\s*(.+)$/i;

/** Assignment id → Eastern due date. */
function dueDates(exp: CourseExportLite | null): Map<number, string> {
  const out = new Map<number, string>();
  for (const a of exp?.assignments ?? []) {
    const d = easternDate(a.due_at);
    if (d) out.set(a.id, d);
  }
  return out;
}

/** "Module 8" names its topic in an item title ("Module 8 - Sorting"); "Module 8: Sorting" names it itself. */
function toModule(m: CanvasModule, i: number, due: Map<number, string>): HomeModuleInput {
  const name = (m.name ?? `Module ${i + 1}`).trim();
  let topic: string | null = name.match(PREFIXED)?.[1].trim() ?? null;
  if (!topic && GENERIC.test(name)) {
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-–]\\s*(.+)$`, "i");
    for (const it of m.items ?? []) {
      const hit = (it.title ?? "").trim().match(re);
      if (hit) {
        topic = hit[1].trim();
        break;
      }
    }
  }
  if (!topic && !GENERIC.test(name)) topic = name;
  const itemTitles = (m.items ?? []).map((it) => it.title ?? "").filter(Boolean);
  const dates = (m.items ?? [])
    .filter((it) => it.type === "Assignment" && typeof it.content_id === "number" && due.has(it.content_id))
    .map((it) => due.get(it.content_id!)!)
    .sort();
  return { id: String(m.id), position: typeof m.position === "number" ? m.position : i + 1, name, topic, itemTitles, dates };
}

/** The lecturer: the speaker with the most words. Other speakers' lines are left out. */
function lecturerLines(t: Transcript): string[] {
  const chars = new Map<string, number>();
  for (const s of t.segments) if (s.speaker) chars.set(s.speaker, (chars.get(s.speaker) ?? 0) + s.text.length);
  const lecturer = [...chars].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return t.segments.filter((s) => !lecturer || s.speaker === lecturer).map((s) => s.text);
}

async function loadLectures(): Promise<LoadedLecture[]> {
  const out: LoadedLecture[] = [];
  const add = (id: string, t: Transcript, recordedAt: string | null) => out.push({ id, date: easternDate(recordedAt), lines: lecturerLines(t), recordingUrl: t.recordingUrl });

  const fixture = join(PRIVATE(), "fixture.transcript.json");
  const html = join(PRIVATE(), "fixtures/zoom-recording.html");
  if (existsSync(fixture)) {
    const t = await readJson<Transcript>(fixture);
    if (t?.segments?.length) add("lecture-2026-10-22", t, t.recordedAt ?? FIXTURE_DATE);
  } else if (existsSync(html)) {
    const { toTranscript } = await import("../../scripts/spike/parse.ts");
    const t = toTranscript(await readFile(html, "utf8"), { filename: html, title: "Lecture" });
    add("lecture-2026-10-22", t, FIXTURE_DATE);
  }
  const dir = join(PRIVATE(), "lectures");
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".transcript.json")).sort() : [];
  for (const f of files) {
    const t = await readJson<Transcript>(join(dir, f));
    if (!t?.segments?.length) continue;
    const date = t.recordedAt ?? f.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
    add(`lecture-${easternDate(date) ?? f}`, t, date);
  }
  return out;
}

/** The course's Canvas modules with their topics and dated items (the import check uses them too). */
export function modulesFromExport(exp: CourseExportLite | null): HomeModuleInput[] {
  return (exp?.modules ?? []).map((m, i) => toModule(m, i, dueDates(exp)));
}
