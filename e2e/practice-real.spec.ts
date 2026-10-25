// /practice on GENERATED questions: the pipeline's output shape (lib/pipeline/types.ts) through the real
// conversion (toPracticeSeed), served in dev at /practice?set=e2e-fixture. The fixture's text is
// invented (lib/pipeline/fixtures/practice-real.ts); its slide renders are in e2e/fixtures/slides/.
//   1. a question with a code block and a clip: graded wrong, cued at the clip start, Rewind plays
//      from there; the code is printed, the slide renders (slug + hash + page name), the scrub bar,
//      captions and source label work
//   2. a question with no clip: its page on the sheet under a blank tape ("No tape for this lecture yet"), no player
//   3. a question whose clip is in another lecture: that recording is the one cued; its slide is only
//      stored under the older name and still renders
import { expect, test, type Page } from "./test";
import { formatTime } from "../lib/format";
import { fixtureOutput } from "../lib/pipeline/fixtures/practice-real";
import { slideImageName } from "../lib/pipeline/run";

const [withCode, noClip, otherLecture, canvasPage] = fixtureOutput.questions;
const URL = "/practice?set=e2e-fixture";

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

type Logged = { type: string; seconds?: number };

/** A fake extension whose frame answers at once; logs what the app sends. */
async function fakeExtension(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { chrome: unknown; __log: Logged[] };
    w.__log = [];
    let paused = true;
    let at = 0;
    w.chrome = {
      runtime: {
        sendMessage(_id: string, msg: { type: string; seconds?: number }, cb: (r: unknown) => void) {
          w.__log.push({ type: msg.type, seconds: msg.seconds });
          if (msg.seconds !== undefined && (msg.type === "seek" || msg.type === "play")) at = msg.seconds;
          if (msg.type === "play") paused = false;
          if (msg.type === "pause") paused = true;
          setTimeout(() => cb({ ok: true, state: { currentTime: at, paused, rate: 1, duration: 3000 }, media: { kind: "audio", videoWidth: null, videoHeight: null } }), 10);
        },
      },
    };
  });
}
const log = (page: Page) => page.evaluate(() => (window as unknown as { __log: Logged[] }).__log);
const wrongOf = (q: (typeof fixtureOutput.questions)[number]) => q.choices.find((c) => c.label !== q.answer)!;
const shot = (page: Page, name: string) => page.screenshot({ path: `.cache/shots/practice-real-${name}-${page.viewportSize()!.width}.png` });

