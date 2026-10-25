// Regression (John, Oct 23, real Brave): the embedded Zoom recording played from 0:00 instead of
// the clip start, and before play the counter read 0:00 with an empty caption bar. The frame's
// player answered before its media had loaded, the seek didn't stick, and play went out anyway.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "./test";
import { formatTime } from "../lib/format";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed, "needs the local practice seed (npm run spike:seed)");

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

type Logged = { type: string; seconds?: number; at: number; cur: number };

test("the embedded recording is at the clip start before it plays, and the counter never reads 0:00", async ({ page }) => {
  test.setTimeout(30_000);
  const q = seed!.questions[0];
  const start = q.match.start;

  // A fake extension, timed like the real frame: no frame for the first second (the iframe is still
  // loading Zoom), then its player answers at 0:00, and its media loads 1.5 s after that. Like the
  // real extension, a seek (or a play with seconds) is held until the media has loaded; status
  // reports where the media really is.
  await page.addInitScript(([frameMs, loadMs]) => {
    const w = window as unknown as { chrome: unknown; __log: Logged[]; __counter: { at: number; text: string }[] };
    w.__log = [];
    w.__counter = [];
    let t0 = 0;
    let cur = 0;
    let paused = true;
    const framed = () => t0 > 0 && Date.now() - t0 >= frameMs;
    const loaded = () => t0 > 0 && Date.now() - t0 >= frameMs + loadMs;
    const whenLoaded = (fn: () => void) => {
      const wait = () => (loaded() ? fn() : setTimeout(wait, 50));
      wait();
    };
    const state = () => ({ currentTime: cur, paused, rate: 1, duration: 6081 });
    const media = { kind: "audio", videoWidth: null, videoHeight: null };
    w.chrome = {
      runtime: {
        sendMessage(_id: string, msg: { type: string; seconds?: number }, cb: (r: unknown) => void) {
          if (!t0) t0 = Date.now();
          const reply = (r: unknown) => {
            w.__log.push({ type: msg.type, seconds: msg.seconds, at: performance.now(), cur });
            cb(r);
          };
          if (!framed()) {
            setTimeout(() => reply({ ok: false, error: "no-frame" }), 10);
            return;
          }
          if (msg.type === "seek" || (msg.type === "play" && msg.seconds !== undefined)) {
            whenLoaded(() => {
              cur = msg.seconds!;
              if (msg.type === "play") paused = false;
              reply({ ok: true, state: state(), media });
            });
            return;
          }
          if (msg.type === "play") paused = false;
          if (msg.type === "pause") paused = true;
          setTimeout(() => reply({ ok: true, state: state(), media }), 10);
        },
      },
    };
    // What the counter shows, sampled through the whole flow.
    setInterval(() => {
      const el = document.querySelector("[data-counter]");
      if (el) w.__counter.push({ at: performance.now(), text: el.textContent ?? "" });
    }, 50);
  }, [1000, 1500]);

  const wrong = q.choices.find((c) => c.label !== q.answer)!;
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();

  // The counter lands on the clip start and the caption bar shows his line there.
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(start), { timeout: 3000 });
  const line = [...q.segments].reverse().find((s) => s.start <= start + 0.05);
  if (line) await expect(page.getByText(line.text, { exact: true }).filter({ visible: true }).first()).toBeVisible();

  // Play goes out only once status has confirmed the media is at the clip start.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __log: Logged[] }).__log.some((l) => l.type === "play")), { timeout: 8000 }).toBe(true);
  const { log, counter } = await page.evaluate(() => {
    const w = window as unknown as { __log: Logged[]; __counter: { at: number; text: string }[] };
    return { log: w.__log, counter: w.__counter };
  });
  const playAt = log.findIndex((l) => l.type === "play");
  const play = log[playAt];
  expect(play.seconds).toBeCloseTo(start, 1);
  const lastStatus = log.slice(0, playAt).filter((l) => l.type === "status").at(-1)!;
  expect(Math.abs(lastStatus.cur - start)).toBeLessThanOrEqual(1);
  // The frame really did report 0:00 first, so this flow exercised the late media.
  expect(log.some((l) => l.type === "status" && l.cur === 0)).toBe(true);

  // Before play, the counter read the clip start every time it was sampled; it never read 0:00.
  const before = counter.filter((c) => c.at < play.at);
  expect(before.length).toBeGreaterThan(5);
  expect([...new Set(before.map((c) => c.text))]).toEqual([formatTime(start)]);
  expect(counter.some((c) => c.text === "0:00")).toBe(false);
});
