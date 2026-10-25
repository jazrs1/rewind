// Questions can carry code (SeedQuestion.code): printed on the sheet as a monospace block with a
// print-green rule, ink text, no syntax colours, long lines wrapped under their own indentation (no sideways scroll).
// The seed has no question with code yet, so this patches one in (dev-only window.__rewindSeedPatch).
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "./test";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed, "needs the local practice seed (npm run spike:seed)");

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

const CODE = {
  language: "cpp",
  lines: [
    "bool twoSum(const std::vector<int>& arr, int target) {",
    "    std::unordered_map<int, int> seen;",
    "    for (int i = 0; i < arr.size(); i++) {",
    "        int diff = target - arr[i];",
    "        if (seen.count(diff)) return true;   // a long comment so this line runs past a phone's width",
    "        seen[arr[i]] = i;",
    "    }",
    "    return false;",
    "}",
  ],
};

async function withCode(page: Page) {
  await page.addInitScript((code) => {
    (window as unknown as { __rewindSeedPatch: unknown }).__rewindSeedPatch = { 0: { code } };
  }, CODE);
  await page.goto("/practice?set=seed");
  const block = page.getByRole("group", { name: "Code for question 1" }).filter({ visible: true });
  await expect(block).toBeVisible();
  return block;
}

test("the question's code is printed under the stem: monospace ink, a print-green rule, no colours, never cut, focusable", async ({ page }) => {
  const block = await withCode(page);
  await expect(block.locator("code")).toHaveText(CODE.lines.join(""));
  const look = await block.evaluate((pre) => {
    const s = getComputedStyle(pre);
    const colors = new Set([...pre.querySelectorAll("code, code *")].map((e) => getComputedStyle(e).color));
    return { tag: pre.tagName, family: s.fontFamily, color: s.color, rule: [s.borderLeftWidth, s.borderLeftColor], colors: [...colors], overflowX: s.overflowX };
  });
  expect(look.tag).toBe("PRE");
  expect(look.family).toMatch(/mono/i);
  expect(look.color).toBe("rgb(22, 36, 28)");
  expect(look.rule).toEqual(["3px", "rgb(36, 87, 63)"]);
  expect(look.colors, "one ink colour, no syntax highlighting").toEqual(["rgb(22, 36, 28)"]);
  expect(look.overflowX).toBe("auto");
  // Under the stem; on a phone, above the answers.
  const [stem, code, first] = await Promise.all([page.locator("h1").boundingBox(), block.boundingBox(), page.getByRole("radio").first().boundingBox()]);
  expect(code!.y).toBeGreaterThanOrEqual(stem!.y + stem!.height - 0.5);
  // (On desktop the answers are in their own column beside it.)
  if (page.viewportSize()!.width < 1024) expect(code!.y + code!.height).toBeLessThanOrEqual(first!.y + 0.5);
  // Neither the page nor the block scrolls sideways: a long line wraps at every width, so nothing is cut or
  // hidden (design sweep, Oct 24: line 1 was cut off at 390; demo review: Oct 22 q12's decisive lines were
  // behind the block's scroll at 1280). The block still takes keyboard focus.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await block.evaluate((pre) => pre.scrollWidth <= pre.clientWidth + 1)).toBe(true);
  await expect(block).toHaveAttribute("tabindex", "0");
  // A wrapped line keeps its indentation: line 5 (8 spaces in) continues under its own first character.
  const wrap = await block.locator("code > span").nth(4).evaluate((span) => {
    const text = span.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const rows = [...range.getClientRects()].filter((r) => r.width > 0);
    const first = document.createRange();
    const at = text.textContent!.search(/\S/);
    first.setStart(text, at);
    first.setEnd(text, at + 1);
    return { rows: new Set(rows.map((r) => Math.round(r.top))).size, startX: first.getBoundingClientRect().left, nextX: rows.at(-1)!.left };
  });
  if (wrap.rows > 1) expect(Math.abs(wrap.nextX - wrap.startX)).toBeLessThan(2);
  await page.screenshot({ path: `.cache/shots/designer-code-sheet-${page.viewportSize()!.width}.png`, fullPage: true });
});

test("desktop: a question with code fits the window, asking and graded, at 1280x800 and 1440x900", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1024, "desktop sheet");
  const q = seed!.questions[0];
  for (const size of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await withCode(page);
    const fits = () => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight);
    expect(await fits(), `${size.width}: asking`).toBe(true);
    const stemSize = await page.locator("h1").evaluate((h) => getComputedStyle(h).fontSize);
    await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
    await page.getByRole("button", { name: "Check answer" }).click();
    await expect(page.locator("[data-margin-note]").filter({ visible: true })).toBeVisible();
    expect(await fits(), `${size.width}: graded, with the margin note`).toBe(true);
    // Grading never resizes the question.
    expect(await page.locator("h1").evaluate((h) => getComputedStyle(h).fontSize)).toBe(stemSize);
  }
});

test("the missed strip's desktop card carries the code too", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1024, "desktop card");
  await withCode(page);
  const q = seed!.questions[0];
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  const strip = page.locator("main div[tabindex='-1']");
  await expect(strip.getByRole("group", { name: "Code for question 1" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `.cache/shots/designer-code-strip-${viewport!.width}.png` });
});
