"use client";

// React side of the attempt store: a hook that re-renders on every change, and the one call the
// practice screen makes when an answer is graded.

import { useCallback, useSyncExternalStore } from "react";
import type { PracticeSeed, SeedQuestion } from "../demo/types.ts";
import type { ChoiceLabel, Confidence } from "../schema.ts";
import { attemptTopic } from "./examples.ts";
import { attemptStore, emptyAttempts, type AttemptRecord } from "./store.ts";

/** The course's stored attempts; empty on the server and in the first client render. */
export function useAttempts(course: string): AttemptRecord[] {
  const store = attemptStore(course);
  const subscribe = useCallback((fn: () => void) => store.subscribe(fn), [store]);
  return useSyncExternalStore(subscribe, store.list, emptyAttempts);
}

/** Saves a graded answer on this device (and drops any example history). */
export function recordAttempt(seed: PracticeSeed, q: SeedQuestion, choice: ChoiceLabel, confidence: Confidence | null): void {
  attemptStore(seed.course.code).add({
    questionId: q.id,
    // A Quick build question is the student's own course text: its bank stays on the device, so the record names no
    // part of it (no stem, no deck or page title); Accounts Lite takes the id, the choice and whether it was right.
    topic: q.quick ? "Quick build" : attemptTopic(q),
    stem: q.quick ? null : q.stem,
    choice,
    correct: choice === q.answer,
    confidence,
    answeredAt: new Date().toISOString(),
  });
}
