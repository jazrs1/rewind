// John's copy rule: the professor is "your professor", "they" or their name, never he, him or his. The prompts say so,
// and the saved replies' own words (not the verbatim lecture quotes inside them) follow it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROFESSOR_RULE, similarPrompt, tutorPrompt, type TutorInput } from "../prompts/tutor";

const PRONOUN = /\b(?:he|him|his|himself|he's|he'd|he'll)\b/i;
/** The text outside quotation marks: a quote from the course stays word for word, whatever it says. */
const outsideQuotes = (t: string) => t.replace(/"[^"]*"|“[^”]*”|‘[^’]*’/g, " ");

describe("no he/him/his for the professor", () => {
  it("the tutor and similar-question prompts tell the model so", () => {
    const input: TutorInput = {
      course: { code: "FAKE1", name: "Fake" },
      question: { stem: "Q?", choices: [{ label: "A", text: "a" }, { label: "B", text: "b" }], answer: "A", explanation: "x", quote: "", quoteSource: "" },
      studentChoice: null,
      hintsGiven: [],
      request: "hint",
    };
    expect(PROFESSOR_RULE).toMatch(/your professor/);
    expect(tutorPrompt(input).prompt).toContain(PROFESSOR_RULE);
    expect(tutorPrompt({ ...input, request: "reply", studentMessage: "hi" }).prompt).toContain(PROFESSOR_RULE);
    expect(similarPrompt(input)).toContain(PROFESSOR_RULE);
  });

  it("the saved replies' own words (outside quotes) never call the professor he, him or his", () => {
    const file = JSON.parse(readFileSync("public/demo/course/tutor.json", "utf8")) as { questions: Record<string, Record<string, unknown>> };
    const found: string[] = [];
    for (const [id, entry] of Object.entries(file.questions)) {
      for (const [kind, r] of Object.entries(entry)) {
        const texts =
          kind === "similar"
            ? (r as { stem: string; explanation: string; choices: { text: string }[] }[]).flatMap((c) => [c.stem, c.explanation, ...c.choices.map((x) => x.text)])
            : [(r as { text: string }).text];
        for (const t of texts) if (PRONOUN.test(outsideQuotes(t))) found.push(`${id}.${kind}: ${t.slice(0, 60)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("the check itself: catches a pronoun outside quotes, leaves a quoted one alone", () => {
    expect(PRONOUN.test(outsideQuotes('He says "we pick a pivot".'))).toBe(true);
    expect(PRONOUN.test(outsideQuotes('Your professor says "he picks a pivot".'))).toBe(false);
  });
});
