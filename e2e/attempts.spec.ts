// Practice attempts stay on the device: a wrong answer on /practice shows up as a miss on the
// Course tape, the demo's example history is labelled until a real answer replaces it, Clear
// empties it, and no request ever carries attempt data. Runs on the local private/ data.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page, type Request } from "./test";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed, "needs the local practice seed (npm run spike:seed)");

const EXAMPLE = "Example practice history";

/** Every request the page makes, to check none carries attempt data. */
function recordRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on("request", (r) => seen.push(r));
  return seen;
}

async function openTape(page: Page) {
  await page.goto("/course/tape");
  const empty = page.getByRole("heading", { name: "No course data yet" });
  await expect(empty.or(page.getByRole("heading", { name: "Course tape", exact: true }))).toBeVisible();
  test.skip(await empty.isVisible(), "needs lecture transcripts or a Canvas export in private/");
  // The skeleton has the title too: wait for the tape's stops.
  await expect(page.locator("[data-stop-id]:visible").first()).toBeVisible();
}

/** Tonight's route back: in the side panel on desktop, in a bottom sheet behind its bar on the phone. */
async function routeList(page: Page) {
  const bar = page.getByRole("button", { name: /^Tonight's route back/ });
  if (await bar.isVisible()) await bar.click();
  return page.getByRole("list", { name: "Route back" });
}

/** The practice evidence items on the tape that quote `stem`. */
const practiceItems = (page: Page, stem: string) => page.locator('li[data-kind="practice"]').filter({ hasText: stem.slice(0, 40) });

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

test("a wrong answer is kept on the device and shows up as a miss on the tape; Clear empties it", async ({ page }) => {
  test.setTimeout(60_000);
  const requests = recordRequests(page);
  const q = seed!.questions[0];
  const wrong = q.choices.find((c) => c.label !== q.answer)!;

  // Before any real answer: the demo's example history, labelled as such.
  await openTape(page);
  await expect(page.getByRole("note").filter({ hasText: EXAMPLE })).toBeVisible();
  const route = await routeList(page);
  // The note shows once (the side panel's); the route list does not repeat it.
  await expect(route.getByText(EXAMPLE)).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Every example evidence item carries the label.
  const examples = page.locator('li[data-kind="practice"]');
  await expect.poll(() => examples.count()).toBeGreaterThan(0);
  for (const item of await examples.all()) await expect(item).toContainText(EXAMPLE);

  // Answer for real on /practice (wrong).
  await page.goto("/practice?set=seed");
  await expect(page.getByRole("contentinfo", { name: "Your practice data" }).getByText(EXAMPLE)).toBeVisible();
  const option = page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) });
  await option.click();
  await expect(option).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();

  // Saved in this browser: only the real answer, the examples are gone.
  const stored = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith("rewind.attempts.")) out[k] = localStorage.getItem(k)!;
    }
    return out;
  });
  const data = JSON.parse(stored["rewind.attempts.v1.COP3530"]) as { attempts: { questionId: string; correct: boolean; example: boolean; choice: string }[] };
  expect(data.attempts).toEqual([expect.objectContaining({ questionId: q.id, correct: false, example: false, choice: wrong.label })]);

  // The tape: the miss is there, and the example label is gone everywhere.
  await openTape(page);
  const miss = practiceItems(page, q.stem);
  await expect(miss).toHaveCount(1);
  await expect(miss).toContainText("You missed it");
  await expect(miss).toContainText("Your practice");
  await expect(page.getByText(EXAMPLE)).toHaveCount(0);
  // Its stop on the tape is named with the miss, and tapping it shows the miss with its source.
  const topic = (await page.locator("dialog").filter({ has: miss }).getAttribute("aria-label"))!;
  const stop = page.locator(`[data-stop-id]:visible[aria-label^="${topic.replace(/["\\]/g, "\\$&")}, Taught"]`);
  await expect(stop).toHaveAttribute("aria-label", /, missed [1-9]/);
  await stop.click();
  await expect(miss).toBeVisible();
  await page.keyboard.press("Escape");

  // Clear (with a confirm step): the miss goes, and stays gone after a reload (no examples either).
  await page.getByRole("button", { name: "Clear my practice data" }).click();
  await expect(practiceItems(page, q.stem)).toHaveCount(1);
  await page.getByRole("button", { name: "Yes, clear it" }).click();
  await expect(practiceItems(page, q.stem)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Cleared." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Course tape", exact: true })).toBeVisible();
  await expect(page.getByText(/practice answers? saved on this device/)).toBeVisible();
  await expect(page.locator('li[data-kind="practice"]')).toHaveCount(0);
  await expect(page.getByText(EXAMPLE)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("rewind.attempts.v1.COP3530"))).toBeNull();

  // Nothing about an attempt ever went over the network.
  const needles = [q.stem.slice(0, 30), "questionId", "answeredAt", "rewind.attempts", "att-"];
  for (const r of requests) {
    const body = r.postData() ?? "";
    for (const n of needles) {
      expect(r.url(), `request URL carries attempt data: ${r.url()}`).not.toContain(n);
      expect(body, `request body carries attempt data: ${r.method()} ${r.url()}`).not.toContain(n);
    }
  }
});

test("a right answer is recorded when it's checked, before and without any Rewind", async ({ page }) => {
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.answer},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  // The grading beat: the sheet is graded in place; nothing has rewound.
  await expect(page.getByText(/correct/i).filter({ visible: true }).first()).toBeVisible();
  const data = JSON.parse((await page.evaluate(() => localStorage.getItem("rewind.attempts.v1.COP3530")))!) as {
    attempts: { questionId: string; correct: boolean; example: boolean; choice: string }[];
  };
  expect(data.attempts).toEqual([expect.objectContaining({ questionId: q.id, correct: true, example: false, choice: q.answer })]);
});

test("Cancel keeps the practice data, on /practice too", async ({ page }) => {
  await page.goto("/practice?set=seed");
  const footer = page.getByRole("contentinfo", { name: "Your practice data" });
  await expect(footer.getByText(EXAMPLE)).toBeVisible();
  await footer.getByRole("button", { name: "Clear my practice data" }).click();
  await footer.getByRole("button", { name: "Cancel" }).click();
  await expect(footer.getByText(EXAMPLE)).toBeVisible();
  await footer.getByRole("button", { name: "Clear my practice data" }).click();
  await footer.getByRole("button", { name: "Yes, clear it" }).click();
  await expect(footer.getByText(EXAMPLE)).toHaveCount(0);
  await expect(footer.getByRole("status")).toContainText("Cleared.");
});
