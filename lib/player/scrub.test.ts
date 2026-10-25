import { describe, expect, it } from "vitest";
import { clipTimeAt, createSeekThrottle, keyTarget, scrubValueText } from "./scrub";

const clip = { start: 918, end: 987 };

describe("scrub rules", () => {
  it("maps the track to the clip window only", () => {
    expect(clipTimeAt(clip, 0)).toBe(918);
    expect(clipTimeAt(clip, 0.5)).toBe(952.5);
    expect(clipTimeAt(clip, 1)).toBe(987);
    expect(clipTimeAt(clip, -0.3)).toBe(918);
    expect(clipTimeAt(clip, 1.7)).toBe(987);
  });

  it("steps 5 s, 15 s with Shift, Home and End to the clip's ends, never outside it", () => {
    expect(keyTarget(clip, 930, "ArrowRight", false)).toBe(935);
    expect(keyTarget(clip, 930, "ArrowLeft", false)).toBe(925);
    expect(keyTarget(clip, 930, "ArrowRight", true)).toBe(945);
    expect(keyTarget(clip, 930, "ArrowLeft", true)).toBe(918);
    expect(keyTarget(clip, 985, "ArrowRight", false)).toBe(987);
    expect(keyTarget(clip, 930, "Home", false)).toBe(918);
    expect(keyTarget(clip, 930, "End", false)).toBe(987);
    expect(keyTarget(clip, 930, "a", false)).toBeNull();
  });

  it("says the time and how far into the clip", () => {
    expect(scrubValueText({ start: 918, end: 987 }, 942)).toBe("15:42, 24 seconds into the clip.");
    expect(scrubValueText(clip, 919.6)).toBe("15:19, 1 second into the clip.");
    expect(scrubValueText(clip, 980)).toBe("16:20, 1 minute 2 seconds into the clip.");
    expect(scrubValueText({ start: 3885, end: 3940 }, 3885)).toBe("1:04:45, 0 seconds into the clip.");
  });
});

describe("createSeekThrottle", () => {
  function setup() {
    let t = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const sent: [number, number][] = [];
    let idle = 0;
    const th = createSeekThrottle(
      async (s) => {
        sent.push([t, s]);
      },
      {
        intervalMs: 250,
        now: () => t,
        setTimer: (fn, ms) => {
          const timer = { at: t + ms, fn };
          timers.push(timer);
          return timer;
        },
        clearTimer: (x) => timers.splice(timers.indexOf(x as (typeof timers)[number]), 1),
        onIdle: () => idle++,
      },
    );
    const advance = async (ms: number) => {
      const until = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        t = next.at;
        next.fn();
        await Promise.resolve();
      }
      t = until;
      await Promise.resolve();
      await Promise.resolve();
    };
    return { th, sent, advance, idle: () => idle };
  }

  it("sends the first at once, then at most one per 250 ms, ending on the latest target", async () => {
    const { th, sent, advance } = setup();
    // A drag: a new target every 20 ms for a second.
    for (let i = 0; i < 50; i++) {
      th.request(900 + i);
      await advance(20);
    }
    expect(sent[0]).toEqual([0, 900]);
    expect(sent.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < sent.length; i++) expect(sent[i][0] - sent[i - 1][0]).toBeGreaterThanOrEqual(250);
    await advance(300);
    expect(sent.at(-1)![1]).toBe(949);
  });

  it("flush sends the final seek now and cancels the waiting one; onIdle once it all settles", async () => {
    const { th, sent, advance, idle } = setup();
    th.request(10);
    await advance(50);
    // The first seek has settled with nothing waiting: idle.
    expect(idle()).toBe(1);
    th.request(20);
    await advance(50);
    expect(sent).toEqual([[0, 10]]);
    expect(idle()).toBe(1);
    void th.flush(30);
    await advance(0);
    expect(sent).toEqual([
      [0, 10],
      [100, 30],
    ]);
    await advance(500);
    expect(sent).toHaveLength(2);
    expect(idle()).toBe(2);
  });
});
