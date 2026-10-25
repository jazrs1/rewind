// The Ask tab (components/ask/AskChat.tsx) on phone and desktop:
//   - dev, the invented two-course set (/ask?set=e2e-ask, the fake model): the deadline card (one row per item, course
//     colour, days left, Graded; no-date lines), a Graded row opening guide mode, a mixed practice set across "DSA and
//     MAS" (MAS has no question bank, said plainly; a card graded in place), a grounded answer with a lecture chip that
//     plays in place, and a polite decline;
//   - the demo (COP3530 only, no key in tests): the example prompts and a saved reply with its cards.
// Screenshots for the PR go to docs/design/ask-*.png. Invented and demo data only.
import { NOT_HOSTED } from "../lib/player/hosted-media";
import { expect, test, type Page } from "./test";

test.use({ serviceWorkers: "block" });
const w = (page: Page) => page.viewportSize()!.width;
const shot = async (page: Page, name: string) => {
  // After the entrance and the cards' rise have settled.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: `docs/design/ask-${name}-${w(page)}x${page.viewportSize()!.height}.png` });
};

async function ask(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Ask about your courses" });
  await expect(input).toBeEnabled();
  await input.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-ask-turn="answer"]').last()).toBeVisible({ timeout: 20_000 });
  await expect(input).toBeEnabled();
}

test("the entrance: the intro and examples rise once; none with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ask?set=e2e-ask");
  await expect(page.locator("[data-example]").first()).toBeVisible();
  expect(await page.locator("[data-ask]").evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
});

test("empty state: centred title, one line and the example chips; course chips in the header", async ({ page }) => {
  await page.goto("/ask?set=e2e-ask");
  const empty = page.locator("[data-ask-empty]");
  await expect(empty.getByRole("heading", { name: "Ask your courses" })).toBeVisible();
  await expect(page.locator("[data-example]")).toHaveCount(3);
  // In the middle of the chat area, not stuck above the composer.
  const log = (await page.getByRole("log", { name: "Conversation" }).boundingBox())!;
  const box = (await empty.boundingBox())!;
  expect(Math.abs(box.y + box.height / 2 - (log.y + log.height / 2))).toBeLessThan(24);
  await expect(page.locator("[data-course-row] [data-course-chip]")).toHaveText(["COP3530", "MAS3114"]);
  await shot(page, "empty");
});

