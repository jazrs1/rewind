import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkField, easternIso, examKey, examSources, findExams, isEasternDate, isExamName, quoteIn, sameEventGroups, sameExamName, sameNumbered, supportedValue, type ExamConflict, type FoundExam, type GenerateJSON } from "./exams";
import type { ExtractedDoc } from "./types";

// Invented course: a syllabus, two announcements and some assignments.
const exp = {
  course: { id: 7, name: "Fake Data Structures", course_code: "FAKE7" },
  announcements: [
    { id: 1, title: "Welcome", posted_at: "2026-08-25T12:00:00Z" },
    { id: 2, title: "Exam 1 moved", posted_at: "2026-09-20T15:00:00Z" },
  ],
  assignments: [
    { id: 10, name: "Exam 2", due_at: "2026-11-06T01:00:00Z" },
    { id: 11, name: "Quiz 3", due_at: null },
    { id: 12, name: "Project 1", due_at: "2026-10-01T03:59:00Z" },
  ],
};
const docs: ExtractedDoc[] = [
  { itemId: "syllabus:7", fileId: null, name: "Syllabus", role: "syllabus", pages: [{ page: 1, text: "Exams\nExam 1 is on Thursday, October 1 at 8:20 PM in\nCAR 100.\nYou may bring one handwritten notes sheet.\nExam 2 covers trees and graphs." }] },
  { itemId: "announcement:1", fileId: null, name: "Welcome", role: "admin", pages: [{ page: 1, text: "Welcome\nSee the syllabus for exam dates." }] },
  { itemId: "announcement:2", fileId: null, name: "Exam 1 moved", role: "admin", pages: [{ page: 1, text: "Exam 1 moved\nExam 1 will now be on Saturday, October 3 at 10:00 AM in CAR 100." }] },
  { itemId: "assignment:10", fileId: null, name: "Exam 2", role: "homework", pages: [{ page: 1, text: "Exam 2" }] },
  { itemId: "assignment:11", fileId: null, name: "Quiz 3", role: "homework", pages: [{ page: 1, text: "Quiz 3" }] },
  { itemId: "assignment:12", fileId: null, name: "Project 1", role: "homework", pages: [{ page: 1, text: "Project 1" }] },
];

const q = (value: unknown, quote: string | null, sourceId: string | null) => ({ value, quote, sourceId });
const nil = q(null, null, null);
const exam = (o: Partial<Record<string, ReturnType<typeof q>>>) => ({ name: nil, date: nil, location: nil, format: nil, notesRule: nil, topics: nil, ...o });

function fakeModel(exams: unknown[]) {
  const calls: { model: string; prompt: string; options: unknown }[] = [];
  const generateJSON = (async (model: string, prompt: string, _schema: object, options?: unknown) => {
    calls.push({ model, prompt, options });
    return { exams };
  }) as GenerateJSON;
  return { generateJSON, calls };
}

describe("quoteIn and easternIso", () => {
  it("normalises whitespace only", () => {
    const text = "Exam 1 is on Thursday, October 1 at 8:20 PM in\nCAR 100.";
    expect(quoteIn(text, "October 1 at 8:20 PM in CAR 100.")).toBe(true);
    expect(quoteIn(text, "October 1 at 8:20 pm in CAR 100.")).toBe(false); // case is not normalised
    expect(quoteIn(text, "Exam 1 is Thursday, October 1")).toBe(false); // a paraphrase
    expect(quoteIn(text, "")).toBe(false);
  });

  it("converts UTC to Eastern with its offset (EDT and EST)", () => {
    expect(easternIso("2026-10-02T00:20:00Z")).toBe("2026-10-01T20:20:00-04:00");
    expect(easternIso("2026-11-06T01:00:00Z")).toBe("2026-11-05T20:00:00-05:00");
    expect(easternIso("nope")).toBeNull();
  });
});

