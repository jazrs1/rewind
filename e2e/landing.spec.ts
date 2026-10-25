// The landing page: everything that looks clickable is a real link or button that goes somewhere, the illustration's
// cassettes are the demo's three lectures, and no "not found" text renders anywhere on it.
import { expect, test } from "./test";

test("every element that looks interactive is a real link or button with a working target", async ({ page, request }) => {
  await page.goto("/");
  await page.locator("main").waitFor();
  const found = await page.evaluate(() => {
    const looksInteractive = (e: Element) => getComputedStyle(e).cursor === "pointer" || e.matches(".btn, .cassette, [role=button], [role=link], [tabindex]");
    const real = (e: Element) => !!e.closest("a[href], button:not([disabled]), summary, label, input, select, textarea");
    const all = [...document.querySelectorAll("body *")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
    });
    return {
      fake: all.filter((e) => looksInteractive(e) && !real(e)).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")} "${(e.textContent ?? "").trim().slice(0, 30)}"`),
      links: [...new Set(all.filter((e) => e.matches("a[href]")).map((e) => (e as HTMLAnchorElement).href))],
      buttons: all.filter((e) => e.matches("button")).map((e) => (e.textContent ?? "").trim()),
    };
  });
  expect(found.fake, "styled as clickable but not a link or button").toEqual([]);
  expect(found.links.length).toBeGreaterThan(0);
  for (const href of found.links) {
    const url = new URL(href);
    expect(url.origin, `${href} stays on this site`).toBe(new URL(page.url()).origin);
    expect((await request.get(href)).status(), href).toBeLessThan(400);
  }
  // No buttons here: if one is added, it needs its own test of what it does.
  expect(found.buttons).toEqual([]);
});

test("the cassettes are the demo's three lectures, each opening that lecture's practice", async ({ page }) => {
  await page.goto("/");
  const lectures = page.getByRole("navigation", { name: "Demo lectures" }).getByRole("link");
  await expect(lectures).toHaveText(["Sorting · Oct 13", "Hash tables · Oct 20", "Graphs · Oct 22"]);
  for (const [i, id] of ["2026-10-13", "2026-10-20", "2026-10-22"].entries()) {
    await expect(lectures.nth(i)).toHaveAttribute("href", `/demo/practice/${id}`);
  }
  await lectures.nth(1).click();
  await expect(page).toHaveURL(/\/demo\/practice\/2026-10-20$/);
  await expect(page.locator("main:visible").first()).toContainText("Oct 20");
});

test("nothing that isn't a link lifts on hover or takes the pointer", async ({ page }) => {
  await page.goto("/");
  // The sample question (a printed form) is a picture: default cursor, no lift.
  const form = page.getByRole("region", { name: "Sample question" });
  await form.hover();
  const cursors = await form.evaluate((el) => [el, ...el.querySelectorAll("*")].map((e) => getComputedStyle(e).cursor));
  expect(cursors.filter((c) => c === "pointer")).toEqual([]);
  // A cassette that is a link takes the pointer (and lifts: app/elevation.css scopes the lift to a.cassette).
  const tape = page.getByRole("navigation", { name: "Demo lectures" }).getByRole("link").first();
  await expect(tape).toHaveCSS("cursor", "pointer");
});

test("the landing page has no \"not found\" text", async ({ page }) => {
  await page.goto("/");
  await page.locator("main").waitFor();
  expect(await page.locator("body").innerText()).not.toMatch(/not found/i);
  // Hidden text too (screen readers, a collapsed element).
  expect(await page.locator("body").textContent()).not.toMatch(/not found/i);
});

test("\"Import your own course (beta)\" opens the extension page, not a private README", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("link", { name: "Import your own course: runs on your computer for now (beta)" });
  await expect(link).toHaveAttribute("href", "/extension");
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: "The Rewind extension" })).toBeVisible();
});
