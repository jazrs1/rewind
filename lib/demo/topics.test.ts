import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DemoBundleFile } from "./bundle.ts";
import { mergeTopics, slideTitle, slideTopic, type TopicTable } from "./topics.ts";

const table: TopicTable = {
  min: 2,
  max: 3,
  topics: [
    { topic: "Merge sort", patterns: ["^Merge Sort"] },
    { topic: "Bubble/Insertion/Selection sort", patterns: ["\\b(?:Bubble|Insertion|Selection) Sort\\b"] },
    { topic: "Load factor & rehashing", patterns: ["\\bLoad Factors?\\b"] },
  ],
  untitled: [{ deck: "7 - Sets, Maps, HashTables", page: 78, topic: "Quadratic probing", why: "title is an image" }],
  merges: [
    { from: ["Quadratic probing"], into: "Hashing" },
    { from: ["Load factor & rehashing"], into: "Hashing" },
  ],
};

describe("slideTitle", () => {
  it("is the slide text's start when it starts with a word", () => {
    expect(slideTitle("Merge Sort Premise: ▪ Merge sort splits")).toBe("Merge Sort Premise: ▪ Merge sort splits");
    expect(slideTitle("Poll Q#2 - Load Factors If we want")).toBe("Poll Q#2 - Load Factors If we want");
  });
  it("is null when the title was an image: a page number, a bullet or a link first", () => {
    for (const t of ["78 H(key) = Sum of key’s character ASCII", "▪ ▪ 42 https://en.wikipedia.org", "● When we insert values", "o The density", "https://x.org", "", null]) expect(slideTitle(t), String(t)).toBeNull();
  });
});

describe("slideTopic", () => {
  it("takes the first table entry whose pattern matches the title", () => {
    expect(slideTopic(table, "6 - Sorting", 40, "Merge Sort Premise")).toEqual({ topic: "Merge sort", from: "title" });
    expect(slideTopic(table, "Discussion 8 - Sorting", 21, "Poll Question #2 Which are true? ● A. Bubble sort works")).toEqual({ topic: "Bubble/Insertion/Selection sort", from: "title" });
  });
  it("never reads a topic out of the body of an untitled slide; the hand list names it, or there is none", () => {
    expect(slideTopic(table, "7 - Sets, Maps, HashTables", 42, "▪ ▪ 42 Load Factor() =")).toBeNull();
    expect(slideTopic(table, "7 - Sets, Maps, HashTables", 78, "78 H(key) = Sum")).toEqual({ topic: "Quadratic probing", from: "untitled" });
  });
});

describe("mergeTopics", () => {
  const items = [
    { id: "a", lecture: "2026-10-13", topic: "Merge sort" },
    { id: "b", lecture: "2026-10-13", topic: "Bubble/Insertion/Selection sort" },
    { id: "c", lecture: "2026-10-20", topic: "Quadratic probing" },
    { id: "d", lecture: "2026-10-20", topic: "Load factor & rehashing" },
  ];
  it("applies the table's merges in order, only while there are more than max", () => {
    expect([...mergeTopics(table, items)]).toEqual([
      ["a", "Merge sort"],
      ["b", "Bubble/Insertion/Selection sort"],
      ["c", "Hashing"],
      ["d", "Hashing"],
    ]);
    // The first merge alone leaves 4 (Hashing and Load factor are two), so the second runs too.
    expect([...mergeTopics({ ...table, max: 4 }, items).values()]).toEqual(items.map((x) => x.topic));
  });
  it("fails outside min..max", () => {
    expect(() => mergeTopics({ ...table, max: 2, merges: [] }, items)).toThrow(/4 topics/);
    expect(() => mergeTopics({ ...table, min: 5, max: 6 }, items)).toThrow(/4 topics/);
  });
});

describe("the committed bundle's topics (scripts/demo/demo-topics.json)", () => {
  const file = JSON.parse(readFileSync(join(process.cwd(), "public", "demo", "course", "course.json"), "utf8")) as DemoBundleFile;
  const committed = JSON.parse(readFileSync(join(process.cwd(), "scripts", "demo", "demo-topics.json"), "utf8")) as TopicTable;

  it("gives every question a topic, 8 to 10 in all", () => {
    for (const s of file.sets) for (const q of s.questions) expect(q.topic, q.id).toMatch(/\S/);
    const n = new Set(file.sets.flatMap((s) => s.questions.map((q) => `${s.id} ${q.topic}`))).size;
    expect(n).toBeGreaterThanOrEqual(committed.min);
    expect(n).toBeLessThanOrEqual(committed.max);
    expect([committed.min, committed.max]).toEqual([8, 10]);
  });

  it("splits each lecture by what its questions are about", () => {
    const topics = (day: string) => [...new Set(file.sets.find((s) => s.id === day)!.questions.map((q) => q.topic))].sort();
    expect(topics("2026-10-13")).toEqual(["Bubble/Insertion/Selection sort", "Merge sort", "Quick sort"]);
    expect(topics("2026-10-20")).toEqual(["C++ maps", "Hash functions & probing", "Load factor & rehashing"]);
    expect(topics("2026-10-22")).toEqual(["Adjacency matrix", "Edge list", "Graph terminology", "Paths & cycles"]);
  });
});