describe("findExams", () => {
  it("a later announcement overrides the syllabus, keeping both quotes", async () => {
    const m = fakeModel([
      exam({ name: q("Exam 1", "Exam 1 is on Thursday", "syllabus:7"), date: q("2026-10-01T20:20:00-04:00", "Exam 1 is on Thursday, October 1 at 8:20 PM", "syllabus:7"), location: q("CAR 100", "October 1 at 8:20 PM in CAR 100.", "syllabus:7"), notesRule: q("handwritten", "You may bring one handwritten notes sheet.", "syllabus:7") }),
      exam({ name: q("Exam 1", "Exam 1 will now be", "announcement:2"), date: q("2026-10-03T10:00:00-04:00", "Exam 1 will now be on Saturday, October 3 at 10:00 AM", "announcement:2") }),
    ]);
    const { exams } = await findExams({ docs, exp }, { generateJSON: m.generateJSON, model: "flash-fake" });
    const e1 = exams.find((e) => e.id === "exam:exam-1")!;
    expect(e1.date).toEqual({ value: "2026-10-03T10:00:00-04:00", quote: "Exam 1 will now be on Saturday, October 3 at 10:00 AM", itemId: "announcement:2" });
    expect(e1.conflicts).toEqual([{
      field: "date",
      kept: {
        value: "2026-10-03T10:00:00-04:00", quote: "Exam 1 will now be on Saturday, October 3 at 10:00 AM",
        source: { kind: "announcement", itemId: "announcement:2", title: "Exam 1 moved", postedAt: "2026-09-20T15:00:00Z", href: "https://ufl.instructure.com/courses/7/discussion_topics/2" },
      },
      other: { value: "2026-10-01T20:20:00-04:00", quote: "Exam 1 is on Thursday, October 1 at 8:20 PM", source: { kind: "syllabus", itemId: "syllabus:7", href: "https://ufl.instructure.com/courses/7/assignments/syllabus" } },
      reason: "newer announcement (posted 2026-09-20T15:00:00Z) overrides the syllabus",
    }]);
    // Fields only the syllabus has are kept from it.
    expect(e1.location).toEqual({ value: "CAR 100", quote: "October 1 at 8:20 PM in CAR 100.", itemId: "syllabus:7" });
    expect(e1.notesRule.value).toBe("handwritten");
    expect(m.calls[0].model).toBe("flash-fake");
  });

  it("reads review pages: a location quoted from a unit review page is kept", async () => {
    const review: ExtractedDoc = { itemId: "page:unit-1-review", fileId: null, name: "Unit 1 Review", role: "review", pages: [{ page: 1, text: "Unit 1 Review\nExam 1 is in CAR 100 during our usual class time." }] };
    const sources = examSources([...docs, review], exp);
    expect(sources.find((s) => s.id === "page:unit-1-review")).toMatchObject({ kind: "page", ref: { kind: "page", pageUrl: "unit-1-review" } });
    const m = fakeModel([exam({ name: q("Exam 1", "Exam 1 is on Thursday", "syllabus:7"), location: q("CAR 100", "Exam 1 is in CAR 100 during our usual class time.", "page:unit-1-review") })]);
    const { exams } = await findExams({ docs: [...docs, review], exp }, { generateJSON: m.generateJSON, model: "m" });
    expect(exams.find((e) => e.id === "exam:exam-1")!.location).toEqual({ value: "CAR 100", quote: "Exam 1 is in CAR 100 during our usual class time.", itemId: "page:unit-1-review" });
    expect(m.calls[0].prompt).toContain("Exam 1 is in CAR 100 during our usual class time.");
  });

  it("an exam the whole-course pass left without a location gets a focused pass over the sources that name it", async () => {
    const review: ExtractedDoc = { itemId: "page:unit-2-review", fileId: null, name: "Unit 2 Review", role: "review", pages: [{ page: 1, text: "Unit 2 Review\nExam 2 will be held in CAR 100." }] };
    const prompts: string[] = [];
    const generateJSON = (async (_m: string, prompt: string) => {
      prompts.push(prompt);
      // The first (whole-course) pass names Exam 2 but misses its room; the focused pass finds it.
      return prompts.length === 1
        ? { exams: [exam({ name: q("Exam 2", "Exam 2 covers trees and graphs.", "syllabus:7") })] }
        : { exams: [exam({ name: q("Exam 2", "Exam 2 will be held in CAR 100.", "page:unit-2-review"), location: q("CAR 100", "Exam 2 will be held in CAR 100.", "page:unit-2-review"), date: q("2026-11-05", "made up", "page:unit-2-review") })] };
    }) as GenerateJSON;
    const { exams } = await findExams({ docs: [...docs, review], exp }, { generateJSON, model: "m" });
    const e2 = exams.find((e) => e.id === "exam:exam-2")!;
    expect(e2.location).toEqual({ value: "CAR 100", quote: "Exam 2 will be held in CAR 100.", itemId: "page:unit-2-review" });
    // The focused pass only saw the sources naming Exam 2, and its quotes are checked as always (a bad date is refused).
    expect(prompts[1]).toContain("Exam 2 will be held in CAR 100.");
    expect(prompts[1]).not.toContain("Exam 1 moved");
    expect(e2.date.value).toBeNull();
  });

  it("one event under two names is one exam, keeping both names' quotes; an orientation quiz isn't an exam", async () => {
    const extra: ExtractedDoc = { itemId: "page:finals", fileId: null, name: "Finals", role: "page", pages: [{ page: 1, text: "The Optional Cumulative Final Exam is on December 9 at 3:00 PM. The Course Orientation Quiz is due August 30." }] };
    const syllabus = { ...docs[0], pages: [{ page: 1, text: `${docs[0].pages[0].text}\nThe Final Exam is on December 9 at 3:00 PM.` }] };
    const all = [syllabus, ...docs.slice(1), extra];
    const m = fakeModel([
      exam({ name: q("Final Exam", "The Final Exam is on December 9", "syllabus:7"), date: q("2026-12-09T15:00:00-05:00", "The Final Exam is on December 9 at 3:00 PM.", "syllabus:7") }),
      exam({ name: q("Optional Cumulative Final Exam", "The Optional Cumulative Final Exam is on December 9", "page:finals"), date: q("2026-12-09T15:00:00-05:00", "The Optional Cumulative Final Exam is on December 9 at 3:00 PM.", "page:finals") }),
      exam({ name: q("Course Orientation Quiz", "The Course Orientation Quiz is due August 30.", "page:finals") }),
    ]);
    const { exams } = await findExams({ docs: all, exp }, { generateJSON: m.generateJSON, model: "m" });
    const finals = exams.filter((e) => /final/i.test(String(e.name.value)));
    expect(finals.map((e) => e.id)).toEqual(["exam:final-exam"]);
    expect(finals[0].conflicts.find((c) => c.field === "name")).toMatchObject({ other: { value: "Optional Cumulative Final Exam", quote: "The Optional Cumulative Final Exam is on December 9" } });
    expect(exams.some((e) => /orientation/i.test(String(e.name.value)))).toBe(false);
    expect(isExamName("Course Orientation Quiz")).toBe(false);
    expect(isExamName("Syllabus Quiz")).toBe(false);
    expect(isExamName("Conceptual Quiz 1: Syllabus, Prerequisites")).toBe(true);
  });

  it("names that only look alike stay apart: another number, or a make-up sitting", () => {
    const g = (name: string, date: string | null = null) => [{ source: { id: "syllabus:7" }, fields: { name: { value: name, quote: name, itemId: "syllabus:7" }, date: { value: date, quote: null, itemId: null } } }] as never;
    const keys = (names: [string, string | null][]) => [...sameEventGroups(new Map(names.map(([n, d]) => [examKey(n), g(n, d)]))).keys()];
    expect(keys([["Exam 1", null], ["Exam 2", null], ["Final Exam", null], ["Make-Up Final Exam", null]])).toEqual(["exam-1", "exam-2", "final-exam", "make-up-final-exam"]);
    expect(keys([["Final Exam", null], ["Optional Cumulative Final Exam", null]])).toEqual(["final-exam"]);
    // The same date and time alone no longer merges two different exams (adversary, MED a).
    expect(keys([["Exam 3", "2026-12-09T15:00:00-05:00"], ["Final Exam", "2026-12-09T15:00:00-05:00"]])).toEqual(["exam-3", "final-exam"]);
  });
});

