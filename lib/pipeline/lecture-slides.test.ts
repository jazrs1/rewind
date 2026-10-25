import { describe, expect, it } from "vitest";
import { closestDeck, isLectureDeck, LECTURE_SLIDE_MIN, moduleDeck, rankLecturePages, titleWords } from "./lecture-slides";

const NUMBERED = ["1 - Algorithmic Analysis", "2 - Lists, Stacks, Queues", "6 - Sorting", "7 - Sets, Maps, HashTables", "8a - Graph Terminology and Implementation", "8b - Graph Traversals and Algorithms"];

describe("lecture slides (lib/pipeline/lecture-slides.ts)", () => {
  it("a numbered deck is a lecture deck; Discussion, Review and game decks never are", () => {
    for (const d of NUMBERED) expect(isLectureDeck(d), d).toBe(true);
    for (const d of ["Discussion 8 - Sorting", "JeopardyTrees", "Exam 2 - Review A", "Sorting_Review_revised"]) expect(isLectureDeck(d), d).toBe(false);
  });

  it("ranks candidate pages by the mean of clip and quote similarity, best first", () => {
    const pages = [[1, 0], [0, 1], [0.7, 0.7]];
    const r = rankLecturePages(pages, [0, 1, 2], { windowVecs: [[1, 0]], quoteVec: [0.6, 0.8] });
    expect(r.map((x) => x.page)).toEqual([2, 0, 1]);
    expect(rankLecturePages(pages, [0, 1], { windowVecs: [], quoteVec: null })).toEqual([]);
    expect(LECTURE_SLIDE_MIN).toBeGreaterThan(0.5);
  });

  it("a question with no lecture takes its module's numbered deck, by topic words", () => {
    expect([...titleWords("Discussion 2 - Algorithm Analysis & Pseudocode")]).toEqual(expect.arrayContaining(["algorithm", "analysi"]));
    expect(closestDeck("Algorithm Analysis", NUMBERED)).toBe("1 - Algorithmic Analysis");
    expect(moduleDeck("Discussion 8 - Sorting", [{ position: 8, topic: "Sorting" }], NUMBERED)).toBe("6 - Sorting");
    expect(moduleDeck("Discussion 3 - Stacks, Queues, and Lists", [], NUMBERED)).toBe("2 - Lists, Stacks, Queues");
    // No shared word picks nothing (no slide beats a wrong one).
    expect(closestDeck("Dynamic Programming", NUMBERED)).toBeNull();
  });
});
