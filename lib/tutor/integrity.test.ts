import { describe, expect, it } from "vitest";
import { reusesValues, revealsAnswer, statesConclusion } from "./integrity";

// Invented questions only.
const heap = {
  answer: "B" as const,
  choices: [
    { label: "A" as const, text: "Constant time" },
    { label: "B" as const, text: "Logarithmic time" },
    { label: "C" as const, text: "Linear time" },
    { label: "D" as const, text: "Quadratic time" },
  ],
};
const count = {
  answer: "B" as const,
  choices: [
    { label: "A" as const, text: "0" },
    { label: "B" as const, text: "2" },
    { label: "C" as const, text: "3" },
    { label: "D" as const, text: "7" },
  ],
};
const climb = {
  answer: "C" as const,
  choices: [
    { label: "A" as const, text: "Each push scans every value in the heap" },
    { label: "B" as const, text: "Each push sorts the whole array again" },
    { label: "C" as const, text: "Each push climbs at most the height of the tree" },
    { label: "D" as const, text: "Each push touches only the root" },
  ],
};

describe("revealsAnswer: every way of giving the right choice away", () => {
  it("by letter, in any case and phrasing", () => {
    for (const t of [
      "The answer is B.",
      "the answer is b",
      "I'd go with b.",
      "I'd go with B",
      "The correct answer is (B).",
      "Option B.",
      "option b is the one",
      "It's B.",
      "it's b",
      "B, obviously.",
      "b, obviously",
      "Think about it. B.",
      "B is correct",
      "b would be right",
      "Choose B.",
    ]) expect(revealsAnswer(t, heap), t).toBe(true);
  });

  it("by position: ordinals and number words", () => {
    for (const t of ["It's the second one.", "The second option.", "Option two.", "Option 2", "choice two is it", "Go with the second.", "the 2nd answer", "Pick the second choice"]) {
      expect(revealsAnswer(t, heap), t).toBe(true);
    }
    expect(revealsAnswer("It's the third one.", heap)).toBe(false);
    expect(revealsAnswer("It's the third one.", climb)).toBe(true);
  });

  it("by elimination", () => {
    for (const t of ["Not A, not C, not D.", "Not A, C or D.", "A, C and D are wrong.", "You can rule out A, C and D.", "Eliminate (A), (C) and (D)."]) {
      expect(revealsAnswer(t, heap), t).toBe(true);
    }
    // One choice ruled out leaves three.
    expect(revealsAnswer("Not A: why would a single step be enough?", heap)).toBe(false);
    expect(revealsAnswer("It's not a tree problem.", heap)).toBe(false);
  });

  it("by the choice's text, and by a paraphrase of it", () => {
    expect(revealsAnswer("It takes logarithmic time, because the tree is shallow.", heap)).toBe(true);
    expect(revealsAnswer("A push only climbs the tree height at most.", climb)).toBe(true);
    expect(revealsAnswer("Each push climbs up to the height of the tree.", climb)).toBe(true);
    // Words every choice shares, or a wrong choice's words, don't count.
    expect(revealsAnswer("Think about what each push touches in the heap.", climb)).toBe(false);
    expect(revealsAnswer("Does each push scan every value in the heap?", climb)).toBe(false);
  });

  it("by a short answer as a number or a word", () => {
    for (const t of ["The answer is 2.", "The result is two", "It comes out as exactly two.", "So the total is 2", "= 2"]) {
      expect(revealsAnswer(t, count), t).toBe(true);
    }
  });

  it("leaves harmless guidance alone", () => {
    for (const t of [
      "Count how many values 2A + B can take.",
      "Think about the pigeonhole principle, 9 into 7.",
      "What does a push do to the tree when the new value is smaller than its parent?",
      "Try saying it in your own words, and tell me which part is the sticking point.",
      "Look at the second line of the code. What does it change?",
      "Which of these grows with the height of the tree?",
    ]) {
      expect(revealsAnswer(t, heap), t).toBe(false);
      expect(revealsAnswer(t, count), t).toBe(false);
    }
  });
});

describe("statesConclusion (graded work): a verdict is an answer too", () => {
  it("catches verdicts on a choice or on the student's answer", () => {
    for (const t of [
      "You're right.",
      "You are correct, that's the idea.",
      "That's correct!",
      "That is wrong, think again.",
      "Option C is wrong.",
      "A is incorrect.",
      "(B) works.",
      "Choice D fails because of the base case.",
      "B is the answer.",
      "The correct answer involves the height.",
      "That isn't the answer.",
      "Spot on.",
      "Yes, that's right.",
    ]) expect(statesConclusion(t), t).toBe(true);
  });

  it("leaves questions and guidance alone", () => {
    for (const t of [
      "What would make you call that correct?",
      "What does the course say about the height of the tree?",
      "Which step of the push could change the order?",
      "How does a push work when the value is smaller than its parent?",
      "Tell me what you've tried so far.",
    ]) expect(statesConclusion(t), t).toBe(false);
  });
});

describe("reusesValues (graded work): no worked example with the question's numbers", () => {
  const q = { stem: "A table has 10 slots and 12 keys. How many collisions are guaranteed?", code: null, choices: [{ text: "0" }, { text: "2" }, { text: "12" }] };
  it("flags a similar problem or example that reuses a number", () => {
    expect(reusesValues("Here's a similar one: a table with 10 slots and 15 keys.", q)).toBe(true);
    expect(reusesValues("For example, with 12 keys in the table, what happens?", q)).toBe(true);
  });
  it("allows a similar problem with different values, and plain guidance that mentions a number", () => {
    expect(reusesValues("Here's a similar one: a table with 6 slots and 9 keys. What do you expect?", q)).toBe(false);
    expect(reusesValues("Count the 10 slots first.", q)).toBe(false);
  });
});
