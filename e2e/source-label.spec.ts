// Sources look like part of the product (John, Oct 23): the slide's source is a label row under the slide
// frame ("Slide 84 · Sets, Maps & Hash Tables", 13 px, muted) with a quiet "Open in Canvas ↗" at its end
// (peach, underlined on hover only, 44 px tall), and the same SourceLabel on the practice sheet (paper
// colours), under the setup line and on radar evidence.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "./test";
import { deckDisplayName } from "../lib/format";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed, "needs the local practice seed (npm run spike:seed)");

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

const style = (l: Locator) =>
  l.evaluate((e) => {
    const s = getComputedStyle(e);
    return { color: s.color, size: s.fontSize, family: s.fontFamily, line: s.textDecorationLine };
  });

async function rewound(page: Page) {
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await expect(page.locator("[data-counter]")).toBeVisible({ timeout: 3000 });
  return q;
}

test("under the slide frame: 'Slide N · Deck' muted, and a quiet Open in Canvas link with a 44 px target", async ({ page }) => {
  const q = await rewound(page);
  const caption = page.locator("figure figcaption");
  const text = `Slide ${q.match.slide.page} · ${deckDisplayName(q.match.slide.deck)}`;
  await expect(caption.getByText(text, { exact: true })).toBeVisible();
  const [panel, row] = await Promise.all([page.locator("figure [data-slide-panel]").boundingBox(), caption.boundingBox()]);
  expect(row!.y, "the label row is under the frame").toBeGreaterThanOrEqual(panel!.y + panel!.height - 0.5);
  expect(await style(caption.getByText(text, { exact: true }))).toMatchObject({ color: "rgb(201, 195, 179)", size: "13px", line: "none" });
  expect((await style(caption.getByText(text, { exact: true }))).family).toMatch(/atkinson/i);

  const open = caption.getByRole("link", { name: q.match.slide.canvasUrl ? "Open in Canvas" : "Open slide" });
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", "noreferrer");
  await expect(open).toHaveAttribute("href", q.match.slide.canvasUrl ?? `/api/dev-slides/${q.match.slide.image}`);
  expect(await style(open)).toMatchObject({ color: "rgb(255, 176, 143)", line: "none" });
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(open.locator("svg")).toHaveCount(1);
  // It is a button now: no underline, hover included (fix 9).
  if (page.viewportSize()!.width >= 1024) {
    await open.hover();
    expect((await style(open)).line).toBe("none");
    await page.mouse.move(0, 0);
  }
  await page.screenshot({ path: `.cache/shots/designer-source-rewind-${page.viewportSize()!.width}.png` });
});

test("without a Canvas link it opens the slide image, labelled Open slide", async ({ page }) => {
  const slide = { ...seed!.questions[0].match.slide };
  delete slide.canvasUrl;
  await page.addInitScript((slide) => {
    (window as unknown as { __rewindSeedPatch: unknown }).__rewindSeedPatch = { 0: { match: { slide } } };
  }, slide);
  const q = await rewound(page);
  const open = page.locator("figure figcaption").getByRole("link", { name: "Open slide" });
  await expect(open).toHaveAttribute("href", `/api/dev-slides/${q.match.slide.image}`);
});

test("the practice sheet uses the same label in paper colours", async ({ page, viewport }) => {
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  const text = `Slide ${q.match.slide.page} · ${deckDisplayName(q.match.slide.deck)}`;
  const label = page.locator("[data-source]").filter({ visible: true });
  await expect(label).toHaveCount(1);
  // While asking it is printed like a form footer and opening the slide waits for the grade.
  const printed = label.getByText(`Source: ${text}`, { exact: true });
  await expect(printed).toBeVisible();
  expect(await style(printed)).toMatchObject({ color: "rgb(36, 87, 63)", size: "13px", line: "none" });
  await expect(label.getByRole("link")).toHaveCount(0);
  const wrong = q.choices.find((c) => c.label !== q.answer)!.label;
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  const open = label.getByRole("link", { name: "Open in Canvas" });
  await expect(open).toBeVisible();
  expect(await style(open)).toMatchObject({ color: "rgb(31, 77, 56)", line: "none" });
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `.cache/shots/designer-source-sheet-${viewport!.width}.png` });
});

test("the setup line and radar evidence carry their source in the same style", async ({ page }) => {
  const q = await rewound(page);
  if (q.match.setup && q.match.exampleStart != null) {
    await expect(page.locator("[data-source]").filter({ hasText: /^From the lecture, / }).filter({ visible: true })).toHaveCount(1);
  }
  if (!seed!.radar?.length) return;
  await page.goto("/radar");
  const first = page.locator("main > ol > li").first();
  const ev = first.locator("[data-source]");
  await expect(ev).toContainText(seed!.lecturer.name);
  expect(await style(ev.locator("span").first())).toMatchObject({ color: "rgb(201, 195, 179)", size: "13px" });
});
