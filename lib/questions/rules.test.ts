import { describe, expect, it } from "vitest";
import type { ChoiceLabel } from "../schema";
import { BAD_OCT22_Q2 as BAD } from "./fixtures/bad-oct22-q2";
import {
  asksAboutShownCode,
  type CheckableQuestion,
  codeProblems,
  deterministicChecks,
  enumeratePairSums,
  enumerateTraversals,
  optionProblems,
  styleProblems,
  uniquenessProblems,
  unseenReferences,
} from "./rules";

const q = (stem: string, choices: string[], answer: ChoiceLabel = "A", code: CheckableQuestion["code"] = null): CheckableQuestion => ({
  stem,
  code,
  choices: (["A", "B", "C", "D"] as ChoiceLabel[]).map((label, i) => ({ label, text: choices[i] })),
  answer,
});

/** Regression (Oct 22 Q2, Oct 23): two valid pairs, an unseen "professor's solution", and "because…" options. */
const BAD_OCT22_Q2 = q(BAD.stem, [BAD.choices.A, BAD.choices.B, BAD.choices.C, BAD.choices.D], BAD.answer);

const TWO_SUM_CODE = {
  language: "cpp",
  lines: ["for (int i = 0; i < n; i++) {", "  int diff = target - arr[i];", "  if (map.count(diff)) return {map[diff], i};", "  map[arr[i]] = i;", "}"],
};

