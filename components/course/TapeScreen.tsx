"use client";

// The course tape screen (docs/design/CourseTape.dc.html at 1280; the phone winds the tape top to
// bottom with the route in a bottom sheet). The server builds the tape (lib/course); here the
// practice attempts kept in this browser are merged in (they never leave the device), which can
// change "missed" and the route. Tapping a stop opens its sources; "Start the route back" plays the
// route's real clips.

import { MissMark } from "./MissMark";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ClearPracticeData, ExampleBadge, useExampleHistory } from "@/components/attempts/PracticeData";
import { useAttempts } from "@/lib/attempts/client";
import type { ExampleSeed } from "@/lib/attempts/examples";
import { hasExampleEvidence, mergeAttempts } from "@/lib/course/attempts";
import { anyGlow } from "@/lib/course/geometry";
import { deskFrame } from "@/lib/course/tapeLayout";
import type { ClipContext, CourseTape, Stop } from "@/lib/course/types";
import { prefersReducedMotion } from "@/lib/motion";
import { ClipMedia } from "./ClipPlayer";
import { RoutePanel, StartRoute } from "./RoutePanel";
import { RoutePlayer } from "./RoutePlayer";
import { Sheet } from "./Sheet";
import { StopDetails } from "./StopDetails";
import { TapeColumn } from "./TapeColumn";
import { TapeDeck } from "./TapeDeck";
import { clipWhen, dayLabel, mmss, shellOf } from "./shared";

const noopSubscribe = () => () => {};
const DESKTOP = "(min-width: 1024px)";

/** Glow, the miss count and bright tape, said once: a quiet row under the tape on desktop, above the column on the phone.
 * The glow line shows only when at least one stop glows. */
function Legend({ glows }: { glows: boolean }) {
  return (
    <ul aria-label="How to read the tape" className="m-0 flex list-none flex-wrap items-center justify-center gap-x-6 gap-y-2 p-0 text-[13px] text-label-muted">
      {glows ? (
        <li data-glow-legend="" className="flex items-center gap-2">
          <span aria-hidden="true" className="h-4 w-[26px] flex-none rounded-full" style={{ background: "radial-gradient(closest-side, rgba(250,70,22,0.85), rgba(233,180,60,0.35) 60%, rgba(233,180,60,0))" }} />
          <span>
            <b className="text-label">Glow:</b> your professor flagged it
          </span>
        </li>
      ) : null}
      <li className="flex items-center gap-2">
        <MissMark />
        <span>= times you missed it</span>
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden="true" className="h-[6px] w-[18px] flex-none rounded-[3px] bg-tape-ribbon" />
        <span>
          <b className="text-label">Bright tape:</b> lectures so far
        </span>
      </li>
    </ul>
  );
}

/** The example-history label, short enough that the side panel fits one 1280 x 800 screen. */
function ExampleNote({ quiet = false }: { quiet?: boolean }) {
  return (
    <p role="note" className={`m-0 max-w-[70ch] text-[14px] leading-snug ${quiet ? "text-center text-label-muted" : "rounded-lg border border-tape-blank-label px-3 py-2"}`}>
      <ExampleBadge /> Example answers so the tape has misses to show, not a real student&apos;s. They go when you answer.
    </p>
  );
}

function Title() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="m-0 font-display text-[40px] leading-none font-extrabold tracking-[-1.2px]">Course tape</h1>
      <p className="m-0 text-[15px] leading-[1.4] text-label-muted">The whole semester on one tape. Rewind it to the stops that matter.</p>
    </div>
  );
}

/** "Oct 22 lecture · Stop 1 of 3 tonight · On the next exam": one line under a stop's title. */
function stopMeta(s: Stop, rank: number | undefined, steps: number): string {
  return [s.firstTaughtAt ? `${dayLabel(s.firstTaughtAt)} lecture` : null, rank ? `Stop ${rank} of ${steps} tonight` : null, s.onNextExam === true ? "On the next exam" : null].filter(Boolean).join(" · ");
}

/** "Route back · Stop 1 of 3 · Oct 13 · 38:04": one line under the route stop's title. */
function routeMeta(tape: CourseTape, i: number): string {
  const step = tape.route.steps[i];
  return [`Route back · Stop ${step.rank} of ${tape.route.steps.length}`, step.play.kind === "clip" ? clipWhen(step.play.clip) : null].filter(Boolean).join(" · ");
}

