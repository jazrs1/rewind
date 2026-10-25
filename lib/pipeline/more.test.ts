import { describe, expect, it } from "vitest";
import { lectureAnchors, usedPages } from "./more";
import { buildIndex } from "./retrieve";
import type { PipelineChunk, PipelineTranscript, PracticeQuestion } from "./types";

// Invented course data only: a sorting lecture and a graphs lecture; a sorting deck, a graphs deck, a lists deck.
const seg = (start: number, text: string) => ({ start, end: start + 5, speaker: "Prof", text });
const lecture = (id: string, text: string): PipelineTranscript => ({ id, source: "zoom", recordingUrl: `https://ufl.zoom.us/rec/play/${id}`, title: id, recordedAt: null, durationSec: 200, segments: Array.from({ length: 12 }, (_, i) => seg(i * 5, `${text}, line ${i}.`)) });
const LECTURES = [lecture("sort", "We sort the array with merge sort and quick sort"), lecture("graph", "A graph is connected when every pair has a path")];
const body = (t: string) => `${t} `.repeat(12);
const page = (deck: string, fileId: number, p: number, text: string): PipelineChunk => ({ id: `${deck}#${p}`, text: body(text), role: "lecture", source: { kind: "slide", itemId: `file:${fileId}`, fileId, page: p, deck } });
const CHUNKS = [
  ...[1, 2, 3, 4, 5, 6].map((p) => page("6 - Sorting", 6, p, p % 2 ? "merge sort splits the array" : "quick sort picks a pivot")),
  ...[1, 2, 3, 4, 5, 6].map((p) => page("8 - Graphs", 8, p, "a graph is connected when a path joins every pair")),
  ...[1, 2].map((p) => page("2 - Lists", 2, p, "a linked list node points to the next")),
];
const embed = async (texts: string[]) => texts.map((t) => (/sort|pivot|array/i.test(t) ? [1, 0.05, 0.05] : /graph|connected|path/i.test(t) ? [0.05, 1, 0.05] : [0.05, 0.05, 1]));
const existing = (deck: string, fileId: number, p: number): PracticeQuestion =>
  ({ id: "e", quoteSource: { kind: "slide", itemId: `file:${fileId}`, fileId, page: p, deck }, retrieval: { clip: null, slide: null, fallback: null } }) as unknown as PracticeQuestion;

describe("lectureAnchors (more questions on each lecture's topic)", () => {
  it("anchors each lecture's questions on the decks it teaches, skipping used pages and neighbours", async () => {
    const index = await buildIndex(LECTURES, CHUNKS, { embed });
    const used = [existing("6 - Sorting", 6, 1)];
    expect([...usedPages(used)].sort()).toEqual(["file:6#0", "file:6#1", "file:6#2"]);
    const anchors = lectureAnchors(index, CHUNKS, used, [2, 3]);
    expect(anchors.map((a) => [a.lecture, a.deck])).toEqual([[0, "6 - Sorting"], [0, "6 - Sorting"], [1, "8 - Graphs"], [1, "8 - Graphs"], [1, "8 - Graphs"]]);
    const pages = (t: number) => anchors.filter((a) => a.lecture === t).map((a) => (a.anchor.source as { page: number }).page);
    // Never page 1 or 2 (used or next to a used one), never two pages side by side.
    expect(pages(0).every((p) => p >= 3)).toBe(true);
    for (const t of [0, 1]) for (const [i, p] of pages(t).entries()) expect(pages(t).some((q, j) => j !== i && Math.abs(q - p) <= 1)).toBe(false);
    // The lists deck isn't taught by either lecture: no anchors.
    expect(anchors.some((a) => a.deck === "2 - Lists")).toBe(false);
  });

  it("a lecture asked for none gets none", async () => {
    const index = await buildIndex(LECTURES, CHUNKS, { embed });
    expect(lectureAnchors(index, CHUNKS, [], [0, 1]).map((a) => a.lecture)).toEqual([1]);
  });
});
