import { describe, expect, it } from "vitest";
import { fixtureOutput, fixtureTranscripts } from "../pipeline/fixtures/practice-real";
import { toPracticeSeed } from "../pipeline/run";
import type { ExtractedDoc, PipelineExam } from "../pipeline/types";
import { checkedExams, practiceIndex } from "./local";
import { scopedSet } from "./practice";

describe("scopedSet", () => {
  it("numbers a scoped set within itself, in the set's order; null keeps the whole set", () => {
    const set = { questions: [1, 2, 3, 4].map((n) => ({ id: `q${n}`, n })) };
    expect(scopedSet(set, ["q4", "q2"]).questions.map((q) => [q.id, q.n])).toEqual([["q2", 1], ["q4", 2]]);
    expect(scopedSet(set, null)).toBe(set);
  });
});

describe("checkedExams (exams.json is re-checked, not trusted)", () => {
  // Invented course data.
  const syllabus = "Midterm 2 is on Thursday, November 12 at 8:20 PM in Turlington L005. It covers heaps and hash tables.";
  const docs: ExtractedDoc[] = [
    { itemId: "syllabus:1001", fileId: null, name: "Syllabus", role: "syllabus", pages: [{ page: 1, text: syllabus }] },
    { itemId: "assignment:7", fileId: null, name: "Midterm 2", role: "unknown", pages: [{ page: 1, text: "Midterm 2" }] },
  ];
  const exp = { course: { id: 1001 }, assignments: [{ id: 7, name: "Midterm 2", due_at: "2026-11-13T02:00:00Z" }] };
  const src = (value: unknown, quote: string, itemId = "syllabus:1001") => ({ value, quote, itemId });
  const honest = {
    id: "exam:midterm-2",
    name: src("Midterm 2", "Midterm 2", "assignment:7"),
    date: src("2026-11-12T20:20:00-05:00", "Thursday, November 12 at 8:20 PM"),
    location: src("Turlington L005", "in Turlington L005"),
    topics: src(["heaps", "hash tables"], "It covers heaps and hash tables."),
    searched: [],
    windowCloses: { value: "2026-11-12T21:00:00-05:00", itemId: "assignment:7" },
  } as unknown as PipelineExam;
  const notFound = { value: null, quote: null, itemId: null };

  it("keeps fields whose quote is in the source and supports the value", () => {
    const [e] = checkedExams([honest], docs, exp);
    expect(e.name.value).toBe("Midterm 2");
    expect(e.date.value).toBe("2026-11-12T20:20:00-05:00");
    expect(e.location.value).toBe("Turlington L005");
    expect(e.topics.value).toEqual(["heaps", "hash tables"]);
    expect(e.windowCloses).toEqual({ value: "2026-11-12T21:00:00-05:00", itemId: "assignment:7" });
  });

  it("shows a tampered value as not found", () => {
    const tampered = {
      ...honest,
      date: src("2026-11-19", "Thursday, November 12 at 8:20 PM"), // value the quote doesn't say
      location: src("Turlington L005", "in Turlington L007"), // quote not in the source
      topics: src(["heaps"], "It covers heaps and hash tables.", "syllabus:9999"), // source that doesn't exist
      windowCloses: { value: "2026-12-01T21:00:00-05:00", itemId: "assignment:7" },
    } as unknown as PipelineExam;
    const [e] = checkedExams([tampered], docs, exp);
    expect(e.name.value).toBe("Midterm 2");
    expect([e.date, e.location, e.topics]).toEqual([notFound, notFound, notFound]);
    expect(e.windowCloses).toBeNull();
  });

  it("without the source text nothing can be checked, so nothing is shown", () => {
    const [e] = checkedExams([honest], [], exp);
    expect([e.name, e.date, e.location, e.topics]).toEqual([notFound, notFound, notFound, notFound]);
  });
});

// Invented course data only (lib/pipeline/fixtures/practice-real.ts).
const lectures = fixtureTranscripts.map((t) => ({ id: t.id, date: t.recordedAt!.slice(0, 10), lines: t.segments.map((s) => s.text), recordingUrl: t.recordingUrl }));
const modules = [
  { id: "m1", position: 1, name: "Module 1", topic: "Heaps", itemTitles: [], dates: [] },
  { id: "m2", position: 2, name: "Module 2", topic: "Hash tables", itemTitles: [], dates: [] },
  { id: "m3", position: 3, name: "Module 3", topic: "Course notes", itemTitles: [], dates: [] },
];

describe("practiceIndex on a generated set (the pipeline's output)", () => {
  const { seed } = toPracticeSeed(fixtureOutput, fixtureTranscripts);
  const index = practiceIndex(seed, lectures, modules);

  it("each question is from the lecture its own clip is in; a question with no clip is from no lecture", () => {
    expect(index.slice(0, 3).map((x) => [x.id, x.lectureDate])).toEqual([
      ["q-code-clip", "2026-10-01"],
      ["q-no-clip", null],
      ["q-other-lecture", "2026-10-03"],
    ]);
    expect(index.slice(3).every((x) => x.lectureDate === null)).toBe(true);
  });

  it("a clip whose recording link differs from the lecture's (share vs play link) is dated by its caption lines; every clip is flagged", () => {
    const relinked = { ...seed, questions: seed.questions.map((q) => (q.id === "q-other-lecture" ? { ...q, match: { ...q.match, recordingUrl: "https://ufl.zoom.us/rec/share/same-lecture-other-link" } } : q)) };
    const ix = practiceIndex(relinked, lectures, modules);
    expect(ix.find((x) => x.id === "q-other-lecture")).toMatchObject({ lectureDate: "2026-10-03", clip: true });
    expect(ix.filter((x) => x.clip).map((x) => x.id)).toEqual(["q-code-clip", "q-other-lecture"]);
  });

  it("modules come from the question's own text and slide (?modules= selects them)", () => {
    expect(index.find((x) => x.id === "q-code-clip")?.module).toBe(1);
    expect(index.find((x) => x.id === "q-other-lecture")?.module).toBe(2);
  });

  it("a hand-written set keeps its one lecture for every question", () => {
    const hand = { ...seed, questionSet: "hand" as const, questions: seed.questions.map((q) => ({ ...q, match: { ...q.match, recordingUrl: undefined } })) };
    expect(new Set(practiceIndex(hand, lectures, modules).map((x) => x.lectureDate))).toEqual(new Set(["2026-10-01"]));
  });
});