export function TapeScreen({
  tape: serverTape,
  clips,
  examples,
  extensionId,
  media = null,
  practicePath = null,
  exam = null,
}: {
  tape: CourseTape;
  clips: Record<string, ClipContext>;
  examples: ExampleSeed | null;
  extensionId: string;
  /** Demo mode: the hosted clips by tape clip id; every other clip shows its transcript. */
  media?: Record<string, { src: string; offset: number }> | null;
  /** Where a lecture's practice opens, followed by its date (the demo: "/demo/practice/"), or null for none. */
  practicePath?: string | null;
  /** The demo's next-exam card (components/demo/DemoExamCard.tsx), under the route; null for none. */
  exam?: ReactNode;
}) {
  const course = serverTape.course.code;
  useExampleHistory(course, examples);
  const attempts = useAttempts(course);
  const tape = useMemo(() => mergeAttempts(serverTape, attempts), [serverTape, attempts]);
  const ranks = useMemo(() => new Map(tape.route.steps.map((s) => [s.stopId, s.rank])), [tape]);
  const glows = anyGlow(tape.stops);
  const shell = useMemo(() => shellOf(tape), [tape]);
  const [stopId, setStopId] = useState<string | null>(null);
  const [routeAt, setRouteAt] = useState<number | null>(null);
  const [routeSheet, setRouteSheet] = useState(false);
  const [allNotes, setAllNotes] = useState(false);
  // The route back on desktop: the tape head travels back to the step's stop first, then its clip opens.
  const [rewindTo, setRewindTo] = useState<string | null>(null);
  const pending = useRef<number | null>(null);
  // The browser's attempts arrive after the first paint. Until then, the example note shows whenever this course
  // has example history to seed (what it will show), so the side panel doesn't shift when the note arrives.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const showsExamples = hydrated ? hasExampleEvidence(tape) : examples !== null;
  const canStart = tape.route.steps.length > 0;
  const travelling = rewindTo !== null && routeAt === null;
  const play = (i: number) => {
    setRouteSheet(false);
    setRouteAt(i);
  };
  const start = (i: number) => {
    const step = tape.route.steps[i];
    if (!step || travelling) return;
    // The phone has no deck (and reduced motion no travel): the clip opens at once.
    if (tape.here.position === null || prefersReducedMotion() || !window.matchMedia?.(DESKTOP).matches) {
      setRewindTo(step.stopId);
      play(i);
      return;
    }
    pending.current = i;
    setRewindTo(step.stopId);
  };
  const arrived = () => {
    if (pending.current === null) return;
    const i = pending.current;
    pending.current = null;
    play(i);
  };
  // While the route plays, the head (behind the player) follows its step; closing it sends the head home.
  const toStep = (i: number) => {
    setRouteAt(i);
    setRewindTo(tape.route.steps[i]?.stopId ?? null);
  };
  const closeRoute = () => {
    setRouteAt(null);
    setRewindTo(null);
  };

  // Desktop: the screen fills the window below whatever header sits above it, so the page never scrolls.
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const fit = () => {
      const top = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY));
      el.style.setProperty("--tape-screen-h", `calc(100dvh - ${top}px)`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  const frame = deskFrame(tape.stops.length);
  // The data notes are a small "About this ranking" disclosure right under the route (above the fold); practice data closes the panel.
  const practiceData = (
    <section aria-label="Your practice data" className="min-w-0 basis-full text-[14px] text-label-muted [&_.btn]:shrink-0 [&_.btn]:whitespace-nowrap">
      <ClearPracticeData course={course} />
    </section>
  );
  const notes = tape.notes.length ? (
    <details className="text-[13px] text-label-muted">
      <summary className="btn btn-tertiary -ml-2 list-none text-label marker:hidden [&::-webkit-details-marker]:hidden">About this ranking</summary>
      <ul className="m-0 flex max-w-[70ch] flex-col gap-1 pl-5">
        {(allNotes ? tape.notes : tape.notes.slice(0, 3)).map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {tape.notes.length > 3 && !allNotes ? (
        <button type="button" onClick={() => setAllNotes(true)} className="btn btn-tertiary text-sm">
          +{tape.notes.length - 3} more
        </button>
      ) : null}
    </details>
  ) : null;

  return (
    <ClipMedia value={media}>
      {/* One main. Desktop: one tape in the middle of a calm frame (at most 1200 px of content, 40 px from the
          window's edges), the side panel beside it at 420 px, both centred in the window's height. Phone: the tape
          winds top to bottom and the route opens as a bottom sheet. Practice data is rendered once, at the end of
          the side panel. */}
      <main ref={mainRef} data-tape-screen="" className="tape-screen flex flex-col px-4 pt-5 pb-28 lg:px-10 lg:py-6">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)] lg:items-center lg:gap-x-12">
          <div className="flex flex-col gap-4 lg:hidden">
            <Title />
            {showsExamples ? <ExampleNote /> : null}
            <Legend glows={glows} />
            <TapeColumn tape={tape} ranks={ranks} onStop={setStopId} />
          </div>
          <div className="hidden min-h-0 flex-col items-center justify-center gap-4 lg:flex">
            {/* The deck keeps its shape and fits the window's height under the legend (and the example note). */}
            <div className="w-full" style={{ maxWidth: `min(${frame.width}px, calc((var(--tape-screen-h, calc(100dvh - var(--demo-header-h, 0px))) - ${showsExamples ? 166 : 104}px) * ${frame.width} / ${frame.height}))` }}>
              <TapeDeck tape={tape} ranks={ranks} onStop={setStopId} rewindTo={rewindTo} onArrive={arrived} />
            </div>
            <div className="flex w-full max-w-[740px] flex-col items-center gap-3">
              <Legend glows={glows} />
              {showsExamples ? <ExampleNote quiet /> : null}
            </div>
          </div>
          <aside className="tape-scroll flex min-w-0 flex-col gap-5 lg:max-h-full lg:overflow-y-auto lg:py-1 lg:pr-2">
            <div className="hidden flex-col gap-5 lg:flex">
              <Title />
              <div className="flex flex-col gap-3">
                <RoutePanel tape={tape} shell={shell} onPlay={start} />
                <StartRoute disabled={!canStart || travelling} onStart={() => start(0)} />
                {notes}
              </div>
            </div>
            {exam}
            <div className="flex flex-wrap items-start gap-x-4 gap-y-1 border-tape-blank lg:border-t lg:pt-3">
              {practiceData}
            </div>
          </aside>
        </div>
        <div data-route-bar="" className="fixed inset-x-0 bottom-0 z-20 border-t border-tape-blank bg-deck/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setRouteSheet(true)}
            className="tape-lift flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border-2 border-label px-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-label"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-[16px] font-bold">Tonight&apos;s route back</span>
              <span className="text-[13px] text-label-muted">
                {tape.route.steps.length} stop{tape.route.steps.length === 1 ? "" : "s"} · {mmss(tape.totals.listenSec)} of lecture
              </span>
            </span>
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5 flex-none text-label">
              <path d="M5 12.5 10 7.5l5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </main>

      <Sheet open={routeSheet} onClose={() => setRouteSheet(false)} label="Tonight's route back" heading="Tonight's route back">
        <div className="flex flex-col gap-3">
          <RoutePanel tape={tape} shell={shell} onPlay={start} heading={false} />
          <StartRoute disabled={!canStart} onStart={() => start(0)} />
        </div>
      </Sheet>

      {tape.stops.map((s) => (
        <Sheet key={s.id} open={stopId === s.id} onClose={() => setStopId(null)} label={s.topic} heading={s.topic} meta={stopMeta(s, ranks.get(s.id), tape.route.steps.length)}>
          <StopDetails
            tapeGlows={glows}
            stop={s}
            context={s.clips[0] ? clips[s.clips[0].id] : undefined}
            extensionId={extensionId}
            accent={shell(s)}
            practiceHref={practicePath && s.firstTaughtAt ? `${practicePath}${s.firstTaughtAt}` : null}
          />
        </Sheet>
      ))}

      <Sheet
        open={routeAt !== null}
        onClose={closeRoute}
        label="Route back"
        wide
        heading={routeAt !== null ? tape.route.steps[routeAt]?.topic : undefined}
        meta={routeAt !== null && tape.route.steps[routeAt] ? routeMeta(tape, routeAt) : undefined}
      >
        {routeAt !== null ? <RoutePlayer tape={tape} index={routeAt} clips={clips} extensionId={extensionId} onIndex={toStep} onDone={closeRoute} /> : null}
      </Sheet>
    </ClipMedia>
  );
}
