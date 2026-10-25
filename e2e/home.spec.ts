// Course home: the countdown to the next exam with a known date, exam fields with their source or
// "not found", one primary button, and lecture tapes with blank grey tapes where there's no recording.
// Runs on the local private/ data (exams.json, Canvas export, transcripts); skips without it.
// Assertions use shapes, not course text.
import { expect, test } from "./test";

test("countdown, sourced fields, not found, blank tapes", async ({ page }, info) => {
  await page.goto("/course");
  const empty = page.getByRole("heading", { name: "No course data yet" });
  const card = page.locator('[data-card="exam"]');
  await expect(empty.or(card)).toBeVisible();
  test.skip(await empty.isVisible(), "needs exams, a Canvas export or lecture transcripts in private/");

  // Countdown: "<exam> in N days" (or today), or says no date is known; never a guessed date.
  const countdown = card.locator("[data-countdown]");
  const kind = await countdown.getAttribute("data-countdown");
  if (kind === "days") {
    await expect(countdown).toHaveText(/ (in \d+ days?|is today)/);
    await expect(countdown).toContainText(/\d+\s*days? left|Today/);
  } else {
    await expect(countdown).toContainText(/date not found|No exam date found/);
  }
  if (info.project.name === "desktop") {
    await expect(page.locator("[data-countdown-text]")).toHaveText(/ in \d+ days?$| is today$|date not found|No exam date found/);
  }

  // Every field is either found (with a source label) or an empty field reading "not found".
  const fields = card.locator("[data-field]");
  expect(await fields.count()).toBe(2);
  // One source line shows ("From …"); the rest wait behind the Sources toggle (fix 3).
  await expect(card.locator("> [data-source]").first()).toContainText(/^From /);
  await card.locator("summary").click();
  const sources = card.getByRole("group", { name: "Sources" }).locator("[data-source]");
  await expect(sources.first()).toBeVisible();
  for (const label of ["Date", "Room"]) {
    const f = card.locator(`[data-field="${label}"]`);
    // Its source line ("Date: …", or merged: "Name and date: …").
    const row = sources.filter({ hasText: new RegExp(`^[^:]*\\b${label}\\b[^:]*:`, "i") });
    await expect(row).toHaveCount(1);
    if ((await f.getAttribute("data-state")) === "found") {
      await expect(row).not.toContainText("not found");
    } else {
      await expect(f).toContainText("not found");
      await expect(row).toContainText(/not found\. (Looked in|No course sources)/);
    }
  }
  // The local data has at least one field we couldn't find (a room, say).
  await expect(card.locator('[data-state="missing"]').first()).toContainText("not found");
  // Source labels sit in small print (13 px).
  expect(await sources.first().evaluate((e) => getComputedStyle(e).fontSize)).toBe("13px");

  // One primary (orange) button on the screen.
  expect(await page.locator("main a, main button").evaluateAll((els) => els.filter((e) => getComputedStyle(e).backgroundColor === "rgb(250, 70, 22)").length)).toBe(1);
  // Source lines that share a source are merged: no source label repeats.
  const labels = await sources.evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/^[^:]+:/, "").trim()));
  expect(new Set(labels).size).toBe(labels.length);
  // Tape titles are never cut off.
  const cut = await page
    .locator("[data-tape]:visible span:not(.sr-only)")
    .evaluateAll((els) => els.filter((e) => getComputedStyle(e).textOverflow === "ellipsis" || (getComputedStyle(e).display !== "inline" && e.scrollWidth > e.clientWidth + 1)).length);
  expect(cut).toBe(0);

  // Tapes: in module order, recorded tapes link, at least one blank tape that says so.
  const tapes = page.getByRole("list", { name: "Lecture tapes" }).locator(":scope > li");
  expect(await tapes.count()).toBeGreaterThan(0);
  const blank = page.locator('[data-tape="blank"]:visible').first();
  await expect(blank).toBeVisible();
  await expect(blank).toContainText("Blank tape");
  await expect(blank.locator("a")).toHaveCount(0);
  // A recorded tape says what it opens: practice for its own lecture(s), or the course tape.
  const recorded = page.locator('[data-tape="recorded"]:visible a').first();
  if (await recorded.count()) {
    await expect(recorded).toHaveAttribute("href", /^\/practice\?lecture=[\d,-]+$|^\/course\/tape$/);
    await expect(recorded).toContainText(/Practice the .+ lectures?|Open the course tape/);
    expect((await recorded.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const practiced = page.locator('[data-tape="recorded"]:visible a[href^="/practice?lecture="]').first();
  if (await practiced.count()) {
    const label = (await practiced.locator("[data-tape-opens]").textContent())!;
    await practiced.click();
    await expect(page).toHaveURL(/\/practice\?lecture=/);
    // /practice says which lecture it's practising, as the tape did.
    await expect(page.locator("[data-practice-scope]")).toContainText(label.replace(/^Practice the /, "").replace(/ lectures?$/, ""));
    await page.goto("/course");
  }

  // Phone: five tapes, "See all" shows the rest.
  if (info.project.name === "phone") {
    const total = await tapes.count();
    if (total > 5) {
      await expect(page.locator("[data-tape]:visible")).toHaveCount(5);
      const all = page.getByRole("button", { name: "See all" });
      expect((await all.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await all.click();
      await expect(page.locator("[data-tape]:visible")).toHaveCount(total);
    }
  }

  // Desktop: a run of 2+ blank tapes is one row ("Mod 1–7: 7 modules without recordings"); Show opens it.
  if (info.project.name === "desktop") {
    await expect(page.locator("[data-tape]:visible").first()).toBeVisible();
    const run = page.locator("[data-blank-run] button").first();
    if (await run.count()) {
      await expect(run).toHaveAttribute("aria-expanded", "false");
      const n = Number((await run.textContent())!.match(/: (\d+) modules without recordings/)![1]);
      const before = await page.locator("[data-tape]:visible").count();
      await run.click();
      await expect(run).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("[data-tape]:visible")).toHaveCount(before + n);
      await run.click();
      await expect(page.locator("[data-tape]:visible")).toHaveCount(before);
    }
  }

  // No horizontal scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("exam coverage not found: no practice starts before the student confirms", async ({ page }) => {
  await page.goto("/course");
  const card = page.locator('[data-card="exam"]');
  await expect(card.or(page.getByRole("heading", { name: "No course data yet" }))).toBeVisible();
  const note = card.locator('[data-coverage="unknown"]');
  test.skip(!(await card.count()) || !(await note.count()), "needs an exam whose topics weren't found");
  await expect(note).toHaveText(/ topics: not found in the syllabus or announcements\.$/);

  // Before any choice: no link into practice from the exam's card or choices, and no link anywhere that
  // opens practice without saying what (tapes name their lecture, a quiz with found topics its modules).
  await expect(card.locator('a[href^="/practice"]')).toHaveCount(0);
  await expect(page.locator("[data-step]").locator('a[href^="/practice"]')).toHaveCount(0);
  await expect(page.locator('a[href="/practice"]')).toHaveCount(0);
  // The one primary says what it is ("Practice for Exam 2"); what it covers is asked after, as the confirm step.
  const primary = page.locator('[data-step="choose"]').getByRole("button", { name: /^Practice for / });
  await expect(primary).toBeVisible();
  await primary.click();
  await expect(page).toHaveURL(/\/course$/);
  const guess = page.locator('[data-step="confirm"]');
  if (await guess.count()) {
    const confirm = page.locator('[data-step="confirm"]');
    await expect(confirm.getByRole("heading", { name: /^Practice Modules? .+\?$/ })).toBeVisible();
    await expect(confirm.locator("[data-ready]")).toHaveText(/^(Ready: Modules? [\d–, ]+( · not yet: [\d, ]+)?|No questions yet for .+)$/);
    const start = confirm.getByRole("link", { name: "Start practice" });
    if (await start.count()) {
      // The confirmed modules reach /practice, and its line says what's being practised.
      const ready = (await confirm.locator("[data-ready]").textContent())!.match(/^Ready: (Modules? [\d–]+(?:, \d+)*)/)![1];
      await start.click();
      await expect(page).toHaveURL(/\/practice\?modules=\d+(,\d+)*$/);
      const scope = page.locator("[data-practice-scope]");
      await expect(scope).toContainText(ready);
      await expect(scope).toHaveText(/^Practising Modules? [\d–, ]+ · \d+ questions?( · \d+ with a clip: ([A-Z][a-z]{2} \d+|another lecture) \(\d+\)(, ([A-Z][a-z]{2} \d+|another lecture) \(\d+\))*)?( · not yet: [\d, ]+)?$/);
    }
    await page.goto("/course");
    await page.locator('[data-step="choose"]').getByRole("button", { name: /^Practice for / }).click();
    await page.getByRole("button", { name: "Pick topics instead" }).click();
    // It starts from the guess's modules; clear them to test an empty pick.
    const checked = page.locator('[data-step="pick"]').getByRole("checkbox", { checked: true });
    while (await checked.count()) await checked.first().uncheck();
  }

  // Pick topics: Start stays disabled until a picked module has questions.
  const pick = page.locator('[data-step="pick"]');
  await expect(pick.getByRole("button", { name: "Start practice" })).toBeDisabled();
  await expect(pick.locator('a[href^="/practice"]')).toHaveCount(0);
  await expect(pick.locator("[data-ready]")).toHaveText("Pick at least one module.");
  const readyRow = pick.locator("label").filter({ hasText: "Questions ready" }).first();
  if (await readyRow.count()) {
    await readyRow.getByRole("checkbox").check();
    await expect(pick.locator("[data-ready]")).toHaveText(/^Ready: Module \d+$/);
    await expect(pick.getByRole("link", { name: "Start practice" })).toHaveAttribute("href", /^\/practice\?modules=\d+$/);
  }
  const notReady = pick.locator("label").filter({ hasText: "No questions yet" }).first();
  if (await notReady.count()) {
    await readyRow.getByRole("checkbox").uncheck();
    await notReady.getByRole("checkbox").check();
    await expect(pick.locator("[data-ready]")).toHaveText(/^No questions yet for Module \d+\.$/);
    await expect(pick.getByRole("button", { name: "Start practice" })).toBeDisabled();
  }
});

test("a nearer quiz with found topics comes first, its Canvas due date labelled as such", async ({ page }, info) => {
  await page.goto("/course");
  await expect(page.locator('[data-card="exam"]').or(page.getByRole("heading", { name: "No course data yet" }))).toBeVisible();
  // The card renders in two places (phone: above the exam card; desktop: heading the side column); one shows.
  const quiz = page.locator('[data-card="quiz"]').filter({ visible: true });
  test.skip(!(await quiz.count()), "no quiz before the next exam with found topics");
  await expect(quiz).toHaveCount(1);
  const [qy, ey] = await Promise.all([quiz.boundingBox(), page.locator('[data-card="exam"]').boundingBox()]);
  if (info.project.name === "phone") expect(qy!.y).toBeLessThan(ey!.y);
  else {
    // Desktop: the nearest deadline leads at the left, the exam card beside it; both tops in the first screen,
    // the exam card's one primary above the fold.
    expect(ey!.x).toBeGreaterThan(qy!.x + qy!.width);
    expect(Math.abs(qy!.y - ey!.y)).toBeLessThan(2);
    const primary = page.locator("[data-step] button, [data-step] a").first();
    const pb = (await primary.boundingBox())!;
    expect(pb.y + pb.height).toBeLessThanOrEqual(800);
  }
  // Ids stay unique with the card rendered twice.
  expect(await page.evaluate(() => { const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); return ids.length === new Set(ids).size; })).toBe(true);
  await expect(quiz.locator('[data-field="Covers"]')).toHaveAttribute("data-state", "found");
  const due = quiz.locator('[data-field="Due"]');
  if (await due.count()) {
    await quiz.locator("summary").click();
    // Not a quote: the source line says it's Canvas's due date.
    await expect(quiz.getByRole("group", { name: "Sources" }).locator("[data-source]").filter({ hasText: /^Due:/ })).toContainText("Canvas due date (not a quote)");
  }
  // Its practice is explicit about the modules it opens and what's ready.
  const practice = quiz.locator("xpath=..").locator("[data-quiz-practice] a");
  if (await practice.count()) {
    await expect(practice).toHaveAttribute("href", /^\/practice\?modules=\d+(,\d+)*$/);
    await expect(quiz.locator("xpath=..").locator("[data-quiz-practice]")).toContainText(/Ready: Modules? [\d–, ]+/);
  }
});

test("loads behind a skeleton of the home (blank tapes, unprinted card), never a spinner", async ({ browser }, info) => {
  // With JavaScript off the Suspense fallback stays on screen (the streamed content waits hidden).
  const ctx = await browser.newContext({ viewport: info.project.use.viewport ?? undefined, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto("/course");
  const skel = page.locator('main[aria-busy="true"]');
  await expect(skel).toBeVisible();
  await expect(skel.locator("[data-skel=card]")).toBeVisible();
  // Blank grey tapes in the shelf's rows: five on the phone (around the latest recording), every module on desktop.
  expect(await skel.locator("[data-skel=tapes] .skeleton.bg-tape-blank:visible").count()).toBe(5);
  expect(await page.locator('[role="progressbar"], .animate-spin').count()).toBe(0);
  await ctx.close();
});
