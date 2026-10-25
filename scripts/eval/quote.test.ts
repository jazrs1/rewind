import { describe, expect, it } from "vitest";
import { quoteAppears } from "./quote";

const src = ["So the load factor is n over m. If it goes above 0.8, we rehash — everything moves.", "Adjacency Matrix: O(|V|^2) space"];

describe("quoteAppears", () => {
  it("accepts an exact span ignoring case, punctuation and spacing", () => {
    expect(quoteAppears("the load factor is N over M", src)).toBe(true);
    expect(quoteAppears("If it goes above 0.8 we rehash, everything moves", src)).toBe(true);
    expect(quoteAppears("adjacency matrix: O(|V|^2) space", src)).toBe(true);
  });
  it("drops a timestamp label", () => {
    expect(quoteAppears("[14:29] So the load factor is n over m", src)).toBe(true);
  });
  it("rejects paraphrase, changed words, ellipses and tiny quotes", () => {
    expect(quoteAppears("the load factor equals n over m", src)).toBe(false);
    expect(quoteAppears("So the load factor ... we rehash", src)).toBe(false);
    expect(quoteAppears("load factor", src)).toBe(false);
  });
});
