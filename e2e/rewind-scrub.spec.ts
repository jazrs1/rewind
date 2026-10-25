// The clip track is a scrub bar (John, Oct 23): tap or drag within the clip window, the counter and the
// caption follow live, the seeks go to the recording throttled (about 4 a second) through the confirmed
// seek path, with a final seek on release. Keys step 5 s / 15 s, Home and End go to the clip's ends.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "./test";
import { formatTime } from "../lib/format";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed, "needs the local practice seed (npm run spike:seed)");

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

type Logged = { type: string; seconds?: number; at: number };
type W = { __log: Logged[]; __cur: () => number };

/** A fake extension: the embedded frame answers at once (audio-only), plays in real time, and a seek lands
 * where it was asked (status reports it), like the real frame once its media has loaded. */
async function fakeExtension(page: Page, start: number) {
  await page.addInitScript((start) => {
    const w = window as unknown as { chrome: unknown } & W;
    w.__log = [];
    let paused = true;
    let at = start;
    let since = Date.now();
    const tick = () => {
      if (!paused) at += (Date.now() - since) / 1000;
      since = Date.now();
    };
    w.__cur = () => (tick(), at);
    w.chrome = {
      runtime: {
        sendMessage(_id: string, msg: { type: string; seconds?: number }, cb: (r: unknown) => void) {
          tick();
          w.__log.push({ type: msg.type, seconds: msg.seconds, at: performance.now() });
          if (msg.seconds !== undefined && (msg.type === "seek" || msg.type === "play")) at = msg.seconds;
          if (msg.type === "play") paused = false;
          if (msg.type === "pause") paused = true;
          const state = { currentTime: at, paused, rate: 1, duration: 6081 };
          setTimeout(() => cb({ ok: true, state, media: { kind: "audio", videoWidth: null, videoHeight: null } }), 10);
        },
      },
    };
  }, start);
}

/** Miss question 1 and pause the clip once it plays, so the times below are exact. */
async function pausedClip(page: Page) {
  const q = seed!.questions[0];
  await fakeExtension(page, q.match.start);
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await page.getByRole("button", { name: "Pause clip" }).click({ timeout: 6000 });
  await expect(page.getByRole("button", { name: "Play clip" })).toBeVisible();
  const slider = page.getByRole("slider", { name: "Clip position" });
  await expect(slider).not.toHaveAttribute("aria-disabled");
  return { q, slider };
}

const seeks = (page: Page) => page.evaluate(() => (window as unknown as W).__log.filter((l) => l.type === "seek"));
const lineAt = (q: PracticeSeed["questions"][number], t: number) => [...q.segments].reverse().find((s) => s.start <= t + 0.05)!;

test("drag the knob to the middle of the clip: the counter and caption follow, seeks are throttled, the recording lands there", async ({ page, isMobile, viewport }) => {
  test.setTimeout(30_000);
  const { q, slider } = await pausedClip(page);
  const phone = (viewport?.width ?? 0) < 1024;
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  const mid = q.match.start + (q.match.end - q.match.start) / 2;
  const before = (await seeks(page)).length;
  const t0 = await page.evaluate(() => performance.now());

  // A drag of about 1.2 s from the knob (at the clip start) to the middle: a finger on the phone, a mouse on desktop.
  const STEPS = 40;
  const cdp = phone ? await page.context().newCDPSession(page) : null;
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) =>
    cdp!.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  if (cdp) await touch("touchStart", box.x);
  else {
    await page.mouse.move(box.x, y);
    await page.mouse.down();
  }
  for (let i = 1; i <= STEPS; i++) {
    const x = box.x + (box.width / 2) * (i / STEPS);
    if (cdp) await touch("touchMove", x);
    else await page.mouse.move(x, y);
    await page.waitForTimeout(30);
  }
  // Still dragging: the counter and the caption are already at the middle.
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(mid));
  if (!isMobile) await expect(page.locator("figure [data-caption]")).toHaveText(lineAt(q, mid).text);
  await expect(slider).toHaveAttribute("aria-valuetext", `${formatTime(mid)}, ${Math.floor(mid - q.match.start)} seconds into the clip.`);
  const t1 = await page.evaluate(() => performance.now());
  if (cdp) await touch("touchEnd", box.x + box.width / 2);
  else await page.mouse.up();

  // The recording ends where the knob was let go, and the counter stays there.
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__cur()), { timeout: 4000 }).toBeCloseTo(mid, 0);
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(mid));
  await page.waitForTimeout(600);
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(mid));

  // Throttled: at most about 4 a second during the drag, never two within 200 ms, plus the final one on release.
  const sent = (await seeks(page)).slice(before);
  // The last one is the final seek on release.
  const during = sent.slice(0, -1);
  const dragS = (t1 - t0) / 1000;
  expect(during.length, `seeks during a ${dragS.toFixed(1)} s drag`).toBeGreaterThanOrEqual(2);
  expect(during.length).toBeLessThanOrEqual(Math.ceil(dragS * 4) + 1);
  for (let i = 1; i < during.length; i++) expect(during[i].at - during[i - 1].at, "gap between seeks while dragging").toBeGreaterThanOrEqual(200);
  expect(sent.at(-1)!.seconds).toBeCloseTo(mid, 0);
  // Every seek stayed inside the clip window.
  for (const s of sent) {
    expect(s.seconds!).toBeGreaterThanOrEqual(q.match.start);
    expect(s.seconds!).toBeLessThanOrEqual(q.match.end);
  }
});

