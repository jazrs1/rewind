// hosted-media source: a clip we host (demo mode), in a <video> (the professor's screen share)
// or an <audio> element that the player component renders and hands over.

import { createStore, INITIAL_STATE, type PlayerSource, type PlayerState } from "./types.ts";

/** Video files get a <video> element; anything else plays as audio. */
export function isVideo(src: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src);
}

/** The slice of HTMLMediaElement we use, so tests can pass a fake. */
export interface MediaLike extends EventTarget {
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  readonly duration: number;
  readyState: number;
  preload: string;
  play(): Promise<void>;
  pause(): void;
}

/** Animation frames, injectable so tests can step them. */
export interface Frames {
  request(cb: () => void): number;
  cancel(id: number): void;
}

const browserFrames: Frames | null =
  typeof requestAnimationFrame === "function" ? { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) } : null;

const HAVE_METADATA = 1;

/** The error a clip that won't load reports; the player falls back to the clip's transcript lines. */
export const LOAD_FAILED = "Couldn't load the recording.";
/** How long a clip gets to load (metadata) before it counts as failed, so the player never waits forever. */
export const LOAD_TIMEOUT_MS = 10_000;

/** The error a demo clip without hosted media reports from the start; the player shows the clip's transcript. */
export const NOT_HOSTED = "The demo doesn't host the recording for this clip.";

/** demo mode, no hosted file for this clip: nothing to play, so the player goes straight to the transcript. */
export function createNoMediaSource(): PlayerSource {
  const store = createStore<PlayerState>({ ...INITIAL_STATE, error: NOT_HOSTED });
  return {
    kind: "none",
    getState: store.get,
    subscribe: store.subscribe,
    async play() {},
    async pause() {},
    async seek() {},
    async setRate() {},
    dispose() {},
  };
}

/**
 * While playing, currentTime is read every frame and the state is sampled the moment its whole second changes
 * (the tape counter's last digit), so the counter turns over with the audio instead of at the next timeupdate
 * (only about 4 a second, and late after a seek or a stall). timeupdate still samples in between.
 */
export function createHostedMediaSource(
  audio: MediaLike,
  now: () => number = () => performance.now(),
  frames: Frames | null = browserFrames,
  loadTimeoutMs: number = LOAD_TIMEOUT_MS,
  /** The lecture second the file starts at: state and seeks are in lecture time, the element in file time. */
  offset = 0,
): PlayerSource {
  const store = createStore<PlayerState>({ ...INITIAL_STATE });
  audio.preload = "auto";
  // A media error, no network, or a download that never gets going: not ready in time counts as failed.
  const loadTimer = setTimeout(() => {
    if (!store.get().ready && !store.get().error) fail();
  }, loadTimeoutMs);
  const ready = () => {
    clearTimeout(loadTimer);
    sample({ ready: true });
  };
  const fail = () => {
    clearTimeout(loadTimer);
    stopFrames();
    sample({ error: LOAD_FAILED });
  };

  const sample = (patch: Partial<PlayerState> = {}) =>
    store.set({
      currentTime: audio.currentTime + offset,
      paused: audio.paused,
      rate: audio.playbackRate,
      duration: Number.isFinite(audio.duration) ? audio.duration + offset : null,
      sampledAt: now(),
      ...patch,
    });

  let frame: number | null = null;
  const stopFrames = () => {
    if (frame !== null) frames?.cancel(frame);
    frame = null;
  };
  const onFrame = () => {
    frame = null;
    if (!frames || audio.paused) return;
    if (Math.floor(audio.currentTime + offset) !== Math.floor(store.get().currentTime)) sample();
    frame = frames.request(onFrame);
  };
  const startFrames = () => {
    if (frames && frame === null && !audio.paused) frame = frames.request(onFrame);
  };

  const handlers: Record<string, () => void> = {
    loadedmetadata: ready,
    canplay: ready,
    timeupdate: () => sample(),
    seeked: () => sample(),
    play: () => {
      sample({ needsGesture: false });
      startFrames();
    },
    // Playback has really started (after play, or after waiting for data): sample from here.
    playing: () => {
      sample();
      startFrames();
    },
    pause: () => {
      stopFrames();
      sample();
    },
    ratechange: () => sample(),
    ended: () => {
      stopFrames();
      sample();
    },
    error: fail,
  };
  for (const [ev, fn] of Object.entries(handlers)) audio.addEventListener(ev, fn);
  if (audio.readyState >= HAVE_METADATA) ready();

  return {
    kind: "hosted-media",
    getState: store.get,
    subscribe: store.subscribe,
    async play(from) {
      if (from !== undefined) audio.currentTime = Math.max(0, from - offset);
      try {
        await audio.play();
      } catch (err) {
        const name = (err as { name?: string })?.name;
        // Autoplay policy: the student has to press play. AbortError: a pause or a new source interrupted it.
        if (name === "NotAllowedError") sample({ needsGesture: true });
        else if (name !== "AbortError") fail();
      }
    },
    async pause() {
      audio.pause();
    },
    async seek(seconds) {
      audio.currentTime = Math.max(0, seconds - offset);
      sample();
    },
    async setRate(rate) {
      audio.playbackRate = rate;
    },
    dispose() {
      clearTimeout(loadTimer);
      stopFrames();
      for (const [ev, fn] of Object.entries(handlers)) audio.removeEventListener(ev, fn);
      audio.pause();
    },
  };
}