// The adversary's review of sameEventGroups (invented names shaped like the real ones).
describe("one exam under two names (sameEventGroups)", () => {
  const T = "2026-11-18T20:30:00-05:00";
  const g = (name: string, date: string | null = null) => [{ source: { id: "syllabus:7" }, fields: { name: { value: name, quote: name, itemId: "syllabus:7" }, date: { value: date, quote: null, itemId: null } } }] as never;
  const groups = (names: [string, string | null][]) => sameEventGroups(new Map(names.map(([n, d], i) => [`${examKey(n)}#${i}`, g(n, d)])));
  const count = (names: [string, string | null][]) => groups(names).size;

  it("HIGH: a Conceptual and a Programming quiz stay apart, even when one's topic says 'Dynamic Programming'", () => {
    expect(count([["Conceptual Quiz 4 - Sorting / Dynamic Programming", null], ["Programming Quiz 4 - Sorting/Dynamic Programming", null]])).toBe(2);
    expect(sameExamName("Conceptual Quiz 4 - Sorting / Dynamic Programming", "Programming Quiz 4 - Sorting/Dynamic Programming")).toBe(false);
    expect(sameExamName("Conceptual Quiz 2", "Programming Quiz 2")).toBe(false);
    // Kind words must match: a Quiz is not a "Chapter Test".
    expect(count([["Quiz 1", null], ["Quiz 1 - Chapter Test", null]])).toBe(2);
  });

  it("merges when the longer name adds only filler, or the shorter is the bare '<kind> [N]' form", () => {
    expect(count([["Final Exam", null], ["Optional Cumulative Final Exam", null]])).toBe(1);
    expect(count([["Exam 2", null], ["Exam 2 (In-Class)", null]])).toBe(1);
    expect(count([["Midterm", null], ["Comprehensive Midterm", null]])).toBe(1);
    expect(count([["Exam 2", null], ["Exam 2 - Trees and Graphs", null]])).toBe(1);
    expect(sameExamName("Final Exam", "Optional Cumulative Final Exam")).toBe(true);
    // Neither bare nor filler: the longer name adds a topic.
    expect(count([["Quiz 3 - Heaps", null], ["Quiz 3 - Heaps and Hashing", null]])).toBe(2);
    // Another number, or no number on one side, is another exam.
    expect(count([["Exam 2", null], ["Exam 3", null], ["Midterm", null], ["Midterm 2", null]])).toBe(4);
  });

  it("MED a: the same date and time merges only names that agree or share the exam number", () => {
    expect(count([["Exam 2", T], ["Exam 3", T]])).toBe(2);
    expect(count([["Exam 3", T], ["Final Exam", T]])).toBe(2);
    expect(count([["Quiz 5", T], ["Lab Quiz 5", T]])).toBe(2);
    // Same number, same kind, same time: one sitting under a longer label.
    expect(count([["Exam 1", T], ["Exam 1: In Class (all students except DRC)", T]])).toBe(1);
    // Without a shared time those two stay apart (the long one names a DRC sitting).
    expect(count([["Exam 1", null], ["Exam 1: In Class (all students except DRC)", null]])).toBe(2);
  });

  it("MED b: a differing part, section or single letter distinguishes", () => {
    expect(count([["Exam 1 Part A", null], ["Exam 1 Part B", null]])).toBe(2);
    expect(count([["Exam 1 Part A", T], ["Exam 1 Part B", T]])).toBe(2);
    expect(count([["Exam 1 Section 1", null], ["Exam 1 Section 2", null]])).toBe(2);
    expect(count([["Quiz 2A", null], ["Quiz 2B", null]])).toBe(2);
    expect(count([["Exam 1 - A", T], ["Exam 1 - B", T]])).toBe(2);
    expect(count([["Exam 1 Part A", null], ["Optional Exam 1 Part A", null]])).toBe(1);
  });

  it("the same date and time never merges a make-up or DRC sitting into the exam", () => {
    for (const sitting of ["Exam 2 Make-Up", "Exam 2 (DRC)", "Exam 2 Re-take", "Exam 2 Retake", "Exam 2 Alt", "Exam 2 Retest", "Exam 2 Late", "Exam 2 Remote", "Exam 2 - Extended Time", "Exam 2 Attempt 2", "Exam 2 Conflict", "Exam 2 Alternate"]) {
      expect(count([["Exam 2", T], [sitting, T]]), sitting).toBe(2);
      expect(sameNumbered("Exam 2", sitting), sitting).toBe(false);
    }
    // Two names for the same sitting still merge.
    expect(count([["Exam 2 DRC", T], ["Exam 2 (DRC)", T]])).toBe(1);
    expect(sameNumbered("Exam 2 Make-Up", "Exam 2 Makeup")).toBe(true);
  });

  it("reads Unicode dashes as hyphens", () => {
    for (const dash of ["‐", "‑", "‒", "–", "—", "―", "−", "﹘", "﹣", "－"]) {
      const name = `Make${dash}Up Final Exam`;
      expect(count([["Final Exam", T], [name, T]]), JSON.stringify(dash)).toBe(2);
      expect(sameExamName("Final Exam", name), JSON.stringify(dash)).toBe(false);
      expect(sameExamName(`Make${dash}Up Final Exam`, "Make-Up Final Exam")).toBe(true);
      expect(sameNumbered(`Exam 2 Re${dash}take`, "Exam 2")).toBe(false);
    }
  });

  it("still: make-up sittings stay apart; an orientation quiz isn't an exam", () => {
    expect(count([["Final Exam", null], ["Make-Up Final Exam", null], ["Final Exam (DRC)", null]])).toBe(3);
    expect(isExamName("Course Orientation Quiz")).toBe(false);
  });

  // Real names are read at test time from private/ (never copied here): ids and counts only in failures.
  const real = (course: string) => {
    const path = `private/pipeline/${course}/exams.json`;
    if (!existsSync(path)) return null;
    type Saved = Omit<FoundExam, "conflicts"> & { conflicts: ExamConflict[] };
    const exams = (JSON.parse(readFileSync(path, "utf8")) as { exams: Saved[] }).exams;
    // As findExams groups them: by examKey, every name the run saw (kept and conflicting) a candidate.
    const byKey = new Map<string, never[]>();
    for (const e of exams)
      for (const name of [String(e.name.value), ...e.conflicts.filter((c) => c.field === "name").map((c) => String(c.other.value))])
        byKey.set(examKey(name), [...(byKey.get(examKey(name)) ?? []), ...(g(name, e.date.value) as never[])]);
    return { exams, out: sameEventGroups(byKey as never) };
  };
  const nameOf = (cs: { fields: { name: { value: unknown } } }[]) => String(cs[0].fields.name.value);
  const cop = real("COP3530");
  it.skipIf(!cop)("COP3530's 24 exams stay 24", () => {
    expect(cop!.exams.length).toBe(24);
    expect(cop!.out.size).toBe(24);
  });
  const mas = real("MAS3114");
  it.skipIf(!mas)("MAS3114: one final exam, no orientation quiz", () => {
    const groups = [...mas!.out.values()] as never as { fields: { name: { value: unknown } } }[][];
    expect(groups.filter((cs) => cs.some((c) => /\bfinal\b/i.test(String(c.fields.name.value)))).length).toBe(1);
    expect(groups.filter((cs) => /orientation/i.test(nameOf(cs))).length).toBe(0);
    expect(mas!.exams.filter((e) => /orientation/i.test(e.name.value ?? "")).length).toBe(0);
  });

  it("refuses a paraphrased quote: that field is null (not found)", async () => {
    const m = fakeModel([
      exam({ name: q("Exam 1", "Exam 1 is on Thursday", "syllabus:7"), date: q("2026-10-01", "Exam 1 is Thursday Oct 1", "syllabus:7"), location: q("CAR 100", "in CAR 100", "announcement:1") }),
    ]);
    const { exams, checked } = await findExams({ docs, exp: { ...exp, announcements: [exp.announcements[0]] } }, { generateJSON: m.generateJSON, model: "m" });
    const e1 = exams.find((e) => e.id === "exam:exam-1")!;
    expect(e1.date).toEqual({ value: null, quote: null, itemId: null });
    expect(e1.location).toEqual({ value: null, quote: null, itemId: null }); // quote isn't in the source it cites
    expect(checked.refusedFields).toBe(2);
  });

  it("a missing date stays null, and an exam with no checkable name is dropped", async () => {
    const m = fakeModel([
      exam({ name: q("Exam 2", "Exam 2 covers trees and graphs.", "syllabus:7"), topics: q(["trees", "graphs"], "Exam 2 covers trees and graphs.", "syllabus:7") }),
      exam({ name: q("Final Exam", "The final exam is cumulative", "syllabus:7") }),
      exam({ name: q("Exam 9", "Exam 9", "syllabus:999") }),
    ]);
    const { exams } = await findExams({ docs, exp }, { generateJSON: m.generateJSON, model: "m" });
    expect(exams.map((e) => e.id)).toEqual(["exam:exam-2", "exam:quiz-3"]);
    const quiz = exams.find((e) => e.id === "exam:quiz-3")!;
    expect(quiz.name).toEqual({ value: "Quiz 3", quote: "Quiz 3", itemId: "assignment:11" });
    expect(quiz.date).toEqual({ value: null, quote: null, itemId: null });
  });

  it("an assignment's due_at is the window's close (metadata), never the exam's date or a quote", async () => {
    const m = fakeModel([
      exam({ name: q("Exam 2", "Exam 2 covers trees and graphs.", "syllabus:7"), topics: q(["trees", "graphs"], "Exam 2 covers trees and graphs.", "syllabus:7") }),
      // The model quoting the metadata from the source's label is refused: it isn't the source's text.
      exam({ name: q("Exam 2", "Exam 2", "assignment:10"), date: q("2026-11-05T20:00:00-05:00", "window closes 2026-11-05T20:00:00-05:00", "assignment:10") }),
    ]);
    const { exams } = await findExams({ docs, exp }, { generateJSON: m.generateJSON, model: "m" });
    const e2 = exams.find((e) => e.id === "exam:exam-2")!;
    expect(e2.date).toEqual({ value: null, quote: null, itemId: null });
    expect(e2.windowCloses).toEqual({ value: "2026-11-05T20:00:00-05:00", itemId: "assignment:10", from: "Canvas assignment due_at (metadata, not a quote)" });
    expect(m.calls[0].prompt).toContain('kind="assignment; Canvas metadata, not quotable: submission window closes 2026-11-05T20:00:00-05:00"');
    expect(m.calls[0].prompt).not.toContain("Due: 2026");
    expect(e2.topics).toEqual({ value: ["trees", "graphs"], quote: "Exam 2 covers trees and graphs.", itemId: "syllabus:7" });
    expect(e2.name.itemId).toBe("syllabus:7"); // the syllabus outranks the assignment for the name
    expect(e2.conflicts).toEqual([]);
  });

  it("projects aren't exams; every source read is listed in searched; the prompt holds the sources", async () => {
    const m = fakeModel([]);
    const { exams } = await findExams({ docs, exp }, { generateJSON: m.generateJSON, model: "m" });
    expect(exams.map((e) => e.id)).toEqual(["exam:exam-2", "exam:quiz-3"]);
    expect(exams[0].searched.map((s) => s.itemId)).toEqual(["syllabus:7", "announcement:1", "announcement:2", "assignment:10", "assignment:11"]);
    expect(m.calls[0].prompt).toContain('<source id="announcement:2" kind="announcement posted 2026-09-20T15:00:00Z">');
    expect(m.calls[0].prompt).not.toContain("Project 1");
  });

  it("one exam across differently named sources; practice, participation and project items are left out", async () => {
    const exp2 = {
      ...exp,
      assignments: [
        { id: 20, name: "Exam 1: Fall 2026 - In Class (All students except DRC)", due_at: "2026-10-07T02:10:00Z" },
        { id: 21, name: "Practice Exam 1", due_at: "2026-10-01T03:59:00Z" },
        { id: 22, name: "Discussion #6 Exam 1 Review Participation Quiz (9/30)", due_at: "2026-09-30T15:40:00Z" },
        { id: 23, name: "Project 1: Final Computed Score", due_at: null },
      ],
    };
    const docs2: ExtractedDoc[] = [
      docs[0],
      ...exp2.assignments.map((a): ExtractedDoc => ({ itemId: `assignment:${a.id}`, fileId: null, name: a.name, role: "homework", pages: [{ page: 1, text: a.name }] })),
    ];
    const m = fakeModel([
      exam({ name: q("Exam 1", "Exam 1 is on Thursday", "syllabus:7"), location: q("CAR 100", "in CAR 100.", "syllabus:7") }),
      exam({ name: q("Practice Exam 1", "Practice Exam 1", "assignment:21") }),
    ]);
    const { exams } = await findExams({ docs: docs2, exp: exp2 }, { generateJSON: m.generateJSON, model: "m" });
    expect(exams.map((e) => e.id)).toEqual(["exam:exam-1"]);
    expect(exams[0].name.itemId).toBe("syllabus:7");
    expect(exams[0].date.value).toBeNull();
    expect(exams[0].windowCloses?.value).toBe("2026-10-06T22:10:00-04:00");
    expect(exams[0].location.value).toBe("CAR 100");
  });

  it("keeps a quiz the model found under a short name (quote checked)", async () => {
    const docs3: ExtractedDoc[] = [
      { itemId: "announcement:2", fileId: null, name: "Week 6", role: "admin", pages: [{ page: 1, text: "Week 6\nCQ6 - Heaps due Oct 16" }] },
    ];
    const m = fakeModel([exam({ name: q("CQ6 - Heaps", "CQ6 - Heaps due Oct 16", "announcement:2"), date: q("2026-10-16", "CQ6 - Heaps due Oct 16", "announcement:2") })]);
    const { exams } = await findExams({ docs: docs3, exp }, { generateJSON: m.generateJSON, model: "m" });
    expect(exams.map((e) => [e.id, e.date.value])).toEqual([["exam:cq6-heaps", "2026-10-16"]]);
  });

  it("with no syllabus or announcements, no model call is made", async () => {
    const m = fakeModel([]);
    const onlyAssignments = docs.filter((d) => d.itemId.startsWith("assignment:"));
    const { exams } = await findExams({ docs: onlyAssignments, exp }, { generateJSON: m.generateJSON, model: "m" });
    expect(m.calls).toHaveLength(0);
    expect(exams.map((e) => e.name.value)).toEqual(["Exam 2", "Quiz 3"]);
  });
});

