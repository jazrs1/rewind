// Skeleton pieces for the tape deck: blank grey tape (tape-blank) in the shape of what's loading.
// Text placeholders sit inside a line of the real font, so line boxes keep their height when it swaps in.

import type { CSSProperties } from "react";

export function DeckBar({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton inline-block h-[0.7em] max-w-full rounded-[3px] bg-tape-blank align-middle ${className}`} />;
}

/** An empty slide inside the slide frame: a title and a few lines in faint slide ink. Fills the frame's content box. */
export function SlideFrameSkeleton() {
  return (
    <div aria-hidden="true" data-skel="slide" className="absolute inset-0 flex flex-col justify-center gap-[9%] px-[8%] pb-[6%]" style={{ "--skeleton-glint": "rgb(255 255 255 / 0.45)" } as CSSProperties}>
      <span className="skeleton h-[12%] w-1/2 rounded bg-slide-ink/15" />
      <span className="skeleton h-[7%] w-5/6 rounded bg-slide-ink/15" />
      <span className="skeleton h-[7%] w-3/4 rounded bg-slide-ink/15" />
      <span className="skeleton h-[7%] w-2/3 rounded bg-slide-ink/15" />
    </div>
  );
}

/** A bar for the first 3 seconds, then one line saying what's happening, in the same line box (PLAN, Usability). */
export function LateLine({ bar, children }: { bar: string; children: string }) {
  return (
    <span className="relative inline-block max-w-full">
      <span className="until-3s absolute inset-0 overflow-hidden">
        <DeckBar className={bar} />
      </span>
      <span className="after-3s">{children}</span>
    </span>
  );
}
