// The live demo tutor with Upstash set but down (its server has a demo key and KV_REST_API_URL pointing at a port that
// refuses connections: playwright.config.ts, KVDOWN_BASE). The live call must be refused before any model call, and the
// saved reply plays. The demo key on that server is fake: a model call would fail, and none is attempted.
import { readFileSync } from "node:fs";
import { expect, test } from "./test";
import type { DemoBundleFile } from "../lib/demo/bundle";
import { KVDOWN_BASE } from "../playwright.config";

const bundle: DemoBundleFile = JSON.parse(readFileSync("public/demo/course/course.json", "utf8"));
const latest = [...bundle.sets].sort((a, b) => b.id.localeCompare(a.id))[0];
const q = latest.questions[0];
const wrong = q.choices.find((c) => c.label !== q.answer)!;
const saved = JSON.parse(readFileSync("public/demo/course/tutor.json", "utf8")) as { questions: Record<string, { hint1: { text: string } }> };

test.use({ baseURL: KVDOWN_BASE, serviceWorkers: "block" });

test("Upstash down: the route answers the fallback before any model call, and the page plays the saved reply", async ({ page }) => {
  const toAnthropic: string[] = [];
  page.on("request", (r) => {
    if (/anthropic\.com/.test(r.url())) toAnthropic.push(r.url());
  });
  // What the server says, directly: refused at the counters ("store"), not after a model error ("error").
  const direct = await page.request.post("/api/demo/tutor", { data: { questionId: q.id, request: "hint" } });
  expect(direct.status()).toBe(200);
  expect((await direct.text()).trim()).toBe(JSON.stringify({ t: "fallback", why: "store" }));

  await page.goto("/demo/practice");
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first().click();
  const panel = page.getByRole("dialog", { name: "Tutor" });
  const t0 = Date.now();
  await panel.getByRole("button", { name: "Hint", exact: true }).click();
  const turn = panel.locator('[data-tutor-turn="hint"]').first();
  await expect(turn).toContainText(saved.questions[q.id].hint1.text.slice(0, 40));
  await expect(turn.locator("[data-saved]")).toHaveText("Saved reply");
  // Quick: the store is refused at once, not after the model's seven seconds or the page's eight.
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(toAnthropic).toEqual([]);
});
