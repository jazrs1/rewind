import { describe, expect, it } from "vitest";
import { normalize, revealsAnswer, statesConclusion } from "./integrity";

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
const hashing = {
  answer: "C" as const,
  choices: [
    { label: "A" as const, text: "Sorting the keys" },
    { label: "B" as const, text: "Binary search" },
    { label: "C" as const, text: "Hashing the key" },
    { label: "D" as const, text: "A linked list scan" },
  ],
};
const powers = {
  answer: "B" as const,
  choices: [
    { label: "A" as const, text: "512" },
    { label: "B" as const, text: "1,024" },
    { label: "C" as const, text: "2,048" },
  ],
};

describe("normalize", () => {
  it("makes look-alikes plain and tidies spacing", () => {
    expect(normalize("Ｂ Β В a​b")).toBe("B B B ab");
    expect(normalize("say b .")).toBe("say b.");
    expect(normalize("1,024 and 12,5 and 1,0245")).toBe("1024 and 12,5 and 1,0245");
  });
});

describe("revealsAnswer, round 3", () => {
  it("sees through fullwidth, Greek and Cyrillic letters, zero-width characters and odd spacing", () => {
    for (const t of ["The answer is Ｂ.", "The answer is Β.", "The answer is В.", "answer: ｂ", "The ans​wer is B.", "I'd say b .", "I'd say b", "(Ｂ)", "Option ℬ", "The answer is B."]) {
      expect(revealsAnswer(t, heap), t).toBe(true);
    }
    expect(revealsAnswer("It's logar​ithmic.", heap)).toBe(true);
    expect(revealsAnswer("It's lоgarithmic.", heap)).toBe(true);
  });

  it("catches spelled-out letters and positions, and elimination in words", () => {
    for (const t of ["It's bee.", "I'd go with bee", "Pick the 2nd.", "It's the 2nd.", "The 2nd option.", "Not the first, not the third, not the fourth.", "Not the first, third or fourth.", "Eliminate the first, the third and the fourth."]) {
      expect(revealsAnswer(t, heap), t).toBe(true);
    }
    expect(revealsAnswer("Not the first.", heap)).toBe(false);
  });

  it("catches a single telling word", () => {
    for (const t of ["It's logarithmic.", "Use logarithmic.", "Think logarithmic!"]) expect(revealsAnswer(t, heap), t).toBe(true);
    for (const t of ["Use hashing.", "It's hashing.", "Try hashing the key."]) expect(revealsAnswer(t, hashing), t).toBe(true);
    // A word the question already says, or a wrong choice's own word, doesn't point anywhere.
    expect(revealsAnswer("It's logarithmic.", { ...heap, stem: "What is the logarithmic cost of a push?" })).toBe(false);
    expect(revealsAnswer("Would sorting the keys help? Why or why not?", hashing)).toBe(false);
    expect(revealsAnswer("How does a hash table find a key?", { ...hashing, stem: "How does a hash table find a key?" })).toBe(false);
  });

  it("catches numbers as counts, with or without commas", () => {
    for (const t of ["It runs twice.", "It's 2.", "Exactly 2 times.", "Exactly two times.", "That's 2."]) expect(revealsAnswer(t, count), t).toBe(true);
    for (const t of ["It's 1024.", "The answer is 1,024.", "It is exactly 1,024 steps.", "That gives 1024."]) expect(revealsAnswer(t, powers), t).toBe(true);
    expect(revealsAnswer("Is it 512 or something else?", powers)).toBe(false);
  });
});

describe("statesConclusion, round 3: bare verdicts", () => {
  it("catches a verdict said on its own", () => {
    for (const t of ["Correct!", "Right!", "Exactly.", "Yes, keep going.", "Yep.", "Nope.", "Wrong.", "Precisely, and why?", "That holds up.", "Your answer looks good.", "Keep that answer.", "Keep your answer as it is.", "Stick with it.", "Looks right.", "Think again. Right."]) {
      expect(statesConclusion(t), t).toBe(true);
    }
  });
  it("leaves guidance alone", () => {
    for (const t of ["What makes you say that?", "Right now, what does the stack hold?", "Exactly how many steps does one push take?", "No two keys share a bucket: what follows from that?", "Which one would you try first?"]) {
      expect(statesConclusion(t), t).toBe(false);
    }
  });
  it("also reads through look-alike letters", () => {
    expect(statesConclusion("Option В is wrong.")).toBe(true);
    expect(statesConclusion("Ｃorrect!")).toBe(true);
  });
});
