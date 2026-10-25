import { describe, expect, it } from "vitest";
import { SETUP_LINE_SCHEMA, SETUP_MAX_WORDS, setupLinePrompt, VERSION } from "./setup-line";

const input = {
  question: "How many collisions? (A) 0 (B) 3",
  clipText: "So we have thirteen pigeon holes.",
  lines: [
    { id: 41, seg: { start: 900, end: 905, speaker: "P", text: "Let me open the Excel file." } },
    { id: 42, seg: { start: 905, end: 910, speaker: "P", text: "Quaternary numbers from zero to thirty-three." } },
  ],
};

describe("setup-line prompt", () => {
  it("is versioned and keeps the spike's rules: grounded, no numbers, at most 35 words", () => {
    expect(VERSION).toBe("setup-line@2");
    expect(SETUP_MAX_WORDS).toBe(35);
    const p = setupLinePrompt(input);
    expect(p).toContain("at most 35 words");
    expect(p).toContain("Use only what these lines say, between exampleLine and the clip");
    expect(p).toContain("never guess slides, code or a whiteboard");
    expect(p).toContain("Use no numbers at all");
    expect(p).toContain("don't give away the answer");
    expect(SETUP_LINE_SCHEMA.required).toEqual(["exampleLine", "setup", "sourceLines"]);
  });

  it("shows each line with its ID and time, and names words to avoid on a retry", () => {
    const p = setupLinePrompt(input);
    expect(p).toContain("#41 [15:00] Let me open the Excel file.");
    expect(p).not.toContain("A previous attempt");
    expect(setupLinePrompt({ ...input, avoid: ["whiteboard", "the number 3"] })).toMatch(/A previous attempt used words these lines don't contain \(whiteboard, the number 3\)\. Rewrite without them\.$/);
  });

  it("names the professor or says they, never he (@2)", () => {
    const p = setupLinePrompt(input);
    expect(p).toContain(`Write it about the professor, as "the professor" or "they", never "he" or "she"`);
    expect(p.replace(`never "he" or "she"`, "")).not.toMatch(/\b(he|his|him)\b/i);
    expect(setupLinePrompt({ ...input, lecturer: "Professor Kapoor" })).toContain(`Write it about Professor Kapoor (the professor), by name, or "they"`);
  });

  it("is a pure function of its input", () => {
    expect(setupLinePrompt(input)).toBe(setupLinePrompt(structuredClone(input)));
  });
});
