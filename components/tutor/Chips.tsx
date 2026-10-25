"use client";

// The tutor's "From your course" chips: a mini-tape chip per lecture moment ("Oct 22 · 57:43 ◀◀", plays the lecture
// from that second) and a slide chip per slide quote (opens the slide). Each carries the word-for-word quote it stands
// for (checked on the server). Shared by the tutor panel, the similar-question card and the study session.

import { formatTime } from "@/lib/format";
import { chipKey, dedupeChips } from "@/lib/tutor/chips";
import type { Grounded } from "@/lib/tutor/claims";

// The ◀◀ on the shell: white on tape 1's blue (4.7:1; cream is 3.9:1), deck ink on the others.
export const SHELL: Record<number, string> = { 1: "bg-tape-1 text-white", 2: "bg-tape-2 text-deck", 3: "bg-tape-3 text-deck", 4: "bg-tape-4 text-deck" };

/** "Oct 22" from YYYY-MM-DD. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A chip is 30 px tall in the mockup; its pointer area reaches 44 px (data-hit-44). */
export const CHIP_HIT = "relative before:absolute before:inset-x-0 before:-inset-y-[7px] before:content-[''] transition-transform duration-150 hover:-translate-y-0.5";

export interface ChipMoment {
  date: string | null;
  shell: 1 | 2 | 3 | 4 | null;
}

export function Chips({
  grounded,
  moment,
  slideHref,
  onOpenMoment,
  onPaper = false,
}: {
  grounded: Grounded[];
  moment: ChipMoment | null | undefined;
  slideHref: string;
  onOpenMoment(start: number): void;
  /** On a paper card the slide chip (paper itself) gets a print-green outline. */
  onPaper?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-grounded-chips="">
      {dedupeChips(grounded, (g) => chipKey(g)).map((g) =>
        g.kind === "lecture" ? (
          <button
            key={`l${g.start}`}
            type="button"
            data-hit-44=""
            data-chip="tape"
            data-quote={g.quote}
            data-start={g.start}
            title={`Lecture, word for word: "${g.quote}"`}
            aria-label={`Rewind to ${moment?.date ? `${dayLabel(moment.date)}, ` : ""}${formatTime(g.start)} in the lecture: "${g.quote}"`}
            onClick={() => onOpenMoment(g.start)}
            className={`${CHIP_HIT} inline-flex h-8 items-center gap-1.5 rounded-md pr-2 pl-1 lg:h-[30px] ${SHELL[moment?.shell ?? 1]}`}
          >
            <span className="inline-flex h-6 items-center rounded-[3px] bg-label px-2 leading-[1.45] font-hand text-[18px] font-bold text-deck lg:h-[24px]">
              {moment?.date ? `${dayLabel(moment.date)} · ` : ""}
              {formatTime(g.start)}
            </span>
            <span aria-hidden="true" className="text-xs font-bold">
              ◀◀
            </span>
          </button>
        ) : (
          <a
            key={`s${g.page}`}
            data-hit-44=""
            data-chip="slide"
            data-quote={g.quote}
            href={g.href ?? slideHref}
            target="_blank"
            rel="noreferrer"
            title={`${g.pageKind === "page" ? "Page" : "Slide"}, word for word: "${g.quote}"`}
            aria-label={`${g.pageKind === "page" ? "Page" : "Slide"} ${g.page}: "${g.quote}"`}
            className={`${CHIP_HIT} inline-flex h-8 items-center rounded-md bg-paper px-2.5 text-xs font-bold text-print no-underline lg:h-[30px] ${onPaper ? "border-[1.5px] border-print" : ""}`}
          >
            {g.pageKind === "page" ? "Page" : "Slide"} {g.page}
          </a>
        ),
      )}
    </div>
  );
}
