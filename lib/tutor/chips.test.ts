// One chip per lecture moment (lecture + second) and per slide (deck + page), the first kept, in order.
import { describe, expect, it } from "vitest";
import { chipKey, dedupeChips } from "./chips";
import type { Grounded } from "./claims";

const lecture = (start: number, quote: string, lec = "l20261013"): { grounded: Grounded; lecture: string } => ({ grounded: { kind: "lecture", quote, start }, lecture: lec });
const slide = (page: number, quote: string, deck = "sorting.pdf"): { grounded: Grounded; lecture?: string } => ({ grounded: { kind: "slide", quote, deck, page, pageKind: "slide" } });
const dedupe = (cs: { grounded: Grounded; lecture?: string }[]) => dedupeChips(cs, (c) => chipKey(c.grounded, c.lecture));

describe("dedupeChips", () => {
  it("two claims at the same lecture second are one chip, the first", () => {
    const out = dedupe([lecture(2292, "pick a pivot"), lecture(2292, "partition around it")]);
    expect(out).toHaveLength(1);
    expect(out[0].grounded.quote).toBe("pick a pivot");
  });

  it("two claims on the same slide are one chip", () => {
    expect(dedupe([slide(74, "quicksort is in place"), slide(74, "average n log n")])).toHaveLength(1);
  });

  it("the same lecture at different seconds is two chips", () => {
    expect(dedupe([lecture(2292, "pick a pivot"), lecture(2310, "recurse on both sides")])).toHaveLength(2);
  });

  it("the same deck at different pages is two chips", () => {
    expect(dedupe([slide(74, "quicksort is in place"), slide(75, "worst case n squared")])).toHaveLength(2);
  });

  it("keeps the original order, the same second in another lecture apart, a slide and a moment apart", () => {
    const out = dedupe([slide(74, "a"), lecture(2292, "b"), slide(74, "c"), lecture(2292, "d", "l20261015"), lecture(2292, "e")]);
    expect(out.map((c) => c.grounded.quote)).toEqual(["a", "b", "d"]);
  });
});
