// Quick build never keeps a question about how the course runs or how its material is laid out (John, Oct 25: real
// COP3530 builds asked "How many projects does the course include?" and "Which video topic in this module covers…").
import { describe, expect, it } from "vitest";
import { aboutCourseLogistics, isLogisticsLine, isLogisticsTitle, withoutLogistics } from "./logistics.ts";

describe("questions about the course, not the subject", () => {
  it("refuses the two real ones", () => {
    expect(aboutCourseLogistics("A course has the following graded components: 10 programming quizzes, two individual projects, one group project, 10 conceptual quizzes, and two exams. How many projects does the course include in total?")).toBe(true);
    expect(aboutCourseLogistics("Which video topic in this module covers how to remove elements stored in binary search trees?\nBST deletion\nBST search and insert")).toBe(true);
  });
  it("refuses other logistics", () => {
    for (const t of ["How many quizzes are dropped?", "What does the syllabus say about late work?", "Which page explains the grading scale?", "What is covered in this week?"]) expect(aboutCourseLogistics(t), t).toBe(true);
  });
  it("keeps real subject questions", () => {
    for (const t of [
      "An undirected graph has vertices A, B, C, D, E and edges A-D, B-C and C-E. Which statement correctly describes this graph?",
      "In quicksort, what happens during the partition step?",
      "How many comparisons does binary search make on a sorted array of 16 elements in the worst case?",
      "Which traversal of a binary search tree visits the keys in sorted order?",
      "What is the height of a complete binary tree with 15 nodes?",
      // review-quick4 M1: subject wording the old patterns matched.
      "What fraction of the page table is resident in memory when only 4 pages are mapped?",
      "In the unit circle, what is the sine of 90 degrees?",
      "Which call uses a function imported from the module math?",
      "What does the loop update in the course of each iteration?",
      "Which order does a topological sort of the course graph produce?",
      "A course has two prerequisites, and each of those has one. In which order can the courses be taken?",
      "How many assignments of truth values satisfy (p or q) and not p?",
      "How many probe attempts does linear probing make to insert a key into a table with 3 occupied slots in a row?",
      "Which header file includes printf?",
      "Which pages does the working set include at time t?",
      "What is the last step before comparing two direction vectors?\nOne final step is to normalize the vector.\nAdd the two vectors.",
      "There are 15 projects shared equally among 3 teams. How many does each team get?\n3 projects\n5 projects",
    ])
      expect(aboutCourseLogistics(t), t).toBe(false);
  });
});

describe("the filters before anything is sent", () => {
  it("drops orientation pages and graded-component lists", () => {
    expect(isLogisticsTitle("Module 1: Course Orientation")).toBe(true);
    expect(isLogisticsTitle("About this course")).toBe(true);
    expect(isLogisticsTitle("Module 4: Trees")).toBe(false);
    expect(withoutLogistics("Graded components\n10 programming quizzes\nTwo individual projects\nOne group project\nA BST keeps smaller keys on the left.")).toBe("A BST keeps smaller keys on the left.");
    expect(isLogisticsLine("10 quizzes, two projects and two exams")).toBe(true);
    expect(isLogisticsLine("Two vertices are adjacent if an edge joins them.")).toBe(false);
    expect(isLogisticsLine("One final step is to normalize the vector.")).toBe(false);
    expect(isLogisticsLine("Two final exams")).toBe(true);
  });
});
