import { describe, expect, it } from "vitest";
import { createEmbedWithFallback, createZoomEmbedSource, type EmbedMedia } from "./zoom-embed";
import type { Reply } from "./zoom-remote";

const URL = "https://ufl.zoom.us/rec/play/x";
const state = { currentTime: 918, paused: false, rate: 1, duration: 6081 };
const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(replies: Record<string, Reply & { media?: EmbedMedia }>) {
  const sent: Record<string, unknown>[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const send = async (msg: Record<string, unknown>) => {
    sent.push(msg);
    return replies[msg.type as string] ?? { ok: false as const, error: "unexpected" };
  };
  const timerOpts = { setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }), clearTimer: () => {} };
  return { sent, timers, send, timerOpts };
}

describe("zoom-embed", () => {
  it("adds embed: true to every message and reports the frame's media", async () => {
    let media: EmbedMedia | null = null;
    const audio = { kind: "audio" as const, videoWidth: null, videoHeight: null };
    const h = harness({ status: { ok: true, state, media: audio } as never, play: { ok: true, state, media: audio } as never, embedMode: { ok: true } });
    const src = createZoomEmbedSource({ recordingUrl: URL, send: h.send, onMedia: (m) => (media = m), now: () => 0, ...h.timerOpts });
    await flush();
    expect(h.sent[0]).toEqual({ type: "status", recordingUrl: URL, embed: true });
    expect(src.getState()).toMatchObject({ ready: true, currentTime: 918 });
    expect(media).toEqual({ kind: "audio", videoWidth: null, videoHeight: null });
    // Embed mode is turned on once, after the frame first answers.
    await src.play(918);
    expect(h.sent.filter((m) => m.type === "embedMode")).toEqual([{ type: "embedMode", recordingUrl: URL, embed: true, on: true }]);
  });

  it("treats no-frame as not ready yet, not an error", async () => {
    const h = harness({ status: { ok: false, error: "no-frame" } });
    const src = createZoomEmbedSource({ recordingUrl: URL, send: h.send, now: () => 0, ...h.timerOpts });
    await flush();
    expect(src.getState()).toMatchObject({ ready: false, error: null });
  });
});

describe("embed with fallback", () => {
  it("switches to zoom-remote when the frame isn't ready in time, and replays the last play", async () => {
    const h = harness({ status: { ok: false, error: "no-frame" }, play: { ok: false, error: "no-frame" } });
    const embed = createZoomEmbedSource({ recordingUrl: URL, send: h.send, now: () => 0, ...h.timerOpts });
    const remoteCalls: (number | undefined)[] = [];
    let remoteMade = 0;
    const src = createEmbedWithFallback({
      embed,
      graceMs: 8000,
      makeFallback: () => {
        remoteMade++;
        return { ...embed, kind: "zoom-remote", play: async (from) => void remoteCalls.push(from), dispose() {} };
      },
      ...h.timerOpts,
    });
    await src.play(918);
    expect(src.activeKind()).toBe("zoom-embed");
    h.timers.find((t) => t.ms === 8000)!.fn();
    expect(src.activeKind()).toBe("zoom-remote");
    expect(remoteMade).toBe(1);
    expect(remoteCalls).toEqual([918]);
  });

  // Regression (John, Oct 23): when the frame can't be moved to the clip, try a Zoom tab.
  it("switches to zoom-remote at once when the frame replies seek-failed, and replays the play", async () => {
    const h = harness({ status: { ok: true, state: { ...state, currentTime: 0, paused: true } }, seek: { ok: false, error: "seek-failed" } });
    const embed = createZoomEmbedSource({ recordingUrl: URL, send: h.send, now: () => 0, ...h.timerOpts });
    const remoteCalls: (number | undefined)[] = [];
    const src = createEmbedWithFallback({
      embed,
      graceMs: 8000,
      makeFallback: () => ({ ...embed, kind: "zoom-remote", play: async (from) => void remoteCalls.push(from), dispose() {} }),
      ...h.timerOpts,
    });
    await flush();
    await src.seek(918); // the cue: the frame says seek-failed, so it falls back with the seek
    expect(src.activeKind()).toBe("zoom-remote");
    expect(h.sent.filter((m) => m.type === "play")).toEqual([]);
    await src.play(); // a resume on the fallback
    expect(remoteCalls).toEqual([undefined]);
  });

  it("a resume after a cue that found no frame replays the clip start on the fallback", async () => {
    const h = harness({ status: { ok: false, error: "no-frame" }, seek: { ok: false, error: "no-frame" } });
    const embed = createZoomEmbedSource({ recordingUrl: URL, send: h.send, now: () => 0, ...h.timerOpts });
    const remoteCalls: (number | undefined)[] = [];
    const src = createEmbedWithFallback({
      embed,
      graceMs: 8000,
      makeFallback: () => ({ ...embed, kind: "zoom-remote", play: async (from) => void remoteCalls.push(from), dispose() {} }),
      ...h.timerOpts,
    });
    await src.seek(918);
    await src.play();
    h.timers.find((t) => t.ms === 8000)!.fn();
    expect(remoteCalls).toEqual([918]);
  });

  it("stays embedded when the frame's player is ready", async () => {
    const h = harness({ status: { ok: true, state } });
    const embed = createZoomEmbedSource({ recordingUrl: URL, send: h.send, now: () => 0, ...h.timerOpts });
    let remoteMade = 0;
    const src = createEmbedWithFallback({ embed, graceMs: 8000, makeFallback: () => (remoteMade++, embed), ...h.timerOpts });
    await flush();
    h.timers.find((t) => t.ms === 8000)!.fn();
    expect(src.activeKind()).toBe("zoom-embed");
    expect(remoteMade).toBe(0);
  });
});
