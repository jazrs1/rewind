import { describe, expect, it } from "vitest";
import { courseTitle, deckDisplayName, formatTime, inSentence } from "./format";

describe("formatTime", () => {
  it("formats minutes and seconds", () => {
    expect(formatTime(2620)).toBe("43:40");
    expect(formatTime(5)).toBe("0:05");
  });
  it("adds hours past 60 minutes and floors fractions", () => {
    expect(formatTime(3735.9)).toBe("1:02:15");
  });
});

describe("deckDisplayName", () => {
  it("cleans deck file names for display", () => {
    expect(deckDisplayName("7 - Sets, Maps, HashTables")).toBe("Sets, Maps & Hash Tables");
    expect(deckDisplayName("8a - Graph Terminology and Implementation")).toBe("Graph Terminology and Implementation");
    expect(deckDisplayName("6 - Sorting.pdf")).toBe("Sorting");
  });

  it("courseTitle never repeats the code", () => {
    expect(courseTitle({ code: "COP3530", name: "COP3530 - Fa26" })).toBe("COP3530 - Fa26");
    expect(courseTitle({ code: "FAKE7", name: "Fake Data Structures" })).toBe("FAKE7 Fake Data Structures");
    expect(courseTitle({ code: "MAS 3114", name: "" })).toBe("MAS 3114");
  });

  it("never doubles a conjunction, and file-name underscores read as spaces", () => {
    expect(deckDisplayName("Discussion 9 - Sets, Maps, and Hash Tables")).toBe("Discussion 9 - Sets, Maps & Hash Tables");
    expect(deckDisplayName("Lists, Stacks, & Queues")).toBe("Lists, Stacks & Queues");
    expect(deckDisplayName("COP3530_Syllabus_Fa26")).toBe("COP3530 Syllabus Fa26");
    expect(deckDisplayName("Discussion 14_ DP and Complexity Theory")).toBe("Discussion 14 DP and Complexity Theory");
  });
});

describe("inSentence", () => {
  it("lowercases an ordinary first word, never names, code or numbers", () => {
    expect(inSentence("The new key overwrites the old one")).toBe("the new key overwrites the old one");
    expect(inSentence("Both keys are kept in that bucket's list")).toBe("both keys are kept in that bucket's list");
    expect(inSentence("Left rotation at 10")).toBe("left rotation at 10");
    expect(inSentence("Dijkstra's algorithm")).toBe("Dijkstra's algorithm");
    expect(inSentence("AVL rotation")).toBe("AVL rotation");
    expect(inSentence("mergeSort(arr, 1, 1)")).toBe("mergeSort(arr, 1, 1)");
    expect(inSentence("O(n log n)")).toBe("O(n log n)");
    expect(inSentence("42")).toBe("42");
  });

  it("keeps a lone capital that names something (a vertex), lowercases the article", () => {
    expect(inSentence("A is adjacent to C")).toBe("A is adjacent to C");
    expect(inSentence("A, B and C")).toBe("A, B and C");
    expect(inSentence("A → B → C")).toBe("A → B → C");
    expect(inSentence("A and D are in one component")).toBe("A and D are in one component");
    expect(inSentence("A new leaf")).toBe("a new leaf");
    expect(inSentence("A pivot is chosen and elements are swapped around it")).toBe("a pivot is chosen and elements are swapped around it");
  });
});