describe("Canvas pages", () => {
  it("a page that mentions an exam is a source (e.g. a unit review page); other pages aren't", async () => {
    const pages: ExtractedDoc[] = [
      { itemId: "page:unit-2-review", fileId: null, name: "Unit 2 Review", role: "review", pages: [{ page: 1, text: "Unit 2 Review\nExam 2 covers eigenvalues, eigenvectors and diagonalization." }] },
      { itemId: "page:office-hours", fileId: null, name: "Office Hours", role: "admin", pages: [{ page: 1, text: "Office hours are Monday at noon." }] },
    ];
    const exp4 = { course: { id: 9, name: "Fake Linear Algebra", course_code: "FAKE9" } };
    const srcs = examSources(pages, exp4);
    expect(srcs.map((s) => [s.id, s.kind])).toEqual([["page:unit-2-review", "page"]]);
    expect(srcs[0].ref).toEqual({ kind: "page", itemId: "page:unit-2-review", pageUrl: "unit-2-review", title: "Unit 2 Review", href: "https://ufl.instructure.com/courses/9/pages/unit-2-review" });
    const m = fakeModel([exam({ name: q("Exam 2", "Exam 2 covers", "page:unit-2-review"), topics: q(["eigenvalues", "diagonalization"], "Exam 2 covers eigenvalues, eigenvectors and diagonalization.", "page:unit-2-review") })]);
    const { exams } = await findExams({ docs: pages, exp: exp4 }, { generateJSON: m.generateJSON, model: "m" });
    expect(m.calls[0].prompt).toContain('<source id="page:unit-2-review" kind="Canvas page "Unit 2 Review"">');
    expect(exams.map((e) => [e.id, e.topics.value, e.topics.itemId])).toEqual([["exam:exam-2", ["eigenvalues", "diagonalization"], "page:unit-2-review"]]);
  });
});

