// Loading state for the Scantron sheet: the same form, unprinted. Every box here mirrors one in
// ScantronSheet with the same classes, and text becomes a bar inside a line of the same font, so
// the line boxes (and every position below them) match when the question swaps in.

import { Oval } from "./Oval";
import { BackButton, TimingMarks } from "./ScantronSheet";

/** A placeholder for text: sits inside a line of the real font, so the line keeps its height. */
function Bar({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton inline-block h-[0.7em] max-w-full rounded-[3px] bg-print/15 align-middle ${className}`} />;
}

/**
 * The stem's lines. On a phone they set where the answers start, so there are as many as a typical generated
 * stem (about 140 characters) wraps to at 390 px: eight. A longer or shorter stem moves the rows below it by
 * 31 px a line; nothing else moves. On desktop the answers column sets the sheet's height, so three will do.
 */
const STEM_LINES = ["w-full", "w-11/12", "w-full lg:w-2/3", "w-full", "w-10/12", "w-full", "w-11/12", "w-1/2"];

export function SheetSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading the practice question"
      className="skeleton-paper relative flex min-h-dvh w-full flex-col gap-3.5 bg-paper pt-5 pr-11 pb-[var(--phone-bottom-room)] pl-5 text-ink lg:mx-auto lg:my-8 lg:min-h-0 lg:max-w-[1600px] lg:gap-[22px] lg:rounded-md lg:pt-8 lg:pr-[72px] lg:pb-8 lg:pl-12"
    >
      <TimingMarks count={22} className="top-6 right-3 bottom-6 lg:top-7 lg:right-[22px] lg:bottom-7" />

      <div className="flex flex-col gap-3.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3 text-print lg:gap-3.5">
          <BackButton />
          <div className="flex flex-col gap-0.5">
            <div className="text-[15px] font-bold lg:text-[17px]" data-skel="title">
              <Bar className="w-44 lg:w-56" />
            </div>
            <div className="text-[13px] lg:text-sm">
              <Bar className="w-24" />
            </div>
          </div>
        </div>
        <div className="flex gap-[5px] border-b-[1.5px] border-print/40 pb-3 lg:gap-1.5 lg:border-0 lg:pb-0" data-skel="progress">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-3 flex-1 rounded-md border-[1.5px] border-print/40 lg:h-3.5 lg:w-[26px] lg:flex-none lg:rounded-[7px]" />
          ))}
        </div>
      </div>
      <div className="hidden border-t-[1.5px] border-print/40 lg:block" />

      <div className="flex flex-col gap-3.5 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-8">
        <div className="flex min-w-0 flex-col gap-3.5 lg:flex-1 lg:gap-[22px]">
          {/* The stem's first desktop fit step (ScantronSheet STEM_PX: 20 px at line-height 1.45). */}
          <div className="flex items-baseline gap-2.5 lg:gap-3" data-skel="stem">
            <span className="font-serif text-[26px] font-semibold lg:text-[20px]">
              <Bar className="w-[0.85em]" />
            </span>
            <div className="flex-1 font-serif text-[25px] leading-tight font-semibold lg:text-[20px] lg:leading-[1.45]">
              {STEM_LINES.map((w, i) => (
                <span key={i} className={`block ${i >= 3 ? "lg:hidden" : ""}`}>
                  <Bar className={w} />
                </span>
              ))}
            </div>
          </div>
          <p className="hidden min-h-11 items-center text-[13px] leading-snug lg:mt-auto lg:flex" data-skel="source">
            <Bar className="w-60" />
          </p>
        </div>

        <div className="flex flex-col gap-3.5 lg:w-[clamp(360px,40%,600px)] lg:flex-none lg:gap-[18px]">
          <div className="flex flex-col">
            {(["A", "B", "C", "D"] as const).map((l, i) => (
              <div key={l} data-skel="answer" className="flex min-h-[58px] items-center gap-3.5 border-b border-paper-rule px-1 lg:min-h-16 lg:gap-4 lg:px-1.5">
                <Oval letter={l} state="empty" size="responsive" />
                <span className="flex-1 font-serif text-[19px] lg:text-xl">
                  <Bar className={["w-1/2", "w-2/3", "w-2/5", "w-3/5"][i]} />
                </span>
              </div>
            ))}
          </div>

          <p className="flex min-h-9 items-center text-[13px] leading-snug text-print lg:hidden" data-skel="source-phone">
            <WhatsHappening bar="w-52" />
          </p>

          <div className="hidden flex-col gap-2 lg:flex" aria-hidden="true">
            <div className="text-sm font-bold">
              <Bar className="w-32" />
            </div>
            <div className="flex gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="min-h-11 flex-1 rounded-lg border-[1.5px] border-print/40" />
              ))}
            </div>
          </div>

          <div className="mt-auto flex flex-col gap-2.5">
            <div className="flex gap-2.5">
              <div data-skel="check" className="skeleton min-h-14 min-w-0 flex-1 rounded-[10px] bg-print/20" />
              <div data-skel="skip" className="skeleton min-h-14 w-[150px] flex-none rounded-[10px] bg-print/20" />
            </div>
            <span className="hidden min-h-6 items-center text-[13px] text-print lg:flex">
              <WhatsHappening bar="w-40" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A bar for the first 3 seconds, then one line saying what's happening, in the same line box. */
function WhatsHappening({ bar }: { bar: string }) {
  return (
    <span className="relative inline-block">
      <span className="until-3s absolute inset-0">
        <Bar className={bar} />
      </span>
      <span className="after-3s">Getting the practice set ready…</span>
    </span>
  );
}
