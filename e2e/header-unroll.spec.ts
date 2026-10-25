// The demo header's lecture tabs unroll out of the Practice pill (John, Oct 25): on a click Course tape glides right
// over --dur-3 instead of jumping; reduced motion lands on the final layout at once; a page that loads on a lecture
// doesn't move at all. Desktop only (on a phone the tabs live in the Menu sheet).
import { expect, test, type Page } from "./test";

const nav = (page: Page) => page.getByRole("navigation", { name: "Demo course" });

/** Course tape's x on every frame for `ms` after `start()` runs in the page (start fires on the first frame). */
async function sampleTapeX(page: Page, ms: number, start: "click-practice" | "none") {
  return page.evaluate(
    ([ms, start]) =>
      new Promise<number[]>((done) => {
        const navEl = document.querySelector('nav[aria-label="Demo course"]')!;
        const tape = [...navEl.querySelectorAll<HTMLAnchorElement>("a.demo-tab")].find((a) => a.textContent?.trim() === "Course tape")!;
        const xs: number[] = [];
        const t0 = performance.now();
        const frame = () => {
          xs.push(tape.getBoundingClientRect().x);
          if (performance.now() - t0 < ms) requestAnimationFrame(frame);
          else done(xs);
        };
        if (start === "click-practice") [...navEl.querySelectorAll<HTMLAnchorElement>("a.demo-tab")].find((a) => a.textContent?.trim() === "Practice")!.click();
        requestAnimationFrame(frame);
      }),
    [ms, start] as const,
  );
}

test.beforeEach(async ({ page }) => {
  test.skip(page.viewportSize()!.width < 1024, "the bar's tabs are desktop only");
});

test("clicking Practice unrolls the lecture tabs: Course tape glides right, never one big jump", async ({ page }) => {
  await page.goto("/demo/tape");
  const practice = nav(page).getByRole("link", { name: "Practice", exact: true });
  await expect(practice).not.toHaveAttribute("aria-current", "page");
  await expect(nav(page).locator(".demo-set")).toHaveCount(0);

  // The route change can take a moment; sample long enough to cover it and the 320 ms unroll.
  const xs = await sampleTapeX(page, 2000, "click-practice");
  await expect(practice).toHaveAttribute("aria-current", "page");
  const sets = nav(page).locator(".demo-set");
  await expect(sets).toHaveCount(3);
  for (const s of await sets.all()) await expect(s).toBeVisible();
  await expect(nav(page).locator("[data-sets-reel]")).toHaveAttribute("data-sets-reel", "still");

  const first = xs[0];
  const last = xs[xs.length - 1];
  const distance = last - first;
  expect(distance, "Course tape moves right").toBeGreaterThan(20);
  const steps = xs.slice(1).map((x, i) => x - xs[i]);
  expect(Math.min(...steps), "never moves back left").toBeGreaterThanOrEqual(-0.5);
  expect(Math.max(...steps), "no single jump of more than ~40% of the way").toBeLessThanOrEqual(distance * 0.4);
  const between = new Set(xs.filter((x) => x > first + 0.5 && x < last - 0.5).map((x) => Math.round(x)));
  expect(between.size, "seen in between, not just before and after").toBeGreaterThanOrEqual(3);
});

test("leaving Practice rolls the tabs back up, then takes them out", async ({ page }) => {
  await page.goto("/demo/tape");
  await nav(page).getByRole("link", { name: "Practice", exact: true }).click();
  await expect(nav(page).locator("[data-sets-reel]")).toHaveAttribute("data-sets-reel", "still");
  await nav(page).getByRole("link", { name: "Course tape", exact: true }).click();
  await expect(nav(page).getByRole("link", { name: "Course tape", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav(page).locator(".demo-set")).toHaveCount(0);
  await expect(nav(page).locator(".demo-tab")).toHaveText(["Practice", "Course tape", "Ask"]);
});

test("reduced motion: the final layout from the first frame", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/demo/practice");
  const settled = await sampleTapeX(page, 200, "none");
  await page.goto("/demo/tape");
  const xs = await sampleTapeX(page, 800, "click-practice");
  await expect(nav(page).getByRole("link", { name: "Practice", exact: true })).toHaveAttribute("aria-current", "page");
  // Every frame is either the old spot (before the route changed) or the final one: nothing in between.
  const last = xs[xs.length - 1];
  expect(Math.abs(last - settled[0])).toBeLessThanOrEqual(0.5);
  const inBetween = xs.filter((x) => Math.abs(x - xs[0]) > 0.5 && Math.abs(x - last) > 0.5);
  expect(inBetween, "no frames mid-way").toEqual([]);
});

test("reload on a lecture page: nothing moves after load", async ({ page }) => {
  await page.goto("/demo/practice");
  const href = await nav(page).locator(".demo-set").first().getAttribute("href");
  // Layout shifts in the header from the very start of the page (Chromium's layout-shift entries).
  await page.addInitScript(() => {
    const w = window as unknown as { __headerShifts: number };
    w.__headerShifts = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; sources?: { node?: Node }[] }[]) {
        if (e.sources?.some((s) => s.node instanceof Element && s.node.closest("[data-demo-header]"))) w.__headerShifts += e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(href!);
  await page.reload();
  await expect(nav(page).locator(".demo-set").first()).toHaveAttribute("aria-current", "page");
  await expect(nav(page).locator("[data-sets-reel]")).toHaveAttribute("data-sets-reel", "still");
  const xs = await sampleTapeX(page, 600, "none");
  expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(0.5);
  expect(await page.evaluate(() => (window as unknown as { __headerShifts: number }).__headerShifts)).toBe(0);
});
