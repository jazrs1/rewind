import { describe, expect, it } from "vitest";
import { locate, tokens, wordsFromSegments } from "./align";

describe("tokens", () => {
  it("splits glued words and drops punctuation", () => {
    expect(tokens("total 11 different valuesOkay? Think of V-cross V.")).toEqual([
      "total", "11", "different", "values", "okay", "think", "of", "v", "cross", "v",
    ]);
  });
});

describe("locate", () => {
  const ref = wordsFromSegments([
    { start: 0, end: 4, speaker: null, text: "so today we look at graphs" },
    { start: 100, end: 108, speaker: null, text: "the maximum number of edges is V squared minus V over two" },
  ]);

  it("finds the start of a sentence even with small wording differences", () => {
    const hit = locate("The max number of edges is V squared minus V, over 2.", ref);
    expect(hit?.start).toBe(100);
    expect(hit!.score).toBeGreaterThanOrEqual(0.6);
  });

  it("interpolates inside a segment", () => {
    expect(locate("we look at graphs", ref)?.start).toBeCloseTo(4 * (2 / 6));
  });

  it("returns null when the text isn't there", () => {
    expect(locate("hash tables resolve collisions with chaining", ref)).toBeNull();
  });
});
