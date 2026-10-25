// Demo mode on the real COP3530 bundle (public/demo/course, used with Professor Kapoor's permission):
// landing → Try the demo → a wrong answer → the rewind lands on the clip (the hosted file when John has
// put it in public/demo/media/, else the clip's transcript) → the Course tape shows the example practice
// history. No private/ data, no extension, no Zoom, no keys.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "./test";
import type { DemoBundleFile, DemoQuestionFile, DemoSetFile } from "../lib/demo/bundle";
import { formatTime } from "../lib/format";
import { lectureLabel, practiceTitle } from "../lib/demo/lecture-label";

const bundle: DemoBundleFile = JSON.parse(readFileSync("public/demo/course/course.json", "utf8"));
const LABEL = "Demo course, materials used with Professor Kapoor's permission";
/** /demo/practice is the latest lecture's set; its first questions are the hosted-clip ones. */
const latest = [...bundle.sets].sort((a, b) => b.id.localeCompare(a.id))[0];
/** A hosted question whose file is there: public/demo/media/<questionId>.mp4. */
const hostedFile = (set: DemoSetFile, id: string) => set.hosted.includes(id) && existsSync(`public/demo/media/${id}.mp4`);
/** Set DEMO_SHOTS to a folder to save screenshots of each screen. */
const SHOTS = process.env.DEMO_SHOTS;

test.beforeEach(async ({ page }) => {
  // The demo never talks to Zoom, Canvas or a model API; fail loudly if it tries.
  await page.route(/^https:\/\/([a-z0-9-]+\.)*(zoom\.us|instructure\.com|googleapis\.com|anthropic\.com)\//, (route) => route.abort());
});

async function missAndRewind(page: Page, q: DemoQuestionFile) {
  const wrong = q.choices.find((c) => c.label !== q.answer)!;
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  // The grading beat comes first, naming his time; the rewind starts only on /^Rewind to .+'s explanation$/.
  await expect(page.getByText(`${bundle.lecturer.short} explains this at ${formatTime(q.clip.start)}`).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation/ }).click();
  await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();
}

