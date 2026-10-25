import { describe, expect, it } from "vitest";
import { exportedTranscripts, mergeTranscripts, watchExported, type BridgeSend } from "./recordings.ts";

const ZOOM = (n: number) => `https://ufl.zoom.us/rec/play/FAKE-${n}`;
const transcript = (n: number) => ({
  source: "zoom",
  recordingUrl: ZOOM(n),
  title: `Lecture ${n}`,
  recordedAt: "2026-10-22T17:48:09",
  durationSec: 3600,
  segments: [{ start: 3463, end: 3470, speaker: "Lecturer", text: "A graph is connected if there is a path between every pair of vertices." }],
});

describe("Add lecture recordings: the extension's exported transcripts", () => {
  it("reads them the way a picked file is read, and drops anything that isn't one", async () => {
    const send: BridgeSend = async (msg) => {
      expect(msg).toEqual({ type: "transcripts" });
      return { ok: true, transcripts: [transcript(1), { nope: true }, "x", { ...transcript(2), recordingUrl: "" }] };
    };
    const r = await exportedTranscripts(send);
    expect(r.ok && r.transcripts.map((t) => t.recordingUrl)).toEqual([ZOOM(1)]);
    expect(await exportedTranscripts(async () => ({ ok: false, error: "no-extension" }))).toEqual({ ok: false, error: "no-extension" });
    expect(await exportedTranscripts(async () => Promise.reject(new Error("gone")))).toEqual({ ok: false, error: "no-extension" });
  });

  it("the count rises as transcripts arrive, asked again on each tick, and stops when the step closes", async () => {
    let have = 0;
    const send: BridgeSend = async () => ({ ok: true, transcripts: Array.from({ length: have }, (_, i) => transcript(i)) });
    const timers: (() => void)[] = [];
    const counts: number[] = [];
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const stop = watchExported(send, (r) => counts.push(r.ok ? r.transcripts.length : -1), { setTimer: (fn) => timers.push(fn), clearTimer: () => {} });
    await flush();
    have = 1;
    timers.shift()!();
    await flush();
    have = 3;
    timers.shift()!();
    await flush();
    expect(counts).toEqual([0, 1, 3]);
    stop();
    timers.shift()?.();
    await flush();
    expect(counts).toEqual([0, 1, 3]);
  });

  it("one per recording: a picked file wins over the extension's copy of the same recording", () => {
    const picked = [{ ...transcript(1), title: "Picked" }] as never[];
    const merged = mergeTranscripts(picked, [transcript(1), transcript(2)] as never[]);
    expect(merged.map((t: { title: string }) => t.title)).toEqual(["Picked", "Lecture 2"]);
  });
});
