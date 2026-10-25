// The invented e2e set for the Ask tab (/ask?set=e2e-ask, dev only; never imported by the demo build): two courses,
// "Data Structures and Algorithms" with the e2e practice set and "Computational Linear Algebra" with no question bank,
// dated items around today. No real course content.

import type { PracticeSeed } from "../demo/types.ts";
import { tapeFromSets } from "../demo/tape.ts";
import { addDays, easternDay, easternStart } from "./dates.ts";
import { buildDeadlines } from "./deadlines.ts";
import { nicknamesOf } from "./nicknames.ts";
import { lectureWindows } from "./search.ts";
import type { AskCourse, AskPassage } from "./types.ts";

export const ASK_SETS = ["e2e-ask"];

/** 11:59 pm Eastern, k days from today. */
const dueIn = (now: number, k: number) => new Date(easternStart(addDays(easternDay(now)!, k + 1)) - 60_000).toISOString();

/**
 * Two invented courses: "Data Structures and Algorithms" (COP3530) with the e2e practice set (lecture B's questions
 * graded, as /study?set=e2e-mixed) and "Computational Linear Algebra" (MAS3114) with no question bank. Dates are
 * relative to `now`, so the "next 2 weeks" always has rows.
 */
export function fixtureAskCourses(seed: PracticeSeed, now: number): AskCourse[] {
  const lectureOf = (q: PracticeSeed["questions"][number]) => ((q.match.recordingUrl ?? seed.recordingUrl).includes("lecture-b") ? "2026-10-03" : "2026-10-01");
  const graded = seed.questions.filter((q) => lectureOf(q) === "2026-10-03").map((q) => q.id);
  const ids = [...new Set(seed.questions.map(lectureOf))].sort();
  const { tape } = tapeFromSets(seed.course, ids.map((id) => ({ id, seed: { questions: seed.questions.filter((q) => lectureOf(q) === id) } })), seed.lecturer.short);
  const moments = Object.fromEntries(seed.questions.map((q) => [q.id, { date: lectureOf(q), shell: 1 as const }]));
  const dsa = buildDeadlines({
    assignments: [
      { id: 501, name: "Quiz 4 - Hashing", due_at: dueIn(now, 3), points_possible: 10, is_quiz_assignment: true },
      { id: 502, name: "Homework 5: Heaps", due_at: dueIn(now, 12), points_possible: 20 },
      { id: 503, name: "Project 2", due_at: dueIn(now, 25), points_possible: 100 },
      { id: 504, name: "Exam 3", due_at: null, points_possible: 100 },
    ],
    calendar_events: [{ id: 601, title: "Review session", start_at: dueIn(now, 5) }],
    exams: [{ id: "exam:exam-2", name: "Exam 2", date: easternDay(dueIn(now, 9)), quote: "Exam 2 is in class", source: "Syllabus", searched: ["Syllabus"] }],
    hrefOf: (d, examId) => (examId ? `/study?set=e2e-mixed&exam=${encodeURIComponent(examId)}` : d.kind === "quiz" || d.kind === "exam" ? "/study?set=e2e-mixed" : null),
  });
  const mas = buildDeadlines({
    assignments: [
      { id: 701, name: "Quiz 6", due_at: dueIn(now, 6), points_possible: 10, is_quiz_assignment: true },
      { id: 702, name: "Practice problems (ungraded)", due_at: dueIn(now, 8), points_possible: 0, grading_type: "not_graded" },
    ],
    exams: [{ id: "exam:mas-final", name: "Final Exam", date: null, quote: null, source: null, searched: ["Syllabus", "Canvas announcements"] }],
  });
  const lines = (pairs: [number, string][]) => pairs.map(([start, text], i) => ({ start, end: pairs[i + 1]?.[0] ?? start + 12, text }));
  const dsaMaterial: AskPassage[] = [
    ...lectureWindows("fake-lecture-a", "2026-10-01", lines([[600, "The new value goes in the next free slot at the bottom."], [612, "Then it swaps with its parent while it is smaller than the parent."], [626, "So a push walks up at most the height of the tree."], [640, "That is why insert is logarithmic in the number of values."]])),
    ...lectureWindows("fake-lecture-b", "2026-10-03", lines([[290, "A hash table turns a key into a bucket index."], [300, "When two keys land in the same bucket we chain them in a list."], [314, "The load factor is the number of keys divided by the number of buckets."], [330, "Keep the load factor low and the chains stay short on average."]])),
    { kind: "slide", deck: "Fake Hashing Deck", page: 5, pageKind: "slide", text: "Load factor: keys divided by buckets. Resize the table when the load factor passes the threshold.", href: null },
  ];
  const masMaterial: AskPassage[] = [
    ...lectureWindows("fake-mas-lecture", "2026-10-02", lines([[120, "A matrix is invertible exactly when its determinant is not zero."], [134, "Row reduce to echelon form and count the pivots to find the rank."]])),
  ];
  const dsaTitle = "Data Structures and Algorithms";
  const masTitle = "Computational Linear Algebra";
  return [
    {
      id: "COP3530",
      code: "COP3530",
      title: dsaTitle,
      nicknames: nicknamesOf("COP3530", dsaTitle, seed.lecturer.short),
      lecturer: seed.lecturer.short,
      shell: 1,
      ...dsa,
      material: dsaMaterial,
      bank: { seed: { ...seed, course: { code: "COP3530", name: dsaTitle } }, gradedIds: graded, tape, moments, media: {} },
      studyHref: "/study?set=e2e-mixed",
      practiceHref: "/practice?set=e2e-mixed",
    },
    { id: "MAS3114", code: "MAS3114", title: masTitle, nicknames: nicknamesOf("MAS3114", masTitle, "Rivera"), lecturer: "Rivera", shell: 2, ...mas, material: masMaterial, bank: null, studyHref: null, practiceHref: null },
  ];
}