test("Try the demo: a wrong answer rewinds to his clip, or to its transcript when the clip isn't hosted", async ({ page }, info) => {
  const q = latest.questions[0];
  const shot = (name: string) => (SHOTS ? page.screenshot({ path: `${SHOTS}/demo-${name}-${info.project.name}.png` }) : null);

  await page.goto("/");
  const tryIt = page.getByRole("link", { name: "Try the demo" });
  await expect(tryIt).toBeVisible();
  await tryIt.click();

  await expect(page).toHaveURL(/\/demo\/practice$/);
  await expect(page.getByRole("note").filter({ hasText: LABEL })).toBeVisible();
  await expect(page.getByText("synthetic placeholder")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(q.stem.slice(0, 30));
  await shot("question");

  await missAndRewind(page, q);
  // The counter lands on the clip start, in lecture time.
  await expect(page.locator("[data-counter]").filter({ visible: true })).toHaveText(formatTime(q.clip.start), { timeout: 8000 });
  const slide = page.getByRole("img", { name: `${q.slide.kind === "page" ? "Page" : "Slide"} ${q.slide.page} of` });

  if (hostedFile(latest, q.id)) {
    // The hosted clip, cut from the lecture at the clip start: it plays from its own 0:00.
    const media = page.locator("video, audio");
    await expect(media).toHaveAttribute("src", `/demo/media/${q.id}.mp4`);
    await expect.poll(() => media.evaluate((m: HTMLMediaElement) => (!m.paused ? m.currentTime : -1)), { timeout: 8000 }).toBeGreaterThanOrEqual(0);
    test.info().annotations.push({ type: "demo clip", description: "hosted" });
  } else {
    // No file yet: honest copy, the slide, and his words inside the clip; nothing playing, nothing spinning.
    await expect(page.getByRole("alert").filter({ hasText: "isn't available in the demo" })).toContainText(`The recording isn't available in the demo. Here's what ${bundle.lecturer.short} said:`);
    await expect(slide).toBeVisible();
    const list = page.getByRole("list", { name: "Transcript" }).filter({ visible: true });
    await expect(list).toContainText(q.lines[0].text.slice(0, 30));
    await expect(list.locator("[aria-current=true]")).toContainText(q.lines[0].text.slice(0, 30));
    await expect(page.locator("video, audio")).toHaveCount(0);
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    test.info().annotations.push({ type: "demo clip", description: "transcript (no hosted file)" });
  }
  await expect(page.getByRole("note").filter({ hasText: LABEL })).toBeVisible();
  await shot("rewind");
});

test("a hosted clip trimmed to its window plays to its end and stops there; Keep listening isn't offered, the transcript stays", async ({ page }) => {
  test.skip(!hostedFile(latest, latest.questions[0].id), "needs the hosted clip (public/demo/media)");
  const q = latest.questions[0];
  const wrong = q.choices.find((c) => c.label !== q.answer)!;
  await page.goto("/demo/practice");
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation/ }).click();
  // The file starts at the clip start (file time 0) and ends at the clip end: nothing past it to play.
  const media = page.locator("video, audio");
  await expect.poll(() => media.evaluate((a: HTMLMediaElement) => (!a.paused ? a.currentTime : -1)), { timeout: 8000 }).toBeGreaterThan(0);
  expect(await media.evaluate((a: HTMLMediaElement) => a.duration)).toBeLessThanOrEqual(q.clip.end - q.clip.start + 1);
  // Play to the clip's end: it stops there, with Replay and no Keep listening (hidden, not disabled).
  await media.evaluate((a: HTMLMediaElement) => (a.currentTime = a.duration - 1.5));
  await expect.poll(() => media.evaluate((a: HTMLMediaElement) => a.paused), { timeout: 6000 }).toBe(true);
  await expect(page.getByRole("button", { name: "Replay" }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep listening" })).toHaveCount(0);
  const slider = page.getByRole("slider", { name: "Clip position" });
  expect(Number(await slider.getAttribute("aria-valuemax"))).toBe(Math.round(q.clip.end - q.clip.start));
  await expect(page.locator("[data-counter]").filter({ visible: true })).not.toHaveText(/^\s*$/);
  // The clip's words are still there to read.
  const list = page.getByRole("list", { name: "Transcript" });
  if (!(await list.isVisible())) await page.getByRole("button", { name: "Read transcript" }).click();
  await expect(list).toContainText(q.lines.at(-1)!.text.slice(0, 30));
});

test("the Course tape shows the example practice history, labelled", async ({ page }) => {
  await page.goto("/demo/tape");
  await expect(page.getByRole("note").filter({ hasText: LABEL })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Course tape" }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Example practice history").filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });
  // One stop per lecture and topic (8 to 10), each taught on its lecture's day; the example misses ring some of them.
  const stops = [...new Set(bundle.sets.flatMap((s) => s.questions.map((q) => `${q.topic}\u0000${s.lecture.replace(/^Lecture, /, "")}`)))].map((k) => k.split("\u0000"));
  expect(stops.length).toBeGreaterThanOrEqual(8);
  expect(stops.length).toBeLessThanOrEqual(10);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [topic, day] of stops) {
    await expect(page.getByRole("button", { name: new RegExp(`^${esc(topic)}, Taught ${day}, stressed`) }).filter({ visible: true }).first()).toBeAttached();
  }
  await expect(page.getByRole("button", { name: /, missed [1-9]/ }).filter({ visible: true }).first()).toBeVisible();
});

