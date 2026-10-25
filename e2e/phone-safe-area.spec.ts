// Phone safe area (John, from his iPhone): Safari's floating toolbar covered the graded sheet's "Rewind to Kapoor's
// explanation". On a 390 x 844 phone, each screen scrolled to the bottom keeps its last button at least 88 px above
// the viewport's bottom edge (app/globals.css --phone-bottom-room, with viewport-fit=cover from app/layout.tsx).
//   1. the graded practice sheet   2. the tutor sheet   3. the study session (its composer and its Topics sheet)
// The fake model (REWIND_FAKE_LLM=1, playwright.config.ts) and the invented e2e set: no key, no network, $0.
import { expect, test, type Locator, type Page } from "./test";
import { fixtureOutput } from "../lib/pipeline/fixtures/practice-real";

const ROOM = 88;
const [withCode] = fixtureOutput.questions;
const URL = "/practice?set=e2e-fixture";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

/** Scrolls the page and every scroll container `inside` to the bottom; returns the px between `el`'s bottom and the viewport's. */
async function gapBelow(page: Page, el: Locator, inside?: Locator): Promise<number> {
  await el.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  if (inside)
    await inside.evaluate((root) => {
      for (const n of [root, ...root.querySelectorAll<HTMLElement>("*")]) if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) n.scrollTop = n.scrollHeight;
    });
  await page.waitForTimeout(400); // sheet and scroll animations settle
  const box = (await el.boundingBox())!;
  return page.viewportSize()!.height - (box.y + box.height);
}

async function gradedWrong(page: Page) {
  await page.goto(URL);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(withCode.stem);
  await page.getByRole("radio", { name: new RegExp(`^Option ${withCode.choices.find((c) => c.label !== withCode.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.getByRole("button", { name: /^Rewind to .+'s explanation$/ })).toBeVisible({ timeout: 4000 });
}

test("the graded sheet: Rewind to the explanation (and every button under it) clears the toolbar", async ({ page }) => {
  await gradedWrong(page);
  const sheet = page.locator(".paper-form");
  const last = sheet.getByRole("button").filter({ visible: true }).last();
  expect(await gapBelow(page, last)).toBeGreaterThanOrEqual(ROOM);
  expect(await gapBelow(page, page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }))).toBeGreaterThanOrEqual(ROOM);
});

test("the tutor sheet: its composer's Send button clears the toolbar", async ({ page }) => {
  await gradedWrong(page);
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first().click();
  const panel = page.getByRole("dialog", { name: "Tutor" });
  await expect(panel).toBeVisible();
  const send = panel.getByRole("button", { name: "Send" });
  expect(await gapBelow(page, send, panel)).toBeGreaterThanOrEqual(ROOM);
});

test("the study session: the composer's Send button and the Topics sheet's last topic clear the toolbar", async ({ page }) => {
  await page.goto("/demo/study");
  const chat = page.getByRole("region", { name: "Study with the tutor" });
  const send = chat.getByRole("button", { name: "Send" });
  await expect(send).toBeVisible();
  expect(await gapBelow(page, send, chat)).toBeGreaterThanOrEqual(ROOM);
  await page.getByRole("button", { name: "Topics" }).click();
  const sheet = page.getByRole("dialog", { name: "Topics" });
  await expect(sheet).toBeVisible();
  const lastTopic = sheet.getByRole("button").filter({ visible: true }).last();
  expect(await gapBelow(page, lastTopic, sheet)).toBeGreaterThanOrEqual(ROOM);
});

test("the viewport meta has viewport-fit=cover (or env(safe-area-inset-bottom) is 0 on iPhone)", async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
});
