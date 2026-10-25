// The grading beat (teammate feedback, Oct 23: after a wrong answer the app jumped straight into the
// lecture, so it wasn't clear you got it wrong). Check answer grades the full-size sheet: the right oval
// fills green with "Correct", the red pen circles your oval with "You marked", a margin note gives his time,
// then /^Rewind to .+'s explanation$/ (primary) and "Next question". Only Rewind folds the sheet and plays.
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
          setTimeout(() => cb({ ok: true, state: { currentTime: at, paused, rate: 1, duration: 6081 }, media: { kind: "audio", videoWidth: null, videoHeight: null } }), 10);
        },
      },
    };
  });
}
const log = (page: Page) => page.evaluate(() => (window as unknown as { __log: Logged[] }).__log);

const wrongOf = (q: PracticeSeed["questions"][number]) => q.choices.find((c) => c.label !== q.answer)!;

async function answer(page: Page, label: string) {
  await page.getByRole("radio", { name: new RegExp(`^Option ${label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
}

test("a wrong answer is graded on the full sheet first, the clip cues meanwhile, and only Rewind plays it", async ({ page }) => {
  const q = seed!.questions[0];
  const wrong = wrongOf(q);
  await fakeExtension(page);
  await page.goto("/practice?set=seed");
  const sheet = page.locator("main > div").first();
  const before = (await sheet.boundingBox())!;
  await answer(page, wrong.label);

  // The sheet stays full size; the marked row is circled in red pen and says so, the right row says Correct.
  const marked = page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) });
  await expect(marked.locator("[data-pen-circle]")).toBeVisible();
  await expect(marked.getByText("You marked")).toBeVisible();
  expect(await marked.getByText("You marked").evaluate((e) => getComputedStyle(e).color)).toBe("rgb(154, 46, 34)");
  await expect(page.getByRole("radio", { name: new RegExp(`^Option ${q.answer},.*correct$`) }).getByText("Correct")).toBeVisible();
  const note = page.locator("[data-margin-note]").filter({ visible: true });
  // The professor by name, never "he" (John, Oct 24); the note in the sans with only its time in Caveat.
  await expect(note).toHaveText(`${seed!.lecturer.short} explains this at ${formatTime(q.match.start)} →`);
  expect(await note.locator(".font-hand").evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/caveat/i);
  expect(await note.locator(".font-hand").textContent()).toBe(formatTime(q.match.start));
  await expect(page.getByRole("status").filter({ hasText: "Incorrect" })).toHaveText(
    `Incorrect. You marked ${wrong.label}. The answer is ${q.answer}. ${seed!.lecturer.short} explains it at ${formatTime(q.match.start)}.`,
  );
  const sheetNow = (await sheet.boundingBox())!;
  expect(Math.abs(sheetNow.width - before.width)).toBeLessThanOrEqual(1);

  // Two next steps: Rewind (the one primary, print green) and Next question (outlined).
  const rewind = page.getByRole("button", { name: /^Rewind to .+'s explanation$/ });
  const next = page.getByRole("button", { name: "Next question" });
  await expect(rewind).toBeVisible();
  await expect(next).toBeVisible();
  expect(await rewind.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(36, 87, 63)");
  expect(await next.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect(rewind).toBeFocused();

  // Meanwhile the player is cued at the clip start (the confirmed seek), and nothing plays.
  await expect.poll(async () => (await log(page)).some((l) => l.type === "seek" && Math.abs(l.seconds! - q.match.start) < 0.5)).toBe(true);
  await page.waitForTimeout(500);
  expect((await log(page)).some((l) => l.type === "play")).toBe(false);
  await expect(page.getByText(/^Rewound to/).filter({ visible: true })).toHaveCount(0);

  // Rewind: the strip and the clip, landing on the right second, then it plays from there.
  await rewind.click();
  await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(q.match.start), { timeout: 3000 });
  await expect.poll(async () => (await log(page)).find((l) => l.type === "play")?.seconds, { timeout: 5000 }).toBeCloseTo(q.match.start, 0);
  await page.screenshot({ path: `.cache/shots/designer-grade-after-rewind-${page.viewportSize()!.width}.png` });
});

// The beat's order and spacing, read from each element's own animation timing (its computed CSS delay and
// duration on the motion tokens), not from wall-clock samples, so a busy machine can't fail it: Correct at
// once, then the red pen (with its wobble), "You marked", the margin note after the pen, then the next
// steps rising --stagger (60 ms) apart after the note.
test("the beat's order: Correct at once, then the pen, the note after it, then the steps 60 ms apart", async ({ page }) => {
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  await answer(page, wrongOf(q).label);
  await expect(page.locator("[data-grade-step]").first()).toBeAttached();
  const timing = await page.evaluate(() => {
    const ms = (v: string) => Math.round(parseFloat(v) * (v.trim().endsWith("ms") ? 1 : 1000));
    const of = (el: Element | null | undefined) => {
      if (!el) return null;
      const st = getComputedStyle(el);
      return { delay: ms(st.animationDelay.split(",")[0]), duration: ms(st.animationDuration.split(",")[0]), name: st.animationName };
    };
    const byText = (t: string) => [...document.querySelectorAll("span")].find((e) => e.textContent === t);
    return {
      correct: of(byText("Correct")),
      marked: of(byText("You marked")),
      pen: of(document.querySelector("[data-pen-circle] path")),
      wobble: of(document.querySelector("[data-pen-circle]")),
      note: of(document.querySelector("[data-margin-note]")),
      steps: [...document.querySelectorAll("[data-grade-step]")].map(of),
    };
  });
  const end = (t: { delay: number; duration: number } | null) => (t ? t.delay + t.duration : NaN);
  expect(timing.correct).toMatchObject({ delay: 0, duration: 200 });
  expect(timing.pen?.name).toBe("pen-draw");
  expect(timing.pen!.delay).toBeGreaterThan(timing.correct!.delay);
  expect(timing.wobble?.name).toBe("pen-wobble");
  expect(timing.wobble!.delay).toBe(timing.pen!.delay);
  expect(timing.marked!.delay).toBeGreaterThanOrEqual(timing.pen!.delay);
  // The beat overlaps its steps (John, Oct 24: about 0.6 s): the note starts while the pen is still drawing,
  // the steps rise as the pen finishes, 60 ms apart, and the last one lands by about 0.65 s.
  expect(timing.note!.delay).toBeGreaterThanOrEqual(timing.pen!.delay);
  expect(timing.note!.delay).toBeLessThan(end(timing.pen));
  expect(timing.steps.length).toBe(2);
  expect(timing.steps[0]!.delay).toBeGreaterThanOrEqual(timing.note!.delay);
  expect(Math.abs(timing.steps[1]!.delay - timing.steps[0]!.delay - 60)).toBeLessThanOrEqual(2);
  expect(end(timing.steps[1])).toBeLessThanOrEqual(650);
});

test("R rewinds and N goes to the next question, from the grade", async ({ page }) => {
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  await answer(page, wrongOf(q).label);
  await expect(page.getByRole("button", { name: /^Rewind to .+'s explanation$/ })).toBeVisible();
  await page.keyboard.press("r");
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(q.match.start), { timeout: 3000 });
  await expect(page.locator("[data-rewind-screen]")).not.toHaveAttribute("aria-hidden");

  await page.goto("/practice?set=seed");
  await answer(page, wrongOf(q).label);
  await expect(page.getByRole("button", { name: /^Rewind to .+'s explanation$/ })).toBeVisible();
  await page.keyboard.press("n");
  await expect(page.getByText(`Question 2 of ${seed!.questions.length}`)).toBeVisible();
});

test("a right answer: green and Correct, Next question is the primary, and a quiet link opens the explanation", async ({ page }) => {
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  await answer(page, q.answer);
  await expect(page.getByRole("radio", { name: new RegExp(`^Option ${q.answer},.*correct$`) }).getByText("Correct")).toBeVisible();
  await expect(page.locator("[data-pen-circle]")).toHaveCount(0);
  await expect(page.locator("[data-margin-note]")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Correct." })).toHaveText(`Correct. The answer is ${q.answer}.`);
  const next = page.getByRole("button", { name: "Next question" });
  expect(await next.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(36, 87, 63)");
  // (Keyboard, as the dev overlay badge can sit over this link at the foot of a phone screen.)
  await page.getByRole("button", { name: `Hear how ${seed!.lecturer.short} explains it` }).press("Enter");
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(q.match.start), { timeout: 3000 });
  await expect(page.getByText(/^You marked .*, correct:/).filter({ visible: true }).or(page.getByText("You marked · Correct").filter({ visible: true }))).toBeVisible();
});

test("with reduced motion every step of the beat is already in its final state", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  await answer(page, wrongOf(q).label);
  const states = await page.evaluate(() => {
    const pen = document.querySelector("[data-pen-circle] path")!;
    const note = [...document.querySelectorAll("[data-margin-note]")].find((e) => e.getClientRects().length)!;
    const next = document.querySelector("[data-grade-next]")!;
    return {
      running: document.getAnimations().filter((a) => a.playState === "running").length,
      dash: getComputedStyle(pen).strokeDashoffset,
      clip: getComputedStyle(note).clipPath,
      opacity: getComputedStyle(next).opacity,
    };
  });
  expect(states).toEqual({ running: 0, dash: "0px", clip: "none", opacity: "1" });
});

test("a question with no recording of it: the note points to the slide and the button opens it", async ({ page }) => {
  const q = seed!.questions[0];
  await page.addInitScript(() => {
    (window as unknown as { __rewindSeedPatch: unknown }).__rewindSeedPatch = { 0: { match: { start: null, end: null } } };
  });
  await fakeExtension(page);
  await page.goto("/practice?set=seed");
  await answer(page, wrongOf(q).label);
  await expect(page.locator("[data-margin-note]").filter({ visible: true })).toHaveText(`It's on slide ${q.match.slide.page} →`);
  const open = page.getByRole("link", { name: `Open slide ${q.match.slide.page}` });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("target", "_blank");
  expect(await open.getAttribute("href")).toBe(q.match.slide.canvasUrl ?? `/api/dev-slides/${q.match.slide.image}`);
  await expect(page.getByRole("button", { name: /^Rewind to .+'s explanation$/ })).toHaveCount(0);
  // No player is mounted, so nothing seeks or plays.
  await expect(page.locator("[data-rewind-screen]")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Incorrect" })).toContainText(`It's on slide ${q.match.slide.page}.`);
});

test("the answers are one tab stop: arrow keys and A to D move the choice, and focus follows it", async ({ page }) => {
  await page.goto("/practice?set=seed");
  const radio = (l: string) => page.getByRole("radio", { name: new RegExp(`^Option ${l},`) });
  await radio("A").click();
  await expect(radio("A")).toBeFocused();
  // Only the chosen answer is in the tab order.
  expect(await page.getByRole("radio").evaluateAll((els) => els.map((e) => e.getAttribute("tabindex")))).toEqual(["0", "-1", "-1", "-1"]);
  await page.keyboard.press("ArrowDown");
  await expect(radio("B")).toHaveAttribute("aria-checked", "true");
  await expect(radio("B")).toBeFocused();
  // A letter key moves focus along with the choice (never left on a radio that's out of the tab order).
  await page.keyboard.press("d");
  await expect(radio("D")).toHaveAttribute("aria-checked", "true");
  await expect(radio("D")).toBeFocused();
});
