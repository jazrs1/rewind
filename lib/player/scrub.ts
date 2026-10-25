// The clip's scrub bar, as pure rules: where a point on the track lands (the clip window only), what the
// arrow keys do, what a screen reader hears, and the throttle that keeps a drag's seeks to about 4 a second
// (leading and trailing, plus a final seek on release). The seeks themselves go through source.seek.

import { formatTime } from "../format.ts";
import type { Clip } from "./clip.ts";

/** At most one seek per this many ms while dragging (about 4 a second). */
export const SCRUB_SEEK_MS = 250;
export const KEY_STEP_SEC = 5;
export const KEY_BIG_STEP_SEC = 15;

const clampTo = (clip: Clip, t: number) => Math.min(clip.end, Math.max(clip.start, t));

/** The time at `fraction` (0..1, clamped) of the way along the clip. */
export function clipTimeAt(clip: Clip, fraction: number): number {
  return clampTo(clip, clip.start + Math.min(1, Math.max(0, fraction)) * (clip.end - clip.start));
}

/** Where a key moves the scrub from `t`: Left/Right 5 s (15 s with Shift), Home/End the clip's ends. Null: not ours. */
export function keyTarget(clip: Clip, t: number, key: string, shift: boolean): number | null {
  const step = shift ? KEY_BIG_STEP_SEC : KEY_STEP_SEC;
  if (key === "ArrowLeft" || key === "ArrowDown") return clampTo(clip, t - step);
  if (key === "ArrowRight" || key === "ArrowUp") return clampTo(clip, t + step);
  if (key === "Home") return clip.start;
  if (key === "End") return clip.end;
  return null;
}

function spokenSeconds(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const secs = `${r} second${r === 1 ? "" : "s"}`;
  return m ? `${m} minute${m === 1 ? "" : "s"}${r ? ` ${secs}` : ""}` : secs;
}

/** "15:42, 24 seconds into the clip." */
export function scrubValueText(clip: Clip, t: number): string {
  return `${formatTime(t)}, ${spokenSeconds(clampTo(clip, t) - clip.start)} into the clip.`;
}

/**
 * Throttles seeks: the first goes at once, then at most one per `intervalMs`, always ending on the latest
 * target. `flush` sends the final one now. `onIdle` runs once every seek sent has settled and none is waiting.
 */
export function createSeekThrottle(
  seek: (t: number) => Promise<void>,
  opts: {
    intervalMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
    onIdle?: () => void;
  } = {},
) {
  const intervalMs = opts.intervalMs ?? SCRUB_SEEK_MS;
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let lastAt = -Infinity;
  let pending: number | null = null;
  let timer: unknown = null;
  let inflight = 0;
  let disposed = false;

  function send(t: number): Promise<void> {
    lastAt = now();
    pending = null;
    inflight++;
    const done = () => {
      inflight--;
      if (!disposed && inflight === 0 && pending === null && timer === null) opts.onIdle?.();
    };
    const p = seek(t);
    p.then(done, done);
    return p;
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  return {
    /** A new target while dragging (or a key press): sent now if the last seek is old enough, else at the next slot. */
    request(t: number) {
      pending = t;
      if (timer !== null) return;
      const wait = lastAt + intervalMs - now();
      if (wait <= 0) {
        void send(t);
        return;
      }
      timer = setTimer(() => {
        timer = null;
        if (pending !== null && !disposed) void send(pending);
      }, wait);
    },
    /** Release: the final seek, now. */
    flush(t: number): Promise<void> {
      cancelTimer();
      return send(t);
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}

export type SeekThrottle = ReturnType<typeof createSeekThrottle>;
