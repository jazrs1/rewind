// The motion tokens in app/globals.css and lib/motion.ts are the same numbers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bezier, DUR, EASE, easeInOut, easeOut, LOOP } from "./motion.ts";

const css = readFileSync(join(import.meta.dirname, "../app/globals.css"), "utf8");
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();

describe("motion tokens", () => {
  it("globals.css and lib/motion.ts agree", () => {
    expect(token("dur-1")).toBe(`${DUR[1]}ms`);
    expect(token("dur-2")).toBe(`${DUR[2]}ms`);
    expect(token("dur-3")).toBe(`${DUR[3]}ms`);
    expect(token("dur-rewind")).toBe(`${DUR.rewind}ms`);
    expect(token("ease-out")).toBe(EASE.out);
    expect(token("ease-in-out")).toBe(EASE.inOut);
    expect(token("ease-settle")).toBe(EASE.settle);
    expect(token("dur-loop-reel")).toBe(`${LOOP.reel}ms`);
    expect(token("dur-loop-shimmer")).toBe(`${LOOP.shimmer}ms`);
  });

  it("the easing functions follow their curves", () => {
    for (const f of [easeOut, easeInOut]) {
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
    }
    expect(easeOut(0.25)).toBeGreaterThan(0.5);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 2);
    expect(easeInOut(0.1)).toBeLessThan(0.05);
    // A linear curve stays linear.
    expect(bezier(0.25, 0.25, 0.75, 0.75)(0.3)).toBeCloseTo(0.3, 3);
  });
});
