// Picked PDFs that look like graded work or submissions are never sent (Q-SEC 2). Synthetic PDFs, made in the test.
import { getDocumentProxy } from "unpdf";
import { describe, expect, it, vi } from "vitest";
import { buildPractice } from "./client.ts";
import { chunksOf, gradedPdfs } from "./export.ts";
import { gradedWhy, peopleOf } from "./graded.ts";
import { pdfFile, readPdfPages, type PdfLike } from "./pdf.ts";
import { makePdf } from "./test-pdf.ts";
import { course } from "./test-helpers.ts";
import type { QuickResponse } from "./types.ts";

const LECTURE = ["A hash table maps keys to buckets and finds a key in constant time on average when the table is not too full.", "With linear probing, a collision moves the key to the next free slot in the table and keeps looking from there."];
const read = async (name: string, pages: { lines: string[] }[]) => pdfFile(name, await readPdfPages((await getDocumentProxy(makePdf(pages))) as unknown as PdfLike));

describe("graded work and submissions", () => {
  it("is recognised by its file name or first page: the words, a score, the student's own name", () => {
    expect(gradedWhy("HW3 submission", "")).toBe("words");
    expect(gradedWhy("Lab_2_Submitted", "")).toBe("words");
    expect(gradedWhy("Exam 1", "Graded by the TA")).toBe("words");
    expect(gradedWhy("Project", "Rubric: clarity, correctness")).toBe("words");
    expect(gradedWhy("Quiz 4", "Score: 18/20")).toBe("score");
    expect(gradedWhy("Quiz 4", "Points: 7 / 10")).toBe("score");
    expect(gradedWhy("Essay", "Grade: B+")).toBe("score");
    expect(gradedWhy("Essay", "Score: 92%")).toBe("score");
    expect(gradedWhy("HW1 Jordan_Avery", "", ["Jordan Avery"])).toBe("name");
    expect(gradedWhy("Homework 1", "Name: Avery, Jordan", ["Jordan Avery", "Avery, Jordan"])).toBe("name");
  });

  it("leaves course material alone, even when it mentions points, grades or a surname", () => {
    expect(gradedWhy("Week 3 Hashing", LECTURE.join("\n"))).toBeNull();
    expect(gradedWhy("Geometry", "Points A and B lie on the line. The grade of a slope is rise over run.")).toBeNull();
    expect(gradedWhy("Algorithms", "Lee's algorithm finds a path.", ["Jordan Lee"])).toBeNull();
    expect(gradedWhy("Syllabus", "Homework is 20% of your grade.")).toBeNull();
    expect(gradedWhy("Study guide", "Submit questions in class.")).toBeNull();
  });

  it("people: the student's own name from the export's user and submissions, never sent", () => {
    const people = peopleOf({
      user: { name: "Jordan Avery", sortable_name: "Avery, Jordan" },
      submissions: [{ user: { name: "Jordan Avery" }, submission_comments: [{ author_name: "Sam Rivera" }] }],
    });
    expect(people).toEqual(expect.arrayContaining(["Jordan Avery", "Avery, Jordan"]));
    // M2: comment authors (mostly the instructor or a TA) are never read.
    expect(people).not.toContain("Sam Rivera");
    expect(peopleOf(null)).toEqual([]);
  });

  it("M1: the real extension export shape (no top-level user, submissions without user) names nobody", () => {
    const real = {
      course: { id: 1, name: "Data Structures", course_code: "COP3530" },
      pages: [],
      assignments: [],
      submissions: [{ assignment_id: 5, user_id: 991177, score: 93, submission_comments: [{ author_name: "Alex Kapoor", comment: "Nice" }] }],
    };
    expect(peopleOf(real)).toEqual([]);
  });

  it("M2: slides whose first page shows the professor's name are not graded work", () => {
    expect(gradedWhy("Lecture 9 Graphs", "COP3530 Data Structures\nAlex Kapoor\nGraph terminology", peopleOf({ submissions: [{ submission_comments: [{ author_name: "Alex Kapoor" }] }] }))).toBeNull();
  });

  it("a synthetic graded PDF is left out of what is sent; the lecture PDF goes", async () => {
    const slides = await read("Week 3 Hashing.pdf", [{ lines: LECTURE }]);
    const quiz = await read("Quiz 4.pdf", [{ lines: ["Score: 18/20", "SECRET-GRADED a hash table maps keys to buckets, my answer was linear probing every time."] }]);
    const mine = await read("HW1 Jordan Avery.pdf", [{ lines: ["SECRET-MINE hash tables map keys to buckets and buckets hold keys, in my own words for this homework."] }]);
    const files = { course, pages: [], transcripts: [], pdfs: [slides, quiz, mine], people: ["Jordan Avery"] };
    expect(gradedPdfs(files.pdfs, files.people).map((f) => f.deck)).toEqual(["Quiz 4", "HW1 Jordan Avery"]);
    const sent = chunksOf(files).chunks;
    expect(sent.map((c) => c.doc?.deck)).toEqual(["Week 3 Hashing"]);

    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ questions: [], refused: [] } satisfies QuickResponse));
    }) as unknown as typeof fetch;
    await buildPractice({ files, fetchFn });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b).not.toMatch(/SECRET|Score: 18|Jordan|Avery|Quiz 4|HW1/);
    }
  });
});