test("each lecture's practice set starts with its hosted-clip questions, in order", async ({ page }) => {
  for (const set of bundle.sets) {
    expect(set.hosted.length).toBeGreaterThan(0);
    expect(set.questions.slice(0, set.hosted.length).map((x) => x.id)).toEqual(set.hosted);
    await page.goto(`/demo/practice/${set.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(set.questions[0].stem.slice(0, 30));
    // Phone: the tabs are in the Menu sheet.
    const menu = page.getByRole("button", { name: "Menu" });
    const phone = await menu.isVisible();
    if (phone) await menu.click();
    await expect(page.getByRole("navigation", { name: "Demo course" }).getByRole("link", { name: set.lecture.replace(/^Lecture, /, "") })).toHaveAttribute("aria-current", "page");
    if (phone) {
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
    }
    for (const [k, id] of set.hosted.entries()) {
      const hq = set.questions.find((x) => x.id === id)!;
      await expect(page.getByRole("heading", { level: 1 })).toContainText(hq.stem.slice(0, 30));
      if (k < set.hosted.length - 1) await page.getByRole("button", { name: "Skip for now" }).filter({ visible: true }).click();
    }
  }
});

test("a hosted question whose file isn't there shows the honest transcript fallback", async ({ page }) => {
  const set = bundle.sets.find((s) => s.hosted.some((id) => !hostedFile(s, id)));
  test.skip(!set, "every hosted clip is there");
  const k = set!.hosted.findIndex((id) => !hostedFile(set!, id));
  const q = set!.questions[k];
  await page.goto(`/demo/practice/${set!.id}`);
  for (let i = 0; i < k; i++) await page.getByRole("button", { name: "Skip for now" }).filter({ visible: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(q.stem.slice(0, 30));
  await missAndRewind(page, q);
  await expect(page.getByRole("alert").filter({ hasText: "isn't available in the demo" })).toContainText(`The recording isn't available in the demo. Here's what ${bundle.lecturer.short} said:`);
  await expect(page.locator("video, audio")).toHaveCount(0);
});

// Poll and answer slides (slide.revealsAnswer) show the answer, so nothing shows them before the student answers.
test.describe("an answer slide is never shown before the answer", () => {
  // The demo's service worker would answer tutor.json and the tutor route itself, past the routes below.
  test.use({ serviceWorkers: "block" });
  const flagged = bundle.sets.flatMap((s) => s.questions.map((q, i) => ({ set: s, q, i }))).filter((x) => x.q.slide.revealsAnswer);

  test("the two poll slides are flagged", () => {
    expect(flagged.map((x) => x.q.id)).toEqual(["l20261013-q2", "l20261020-q3"]);
  });

  for (const { set, q, i } of flagged) {
    test(`${q.id}: no slide image or slide chip while asking; after grading the slide appears`, async ({ page }) => {
      const image = page.locator(`img[src$="${q.slide.image.replace(/^slides\//, "")}"]`).filter({ visible: true });
      // The tutor's hint quotes this slide (a slide chip) and a lecture line (a tape chip).
      await page.route("**/api/demo/tutor", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body:
            [
              { t: "text", d: "What is the question really asking?" },
              {
                t: "done",
                mode: "hint",
                grounded: [
                  { kind: "lecture", quote: q.lines[0].text, start: q.lines[0].start },
                  { kind: "slide", quote: q.quote, deck: q.slide.deck, page: q.slide.page, pageKind: q.slide.kind },
                ],
                rewritten: false,
                confirmed: false,
                hintsUsed: 1,
                sig: "sig-1",
              },
            ]
              .map((e) => JSON.stringify(e))
              .join("\n") + "\n",
        }),
      );
      await page.goto(`/demo/practice/${set.id}`);
      for (let k = 0; k < i; k++) await page.getByRole("button", { name: "Skip for now" }).filter({ visible: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(q.stem.slice(0, 30));
      await expect(image).toHaveCount(0);
      await expect(page.getByRole("img", { name: new RegExp(`^(Slide|Page) ${q.slide.page} of`) }).filter({ visible: true })).toHaveCount(0);

      // A hint before answering: no slide chip, and no chip for the moment inside its own explanation either
      // (lib/tutor/poll.ts safeChips): the hint's words show alone.
      await page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first().click();
      const panel = page.getByRole("dialog", { name: "Tutor" });
      await panel.getByRole("button", { name: "Hint", exact: true }).click();
      const turn = panel.locator('[data-tutor-turn="hint"]').first();
      await expect(turn).toContainText("What is the question really asking?");
      await expect(turn.locator('[data-chip="slide"]')).toHaveCount(0);
      await expect(turn.locator('[data-chip="tape"]')).toHaveCount(0);
      await panel.getByRole("button", { name: "Close tutor" }).click();
      await expect(panel).toBeHidden();

      // Graded: the hint's slide chip appears, and Rewind shows the slide.
      const wrong = q.choices.find((c) => c.label !== q.answer)!;
      await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
      await page.getByRole("button", { name: "Check answer" }).click();
      await expect(page.getByText(`${bundle.lecturer.short} explains this at ${formatTime(q.clip.start)}`).filter({ visible: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first().click();
      await expect(turn.locator('[data-chip="slide"]')).toBeVisible();
      await panel.getByRole("button", { name: "Close tutor" }).click();
      await page.getByRole("button", { name: /^Rewind to .+'s explanation/ }).click();
      await expect(image.first()).toBeVisible();
    });
  }
});

test("the radar placeholder carries the label too", async ({ page }) => {
  await page.goto("/demo/radar");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("coming in the demo");
  await expect(page.getByRole("note").filter({ hasText: LABEL })).toBeVisible();
});

// John, Oct 24: each lecture's tab names what it covers ("Sorting · Oct 13"): the topic from its lecture deck (never a
// Discussion deck), at most 14 characters, then the date; the practice sheet's header says the same, in full.
test("the lecture tabs name each lecture's topic, then its date, and the sheet's header matches", async ({ page }) => {
  const sets = [...bundle.sets].sort((a, b) => a.id.localeCompare(b.id));
  await page.goto("/demo/practice");
  if (page.viewportSize()!.width >= 1024) {
    const tabs = page.getByRole("navigation", { name: "Demo course" }).locator(".demo-set");
    await expect(tabs).toHaveCount(sets.length);
    for (const [i, set] of sets.entries()) {
      const l = lectureLabel(set.questions.map((q) => q.slide.deck));
      const date = set.lecture.replace(/^Lecture,\s*/, "");
      expect(l, `${set.id}: a lecture deck to name it`).not.toBeNull();
      expect(l!.topic.length, `${set.id}: at most 14 characters`).toBeLessThanOrEqual(14);
      expect(l!.topic).not.toMatch(/^discussion\b/i);
      await expect(tabs.nth(i)).toHaveText(`${l!.topic}\u00a0· ${date}`);
    }
  }
  for (const set of sets) {
    await page.goto(`/demo/practice/${set.id}`);
    await expect(page.getByText(practiceTitle(set.lecture, set.questions.map((q) => q.slide.deck))).filter({ visible: true }).first()).toBeVisible();
  }
});

// John, Oct 24: on desktop the transport's three keys sit on the left, Play at the left edge, the tape window to their right.
test("desktop: the transport keys are left of the tape window, Play first", async ({ page }) => {
  test.skip(page.viewportSize()!.width < 1024, "desktop layout (the phone keeps the window above the keys)");
  await page.goto("/demo/practice");
  await missAndRewind(page, latest.questions[0]);
  const clip = page.getByRole("region", { name: "Lecture clip" });
  const keys = clip.getByRole("group", { name: "Transport" });
  await expect(keys).toBeVisible();
  const k = (await keys.boundingBox())!;
  const win = (await clip.locator("[data-tape-window]").boundingBox())!;
  expect(k.x + k.width, "the keys end before the tape window starts").toBeLessThanOrEqual(win.x);
  expect(Math.abs(k.y + k.height / 2 - (win.y + win.height / 2)), "keys and window on one row").toBeLessThan(k.height / 2);
  const xs = await keys.getByRole("button").evaluateAll((bs) => bs.map((b) => ({ name: b.getAttribute("aria-label") ?? b.textContent!.trim(), x: b.getBoundingClientRect().x })));
  const first = xs.reduce((a, b) => (b.x < a.x ? b : a));
  expect(first.name, "Play is the leftmost key").toMatch(/^(Play|Pause)/);
});

// John, Oct 25: the course label never runs under the tabs. The header shows just the course code; "Demo course" is in
// the permission strip.
for (const width of [1280, 1440]) {
  test(`at ${width} px the header's course label is whole and clear of the tabs; the strip says Demo course`, async ({ page }) => {
    test.skip(page.viewportSize()!.width < 1024, "desktop header");
    await page.setViewportSize({ width, height: 800 });
    for (const path of ["/demo/practice", "/demo/tape"]) {
      await page.goto(path);
      const course = page.locator("[data-brand-course]");
      await expect(course).toHaveText(bundle.course.code);
      expect(await course.evaluate((e) => e.scrollWidth <= e.clientWidth), `${path}: not cut off`).toBe(true);
      const c = (await course.boundingBox())!;
      const tabs = (await page.getByRole("navigation", { name: "Demo course" }).boundingBox())!;
      expect(c.x + c.width, `${path}: ends before the tabs`).toBeLessThanOrEqual(tabs.x);
      await expect(page.getByRole("note").filter({ hasText: LABEL })).toBeVisible();
      await expect(page.locator("[data-demo-label]")).toContainText(/^Demo course/);
    }
  });
}
