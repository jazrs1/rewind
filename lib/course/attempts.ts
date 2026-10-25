// Merges the student's practice attempts (kept in the browser, lib/attempts/store.ts) into a
// course tape the server already built. Pure: the same rules as buildCourseTape for "missed"
// (one wrong answer = WEIGHTS.practiceWrong, evidence with the question text), then the heat and
// the route back are recomputed. Example attempts carry `example: true` on their evidence so the
// screen can label them.

import { practiceEvidence, routeSteps, routeTotals, toScore } from "./build.ts";
import { bestTopic, topicIndex, topicsIn } from "./topics.ts";
import type { CourseTape, Evidence, Stop } from "./types.ts";

/** What the tape needs from a stored attempt. */
export interface TapeAttempt {
  questionId: string;
  /** The rewind's slide deck ("7 - Sets, Maps, HashTables") or another topic name. */
  topic: string;
  stem: string | null;
  correct: boolean;
  answeredAt: string;
  example: boolean;
}

const deckName = (label: string) => label.replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();

/** The stop an attempt belongs to: the stop holding its slide deck, else the topic it names. */
export function stopForAttempt(stops: Stop[], a: Pick<TapeAttempt, "topic" | "stem">): string | null {
  const deck = a.topic.trim().toLowerCase();
  const byDeck = stops.find((s) => s.slides.some((f) => deckName(f.label) === deck));
  if (byDeck) return byDeck.id;
  const idx = topicIndex(stops.map((s) => ({ key: s.id, topic: s.topic })));
  return topicsIn(a.topic, idx)[0] ?? bestTopic(`${a.topic} ${a.stem ?? ""}`, idx, 1)?.key ?? null;
}

/** True when any example attempt contributes to the tape (a stop's missed evidence or unplaced). */
export function hasExampleEvidence(tape: CourseTape): boolean {
  return tape.stops.some((s) => s.missed.evidence.some((e) => e.example)) || tape.unplaced.some((e) => e.example);
}

export function mergeAttempts(tape: CourseTape, attempts: TapeAttempt[]): CourseTape {
  if (!attempts.length) return tape;
  const added = new Map<string, Evidence[]>();
  const unplaced = [...tape.unplaced];
  for (const a of attempts) {
    const ev = practiceEvidence(a.stem, a);
    const key = stopForAttempt(tape.stops, a);
    if (key) added.set(key, [...(added.get(key) ?? []), ev]);
    else unplaced.push(ev);
  }
  const missedEv = new Map(tape.stops.map((s) => [s.id, [...s.missed.evidence, ...(added.get(s.id) ?? [])]]));
  const maxMiss = Math.max(0, ...[...missedEv.values()].map((ev) => toScore(ev, 0).score));
  const stops: Stop[] = tape.stops.map((s) => ({ ...s, missed: toScore(missedEv.get(s.id)!, maxMiss) }));

  // Same pool as the server's route: the next exam's stops when its coverage is known.
  const covered = tape.route.basis === "next-exam" ? new Set(stops.filter((s) => s.onNextExam === true).map((s) => s.id)) : null;
  const steps = routeSteps(stops, covered);
  const { listenSec, questions } = routeTotals(steps);
  return {
    ...tape,
    stops,
    route: { ...tape.route, steps },
    totals: { ...tape.totals, listenSec, questions },
    unplaced,
  };
}