describe("exam names", () => {
  it("programming assignments, corrections and extra credit aren't exams", () => {
    expect(isExamName("Programming Assignment: Unit Tests")).toBe(false);
    expect(isExamName("Exam 2 Review")).toBe(false);
    expect(isExamName("Test 1 Corrections")).toBe(false);
    expect(isExamName("Quiz Bowl Extra Credit")).toBe(false);
    expect(isExamName("Exam 2")).toBe(true);
    expect(isExamName("Quiz 8")).toBe(true);
  });

  it("Exam II and Exam 2 are one exam", async () => {
    expect(examKey("Exam II")).toBe("exam-2");
    expect(examKey("Exam 2: In Class")).toBe("exam-2");
    expect(examKey("Midterm #III")).toBe("midterm-3");
    const ann: ExtractedDoc = { itemId: "announcement:11", fileId: null, name: "Week 6", role: "admin", pages: [{ page: 1, text: "Week 6\nExam II moved to October 22." }] };
    const exp3 = {
      course: { id: 1, name: "X", course_code: "X" },
      announcements: [{ id: 11, title: "Week 6", posted_at: "2026-10-08T12:00:00Z" }],
      assignments: [{ id: 21, name: "Exam 2", due_at: "2026-10-23T03:59:00Z" }, { id: 22, name: "Programming Assignment: Unit Tests", due_at: "2026-10-20T03:59:00Z" }],
    };
    const asg = exp3.assignments.map((a): ExtractedDoc => ({ itemId: `assignment:${a.id}`, fileId: null, name: a.name, role: "homework", pages: [{ page: 1, text: a.name }] }));
    const m = fakeModel([exam({ name: q("Exam II", "Exam II moved", "announcement:11"), date: q("2026-10-22", "Exam II moved to October 22.", "announcement:11") })]);
    const { exams } = await findExams({ docs: [ann, ...asg], exp: exp3 }, { generateJSON: m.generateJSON, model: "m" });
    expect(exams.map((e) => [e.id, e.date.value])).toEqual([["exam:exam-2", "2026-10-22"]]);
  });
});

