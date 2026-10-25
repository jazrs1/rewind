"use client";

// The route back, playing: each stop's real clip in route order (the rewind from a practice question
// when there is one, else where he flagged it, else his longest stretch on it), with Next stop to go
// on. A stop without a recording shows its slides, or says nothing was found.

import { SourceLabel } from "@/components/source/SourceLabel";
import type { ClipContext, CourseTape } from "@/lib/course/types";
import { ClipPlayer } from "./ClipPlayer";
import { shellOf } from "./shared";

const OUTLINED =
  "btn btn-secondary";

export function RoutePlayer({ tape, index, clips, extensionId, onIndex, onDone }: { tape: CourseTape; index: number; clips: Record<string, ClipContext>; extensionId: string; onIndex(i: number): void; onDone(): void }) {
  const steps = tape.route.steps;
  const step = steps[index];
  if (!step) return null;
  const last = index === steps.length - 1;
  return (
    // The stop's title and "Route back · Stop 1 of 3 · Oct 13 · 38:04" are the sheet's header row (with its ×).
    <div data-route-step={step.rank} className="flex flex-col gap-3 pt-3">
      {step.play.kind === "clip" ? (
        <ClipPlayer key={step.play.clip.id} clip={step.play.clip} context={clips[step.play.clip.id]} extensionId={extensionId} accent={shellOf(tape)(tape.stops.find((s) => s.id === step.stopId)!)} frameless />
      ) : step.play.kind === "fallback" ? (
        <SourceLabel tone="deck" link={step.play.fallback.href ? { href: step.play.fallback.href, label: "Open in Canvas" } : null}>
          No recording of it: the slides are {step.play.fallback.label}
        </SourceLabel>
      ) : (
        <p className="m-0 text-[15px] text-label-muted">No recording or slides of it: not found.</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {index > 0 ? (
          <button type="button" className={OUTLINED} onClick={() => onIndex(index - 1)}>
            Previous stop
          </button>
        ) : (
          <span />
        )}
        {last ? (
          <button type="button" className={OUTLINED} onClick={onDone}>
            Done
          </button>
        ) : (
          <button type="button" className={OUTLINED} onClick={() => onIndex(index + 1)}>
            Next stop
          </button>
        )}
      </div>
    </div>
  );
}
