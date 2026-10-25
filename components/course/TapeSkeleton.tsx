// The course tape while it loads (PLAN, Usability: each screen's own layout in placeholder shapes), in
// the same boxes as TapeScreen so nothing moves when it swaps in: on desktop the centred frame with the tape
// panel (three blank rows) and its legend row beside the 420 px side panel (title, route tapes, Start, the
// practice-data row); on the phone the wound column of blank stops and the route bar. The shimmer is the
// shared .skeleton glint (static with reduced motion).

import { deskFrame } from "@/lib/course/tapeLayout";

const Bar = ({ className }: { className: string }) => <span aria-hidden="true" className={`skeleton block rounded-[3px] bg-deck-raised ${className}`} />;

function Title() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="m-0 font-display text-[40px] leading-none font-extrabold tracking-[-1.2px]">Course tape</h1>
      <p className="m-0 text-[15px] leading-[1.4] text-label-muted">The whole semester on one tape. Rewind it to the stops that matter.</p>
    </div>
  );
}

export function TapeSkeleton() {
  const f = deskFrame(3);
  return (
    <main aria-busy="true" aria-label="Loading the course tape" className="tape-screen flex flex-col px-4 pt-5 pb-28 lg:px-10 lg:py-6">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)] lg:items-center lg:gap-x-12">
        <div className="flex flex-col gap-4 lg:hidden">
          <Title />
          <Bar className="h-[24px] rounded" />
          <div data-skel="column" className="flex h-[990px] flex-col gap-2 overflow-hidden rounded-xl bg-panel px-3 py-4">
            {Array.from({ length: 14 }, (_, i) => (
              <span key={i} aria-hidden="true" className="flex min-h-14 items-center">
                <span className="ml-[38px] h-14 w-4 bg-tape-blank" />
                <span className="ml-[38px] flex flex-1 flex-col gap-2">
                  <Bar className="h-4 w-2/3" />
                  <Bar className="h-3 w-1/3" />
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="hidden min-h-0 flex-col items-center justify-center gap-4 lg:flex">
          <div className="w-full" style={{ maxWidth: `min(${f.width}px, calc((var(--tape-screen-h, calc(100dvh - var(--demo-header-h, 0px))) - 104px) * ${f.width} / ${f.height}))` }}>
            <section className="skeleton relative w-full overflow-hidden rounded-2xl bg-panel" style={{ aspectRatio: `${f.width} / ${f.height}` }}>
              {f.rows.map((y) => (
                <span
                  key={y}
                  aria-hidden="true"
                  className="absolute h-[3%] rounded bg-tape-blank"
                  style={{ left: `${((f.x0 - f.r) / f.width) * 100}%`, right: `${((f.width - f.x1 - f.r) / f.width) * 100}%`, top: `${(y / f.height) * 100 - 1.5}%` }}
                />
              ))}
            </section>
          </div>
          <Bar className="h-5 w-[420px] rounded" />
        </div>
        <aside className="flex min-w-0 flex-col gap-5">
          <div className="hidden flex-col gap-5 lg:flex">
            <Title />
            <div className="flex flex-col gap-3">
              <Bar className="h-10 w-56" />
              {[0, 1, 2].map((i) => (
                <span key={i} aria-hidden="true" className="skeleton flex h-[50px] items-center rounded-lg bg-tape-blank px-[6px]">
                  <span className="h-9 flex-1 rounded bg-tape-blank-label/60" />
                </span>
              ))}
              <Bar className="h-10 w-64" />
              <span data-skel="start" aria-hidden="true" className="skeleton block h-14 rounded-[10px] bg-deck-raised" />
              <Bar className="h-9 w-full" />
            </div>
          </div>
          <div className="flex h-[92px] flex-col gap-2 lg:h-[88px]">
            <Bar className="h-11 w-56 rounded" />
            <Bar className="h-4 w-3/4" />
          </div>
        </aside>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-tape-blank bg-deck px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] lg:hidden">
        <Bar className="h-14 rounded-[10px]" />
      </div>
    </main>
  );
}
