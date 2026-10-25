// /practice shows the course pipeline's output (private/pipeline/COP3530/output.json, dev only)
// when a run has finished, else the local seed; ?set=seed always shows the seed. Skips without it.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "./test";
import type { PracticeSeed } from "../lib/demo/types";
import type { PipelineOutput } from "../lib/pipeline/types";

const OUTPUT = "private/pipeline/COP3530/output.json";
const SEED = "private/demo/seed.json";
const output: PipelineOutput | null = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, "utf8")) : null;
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

test("/practice shows the pipeline's questions when a run has finished", async ({ page }) => {
  const shown = output?.questions.filter((q) => q.retrieval.slide) ?? [];
  test.skip(!shown.length, "needs a finished pipeline run (npm run pipeline -- --course COP3530)");
  await page.goto("/practice");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(shown[0].stem.slice(0, 40));
  await expect(page.getByLabel(/^Question 1 of/).first()).toHaveAttribute("aria-label", `Question 1 of ${shown.length}, none answered yet`);
});

test("/practice?set=seed shows the local seed", async ({ page }) => {
  test.skip(!seed, "needs the local practice seed (npm run spike:seed)");
  await page.goto("/practice?set=seed");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(seed!.questions[0].stem.slice(0, 40));
});
