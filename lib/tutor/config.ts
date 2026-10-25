// What /practice gives the tutor panel: which questions are graded work and what the assignment is (decided on
// the server: lib/tutor/graded.ts), and for each question the lecture's date and tape shell for its mini-tape
// chips. Dev only (local course data, a model); null in the demo and production builds, which have their own
// tutor (lib/demo/tutor-config.ts).

import type { TutorConfig } from "../../components/tutor/types.ts";
import { isDemoMode } from "../demo/guard.ts";
import type { PracticeSeed } from "../demo/types.ts";
import { loadLocalHome, loadLocalPracticeIndex } from "../home/local.ts";
import { gradedScope } from "./graded.ts";
import { issueSession } from "./sign.ts";

export async function loadTutorConfig(seed: PracticeSeed, params: { set?: string | string[] }): Promise<TutorConfig | null> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return null;
  const set = typeof params.set === "string" ? params.set : undefined;
  const scope = await gradedScope(seed, set);
  const gradedIds = seed.questions.filter((q) => scope.isGraded(q.id)).map((q) => q.id);
  const fixture = set === "e2e-fixture" || set === "e2e-graded" || set === "e2e-mixed";
  const [index, home] = fixture ? [[], null] : await Promise.all([loadLocalPracticeIndex(seed.course.code, seed).catch(() => []), loadLocalHome(new Date().toISOString()).catch(() => null)]);
  const shellOf = new Map<string, 1 | 2 | 3 | 4>();
  for (const t of home?.tapes ?? []) if (t.shell) for (const d of t.lectureDates) shellOf.set(d, t.shell);
  const moments: TutorConfig["moments"] = {};
  for (const q of index) moments[q.id] = { date: q.lectureDate, shell: (q.lectureDate && shellOf.get(q.lectureDate)) || null };
  // The invented fixture: lecture A is Oct 1, lecture B Oct 3 (lib/pipeline/fixtures/practice-real.ts).
  if (fixture) for (const q of seed.questions) moments[q.id] = { date: (q.match.recordingUrl ?? seed.recordingUrl).includes("lecture-b") ? "2026-10-03" : "2026-10-01", shell: 1 };
  return { endpoint: "/api/tutor", set, graded: scope.assignment, gradedIds, moments, session: issueSession() };
}
