"use client";

// Tonight's route back (CourseTape mockup, lines 114-137): the top stops as tapes, each with its
// number, topic and the lecture time it plays; the total listening time; "Start the route back"
// (the one orange button), which plays the route's real clips in order. Example practice history
// is labelled on any stop it counts in.


import type { CourseTape, RouteStep, Stop } from "@/lib/course/types";
import { clipWhen, mmss } from "./shared";

function stepWhen(step: RouteStep): string {
  if (step.play.kind === "clip") return clipWhen(step.play.clip);
  if (step.play.kind === "fallback") return "no recording: slides";
  return "nothing to play: not found";
}

export function RoutePanel({ tape, shell, onPlay, heading = true }: { tape: CourseTape; shell(s: Stop): string; onPlay(index: number): void; heading?: boolean }) {
  const byId = new Map(tape.stops.map((s) => [s.id, s]));
  const steps = tape.route.steps;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-[2px]">
        {heading ? <h2 className="m-0 font-display text-[18px] leading-tight font-bold">Tonight&apos;s route back</h2> : null}
        <span className="text-[13px] leading-snug text-label-muted">{tape.route.label}</span>
      </div>
      {steps.length ? (
        <ol aria-label="Route back" className="m-0 flex list-none flex-col gap-2 p-0">
          {steps.map((step, i) => {
            const stop = byId.get(step.stopId)!;
            return (
              <li key={step.stopId} data-rank={step.rank} className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => onPlay(i)}
                  aria-describedby={`route-step-hint-${step.rank}`}
                  data-route-tape=""
                  className="tape-lift flex min-h-[50px] w-full items-center gap-[6px] rounded-lg px-[6px] py-[7px] text-left shadow-[inset_0_1px_0_rgb(255_255_255/0.3),inset_0_-2px_4px_rgb(0_0_0/0.2),0_4px_10px_-4px_rgb(0_0_0/0.55)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-label"
                  style={{ background: stop.module ? shell(stop) : "var(--color-tape-blank)" }}
                >
                  <span className="flex size-[30px] flex-none items-center justify-center rounded-full bg-action text-[14px] font-bold text-ink">{step.rank}</span>{" "}
                  <span className="flex min-h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded bg-label px-[10px] py-1 text-deck shadow-[0_0_0_2px_rgb(0_0_0/0.15),inset_0_1px_2px_rgb(0_0_0/0.2)]">
                    <span className={`min-w-0 font-sans font-bold leading-[1.2] ${step.topic.length > 26 ? "text-[14px]" : "text-[15px]"}`}>{step.topic}</span>{" "}
                    <span className="flex-none text-[13px] font-bold whitespace-nowrap text-tape-label-ink tabular-nums">{stepWhen(step)}</span>
                  </span>
                </button>
                <span id={`route-step-hint-${step.rank}`} className="sr-only">
                  Plays this stop&apos;s clip
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="m-0 text-[15px] text-label-muted">No taught topic has evidence yet, so there&apos;s no route back.</p>
      )}
      <p data-route-summary="" className="m-0 mt-1 flex items-baseline gap-2">
        <span className="font-display text-[40px] leading-none font-extrabold tabular-nums">{mmss(tape.totals.listenSec)}</span>
        <span className="text-[14px] text-label-muted">
          of lecture, then {tape.totals.questions} question{tape.totals.questions === 1 ? "" : "s"}
        </span>
      </p>
    </div>
  );
}

export function StartRoute({ disabled, onStart }: { disabled: boolean; onStart(): void }) {
  return (
    <div className="flex flex-col gap-[10px]">
      <button
        type="button"
        disabled={disabled}
        onClick={onStart}
        className="btn btn-primary btn-lg w-full"
      >
        Start the route back
      </button>
      <p className="m-0 text-[13px] leading-[1.45] text-label-muted">Ranked from what your professor stressed and what you miss. Evidence, not a prediction. Tap any stop to see why.</p>
    </div>
  );
}
