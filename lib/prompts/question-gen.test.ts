import { describe, expect, it } from "vitest";
import { passageBlock, QUALITY_RULES, QUESTION_GEN_SCHEMA, questionGenPrompt, VERSION } from "./question-gen";

const input = {
  course: { code: "COP3530", name: "Data Structures and Algorithms" },
  topic: "7 - Sets, Maps, HashTables",
  passages: [
    { id: "P1", label: "lecture 15:18 to 16:27", lines: [{ start: 918, text: "So the answer is three collisions." }] },
    { id: "P2", label: 'slide 84 of "7 - Sets, Maps, HashTables"', text: "Pigeonhole principle" },
  ],
  styleExamples: ["What is the maximum number of edges in a simple undirected graph with 6 vertices? (A) 36 (B) 30 (C) 15 (D) 12"],
};

describe("question-gen prompt", () => {
  it("is versioned and carries all four quality rules", () => {
    expect(VERSION).toBe("question-gen@2");
    const p = questionGenPrompt(input);
    expect(p).toContain(QUALITY_RULES);
    expect(p).toContain("Exactly one defensible answer under the PROBLEM's own definition, not just under one implementation");
    expect(p).toContain('no "the professor\'s solution", "the code from lecture", "the example above"');
    expect(p).toContain('no explanations or reasons ("because…", "since…")');
    expect(p).toContain("sounds like the course's own quizzes and past reviews");
    expect(p).toContain("the lines (3 to 8, copied exactly from one passage");
  });

  it("shows the style examples and numbered passages with times", () => {
    const p = questionGenPrompt(input);
    expect(p).toContain("QUESTIONS FROM THE COURSE'S PAST REVIEWS AND QUIZZES");
    expect(p).toContain("- What is the maximum number of edges");
    expect(p).toContain("[P1] lecture 15:18 to 16:27\n[15:18] So the answer is three collisions.");
    expect(passageBlock(input.passages[1])).toBe('[P2] slide 84 of "7 - Sets, Maps, HashTables"\nPigeonhole principle');
    expect(questionGenPrompt({ ...input, styleExamples: [] })).not.toContain("PAST REVIEWS AND QUIZZES (");
  });

  it("names the exam, the stems to avoid and the retry reason when given", () => {
    const p = questionGenPrompt({ ...input, exam: "Exam 2", avoid: ["Which keys collide?"], retryReason: "two valid pairs" });
    expect(p).toContain("for Exam 2");
    expect(p).toContain("- Which keys collide?");
    expect(p).toMatch(/An earlier attempt was rejected: two valid pairs\nWrite a new question that avoids this problem\.$/);
  });

  it("asks for code and the cited passage IDs in the schema", () => {
    expect(QUESTION_GEN_SCHEMA.required).toEqual(["stem", "code", "choices", "answer", "explanation", "quote", "quotePassage"]);
    expect(QUESTION_GEN_SCHEMA.properties.code.required).toEqual(["language", "lines", "passage"]);
  });
});