describe("the Oct 22 Q2 regression", () => {
  it("is rejected by every deterministic rule it breaks: a, b and c", () => {
    const failures = deterministicChecks(BAD_OCT22_Q2);
    const rules = new Set(failures.map((f) => f.rule));
    expect(rules).toEqual(new Set(["unique", "standalone", "options"]));
    expect(failures.find((f) => f.rule === "unique")!.reason).toMatch(/2 valid answers \(indices \{1, 4\} \(7 \+ 6\) and indices \{2, 3\} \(4 \+ 9\)\)/);
    expect(failures.find((f) => f.rule === "standalone")!.reason).toMatch(/professor's/);
    expect(failures.filter((f) => f.rule === "options")).toHaveLength(4);
  });
});

describe("a. exactly one answer (brute force in code)", () => {
  it("enumerates every pair that sums to the target", () => {
    expect(enumeratePairSums("Which pair of indices sums to the target for arr = [2, 7, 4, 9, 6], target = 13?")!.answers).toHaveLength(2);
    expect(enumeratePairSums("Which two numbers in [3, 8, 1, 5] add up to 9?")!.answers).toEqual(["indices {1, 2} (8 + 1)"]);
    expect(enumeratePairSums("What is the load factor of a table with 7 buckets?")).toBeNull();
  });

  it("keeps a pair-sum question with one valid pair", () => {
    expect(uniquenessProblems(q("For arr = [2, 7, 4, 10, 6] and target = 13, which pair of indices sums to the target?", ["{0, 1}", "{1, 4}", "{2, 3}", "{3, 4}"]))).toEqual([]);
  });

  it("allows several valid answers when the question shows the code and asks what that code returns", () => {
    const shown = q("What does the code shown return for arr = [2, 7, 4, 9, 6] and target = 13?", ["{1, 4}", "{2, 3}", "{3, 2}", "{-1, -1}"], "B", TWO_SUM_CODE);
    expect(asksAboutShownCode(shown)).toBe(true);
    expect(uniquenessProblems(shown)).toEqual([]);
  });

  it("enumerates BFS and DFS orders, and accepts a stated tie-break", () => {
    const stem = "Take an undirected graph with edges A–B, A–C, B–D and C–D. Starting from A, what is a BFS order?";
    expect(enumerateTraversals(stem)!.answers.sort()).toEqual(["A, B, C, D", "A, C, B, D"]);
    expect(uniquenessProblems(q(stem, ["A, B, C, D", "A, D, B, C", "D, C, B, A", "B, A, C, D"]))[0]).toMatch(/BFS order .* has 2 valid answers/);
    expect(enumerateTraversals(stem.replace("?", ", visiting neighbors in alphabetical order?"))).toBeNull();
    expect(enumerateTraversals("A directed graph has edges A -> B, B -> C. What is the DFS order from A?")!.answers).toEqual(["A, B, C"]);
  });
});

describe("b. nothing referenced that isn't shown", () => {
  it.each([
    "Using the professor's solution, what is returned?",
    "In the code from lecture, what does the loop check?",
    "In the example above, how many collisions occur?",
    "As we saw in class, which representation uses more space?",
    "Which line on the slide is wrong?",
    "In the hash map solution to Two-Sum, what is stored?",
    "What does the code return for n = 3?",
  ])("rejects %j", (stem) => {
    expect(unseenReferences(q(stem, ["1", "2", "3", "4"]))).not.toEqual([]);
  });

  it.each([
    "Which of the following is a valid solution to the recurrence T(n) = 2T(n/2) + n?",
    "Consider the following graph: A–B, B–C. Which vertex has degree 2?",
    "A hash map solution to Two-Sum stores each value with its index. What does it look up for arr[i]?",
  ])("accepts %j", (stem) => {
    expect(unseenReferences(q(stem, ["1", "2", "3", "4"]))).toEqual([]);
  });

  it("allows referring to code that is shown, but never to the lecture", () => {
    expect(unseenReferences(q("What does the code shown return for n = 3?", ["1", "2", "3", "4"], "A", TWO_SUM_CODE))).toEqual([]);
    expect(unseenReferences(q("What does the professor's code shown return?", ["1", "2", "3", "4"], "A", TWO_SUM_CODE))).not.toEqual([]);
  });
});

describe("c. short, parallel options", () => {
  it("rejects explanations, catch-alls and a long outlier", () => {
    expect(optionProblems(q("S?", ["O(1) since it hashes", "O(n)", "O(log n)", "O(n^2)"]))[0]).toMatch(/option A explains itself \("since…"\)/);
    expect(optionProblems(q("S?", ["1", "2", "3", "None of the above"])).join()).toMatch(/catch-all/);
    expect(optionProblems(q("Which edge connects the graph?", ["P–R", "Q–R", "R–T", "No edge is needed; the graph is already connected"], "C")).join()).toMatch(/differ too much in length/);
  });

  it("rejects a correct option that gives itself away by length", () => {
    expect(
      optionProblems(q("S?", ["The array", "The map's keys", "The stored complement of each element seen so far", "The index"], "C")).join(),
    ).toMatch(/correct option is much longer/);
  });

  it("accepts short parallel options", () => {
    expect(optionProblems(q("S?", ["O(1)", "O(outdegree(A))", "O(|V|)", "O(|E|)"], "C"))).toEqual([]);
    expect(optionProblems(q("S?", ["Whether arr[i] is already in the map", "Whether target - arr[i] is already in the map", "Whether arr[i] equals target", "Whether the map's load factor is above 1"], "B"))).toEqual([]);
  });
});

describe("d. course style, and code length", () => {
  it("rejects a stem much longer than the course's own questions", () => {
    const examples = ["What is the maximum number of edges in a simple undirected graph with 6 vertices? (A) 36 (B) 30 (C) 15 (D) 12"];
    expect(styleProblems(q("word ".repeat(60).trim() + "?", ["1", "2", "3", "4"]), examples)[0]).toMatch(/stem is 60 words/);
    expect(styleProblems(q("How many edges can a simple graph on 5 vertices have?", ["1", "2", "3", "4"]), examples)).toEqual([]);
    expect(styleProblems(q("word ".repeat(60), ["1", "2", "3", "4"]), [])).toEqual([]);
  });

  it("wants 3 to 8 lines of code", () => {
    expect(codeProblems(q("S?", ["1", "2", "3", "4"], "A", { language: "cpp", lines: ["x++;"] }))[0]).toMatch(/1 lines/);
    expect(codeProblems(q("S?", ["1", "2", "3", "4"], "A", TWO_SUM_CODE))).toEqual([]);
  });
});
