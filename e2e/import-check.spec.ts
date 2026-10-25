// Import check: what the course pipeline found, from its report data. Reached by a quiet link on the
// course home (not a second orange button). Runs on the local private/ data; skips without it.
// Assertions use shapes, not course text.
import { expect, test } from "./test";

test("the home links quietly to the import check, which shows files, questions, gaps and every exam's sources", async ({ page }) => {
  await page.goto("/course");
  const link = page.getByRole("link", { name: "What the import found" });
  await expect(link.or(page.getByRole("heading", { name: "No course data yet" }))).toBeVisible();
  test.skip(!(await link.isVisible()), "needs the local course data");
  // Quiet: a text link, not an orange button, with a 44 px target.
  expect(await link.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe("rgb(250, 70, 22)");
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await link.click();
  await expect(page).toHaveURL(/\/course\/import$/);

  const empty = page.getByRole("heading", { name: "No import found yet" });
  await expect(page.getByRole("heading", { name: /^Here.s what we found/, level: 1 }).or(empty)).toBeVisible();
  test.skip(await empty.isVisible(), "needs the pipeline's report in private/pipeline/");
  await expect(page.locator("[data-section=files]")).toBeVisible();

  // Files by role, each with a count, and what that means in plain words.
  const roles = page.getByRole("list", { name: "Files by role" }).locator("li");
  expect(await roles.count()).toBeGreaterThan(0);
  for (const r of await roles.all()) await expect(r).toContainText(/\d+( \([A-Z]+ \d+(, [A-Z]+ \d+)*\))? · \d+ local/);
  // Each status said as it is: never "need a download" for files that failed to fetch.
  await expect(roles.filter({ hasText: "need a download" })).toHaveCount(0);
  const words = page.getByRole("list", { name: "What that means" }).locator("li");
  await expect(words.first()).toBeVisible();
  for (const w of await words.allTextContents()) expect(w).toMatch(/^1 file (came from your local folder|was downloaded|wasn't downloaded: download is off|couldn't be fetched \(.+\)|in your local folder matched no course file)\.$|^\d+ files (came from your local folder|were downloaded|weren't downloaded: download is off|couldn't be fetched \(.+\)|in your local folder matched no course file)\.$|^The pipeline's download plan wasn't found\.$/);
  await expect(page.getByText(/^From Canvas: Canvas pages (\d+|not found) · Announcements (\d+|not found) · Assignments (\d+|not found)$/)).toBeVisible();

  // Practice questions: kept and dropped, % with a clip and a slide (or "not found").
  const questions = page.locator("[data-section=questions]");
  await expect(questions.getByText(/with a lecture clip \(\d+\)/)).toBeVisible();
  await expect(questions.getByText(/with a slide \(\d+\)/)).toBeVisible();
  await expect(questions.getByText(/with a document page \(\d+\)/)).toBeVisible();
  await expect(questions.getByText(/^(\d+%|not found)$/).first()).toBeVisible();

  // Gaps: a list of "No material found for …" / "No practice questions yet for …", or none.
  const gaps = page.getByRole("list", { name: "Gaps" }).locator("li");
  if (await gaps.count()) for (const g of await gaps.allTextContents()) expect(g).toMatch(/^(No material found for .+|No practice questions yet for .+ \(\d+ files? with text\))\.$/);
  else await expect(page.getByText(/^No gaps:/)).toBeVisible();
  // It says what it searched.
  await expect(page.locator("[data-searched]")).toContainText(/Searched \d+ files?'s? titles and text, \d+ modules?'s? items and \d+ practice questions?/);

  // Exams: each has its date with a source label, or "not found", and says what's missing.
  const exams = page.getByRole("list", { name: "Exams" }).locator(":scope > li");
  expect(await exams.count()).toBeGreaterThan(0);
  for (const e of await exams.all()) {
    const date = e.locator("p", { hasText: /^Date:/ });
    if (!/not found/.test((await date.textContent()) ?? "")) await expect(e.locator("[data-source]")).toHaveCount(1);
    await expect(e.locator("[data-missing]")).toHaveText(/^(Not found: [a-z ,]+\.( Looked in .+\.)?|Every field found\.)$/);
  }
  // The local data has exams with fields not found; each says so instead of guessing.
  expect(await exams.filter({ hasText: /Not found: / }).count()).toBeGreaterThan(0);

  // Coming up first (next one on top); past ones folded into one "already taken" line.
  const whens = await exams.evaluateAll((els) => els.map((e) => e.getAttribute("data-when")));
  expect(whens).toEqual([...whens.filter((w) => w === "upcoming"), ...whens.filter((w) => w === "undated")]);
  await expect(exams.and(page.locator('[data-when="past"]'))).toHaveCount(0);
  const past = page.locator("[data-past]");
  if (await past.count()) {
    await expect(past.locator("summary")).toHaveText(/^\d+ already taken, kept for reviewShow them$/);
    await expect(page.getByRole("list", { name: "Already taken" })).toBeHidden();
    await past.locator("summary").click();
    await expect(page.getByRole("list", { name: "Already taken" }).locator("li").first()).toContainText("Already taken");
  }
  // A quiz's Canvas due date is shown as such, never as a quote.
  for (const due of await exams.filter({ hasText: /Due [A-Z][a-z]{2} \d+/ }).all()) await expect(due.locator("[data-source]")).toContainText("Canvas due date (not a quote)");

  // Phone: long lists show their first 3 and a "Show N more" button; desktop shows them all.
  const phone = (page.viewportSize()?.width ?? 1280) < 1024;
  for (const name of ["Exams", "Files by role", "Gaps"]) {
    const items = page.getByRole("list", { name }).locator(":scope > li");
    const n = await items.count();
    if (n <= 3) continue;
    await expect(items.filter({ visible: true })).toHaveCount(phone ? 3 : n);
    if (!phone) continue;
    const more = page.locator("button", { hasText: /^Show \d+ more / }).filter({ hasText: new RegExp(`^Show ${n - 3} more`) }).first();
    await more.click();
    await expect(items.filter({ visible: true })).toHaveCount(n);
  }

  // No orange button here, and no sideways scroll.
  expect(await page.locator("main a, main button").evaluateAll((els) => els.filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === "rgb(250, 70, 22)").length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
