import { describe, expect, it } from "vitest";
import { missedFact, stressedFact } from "./stopFacts.ts";
import type { Evidence } from "./types.ts";

const ev = (e: Partial<Evidence> & Pick<Evidence, "kind">): Evidence => ({ points: 1, quote: null, source: "Lecture, Oct 22", detail: "", at: null, ...e });
const stop = (evidence: Evidence[], lectureMinutes = 0) => ({ stressed: { score: 0, heat: 0, evidence }, lectureMinutes }) as Parameters<typeof stressedFact>[0];

describe("stop sheet tiles", () => {
  it("names who flagged it, then what and when, the strongest flag first", () => {
    const flags = [ev({ kind: "radar", flags: ["announcement"], at: "2026-10-13", sec: 600 }), ev({ kind: "radar", flags: ["importance", "exam"], at: "2026-10-22", sec: 2290 })];
    expect(stressedFact(stop(flags), "Kapoor")).toEqual({ title: "Kapoor flagged it", value: "Exam flag · Oct 22, 38:10 (+1 more)" });
    expect(stressedFact(stop([ev({ kind: "radar" })]), "Your professor")).toEqual({ title: "Your professor flagged it", value: "Flagged in lecture" });
  });
  it("says what other evidence is, never that it was flagged", () => {
    expect(stressedFact(stop([ev({ kind: "review", source: "Exam 1 review" })]), "Kapoor")).toEqual({ title: "On a past review", value: "Exam 1 review" });
    expect(stressedFact(stop([ev({ kind: "announcement", at: "2026-10-02" })]), "Kapoor")).toEqual({ title: "In an announcement", value: "Oct 2" });
    expect(stressedFact(stop([ev({ kind: "minutes" })], 12.4), "Kapoor")).toEqual({ title: "12 min of lecture on it", value: null });
  });
  it("without evidence: Not flagged yet, nothing under it (minutes that aren't evidence don't count)", () => {
    expect(stressedFact(stop([]), "Kapoor")).toEqual({ title: "Not flagged yet", value: null });
    expect(stressedFact(stop([], 30), "Kapoor")).toEqual({ title: "Not flagged yet", value: null });
  });
  it("the right tile: You miss it over 2 of 3; no misses or no answers said as the title", () => {
    expect(missedFact(2, 3)).toEqual({ title: "You miss it", value: "2 of 3" });
    expect(missedFact(0, 2)).toEqual({ title: "No misses yet", value: "0 of 2" });
    expect(missedFact(0, 0)).toEqual({ title: "Not practiced yet", value: null });
  });
});
