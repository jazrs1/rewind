// Clip rules on top of any PlayerSource: start at the clip, stop at its end unless the
// student chose "Keep listening", back 10 s, speed steps, and which caption line is current.

import type { TranscriptSegment } from "../schema.ts";
import { createStore, liveTime, type PlayerSource, type PlayerState } from "./types.ts";

export interface Clip {
  start: number;
  end: number;
}

export const RATES = [1, 1.25, 1.5] as const;
export const SKIP_SEC = 10;

export function nextRate(rate: number): number {
  const i = RATES.findIndex((r) => Math.abs(r - rate) < 0.01);
  return RATES[(i + 1) % RATES.length];
}

export function clipProgress(clip: Clip, t: number) {
  const total = Math.max(0, clip.end - clip.start);
  const elapsed = Math.min(total, Math.max(0, t - clip.start));
  return { total, elapsed, left: total - elapsed, fraction: total ? elapsed / total : 0 };
}

/** Index of the line being spoken at `t`: the last one that started at or before it. */
export function captionIndex(segments: TranscriptSegment[], t: number): number {
  let idx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start <= t + 0.05) idx = i;
    else break;
  }
  return idx;
}

export interface ClipState {
  player: PlayerState;
  /** Playback reached the clip's end and stopped there. */
  ended: boolean;
  keepListening: boolean;
  /** The source has reported a position at the clip start (or is playing). Until then, the
   * counter and captions show the clip start, not whatever the recording reports (often 0:00). */
  cued: boolean;
}

/** How close (seconds) the source must be to the clip start for it to count as cued. */
export const CUE_TOLERANCE = 1;

function isCued(player: PlayerState, clip: Clip): boolean {
  return player.ready && (!player.paused || Math.abs(player.currentTime - clip.start) <= CUE_TOLERANCE);
}

/** The time the counter and captions show: the clip start until the source is cued there. */
export function displayTime(s: ClipState, clip: Clip, now: number): number {
  return s.player.ready && s.cued ? liveTime(s.player, now) : clip.start;
}

export function createClipController(source: PlayerSource, clip: Clip, now: () => number = () => performance.now()) {
  const first = source.getState();
  const store = createStore<ClipState>({ player: first, ended: false, keepListening: false, cued: isCued(first, clip) });

  const unsubscribe = source.subscribe(() => {
    const player = source.getState();
    const { keepListening, ended } = store.get();
    const cued = store.get().cued || isCued(player, clip);
    const t = liveTime(player, now());
    if (!keepListening && !player.paused && t >= clip.end) {
      void source.pause();
      store.set({ player, ended: true, cued });
      return;
    }
    // A file trimmed to the clip stops by itself at its end (already paused when sampled): that's the clip's end too.
    const ranOut = player.paused && player.duration != null && t >= player.duration - 0.25 && t >= clip.end - 0.5;
    if (!keepListening && ranOut) {
      store.set({ player, ended: true, cued });
      return;
    }
    store.set({ player, ended: ended && player.paused, cued });
  });

  return {
    getState: store.get,
    subscribe: store.subscribe,
    /** Get the clip ready without playing (preload). */
    cue: () => source.seek(clip.start),
    /** Plays from the clip start (the rewind, or while not yet cued there), or resumes. */
    play: (fromStart = false) => {
      const { ended, keepListening, cued } = store.get();
      store.set({ ended: false });
      return source.play(fromStart || !cued || (ended && !keepListening) ? clip.start : undefined);
    },
    pause: () => source.pause(),
    toggle() {
      return store.get().player.paused ? this.play() : source.pause();
    },
    back: () => source.seek(Math.max(0, liveTime(source.getState(), now()) - SKIP_SEC)),
    forward: () => source.seek(liveTime(source.getState(), now()) + SKIP_SEC),
    cycleRate: () => source.setRate(nextRate(source.getState().rate)),
    keepListening() {
      store.set({ keepListening: true, ended: false });
      return source.play();
    },
    seekTo: (seconds: number) => source.seek(seconds),
    dispose: unsubscribe,
  };
}

export type ClipController = ReturnType<typeof createClipController>;

/**
 * Whether the caption band under the picture shows. Our hosted clips are Zoom recordings with the captions burned in,
 * so while one plays the band would say every line twice: the transcript's active line is the caption instead.
 */
export function showsCaptionBand(o: { slide: boolean; failed: boolean; hostedVideo: boolean }): boolean {
  return o.slide && !o.failed && !o.hostedVideo;
}

/** A transcript row's height (min-h-11) and the panel's vertical padding (py-2). */
export const TRANSCRIPT_LINE_H = 44;
export const TRANSCRIPT_PAD_Y = 16;

/** The transcript list's height for `lines` whole rows, padding included: a whole multiple of the row, so the bottom
 *  edge falls on a line boundary as well as the top. */
export function transcriptPanelHeight(lines: number): number {
  return lines * TRANSCRIPT_LINE_H + TRANSCRIPT_PAD_Y;
}

/** Rows shown under a hosted video: 3 on a short screen (under 900 px tall, e.g. 1280x800), 5 otherwise. The video
 *  never shrinks for them; the transcript gives up the lines instead (John, Oct 25). */
export function hostedTranscriptLines(viewportHeight: number): number {
  return viewportHeight < 900 ? 3 : 5;
}

/**
 * Where the transcript list scrolls so line `i` is whole in view, always on a row boundary (null: it already is, so
 * nothing moves). The line he's on goes to the top, with the line before it above when both fit whole, so the top
 * row is never cut and a long paragraph taller than the box shows from its first words. Rows are px in the list's content.
 */
export function lineScrollTarget(rows: readonly { top: number; height: number }[], i: number, view: { scrollTop: number; height: number }): number | null {
  const line = rows[i];
  if (!line) return null;
  if (line.top >= view.scrollTop - 0.5 && line.top + line.height <= view.scrollTop + view.height + 0.5) return null;
  const prev = rows[i - 1];
  const top = prev && line.top + line.height - prev.top <= view.height ? prev.top : line.top;
  return Math.max(0, Math.floor(top));
}
