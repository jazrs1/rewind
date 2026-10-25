// Course logistics never become questions: filtered in the browser before sending, and ruled out in the server prompt.
// Synthetic course text only; the fake model.
import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "../demo/tutor-store.ts";
import { questionGenPrompt, SUBJECT_ONLY } from "../prompts/question-gen.ts";
import { buildPractice } from "./client.ts";
import { chunksOf, readFile, subjectPages } from "./export.ts";
import { isLogisticsLine, isLogisticsTitle, subjectText } from "./logistics.ts";
import { quickLLM, writeQuestions } from "./service.ts";
import { countingModel, course, pageChunk, request } from "./test-helpers.ts";

const LOGISTICS_PAGE = {
  title: "Start Here: Course Information",
  text: [
    "Welcome to MAS3114!",
    "Purchase your MyLab Math access code from the bookstore before the first class.",
    "Click Modules in the left menu of Canvas to find each week's work.",
    "Homework 1 is due Friday, Sep 4 at 11:59 PM.",
    "Grading: Homework 20%, Quizzes 10%, Exams 70%.",
    "Late work loses 10% per day. Make-up exams require documentation.",
    "Office hours: Tuesdays 2-3 PM in LIT 402, or email the instructor at instructor@example.edu.",
  ].join("\n"),
};

const MIXED_PAGE = {
  title: "Module 4: Determinants",
  text: [
    "The determinant of a 2 by 2 matrix with rows (a, b) and (c, d) is ad - bc, and a square matrix is invertible exactly when its determinant is not zero.",
    "Quiz 4 on determinants is due Thu, Sep 24 in MyLab.",
    "Swapping two rows multiplies the determinant by -1, and scaling one row by k multiplies it by k.",
  ].join("\n"),
};

describe("course logistics, filtered before sending", () => {
  it("a synthetic logistics page produces no questions: nothing is sent", async () => {
    expect(subjectText(LOGISTICS_PAGE.title, LOGISTICS_PAGE.text)).toBeNull();
    // Even under a neutral title, every line is logistics.
    expect(subjectText("Week 1", LOGISTICS_PAGE.text)).toBeNull();
    expect(chunksOf({ course, pages: [LOGISTICS_PAGE, { title: "Week 1", text: LOGISTICS_PAGE.text }], transcripts: [] }).chunks).toEqual([]);
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const r = await buildPractice({ files: { course, pages: [LOGISTICS_PAGE], transcripts: [] }, fetchFn });
    expect(r).toEqual({ questions: [], stopped: "nothing" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a subject page keeps its subject and loses its logistics lines", () => {
    const [p] = subjectPages([MIXED_PAGE]);
    expect(p.text).toContain("ad - bc");
    expect(p.text).toContain("Swapping two rows");
    expect(p.text).not.toMatch(/MyLab|due Thu/);
    const sent = chunksOf({ course, pages: [MIXED_PAGE], transcripts: [] }).chunks.map((c) => c.text).join(" ");
    expect(sent).not.toMatch(/MyLab|Sep 24/);
  });

  it("titles: logistics are dropped whole; subject titles that share a word are kept", () => {
    for (const t of ["Syllabus", "Course Schedule", "Grading Policy", "Office Hours", "Getting Started with MyLab", "How to Submit Homework", "Exam Information", "Important Dates"]) expect(isLogisticsTitle(t), t).toBe(true);
    for (const t of ["Module 4: Determinants", "Scheduling Algorithms", "Gradient Descent", "Connected Components", "Week 3 Hashing"]) expect(isLogisticsTitle(t), t).toBe(false);
  });

  it("lines that only look like logistics in a math course are kept", () => {
    for (const l of [
      "Due to symmetry, the probability is 1/2.",
      "The function is monotonic on the interval, so we may 2-color the graph.",
      "About 95% of the eigenvalues lie in the unit disk.",
      "We achieve O(n log n) by merging the two halves.",
      "Click the vertex to select it in the diagram.",
    ]) expect(isLogisticsLine(l), l).toBe(false);
  });

  it("a syllabus PDF is dropped, and logistics lines on a slide are dropped", () => {
    const files = {
      course,
      pages: [],
      transcripts: [],
      pdfs: [
        { deck: "MAS3114 Syllabus Fall", kind: "document" as const, pages: [{ page: 1, text: pageChunk(0).text }], skipped: 0 },
        { deck: "Lecture 5 Eigenvalues", kind: "slide" as const, pages: [{ page: 2, text: `${pageChunk(1).text}\nHomework 5 due Mon, Oct 5 in WebAssign.` }], skipped: 0 },
      ],
    };
    const chunks = chunksOf(files).chunks;
    expect(chunks.map((c) => c.doc?.deck)).toEqual(["Lecture 5 Eigenvalues"]);
    expect(chunks[0].text).not.toMatch(/WebAssign|Oct 5/);
  });

  it("assignment descriptions are never read: they're graded work", () => {
    const parse = () => ({ body: { nodeType: 1, tagName: "BODY", childNodes: [{ nodeType: 3, nodeValue: "Eigenvalues are the roots of the characteristic polynomial.", childNodes: [] }] } }) as unknown as Document;
    const got = readFile(
      { course: { id: 1, name: "Linear Algebra", course_code: "MAS3114" }, pages: [{ title: "Eigenvalues", body: "<p>x</p>" }], assignments: [{ name: "HW 5", description: "<p>SECRET-ASSIGNMENT-DESCRIPTION: find the eigenvalues</p>" }] },
      parse,
    );
    expect(JSON.stringify(got)).not.toMatch(/SECRET-ASSIGNMENT|HW 5/);
  });
});

describe("the server prompt: subject matter only", () => {
  const passages = [{ id: "P1", label: "page", text: "The determinant of a 2 by 2 matrix is ad - bc." }];
  const base = { course: { code: "MAS3114", name: "Linear Algebra" }, topic: "Determinants", exam: null, passages, styleExamples: [] };

  it("Quick build's prompt says so, word for word; the pipeline's prompt is unchanged", () => {
    expect(SUBJECT_ONLY).toMatch(/^Write questions only about the subject matter\. Never about how the course runs/);
    expect(SUBJECT_ONLY).toMatch(/how its material is laid out/);
    expect(questionGenPrompt({ ...base, fence: true })).toContain(SUBJECT_ONLY);
    expect(questionGenPrompt(base)).not.toContain(SUBJECT_ONLY);
  });

  it("every question prompt the route sends carries it", async () => {
    const { model, calls } = countingModel();
    await writeQuestions(request([pageChunk(0), pageChunk(1)]), { llm: quickLLM({ model, store: memoryStore(), now: () => 0 }), count: 2 });
    const gen = calls.prompts.filter((p) => !p.startsWith("You check practice questions"));
    expect(gen.length).toBeGreaterThan(0);
    for (const p of gen) expect(p).toContain(SUBJECT_ONLY);
  });
});
