// Motion tokens (design polish A). The same values live in app/globals.css (@theme: --dur-*, --ease-*);
// lib/motion.test.ts keeps the two in step. CSS animations use the vars, JS-driven ones (the fold, the
// rewind roll) use these. Only transform, opacity, clip-path and stroke-dashoffset animate; under
// prefers-reduced-motion every one of them is an instant state swap and nothing loops.

export const DUR = {
  /** Hover lift, press, the oval's pencil fill. */
  1: 150,
  /** Fades ("Correct", "You marked"), the margin note. */
  2: 200,
  /** The answer sheet folding into its strip; the red pen's circle. */
  3: 320,
  /** The rewind: reels back, counter rolling down to the clip start. */
  rewind: 900,
} as const;

export const EASE = {
  /** Things arriving and settling (fades, fills, the fold). */
  out: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  /** Things that start and stop on screen (the reels, the counter). */
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  /** A small overshoot that settles: entrances only (the pen's tail, tapes dropping). */
  settle: "cubic-bezier(0.2, 0.9, 0.3, 1.15)",
} as const;

/** Loops that only run while something is happening (reels while playing, skeleton shimmer while loading). */
export const LOOP = { reel: 2400, shimmer: 1500 } as const;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** The point at progress t (0..1) on a CSS cubic-bezier(x1, y1, x2, y2), for JS-driven motion that must follow a token. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = (s: number) => ((ax * s + bx) * s + cx) * s;
  const y = (s: number) => ((ay * s + by) * s + cy) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const d = dx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= (x(s) - t) / d;
    }
    let lo = 0, hi = 1;
    for (let i = 0; i < 20 && Math.abs(x(s) - t) > 1e-5; i++) {
      if (x(s) < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return y(s);
  };
}

const parse = (css: string) => css.match(/-?[\d.]+/g)!.map(Number) as [number, number, number, number];
/** The easing tokens as functions of t. */
export const easeOut = bezier(...parse(EASE.out));
export const easeInOut = bezier(...parse(EASE.inOut));
