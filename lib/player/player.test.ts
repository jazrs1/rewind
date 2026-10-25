import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captionIndex, clipProgress, createClipController, displayTime, hostedTranscriptLines, lineScrollTarget, nextRate, showsCaptionBand, transcriptPanelHeight } from "./clip";
import { createHostedMediaSource, createNoMediaSource, isVideo, LOAD_FAILED, NOT_HOSTED, type MediaLike } from "./hosted-media";
import { createZoomRemoteSource, type Reply } from "./zoom-remote";
import { createStore, INITIAL_STATE, liveTime, type PlayerSource } from "./types";

class FakeAudio extends EventTarget implements MediaLike {
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 120;
  readyState = 4;
  preload = "";
  blockPlay = false;
  async play() {
    if (this.blockPlay) throw Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  tick(t: number) {
    this.currentTime = t;
    this.dispatchEvent(new Event("timeupdate"));
  }
}

const segs = [10, 14, 20, 31].map((start) => ({ start, end: start + 4, speaker: "Lee", text: `at ${start}` }));

describe("caption band and transcript scroll", () => {
  it("hides the caption band while a hosted clip plays (Zoom's captions are burned in)", () => {
    expect(showsCaptionBand({ slide: true, failed: false, hostedVideo: true })).toBe(false);
    expect(showsCaptionBand({ slide: true, failed: false, hostedVideo: false })).toBe(true);
    expect(showsCaptionBand({ slide: true, failed: true, hostedVideo: false })).toBe(false);
    expect(showsCaptionBand({ slide: false, failed: false, hostedVideo: false })).toBe(false);
  });

  it("drops the hosted transcript to 3 lines under 900 px tall, 5 above", () => {
    expect(hostedTranscriptLines(800)).toBe(3);
    expect(hostedTranscriptLines(899)).toBe(3);
    expect(hostedTranscriptLines(900)).toBe(5);
    expect(hostedTranscriptLines(1080)).toBe(5);
    expect(transcriptPanelHeight(hostedTranscriptLines(800))).toBe(148);
  });

  it("sizes the transcript to a whole number of lines plus padding", () => {
    for (const n of [2, 3, 5, 6]) {
      const h = transcriptPanelHeight(n);
      expect(h).toBe(n * 44 + 16);
      expect((h - 16) % 44).toBe(0);
    }
  });

  const rows = [
    { top: 0, height: 44 },
    { top: 44, height: 44 },
    { top: 88, height: 44 },
    { top: 132, height: 44 },
    { top: 176, height: 300 }, // a long paragraph, taller than the box
    { top: 476, height: 44 },
  ];
  const view = { scrollTop: 0, height: 200 };

  it("leaves a line that is already whole in view", () => {
    expect(lineScrollTarget(rows, 2, view)).toBeNull();
  });

  it("scrolls on row boundaries, the line before it above", () => {
    expect(lineScrollTarget(rows, 3, { scrollTop: 0, height: 150 })).toBe(88);
    // The paragraph before it doesn't fit with it, so the line goes to the top alone.
    expect(lineScrollTarget(rows, 5, view)).toBe(476);
  });

  it("shows a paragraph taller than the box from its first words", () => {
    expect(lineScrollTarget(rows, 4, view)).toBe(176);
    // Already there: the same target, so the player doesn't move the list.
    expect(lineScrollTarget(rows, 4, { scrollTop: 176, height: 200 })).toBe(176);
  });

  it("goes back up to a line above the view", () => {
    expect(lineScrollTarget(rows, 1, { scrollTop: 132, height: 200 })).toBe(0);
  });
});

describe("clip helpers", () => {
  it("steps speed 1x, 1.25x, 1.5x and back", () => {
    expect([1, 1.25, 1.5].map(nextRate)).toEqual([1.25, 1.5, 1]);
  });
  it("reports progress clamped to the clip", () => {
    expect(clipProgress({ start: 10, end: 50 }, 22)).toEqual({ total: 40, elapsed: 12, left: 28, fraction: 0.3 });
    expect(clipProgress({ start: 10, end: 50 }, 5).elapsed).toBe(0);
  });
  it("finds the current caption line", () => {
    expect(captionIndex(segs, 9)).toBe(-1);
    expect(captionIndex(segs, 15)).toBe(1);
    expect(captionIndex(segs, 99)).toBe(3);
  });
  it("extrapolates time between samples only while playing", () => {
    const s = { ready: true, currentTime: 10, paused: false, rate: 1.5, duration: 60, needsGesture: false, error: null, sampledAt: 1000 };
    expect(liveTime(s, 3000)).toBe(13);
    expect(liveTime({ ...s, paused: true }, 3000)).toBe(10);
  });
});

describe("hosted-media + clip controller", () => {
  it("plays video files in a <video> and the rest as audio", () => {
    expect(isVideo("/demo/q1.mp4")).toBe(true);
    expect(isVideo("/demo/q1.mp4?v=2")).toBe(true);
    expect(isVideo("/demo/q1.mp3")).toBe(false);
  });

  it("plays from the clip start and stops at its end", async () => {
    const audio = new FakeAudio();
    const src = createHostedMediaSource(audio, () => 0);
    const c = createClipController(src, { start: 10, end: 50 }, () => 0);
    await c.play(true);
    expect(audio.currentTime).toBe(10);
    expect(c.getState().player.paused).toBe(false);
    audio.tick(49);
    expect(audio.paused).toBe(false);
    audio.tick(50.1);
    expect(audio.paused).toBe(true);
    expect(c.getState().ended).toBe(true);
    // Play again after the end replays the clip.
    await c.play();
    expect(audio.currentTime).toBe(10);
  });

  it("a clip cut from the lecture (offset): lecture time outside, file time on the element", async () => {
    const audio = new FakeAudio();
    const src = createHostedMediaSource(audio, () => 0, null, 10_000, 2056);
    const c = createClipController(src, { start: 2056, end: 2129 }, () => 0);
    await c.cue();
    expect(audio.currentTime).toBe(0);
    await c.play(true);
    expect(audio.currentTime).toBe(0);
    audio.tick(30);
    expect(c.getState().player.currentTime).toBe(2086);
    expect(c.getState().player.duration).toBe(2056 + 120);
    await src.seek(2000); // before the file starts: its first frame
    expect(audio.currentTime).toBe(0);
    audio.tick(73.5);
    expect(audio.paused).toBe(true);
    expect(c.getState().ended).toBe(true);
  });

  it("a file trimmed to the clip that stops by itself at its end has ended, and plays again from the clip start", async () => {
    const audio = new FakeAudio();
    audio.duration = 40;
    const src = createHostedMediaSource(audio, () => 0, null, 10_000, 2284);
    const c = createClipController(src, { start: 2284, end: 2324 }, () => 0);
    await c.play(true);
    audio.tick(39.6);
    expect(c.getState().ended).toBe(false);
    // The element pauses itself at the end of the file, before its last timeupdate.
    audio.paused = true;
    audio.currentTime = 40;
    audio.dispatchEvent(new Event("ended"));
    expect(c.getState().ended).toBe(true);
    await c.play();
    expect(audio.currentTime).toBe(0);
  });

  it("no hosted media: the error is there from the start, so the player shows the transcript", async () => {
    const src = createNoMediaSource();
    expect(src.kind).toBe("none");
    expect(src.getState()).toMatchObject({ ready: false, error: NOT_HOSTED });
    const c = createClipController(src, { start: 10, end: 50 }, () => 0);
    await c.play(true);
    expect(c.getState().player.error).toBe(NOT_HOSTED);
  });

  it("keeps going past the end after Keep listening", async () => {
    const audio = new FakeAudio();
    const c = createClipController(createHostedMediaSource(audio, () => 0), { start: 10, end: 50 }, () => 0);
    await c.play(true);
    audio.tick(51);
    await c.keepListening();
    audio.tick(70);
    expect(audio.paused).toBe(false);
  });

  it("reads currentTime every frame while playing, so the counter's second turns over with the audio", async () => {
    const audio = new FakeAudio();
    const queued = new Map<number, () => void>();
    let id = 0;
    const frames = { request: (cb: () => void) => (queued.set(++id, cb), id), cancel: (n: number) => void queued.delete(n) };
    const step = () => {
      const cbs = [...queued.values()];
      queued.clear();
      for (const cb of cbs) cb();
    };
    let clock = 0;
    const src = createHostedMediaSource(audio, () => clock, frames);
    await src.play(12.2);
    expect(queued.size).toBe(1);
    // Within the same second: no new sample (no re-render every frame).
    audio.currentTime = 12.9;
    clock = 700;
    step();
    expect(src.getState().currentTime).toBe(12.2);
    // The second turns over between timeupdates: sampled on that frame, at that moment.
    audio.currentTime = 13.01;
    clock = 810;
    step();
    expect(src.getState()).toMatchObject({ currentTime: 13.01, sampledAt: 810 });
    expect(Math.floor(liveTime(src.getState(), 816))).toBe(13);
    // Paused: the frames stop.
    audio.pause();
    expect(queued.size).toBe(0);
    await src.play();
    expect(queued.size).toBe(1);
    src.dispose();
    expect(queued.size).toBe(0);
  });

  it("goes back 10 s without going below zero, and flags a blocked play", async () => {
    const audio = new FakeAudio();
    const src = createHostedMediaSource(audio, () => 0);
    const c = createClipController(src, { start: 4, end: 50 }, () => 0);
    audio.tick(6);
    await c.back();
    expect(audio.currentTime).toBe(0);
    audio.blockPlay = true;
    await c.play();
    expect(src.getState().needsGesture).toBe(true);
  });

  describe("a clip that won't load", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("fails on a media error", () => {
      const audio = Object.assign(new FakeAudio(), { readyState: 0 });
      const src = createHostedMediaSource(audio, () => 0, null);
      audio.dispatchEvent(new Event("error"));
      expect(src.getState()).toMatchObject({ ready: false, error: LOAD_FAILED });
    });

    it("fails when it isn't ready in time (offline, stalled), so the player never waits forever", () => {
      const audio = Object.assign(new FakeAudio(), { readyState: 0 });
      const src = createHostedMediaSource(audio, () => 0, null, 5000);
      vi.advanceTimersByTime(4999);
      expect(src.getState().error).toBeNull();
      vi.advanceTimersByTime(1);
      expect(src.getState().error).toBe(LOAD_FAILED);
    });

    it("doesn't time out once it has loaded, or after it's disposed", () => {
      const audio = Object.assign(new FakeAudio(), { readyState: 0 });
      const src = createHostedMediaSource(audio, () => 0, null, 5000);
      audio.dispatchEvent(new Event("loadedmetadata"));
      vi.advanceTimersByTime(10_000);
      expect(src.getState()).toMatchObject({ ready: true, error: null });
      const other = createHostedMediaSource(Object.assign(new FakeAudio(), { readyState: 0 }), () => 0, null, 5000);
      other.dispose();
      vi.advanceTimersByTime(10_000);
      expect(other.getState().error).toBeNull();
    });

    it("an interrupted play() (AbortError) isn't a failure; any other rejection is", async () => {
      const audio = new FakeAudio();
      const src = createHostedMediaSource(audio, () => 0, null);
      audio.play = () => Promise.reject(Object.assign(new Error("interrupted"), { name: "AbortError" }));
      await src.play();
      expect(src.getState().error).toBeNull();
      audio.play = () => Promise.reject(Object.assign(new Error("no source"), { name: "NotSupportedError" }));
      await src.play();
      expect(src.getState().error).toBe(LOAD_FAILED);
    });
  });
});

