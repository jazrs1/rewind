// Which practice questions are graded work, decided on the server (never by a flag the browser sends).
// A question is graded when it falls in the open assignment's scope: the course home's next quiz (its found
// topics name modules; a question on one of those modules, or one whose module can't be told, is graded).
// When the course data can't say (no home, an error, an assignment whose modules aren't known), everything
// is graded: unknown = graded. With no open assignment at all, it is practice.
//
// The e2e tests use the invented fixture: /practice?set=e2e-fixture is plain practice, ?set=e2e-graded is the
// same questions under an open invented quiz, ?set=e2e-mixed has lecture B's questions under it and lecture A's as
// practice (the set name picks the fixture, nothing else).

import type { PracticeSeed } from "../demo/types.ts";
import { loadLocalHome, loadLocalPracticeIndex } from "../home/local.ts";
import { assignmentOfExam, E2E_QUIZ, type Assignment } from "./assignment.ts";

export interface GradedScope {
  /** The open assignment, when there is one (or "this assignment" when graded but unknown). */
  assignment: Assignment | null;
  isGraded(questionId: string): boolean;
}

const UNKNOWN: Assignment = { id: "unknown", name: "this assignment", topics: null, due: null };
const allGraded = (assignment: Assignment = UNKNOWN): GradedScope => ({ assignment, isGraded: () => true });

export async function gradedScope(seed: PracticeSeed, set: string | undefined, now = new Date().toISOString()): Promise<GradedScope> {
  if (set === "e2e-graded") return allGraded(E2E_QUIZ);
  if (set === "e2e-fixture") return { assignment: null, isGraded: () => false };
  // The study session's invented course: lecture B's questions are under the open invented quiz, lecture A's are practice.
  if (set === "e2e-mixed") {
    const graded = new Set(seed.questions.filter((q) => (q.match.recordingUrl ?? seed.recordingUrl).includes("lecture-b")).map((q) => q.id));
    return { assignment: E2E_QUIZ, isGraded: (id) => graded.has(id) };
  }
  try {
    const home = await loadLocalHome(now, seed.course.code);
    if (!home) return allGraded();
    const quiz = home.quiz;
    if (!quiz) return { assignment: null, isGraded: () => false };
    const assignment = assignmentOfExam(quiz.exam);
    // Its modules aren't known: it could cover anything.
    if (!quiz.practice?.modules.length) return allGraded(assignment);
    const modules = new Set(quiz.practice.modules);
    const index = new Map((await loadLocalPracticeIndex(seed.course.code, seed)).map((q) => [q.id, q.module]));
    return {
      assignment,
      isGraded: (id) => {
        const m = index.get(id);
        return m == null || modules.has(m);
      },
    };
  } catch {
    return allGraded();
  }
}
