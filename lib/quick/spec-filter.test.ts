// Practice is never built from graded work's instructions (John, Oct 25: a real COP3530 build asked about the
// Module 4 programming quiz spec: "you will return the number of values that appear in at least k levels").
import { describe, expect, it } from "vitest";
import { gradedWhy } from "./graded.ts";
import { aboutCourseLogistics, isAssignmentSpec, subjectText } from "./logistics.ts";

const SPEC_PAGE = [
  "Module 4: Trees",
  "Videos: Types of trees, Tree representation in C++, BST search and insert, BST deletion",
  "Programming Quiz 4: Count values by level",
  "Given the root of a binary tree and a positive integer k, you will return the number of values that appear in at least k levels of the tree.",
  "Sample input: [5], [3, 5], [3, 5, 7], k = 2",
  "Submit your solution on Stepik by Friday.",
].join("\n");

describe("assignment specs are never used", () => {
  it("drops the real Module 4 page whole", () => {
    expect(isAssignmentSpec(SPEC_PAGE)).toBe(true);
    expect(subjectText("Module 4: Trees", SPEC_PAGE)).toBeNull();
  });
  it("rejects a question whose quote is the spec", () => {
    expect(aboutCourseLogistics("you will return the number of values that appear in at least k levels of the tree given the root of a binary tree and a positive integer k.")).toBe(true);
  });
  it("treats a spec PDF as graded work", () => {
    expect(gradedWhy("Project 2", "Project 2: AVL Tree\nYour program should read commands from standard input.\nSample output: successful")).toBe("words");
  });
  it("keeps lecture material with one exercise in it", () => {
    const slide = "A binary search tree keeps smaller keys on the left.\nExercise: write a function that returns the height of a tree.\nThe height of a leaf is 0.";
    expect(isAssignmentSpec(slide)).toBe(false);
    expect(subjectText("Lecture 8: Trees", slide)).not.toBeNull();
    expect(gradedWhy("8a - Graph Terminology and Implementation", "Graph: Terminology\nA connected graph has a path between every pair of vertices.")).toBeNull();
  });
});
