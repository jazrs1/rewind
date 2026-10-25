import { describe, expect, it } from "vitest";
import { parseQuestionLine } from "./types";

describe("parseQuestionLine", () => {
  it("splits the stem from lettered choices", () => {
    expect(parseQuestionLine("How many? (A) 0 (B) 3 (C) 4 (D) 13")).toEqual({
      stem: "How many?",
      choices: [
        { label: "A", text: "0" },
        { label: "B", text: "3" },
        { label: "C", text: "4" },
        { label: "D", text: "13" },
      ],
    });
  });

  it("keeps parentheses that aren't choice letters", () => {
    const q = parseQuestionLine("Which uses O(|V|^2) space? (A) Edge list (B) Adjacency matrix");
    expect(q.stem).toBe("Which uses O(|V|^2) space?");
    expect(q.choices.map((c) => c.text)).toEqual(["Edge list", "Adjacency matrix"]);
  });
});
