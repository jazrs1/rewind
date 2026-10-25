// The live tutor in the public demo (/api/demo/tutor), with the model mocked at the route: no key, no network, $0.
//   - a fast live reply streams in, with its quote-checked chip, and is not labelled "Saved reply"
//   - a hang past 8 s, a 429, an error event and the daily cap each play the saved reply, labelled "Saved reply"
//   - with no REWIND_DEMO_ANTHROPIC_API_KEY (this dev server has none) the real route answers the fallback at once
//   - the request carries only the question id and what the student wrote (plus the signed turns), never course text
import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "./test";
import type { DemoBundleFile } from "../lib/demo/bundle";

const bundle: DemoBundleFile = JSON.parse(readFileSync("public/demo/course/course.json", "utf8"));
const latest = [...bundle.sets].sort((a, b) => b.id.localeCompare(a.id))[0];
const q = latest.questions[0];
const wrong = q.choices.find((c) => c.label !== q.answer)!;
const line = q.lines[0];

const saved = (text: string, grounded: object[] = []) => ({ text, grounded });
const SAVED_FILE = {
  format: "rewind-demo-tutor/1",
  model: "fake",
  questions: {
    [q.id]: {
      hint1: saved("SAVED HINT ONE: what is the question really asking?", [{ kind: "lecture", quote: line.text, start: line.start }]),
      hint2: saved("SAVED HINT TWO: compare the two ideas."),
      socratic: saved("SAVED SOCRATIC: what changes if you swap them?"),
      confirm: saved("SAVED CONFIRM: yes, you reasoned it out."),
      answer: saved("SAVED ANSWER: it is the one that matches the slide."),
    },
  },
};

const ndjson = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const live = (text: string) => ndjson([...text.split(" ").map((w) => ({ t: "text", d: `${w} ` })), { t: "done", mode: "hint", grounded: [{ kind: "lecture", quote: line.text, start: line.start }], rewritten: false, confirmed: false, hintsUsed: 1, sig: "sig-1" }]);

// The demo's offline service worker would answer tutor.json itself, past the routes below.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await page.route("**/demo/course/tutor.json", (route) => route.fulfill({ json: SAVED_FILE }));
});

/** The demo practice page: a wrong answer checked, the tutor open. */
async function openTutor(page: Page) {
  await page.goto("/demo/practice");
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first().click();
  const panel = page.getByRole("dialog", { name: "Tutor" });
  await expect(panel).toBeVisible();
  return panel;
}
const hint = (panel: ReturnType<Page["getByRole"]>) => panel.getByRole("button", { name: "Hint", exact: true });

test("a fast live reply streams in with its quote-checked chip, and isn't labelled as saved", async ({ page }) => {
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/demo/tutor", (route: Route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: live("Think about what the question is really asking.") });
  });
  const panel = await openTutor(page);
  await expect(panel.locator("[data-integrity]")).toHaveCount(0); // no graded work in the demo
  await hint(panel).click();
  const turn = panel.locator('[data-tutor-turn="hint"]').first();
  await expect(turn).toContainText("Think about what the question is really asking.");
  await expect(turn.locator("[data-from-course]")).toBeVisible();
  await expect(turn.locator('[data-chip="tape"]')).toHaveAttribute("data-quote", line.text);
  await expect(panel.locator("[data-saved]")).toHaveCount(0);
  // Only the question id and what the student did go up: no prompt, no course text, no assignment flag.
  expect(Object.keys(body!).sort()).toEqual(["history", "marked", "message", "questionId", "request"]);
  expect(body).toMatchObject({ questionId: q.id, request: "hint", marked: wrong.label, history: [] });
});

test("a live reply that hangs past 8 seconds plays the saved reply, labelled", async ({ page }) => {
  test.setTimeout(40_000);
  await page.route("**/api/demo/tutor", async (route) => {
    await new Promise((r) => setTimeout(r, 11_000));
    await route.abort().catch(() => {});
  });
  const panel = await openTutor(page);
  await hint(panel).click();
  await expect(panel.locator("[data-tutor-skeleton]")).toBeVisible();
  const t0 = Date.now();
  const turn = panel.locator('[data-tutor-turn="hint"]').first();
  await expect(turn).toContainText("SAVED HINT ONE", { timeout: 12_000 });
  expect(Date.now() - t0).toBeGreaterThan(6000);
  await expect(turn.locator("[data-saved]")).toHaveText("Saved reply");
  await expect(turn.locator("[data-from-course]")).toBeVisible();
  await expect(panel.locator("[data-tutor-skeleton]")).toHaveCount(0);
});

