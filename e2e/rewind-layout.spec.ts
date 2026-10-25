// The rewind screen after John's review (Oct 23): cassette reels, the transcript on screen when the
// recording fails, one primary button, and a slide/video frame that fills the player column.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "./test";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed, "needs the local practice seed (npm run spike:seed)");

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

/** A fake extension whose embedded frame plays at once (audio-only, so our slide shows). */
async function playingEmbed(page: Page, start: number) {
  await page.addInitScript((start) => {
    const t0 = Date.now();
    let paused = true;
    let at = start;
    let since = t0;
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage(_id: string, msg: { type: string }, cb: (r: unknown) => void) {
          if (!paused) at += (Date.now() - since) / 1000;
          since = Date.now();
          if (msg.type === "play") paused = false;
          if (msg.type === "pause") paused = true;
          const state = { currentTime: at, paused, rate: 1, duration: 6081 };
          setTimeout(() => cb({ ok: true, state, media: { kind: "audio", videoWidth: null, videoHeight: null } }), 10);
        },
      },
    };
  }, start);
}

async function miss(page: Page) {
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();
  return q;
}

test("the reels are a cassette's: a tape window with two reels with dashed hubs, the tape between and the counter on it", async ({ page }) => {
  await miss(page);
  const reels = page.locator("[data-reels]");
  await expect(page.locator("[data-counter]")).toBeVisible({ timeout: 3000 });
  // The counter sits between the reels, on the tape, in the same window (brief B: one object).
  const [r, c] = await Promise.all([reels.boundingBox(), page.locator("[data-counter]").boundingBox()]);
  expect(Math.abs(r!.y + r!.height / 2 - (c!.y + c!.height / 2))).toBeLessThanOrEqual(4);
  expect(c!.x).toBeGreaterThan(r!.x);
  expect(c!.x + c!.width).toBeLessThan(r!.x + r!.width);
  await expect(reels.locator(".reel")).toHaveCount(2);
  // A dashed ring for each hub (rewind-controls.spec has the details), and the tape strip.
  await expect(reels.locator(".reel [data-hub]")).toHaveCount(2);
  await expect(reels.locator("[data-ribbon]")).toHaveCount(1);
});

test("when the recording fails, the transcript is inside the panel and on screen", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1024, "desktop: the whole screen fits without scrolling");
  await miss(page);
  const alert = page.getByRole("alert").filter({ hasText: "said" });
  await expect(alert).toContainText(/here's what/i);
  const list = page.getByRole("list", { name: "Transcript" });
  // In the same panel as the alert.
  expect(await list.evaluate((l, a) => l.closest(".bg-deck-raised") === a!.parentElement, await alert.elementHandle())).toBe(true);
  await expect(alert).toBeInViewport({ ratio: 1 });
  const lines = list.getByRole("button");
  let shown = 0;
  for (let i = 0; i < (await lines.count()); i++) {
    const b = await lines.nth(i).boundingBox();
    const box = await list.boundingBox();
    // Count lines at least half on show inside the list (it scrolls the line he is on into view).
    if (b && box && Math.min(b.y + b.height, box.y + box.height) - Math.max(b.y, box.y) >= b.height / 2 && b.y + b.height / 2 <= viewport!.height) shown++;
  }
  expect(shown, "transcript lines on screen").toBeGreaterThanOrEqual(2);
  await expect(list.locator("[aria-current=true]")).toBeInViewport({ ratio: 1 });
  // The list fits on screen; anything more scrolls inside it.
  const box = (await list.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(viewport!.height);
});

