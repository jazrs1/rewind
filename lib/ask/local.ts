// The courses on this device, for the Ask tab, from the local private/ folder. Dev only, like lib/home/local.ts:
// real course data never goes into a production build or demo mode. A course is any code with a Canvas export
// (private/<CODE>.course.json) or a pipeline run (private/pipeline/<CODE>/). For each:
//   - deadlines: the export's assignments, quizzes and calendar events, and the pipeline's exams with each field
//     re-checked against its quote (checkedExams); an exam's date counts only with its quote;
//   - material: the pipeline's transcripts and extracted slides/pages (transcripts.json, docs.json), the export's
//     Canvas pages; COP3530 also gets the local lecture transcripts the Course tape reads;
//   - the question bank: the pipeline's practice set (else the local seed when it is this course's), which of its
//     questions are graded (lib/tutor/graded.ts) and, for the course the tape is built for, the Course tape.
// The page gets this as data; the tools run over it in the browser, and nothing of it is sent anywhere but the model
// call that needs it.

// Never in a client bundle: importing this from a "use client" file fails the build.
import "server-only";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDemoMode } from "../demo/guard.ts";
import { loadLocalSeed } from "../demo/load.ts";
import type { PracticeSeed } from "../demo/types.ts";
import { loadLocalCourseTape, loadLocalInputs } from "../course/local.ts";
import { sourceLabel } from "../home/build.ts";
import { checkedExams, HOME_COURSE, loadLocalHome } from "../home/local.ts";
import { COURSE_CODE } from "../pipeline/private-fs.ts";
import { fixtureSeed, loadPipelineSeed } from "../pipeline/practice-seed.ts";
import type { ExtractedDoc, PipelineExam, PipelineTranscript } from "../pipeline/types.ts";
import { gradedScope } from "../tutor/graded.ts";
import { loadTutorConfig } from "../tutor/config.ts";
import { buildDeadlines } from "./deadlines.ts";
import { ASK_SETS, fixtureAskCourses } from "./fixture.ts";
import { cleanTitle, nicknamesOf } from "./nicknames.ts";
import { lectureWindows } from "./search.ts";
import type { AskBank, AskCourse, AskPassage } from "./types.ts";

const PRIVATE = () => join(process.cwd(), "private");

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

type Export = {
  course: { id?: number; name?: string | null; course_code?: string | null };
  assignments?: Record<string, unknown>[];
  quizzes?: Record<string, unknown>[];
  calendar_events?: Record<string, unknown>[];
  announcements?: { id: number; title?: string; posted_at?: string | null }[];
  pages?: { url: string; title?: string; body?: string | null }[];
};

/** The codes with local data, in a stable order. */
async function localCodes(): Promise<string[]> {
  const codes = new Set<string>();
  const root = PRIVATE();
  if (!existsSync(root)) return [];
  for (const f of await readdir(root).catch(() => [] as string[])) {
    const m = f.match(/^([A-Z0-9]{1,32})\.course\.json$/);
    if (m) codes.add(m[1]);
  }
  const pipe = join(root, "pipeline");
  if (existsSync(pipe)) for (const d of await readdir(pipe).catch(() => [] as string[])) if (COURSE_CODE.test(d)) codes.add(d);
  return [...codes].sort();
}

const stripHtml = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** The lecturer's lines of a transcript (the speaker with the most words). */
function lecturerLines(t: { segments: { start: number; end: number; speaker?: string | null; text: string }[] }) {
  const chars = new Map<string, number>();
  for (const s of t.segments) if (s.speaker) chars.set(s.speaker, (chars.get(s.speaker) ?? 0) + s.text.length);
  const lecturer = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return t.segments.filter((s) => !lecturer || s.speaker === lecturer).map((s) => ({ start: s.start, end: s.end, text: s.text }));
}
const easternDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : null);