for (const [name, reply] of [
  ["a 429 from the route", { status: 429, body: ndjson([{ t: "fallback", why: "rate" }]) }],
  ["the daily cap", { status: 200, body: ndjson([{ t: "fallback", why: "day-budget" }]) }],
  ["an error event", { status: 200, body: ndjson([{ t: "error", m: "x" }]) }],
  ["a server error", { status: 500, body: "boom" }],
] as const) {
  test(`${name} plays the saved reply, labelled, through Hint, Hint, Socratic, confirm and the answer`, async ({ page }) => {
    await page.route("**/api/demo/tutor", (route) => route.fulfill({ status: reply.status, contentType: "application/x-ndjson", body: reply.body }));
    const panel = await openTutor(page);
    await hint(panel).click();
    await expect(panel.locator('[data-tutor-turn="hint"]').first()).toContainText("SAVED HINT ONE");
    await hint(panel).click();
    await expect(panel.locator('[data-tutor-turn="hint"]').nth(1)).toContainText("SAVED HINT TWO");
    await expect(hint(panel)).toHaveCount(0);
    await panel.getByRole("textbox", { name: "Ask the tutor" }).fill("I'm not sure where to start");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(panel.locator('[data-tutor-turn="reply"]').first()).toContainText("SAVED SOCRATIC");
    await panel.getByRole("textbox", { name: "Ask the tutor" }).fill("So it's the one that matches the slide");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(panel.locator('[data-tutor-turn="reply"]').nth(1)).toContainText("SAVED CONFIRM");
    await panel.getByRole("button", { name: "Show the answer" }).click();
    await expect(panel.locator('[data-tutor-turn="answer"]')).toContainText("SAVED ANSWER");
    await expect(panel.locator("[data-saved]")).toHaveCount(5);
  });
}

test("the answer isn't shown before an answer is checked, saved or live", async ({ page }) => {
  await page.route("**/api/demo/tutor", (route) => route.fulfill({ status: 200, body: ndjson([{ t: "fallback", why: "day-budget" }]) }));
  await page.goto("/demo/practice");
  // "Ask the tutor" is disabled until the panel can open (never a click that silently does nothing).
  const ask = page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first();
  await expect(ask).toBeEnabled();
  await ask.click();
  const panel = page.getByRole("dialog", { name: "Tutor" });
  await expect(panel).toBeVisible();
  await hint(panel).click();
  await expect(panel.locator('[data-tutor-turn="hint"]')).toContainText("SAVED HINT ONE");
  await hint(panel).click();
  await expect(panel.locator('[data-tutor-turn="hint"]').nth(1)).toContainText("SAVED HINT TWO");
  await panel.getByRole("button", { name: "Show the answer" }).click();
  await expect(panel.getByText("Mark your answer and check it first")).toBeVisible();
  await expect(panel).not.toContainText("SAVED ANSWER");
});

test("with no demo key on the server the real route answers the fallback at once, and the saved reply plays", async ({ page }) => {
  const panel = await openTutor(page);
  const t0 = Date.now();
  await hint(panel).click();
  await expect(panel.locator('[data-tutor-turn="hint"]').first()).toContainText("SAVED HINT ONE", { timeout: 5000 });
  expect(Date.now() - t0).toBeLessThan(5000);
  await expect(panel.locator("[data-saved]")).toHaveText("Saved reply");
  // An unknown question id is a 404, not a fallback.
  const res = await page.request.post("/api/demo/tutor", { data: { questionId: "nope", request: "hint" } });
  expect(res.status()).toBe(404);
  const ok = await page.request.post("/api/demo/tutor", { data: { questionId: q.id, request: "hint" } });
  expect((await ok.text()).trim()).toBe(JSON.stringify({ t: "fallback", why: "no-key" }));
});

test("a stream that is cut off after some words, with no 'done', plays the saved reply instead of a half answer", async ({ page }) => {
  await page.route("**/api/demo/tutor", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson([{ t: "text", d: "Think about " }, { t: "text", d: "what the " }]) }));
  const panel = await openTutor(page);
  await hint(panel).click();
  const turn = panel.locator('[data-tutor-turn="hint"]').first();
  await expect(turn).toContainText("SAVED HINT ONE");
  await expect(turn).not.toContainText("Think about what the");
  await expect(turn.locator("[data-saved]")).toHaveText("Saved reply");
});

test("the real routes answer 400, not a crash, to a body that isn't an object", async ({ page }) => {
  for (const path of ["/api/demo/tutor", "/api/tutor"]) {
    for (const data of ["null", "42", "[]"]) {
      const res = await page.request.post(path, { data, headers: { "content-type": "application/json" } });
      expect(res.status(), `${path} ${data}`).toBe(400);
    }
  }
});

test("without the saved-replies file the demo still answers, plainly, with no course claim", async ({ page }) => {
  await page.unroute("**/demo/course/tutor.json");
  await page.route("**/demo/course/tutor.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/api/demo/tutor", (route) => route.fulfill({ status: 500, body: "boom" }));
  const panel = await openTutor(page);
  await hint(panel).click();
  const turn = panel.locator('[data-tutor-turn="hint"]').first();
  await expect(turn).toContainText("The live tutor is busy right now.");
  await expect(turn.locator("[data-from-course]")).toHaveCount(0);
  await expect(turn.locator("[data-saved]")).toHaveText("Saved reply");
});

test("'Ask the tutor' is served disabled and turns on only once the panel can open", async ({ page }) => {
  // The server-rendered page (before any script runs) marks every "Ask the tutor" aria-disabled, so an early tap is
  // visibly unavailable rather than a click that silently does nothing.
  const html = await (await page.request.get("/demo/practice")).text();
  const buttons = [...html.matchAll(/<button[^>]*data-ask-tutor[^>]*>/g)].map((m) => m[0]);
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) expect(b).toContain('aria-disabled="true"');
  await page.goto("/demo/practice");
  const ask = page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first();
  await expect(ask).toBeEnabled();
  await expect(ask).not.toHaveAttribute("aria-disabled");
  await ask.click();
  await expect(page.getByRole("dialog", { name: "Tutor" })).toBeVisible();
});
