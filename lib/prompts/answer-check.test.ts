import { describe, expect, it } from "vitest";
import { ANSWER_CHECK_SCHEMA, answerCheckPrompt, VERSION } from "./answer-check";
import { QUALITY_RULES } from "./question-gen";

const input = {
  course: { code: "COP3530", name: "Data Structures and Algorithms" },
  passages: [{ id: "P1", label: "slide 90", text: "int diff = target - arr[i];" }],
  styleExamples: ["Which graph representation uses O(|V|^2) space? (A) Edge list (B) Adjacency matrix"],
  question: {
    stem: "What does the code shown return?",
    code: { language: "cpp", lines: ["int diff = target - arr[i];", "if (map.count(diff))", "  return {map[diff], i};"] },
    choices: [
      { label: "A", text: "{0, 1}" },
      { label: "B", text: "{1, 2}" },
    ],
    quote: "int diff = target - arr[i];",
  },
};

describe("answer-check prompt", () => {
  it("is versioned and asks about every rule, with brute-force reasoning for rule 1", () => {
    expect(VERSION).toBe("answer-check@2");
    const p = answerCheckPrompt(input);
    expect(p).toContain(QUALITY_RULES);
    expect(p).toContain("work out every valid answer to the problem as defined, not just the one a particular implementation would return");
    expect(p).toContain("the student sees only the stem, the code shown (if any) and the choices");
    expect(ANSWER_CHECK_SCHEMA.required).toEqual(["answer", "why", "unambiguous", "uniqueUnderDefinition", "standsAlone", "optionsParallel", "soundsLikeCourse", "quoteSupports", "problems"]);
  });

  it("shows the question as the student sees it, code included, and never a key", () => {
    const p = answerCheckPrompt(input);
    expect(p).toContain("CODE SHOWN WITH THE QUESTION (cpp)\nint diff = target - arr[i];\nif (map.count(diff))");
    expect(p).toContain("(A) {0, 1}\n(B) {1, 2}");
    expect(p).toContain("- Which graph representation uses");
    expect(p).not.toMatch(/correct answer|answer key|the key/i);
    expect(answerCheckPrompt({ ...input, question: { ...input.question, code: null } })).not.toContain("CODE SHOWN");
  });
});