async function answer(page: Page, label: string) {
  await page.getByRole("radio", { name: new RegExp(`^Option ${label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
}

async function skipTo(page: Page, stem: string) {
  for (let i = 0; i < 6 && !(await page.getByRole("heading", { level: 1, name: stem }).isVisible()); i++) await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(stem);
}

/** How many px tall the area is where a tap at the element's centre column lands on it (::before hit areas included), within the window. */
async function hitHeight(page: Page, el: ReturnType<Page["locator"]>, selector: string): Promise<number> {
  const b = (await el.boundingBox())!;
  return page.evaluate(
    ([x, cy, sel, label]) => {
      let n = 0;
      for (let dy = -40; dy <= 40; dy++) {
        const hit = document.elementFromPoint(x as number, (cy as number) + dy)?.closest(sel as string);
        if (hit && (hit.getAttribute("aria-label") ?? hit.textContent) === label) n++;
      }
      return n;
    },
    [b.x + b.width / 2, b.y + b.height / 2, selector, await el.evaluate((e) => e.getAttribute("aria-label") ?? e.textContent)] as const,
  );
}

/** The image has loaded and decoded (a broken image has naturalWidth 0). */
async function rendered(img: ReturnType<Page["locator"]>) {
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), { timeout: 5000 }).toBe(true);
}

test("a generated question with code and a clip: graded wrong, cued at the clip start, Rewind plays from there", async ({ page }) => {
  await fakeExtension(page);
  await page.goto(URL);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(withCode.stem);

  // The code is printed on the sheet, and the source label names the slide.
  const block = page.getByRole("group", { name: "Code for question 1" }).filter({ visible: true });
  await expect(block.locator("code")).toHaveText(withCode.code!.lines.join(""));
  await expect(page.getByText(/^Source: Slide 3 · /).filter({ visible: true }).first()).toBeVisible();
  await shot(page, "asking");

  await answer(page, wrongOf(withCode).label);
  const start = withCode.retrieval.clip!.start;
  await expect(page.locator("[data-margin-note]").filter({ visible: true })).toHaveText(new RegExp(`^.+ explains this at ${formatTime(start)} →$`));
  // The recording is cued (a confirmed seek to the clip start) during the grading beat; nothing plays yet.
  await expect.poll(async () => (await log(page)).some((l) => l.type === "seek" && Math.abs(l.seconds! - start) < 0.5)).toBe(true);
  expect((await log(page)).some((l) => l.type === "play")).toBe(false);
  await expect(page.locator(`iframe[src="${withCode.retrieval.clip!.recordingUrl}"]`)).toHaveCount(1);
  await page.waitForTimeout(1200); // the grading beat (pen, note, then the buttons) has finished
  await shot(page, "graded");

  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(start), { timeout: 3000 });
  await expect.poll(async () => (await log(page)).find((l) => l.type === "play")?.seconds, { timeout: 5000 }).toBeCloseTo(start, 0);
  // The slide renders, by its slug + hash + page name.
  const img = page.locator("[data-rewind-screen] figure img");
  await expect(img).toHaveAttribute("src", `/api/dev-slides/${slideImageName("Fake Heaps Deck", 3, 101)}`);
  await rendered(img);
  // The scrub bar spans the clip; the caption is his line at the clip start (the student's line is never shown).
  const slider = page.getByRole("slider", { name: "Clip position" });
  await expect(slider).toHaveAttribute("aria-valuemax", String(withCode.retrieval.clip!.end - start));
  await expect(page.getByText("The new value goes in the next free slot at the bottom.").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("Watch where the new value lands before anything moves.").filter({ visible: true })).toHaveCount(0);

  // The scrub bar's touch area is at least 44 px tall (what a tap actually lands on, not the thin track).
  expect(await hitHeight(page, slider, '[role="slider"]')).toBeGreaterThanOrEqual(44);
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const example = page.getByRole("button", { name: /^From the start of the example/ });
  if (page.viewportSize()!.width >= 1024) {
    // Desktop: every line of the question's code shows in the strip (no inner scroll), the header names the
    // course once, and the practice-data footer sits below the rewind screen, never over its controls.
    const strip = page.locator("[data-rewind-screen] [data-code]").filter({ visible: true });
    await expect(strip.locator("code > span")).toHaveCount(withCode.code!.lines.length);
    expect(await strip.evaluate((pre) => pre.scrollHeight <= pre.clientHeight + 1 && pre.scrollWidth <= pre.clientWidth + 1)).toBe(true);
    // The whole strip fits its column: stem, code and all four choices, nothing scrolled or cut.
    const card = page.locator("[data-strip-fit]");
    expect(await card.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    const cardBox = (await card.boundingBox())!;
    for (const li of await card.locator("li").filter({ visible: true }).all()) {
      const b = (await li.boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
    }
    await expect(page.locator("[data-rewind-screen] header")).toContainText("FAKE7 Fake Data Structures");
    const footer = page.getByRole("contentinfo", { name: "Your practice data" });
    await footer.scrollIntoViewIfNeeded();
    for (const el of [example, slider]) expect(overlaps((await footer.boundingBox())!, (await el.boundingBox())!)).toBe(false);
  } else {
    // Phone (390x844): time left, Read transcript and the example button are above the sticky Next question bar, not under it.
    const bar = (await page.locator("[data-next-bar]").boundingBox())!;
    for (const el of [page.getByText(/seconds left of the clip/).filter({ visible: true }), page.getByRole("button", { name: "Read transcript" }), example]) {
      const b = (await el.boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(bar.y + 0.5);
    }
  }
  await shot(page, "rewind");
});

test("a long generated set: the progress row stays one short line, with no sideways scroll", async ({ page }) => {
  await page.goto(URL);
  const row = page.locator("[role=img][aria-label^='Question ']").first();
  await expect(row).toHaveAttribute("aria-label", `Question 1 of ${fixtureOutput.questions.length}, none answered yet`);
  // More questions than PROGRESS_DOTS (14): 14 ovals.
  expect(fixtureOutput.questions.length).toBeGreaterThan(14);
  await expect(row.locator("[data-progress-dot]")).toHaveCount(14);
  await expect(page.getByText(`Question 1 of ${fixtureOutput.questions.length}`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Further in, the window follows the current question.
  for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "Skip for now" }).click();
  // Question 9 of 16, centred in 14 ovals: they start at question 3.
  await expect(row.locator("[data-progress-dot]").first()).toHaveAttribute("data-progress-dot", String(Math.max(1, Math.min(9 - 6, fixtureOutput.questions.length - 14 + 1))));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The practice-data button keeps a 44 px touch area, inside the window.
  const clear = page.getByRole("button", { name: "Clear my practice data" });
  await clear.scrollIntoViewIfNeeded();
  expect(await hitHeight(page, clear, 'button[type="button"]')).toBeGreaterThanOrEqual(44);
});

test("a generated question with no clip: its page on the sheet and an honest line, never a player", async ({ page }) => {
  await fakeExtension(page);
  await page.goto(URL);
  await skipTo(page, noClip.stem);
  await answer(page, wrongOf(noClip).label);

  await expect(page.locator("[data-margin-note]").filter({ visible: true })).toHaveText("It's on page 2 →");
  // Focus goes to the graded question (its page is right under it), not to a link that opens a new tab.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  const fallback = page.locator("figure[data-no-clip]").filter({ visible: true });
  // A blank tape says there is no recording (PhoneReading lines 30-37), then the slide.
  await expect(fallback).toContainText("No tape for this lecture yet");
  await expect(fallback.locator("img")).toHaveAttribute("src", `/api/dev-slides/${slideImageName("Fake Course Notes", 2, 102)}`);
  await rendered(fallback.locator("img"));
  await expect(page.getByRole("link", { name: "Open page 2" })).toHaveAttribute("href", noClip.retrieval.slide!.href!);
  await expect(page.getByRole("button", { name: /^Rewind to .+'s explanation$/ })).toHaveCount(0);
  // No player is mounted, so nothing seeks or plays.
  await expect(page.locator("[data-rewind-screen]")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await log(page)).toEqual([]);
  // The sheet still never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.waitForTimeout(1200);
  await shot(page, "noclip");
});

test("a question quoting a Canvas page: Page as its source and the page's words, no image, no player", async ({ page }) => {
  await fakeExtension(page);
  await page.goto(URL);
  await skipTo(page, canvasPage.stem);
  await expect(page.getByText("Page · Fake Lesson 3").filter({ visible: true }).first()).toBeVisible();
  await answer(page, wrongOf(canvasPage).label);
  await expect(page.locator("[data-margin-note]").filter({ visible: true })).toHaveText("It's on the course page →");
  const fallback = page.locator("figure[data-no-clip]").filter({ visible: true });
  await expect(fallback.locator("[data-page-excerpt]")).toHaveText(canvasPage.quote);
  await expect(fallback.locator("img")).toHaveCount(0);
  await expect(fallback).toContainText("No tape for this lecture yet");
  await expect(page.getByRole("link", { name: "Open the page" })).toHaveAttribute("href", canvasPage.retrieval.page!.href!);
  await expect(page.locator("[data-rewind-screen]")).toHaveCount(0);
  expect(await log(page)).toEqual([]);
});

test("a clip in another lecture cues that recording; a slide stored under its older name still renders", async ({ page }) => {
  await fakeExtension(page);
  await page.goto(URL);
  await skipTo(page, otherLecture.stem);
  await answer(page, wrongOf(otherLecture).label);
  const clip = otherLecture.retrieval.clip!;
  await expect(page.locator(`iframe[src="${clip.recordingUrl}"]`)).toHaveCount(1);
  await expect.poll(async () => (await log(page)).some((l) => l.type === "seek" && Math.abs(l.seconds! - clip.start) < 0.5)).toBe(true);
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(clip.start), { timeout: 3000 });
  await rendered(page.locator("[data-rewind-screen] figure img"));
});
