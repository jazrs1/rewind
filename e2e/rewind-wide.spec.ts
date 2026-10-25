// Wide screens (John, Oct 25): the rewind frame grows with the window (up to 1600 px), the sheet column is 40% of it
// (420 to 680 px; 50%, up to 760 px, for a long question or one with code), and the stem keeps a readable measure: at
// least ~45 characters a line, at 18 to 20 px, on the practice sheet, the graded sheet and the rewind screen alike.
// Every demo question, at 1280x800, 1440x900, 1920x1080 and 2560x1440; no page scroll at the first three.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "./test";
import type { DemoBundleFile } from "../lib/demo/bundle";

const bundle: DemoBundleFile = JSON.parse(readFileSync("public/demo/course/course.json", "utf8"));
const SIZES = [
  { width: 1280, height: 800, scroll: false },
  { width: 1440, height: 900, scroll: false },
  { width: 1920, height: 1080, scroll: false },
  { width: 2560, height: 1440, scroll: true },
];

/** The stem's measure: characters per full line (the last, partial line left out; one line is no wrap at all). */
async function measure(page: Page) {
  return page.evaluate(() => {
    const stem = [...document.querySelectorAll<HTMLElement>("[data-stem]")].find((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden");
    if (!stem) return null;
    // Every character a reader sees on each line (the rewind strip's question number shares the first line).
    const rows = new Map<number, number>();
    const range = document.createRange();
    const walk = document.createTreeWalker(stem, NodeFilter.SHOW_TEXT);
    for (let text = walk.nextNode(); text; text = walk.nextNode()) {
      for (let i = 0; i < text.textContent!.length; i++) {
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const r = range.getClientRects()[0];
        if (r && r.width > 0) rows.set(Math.round(r.top), (rows.get(Math.round(r.top)) ?? 0) + 1);
      }
    }
    const counts = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
    const full = counts.slice(0, -1);
    return {
      lines: counts.length,
      cpl: full.length ? full.reduce((a, b) => a + b, 0) / full.length : Infinity,
      px: parseFloat(getComputedStyle(stem).fontSize),
      overflow: document.scrollingElement!.scrollHeight - innerHeight,
    };
  });
}

for (const size of SIZES) {
  test(`every demo question at ${size.width}x${size.height}: the stem keeps 45+ characters a line on the sheet, graded and rewound${size.scroll ? "" : ", with no page scroll"}`, async ({ page }) => {
    test.skip(page.viewportSize()!.width < 1024, "desktop widths");
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const set of [...bundle.sets].sort((a, b) => a.id.localeCompare(b.id))) {
      await page.goto(`/demo/practice/${set.id}`);
      for (const q of set.questions) {
        const check = async (view: string) => {
          const m = (await measure(page))!;
          const what = `${set.id} q${set.questions.indexOf(q) + 1} ${view}`;
          expect(m, `${what}: a stem on screen`).not.toBeNull();
          expect.soft(m.px, `${what}: stem 18 to 20 px`).toBeGreaterThanOrEqual(18);
          expect.soft(m.px, `${what}: stem 18 to 20 px`).toBeLessThanOrEqual(20);
          expect.soft(m.cpl, `${what}: ${m.lines} lines`).toBeGreaterThanOrEqual(45);
          if (!size.scroll) expect.soft(m.overflow, `${what}: no page scroll`).toBeLessThanOrEqual(1);
        };
        await expect(page.locator("main h1")).toHaveText(q.stem);
        await check("asking");
        const wrong = q.choices.find((c) => c.label !== q.answer)!;
        await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
        await page.getByRole("button", { name: "Check answer" }).click();
        await expect(page.locator("[data-margin-note]").filter({ visible: true })).toBeVisible();
        await check("graded");
        const rewind = page.getByRole("button", { name: /^Rewind to .+'s explanation/ });
        if (await rewind.count()) {
          await rewind.click();
          await expect(page.locator("[data-counter]").filter({ visible: true })).toBeVisible();
          await page.waitForTimeout(150);
          await check("rewound");
        }
        await page.getByRole("button", { name: "Next question" }).filter({ visible: true }).click();
      }
    }
  });
}

// Tutor open (John, Oct 25): the slide fills the player column at 16:9, as wide as the transport under it; no page scroll.
for (const size of [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
]) {
  test(`tutor open at ${size.width}x${size.height}: the slide and the transport are one width, the reels shown, no page scroll`, async ({ page }) => {
    test.skip(page.viewportSize()!.width < 1024, "desktop widths");
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const set = [...bundle.sets].sort((a, b) => b.id.localeCompare(a.id))[0];
    const q = set.questions[0];
    await page.goto(`/demo/practice/${set.id}`);
    await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
    await page.getByRole("button", { name: "Check answer" }).click();
    await page.getByRole("button", { name: /^Rewind to .+'s explanation/ }).click();
    await expect(page.locator("[data-counter]").filter({ visible: true })).toBeVisible();
    await page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first().click();
    await expect(page.locator("[data-tutor-mode]")).toBeVisible();
    await page.waitForTimeout(400);
    const slide = (await page.locator("[data-tutor-mode] [data-slide-panel]").boundingBox())!;
    const transport = (await page.locator("[data-tutor-mode] [data-transport]").boundingBox())!;
    expect(Math.abs(slide.width - transport.width), "slide and transport one width").toBeLessThanOrEqual(1);
    const media = (await page.locator("[data-tutor-mode] [data-media]").boundingBox())!;
    expect(Math.abs(media.width / media.height - 16 / 9)).toBeLessThan(0.01);
    await expect(page.locator("[data-tutor-mode] [data-reels] svg")).toHaveCount(2);
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight), "no page scroll").toBeLessThanOrEqual(1);
    // The caption is one line, "Open slide" on its row; "Show question" is inside the summary strip.
    const caption = page.locator("[data-tutor-mode] figcaption [data-source] > span").first();
    expect(await caption.evaluate((e) => e.getClientRects().length === 1 && getComputedStyle(e).whiteSpace === "nowrap")).toBe(true);
    const strip = (await page.locator("[data-missed-summary] .paper-sheet").boundingBox())!;
    const show = (await page.getByRole("button", { name: "Show question" }).boundingBox())!;
    expect(show.y >= strip.y - 1 && show.y + show.height <= strip.y + strip.height + 8, "Show question inside the strip").toBe(true);
  });
}