describe("a quote must support its value, not just appear in the source", () => {
  const syl: ExtractedDoc = { itemId: "syllabus:1", fileId: null, name: "Syllabus", role: "syllabus", pages: [{ page: 1, text: "Exam 1 is on October 1.\nExam 2 is on October 15 in CSE A101.\nYou may bring one printed notes sheet. Exam 2 covers heaps, hash tables and graph traversal." }] };
  const exp1 = { course: { id: 1, name: "X", course_code: "X" } };
  const sources = new Map(examSources([syl], exp1).map((s) => [s.id, s]));
  const check = (field: Parameters<typeof checkField>[1], value: unknown, quote: string) => checkField({ value, quote, sourceId: "syllabus:1" }, field, sources).value;

  it("refuses the adversary's probes: a real quote that doesn't back the value", async () => {
    const m = fakeModel([
      exam({ name: q("Exam 1", "Exam 1", "syllabus:1"), date: q("2026-12-25", "Exam 1", "syllabus:1"), location: q("Marston Library", "E", "syllabus:1"), notesRule: q("printed", "Exam", "syllabus:1"), topics: q(["graphs", "heaps"], "on", "syllabus:1") }),
      exam({ name: q("Exam 1", "October 1. Exam 2", "syllabus:1") }),
    ]);
    const { exams, checked } = await findExams({ docs: [syl], exp: exp1 }, { generateJSON: m.generateJSON, model: "m" });
    const e1 = exams.find((e) => e.id === "exam:exam-1")!;
    for (const f of ["date", "location", "notesRule", "topics"] as const) expect(e1[f]).toEqual({ value: null, quote: null, itemId: null });
    expect(e1.name.quote).toBe("Exam 1"); // the second proposal's quote names Exam 2, so it was refused
    expect(checked.refusedFields).toBe(5);
  });

  it("dates need the month and day; times need the hour (else only the day is kept)", () => {
    expect(check("date", "2026-10-01", "Exam 1 is on October 1.")).toBe("2026-10-01");
    expect(check("date", "2026-10-15", "Exam 1 is on October 1.")).toBeNull(); // wrong day
    expect(check("date", "2026-11-01", "Exam 1 is on October 1.")).toBeNull(); // wrong month
    expect(check("date", "2026-10-01T20:00:00-04:00", "Exam 1 is on October 1.")).toBe("2026-10-01"); // hour not quoted
    expect(supportedValue("date", "2026-10-06T20:20:00-04:00", "Exam 1 on 10/6 at 8:20 PM")).toBe("2026-10-06T20:20:00-04:00");
    expect(supportedValue("date", "2026-11-18T20:30:00-05:00", "Exam 2: Tue Nov 18, 8:30-10:10 pm")).toBe("2026-11-18T20:30:00-05:00");
    expect(supportedValue("date", "2026-11-18T09:30:00-05:00", "Exam 2: Tue Nov 18, 8:30-10:10 pm")).toBe("2026-11-18");
  });

  it("location needs every room word; notes need the keyword; topics need their main words", () => {
    expect(check("location", "CSE A101", "Exam 2 is on October 15 in CSE A101.")).toBe("CSE A101");
    expect(check("location", "Marston Library", "Exam 2 is on October 15 in CSE A101.")).toBeNull();
    expect(check("notesRule", "printed", "You may bring one printed notes sheet.")).toBe("printed");
    expect(check("notesRule", "handwritten", "You may bring one printed notes sheet.")).toBeNull();
    expect(check("notesRule", "none", "You may bring one printed notes sheet.")).toBeNull();
    expect(check("topics", ["heaps", "hash tables", "graphs", "sorting"], "Exam 2 covers heaps, hash tables and graph traversal.")).toEqual(["heaps", "hash tables", "graphs"]);
    expect(check("topics", ["sorting"], "Exam 2 covers heaps, hash tables and graph traversal.")).toBeNull();
  });

  it("applies to every field type: one supported and one unsupported value each", () => {
    const sv = supportedValue;
    // name
    expect(sv("name", "Exam 2", "Exam 2")).toBe("Exam 2");
    expect(sv("name", "Exam 3", "Exam 2 is on October 15")).toBeNull();
    expect(sv("name", "Final Exam", "Exam 2 is on October 15")).toBeNull();
    // date
    expect(sv("date", "2026-10-15", "Exam 2 is on October 15")).toBe("2026-10-15");
    expect(sv("date", "2026-10-15", "Exam 2 is on Thursday")).toBeNull();
    // time
    expect(sv("date", "2026-10-15T20:20:00-04:00", "Exam 2: October 15, 8:20 PM")).toBe("2026-10-15T20:20:00-04:00");
    expect(sv("date", "2026-10-15T09:00:00-04:00", "Exam 2: October 15, 8:20 PM")).toBe("2026-10-15");
    // location
    expect(sv("location", "CAR 100", "Exam 1 is in CAR 100.")).toBe("CAR 100");
    expect(sv("location", "CAR 200", "Exam 1 is in CAR 100.")).toBeNull();
    // format
    expect(sv("format", "multiple choice on Canvas", "The exam is multiple-choice, taken on Canvas.")).toBe("multiple choice on Canvas");
    expect(sv("format", "paper, 75 minutes", "The exam is multiple-choice, taken on Canvas.")).toBeNull();
    // notes rule
    expect(sv("notesRule", "none", "No notes or calculators are allowed.")).toBe("none");
    expect(sv("notesRule", "printed", "No notes or calculators are allowed.")).toBeNull();
    // topics
    expect(sv("topics", ["AVL trees", "heaps"], "Covers AVL trees, heaps and tries.")).toEqual(["AVL trees", "heaps"]);
    expect(sv("topics", ["red-black trees"], "Covers AVL trees, heaps and tries.")).toBeNull();
    // a field added later gets the generic rule
    expect(sv("duration", "75 minutes", "You will have 75 minutes.")).toBe("75 minutes");
    expect(sv("duration", "90 minutes", "You will have 75 minutes.")).toBeNull();
    // too short to support anything (names excepted, down to their own length)
    expect(sv("location", "CAR", "CAR")).toBeNull();
  });

  it("dates carry the Eastern offset for that day, or are date-only (Z and naive times refused)", () => {
    const quote = "Exam 2 is on October 15 in CSE A101.";
    expect(check("date", "2026-10-15T23:00:00Z", quote)).toBeNull();
    expect(check("date", "2026-10-15T20:00:00", quote)).toBeNull();
    expect(check("date", "2026-10-15T20:00:00+01:00", quote)).toBeNull();
    expect(check("date", "2026-10-15T20:00:00-05:00", quote)).toBeNull(); // EST offset on an EDT day
    expect(check("date", "2026-10-15", quote)).toBe("2026-10-15");
    expect(isEasternDate("2026-10-15T20:00:00-04:00")).toBe(true);
    expect(isEasternDate("2026-12-01T20:00-05:00")).toBe(true);
    expect(isEasternDate("2026-02-30")).toBe(false);
  });

  it("names: Exam II is quoted by \"Exam 2\", but not by a quote that names another exam", () => {
    expect(supportedValue("name", "Exam II", "Exam 2 moved to October 22.")).toBe("Exam II");
    expect(supportedValue("name", "Exam 1", "October 1. Exam 2")).toBeNull();
  });
});