export async function loadLocalAskCourses(now = new Date().toISOString()): Promise<AskCourse[] | null> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  const codes = await localCodes();
  const localSeed = await loadLocalSeed();
  if (localSeed && !codes.includes(localSeed.course.code.replace(/\s+/g, "").toUpperCase())) codes.push(localSeed.course.code.replace(/\s+/g, "").toUpperCase());
  if (!codes.length) return null;
  // /study and /practice serve one course (REWIND_COURSE, default COP3530): only its items open a study session.
  const served = process.env.REWIND_COURSE ?? HOME_COURSE;
  const courses: AskCourse[] = [];
  for (const [i, code] of codes.entries()) {
    const dir = join(PRIVATE(), "pipeline", code);
    const [exp, examsFile, docs, transcripts] = await Promise.all([
      readJson<Export>(join(PRIVATE(), `${code}.course.json`)),
      readJson<PipelineExam[] | { exams: PipelineExam[] }>(join(dir, "exams.json")),
      readJson<ExtractedDoc[]>(join(dir, "docs.json")),
      readJson<PipelineTranscript[]>(join(dir, "transcripts.json")),
    ]);
    const seed: PracticeSeed | null = (await loadPipelineSeed(code)) ?? (localSeed && localSeed.course.code.replace(/\s+/g, "").toUpperCase() === code ? localSeed : null);
    const studyHere = code === served && !!seed;
    const home = studyHere ? await loadLocalHome(now, code).catch(() => null) : null;
    const homeExamIds = new Set([home?.quiz?.exam.id, home?.countdown?.exam?.id].filter((x): x is string => !!x));
    const exams = checkedExams(Array.isArray(examsFile) ? examsFile : (examsFile?.exams ?? []), docs ?? [], exp ? { course: { id: exp.course.id, name: exp.course.name, course_code: exp.course.course_code }, announcements: exp.announcements as never, assignments: exp.assignments as never } : null);
    const { deadlines, searched } = buildDeadlines({
      assignments: exp?.assignments,
      quizzes: exp?.quizzes,
      calendar_events: exp?.calendar_events,
      exams: exams.map((e) => ({
        id: e.id,
        name: e.name.value,
        date: e.date.value,
        quote: e.date.quote,
        source: e.date.itemId ? (e.searched.find((s) => s.itemId === e.date.itemId) ? sourceLabel(e.searched.find((s) => s.itemId === e.date.itemId)!) : "course material") : null,
        searched: e.searched.map(sourceLabel),
      })),
      hrefOf: (d, examId) => (!studyHere ? null : examId && homeExamIds.has(examId) ? `/study?exam=${encodeURIComponent(examId)}` : d.kind === "exam" || d.kind === "quiz" ? "/study" : null),
    });
    if (!exp) searched.push("no Canvas export on this device");

    const material: AskPassage[] = [];
    for (const t of transcripts ?? []) material.push(...lectureWindows(t.id, easternDay(t.recordedAt), lecturerLines(t)));
    if (code === HOME_COURSE && !transcripts?.length) {
      const inputs = await loadLocalInputs(now).catch(() => null);
      for (const l of inputs?.lectures ?? []) material.push(...lectureWindows(l.id, easternDay(l.recordedAt), lecturerLines(l)));
    }
    for (const d of docs ?? []) {
      if (d.itemId.startsWith("announcement:") || d.itemId.startsWith("assignment:")) continue;
      for (const p of d.pages) if (p.text?.trim()) material.push({ kind: "slide", deck: d.name, page: p.page, pageKind: d.role === "lecture" ? "slide" : "page", text: p.text, href: null });
    }
    for (const p of exp?.pages ?? []) if (p.body && !(docs ?? []).some((d) => d.itemId === `page:${p.url}`)) material.push({ kind: "page", title: p.title ?? p.url, text: stripHtml(p.body), href: null });

    let bank: AskBank | null = null;
    if (seed) {
      const scope = await gradedScope(seed, undefined, now);
      const tutor = await loadTutorConfig(seed, {}).catch(() => null);
      bank = {
        seed,
        gradedIds: seed.questions.filter((q) => scope.isGraded(q.id)).map((q) => q.id),
        tape: code === HOME_COURSE ? await loadLocalCourseTape(now).catch(() => null) : null,
        moments: tutor?.moments ?? {},
        media: {},
      };
    }
    const rawTitle = (seed?.course.code.replace(/\s+/g, "").toUpperCase() === code && seed.course.name) || exp?.course.name || code;
    const title = cleanTitle(rawTitle, code) || rawTitle;
    const lecturer = seed?.lecturer.short ?? null;
    courses.push({
      id: code,
      code,
      title,
      nicknames: nicknamesOf(code, title, lecturer),
      lecturer,
      shell: ((i % 4) + 1) as 1 | 2 | 3 | 4,
      deadlines,
      searched,
      material,
      bank,
      studyHref: studyHere ? "/study" : null,
      practiceHref: studyHere ? "/practice" : null,
    });
  }
  return courses;
}

/** What /ask shows: the invented e2e set (?set=e2e-ask, dated around now), else the courses on this device. Dev only. */
export async function loadAskCourses(set: string | undefined): Promise<AskCourse[] | null> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  if (set && ASK_SETS.includes(set)) {
    const seed = fixtureSeed();
    return seed ? fixtureAskCourses(seed, Date.now()) : null;
  }
  return loadLocalAskCourses();
}