test("exams in the next 2 weeks: exams first, Also due, a chevron on every row that opens something, the no-date footer", async ({ page }) => {
  await page.goto("/ask?set=e2e-ask");
  await page.locator("[data-example]").first().click();
  const card = page.locator("[data-deadline-card]");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const answer = page.locator('[data-ask-turn="answer"]').last();
  await expect(answer.locator("[data-tutor-turn] > span").first()).toHaveText(/^1 exam: Exam 2, (Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d{1,2}, in 9 days\. Also due: 3 graded items and 1 more\.$/);
  const rows = card.locator("[data-deadline-row]");
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toHaveAttribute("data-kind", "exam");
  await expect(card.locator("[data-exam-summary]")).toContainText(/^1 exam: Exam 2, /);
  await expect(card.locator("[data-also-due]")).toHaveText(/Also due/i);
  await expect(card.locator("[data-row-chevron]")).toHaveCount(5);
  for (const row of await rows.all()) await expect(row.locator("a, button")).toHaveCount(1);
  await expect(rows.nth(1)).toContainText("Quiz 4 - Hashing");
  await expect(rows.nth(1).locator("[data-graded]")).toHaveText("Graded");
  const footer = card.locator("[data-no-date]");
  await expect(footer).toContainText("No date for Final Exam in your MAS3114 Canvas data (looked in: Syllabus, Canvas announcements, Canvas assignments).");
  // Never cut off: the footer's text fits its box.
  expect(await footer.evaluate((el) => [...el.querySelectorAll("p")].every((p) => p.scrollWidth <= p.clientWidth + 1))).toBe(true);
  await footer.scrollIntoViewIfNeeded();
  await shot(page, "deadlines");
  // An ungraded row in a course with no practice page asks for its practice; a Graded row opens guide mode.
  await card.locator('[data-row-action="ask-practice"]').click();
  await expect(page.locator("[data-student-turn]").last()).toHaveText("Help me practice for MAS3114");
  await expect(page.locator('[data-ask-turn="answer"]').last()).toContainText("MAS3114 has no question bank yet");
  await card.locator('[data-row-action="guide"]').nth(1).click();
  await expect(page.locator("[data-student-turn]").last()).toHaveText("Guide me on Quiz 4 - Hashing");
  const guided = page.locator('[data-ask-turn="answer"]').last();
  await expect(guided.locator("[data-integrity]")).toContainText("Quiz 4 - Hashing · Graded");
  await expect(guided.locator("[data-practice-card]")).toHaveCount(0);
});

test("practice for DSA and MAS: Scantron cards from the bank, graded in place; MAS's missing bank said plainly", async ({ page }) => {
  await page.goto("/ask?set=e2e-ask");
  await ask(page, "Help me practice for DSA and MAS");
  const answer = page.locator('[data-ask-turn="answer"]').last();
  await expect(answer).toContainText("MAS3114 has no question bank yet");
  const cards = answer.locator("[data-practice-card]");
  await expect(cards).toHaveCount(6);
  // Lecture B's questions are graded work (the invented quiz): never in a practice set.
  await expect(answer.locator('[data-practice-card="q-other-lecture"]')).toHaveCount(0);
  await shot(page, "practice");
  const first = cards.first();
  await first.getByRole("radio").first().click();
  await first.getByRole("button", { name: "Check" }).click();
  await expect(first.locator("[data-similar-card]")).toHaveAttribute("data-checked", /right|wrong/);
});

test("what the lecturer said: a grounded answer with a lecture chip that plays in place; off-topic declined", async ({ page }) => {
  await page.goto("/ask?set=e2e-ask");
  await ask(page, "What did Lee say about the heap push and the parent?");
  const answer = page.locator('[data-ask-turn="answer"]').last();
  await expect(answer.locator("[data-from-course]")).toBeVisible();
  const chip = answer.locator('[data-chip="tape"]').first();
  await expect(chip).toHaveAttribute("data-quote", /parent/i);
  await shot(page, "grounded");
  await chip.click();
  await expect(page.locator('[data-ask-turn="clip"]')).toBeVisible();
  // No hosted clip covers this moment: no empty 16:9 player and no "not hosted" note, only the slide (if any) and the quote.
  const tile = page.locator('[data-ask-turn="clip"] [data-clip-tile]').last();
  await expect(tile.locator("video, [data-clip-video]")).toHaveCount(0);
  await expect(tile).not.toContainText(NOT_HOSTED);
  await expect(tile.locator("figcaption q")).not.toBeEmpty();
  // Lecture B's load-factor lines explain graded questions (the invented open quiz): quoted, but never a chip.
  await ask(page, "What did Lee say about load factor?");
  const graded = page.locator('[data-ask-turn="answer"]').last();
  await expect(graded).toContainText("load factor");
  await expect(graded.locator("[data-chip]")).toHaveCount(0);
  await ask(page, "Tell me a joke about the weather");
  await expect(page.locator('[data-ask-turn="answer"]').last()).toContainText("I can only help with your courses");
});

test("the demo: COP3530 only, its example prompts, and a saved reply when there is no key", async ({ page }) => {
  await page.goto("/demo/ask");
  await expect(page.locator("[data-course-row]")).toContainText("COP3530");
  await expect(page.locator("[data-example]")).toHaveText(["Help me practice graphs and hash tables", "What did Kapoor say about load factor?", "Explain quicksort, I'm behind"]);
  await page.locator("[data-example]").first().click();
  const answer = page.locator('[data-ask-turn="answer"]').last();
  await expect(answer.locator("[data-saved]")).toBeVisible({ timeout: 20_000 });
  await expect(answer.locator("[data-practice-card]")).toHaveCount(6);
  await expect(answer).not.toContainText(/MAS/);
  await shot(page, "demo-practice");
  await page.goto("/demo/ask");
  await page.locator("[data-example]").nth(1).click();
  const qa = page.locator('[data-ask-turn="answer"]').last();
  await expect(qa.locator('[data-chip="tape"]')).toHaveCount(2, { timeout: 20_000 });
  await shot(page, "demo-grounded");
});

test("the demo's quicksort reply: each citation chip once (one per lecture second, one per slide)", async ({ page }) => {
  await page.goto("/demo/ask");
  await page.locator("[data-example]").nth(2).click();
  const answer = page.locator('[data-ask-turn="answer"]').last();
  await expect(answer.locator("[data-chip]").first()).toBeVisible({ timeout: 20_000 });
  const labels = (await answer.locator("[data-chip]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.length).toBeGreaterThan(0);
  expect(labels).toEqual([...new Set(labels)]);
});

for (const path of ["/ask?set=e2e-ask", "/demo/ask"]) {
  test(`contrast on ${path}: all reply and student text 4.5:1 (the 3:1 edges are in e2e/tutor.spec.ts)`, async ({ page }) => {
    await page.goto(path);
    await page.locator("[data-example]").nth(1).click();
    await expect(page.locator('[data-ask-turn="answer"]').last()).toBeVisible({ timeout: 20_000 });
    const pairs = await page.locator("main[data-ask]").evaluate((root) => {
      const solid = (el: Element | null): string => {
        for (let p = el; p; p = p.parentElement) {
          const bg = getComputedStyle(p).backgroundColor;
          if (!/rgba\(0, 0, 0, 0\)/.test(bg)) return bg;
        }
        return "rgb(255, 255, 255)";
      };
      return [...root.querySelectorAll("[data-tutor-turn] *, [data-student-turn]")]
        .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()))
        .map((e) => ({ text: e.textContent!.slice(0, 30), color: getComputedStyle(e).color, bg: solid(e) }));
    });
    expect(pairs.length).toBeGreaterThan(1);
    for (const p of pairs) expect(contrast(p.color, p.bg), p.text).toBeGreaterThanOrEqual(4.5);
  });
}

test("the demo's quicksort clip (Oct 13 · 38:04, no question of its own) plays the hosted l20261013-q1 from that second; its quote is cream on the deck", async ({ page }) => {
  await page.goto("/demo/ask");
  await page.locator("[data-example]").nth(2).click();
  const answer = page.locator('[data-ask-turn="answer"]').last();
  await expect(answer).toBeVisible({ timeout: 20_000 });
  // The clip turn comes with the reply, or from its 38:04 chip.
  const clip = page.locator('[data-ask-turn="clip"] [data-clip-tile][data-start="2284"]');
  if (!(await clip.count())) await answer.locator('[data-chip="tape"]').filter({ hasText: "38:04" }).first().click();
  const tile = clip.last();
  await expect(tile).toHaveAttribute("data-hosted", "");
  await expect(tile).not.toContainText(NOT_HOSTED);
  const video = tile.locator("video");
  await expect(video).toHaveAttribute("src", /^\/demo\/media\/l20261013-q1\.mp4#t=/);
  await tile.getByRole("button", { name: /^Play the lecture from Oct 13, 38:04/ }).click();
  // 38:04 is (38:04 − the file's start) into the file: about 10 s if the file starts at 37:54.
  const expected = await video.evaluate((v) => Number((v as HTMLVideoElement).src.split("#t=")[1]));
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(expected - 0.5);
  expect(await video.evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeLessThan(expected + 3);
  // The quote under the tile sits on the deck: cream, 4.5:1 at least.
  const pair = await tile.locator("figcaption q").evaluate((e) => {
    let bg = "rgba(0, 0, 0, 0)";
    for (let p: Element | null = e; p && /rgba\(0, 0, 0, 0\)/.test(bg); p = p.parentElement) bg = getComputedStyle(p).backgroundColor;
    return { color: getComputedStyle(e).color, bg };
  });
  expect(contrast(pair.color, pair.bg)).toBeGreaterThanOrEqual(4.5);
});

/** WCAG contrast of two computed rgb() colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, b] = c.match(/[\d.]+/g)!.slice(0, 3).map((x) => Number(x) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

test("the demo header: Ask is a tab after Practice and Course tape; the courses in a thin row under it, no header of its own", async ({ page }) => {
  await page.goto("/demo/ask");
  if (w(page) >= 1024) {
    const tabs = page.getByRole("navigation", { name: "Demo course" }).locator(".demo-tab");
    await expect(tabs).toHaveText(["Practice", "Course tape", "Ask"]);
    await expect(tabs.nth(2)).toHaveAttribute("aria-current", "page");
  } else {
    await page.getByRole("button", { name: "Menu" }).click();
    const sheet = page.getByRole("dialog", { name: "Menu" });
    await expect(sheet.getByRole("link", { name: "Ask", exact: true })).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
  }
  // One header (the app's); the course chips sit in a thin row under it.
  await expect(page.locator("main[data-ask] header")).toHaveCount(0);
  const row = page.locator("[data-course-row]");
  await expect(row.locator("[data-course-chip]")).toHaveText(["COP3530"]);
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(44);
  // And the way there from another demo screen.
  await page.goto("/demo/tape");
  if (w(page) >= 1024) await page.getByRole("navigation", { name: "Demo course" }).getByRole("link", { name: "Ask", exact: true }).click();
  else {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: "Ask", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/demo\/ask$/);
});
