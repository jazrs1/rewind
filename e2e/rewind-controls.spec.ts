// The rewind's controls after the third review (Oct 23): one orange control at a time, the counter and
// reels fitting a phone row with h:mm:ss, the failed state's transcript clear of the pinned Next bar,
// two-line captions, cassette hubs and the example button waiting for the recording.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "./test";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed, "needs the local practice seed (npm run spike:seed)");

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

const ORANGE = "rgb(250, 70, 22)";
const CLEAR = "rgba(0, 0, 0, 0)";

/** A fake extension whose embedded frame answers at once (audio-only) and plays in real time; seeks land. */
async function liveEmbed(page: Page, start: number) {
  await page.addInitScript((start) => {
    let paused = true;
    let at = start;
    let since = Date.now();
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage(_id: string, msg: { type: string; seconds?: number }, cb: (r: unknown) => void) {
          if (!paused) at += (Date.now() - since) / 1000;
          since = Date.now();
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

async function missQuestion(page: Page, i: number) {
  const q = seed!.questions[i];
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();
  return q;
}

/** Every visible control filled orange, by accessible name. */
async function orange(page: Page) {
  return page.evaluate((ORANGE) => {
    return [...document.querySelectorAll("button")]
      .filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== "hidden" && getComputedStyle(b).backgroundColor === ORANGE)
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
  }, ORANGE);
}

async function bg(l: Locator) {
  return l.evaluate((b) => getComputedStyle(b).backgroundColor);
}

test("exactly one orange control: Play/Pause while playing; Next question once paused, ended or failed", async ({ page }) => {
  const q = seed!.questions[0];
  await liveEmbed(page, q.match.start);
  await page.goto("/practice?set=seed");
  await missQuestion(page, 0);
  const next = page.getByRole("button", { name: "Next question" }).filter({ visible: true });
  const toggle = page.getByRole("button", { name: /^(Play|Pause) clip$/ });

  // Playing.
  await expect(page.getByRole("button", { name: "Pause clip" })).toBeVisible({ timeout: 5000 });
  expect(await orange(page)).toEqual(["Pause clip"]);
  expect(await bg(next)).toBe(CLEAR);

  // Paused.
  await toggle.click();
  await expect(page.getByRole("button", { name: "Play clip" })).toBeVisible();
  await expect(next).toHaveAttribute("data-primary", "");
  expect(await orange(page)).toEqual(["Next question"]);
  expect(await bg(toggle)).toBe(CLEAR);
  expect(await toggle.evaluate((b) => getComputedStyle(b).borderTopWidth)).toBe("2px");

  // Ended: play from his line at the clip's end, and the clip stops there.
  await page.evaluate(() => scrollTo(0, 0));
  if (!(await page.getByRole("list", { name: "Transcript" }).isVisible())) await page.getByRole("button", { name: "Read transcript" }).click();
  const last = q.segments.find((s) => s.start >= q.match.end - 0.05)!;
  await page.getByRole("list", { name: "Transcript" }).getByRole("button", { name: new RegExp(last.text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  await expect(page.getByRole("button", { name: "Replay" }).filter({ visible: true })).toBeVisible({ timeout: 5000 });
  // Next question's fill eases in (150 ms) as the clip ends, so wait for it to settle.
  await expect.poll(() => orange(page)).toEqual(["Next question"]);
  await expect.poll(() => bg(toggle)).toBe(CLEAR);
});

test("Keep listening on the embedded recording: after the clip's end it plays on, the scrub window grows past the clip", async ({ page }) => {
  const q = seed!.questions[0];
  await liveEmbed(page, q.match.start);
  await page.goto("/practice?set=seed");
  await missQuestion(page, 0);
  await expect(page.getByRole("button", { name: "Pause clip" })).toBeVisible({ timeout: 5000 });
  const slider = page.getByRole("slider", { name: "Clip position" });
  await expect(slider).not.toHaveAttribute("aria-disabled");
  const sb = (await slider.boundingBox())!;
  await page.mouse.click(sb.x + sb.width * 0.93, sb.y + sb.height / 2);
  if (await page.getByRole("button", { name: "Play clip" }).count()) await page.getByRole("button", { name: "Play clip" }).click();
  // It plays the last seconds and stops at the end.
  await expect(page.getByRole("button", { name: "Replay" }).filter({ visible: true })).toBeVisible({ timeout: 25_000 });
  await page.getByRole("button", { name: "Keep listening" }).filter({ visible: true }).click();
  // Within 2 s the counter has passed the clip end: the window is wider than the clip, and it is playing.
  await expect(page.getByRole("button", { name: "Pause clip" })).toBeVisible({ timeout: 2000 });
  await expect.poll(async () => Number(await slider.getAttribute("aria-valuenow")), { timeout: 2000 }).toBeGreaterThan(q.match.end - q.match.start);
  expect(Number(await slider.getAttribute("aria-valuemax"))).toBeGreaterThan(q.match.end - q.match.start);
});

test("exactly one orange control when the recording fails: Next question", async ({ page }) => {
  await page.goto("/practice?set=seed");
  await missQuestion(page, 0);
  await expect(page.getByRole("alert").filter({ hasText: "said" })).toBeVisible();
  expect(await orange(page)).toEqual(["Next question"]);
  expect(await bg(page.getByRole("button", { name: "Play clip" }))).toBe(CLEAR);
});

/** The deck face holds together: the tape window (reels, when shown, either side of the counter) and then the keys, never overlapping. */
async function rowFits(clip: Locator, what: string) {
  const counter = (await clip.locator("[data-counter]").boundingBox())!;
  const back = (await clip.getByRole("button", { name: "Back 10 seconds" }).boundingBox())!;
  const win = (await clip.locator("[data-tape-window]").boundingBox())!;
  // Desktop: the keys on the left, the tape window to their right (John, Oct 24). Phone: the window, the keys under it.
  const keys = (await clip.getByRole("group", { name: "Transport" }).boundingBox())!;
  const left = keys.x + keys.width <= win.x;
  const under = win.y + win.height <= keys.y;
  expect(left || under, `${what}: the keys clear of the window (left of it on desktop, under it on a phone)`).toBe(true);
  // The keys keep their spec size on a phone too: 56 x 48.
  expect(Math.round(back.width), `${what}: key width`).toBe(56);
  expect(Math.round(back.height), `${what}: key height`).toBe(48);
  const reels = clip.locator("[data-reels] > svg");
  if (await reels.first().isVisible()) {
    const [l, r] = [(await reels.nth(0).boundingBox())!, (await reels.nth(1).boundingBox())!];
    expect(l.x + l.width, `${what}: left reel before the counter`).toBeLessThanOrEqual(counter.x);
    expect(r.x, `${what}: right reel after the counter`).toBeGreaterThanOrEqual(counter.x + counter.width);
    expect(r.x + r.width, `${what}: reels inside the window`).toBeLessThanOrEqual(win.x + win.width);
    expect(l.width, `${what}: reels big enough to read`).toBeGreaterThanOrEqual(32);
  }
}

test("at 390 px the counter and reels fit the row for every seed question and radar moment, h:mm:ss included", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) !== 390, "phone width");
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/practice?set=seed");
  for (let i = 0; i < seed!.questions.length; i++) {
    const q = await missQuestion(page, i);
    const clip = page.getByRole("region", { name: "Lecture clip" });
    await expect(clip.locator("[data-counter]")).toBeVisible();
    await rowFits(clip, `question ${q.n}`);
    await page.getByRole("button", { name: "Next question" }).filter({ visible: true }).click();
  }
  if (!seed!.radar?.length) return;
  await page.goto("/radar");
  const items = page.locator("main > ol > li");
  for (let i = 0; i < seed!.radar.length; i++) {
    await items.nth(i).getByRole("button", { name: /^Play the moment at / }).click();
    const clip = items.nth(i).getByRole("region", { name: "Lecture clip" });
    await expect(clip.locator("[data-counter]")).toBeVisible();
    await rowFits(clip, `radar moment ${i}`);
  }
});

test("at 390 px with no extension, the transcript scrolls clear of the pinned Next bar with the clip's first lines whole", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) !== 390, "phone width");
  await page.goto("/practice?set=seed");
  const q = await missQuestion(page, 0);
  const list = page.getByRole("list", { name: "Transcript" });
  await expect(list).toBeVisible();
  // The list has scrolled itself to the clip (smoothly) before the page is scrolled.
  await expect
    .poll(() => list.evaluate((l) => {
      const cur = l.querySelector<HTMLElement>("[aria-current=true]")?.closest("li");
      return !!cur && Math.abs(cur.offsetTop - l.scrollTop) < 2;
    }))
    .toBe(true);
  // Scroll the page (from over the answer strip, not the list, which scrolls on its own).
  await page.mouse.move(195, 60);
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => page.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 1)).toBe(true);
  // The wheel's smooth scroll can still be settling its last pixel: wait until the page holds still, then read the
  // bar, the list and the lines in one snapshot (read one by one, a moving page put a line a pixel above its list).
  await expect
    .poll(() => page.evaluate(() => new Promise<boolean>((done) => { const y = scrollY; requestAnimationFrame(() => requestAnimationFrame(() => done(scrollY === y))); })))
    .toBe(true);
  const firsts = q.segments.filter((s) => s.start >= q.match.start - 0.05).slice(0, 2);
  const snap = await page.evaluate((idx) => {
    const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { y: r.y, height: r.height }; };
    const list = document.querySelector('[aria-label="Transcript"]')!;
    const buttons = list.querySelectorAll("button");
    return { bar: rect(document.querySelector("[data-next-bar]")!), box: rect(list), lines: idx.map((i) => rect(buttons[i])) };
  }, firsts.map((s) => q.segments.indexOf(s)));
  const { bar, box } = snap;
  expect(box.y + box.height, "the list ends above the bar").toBeLessThanOrEqual(bar.y + 0.5);
  // The clip's first two lines are whole inside the list, above the bar.
  for (const [n, s] of firsts.entries()) {
    const line = snap.lines[n];
    expect(line.y, `"${s.text.slice(0, 30)}" starts inside the list`).toBeGreaterThanOrEqual(box.y - 0.5);
    expect(line.y + line.height, `"${s.text.slice(0, 30)}" ends inside the list`).toBeLessThanOrEqual(Math.min(box.y + box.height, bar.y) + 0.5);
  }
});

