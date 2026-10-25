import { describe, expect, it } from "vitest";
import { keywords, matchSlides } from "./slides";

const seg = (start: number, end: number, text: string) => ({ start, end, speaker: "Lecturer", text });
const pages = [
  { deck: "Fake", page: 1, text: "Stacks: push, pop, last in first out" },
  { deck: "Fake", page: 2, text: "Queues: enqueue, dequeue, first in first out" },
  { deck: "Fake", page: 3, text: "Deques: push and pop at both ends" },
];

describe("keywords", () => {
  it("keeps 4+ letter words, drops stopwords and a plural s", () => {
    expect([...keywords("These Stacks are about the PUSH operations, okay?")]).toEqual(["stack", "push", "operation"]);
    expect([...keywords("class access")]).toEqual(["class", "access"]);
  });
});

describe("matchSlides", () => {
  it("spans each clearly matched page from its first to its last matching segment", () => {
    const spans = matchSlides(
      [seg(0, 5, "A queue lets you enqueue at the back"), seg(10, 15, "and dequeue from the front of the queue"),
        seg(20, 25, "Unrelated chatter about the weather"), seg(30, 40, "Back to queues: enqueue then dequeue")],
      pages,
    );
    expect(spans).toEqual([{ deck: "Fake", page: 2, from: 0, to: 40 }]);
  });

  it("skips a segment that matches two pages equally (not a clear match)", () => {
    // Two pages, so no word counts as common; "linked" and "list" are on both.
    const two = [
      { deck: "Fake", page: 1, text: "Linked list insertion" },
      { deck: "Fake", page: 2, text: "Linked list deletion" },
    ];
    expect(matchSlides([seg(0, 5, "walk the linked list node by node")], two)).toEqual([]);
    expect(matchSlides([seg(0, 5, "insertion into a linked list")], two)).toEqual([{ deck: "Fake", page: 1, from: 0, to: 5 }]);
  });

  it("needs at least two shared keywords", () => {
    expect(matchSlides([seg(0, 5, "dequeue")], pages)).toEqual([]);
    expect(matchSlides([seg(0, 5, "dequeue")], pages, { minShared: 1 })).toEqual([{ deck: "Fake", page: 2, from: 0, to: 5 }]);
  });

  it("ignores words found on more than half the pages", () => {
    const many = [
      { deck: "Fake", page: 1, text: "graph vertices" },
      { deck: "Fake", page: 2, text: "graph edges weights" },
      { deck: "Fake", page: 3, text: "graph traversal" },
    ];
    // "graph" is on every page, so only "edges" and "weights" count.
    expect(matchSlides([seg(0, 5, "the graph has edges with weights")], many)).toEqual([{ deck: "Fake", page: 2, from: 0, to: 5 }]);
    expect(matchSlides([seg(0, 5, "graph graph graph vertices")], many)).toEqual([]);
  });
});
