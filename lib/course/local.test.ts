import { describe, expect, it } from "vitest";
import { examsForTape } from "./local.ts";
import type { ExamInput } from "./types.ts";

const exams: ExamInput[] = [
  { id: "1", name: "Quiz A", at: "2026-01-10T23:59:00Z", score: 7, possible: 10 },
  { id: "2", name: "Exam B", at: null, score: null, possible: 100 },
];

describe("examsForTape", () => {
  it("drops every Canvas score while grades are off, so none reaches the page data", () => {
    const out = examsForTape(exams, false);
    expect(out.map((e) => [e.score, e.possible])).toEqual([[null, null], [null, null]]);
    expect(out.map((e) => [e.id, e.name, e.at])).toEqual(exams.map((e) => [e.id, e.name, e.at]));
  });

  it("keeps scores only when grades are switched on", () => {
    expect(examsForTape(exams, true)).toEqual(exams);
  });
});
