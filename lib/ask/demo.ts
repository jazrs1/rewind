// The Ask tab's one course on the public demo (COP3530 only: docs/briefs/ask-tab-notes.md), built on the server from
// committed data: the demo bundle's lectures' lines, slides and questions, and its deadlines file
// (public/demo/course/deadlines.json, lib/ask/demo-deadlines.ts) when it is there. Pure: no private/ data.

import type { DemoBundle } from "../demo/bundle.ts";
import { buildDemoTape } from "../demo/tape.ts";
import { demoTutorConfig } from "../demo/tutor-config.ts";
import type { PracticeSeed } from "../demo/types.ts";
import { deadlinesFromFile, DEMO_DEADLINES_SEARCHED, DEMO_NO_DEADLINES } from "./demo-deadlines.ts";
import { cleanTitle, nicknamesOf } from "./nicknames.ts";
import { lectureWindows } from "./search.ts";
import type { AskCourse, AskPassage } from "./types.ts";

/** Demo course titles: the bundle names it by its Canvas name ("COP3530 - Fa26"); the student knows it as this. */
const DEMO_TITLE = "Data Structures and Algorithms";

function seedMaterial(seed: Pick<PracticeSeed, "questions">, lecture: string, date: string | null): AskPassage[] {
  const seen = new Set<number>();
  const lines = seed.questions
    .flatMap((q) => q.segments)
    .filter((s) => !seen.has(s.start) && !!seen.add(s.start))
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ start: s.start, end: s.end, text: s.text }));
  const slides = new Map<string, AskPassage>();
  for (const q of seed.questions) {
    const s = q.match.slide;
    const text = q.source?.quote ?? "";
    if (!text || s.revealsAnswer) continue;
    const key = `${s.deck}#${s.page}`;
    if (!slides.has(key)) slides.set(key, { kind: "slide", deck: s.deck, page: s.page, pageKind: s.kind ?? "slide", text, href: s.image ? `/${s.image.replace(/^\//, "")}` : null, image: s.image || undefined });
  }
  return [...lectureWindows(lecture, date, lines), ...slides.values()];
}

/** `deadlines`: the parsed deadlines.json, or null while it isn't in the bundle. */
export function demoAskCourses(bundle: DemoBundle, deadlines: unknown = null): AskCourse[] {
  const sets = [...bundle.sets].sort((a, b) => a.id.localeCompare(b.id));
  const questions = sets.flatMap((s) => s.seed.questions);
  const seed: PracticeSeed = { ...sets[0].seed, course: bundle.course, set: "Demo course", questions };
  const media: Record<string, { src: string; offset: number; end?: number }> = {};
  for (const s of sets) for (const h of s.hosted) media[h.questionId] = { src: h.src, offset: h.offset, end: h.end };
  const title = cleanTitle(bundle.course.name, bundle.course.code) || DEMO_TITLE;
  const named = title === bundle.course.code || title.length < 6 ? DEMO_TITLE : title;
  return [
    {
      id: bundle.course.code,
      code: bundle.course.code,
      title: named,
      nicknames: nicknamesOf(bundle.course.code, named, bundle.lecturer.short),
      lecturer: bundle.lecturer.short,
      shell: 1,
      deadlines: deadlinesFromFile(deadlines),
      searched: deadlines ? DEMO_DEADLINES_SEARCHED : DEMO_NO_DEADLINES,
      material: sets.flatMap((s) => seedMaterial(s.seed, `lecture-${s.id}`, s.id)),
      bank: { seed, gradedIds: [], tape: buildDemoTape(bundle).tape, moments: demoTutorConfig(bundle).moments, media },
      studyHref: "/demo/study",
      practiceHref: "/demo/practice",
    },
  ];
}