describe("the adversary's second round of probes (all invented quotes)", () => {
  const sv = supportedValue;
  const T = (h: string) => `2026-10-15T${h}:00-04:00`;

  it("AM/PM: \"8 PM\" doesn't back 08:00 and \"8 AM\" doesn't back 20:00; a time must be written as a time", () => {
    expect(sv("date", T("08:00"), "Exam 2: October 15, 8 PM")).toBe("2026-10-15");
    expect(sv("date", T("20:00"), "Exam 2: October 15, 8 PM")).toBe(T("20:00"));
    expect(sv("date", T("20:00"), "Exam 2: October 15, 8 AM")).toBe("2026-10-15");
    expect(sv("date", T("08:00"), "Exam 2: October 15, 8 AM")).toBe(T("08:00"));
    expect(sv("date", T("20:00"), "Exam 2: October 15, 8:00 p.m.")).toBe(T("20:00"));
    expect(sv("date", T("20:00"), "Exam 2: October 15 at 20:00")).toBe(T("20:00"));
    expect(sv("date", T("08:00"), "Exam 2: October 15 at 20:00")).toBe("2026-10-15");
    expect(sv("date", T("20:00"), "Exam 2: October 15, room 8")).toBe("2026-10-15"); // bare number
    expect(sv("date", T("08:00"), "Exam 2: October 15 at 8:00")).toBe("2026-10-15"); // no meridiem: ambiguous
    expect(sv("date", T("20:30"), "Exam 2: October 15, 8 PM")).toBe("2026-10-15"); // minutes must match too
    expect(sv("date", T("11:00"), "Exam 2: October 15, 11-1 pm")).toBe(T("11:00"));
    expect(sv("date", T("12:00"), "Exam 2: October 15 at noon")).toBe(T("12:00"));
  });

  it("\"Exam 2 - October 15\" doesn't back 14:00 (the exam number isn't an hour)", () => {
    expect(sv("date", T("14:00"), "Exam 2 - October 15")).toBe("2026-10-15");
    expect(sv("date", T("14:00"), "Exam 2 - 4 pm, October 15")).toBe("2026-10-15");
    expect(sv("date", T("16:00"), "Exam 2 - 4 pm, October 15")).toBe(T("16:00"));
  });

  it("number ranges are never dates: a date needs a month name or m/d", () => {
    expect(sv("date", "2026-10-15", "Exam 2 covers chapters 10-15")).toBeNull();
    expect(sv("date", "2026-03-05", "Read pages 3-5 before the exam")).toBeNull();
    expect(sv("date", "2026-03-05", "Exam 1 covers chapters 3/5 and 6")).toBeNull(); // a label, not a date
    expect(sv("date", "2026-10-15", "Exam 2 is on 10/15")).toBe("2026-10-15");
    expect(sv("date", "2026-10-15", "Exam 2 is on 10/15/2026")).toBe("2026-10-15");
    expect(sv("date", "2026-10-15", "Exam 2 is on 2026-10-15")).toBe("2026-10-15");
  });

  it("month names are real month tokens: \"Marston 5th\" doesn't back March 5", () => {
    expect(sv("date", "2026-03-05", "Exam 1 is in Marston 5th floor")).toBeNull();
    expect(sv("date", "2026-05-01", "Exam 1 is in Mayfield 1 hall")).toBeNull();
    expect(sv("date", "2026-03-05", "Exam 1 is on Mar. 5th")).toBe("2026-03-05");
    expect(sv("date", "2026-03-05", "Exam 1 is on March 5")).toBe("2026-03-05");
    expect(sv("date", "2026-09-05", "Exam 1 is on Sept 5")).toBe("2026-09-05");
    expect(sv("date", "2026-03-05", "Exam 1 is on the 5th of March")).toBe("2026-03-05");
  });

  it("negated notes rules: \"No printed notes are allowed\" backs \"none\", not \"printed\"", () => {
    expect(sv("notesRule", "printed", "No printed notes are allowed.")).toBeNull();
    expect(sv("notesRule", "none", "No printed notes are allowed.")).toBe("none");
    expect(sv("notesRule", "handwritten", "Handwritten notes are not allowed.")).toBeNull();
    expect(sv("notesRule", "none", "Handwritten notes are not allowed.")).toBe("none");
    expect(sv("notesRule", "printed", "The exam is taken without printed notes.")).toBeNull();
    expect(sv("notesRule", "none", "The exam is taken without printed notes.")).toBe("none");
    expect(sv("notesRule", "printed", "Printed notes can't be used on the exam.")).toBeNull();
    expect(sv("notesRule", "none", "Printed notes can't be used on the exam.")).toBe("none");
    // affirmative rules still count, and a negation about something else doesn't make "none"
    expect(sv("notesRule", "printed", "One printed sheet is allowed, but no calculators.")).toBe("printed");
    expect(sv("notesRule", "none", "One printed sheet is allowed, but no calculators.")).toBeNull();
    expect(sv("notesRule", "none", "You may not use a calculator, notes are allowed.")).toBeNull();
    expect(sv("notesRule", "none", "No calculators or notes are allowed.")).toBe("none");
  });
});
