import { describe, expect, it } from "vitest";
import { alignClock, alignOffset, captionChanges, speechOnsets } from "./clip-align.ts";
import { studentLines } from "./speaker-check.ts";

const segments = [
  { start: 100, end: 108 },
  { start: 108, end: 115 },
  { start: 117, end: 121 },
  { start: 121, end: 133 },
  { start: 133, end: 140 },
  { start: 141, end: 150 },
];

describe("captionChanges", () => {
  it("finds the first frame of each change in the caption strip", () => {
    const f = (v: number) => new Uint8Array(16).fill(v);
    const frames = [f(0), f(0), f(200), f(200), f(200), f(50), f(50)];
    expect(captionChanges(frames, 10)).toEqual([0.2, 0.5]);
  });
});

describe("alignOffset", () => {
  it("recovers where a capture starts from changes on segment boundaries, ignoring a stray change", () => {
    // The capture's 0:00 is lecture 104.3: boundaries 108, 115, 117, 121, 133 land at 3.7, 10.7, 12.7, 16.7, 28.7.
    const changes = [3.7, 10.7, 12.7, 16.7, 22.1, 28.7];
    const a = alignOffset(changes, segments, 110, 30)!;
    expect(a.offset).toBeCloseTo(104.3, 1);
    expect(a.lead).toBeCloseTo(5.7, 1);
    expect(a.matched).toBe(5);
  });

  it("refuses to guess from fewer than 3 matches", () => {
    expect(alignOffset([1], segments, 110, 30)).toBeNull();
  });
});

describe("alignClock", () => {
  it("fits one lecture zero from changes pooled on the wall clock", () => {
    // Lecture 0:00 at clock 50000: boundaries at clock 50108, 50115, 50121, 50133.
    const z = alignClock([50108, 50115, 50121, 50133.1], segments, 50004, 15)!;
    expect(z.zero).toBeCloseTo(50000, 0);
  });
});

describe("speechOnsets", () => {
  it("marks speech resuming after a pause, not every loud frame", () => {
    const db = [60, 60, 60, 20, 20, 20, 20, 20, 20, 60, 60, 20, 60, 60];
    expect(speechOnsets(db, 10, 0.5)).toEqual([0.9]);
  });
});

describe("studentLines", () => {
  const turn = (speaker: string, text: string) => ({ speaker, start: 0, end: 1, text });
  it("flags a second speaker, a student phrase and a listed name; passes the lecturer", () => {
    const lines = studentLines(
      [turn("a", "So in quicksort you pick a pivot and partition the array around it."), turn("b", "Is that on the exam?"), turn("a", "Can you repeat the question?"), turn("a", "Good point, Zephyrine.")],
      ["Zephyrine"],
    );
    expect(lines.map((l) => l.why)).toEqual(["second speaker b", "sounds like a student", "a name"]);
    expect(studentLines([turn("a", "Does this make sense? Right?")], ["Zephyrine"])).toEqual([]);
  });
});
