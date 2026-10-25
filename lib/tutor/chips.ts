// One chip per place in the course: a lecture moment is its lecture and second, a slide is its deck and page. Two
// claims quoting different lines of the same moment (or slide) are one chip, the first, in the reply's order. Used by
// the Ask reply (lib/ask/ground.ts) and by the tutor and study session's chip row (components/tutor/Chips.tsx).

import type { Grounded } from "./claims.ts";

/** Where a chip points: kind + lecture + second, or kind + deck + page. */
export function chipKey(g: Grounded, lecture?: string | null): string {
  return g.kind === "lecture" ? `lecture\u0000${lecture ?? ""}\u0000${g.start}` : `slide\u0000${g.deck}\u0000${g.page}`;
}

/** The chips with repeats dropped: the first of each key kept, the original order. */
export function dedupeChips<T>(chips: readonly T[], keyOf: (c: T) => string): T[] {
  const seen = new Set<string>();
  return chips.filter((c) => {
    const k = keyOf(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
