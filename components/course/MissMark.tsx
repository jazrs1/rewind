// The miss marker (John's review): a red-pen count next to a topic's dot, "✕3" for three missed answers, the Scantron
// red pen on a small cream tab so it reads on the deck. It replaces the old peach ring everywhere (Course tape stops
// and the study rail); the dot keeps its module's tape colour. Decorative: the stop's or topic's name says "missed 3".

import type { Stop } from "@/lib/course/types";

/** Missed answers on a stop: its missed evidence that counted against it (a wrong answer, a grade with points lost). */
export const missCount = (s: Pick<Stop, "missed">) => s.missed.evidence.filter((e) => e.points > 0).length;

/** With no `n` it is the generic mark the legends use ("✕ = times you missed it"). */
export function MissMark({ n, className = "" }: { n?: number; className?: string }) {
  if (n !== undefined && !(n > 0)) return null;
  return (
    <span aria-hidden="true" data-miss={n ?? undefined} data-miss-key={n === undefined ? "" : undefined} className={`inline-flex h-[18px] items-center rounded-[4px] bg-label px-1 font-hand text-[18px] leading-none font-bold text-red-pen ${className}`}>
      ✕{n ?? ""}
    </span>
  );
}
