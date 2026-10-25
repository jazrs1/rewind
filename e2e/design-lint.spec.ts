// npm run lint:design, the rendered half (the static half is scripts/design/lint.ts): on every main screen
// and state, at 390 and 1280,
//   - every visible control (link, button, radio, summary, input; an input by its label) is at least 44 x 44 px, except links
//     inside running text (WCAG's inline exception) and controls that declare a larger hit area
//     (data-hit-44, e.g. a pseudo-element that extends a 28 px strip button to 46 px);
//   - at most one primary control per screen: action orange on the deck, print green on paper.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "./test";
import type { DemoBundleFile } from "../lib/demo/bundle";
import type { PracticeSeed } from "../lib/demo/types";
import { ACCOUNTS_BASE, QUICK_BASE } from "../playwright.config";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;
const bundle: DemoBundleFile = JSON.parse(readFileSync("public/demo/course/course.json", "utf8"));

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

async function audit(page: Page, screen: string) {
  await page.evaluate(() => document.fonts.ready);
  const res = await page.evaluate(() => {
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const st = getComputedStyle(e);
      if (st.visibility === "hidden" || st.display === "none") return false;
      if (e.closest("[inert], [aria-hidden=true], dialog:not([open])")) return false;
      return true;
    };
    // With a modal dialog open, the screen is the dialog (the page behind it is inert).
    const scope: ParentNode = document.querySelector("dialog[open]:modal") ?? document;
    const controls = [...scope.querySelectorAll("a[href], button, [role=button], [role=radio], summary, input:not([type=hidden])")].filter(visible);
    const small = controls
      .filter((e) => {
        if (e.closest("[data-hit-44]")) return false;
        // A checkbox or radio input is hit through its label: the label row is the target.
        const r = (e.tagName === "INPUT" && e.closest("label")) ? e.closest("label")!.getBoundingClientRect() : e.getBoundingClientRect();
        if (r.width >= 43.5 && r.height >= 43.5) return false;
        // Inline links in running text are exempt (WCAG 2.5.8): a link whose parent block holds other text.
        if (e.tagName === "A" && getComputedStyle(e).display === "inline") {
          const block = e.parentElement;
          if (block && (block.textContent ?? "").trim().length > (e.textContent ?? "").trim().length + 10) return false;
        }
        return true;
      })
      .map((e) => `${e.tagName.toLowerCase()} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 40)}" ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
    // No default underlines: a link is underlined only inside running text (and then on hover/focus), never bare.
    const underlined = controls
      .filter((e) => e.tagName === "A" && getComputedStyle(e).textDecorationLine.includes("underline"))
      .map((e) => `a "${(e.textContent ?? "").trim().slice(0, 40)}"`);
    const PRIMARY = ["rgb(250, 70, 22)", "rgb(36, 87, 63)"];
    const primaries = controls
      .filter((e) => e.matches("a, button, [role=button]") && PRIMARY.includes(getComputedStyle(e).backgroundColor))
      .map((e) => (e.textContent ?? "").trim().slice(0, 40));
    return { small, primaries, underlined };
  });
  expect(res.underlined, `${screen}: bare underlined links`).toEqual([]);
  expect(res.small, `${screen}: tap targets under 44 px`).toEqual([]);
  expect(res.primaries.length, `${screen}: more than one primary: ${JSON.stringify(res.primaries)}`).toBeLessThanOrEqual(1);
  const text = await page.evaluate(textRules);
  expect(text.hand, `${screen}: Caveat set on words or under 18 px`).toEqual([]);
  expect(text.wide, `${screen}: paragraphs wider than 75ch`).toEqual([]);
  expect(text.close, `${screen}: text-only Close controls (use the × button on the title row)`).toEqual([]);
}

/**
 * Text rules (John, Oct 24), on what's rendered:
 *   - Caveat only for values: dates and times, numbers, single answer letters; never a word of 2+ letters (month and
 *     weekday abbreviations and AM/PM count as part of a date), never under 18 px;
 *   - no paragraph with a rendered line longer than 75ch (a text dump);
 *   - no text-only "Close" link or button: closing is the × on the title row.
 */
function textRules() {
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const st = getComputedStyle(e);
    if (st.visibility === "hidden" || st.display === "none") return false;
    return !e.closest("[inert], [aria-hidden=true], dialog:not([open]), .sr-only");
  };
  const scope: ParentNode = document.querySelector("dialog[open]:modal") ?? document;
  const hand: string[] = [];
  const date = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun|AM|PM)\b/g;
  for (const el of scope.querySelectorAll("*")) {
    const st = getComputedStyle(el);
    if (!/caveat/i.test(st.fontFamily) || !visible(el)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
    if (!own) continue;
    if (/[A-Za-z]{2,}/.test(own.replace(date, ""))) hand.push(`"${own.slice(0, 40)}": a word in Caveat`);
    if (parseFloat(st.fontSize) < 17.5) hand.push(`"${own.slice(0, 40)}": Caveat at ${st.fontSize}`);
  }
  // 1ch in the paragraph's own font: the width of a "0" set inside it.
  const ch = (el: Element) => {
    const probe = document.createElement("span");
    probe.textContent = "0";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
    el.append(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w || 8;
  };
  // The longest rendered line of a paragraph, in ch (its text's line boxes, grouped by line).
  const longest = (p: Element) => {
    const lines = new Map<number, number>();
    const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      // Text a reader doesn't see (screen-reader-only copy, a hidden variant) isn't a line on screen.
      if (!n.parentElement || !visible(n.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 1) lines.set(Math.round(r.top), (lines.get(Math.round(r.top)) ?? 0) + r.width);
    }
    return Math.max(0, ...lines.values()) / ch(p);
  };
  const wide = [...scope.querySelectorAll("p")]
    .filter(visible)
    .map((p) => ({ p, n: longest(p) }))
    .filter(({ n }) => n > 75)
    .map(({ p, n }) => `"${(p.textContent ?? "").trim().slice(0, 40)}…" ${Math.round(n)}ch`);
  const close = [...scope.querySelectorAll("a[href], button")]
    .filter(visible)
    .filter((e) => /^close$/i.test((e.textContent ?? "").trim()) && !e.querySelector("svg"))
    .map((e) => `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim()}"`);
  return { hand, wide, close };
}

test("tap targets and one primary: landing, course home, course tape, import check, extension, privacy", async ({ page }) => {
  for (const [screen, path, wait] of [
    ["landing", "/", "main"],
    ["extension", "/extension", "h1"],
    ["privacy", "/privacy", "h1"],
    ["home", "/course", "[data-countdown]:visible, h1:visible"],
    ["tape", "/course/tape", "[data-stop-id]:visible, h1:visible"],
    ["import", "/course/import", "[data-section=files]:visible, h1:visible"],
  ] as const) {
    await page.goto(path);
    await page.locator(wait).first().waitFor();
    await page.waitForTimeout(1200);
    await audit(page, screen);
  }
});

test("tap targets and one primary in the open states: home confirm and pick, a tape stop, the route back", async ({ page }, info) => {
  await page.goto("/course");
  const guess = page.getByRole("button", { name: /^Everything since/ });
  if (await guess.count()) {
    await guess.click();
    await audit(page, "home confirm");
    await page.getByRole("button", { name: "Pick topics instead" }).click();
    await audit(page, "home pick");
  }
  await page.goto("/course/tape");
  const stop = page.locator("[data-stop-id]:visible").first();
  if (await stop.count()) {
    await stop.click();
    await page.waitForTimeout(300);
    await audit(page, "tape stop sheet");
    await page.keyboard.press("Escape");
    if (info.project.name === "phone") await page.getByRole("button", { name: /^Tonight's route back/ }).click();
    const start = page.getByRole("button", { name: "Start the route back" }).filter({ visible: true });
    if (await start.count()) {
      await audit(page, "tape route");
      await start.click();
      await page.waitForTimeout(1500);
      await audit(page, "tape route playing");
    }
  }
});

test("tap targets and one primary through a miss: asking, graded, the rewind (demo course)", async ({ page }) => {
  // /demo/practice: the latest lecture's set.
  const q = [...bundle.sets].sort((a, b) => b.id.localeCompare(a.id))[0].questions[0];
  const wrong = q.choices.find((c) => c.label !== q.answer)!.label;
  await page.goto("/demo/practice");
  await page.locator("[role=radio]").first().waitFor();
  await audit(page, "demo asking");
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong},`) }).click();
  await audit(page, "demo picked");
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.waitForTimeout(1000);
  await audit(page, "demo graded");
  await page.getByRole("button", { name: /^Rewind/ }).filter({ visible: true }).first().click();
  await page.waitForTimeout(1800);
  await audit(page, "demo rewind");
});

test("tap targets, one primary and the text rules on the demo Course tape: a stop's sheet and the route back", async ({ page }, info) => {
  await page.goto("/demo/tape");
  await page.locator("[data-stop-id]").filter({ visible: true }).first().waitFor();
  // Measured once every stop's staggered entrance (a 0.6 scale-in, later stops later) has finished.
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => (a as CSSAnimation).animationName?.startsWith("tape-stop") && a.playState !== "finished").length))
    .toBe(0);
  await audit(page, "demo course tape");
  await page.locator("[data-stop-id]").filter({ visible: true }).first().click();
  await page.locator("dialog[open]").waitFor();
  // Measured once the sheet's entrance (a 0.98 scale-in) has finished.
  await page.waitForTimeout(400);
  await audit(page, "demo stop sheet");
  await page.keyboard.press("Escape");
  if (info.project.name === "phone") await page.getByRole("button", { name: /^Tonight's route back/ }).click();
  await page.getByRole("button", { name: "Start the route back" }).filter({ visible: true }).first().click();
  await page.locator("[data-route-step]").waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  await audit(page, "demo route stop");
});

test("tap targets and one primary on the local practice set", async ({ page }) => {
  test.skip(!seed, "needs the local practice seed");
  const q = seed!.questions[0];
  await page.goto("/practice?set=seed");
  await page.locator("[role=radio]").first().waitFor();
  await audit(page, "practice asking");
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.waitForTimeout(1000);
  await audit(page, "practice graded");
});

test("tap targets and one primary with the tutor open: graded sheet, a hint with its chips, beside the rewind, a graded assignment", async ({ page }) => {
  const URL = "/practice?set=e2e-fixture";
  const tutor = page.getByRole("dialog", { name: "Tutor" });
  const open = () => page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first().click();
  await page.goto(URL);
  await page.locator("[role=radio]").first().waitFor();
  await page.getByRole("radio", { name: /^Option B,/ }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.waitForTimeout(1200);
  await open();
  await audit(page, "tutor on the graded sheet");
  await tutor.getByRole("button", { name: "Hint", exact: true }).click();
  await tutor.locator('[data-tutor-turn="hint"] [data-chip]').first().waitFor();
  await audit(page, "tutor with a hint and chips");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  await page.waitForTimeout(1500);
  await open();
  await audit(page, "tutor beside the rewind");
  await page.goto("/practice?set=e2e-graded");
  await page.locator("[role=radio]").first().waitFor();
  await open();
  await audit(page, "tutor on a graded assignment");
});

test.describe("with accounts on (fake sign-in)", () => {
  test.use({ baseURL: ACCOUNTS_BASE });

  test("tap targets and one primary: the demo's sign-in, signed in, and the Delete my data confirm", async ({ page }, info) => {
    // Each audit sees the screen at rest: the pointer is moved off every control first, since a click leaves it over
    // whatever opened under it (the menu's import link underlines on hover, which is right; it made this test flaky).
    const atRest = async (screen: string) => {
      await page.mouse.move(0, 0);
      await audit(page, screen);
    };
    await page.goto("/demo/practice");
    // Phone: the account control is in the Menu sheet (the header is the wordmark and Menu only).
    if (info.project.name === "phone") await page.getByRole("button", { name: "Menu", exact: true }).click();
    const signIn = page.getByRole("button", { name: "Sign in to save your practice" });
    await signIn.waitFor();
    await atRest("accounts signed out");
    await signIn.click();
    await atRest("accounts sign-in form");
    await page.getByLabel("Email (test sign-in)").fill(`lint-${info.project.name}-${Date.now()}@ufl.edu`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // Signed in, the header shows the account button; its menu holds the status line and Delete my data.
    await page.locator('[data-account="signed-in"] [data-account-button]').click();
    await page.getByRole("status").filter({ hasText: "saved in your account" }).waitFor();
    await atRest("accounts signed in");
    // The import link (a tertiary button: app/elevation.css): at rest, no underline and no tint; on hover, the 8% tint,
    // still no underline. Asserted in both states, so the audit above can't depend on where the pointer was.
    const importLink = page.getByRole("link", { name: "Import your own course: runs on your computer for now (beta)" });
    const look = () => importLink.evaluate((e) => ({ underline: getComputedStyle(e).textDecorationLine.includes("underline"), tint: getComputedStyle(e, "::before").opacity }));
    // Polled: the tint fades (a transition), so a single read can land mid-fade.
    await expect.poll(look).toEqual({ underline: false, tint: "0" });
    await importLink.hover();
    await expect.poll(look).toEqual({ underline: false, tint: "0.08" });
    await page.mouse.move(0, 0);
    await expect.poll(look).toEqual({ underline: false, tint: "0" });
    await page.getByRole("button", { name: "Delete my data" }).click();
    await atRest("accounts delete confirm");
  });
});

test("tap targets and one primary in the study session: the demo with a graded quiz card and a reply, the topics sheet, a graded topic", async ({ page }) => {
  await page.route("**/api/demo/tutor", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ t: "fallback", why: "no-key" }) + "\n" }));
  await page.goto("/demo/study");
  const chat = page.getByRole("region", { name: "Study with the tutor" });
  await chat.getByRole("button", { name: "Quiz me" }).click();
  const card = chat.locator("[data-similar-card]");
  await card.getByRole("radio").first().click();
  await card.getByRole("button", { name: "Check" }).click();
  await chat.getByRole("button", { name: "Explain this topic" }).click();
  await chat.locator("[data-saved]").first().waitFor();
  await page.waitForTimeout(500);
  await audit(page, "study session with a quiz card and a reply");
  if (page.viewportSize()!.width < 1024) {
    await page.getByRole("button", { name: "Topics" }).click();
    await page.getByRole("dialog", { name: "Topics" }).waitFor();
    await audit(page, "study session topics sheet");
  }
  await page.goto("/study?set=e2e-mixed");
  await page.locator("[data-topic][data-graded]").first().waitFor({ state: "attached" });
  if (page.viewportSize()!.width < 1024) await page.getByRole("button", { name: "Topics" }).click();
  await page.locator("[data-topic][data-graded]:visible").first().click();
  await page.locator("[data-integrity]").waitFor();
  await audit(page, "study session on a graded topic");
});

test("tap targets and one primary on the Ask tab: the examples, a deadline card, practice cards, the demo's saved reply", async ({ page }) => {
  await page.goto("/ask?set=e2e-ask");
  await page.locator("[data-example]").first().waitFor();
  await audit(page, "ask empty");
  await page.locator("[data-example]").first().click();
  await page.locator("[data-deadline-card]").waitFor();
  await audit(page, "ask deadline card");
  await page.getByRole("textbox", { name: "Ask about your courses" }).fill("Help me practice for DSA and MAS");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator("[data-practice-card]").first().waitFor();
  await page.waitForTimeout(500);
  await audit(page, "ask practice cards");
  await page.goto("/demo/ask");
  await page.locator("[data-example]").nth(1).click();
  await page.locator("[data-saved]").waitFor();
  await page.waitForTimeout(500);
  await audit(page, "ask demo saved reply");
});

test.describe("with Quick build on", () => {
  test.use({ baseURL: QUICK_BASE });

  test("tap targets and one primary: the build step with files chosen, the saved bank, practice asking and graded", async ({ page }) => {
    const text = "A hash table maps keys to buckets and finds a key in constant time on average when the table is not too full. With linear probing, a collision moves the key to the next free slot.";
    const course = { exportedAt: "2026-10-24T21:00:00Z", course: { id: 1, name: "Data Structures (Demo)", course_code: "FAKE1001" }, pages: [{ page_id: 1, title: "Module 1: Hash tables", url: "m1", body: `<p>${text}</p>` }], files: [], modules: [], assignments: [], announcements: [], submissions: [], errors: [] };
    await page.goto("/extension");
    await page.locator("[data-quick-files]").setInputFiles([{ name: "FAKE1001.course.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(course)) }]);
    await page.locator("[data-quick-found]").waitFor();
    await page.waitForTimeout(400);
    await audit(page, "quick build step");

    const bank = {
      v: 1,
      course: { code: "FAKE1001", name: "Data Structures (Demo)" },
      builtAt: "2026-10-24T21:00:00Z",
      questions: [
        {
          id: "qb-page1",
          stem: "What does linear probing do on a collision?",
          code: null,
          choices: ["Starts over", "Moves to the next free slot", "Drops the key", "Doubles the table"].map((t, i) => ({ label: "ABCD"[i], text: t })),
          answer: "B",
          explanation: "The page says so.",
          quote: "With linear probing, a collision moves the key to the next free slot.",
          source: { kind: "page", title: "Module 1: Hash tables" },
        },
      ],
    };
    await page.evaluate((b) => localStorage.setItem("rewind.quick.v1.AKE1001", JSON.stringify(b)), bank);
    await page.goto("/extension");
    await page.locator("[data-quick-bank]").waitFor();
    await page.waitForTimeout(400);
    await audit(page, "quick saved bank");

    await page.goto("/quick/practice");
    await page.locator("[role=radio]").first().waitFor();
    await audit(page, "quick practice asking");
    await page.getByRole("radio", { name: /^Option A,/ }).click();
    await page.getByRole("button", { name: "Check answer" }).click();
    await page.waitForTimeout(1000);
    await audit(page, "quick practice graded");
  });
});