describe("zoom-remote", () => {
  const URL = "https://ufl.zoom.us/rec/play/x";
  /** `replies` may be changed between steps; a function reply sees the message. */
  function fake(replies: Record<string, Reply | ((msg: Record<string, unknown>) => Reply)>) {
    const sent: Record<string, unknown>[] = [];
    const timers: (() => void)[] = [];
    const src = createZoomRemoteSource({
      recordingUrl: URL,
      send: async (msg) => {
        sent.push(msg);
        const r = replies[msg.type as string];
        return (typeof r === "function" ? r(msg) : r) ?? { ok: false, error: "unexpected" };
      },
      now: () => 0,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
    /** Runs the latest scheduled poll. */
    const poll = async () => {
      timers.pop()?.();
      await flush();
    };
    return { src, sent, timers, poll, replies };
  }
  const state = { currentTime: 918, paused: false, rate: 1, duration: 6081 };
  const at = (currentTime: number, paused = true) => ({ ok: true as const, state: { ...state, currentTime, paused } });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const types = (sent: Record<string, unknown>[]) => sent.map((m) => m.type);

  it("polls status, then seeks, confirms with status, and plays with the start time", async () => {
    const { src, sent } = fake({ status: at(918), seek: at(918), play: at(918, false) });
    await flush();
    expect(sent[0]).toEqual({ type: "status", recordingUrl: URL });
    expect(src.getState()).toMatchObject({ ready: true, currentTime: 918 });
    await src.play(918);
    expect(sent.slice(1)).toEqual([
      { type: "seek", seconds: 918, background: true, recordingUrl: URL },
      { type: "status", recordingUrl: URL },
      { type: "play", background: true, seconds: 918, recordingUrl: URL },
    ]);
    expect(src.getState().paused).toBe(false);
  });

  // Regression (John, Oct 23): the embedded recording played from 0:00. Its frame answered before
  // its media had loaded, so the seek didn't stick, and play went out anyway.
  it("plays only after status confirms the position, and seeks again until it does", async () => {
    const t = 0;
    const h = fake({ status: () => at(t), seek: at(0), play: () => at(t, false) });
    await flush();
    await h.src.play(918);
    // Each seek is accepted, but status keeps reading 0: three tries, then seek-failed, and no play.
    expect(types(h.sent)).toEqual(["status", "seek", "status", "seek", "status", "seek", "status"]);
    expect(h.src.getState().error).toMatch(/didn't jump/);
    expect(types(h.sent)).not.toContain("play");

    // The media lands on the second check.
    let checks = 0;
    const g = fake({ status: () => at(checks++ >= 2 ? 918 : 0), seek: at(0), play: at(918, false) });
    await flush();
    await g.src.play(918);
    expect(types(g.sent)).toEqual(["status", "seek", "status", "seek", "status", "play"]);
    expect(g.sent.at(-1)).toMatchObject({ type: "play", seconds: 918 });
    expect(g.src.getState().error).toBeNull();
  });

  it("holds a seek and play while the tab/frame isn't there, and delivers them once it is", async () => {
    const h = fake({ status: { ok: false, error: "no-tab" }, seek: { ok: false, error: "no-tab" }, play: at(918, false) });
    await flush();
    await h.src.seek(918); // the cue at mount
    await h.src.play(); // a resume before the frame exists keeps the pending seek
    expect(types(h.sent)).toEqual(["status", "seek", "seek"]);
    expect(h.src.getState().ready).toBe(false);
    // The frame registers.
    h.replies.status = at(918);
    h.replies.seek = at(918);
    await h.poll();
    await flush();
    expect(types(h.sent)).toEqual(["status", "seek", "seek", "status", "seek", "status", "play"]);
    expect(h.sent.at(-1)).toMatchObject({ type: "play", seconds: 918 });
  });

  it("seek-failed from the extension is an error that later polls don't clear, and nothing plays", async () => {
    const h = fake({ status: at(0), seek: { ok: false, error: "seek-failed" } });
    await flush();
    await h.src.play(918);
    expect(types(h.sent)).toEqual(["status", "seek"]);
    expect(h.src.getState().error).toMatch(/didn't jump to the clip/);
    await h.poll();
    expect(h.src.getState().error).toMatch(/didn't jump to the clip/);
    // A later seek that lands clears it.
    h.replies.seek = at(30);
    h.replies.status = at(30);
    await h.src.seek(30);
    expect(h.src.getState().error).toBeNull();
  });

  it("treats no-tab as not ready, and reports needs-gesture and a missing extension", async () => {
    const h = fake({ status: { ok: false, error: "no-tab" }, play: { ok: false, error: "needs-gesture" } });
    await flush();
    expect(h.src.getState()).toMatchObject({ ready: false, error: null });
    h.replies.status = at(10);
    h.replies.seek = at(10);
    await h.src.play(10);
    expect(h.src.getState().needsGesture).toBe(true);
    const other = fake({ status: { ok: false, error: "no-extension" } });
    await flush();
    expect(other.src.getState().error).toMatch(/extension isn't installed/);
  });
});

describe("clip controller before the source is at the clip", () => {
  it("shows the clip start until a position there is confirmed, then follows the source", async () => {
    const store = createStore({ ...INITIAL_STATE });
    const plays: (number | undefined)[] = [];
    const src: PlayerSource = {
      kind: "zoom-embed",
      getState: store.get,
      subscribe: store.subscribe,
      play: async (from?: number) => void plays.push(from),
      pause: async () => {},
      seek: async () => {},
      setRate: async () => {},
      dispose() {},
    };
    const clip = { start: 918, end: 960 };
    const c = createClipController(src, clip, () => 0);
    // The frame answers at 0:00 before its media has loaded: the counter still reads the clip start.
    store.set({ ready: true, currentTime: 0, paused: true });
    expect(c.getState().cued).toBe(false);
    expect(displayTime(c.getState(), clip, 0)).toBe(918);
    // A resume before it is cued still asks for the clip start.
    await c.play();
    expect(plays).toEqual([918]);
    store.set({ currentTime: 917.6 });
    expect(c.getState().cued).toBe(true);
    expect(displayTime(c.getState(), clip, 0)).toBe(917.6);
    // Once cued, a resume is a resume, and the counter follows the source anywhere.
    await c.play();
    expect(plays).toEqual([918, undefined]);
    store.set({ currentTime: 905 });
    expect(displayTime(c.getState(), clip, 0)).toBe(905);
  });
});

describe("extensionSender", () => {
  // Regression (Oct 23): .env.local had NEXT_PUBLIC_EXTENSION_ID, the app read another name, the ID was
  // empty, and the player said "isn't installed" even in a browser that had the extension.
  it("reports a missing ID separately from a missing extension", async () => {
    const { extensionSender } = await import("./zoom-remote");
    expect(await extensionSender("")({ type: "ping" })).toEqual({ ok: false, error: "no-extension-id" });
    expect(await extensionSender("abc")({ type: "ping" })).toEqual({ ok: false, error: "no-extension" });
  });

  it("Chrome's 'Receiving end does not exist' (no extension with this ID) is no-extension", async () => {
    const { extensionSender } = await import("./zoom-remote");
    const g = globalThis as { chrome?: unknown };
    const runtime = { lastError: undefined as { message: string } | undefined, sendMessage: (_id: string, _m: unknown, cb: () => void) => cb() };
    g.chrome = { runtime };
    try {
      runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
      expect(await extensionSender("abc")({ type: "ping" })).toEqual({ ok: false, error: "no-extension" });
      runtime.lastError = { message: "Something else" };
      expect(await extensionSender("abc")({ type: "ping" })).toEqual({ ok: false, error: "Something else" });
    } finally {
      delete g.chrome;
    }
  });

  it("several IDs (the zip's pinned one, the store's): tries each until one is there, then asks that one first", async () => {
    const { extensionSender } = await import("./zoom-remote");
    const g = globalThis as { chrome?: unknown };
    const asked: string[] = [];
    const installed = new Set(["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
    const runtime = {
      lastError: undefined as { message: string } | undefined,
      sendMessage(id: string, _m: unknown, cb: (r?: unknown) => void) {
        asked.push(id);
        if (installed.has(id)) {
          runtime.lastError = undefined;
          cb({ ok: true, version: "0.1.0" });
        } else {
          runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
          cb();
        }
      },
    };
    g.chrome = { runtime };
    try {
      const send = extensionSender("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(await send({ type: "ping" })).toEqual({ ok: true, version: "0.1.0" });
      expect(asked).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
      asked.length = 0;
      await send({ type: "ping" });
      expect(asked).toEqual(["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
      // None installed: no-extension, after asking each once.
      installed.clear();
      asked.length = 0;
      expect(await extensionSender("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")({ type: "ping" })).toEqual({ ok: false, error: "no-extension" });
      expect(asked).toHaveLength(2);
    } finally {
      delete g.chrome;
    }
  });
});
