import { describe, expect, it } from "vitest";
import { labelTime } from "./match";

describe("labelTime", () => {
  // Regression (Oct 23): Flash copied the transcript's "[1:37:59]" brackets, the label was
  // rejected, and Q5's clip silently started at the window start, 12 s early.
  it("accepts labels with or without brackets", () => {
    expect(labelTime("1:37:59")).toBe(5879);
    expect(labelTime("[1:37:59]")).toBe(5879);
    expect(labelTime("[15:18]")).toBe(918);
  });
  it("returns null for anything that isn't a time", () => {
    expect(labelTime("none")).toBeNull();
    expect(labelTime("")).toBeNull();
  });
});
