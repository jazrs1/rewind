// The demo course's Course tape, built from the demo bundle only (no private/ data): one stop per lecture
// and topic (each question's topic is from its slide's title, lib/demo/topics.ts), the lecture lines the
// bundle has (the clips behind its questions), and its questions as practice with their clips. Each stop
// keeps its lecture's date and its questions' clip times. "Missed" starts from the example practice
// history (lib/attempts/examples.ts), labelled "Example practice history" on screen, until the visitor answers.

import { exampleSeedOf, type ExampleSeed } from "../attempts/examples.ts";
import { buildCourseTape, routeSteps, routeTotals } from "../course/build.ts";
import type { ClipContext, CourseTape, CourseTapeInputs, DerivedTopic, LectureInput } from "../course/types.ts";
import type { DemoBundle } from "./bundle.ts";
import { derivedTopics } from "./topic-stats.ts";
import type { PracticeSeed, SeedQuestion } from "./types.ts";

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** A topic's Course tape stop id ("Load factor & rehashing" → "load-factor-rehashing"), as topic-stats.json names it. */
export const stopIdOf = slugOf;

/** "Discussion 8 - Sorting" / "6 - Sorting" → "Sorting". */
const deckTopic = (deck: string) => deck.replace(/^\s*(?:discussion\s+)?\d{1,2}[a-z]?\s*[-–]\s*/i, "").trim();

/** A lecture's topic when its questions have none: its most used numbered lecture deck (not a discussion), by question count, ties by name. */
function lectureTopic(decks: string[]): string {
  const count = new Map<string, number>();
  for (const d of decks) if (!/^\s*discussion\b/i.test(d)) count.set(d, (count.get(d) ?? 0) + 1);
  const best = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? decks[0];
  return deckTopic(best);
}

/** A lecture's questions by topic, topics in the order the lecture reaches them (first clip start). */
function topicGroups(s: LectureSet): { id: string; topic: string; questions: SeedQuestion[] }[] {
  const fallback = lectureTopic(s.seed.questions.map((q) => q.match.slide.deck));
  const by = new Map<string, SeedQuestion[]>();
  for (const q of s.seed.questions) {
    const topic = q.topic ?? fallback;
    by.set(topic, [...(by.get(topic) ?? []), q]);
  }
  const first = (qs: SeedQuestion[]) => Math.min(...qs.map((q) => q.match.start));
  return [...by]
    .sort((a, b) => first(a[1]) - first(b[1]) || a[0].localeCompare(b[0]))
    .map(([topic, questions]) => ({ id: `${s.id}-${slugOf(topic)}`, topic, questions }));
}

export const DEMO_TAPE_NOTE =
  "Demo course: the lectures here hold only the moments behind its practice questions, so minutes of lecture count those moments, not the whole class.";
/** The note when topic-stats.json is there: its minutes and flags are the whole class's. */
export const DEMO_TAPE_STATS_NOTE =
  "Demo course: the lectures here hold only the moments behind its practice questions; minutes of lecture and flags are counted on the full recordings.";

export interface DemoTape {
  tape: CourseTape;
  clips: Record<string, ClipContext>;
  /** Hosted clips by tape clip id (lectureId@start). */
  media: Record<string, { src: string; offset: number }>;
  examples: ExampleSeed | null;
}

export function buildDemoTape(bundle: DemoBundle): DemoTape {
  // topic-stats.json names stops by id; the tape takes derived numbers by topic name.
  const names = new Map(bundle.sets.flatMap((s) => s.seed.questions.flatMap((q) => (q.topic ? [[slugOf(q.topic), q.topic] as const] : []))));
  return tapeFromSets(bundle.course, bundle.sets, bundle.lecturer.short, bundle.stats ? derivedTopics(bundle.stats, names) : undefined);
}

/** A practice set as one lecture: its date (YYYY-MM-DD) as the id, its questions, and its hosted clips. */
export interface LectureSet {
  id: string;
  seed: Pick<PracticeSeed, "questions">;
  /** The hosted questions (file there or not): the set's first questions, in order. */
  hostedIds?: string[];
  /** The hosted clips whose file is there. */
  hosted?: { questionId: string; src: string; offset: number }[];
}

/**
 * The Course tape of a course known only by its practice sets, one set per lecture (the demo bundle; the study session's
 * invented e2e course): one module per lecture and topic (a lecture whose questions have no topic is one module), the
 * lecture lines its questions carry, its questions as practice; `derived`: numbers from the full recordings (topic-stats.json).
 */