test("slide captions are at most two whole lines, nothing cut, on every seed question", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await liveEmbed(page, 0);
  await page.goto("/practice?set=seed");
  for (let i = 0; i < seed!.questions.length; i++) {
    await missQuestion(page, i);
    const text = page.locator("figure [data-caption]");
    await expect(text).not.toHaveText(/^\s*$/, { timeout: 5000 });
    const m = await text.evaluate((el) => {
      const box = el.parentElement!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      const cs = getComputedStyle(el.parentElement!);
      const [padTop, pad] = [parseFloat(cs.paddingTop), parseFloat(cs.paddingBottom)];
      return {
        lines: Math.round(r.height / lh),
        textTop: r.top,
        textBottom: r.bottom,
        boxTop: box.top,
        boxBottom: box.bottom,
        padTop,
        pad,
        band: Math.round(box.height - padTop - pad),
        twoLines: Math.round(2 * lh),
        clamp: getComputedStyle(el).webkitLineClamp,
      };
    });
    expect(m.lines, `question ${i + 1}: lines`).toBeLessThanOrEqual(2);
    expect(m.clamp).toBe("2");
    // The band always holds two lines, so it keeps its height as the caption changes.
    expect(m.band, `question ${i + 1}: a two-line band`).toBe(m.twoLines);
    // The padding is empty: the clamped text stays inside the band's content box.
    expect(m.textTop, `question ${i + 1}: nothing in the top padding`).toBeGreaterThanOrEqual(m.boxTop + m.padTop - 1);
    expect(m.textBottom, `question ${i + 1}: nothing in the padding`).toBeLessThanOrEqual(m.boxBottom - m.pad + 1);
    await page.getByRole("button", { name: "Next question" }).filter({ visible: true }).click();
  }
});

test("the reel hubs are the cassette's dashed rings round a pale centre", async ({ page }) => {
  await page.goto("/practice?set=seed");
  await missQuestion(page, 0);
  const hubs = page.locator("[data-reels] .reel [data-hub]");
  await expect(hubs).toHaveCount(2);
  const h = await hubs.first().evaluate((c) => ({ dash: c.getAttribute("stroke-dasharray"), fill: c.getAttribute("fill"), r: Number(c.getAttribute("r")), w: Number(c.getAttribute("stroke-width")) }));
  expect(h.dash).toBeTruthy();
  expect(h.fill).toBe("none");
  // About 14 of the reel's 32 px across, outer edge.
  expect((h.r * 2 + h.w) / 18).toBeCloseTo(14 / 32, 2);
  await expect(page.locator("[data-reels] .reel rect")).toHaveCount(0);
});
