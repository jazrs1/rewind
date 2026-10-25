// Course tape (CourseTape mockup): stops as named buttons in tape order, each stop's evidence on tap
// (or "not found"), and tonight's route back, whose "Start the route back" plays a real clip.
// Runs on the local private/ data (skips without it) and on the demo course's tape (/demo/tape, always there).
// Tests never contact Zoom.
import { expect, test, type Page } from "./test";
import { formatTime } from "../lib/format";

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

/** The local course's tape (private/ data) and the demo course's, built from the committed bundle. */
const PATHS = ["/course/tape", "/demo/tape"] as const;

async function open(page: Page, path: (typeof PATHS)[number]) {
  await page.goto(path);
  const empty = page.getByRole("heading", { name: "No course data yet" });
  const title = page.getByRole("heading", { name: "Course tape", exact: true, level: 1 });
  await expect(empty.or(title)).toBeVisible();
  test.skip(await empty.isVisible(), "needs lecture transcripts or a Canvas export in private/");
  // The skeleton has the title too: wait for the tape itself.
  await expect(page.locator("[data-stop-id]:visible").first()).toBeVisible();
  return title;
}

/** On the phone the route is a bottom sheet behind the "Tonight's route back" bar. */
async function routeArea(page: Page, phone: boolean) {
  if (phone) {
    await page.getByRole("button", { name: /^Tonight's route back/ }).click();
    return page.getByRole("dialog", { name: "Tonight's route back" });
  }
  return page.locator("aside");
}

for (const path of PATHS) {
  test(`${path}: stops in tape order, named with their scores; tapping one shows its evidence or says not found`, async ({ page }) => {
    const title = await open(page, path);
    // The mockup's title: Bricolage 800 at 40 px.
    expect(await title.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight])).toEqual(["40px", "800"]);

    const stops = page.locator("[data-stop-id]:visible");
    const n = await stops.count();
    expect(n).toBeGreaterThan(0);
    expect(await stops.evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-order"))))).toEqual(Array.from({ length: n }, (_, i) => i));
    const dates = (await stops.evaluateAll((els) => els.map((el) => el.getAttribute("data-first-taught") ?? ""))).filter(Boolean);
    expect(dates).toEqual([...dates].sort());
    const states = await stops.evaluateAll((els) => els.map((el) => el.getAttribute("data-state")));
    expect(states.filter((s) => s === "current").length).toBeLessThanOrEqual(1);
    if (states.includes("current")) expect(states.slice(states.indexOf("current") + 1)).not.toContain("past");
    for (const name of await stops.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))) {
      expect(name).toMatch(/^.+, Taught( \w{3} \d{1,2}|: not found), stressed [\d.]+, missed [\d.]+(, on the next exam)?(, stop [1-3] on tonight's route back)?$/);
    }
    // A stop glows only when its name says it was stressed: both come from the same score.
    const glowing = await page.locator("[data-glow-for]").evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-glow-for")));
    // The demo's lectures are clip excerpts: it glows only from flags, reviews and topic-stats.json, so it may not glow at
    // all (the glow test below holds either way). A course with full lectures has glowing stops.
    if (path !== "/demo/tape") expect(glowing.length).toBeGreaterThan(0);
    for (const id of glowing) await expect(page.locator(`[data-stop-id="${id}"]:visible`)).not.toHaveAttribute("aria-label", /, stressed 0,/);
    // Tap targets.
    const box = await stops.first().boundingBox();
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);

    // A stressed stop shows its evidence, each with its source in small print.
    const stressed = page.locator('[data-stop-id]:visible:not([aria-label*=", stressed 0,"])').first();
    if (await stressed.count()) {
      const name = (await stressed.getAttribute("aria-label"))!.split(", Taught")[0];
      await stressed.click();
      const sheet = page.getByRole("dialog", { name });
      await expect(sheet).toBeVisible();
      const evidence = sheet.getByRole("list", { name: `Evidence for ${name}` }).locator("li");
      await expect(evidence.first()).toBeVisible();
      await expect(evidence.first().locator("[data-source]")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    } else expect(path, "only the demo may have no stressed stop").toBe("/demo/tape");

    // A stop with no stressed evidence doesn't glow and its tile says so as its title, with nothing under it (John, Oct 25).
    const calm = page.locator('[data-stop-id]:visible[aria-label*=", stressed 0,"]').first();
    if (await calm.count()) {
      const calmName = (await calm.getAttribute("aria-label"))!.split(", Taught")[0];
      await calm.click();
      const tile = page.getByRole("dialog", { name: calmName }).getByRole("region", { name: `Stressed: ${calmName}` });
      await expect(tile.getByRole("heading")).toHaveText("Not flagged yet");
      await expect(tile.locator("p")).toHaveCount(0);
    }
  });

  test(`${path}: glow wording only when a stop glows; the ✕ miss marker above-right of its dot, never over the tape head, "You are here" or a route badge`, async ({ page }) => {
    await open(page, path);
    const glowing = await page.locator("[data-glow-for]").evaluateAll((els) => els.filter((e) => e.getClientRects().length).length);
    await expect(page.locator("[data-glow-legend]:visible")).toHaveCount(glowing ? 1 : 0);
    if (!glowing) {
      // Nowhere on the page, the stop sheets included.
      await expect(page.getByText(/flagged it/)).toHaveCount(0);
      await expect(page.getByText(/Glow/)).toHaveCount(0);
    }
    // The ✕ legend is the bare mark.
    await expect(page.locator("[data-miss-key]:visible")).toHaveText("✕");
    await expect(page.getByText("= times you missed it").filter({ visible: true })).toHaveCount(1);

    const boxes = (sel: string) => page.locator(sel).evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
    // The demo's example history (read on the device after hydration) gives it misses.
    if (path === "/demo/tape") await expect(page.locator("[data-miss]:visible").first()).toBeVisible();
    const misses = await boxes("[data-miss]");
    if (path === "/demo/tape") expect(misses.length).toBeGreaterThan(0);
    const keepOut = [...(await boxes("[data-head]")), ...(await boxes("[data-here]")), ...(await boxes("[data-route-badge]"))];
    expect(keepOut.length).toBeGreaterThan(1);
    const overlaps = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    for (const m of misses) for (const k of keepOut) expect(overlaps(m, k), `✕ at ${m.left},${m.top} over ${k.left},${k.top}`).toBe(false);
    // Above-right of its own dot.
    const pairs = await page.locator("[data-stop-id]:visible").evaluateAll((els) =>
      els.flatMap((el) => {
        const m = el.querySelector("[data-miss]");
        const d = el.querySelector("[data-dot]");
        return m && d ? [{ m: m.getBoundingClientRect().toJSON() as DOMRect, d: d.getBoundingClientRect().toJSON() as DOMRect }] : [];
      }),
    );
    expect(pairs.length).toBe(misses.length);
    for (const { m, d } of pairs) {
      expect(m.left).toBeGreaterThan(d.left + d.width / 2);
      expect(m.bottom).toBeLessThanOrEqual(d.top + d.height / 2);
    }
  });

  test(`${path}: Start the route back plays the first stop's real clip`, async ({ page }, info) => {
    await open(page, path);
    const area = await routeArea(page, info.project.name === "phone");
    const route = area.getByRole("list", { name: "Route back" }).locator(":scope > li");
    const steps = await route.count();
    test.skip(steps === 0, "no route back on this data");
    expect(steps).toBeLessThanOrEqual(3);
    for (let i = 0; i < steps; i++) await expect(route.nth(i)).toHaveAttribute("data-rank", String(i + 1));

    // Does the first stop have a clip? Its button names the lecture time it plays ("…, Oct 22 · 57:43").
    // Its name is its visible text: rank, topic and the lecture time it plays ("… Oct 22 · 57:43").
    const firstHasClip = /\d:\d{2}$/.test(((await route.first().getByRole("button").textContent()) ?? "").trim());

    // The one orange button.
    const start = area.getByRole("button", { name: "Start the route back" });
    expect(await start.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).fontSize])).toEqual(["rgb(250, 70, 22)", "18px"]);
    // Desktop: the whole screen fits 1280 x 800, like the mockup.
    if (info.project.name === "desktop") expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await start.click();

    const player = page.getByRole("dialog", { name: "Route back" });
    await expect(player.locator('[data-route-step="1"]')).toBeVisible();
    const clip = player.locator("[data-clip-start]");
    await expect(clip).toHaveCount(firstHasClip ? 1 : 0);
    if (firstHasClip) {
      // A real clip from the pipeline or lecture output: the counter lands on its start.
      const startSec = Number(await clip.getAttribute("data-clip-start"));
      const endSec = Number(await clip.getAttribute("data-clip-end"));
      expect(endSec).toBeGreaterThan(startSec);
      await expect(player.getByText(formatTime(startSec), { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 4000 });
    } else {
      await expect(player.getByText(/No recording|weren't found/)).toBeVisible();
    }
  });
}

// John, Oct 24: a stop's sheet is no text dump. 640 px at most on desktop; the title and a 44 px × on one row; the two
// facts as tiles; at most 3 evidence rows and 3 misses before "+N more"; Play this moment is the one primary.
test("/demo/tape: every stop's sheet: × on the title row, two tiles, at most 3 rows each, Play this moment the primary", async ({ page }) => {
  await open(page, "/demo/tape");
  const stops = page.locator("[data-stop-id]:visible");
  const n = await stops.count();
  test.skip(n === 0, "no stops");
  const desktop = page.viewportSize()!.width >= 1024;
  for (let i = 0; i < n; i++) {
    const stop = stops.nth(i);
    const name = (await stop.getAttribute("aria-label"))!.split(", Taught")[0];
    await stop.click();
    const sheet = page.getByRole("dialog", { name });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(250);
    if (desktop) expect((await sheet.boundingBox())!.width, `${name}: at most 640 px`).toBeLessThanOrEqual(641);

    const heading = sheet.getByRole("heading", { level: 2 });
    const close = sheet.getByRole("button", { name: "Close", exact: true });
    const h = (await heading.boundingBox())!;
    const c = (await close.boundingBox())!;
    expect(Math.min(c.width, c.height), `${name}: × is 44 px`).toBeGreaterThanOrEqual(44);
    expect(c.y, `${name}: × on the title row`).toBeLessThan(h.y + h.height);
    expect(c.y + c.height, `${name}: × on the title row`).toBeGreaterThan(h.y);

    // The tiles' titles are the facts (John, Oct 25): "Kapoor flagged it" with what and when, else "Not flagged yet"
    // alone; "You miss it" with "2 of 3" ("No misses yet" over "0 of 2"), else "Not practiced yet" alone.
    const stressed = sheet.getByRole("region", { name: `Stressed: ${name}` });
    await expect(stressed).toBeVisible();
    const title = (await stressed.getByRole("heading").textContent())!.trim();
    if (/ flagged it$/.test(title)) await expect(stressed.locator("p")).toHaveText(/^(\w+ flag|Flagged in lecture)( · [A-Z][a-z]{2} \d{1,2}(, \d+:\d{2}(:\d{2})?)?)?( \(\+\d+ more\))?$/);
    else if (title === "Not flagged yet") await expect(stressed.locator("p")).toHaveCount(0);
    else expect(title, `${name}: a fact as the title`).toMatch(/^(On a past review|In an announcement|\d+ min of lecture on it)$/);
    const missed = sheet.getByRole("region", { name: `Missed: ${name}` });
    await expect(missed).toBeVisible();
    const missTitle = (await missed.getByRole("heading").textContent())!.trim();
    if (missTitle === "You miss it") await expect(missed.locator("p").first()).toHaveText(/^[1-9]\d* of \d+$/);
    else if (missTitle === "No misses yet") await expect(missed.locator("p").first()).toHaveText(/^0 of \d+$/);
    else {
      expect(missTitle).toBe("Not practiced yet");
      await expect(missed.locator("p")).toHaveCount(0);
    }
    // No scoring rules in the sheet; they wait behind a closed "How this is ranked".
    await expect(sheet.getByText(/No glow under 1\.5 points/)).toBeHidden();
    const how = sheet.locator("details").filter({ hasText: "How this is ranked" });
    await expect(how).toHaveCount(1);
    await expect(how).not.toHaveAttribute("open", "");
    const evidence = sheet.getByRole("list", { name: `Evidence for ${name}` });
    if (await evidence.count()) expect(await evidence.locator(":scope > li").count(), `${name}: evidence rows`).toBeLessThanOrEqual(3);
    const misses = sheet.locator('li[data-kind="practice"]');
    expect(await misses.count(), `${name}: miss rows`).toBeLessThanOrEqual(3);

    const play = sheet.getByRole("button", { name: /^Play this moment · \d/ });
    if (await play.count()) await expect(play).toHaveClass(/btn-primary/);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
});
