// Loading state for the exam radar: the list's own layout on the deck, in blank grey tape.
// Boxes mirror RadarList's with the same classes and text becomes bars inside lines of the same font,
// so nothing moves when the list swaps in. The header's fixed copy is real.

import { DeckBar, LateLine } from "@/components/rewind/DeckSkeleton";

/** Widths of the filter chips (All plus one per kind). */
const CHIPS = ["w-[72px]", "w-[104px]", "w-[118px]", "w-[150px]", "w-[96px]"];
/** Quote lines per card on a phone and on desktop, as the demo lecture's first moments wrap. */
const CARDS: [phone: number, desktop: number][] = [
  [6, 3],
  [6, 3],
  [3, 1],
  [4, 2],
];

function Lines({ phone, desktop, last }: { phone: number; desktop: number; last: string }) {
  return Array.from({ length: phone }, (_, j) => (
    <span key={j} className={`block ${j >= desktop ? "lg:hidden" : ""}`}>
      <DeckBar className={j === phone - 1 ? last : j === desktop - 1 ? "w-full lg:w-3/4" : "w-full"} />
    </span>
  ));
}

export function RadarSkeleton() {
  return (
    <main aria-busy="true" aria-label="Loading the exam radar" className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-5 px-5 py-6 text-label lg:px-8 lg:py-10">
      <header className="flex flex-col gap-2">
        <a href="/practice" className="btn btn-tertiary self-start">
          ← Practice
        </a>
        <h1 className="font-display text-4xl font-extrabold tracking-tight lg:text-5xl">Exam radar</h1>
        <p className="text-label-muted" data-skel="intro">
          <span className="block">
            <DeckBar className="w-full" />
          </span>
          <span className="block lg:hidden">
            <DeckBar className="w-full" />
          </span>
          <span className="block">
            <LateLine bar="w-40 lg:w-52">Loading the lecture&apos;s flagged moments…</LateLine>
          </span>
        </p>
      </header>

      <div className="flex flex-wrap gap-2" data-skel="chips">
        {CHIPS.map((w, i) => (
          <span key={i} className={`skeleton min-h-11 rounded-[10px] bg-tape-blank ${w}`} />
        ))}
      </div>

      <ol className="flex flex-col gap-3">
        {CARDS.map(([phone, desktop], i) => (
          <li key={i} data-skel="card" className="flex flex-col gap-3 rounded-xl bg-deck-raised px-4 py-3.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-display text-[22px] leading-none font-extrabold">
                <DeckBar className="w-[3.2em]" />
              </span>
              <span className="rounded-md px-2 py-0.5 text-xs font-bold">
                <DeckBar className="w-16" />
              </span>
            </div>
            <div className="text-base leading-snug">
              <Lines phone={phone} desktop={desktop} last={["w-2/5", "w-3/4", "w-1/2", "w-2/3"][i]} />
            </div>
            {/* The evidence's source line (SourceLabel: 13 px). */}
            <p data-source="" className="text-[13px] leading-snug">
              <Lines phone={2} desktop={1} last="w-3/5" />
            </p>
            <span className="min-h-12 w-[150px] self-start rounded-[10px] border-2 border-tape-blank" />
          </li>
        ))}
      </ol>
    </main>
  );
}
