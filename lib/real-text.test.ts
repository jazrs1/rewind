import { describe, expect, it } from "vitest";
import { hitLines, REAL_TEXT_ALLOWED, realTextHits, transcriptRuns } from "./real-text";

describe("real course text guard", () => {
  it("finds an 8-word run across lines and punctuation, and nothing shorter", () => {
    const runs = transcriptRuns(["So the purple walrus can't sort these eleven sandwiches before lunch, okay?"]);
    expect(hitLines('x = 1;\n"The purple walrus cant sort these\neleven sandwiches"', runs)).toEqual([2]);
    expect(hitLines("the purple walrus can't sort these eleven", runs)).toEqual([]);
  });

  it("allows real lecture text in the demo bundle directory only", () => {
    expect(REAL_TEXT_ALLOWED).toEqual(["public/demo/course/"]);
  });

  const hits = realTextHits(process.cwd());
  it.skipIf(hits === null)("no committed file outside private/ and the demo bundle quotes a real lecture (8+ words) or names a real course id", () => {
    // file:line only: the failure message must not repeat the lecture text.
    expect(hits).toEqual([]);
  });

  it.skipIf(hits === null)("the allowlist is what lets the bundle through (it does quote the lectures)", () => {
    const all = realTextHits(process.cwd(), []);
    expect(all!.length).toBeGreaterThan(0);
    // Only the approved demo bundle files: the course and the saved tutor replies that quote it.
    expect(all!.every((h) => h.startsWith("public/demo/course/course.json:") || h.startsWith("public/demo/course/tutor.json:"))).toBe(true);
  });
});
