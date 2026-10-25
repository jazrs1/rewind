// The demo moment: miss a practice question, and the rewind lands on the professor's explanation.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "./test";
import { formatTime } from "../lib/format";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed, "needs the local practice seed (npm run spike:seed)");

// Tests never contact Zoom: the embedded recording frame is blocked (it then falls back, as without the extension).
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

test("a wrong answer rewinds to the explanation, with the slide and setup line", async ({ page }) => {
  const q = seed!.questions[0];
  const wrong = q.choices.find((c) => c.label !== q.answer)!;

  await page.goto("/practice?set=seed");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(q.stem.slice(0, 30));
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await expect(page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();

  // The sheet becomes a strip that says what you marked and the right answer.
  await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();

  // The counter rolls back and stops at the clip start; the slide and the setup line are beside it.
  await expect(page.getByText(formatTime(q.match.start), { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole("img", { name: new RegExp(`Slide ${q.match.slide.page} of`) })).toBeVisible();
  if (q.match.setup) await expect(page.getByText(q.match.setup).filter({ visible: true }).first()).toBeVisible();

  // Keyboard: N goes to the next question.
  await page.keyboard.press("n");
  await expect(page.getByText(`Question 2 of ${seed!.questions.length}`)).toBeVisible();
});

test("a right answer fills the oval and says Correct, with no rewind", async ({ page }) => {
  const q = seed!.questions[0];
  const other = q.choices.find((c) => c.label !== q.answer)!;
  await page.goto("/practice?set=seed");
  // A click first, so the page is hydrated before the keyboard is used.
  await page.getByRole("radio", { name: new RegExp(`^Option ${other.label},`) }).click();
  await page.keyboard.press(q.answer.toLowerCase());
  await expect(page.getByRole("radio", { name: new RegExp(`^Option ${q.answer},`) })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.getByRole("radio", { name: new RegExp(`^Option ${q.answer},.*correct$`) })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next question" })).toBeVisible();
  // No rewind: the player waits out of sight (cued), and nothing rolls or plays.
  await expect(page.getByText("Rewound to").filter({ visible: true })).toHaveCount(0);
  await page.waitForTimeout(1200);
  await expect(page.locator("[data-rewind-screen]")).toHaveAttribute("aria-hidden", "true");
});

// Regressions from the first reviewer pass (Oct 23).
test.describe("review regressions", () => {
  async function miss(page: import("@playwright/test").Page) {
    const q = seed!.questions[0];
    const wrong = q.choices.find((c) => c.label !== q.answer)!;
    await page.goto("/practice?set=seed");
    await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
    // Enter on the focused answer checks it (it used to re-select instead).
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
    await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();
    return q;
  }

  test("Enter after a mouse click checks the answer, and Next question is in view", async ({ page }) => {
    await miss(page);
    await expect(page.getByRole("button", { name: "Next question" })).toBeInViewport();
  });

  test("the transcript opens scrolled to the clip, and Hide transcript closes it in the error state", async ({ page, isMobile, viewport }) => {
    test.skip(!!isMobile || (viewport?.width ?? 0) >= 1024, "phone layout only");
    const q = await miss(page);
    // Without the extension the transcript opens by itself, scrolled so the clip's first line is inside the list's view.
    const startText = q.segments.find((s) => s.start >= q.match.start)!.text;
    await expect
      .poll(() =>
        page.evaluate((text) => {
          const list = document.querySelector<HTMLElement>('ol[aria-label="Transcript"]')!;
          const item = [...list.children].find((li) => li.textContent?.includes(text)) as HTMLElement | undefined;
          if (!item) return "missing";
          const inView = item.offsetTop >= list.scrollTop && item.offsetTop + Math.min(item.offsetHeight, 40) <= list.scrollTop + list.clientHeight;
          return inView ? "in view" : `out of view (top ${item.offsetTop}, scrollTop ${list.scrollTop})`;
        }, startText),
      )
      .toBe("in view");
    await page.getByRole("button", { name: "Hide transcript" }).click();
    await expect(page.getByRole("list", { name: "Transcript" })).toBeHidden();
  });
});

test("when the embedded frame never loads, it falls back to a Zoom tab and shows the setup card", async ({ page, viewport }) => {
  const desktop = (viewport?.width ?? 0) >= 1024;
  test.setTimeout(30_000);
  const q = seed!.questions[0];
  // A fake extension: the embedded frame never reports a player; the background Zoom tab plays.
  await page.addInitScript((start) => {
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage(_id: string, msg: { embed?: boolean; type: string }, cb: (r: unknown) => void) {
          const state = { currentTime: start, paused: msg.type !== "play", rate: 1, duration: 6081 };
          setTimeout(() => cb(msg.embed ? { ok: false, error: "no-frame" } : { ok: true, state }), 10);
        },
      },
    };
  }, q.match.start);
  const wrong = q.choices.find((c) => c.label !== q.answer)!;
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await expect(page.locator("iframe")).toHaveCount(1);
  // The fallback drops the frame; the setup card is desktop-only (phone browsers can't run the extension).
  await expect(page.locator("iframe")).toHaveCount(0, { timeout: 12_000 });
  const card = page.getByRole("complementary", { name: "Play lectures inside Rewind" });
  if (!desktop) {
    await expect(card).toBeHidden();
    return;
  }
  // Regression (review, Oct 23): the collapsed card fits on screen, and opening it doesn't scroll the page.
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect(page.getByText(/extension isn't installed/)).toHaveCount(0);
  // Regression (review, Oct 23): the card must not push the player controls below the fold.
  await expect(page.getByRole("button", { name: /^(Play|Pause) clip$/ })).toBeInViewport();
  await page.getByRole("button", { name: "Show me how" }).click();
  await expect(page.getByText("chrome://settings/cookies")).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("the setup card names Brave's settings page in Brave", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1024, "the setup card is desktop-only");
  const q = seed!.questions[0];
  await page.addInitScript(() => {
    (navigator as unknown as { brave: unknown }).brave = { isBrave: () => Promise.resolve(true) };
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage(_id: string, msg: { embed?: boolean; type: string }, cb: (r: unknown) => void) {
          setTimeout(() => cb(msg.embed ? { ok: false, error: "no-frame" } : { ok: true, state: { currentTime: 918, paused: true, rate: 1, duration: 6081 } }), 10);
        },
      },
    };
  });
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await page.getByRole("button", { name: "Show me how" }).click({ timeout: 12_000 });
  await expect(page.getByText("brave://settings/cookies")).toBeVisible();
});

test("with reduced motion the sheet swaps to the strip at once and the counter starts at the clip time", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const q = seed!.questions[0];
  const wrong = q.choices.find((c) => c.label !== q.answer)!;
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  // No fold and no rolling counter: the counter already reads the clip start, and focus is on the strip.
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(q.match.start), { timeout: 500 });
  await expect(page.locator("[data-strip-ghost]")).toHaveCount(0);
  await expect(page.locator("[data-odometer]")).toHaveCount(0);
  await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator(":focus")).toContainText("You marked");
});

test("with motion the sheet folds into the strip, then the counter rolls down to the clip start", async ({ page }) => {
  const q = seed!.questions[0];
  const wrong = q.choices.find((c) => c.label !== q.answer)!;
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  // The fold's stand-in is on screen, then gone; the rolling counter gives way to the clip start.
  await expect(page.locator("[data-odometer]")).toHaveCount(1);
  await expect(page.locator("[data-strip-ghost]")).toHaveCount(0, { timeout: 1000 });
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(q.match.start), { timeout: 3000 });
  await expect(page.locator("[data-odometer]")).toHaveCount(0);
  await expect(page.locator(":focus")).toContainText("You marked");
});
