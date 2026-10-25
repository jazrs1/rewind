// The graded assignment a practice session is for (the course home's next quiz): its name, topics and due
// date, from the same data the home already loads. Dev only (local course data). Anything that names an
// assignment makes the session graded, whether or not it resolves, so the safe mode is the default.

import { isDemoMode } from "../demo/guard.ts";
import { loadLocalHome } from "../home/local.ts";
import type { HomeExam } from "../home/types.ts";

export interface Assignment {
  id: string;
  /** "Quiz 8". */
  name: string;
  /** "Heaps, Sorting", or null when the course doesn't say. */
  topics: string | null;
  /** "Oct 30" (the home's date, without the time), or null. */
  due: string | null;
}

/** The invented quiz the e2e tests use at /practice?set=e2e-fixture&graded=e2e-quiz. */
export const E2E_QUIZ: Assignment = { id: "e2e-quiz", name: "Fake Quiz 8", topics: "Heaps and hashing", due: "Oct 30" };

export function assignmentOfExam(exam: HomeExam): Assignment {
  const due = exam.date.state === "found" ? exam.date.text.split(",")[0] : null;
  return { id: exam.id, name: exam.title, topics: exam.topics.state === "found" ? exam.topics.text : null, due };
}

export async function loadAssignment(id: string, now = new Date().toISOString()): Promise<Assignment> {
  const unknown: Assignment = { id, name: "this assignment", topics: null, due: null };
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return unknown;
  if (id === E2E_QUIZ.id) return E2E_QUIZ;
  const home = await loadLocalHome(now);
  const exam = [home?.quiz?.exam, home?.countdown.exam].find((e) => e?.id === id);
  return exam ? assignmentOfExam(exam) : unknown;
}