test("one primary button: Next question is outlined while the clip plays, orange once it's paused", async ({ page }) => {
  const q = seed!.questions[0];
  await playingEmbed(page, q.match.start);
  await miss(page);
  const next = page.getByRole("button", { name: "Next question" }).filter({ visible: true });
  const pause = page.getByRole("button", { name: "Pause clip" });
  await expect(pause).toBeVisible({ timeout: 5000 });
  await expect(next).not.toHaveAttribute("data-primary");
  expect(await next.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await pause.click();
  await expect(page.getByRole("button", { name: "Play clip" })).toBeVisible();
  await expect(next).toHaveAttribute("data-primary", "");
  expect(await next.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(250, 70, 22)");
});

for (const width of [390, 1280, 1440]) {
  test(`at ${width} px the slide sits in the player column at 16:9 (12 px in; no height cap), the biggest thing on screen`, async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) !== width && !(width === 1440 && (viewport?.width ?? 0) === 1280), "one width per project");
    if (width === 1440) await page.setViewportSize({ width: 1440, height: 900 });
    const q = seed!.questions[0];
    await playingEmbed(page, q.match.start);
    await miss(page);
    await expect(page.getByRole("button", { name: "Pause clip" })).toBeVisible({ timeout: 5000 });
    const media = page.locator("figure [data-media]");
    const [m, f, strip] = await Promise.all([media.boundingBox(), page.locator("figure").boundingBox(), page.locator("main div[tabindex='-1']").boundingBox()]);
    expect(Math.abs(m!.width / m!.height - 16 / 9)).toBeLessThan(0.01);
    // The slide (its panel on desktop, as in the mockup, where the 380 px panel is the slide) outsizes the paper.
    const slideBox = width >= 1280 ? (await page.locator("figure [data-slide-panel]").boundingBox())! : m!;
    // From 1440 up. At 1280 the sheet column keeps a readable measure (460 px at least: John, Oct 25), so the slide,
    // sized by the height left, may be the smaller of the two there.
    if (width >= 1440 || width < 1024) expect(slideBox.width * slideBox.height, "about as big as the answer strip or bigger").toBeGreaterThan(0.7 * strip!.width * strip!.height);
    if (width >= 1280) {
      // The sheet column is 40% of the frame, 460 to 680 px (50%, 520 to 760 px, for a long question: John, Oct 25); the
      // player column is as wide as the height left lets its slide be, so the transport and transcript stay above the fold.
      const frame = await page.locator("[data-rewind-frame]").evaluate((e) => e.clientWidth - parseFloat(getComputedStyle(e).paddingLeft) - parseFloat(getComputedStyle(e).paddingRight));
      const long = (await page.locator("[data-sheet-column]").getAttribute("data-sheet-column")) === "long";
      const want = long ? Math.min(760, Math.max(520, frame * 0.5)) : Math.min(680, Math.max(460, frame * 0.4));
      expect(Math.abs(strip!.width - want), `sheet column ${Math.round(strip!.width)} px, want ${Math.round(want)}`).toBeLessThanOrEqual(1);
      expect(f!.width).toBeGreaterThan(440);
      const panel = (await page.locator("figure [data-slide-panel]").boundingBox())!;
      // No height cap any more (John, Oct 24): the video is as wide as its column.
      expect(Math.abs(m!.x + m!.width / 2 - (panel.x + panel.width / 2))).toBeLessThanOrEqual(1);
      expect(m!.y - panel.y).toBeCloseTo(12, 0);
      // The video scales to the height that is left: the transport keys (and Keep listening) are on screen
      // without scrolling at 1280x800 and 1440x900 (John, Oct 24).
      const vh = page.viewportSize()!.height;
      for (const el of [page.getByRole("group", { name: "Transport" }), page.getByRole("button", { name: "Keep listening" }).filter({ visible: true })]) {
        const b = (await el.boundingBox())!;
        expect(b.y + b.height, "above the bottom edge, no scroll").toBeLessThanOrEqual(vh - 16);
      }
      if (width === 1280) {
        // "Rewound to…" now heads the player, above the video, so it is on screen at the top of the page.
        const b = (await page.locator("[data-player-head] p[data-eyebrow]", { hasText: /^Rewound to /i }).boundingBox())!;
        expect(b.y + b.height).toBeLessThanOrEqual(800);
      }
    } else {
      // Phone: 12 px in from the panel's edges.
      expect(Math.abs(m!.x - f!.x - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(f!.x + f!.width - (m!.x + m!.width) - 12)).toBeLessThanOrEqual(1);
      // Phone: full width under the strip.
      expect(m!.y).toBeGreaterThan(strip!.y + strip!.height);
      expect(Math.abs(f!.width - strip!.width)).toBeLessThanOrEqual(1);
    }
    // The live caption has its own band under the slide: it never covers any of the slide image.
    const [img, band] = await Promise.all([page.locator("figure img").boundingBox(), page.locator("figure [data-caption-band]").boundingBox()]);
    await expect(page.locator("figure [data-caption]")).not.toHaveText(/^\s*$/);
    expect(band!.y, "the caption starts below the slide").toBeGreaterThanOrEqual(img!.y + img!.height);
    expect(band!.y + band!.height, "inside the slide panel").toBeLessThanOrEqual(f!.y + f!.height);
    await page.screenshot({ path: `.cache/shots/designer-rewind-frame-${width}.png` });
  });
}
