// The study session's topics rail: the exam's coverage topics from the Course tape, each with the tape's own heat
// (glow = your professor flagged it, ✕n = you missed n) and module colour, in priority order: stressed × missed (the route
// back's product), then stressed, then missed, then tape order; topics not taught yet go last. Pure: it takes the
// tape the page already has (with the student's practice merged in, lib/course/attempts.ts) and which questions the
// server says are graded.

import { glowLevel } from "../course/geometry.ts";
import type { CourseTape, Stop } from "../course/types.ts";

export interface StudyTopic {
  id: string;
  name: string;
  /** The module's tape colour, as on the Course tape (var(--color-tape-n)); a stop with no module gets label-muted. */
  shell: string;
  /** Glow strength 0..5, the Course tape's glowLevel. */
  glow: number;
  stressed: number;
  missed: number;
  /** The missed ring's strength 0..1 (the tape's missed heat). */
  missedHeat: number;
  /** Practice answers on it, and how many were wrong. */
  tried: number;
  wrong: number;
  taught: string | null;
  ahead: boolean;
  /** stressed × missed. */
  priority: number;
  /** The question the tutor talks about for this topic (graded first when the topic is graded). */
  anchorId: string;
  questionIds: string[];
  /** Any of its questions is graded work (decided on the server): integrity mode while it is in focus. */
  graded: boolean;
}

/** The module colours in course order, exactly as the Course tape picks them (components/course/shared.ts shellOf). */
export function shellOfTape(tape: CourseTape): (s: Stop) => string {
  const order = [...new Set(tape.stops.filter((s) => s.module).sort((a, b) => a.module!.position - b.module!.position).map((s) => s.module!.id))];
  return (s) => (s.module ? `var(--color-tape-${(order.indexOf(s.module.id) % 4) + 1})` : "var(--color-label-muted)");
}

export function studyTopics(tape: CourseTape, questionIds: Iterable<string>, gradedIds: Iterable<string>): StudyTopic[] {
  const known = new Set(questionIds);
  const graded = new Set(gradedIds);
  const shell = shellOfTape(tape);
  const topics = tape.stops
    .filter((s) => s.onNextExam !== false)
    .map((s): StudyTopic | null => {
      const ids = s.practiceIds.filter((id) => known.has(id));
      if (!ids.length) return null;
      const g = ids.filter((id) => graded.has(id));
      const practice = s.missed.evidence.filter((e) => e.kind === "practice");
      return {
        id: s.id,
        name: s.topic,
        shell: shell(s),
        glow: glowLevel(s.stressed.heat, s.stressed.score),
        stressed: s.stressed.score,
        missed: s.missed.score,
        missedHeat: s.missed.heat,
        tried: practice.length,
        wrong: practice.filter((e) => e.points > 0).length,
        taught: s.firstTaughtAt,
        ahead: s.state === "future",
        priority: Math.round(s.stressed.score * s.missed.score * 100) / 100,
        anchorId: g[0] ?? ids[0],
        questionIds: ids,
        graded: g.length > 0,
      };
    })
    .filter((t): t is StudyTopic => t !== null);
  const order = new Map(tape.stops.map((s) => [s.id, s.order]));
  return topics.sort(
    (a, b) => Number(a.ahead) - Number(b.ahead) || b.priority - a.priority || b.stressed - a.stressed || b.missed - a.missed || order.get(a.id)! - order.get(b.id)!,
  );
}

/** "in 6 days", "tomorrow", "today", or null when the date isn't known. */
export function daysText(days: number | null): string | null {
  if (days === null || days < 0) return null;
  return days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}
