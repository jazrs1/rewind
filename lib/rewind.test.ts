import { describe, expect, it } from "vitest";
import { cosine, makeWindows, MIN_GROUNDING, setupGrounding, setupNumbers, snapToSegment, topK } from "./rewind";
import type { TranscriptSegment } from "./schema";

// A segment every 10 s for 2 minutes.
const segs: TranscriptSegment[] = Array.from({ length: 12 }, (_, i) => ({
  start: i * 10,
  end: i * 10 + 10,
  speaker: "Lecturer",
  text: `s${i}`,
}));

describe("makeWindows", () => {
  it("cuts 40 s windows every 20 s", () => {
    const w = makeWindows(segs);
    expect(w.map((x) => x.start)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(w[0].text).toBe("s0 s1 s2 s3");
    expect(w[0].end).toBe(40);
    expect(w[5].text).toBe("s10 s11");
  });

  it("skips gaps and duplicate windows", () => {
    const sparse = [segs[0], { ...segs[1], start: 300, end: 305 }];
    expect(makeWindows(sparse).map((x) => x.start)).toEqual([0, 300]);
  });
});

describe("topK", () => {
  const items = [{ start: 0 }, { start: 20 }, { start: 100 }, { start: 200 }];
  const vecs = [[1, 0], [0.9, 0.1], [0.5, 0.5], [0, 1]];

  it("ranks by cosine", () => {
    expect(topK([1, 0], items, vecs, 2).map((r) => r.item.start)).toEqual([0, 20]);
  });

  it("keeps candidates apart with minGap", () => {
    expect(topK([1, 0], items, vecs, 2, 40).map((r) => r.item.start)).toEqual([0, 100]);
  });

  it("cosine handles zero vectors", () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([2, 0], [1, 0])).toBeCloseTo(1);
  });
});

describe("snapToSegment", () => {
  it("snaps to the segment start at or before the time", () => {
    expect(snapToSegment(segs, 43)).toBe(40);
    expect(snapToSegment(segs, 39.8)).toBe(40);
    expect(snapToSegment(segs, 0)).toBe(0);
  });
});

describe("setupGrounding", () => {
  const sources = ["So we have sixteen base-4 numbers going into the hash function.", "Let me open the Excel file with the collisions."];

  it("scores a faithful summary high", () => {
    const g = setupGrounding("He's in an Excel file, hashing sixteen base-4 numbers and looking for collisions.", sources);
    expect(g.unsupported).toEqual([]);
    expect(g.score).toBeGreaterThanOrEqual(MIN_GROUNDING);
  });

  it("flags words the sources don't support", () => {
    const g = setupGrounding("He's drawing a red-black tree on the whiteboard.", sources);
    expect(g.unsupported).toEqual(["drawing", "black", "tree", "whiteboard"]);
    // Numbers must match exactly, as digits or words.
    expect(setupGrounding("He hashes sixteen numbers.", ["we hash 16 numbers"]).unsupported).toEqual([]);
    expect(setupGrounding("He hashes 13 numbers into 11 slots.", ["we hash 16 numbers into 11 slots"]).unsupported).toEqual(["13"]);
    // Framing verbs don't count, but unsupported things still do.
    expect(setupGrounding("He's walking through the slides.", sources).unsupported).toEqual(["slides"]);
    expect(g.score).toBe(0);
  });
});

describe("setupNumbers", () => {
  // Regression (Oct 23, John): a setup quoted a count that the lecturer corrects later in the clip.
  it("finds digits and number words so such setups are rejected", () => {
    expect(setupNumbers("The keys run from 0 to 20, which makes 21 values in all.")).toEqual(["0", "20", "21"]);
    expect(setupNumbers("He maps sixteen keys into the table.")).toEqual(["sixteen"]);
    expect(setupNumbers("He works out how many outputs the hash function can produce.")).toEqual([]);
  });
});
