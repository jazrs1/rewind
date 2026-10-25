// Example practice history for the judges' demo course, so the Course tape has misses to show
// before anyone has practiced. Never presented as a real student's data: every record built
// from these is `example: true` and the screens label it "Example practice history".
// Pure (the caller passes `now`).

import type { PracticeSeed, SeedQuestion } from "../demo/types.ts";
import type { NewAttempt } from "./store.ts";

/** Courses that get example history: the demo course only. */
export const DEMO_COURSES = ["COP3530"];

export function isDemoSeed(seed: { course: { code: string } }): boolean {
  return DEMO_COURSES.includes(seed.course.code.toUpperCase().replace(/\s/g, ""));
}

/** What a recorded attempt says the question is about: its demo topic, else its rewind's slide deck. */
export function attemptTopic(q: Pick<SeedQuestion, "match" | "topic">): string {
  return q.topic ?? q.match.slide.deck;
}

/** The little the example history needs from the seed (small enough to hand to the browser). */
export interface ExampleSeed {
  course: { code: string };
  questions: (Pick<SeedQuestion, "id" | "stem" | "answer" | "choices"> & { topic: string })[];
}

/** The demo seed's questions for example history, or null for any other course. */
export function exampleSeedOf(seed: Pick<PracticeSeed, "course" | "questions">): ExampleSeed | null {
  if (!isDemoSeed(seed) || !seed.questions.length) return null;
  return {
    course: { code: seed.course.code },
    questions: seed.questions.map((q) => ({ id: q.id, stem: q.stem, answer: q.answer, choices: q.choices, topic: attemptTopic(q) })),
  };
}

/** Wrong on most questions, right on a few: the pattern repeats over the seed's questions. */
const PATTERN: { correct: boolean; confidence: NewAttempt["confidence"] }[] = [
  { correct: false, confidence: "fairly-sure" },
  { correct: true, confidence: "certain" },
  { correct: false, confidence: "guessing" },
  { correct: false, confidence: "fairly-sure" },
  { correct: true, confidence: "guessing" },
];
const MAX_EXAMPLES = 6;

/**
 * A handful of plausible attempts across the seed's questions (some wrong), dated over the few
 * days before `now`. Empty unless this is the demo seed.
 */
export function exampleHistory(seed: ExampleSeed | null, now: string): NewAttempt[] {
  if (!seed || !isDemoSeed(seed) || !seed.questions.length) return [];
  const t0 = Date.parse(now);
  const n = Math.min(MAX_EXAMPLES, Math.max(seed.questions.length, 3));
  return Array.from({ length: n }, (_, i) => {
    const q = seed.questions[i % seed.questions.length];
    const p = PATTERN[i % PATTERN.length];
    const wrong = q.choices.find((c) => c.label !== q.answer)?.label ?? q.answer;
    const choice = p.correct ? q.answer : wrong;
    return {
      questionId: q.id,
      topic: q.topic,
      stem: q.stem,
      choice,
      correct: choice === q.answer,
      confidence: p.confidence,
      // Oldest first, one every 7 hours, the last a day before now.
      answeredAt: new Date(t0 - (n - 1 - i) * 7 * 3600_000 - 24 * 3600_000).toISOString(),
    };
  });
}