test("a tap jumps there", async ({ page }) => {
  const { q, slider } = await pausedClip(page);
  const box = (await slider.boundingBox())!;
  const t = q.match.start + (q.match.end - q.match.start) * 0.75;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__cur()), { timeout: 4000 }).toBeCloseTo(t, 0);
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(t));
});

test("keys: Right/Left 5 s, Shift 15 s, Home and End the clip's ends, said as time and seconds into the clip", async ({ page }) => {
  const { q, slider } = await pausedClip(page);
  const s = q.match.start;
  const said = (t: number) => {
    const d = Math.floor(t - s);
    return `${formatTime(t)}, ${d >= 60 ? `1 minute ${d - 60} seconds` : `${d} seconds`} into the clip.`;
  };
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", said(s + 5));
  await page.keyboard.press("Shift+ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", said(s + 20));
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(s + 20));
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", said(s + 15));
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__cur()), { timeout: 4000 }).toBeCloseTo(s + 15, 0);
  await page.keyboard.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", said(q.match.end));
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", said(s));
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__cur()), { timeout: 4000 }).toBeCloseTo(s, 0);
});

test("on a phone the scrub bar's hit area is 44 px tall though the track is thin; the knob never animates", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) !== 390, "phone width");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { slider } = await pausedClip(page);
  const box = (await slider.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(8);
  const hit = await slider.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const before = getComputedStyle(el, "::before");
    const x = r.x + r.width / 2;
    // Probe the band 44 px tall the hit area covers.
    const hits = [0.5, 10, 22, 33, 43.5].map((dy) => el.contains(document.elementFromPoint(x, r.y + parseFloat(before.top) + dy)));
    return { h: parseFloat(before.height), hits };
  });
  expect(hit.h).toBeGreaterThanOrEqual(44);
  expect(hit.hits).toEqual([true, true, true, true, true]);
  // The band never covers another control: the line below (Read transcript) starts under it.
  const link = (await page.getByRole("button", { name: /transcript$/ }).boundingBox())!;
  const before = await slider.evaluate((el) => el.getBoundingClientRect().bottom + parseFloat(getComputedStyle(el, "::before").bottom) * -1);
  expect(before).toBeLessThanOrEqual(link.y);
  const knob = slider.locator("[data-knob]");
  expect(await knob.evaluate((k) => [getComputedStyle(k).transitionDuration, getComputedStyle(k).animationName])).toEqual(["0s", "none"]);
});

test("desktop hover shows the time and his line there", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1024, "desktop hover");
  const { q, slider } = await pausedClip(page);
  const box = (await slider.boundingBox())!;
  const t = q.match.start + (q.match.end - q.match.start) * 0.6;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  const label = slider.locator("[data-scrub-label]");
  await expect(label).toBeVisible();
  await expect(label).toContainText(formatTime(t));
  await expect(label).toContainText(lineAt(q, t).text.slice(0, 30));
  // Hovering moves nothing.
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(q.match.start));
  await page.screenshot({ path: ".cache/shots/designer-scrub-hover-1280.png" });
  await page.mouse.move(box.x + box.width / 2, box.y - 200);
  await expect(label).toHaveCount(0);
});

test("during the rewind and when the recording fails, the scrub bar is disabled", async ({ page }) => {
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "said" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Clip position" })).toHaveAttribute("aria-disabled", "true");
});
