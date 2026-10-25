// Lite exam radar: every flagged moment, in his own words, playable.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "./test";
import { formatTime } from "../lib/format";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed?.radar?.length, "needs the local seed with radar moments (npm run spike:seed)");

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

test("lists every flagged moment word for word, filters by kind, and plays one", async ({ page }) => {
  const radar = seed!.radar!;
  await page.goto("/radar");
  await expect(page.getByRole("heading", { name: "Exam radar" })).toBeVisible();
  await expect(page.getByText("evidence, not a prediction", { exact: false })).toBeVisible();
  const items = page.locator("main ol > li");
  await expect(items).toHaveCount(radar.length);
  // Quotes are the transcript lines, unchanged.
  await expect(items.first().locator("blockquote")).toHaveText(`“${radar[0].text}”`);

  // Filter by the first kind: only moments of that kind remain.
  const kind = radar[0].kinds[0];
  const n = radar.filter((m) => m.kinds.includes(kind)).length;
  await page.getByRole("group", { name: "Filter by kind" }).getByRole("button", { name: new RegExp(`\\(${n}\\)$`) }).first().click();
  await expect(items).toHaveCount(n);

  // Play the first moment: the player opens and the counter lands a few seconds before the line.
  await items.first().getByRole("button", { name: /^Play the moment at / }).click();
  const first = radar.find((m) => m.kinds.includes(kind))!;
  await expect(items.first().getByText(formatTime(first.start), { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 3000 });
  await expect(items.first().getByText("No slide matched this moment")).toBeVisible();
});
