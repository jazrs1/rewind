// Resilience: the demo offline after its first load, the transcript when a clip won't load, the route
// error boundary, the offline note, and no console errors on any screen. Demo tests use the committed
// bundle (public/demo/course); the clip-failure tests need its hosted clip (public/demo/media/<questionId>.mp4)
// and skip until John has put it there. The screens sweep reads the local private/ data when it's there.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "./test";
import type { DemoBundleFile } from "../lib/demo/bundle";

const bundle: DemoBundleFile = JSON.parse(readFileSync("public/demo/course/course.json", "utf8"));
/** /demo/practice: the latest lecture's set, its hosted-clip question first. */
const set = [...bundle.sets].sort((a, b) => b.id.localeCompare(a.id))[0];
const q = set.questions[0];
const wrong = q.choices.find((c) => c.label !== q.answer)!;
const CLIP = set.hosted[0] === q.id ? `/demo/media/${q.id}.mp4` : null;
const hosted = !!CLIP && existsSync(`public${CLIP}`);
const slideUrl = `/demo/course/${q.slide.image}`;

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*(zoom\.us|googleapis\.com|anthropic\.com)\//, (route) => route.abort());
});

/** The dev server's hot-reload socket can't reconnect offline; a build has no such socket. */
const DEV_HMR = /WebSocket connection to .*\/_next\/(webpack-)?hmr/;
/** The dev tools' own font, which the dev overlay asks for when its socket drops; a build has neither. */
const DEV_FONT = "/__nextjs_font/";

/** Console errors and uncaught exceptions on the page. `allow` drops the ones a test causes on purpose. */
function consoleErrors(page: Page, allow: RegExp[] = []) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || [DEV_HMR, ...allow].some((a) => a.test(m.text())) || m.location().url.includes(DEV_FONT)) return;
    errors.push(`${m.text()} (${m.location().url})`);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function missAndRewind(page: Page) {
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation/ }).click();
  await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();
}

const fallback = (page: Page) => page.getByRole("alert").filter({ hasText: "Couldn't load the recording, so here's what" });
/** No hosted file for the clip: the transcript from the start, said so. */
const notHosted = (page: Page) => page.getByRole("alert").filter({ hasText: "The recording isn't available in the demo" });

/** After a fallback: the button offers Play (nothing is playing), and the bold line is the clip's first, not the one before it. */
async function expectStoppedAtClipStart(page: Page) {
  await expect(page.getByRole("button", { name: "Play clip" }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause clip" }).filter({ visible: true })).toHaveCount(0);
  const first = q.lines.find((s) => s.end > q.clip.start)!;
  const bold = page.getByRole("list", { name: "Transcript" }).filter({ visible: true }).locator("[aria-current=true]");
  await expect(bold).toHaveCount(1);
  await expect(bold).toContainText(first.text.slice(0, 30));
}

test("the demo keeps working offline after the first load: the rewind plays from the cache (or the transcript shows), no errors", async ({ page, context }) => {
  const errors = consoleErrors(page);
  await page.goto("/demo/practice");
  // The service worker has cached the page, its assets, the clip and the slides.
  await expect(page.locator("html[data-demo-offline=ready]")).toBeAttached({ timeout: 30_000 });
  const cached = await page.evaluate(
    async (urls) => Promise.all(urls.map(async (u) => !!(await caches.match(new URL(u, location.origin).href)))),
    ["/demo/practice", slideUrl, ...(hosted ? [CLIP!] : [])],
  );
  expect(cached).toEqual(hosted ? [true, true, true] : [true, true]);

  const fromCache: string[] = [];
  page.on("response", (r) => void (r.fromServiceWorker() && fromCache.push(new URL(r.url()).pathname)));
  await context.setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "You're offline" })).toBeVisible();

  await missAndRewind(page);
  const media = page.locator("video, audio");
  await expect
    .poll(
      async () =>
        (await fallback(page).isVisible()) ||
        (await notHosted(page).isVisible()) ||
        ((await media.count()) > 0 && (await media.evaluate((a: HTMLMediaElement) => !a.paused && a.currentTime >= 0.5))),
      { timeout: 15_000 },
    )
    .toBe(true);
  if (await notHosted(page).isVisible()) {
    test.info().annotations.push({ type: "offline clip", description: "not hosted: transcript" });
  } else if (await fallback(page).isVisible()) {
    test.info().annotations.push({ type: "offline clip", description: "transcript fallback" });
  } else {
    // From the cache: the hosted file starts at the clip's second.
    expect(fromCache).toContain(CLIP);
    test.info().annotations.push({ type: "offline clip", description: "played from the cache" });
  }

  // A reload with no network still opens the demo, from the cache. (Only the HTML is checked: the dev server's
  // client waits for its hot-reload socket before hydrating; a build doesn't have one.)
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(q.stem.slice(0, 30));
  expect(fromCache).toContain("/demo/practice");
  expect(errors).toEqual([]);
});

