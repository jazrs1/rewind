// The course home while it loads, in its own layout and worlds (PLAN, Usability): an unprinted
// exam card on paper, the primary button's slot, and blank grey tapes on the deck. The shimmer
// is the shared .skeleton glint (static with reduced motion). Same boxes as the real page, so
// nothing shifts when it swaps in.

import type { ReactNode } from "react";

/** Row heights of the real tape shelf (blank 52/56 px; recorded with its caption, wrapped titles taller). */
const PHONE_ROWS = [52, 73.9, 85.5, 85.5, 63.6];
// Desktop folds a run of blank tapes into one 56 px row ("Mod 1–7: 7 modules without recordings").
const DESKTOP_ROWS = [56, 77.9, 77.9, 77.9, 56];

const Bar =({ className }: { className: string }) => <span aria-hidden="true" className={`skeleton block rounded-[3px] ${className}`} />;

export function HomeFrame({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh w-full flex-1">
      <nav aria-label="Courses" className="hidden w-[264px] flex-none flex-col gap-[10px] bg-deck-sunk px-5 py-7 lg:flex">
        <div className="mb-[18px] font-display text-[32px] font-extrabold tracking-[-1px]">Rewind</div>
        <div className="mb-[2px] text-[13px] text-label-faint">Your courses</div>
        {nav}
      </nav>
      {children}
    </div>
  );
}

function QuizSlot({ className }: { className: string }) {
  return (
    <div data-skel="quiz" className={`flex-col gap-2 ${className}`}>
      <div className="skeleton-paper skeleton h-[332.25px] rounded-md bg-paper lg:h-[295.5px]" />
      <div className="flex h-[67.5px] flex-col justify-center gap-1">
        <Bar className="h-11 w-64 rounded-[10px] bg-deck-raised" />
      </div>
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <HomeFrame nav={<div className="skeleton h-[62px] rounded-[10px] bg-deck-raised" />}>
      <main aria-busy="true" aria-label="Loading the course" className="mx-auto flex w-full max-w-xl min-w-0 flex-1 flex-col gap-4 px-5 pt-[22px] pb-6 lg:max-w-none lg:gap-6 lg:px-12 lg:py-9">
        <div className="flex flex-col gap-1">
          <div className="flex h-[47.5px] items-center lg:h-[57px]">
            <Bar className="h-[40px] w-48 bg-deck-raised lg:h-[48px] lg:w-60" />
          </div>
          <div className="flex h-[22.5px] items-center lg:h-6">
            <Bar className="h-4 w-56 bg-deck-raised" />
          </div>
        </div>
        <div className="flex flex-col gap-4 lg:flex-row lg:gap-8">
          <section className="flex flex-col gap-4 lg:flex-[0_0_440px]">
            {/* Phone: a nearer quiz's card and its practice link come first. */}
            <QuizSlot className="flex lg:hidden" />
            {/* The exam card: header rule, name and days, two fields, the coverage line, two source lines. */}
            <div data-skel="card" className="skeleton-paper flex flex-col gap-[10px] rounded-md bg-paper pt-[14px] pr-[34px] pb-4 pl-4 lg:pr-[44px] lg:pb-[14px] lg:pl-[22px]">
              <div className="flex h-[26.5px] items-center justify-between border-b-[1.5px] border-print/40 pb-[6px] lg:h-[28.5px] lg:pb-2">
                <Bar className="h-3 w-20 bg-print/15" />
                <Bar className="h-3 w-32 bg-print/15" />
              </div>
              <div className="flex h-[37px] items-end justify-between lg:h-[47px]">
                <Bar className="h-[30px] w-32 bg-print/15 lg:h-[34px]" />
                <Bar className="h-[30px] w-24 bg-print/15 lg:h-[40px]" />
              </div>
              <div className="grid grid-cols-2 gap-2 lg:gap-[10px]">
                <div className="h-[52.3px] rounded-[3px] border-[1.5px] border-print/40 lg:h-[59.5px]" />
                <div className="h-[52.3px] rounded-[3px] border-[1.5px] border-print/40 lg:h-[59.5px]" />
              </div>
              <div className="flex h-[38.5px] flex-col justify-center gap-2 lg:h-[19.3px]">
                <Bar className="h-3 w-5/6 bg-print/15" />
                <Bar className="h-3 w-1/3 bg-print/15 lg:hidden" />
              </div>
              <div className="flex flex-col">
                <div className="flex h-[71.5px] flex-col justify-center gap-2 lg:h-[53.6px]">
                  <Bar className="h-3 w-3/4 bg-print/15" />
                  <Bar className="h-3 w-1/2 bg-print/15" />
                </div>
                <div className="flex h-[53.6px] flex-col justify-center gap-2 lg:h-[35.8px]">
                  <Bar className="h-3 w-full bg-print/15" />
                  <Bar className="h-3 w-2/3 bg-print/15" />
                </div>
              </div>
            </div>
            {/* The practice choices: the guess (primary) with its note, and "Pick topics". */}
            <div data-skel="chooser" className="flex flex-col gap-3">
              <div className="flex flex-col gap-[6px]">
                <div className="skeleton h-[63.5px] rounded-[10px] bg-deck-raised lg:h-[58px]" />
                <div className="flex h-[19.5px] items-center"><Bar className="h-3 w-48 bg-deck-raised" /></div>
              </div>
              <div className="skeleton h-11 rounded-[10px] bg-deck-raised" />
            </div>
          </section>
          <section className="flex min-w-0 flex-1 flex-col gap-[14px]">
            {/* Desktop: the quiz heads the side column, so the exam card stays above the fold. */}
            <QuizSlot className="hidden lg:mb-2 lg:flex" />
            <div className="mt-1 pb-[2px] font-display text-[22px] font-bold text-label-faint lg:mt-0 lg:pb-0 lg:text-[24px]">Lecture tapes</div>
            {/* Blank tapes in the rows the real shelf takes: recorded tapes carry a caption line under the shell
                (and a long title wraps), so their rows are taller. Phone: the five around the latest recording. */}
            <div data-skel="tapes" className="flex flex-col gap-[10px]">
              {PHONE_ROWS.map((h, i) => (
                <div key={`p${i}`} className="lg:hidden" style={{ height: h }}>
                  <div className="skeleton flex h-[52px] items-center rounded-lg bg-tape-blank px-2">
                    <div className="h-[34px] flex-1 rounded bg-tape-blank-label/60" />
                  </div>
                </div>
              ))}
              {DESKTOP_ROWS.map((h, i) => (
                <div key={`d${i}`} className="hidden lg:block" style={{ height: h }}>
                  <div className="skeleton flex h-14 items-center rounded-lg bg-tape-blank px-[9px]">
                    <div className="h-10 flex-1 rounded bg-tape-blank-label/60" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </HomeFrame>
  );
}
