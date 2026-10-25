// What the study session page is given, built on the server. Which questions are graded (and so which topics are in
// integrity mode) is decided here, from the course data (lib/tutor/graded.ts), never by the page.
//   - dev (/study): the local Course tape, practice set and course home; or, for ?set=e2e-fixture|e2e-graded|e2e-mixed,
//     the invented e2e course. Dev only, like /practice.
//   - demo (/demo/study): the demo bundle's tape and questions, its hosted clips, and the public demo tutor (which is
//     never graded and always keeps to the question it is asked about).

import type { TutorConfig } from "../../components/tutor/types.ts";
import { exampleSeedOf, type ExampleSeed } from "../attempts/examples.ts";
import { courseKey } from "../attempts/store.ts";
import { loadLocalCourseTape } from "../course/local.ts";
import type { CourseTape } from "../course/types.ts";
import type { DemoBundle } from "../demo/bundle.ts";
import { isDemoMode } from "../demo/guard.ts";
import { loadLocalSeed } from "../demo/load.ts";
import { tapeFromSets, type DemoTape } from "../demo/tape.ts";
import { demoTutorConfig } from "../demo/tutor-config.ts";
import type { PracticeSeed } from "../demo/types.ts";
import { loadLocalHome } from "../home/local.ts";
import { fixtureOutput } from "../pipeline/fixtures/practice-real.ts";
import { loadPracticeSeed } from "../pipeline/practice-seed.ts";
import type { TutorScope } from "../prompts/tutor.ts";
import { loadTutorConfig } from "../tutor/config.ts";
import { daysText, studyTopics } from "./topics.ts";

export interface StudyConfig {
  course: { code: string; name: string };
  /** "Exam 2 topics". */
  title: string;
  /** Under the title: "Exam 2 · in 6 days", or what is known instead. */
  examLine: string;
  /** What the session is for, in the study topic rule ("Exam 2"). */
  examName: string;
  tape: CourseTape;
  examples: ExampleSeed | null;
  /** Every question the session can talk about (one seed, all lectures). */
  seed: PracticeSeed;
  /** The tutor: its route (dev: /api/tutor/study, which keeps to the exam's topics; demo: the public demo route). */
  tutor: TutorConfig;
  /** Hosted clips by question id (the demo's), played in place in the chat. */
  media: Record<string, { src: string; offset: number; end?: number }>;
  /** Back: the practice page these questions are from. */
  backHref: string;
  demo: boolean;
}

export const STUDY_SETS = ["e2e-fixture", "e2e-graded", "e2e-mixed"];

const DAY = 86_400_000;
const daysUntil = (iso: string, now: string) => Math.ceil((Date.parse(iso) - Date.parse(now)) / DAY);

/** The invented e2e course as lectures: lecture A (Oct 1) and B (Oct 3), as /practice's fixture says. */
function fixtureTape(seed: PracticeSeed): DemoTape {
  const lectureOf = (q: PracticeSeed["questions"][number]) => ((q.match.recordingUrl ?? seed.recordingUrl).includes("lecture-b") ? "2026-10-03" : "2026-10-01");
  const ids = [...new Set(seed.questions.map(lectureOf))];
  return tapeFromSets(seed.course, ids.map((id) => ({ id, seed: { questions: seed.questions.filter((q) => lectureOf(q) === id) } })), seed.lecturer.short);
}

export async function loadStudyConfig(params: { set?: string | string[]; exam?: string | string[] }, now = new Date().toISOString()): Promise<StudyConfig | null> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  const set = typeof params.set === "string" ? params.set : undefined;
  const seed = await loadPracticeSeed(set);
  if (!seed) return null;
  const tutor = await loadTutorConfig(seed, { set });
  if (!tutor) return null;
  const backHref = `/practice${set ? `?set=${encodeURIComponent(set)}` : ""}`;
  const base = { course: seed.course, seed, tutor: { ...tutor, endpoint: "/api/tutor/study" }, media: {}, backHref, demo: false };
  if (set && STUDY_SETS.includes(set)) {
    const exam = fixtureOutput.exams[0];
    const date = exam.date.value;
    const when = date ? daysText(daysUntil(date, now)) : null;
    const { tape, examples } = fixtureTape(seed);
    return { ...base, title: `${exam.name.value} topics`, examLine: `${exam.name.value}${when ? ` · ${when}` : " · date not found"}`, examName: exam.name.value ?? "the exam", tape, examples };
  }
  const [tape, home, local] = await Promise.all([loadLocalCourseTape(now), loadLocalHome(now, seed.course.code).catch(() => null), loadLocalSeed()]);
  if (!tape) return null;
  const wanted = typeof params.exam === "string" ? params.exam : null;
  const quiz = home?.quiz && (!wanted || home.quiz.exam.id === wanted) ? home.quiz : null;
  const countdown = home?.countdown;
  const exam = quiz?.exam ?? countdown?.exam ?? null;
  const days = quiz ? quiz.days : countdown?.kind === "days" ? countdown.days : null;
  const name = exam?.title ?? "The next exam";
  const when = daysText(days);
  const examples = local && courseKey(local.course.code) === courseKey(tape.course.code) ? exampleSeedOf(local) : null;
  return { ...base, title: `${name} topics`, examLine: `${name}${when ? ` · ${when}` : " · date not found"}`, examName: name, tape, examples };
}

export function demoStudyConfig(bundle: DemoBundle, demo: DemoTape): StudyConfig {
  const questions = [...bundle.sets].sort((a, b) => a.id.localeCompare(b.id)).flatMap((s) => s.seed.questions);
  const first = bundle.sets[0].seed;
  const seed: PracticeSeed = { ...first, course: bundle.course, set: "Demo course", questions };
  const media: StudyConfig["media"] = {};
  for (const s of bundle.sets) for (const h of s.hosted) media[h.questionId] = { src: h.src, offset: h.offset, end: h.end };
  return {
    course: bundle.course,
    title: "Demo course topics",
    examLine: `${bundle.sets.length} lectures · the demo has no exam date`,
    examName: "the demo course",
    tape: demo.tape,
    examples: demo.examples,
    seed,
    tutor: demoTutorConfig(bundle),
    media,
    backHref: "/demo/practice",
    demo: true,
  };
}

/**
 * The dev study route's topic rule: the exam's coverage topics as the Course tape lists them, from the server's own
 * data (never from the request).
 */
export async function studyScope(set: string | undefined): Promise<TutorScope | null> {
  const c = await loadStudyConfig({ set });
  if (!c) return null;
  const topics = studyTopics(c.tape, c.seed.questions.map((q) => q.id), c.tutor.gradedIds).map((t) => t.name);
  return { kind: "study", name: c.examName, topics };
}