test.describe("when the clip can't load", () => {
  // Without the demo's service worker, so the page's own route decides what the clip request gets.
  test.use({ serviceWorkers: "block" });
  test.skip(!hosted, `needs the hosted clip ${CLIP} (John drops it in public/demo/media/)`);

  test("a failed clip shows the transcript lines for that clip instead, never a spinner", async ({ page }) => {
    const errors = consoleErrors(page, [/Failed to load resource/]);
    await page.route(`**${CLIP}`, (route) => route.abort("failed"));
    await page.goto("/demo/practice");
    await missAndRewind(page);
    await expect(fallback(page)).toBeVisible({ timeout: 10_000 });
    await expect(fallback(page)).toContainText(`here's what ${bundle.lecturer.short} said`);
    const list = page.getByRole("list", { name: "Transcript" });
    await expect(list).toBeVisible();
    // The line he's on at the clip's start is there to read.
    const first = q.lines.filter((s) => s.start <= q.clip.start + 0.05).at(-1)!;
    await expect(list).toContainText(first.text.slice(0, 30));
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    await expectStoppedAtClipStart(page);
    expect(errors).toEqual([]);
  });

  test("a clip that never answers times out to the transcript", async ({ page }) => {
    test.setTimeout(45_000);
    // The request hangs: no data, no error.
    await page.route(`**${CLIP}`, () => {});
    await page.goto("/demo/practice");
    await missAndRewind(page);
    await expect(fallback(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("list", { name: "Transcript" })).toBeVisible();
    await expectStoppedAtClipStart(page);
  });
});

test("a screen that throws shows the error boundary: plain words, a retry, no stack or message", async ({ page }) => {
  await page.goto("/dev/throw");
  const state = page.locator("[data-error-state]");
  await expect(state).toBeVisible();
  await expect(state.getByRole("heading", { level: 1 })).toHaveText("This page didn't load");
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("secret detail");
  expect(body).not.toMatch(/\bat .+:\d+:\d+/);
  // Retry re-renders the segment (this one throws again, so the boundary stays, with its button).
  await state.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("[data-error-state]").getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
});

test("/course/import: the skeleton keeps the header's import line, so the cards don't move when the data swaps in", async ({ browser, viewport }) => {
  // With JavaScript off the fallback stays and the streamed content waits hidden; swap it in as React does.
  const ctx = await browser.newContext({ viewport, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto("/course/import");
  const top = () => page.evaluate(() => document.querySelector("main header")?.nextElementSibling?.getBoundingClientRect().y ?? null);
  const before = await top();
  const swapped = await page.evaluate(() => {
    const start = document.getElementById("B:0");
    const content = document.getElementById("S:0");
    if (!start || !content) return false;
    const fallback: ChildNode[] = [];
    for (let n = start.nextSibling; n && !(n.nodeType === 8 && (n as Comment).data === "/$"); n = n.nextSibling) fallback.push(n);
    fallback.at(-1)!.after(...content.childNodes);
    for (const f of fallback) f.remove();
    return true;
  });
  test.skip(!swapped || !(await page.locator("[data-section=exams]").count()), "needs the local pipeline report in private/");
  expect(before).not.toBeNull();
  expect(Math.abs((await top())! - before!)).toBeLessThanOrEqual(2);
  await ctx.close();
});

// /demo/practice/<lecture>: params read outside <Suspense> was a dev console error there.
for (const path of ["/", "/course", "/course/import", "/course/tape", "/practice", "/demo/practice", `/demo/practice/${bundle.sets[0].id}`]) {
  test(`${path}: no console errors, and a small offline note that covers nothing`, async ({ page, context }) => {
    const errors = consoleErrors(page);
    await page.goto(path);
    await expect(page.locator("main").first()).toBeVisible();
    await expect(page.locator("main[aria-busy=true]")).toHaveCount(0, { timeout: 15_000 });
    // The demo is offline-ready after its first load: let that finish (else the service worker's install fails offline).
    if (path.startsWith("/demo")) await expect(page.locator("html[data-demo-offline=ready]")).toBeAttached({ timeout: 30_000 });
    // And the page's images (a slide that was still loading would fail offline, which is not the note's doing).
    await page.waitForLoadState("networkidle");
    await context.setOffline(true);
    const note = page.getByRole("status").filter({ hasText: "You're offline" });
    await expect(note).toBeVisible();
    // No heading, link, banner or the demo label under it.
    const covered = await note.evaluate((n) => {
      const a = n.getBoundingClientRect();
      return [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, a, header, [role=banner], [role=note]")]
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        })
        .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
    });
    expect(covered).toEqual([]);
    await context.setOffline(false);
    await expect(note).toBeHidden();
    expect(errors).toEqual([]);
  });
}
