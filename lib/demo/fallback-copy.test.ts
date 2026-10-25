import { describe, expect, it } from "vitest";
import { CAP_REACHED, fallbackCopy, GENERIC_SAVED, NO_SAVED_SIMILAR, SIMILAR_DROPPED } from "./tutor-pick";

describe("fallback copy matches the cause (never \"busy\" unless it is)", () => {
  it("a daily cap says so", () => {
    for (const why of ["visitor", "ip-day", "day-calls", "day-budget"]) {
      expect(fallbackCopy(why, "similar")).toBe(CAP_REACHED);
      expect(fallbackCopy(why, "hint")).toBe(CAP_REACHED);
    }
  });
  it("a similar question that failed its checks says so, not busy", () => {
    expect(fallbackCopy("similar", "similar")).toBe(SIMILAR_DROPPED);
    expect(SIMILAR_DROPPED).not.toMatch(/busy/i);
    expect(CAP_REACHED).not.toMatch(/busy/i);
  });
  it("busy only for a rate limit, an error, a timeout or storage being down", () => {
    for (const why of ["rate", "error", "store", null]) {
      expect(fallbackCopy(why, "similar")).toBe(NO_SAVED_SIMILAR);
      expect(fallbackCopy(why, "reply")).toBe(GENERIC_SAVED.text);
    }
  });
});