export function tapeFromSets(course: { code: string; name: string }, input: LectureSet[], lecturer: string, derived?: DerivedTopic[]): DemoTape {
  const sets = [...input].sort((a, b) => a.id.localeCompare(b.id));
  // One tape input per lecture and topic, named as its stop's module, so nothing is placed by keyword guessing.
  const groups = sets.flatMap((s) => topicGroups(s).map((g) => ({ ...g, set: s })));
  const lectureOf = new Map(groups.flatMap((g) => g.questions.map((q) => [q.id, `lecture-${g.id}`] as const)));
  const lectures: LectureInput[] = groups.map((g) => {
    const seen = new Set<string>();
    const segments = g.questions
      .flatMap((q) => q.segments)
      .filter((x) => !seen.has(`${x.start}`) && !!seen.add(`${x.start}`))
      .sort((a, b) => a.start - b.start);
    return {
      id: `lecture-${g.id}`,
      title: "Lecture",
      recordedAt: `${g.set.id}T17:50:00Z`,
      recordingUrl: "",
      durationSec: Math.ceil(segments.at(-1)?.end ?? 0),
      lecturer: null,
      segments,
      // Only the clips behind its questions are here, not the class: their minutes don't count toward "stressed".
      clipOnly: true,
      moduleId: `demo-${g.id}`,
    };
  });
  const last = sets.at(-1)!.id;
  const inputs: CourseTapeInputs = {
    course,
    // The day after the last lecture, so every lecture is taught and the tape is the same on every build.
    now: new Date(Date.parse(`${last}T16:00:00Z`) + 86_400_000).toISOString(),
    modules: groups.map((g, i) => ({
      id: `demo-${g.id}`,
      name: g.topic,
      position: i + 1,
      itemTitles: [...new Set(g.questions.map((q) => q.match.slide.deck))].sort(),
      from: "lecture" as const,
    })),
    items: [],
    lectures,
    radar: [],
    practice: groups.flatMap((g) =>
      g.questions.map((q) => ({
        id: q.id,
        text: q.stem,
        topic: g.topic,
        lectureId: `lecture-${g.id}`,
        moduleId: `demo-${g.id}`,
        clip: { start: q.match.start, end: q.match.end, slide: { deck: q.match.slide.deck, page: q.match.slide.page }, setup: q.match.setup, exampleStart: null },
        attempts: null,
      })),
    ),
    grades: [],
    announcements: [],
    exams: [],
    nextExam: null,
    notes: [derived?.length ? DEMO_TAPE_STATS_NOTE : DEMO_TAPE_NOTE],
    ...(derived?.length ? { derived } : {}),
  };
  const built = buildCourseTape(inputs);
  // A stop's hosted-clip questions (file there or not: the set's first questions, in order) lead it, so a stop and the
  // route play them first. A set with no hosted list leads with its first question.
  const hostedRank = new Map<string, number>(
    sets.flatMap((s) => s.seed.questions.slice(0, s.hostedIds?.length ?? 1).map((q, i) => [`${lectureOf.get(q.id)}@${q.match.start}`, i] as const)),
  );
  const rank = (id: string) => hostedRank.get(id) ?? Number.MAX_SAFE_INTEGER;
  const stops = built.stops.map((s) => ({ ...s, clips: [...s.clips].sort((a, b) => rank(a.id) - rank(b.id)) }));
  const steps = routeSteps(stops, null);
  // The tape inputs are one per topic; the course has one lecture per set.
  const tape: CourseTape = { ...built, stops, route: { ...built.route, steps }, totals: { ...built.totals, lectures: sets.length, ...routeTotals(steps) } };

  const byLecture = new Map(lectures.map((l) => [l.id, l]));
  const hostedBy = new Map<string, { src: string; offset: number }>(sets.flatMap((s) => (s.hosted ?? []).map((h) => [`${lectureOf.get(h.questionId)}@${h.offset}`, h] as const)));
  const clips: Record<string, ClipContext> = {};
  const media: Record<string, { src: string; offset: number }> = {};
  for (const c of [...tape.stops.flatMap((s) => s.clips), ...tape.route.steps.flatMap((s) => (s.play.kind === "clip" ? [s.play.clip] : []))]) {
    const l = byLecture.get(c.lectureId);
    if (!l) continue;
    clips[c.id] = { segments: l.segments.filter((g) => g.start >= c.start && g.start < c.end), lecturer };
    const h = hostedBy.get(c.id);
    if (h) media[c.id] = { src: h.src, offset: h.offset };
  }

  // Example history spread over the lectures: their questions taken in turn.
  const rounds = Math.max(...sets.map((s) => s.seed.questions.length));
  const questions = Array.from({ length: rounds }, (_, i) => sets.flatMap((s) => (s.seed.questions[i] ? [s.seed.questions[i]] : []))).flat();
  return { tape, clips, media, examples: exampleSeedOf({ course, questions }) };
}
