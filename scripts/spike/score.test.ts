import { describe, expect, it } from "vitest";
import { isRight, score } from "./score";

const ranges: [number, number][] = [[918, 990], [1123, 1150]];

describe("isRight", () => {
  it("counts starts inside a range or up to 10 s before one", () => {
    expect(isRight(918, ranges)).toBe(true);
    expect(isRight(990, ranges)).toBe(true);
    expect(isRight(908, ranges)).toBe(true);
    expect(isRight(1113, ranges)).toBe(true);
  });

  it("rejects starts more than 10 s early or after the range", () => {
    expect(isRight(907, ranges)).toBe(false);
    expect(isRight(991, ranges)).toBe(false);
    expect(isRight(1050, ranges)).toBe(false);
  });
});

describe("score", () => {
  it("prefers the audio-refined start, and leaves questions without truth unscored", () => {
    const out = score(
      [
        { n: 1, start: 900, playFrom: 920 },
        { n: 2, start: 2329 },
        { n: 3, start: null },
      ],
      { Q1: ranges, Q3: [[3460, 3530]] },
    );
    expect(out.map((s) => s.verdict)).toEqual(["right", "unscored", "wrong"]);
  });
});
