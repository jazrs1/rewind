import { describe, expect, it } from "vitest";
import { LABEL_MAX, lectureLabel, shortLabel } from "./lecture-label.ts";

describe("lecture labels", () => {
  it("come from the lecture deck, never a Discussion deck, with the number dropped", () => {
    expect(lectureLabel(["Discussion 8 - Sorting", "6 - Sorting", "6 - Sorting", "Discussion 8 - Sorting", "Discussion 8 - Sorting"])).toEqual({ topic: "Sorting", deck: "Sorting" });
    expect(lectureLabel(["Discussion 10 - Graphs definitions"])).toBeNull();
  });
  it("use the committed overrides for the demo's long titles", () => {
    expect(shortLabel("7 - Sets, Maps, HashTables")).toBe("Hash tables");
    expect(shortLabel("8a - Graph Terminology and Implementation")).toBe("Graphs");
  });
  it("are at most 14 characters, cut at a word", () => {
    const l = shortLabel("9 - Balanced Search Trees and Rotations");
    expect(l.length).toBeLessThanOrEqual(LABEL_MAX);
    expect(l).toBe("Balanced");
  });
});
