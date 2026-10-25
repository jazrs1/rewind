// The full-screen study session (components/study/StudySession.tsx), John's approved mock with his changes:
//   - the rail: the Course tape's module colours, priority order with "Start here", the exam line, glow and ring;
//   - Quiz me: a sent request is a student bubble (never something clickable), the card is graded in place with a stamp;
//   - lecture moments are 16:9 clip tiles that play in place (the hosted video, or the player's own line when it isn't hosted);
//   - integrity mode on a graded topic, decided on the server: the banner, no quiz or similar question, other quick actions;
//   - ⤢ on the tutor panel carries the conversation over; the phone header names only the topic; the entrance; reduced motion.
// The demo tutor route is mocked; the dev routes run the fake model (REWIND_FAKE_LLM=1). Invented and demo data only.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { DemoBundleFile } from "../lib/demo/bundle";
import { NOT_HOSTED } from "../lib/player/hosted-media";

const bundle: DemoBundleFile = JSON.parse(readFileSync("public/demo/course/course.json", "utf8"));
const phone = (page: Page) => page.viewportSize()!.width < 1024;
const chat = (page: Page) => page.getByRole("region", { name: "Study with the tutor" });
const shot = (page: Page, name: string) => page.screenshot({ path: `.cache/shots/study-${name}-${page.viewportSize()!.width}.png` });
const ndjson = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

// The demo's offline service worker would answer tutor.json itself.
test.use({ serviceWorkers: "block" });

/** The rail on desktop, the sheet's list on a phone. */
async function rail(page: Page) {
  if (!phone(page)) return page.getByRole("complementary", { name: "Topics" });
  await page.getByRole("button", { name: "Topics" }).click();
  return page.getByRole("dialog", { name: "Topics" });
}

test("the demo session: the rail in priority order with Start here, the exam line, module colours, glow and ring", async ({ page }) => {
  await page.goto("/demo/study");
  const r = await rail(page);
  await expect(r.getByText("Demo course topics")).toBeVisible();
  await expect(r.locator("[data-exam-line]")).toHaveText(`${bundle.sets.length} lectures · the demo has no exam date`);
  const topics = r.locator("[data-topic]");
  await expect(topics.first()).toBeVisible();
  // Exactly one "Start here", on the top topic.
  await expect(r.locator("[data-start-here]")).toHaveCount(1);
  await expect(topics.first().locator("[data-start-here]")).toHaveText("Start here");
  // The glow is drawn where your professor flagged it, and the legend only names what is drawn.
  const glows = await r.locator("[data-glow]").count();
  if (glows) {
    await expect(r.getByText("Glow:")).toBeVisible();
    const box = await r.locator("[data-glow]").first().boundingBox();
    expect(box!.width).toBeGreaterThan(34);
  } else await expect(r.getByText("Glow:")).toHaveCount(0);
  // Module colours are the Course tape's tokens.
  const dots = await topics.evaluateAll((els) => els.map((e) => getComputedStyle(e.querySelector("[aria-hidden] > span:last-child")!).backgroundColor));
  const tokens = await page.evaluate(() => [1, 2, 3, 4].map((n) => getComputedStyle(document.documentElement).getPropertyValue(`--color-tape-${n}`).trim()));
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  for (const d of dots) expect(tokens.map(rgb)).toContain(d);
  await shot(page, "rail");
});

test("Quiz me: the request is a student bubble, the card is graded in place with a stamp, its chip plays the moment in a clip tile", async ({ page }) => {
  await page.goto("/demo/study");
  const c = chat(page);
  await c.getByRole("button", { name: "Quiz me" }).click();
  // What was sent is the student's words, not a control.
  const sent = c.locator("[data-student-turn]").last();
  await expect(sent).toHaveText("Quiz me");
  expect(await sent.evaluate((e) => e.tagName)).toBe("DIV");
  await expect(sent.locator("button, a, [role=button]")).toHaveCount(0);
  const card = c.locator("[data-similar-card]");
  await expect(card).toBeVisible();
  await card.getByRole("radio").first().click();
  await card.getByRole("button", { name: "Check" }).click();
  await expect(card).toHaveAttribute("data-checked", /right|wrong/);
  await expect(card.locator(".stamp").first()).toBeVisible();
  if ((await card.getAttribute("data-checked")) === "wrong") await expect(card.locator("[data-pen-circle]")).toBeVisible();
  // Its source chip, once checked: a lecture moment opens as a 16:9 clip tile in the chat.
  const chip = card.locator('[data-chip="tape"]');
  if (await chip.count()) {
    await chip.click();
    const tile = c.locator("[data-clip-tile]").last();
    await expect(tile).toBeVisible();
    const box = await tile.locator("div").first().boundingBox();
    expect(Math.abs(box!.width / box!.height - 16 / 9)).toBeLessThan(0.05);
    // The hosted clip's video, or (not hosted) the player's own line; the quote is there either way.
    await expectTileSource(tile);
    await expect(tile.locator("figcaption q")).not.toBeEmpty();
  }
  await shot(page, "quiz");
});

test("a live reply from the demo relay: its explanation moment stays hidden until the question is answered, then plays as a clip tile; the request is the question's", async ({ page }) => {
  const q = [...bundle.sets].sort((a, b) => a.id.localeCompare(b.id)).flatMap((s) => s.questions);
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/demo/tutor", (route) => {
    body = route.request().postDataJSON();
    const qq = q.find((x) => x.id === (body as { questionId: string }).questionId)!;
    const line = qq.lines[0];
    return route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: ndjson([{ t: "text", d: "Think about what the lecture says here." }, { t: "done", mode: "socratic", grounded: [{ kind: "lecture", quote: line.text, start: line.start }], rewritten: false, confirmed: false, hintsUsed: 0, sig: "s" }]),
    });
  });
  await page.goto("/demo/study");
  await chat(page).getByRole("button", { name: "Explain this topic" }).click();
  const turn = chat(page).locator('[data-tutor-turn="reply"]').last();
  await expect(turn).toContainText("Think about what the lecture says here.");
  // The moment is inside the question's explanation window: not before the student answers it (John's rule).
  await expect(turn.locator("[data-clip-tile], [data-chip]")).toHaveCount(0);
  const asked = (body as unknown as { questionId: string }).questionId;
  // Answer that question in the chat (Quiz me puts the topic's first unanswered question in: the one asked about).
  await chat(page).getByRole("button", { name: "Quiz me" }).click();
  const card = chat(page).locator("[data-similar-card]").last();
  await card.getByRole("radio").first().click();
  await card.getByRole("button", { name: "Check" }).click();
  const stem = await card.locator("p.font-serif").textContent();
  const quizzed = q.find((x) => x.stem === stem)!.id;
  expect(quizzed).toBe(asked);
  await expect(turn.locator("[data-clip-tile]")).toBeVisible();
  // The demo relay gets a question id and the student's words only; never a scope or anything else.
  expect(Object.keys(body!).sort()).toEqual(["history", "marked", "message", "questionId", "request"]);
});

test("integrity mode on a graded topic, decided on the server: the banner, no quiz or similar question, other quick actions", async ({ page }) => {
  await page.goto("/study?set=e2e-mixed");
  const r = await rail(page);
  const graded = r.locator("[data-topic][data-graded]");
  const practice = r.locator("[data-topic]:not([data-graded])");
  await expect(graded).toHaveCount(1);
  await expect(practice.first()).toBeVisible();
  await practice.first().click();
  const c = chat(page);
  await expect(page.locator("[data-integrity]")).toHaveCount(0);
  await expect(c.getByRole("button", { name: "Quiz me" })).toBeVisible();
  await expect(c.getByRole("button", { name: "Similar one" })).toBeVisible();
  await (await rail(page)).locator("[data-topic][data-graded]").click();
  await expect(page.locator("[data-integrity]")).toContainText("Graded, due Oct 30");
  for (const gone of ["Quiz me", "Similar one", "Explain this topic"]) await expect(c.getByRole("button", { name: gone })).toHaveCount(0);
  await expect(c.getByRole("button", { name: /^Explain .+ again$/ })).toBeVisible();
  await c.getByRole("button", { name: "Where do I start?" }).click();
  await expect(c.locator('[data-tutor-turn="reply"]').last()).toContainText("What does the course say about this idea?");
  await shot(page, "graded");
  // The server decides: a similar question asked straight of the study route on a graded question is refused.
  const gradedQ = await page.request.post("/api/tutor/study", { data: { set: "e2e-mixed", questionId: "q-other-lecture", request: "similar", history: [] } });
  const evs = (await gradedQ.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(evs.filter((e) => e.t === "text").map((e) => e.d).join("")).toContain("I won't write a question like this one on graded work");
  expect(evs.find((e) => e.t === "done").similar).toBeNull();
});

test("⤢ on the tutor panel carries the conversation into the study session, on that question's topic", async ({ page }) => {
  await page.goto("/practice?set=e2e-fixture");
  const ask = page.getByRole("button", { name: "Ask the tutor" }).filter({ visible: true }).first();
  await expect(ask).toBeEnabled();
  await ask.click();
  const panel = page.getByRole("dialog", { name: "Tutor" });
  await panel.getByRole("button", { name: "Hint", exact: true }).click();
  await expect(panel.locator('[data-tutor-turn="hint"]')).toContainText("Start with what the question is really asking");
  await panel.getByRole("link", { name: "Open the full-screen study session" }).click();
  await expect(page).toHaveURL(/\/study\?set=e2e-fixture&q=/);
  const c = chat(page);
  await expect(c.locator('[data-tutor-turn="hint"]')).toContainText("Start with what the question is really asking");
  await expect(c.locator("[data-student-turn]").first()).toHaveText("Hint");
});

test("phone header names only the topic; one entrance, and none with reduced motion", async ({ page }) => {
  await page.goto("/demo/study");
  if (phone(page)) {
    const sub = page.locator("[data-study-topic]");
    await expect(sub).toBeVisible();
    expect((await sub.textContent())!).not.toMatch(/in focus|·/);
  }
  const anim = () => page.locator("[data-study-intro]").evaluate((e) => getComputedStyle(e).animationName);
  expect(await anim()).toBe("rise");
  if (!phone(page)) expect(await page.locator("aside.study-rail-in").evaluate((e) => getComputedStyle(e).animationName)).toBe("rail-in");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  expect(await anim()).toBe("none");
});

// John's review of the study session (they show on camera).
const topicButtons = (page: Page) => page.locator(phone(page) ? "dialog [data-topic]" : "aside [data-topic]");
async function focusTopic(page: Page, i: number) {
  if (phone(page)) await page.getByRole("button", { name: "Topics" }).click();
  await topicButtons(page).nth(i).click();
}
/**
 * A clip tile is a hosted video with its play control (its own question's clip, or a same-lecture clip whose window
 * holds the moment), or no player at all: the slide if there is one, then the quote, and no "not hosted" note.
 */
async function expectTileSource(tile: ReturnType<Page["locator"]>) {
  const q = await tile.getAttribute("data-question");
  const own = bundle.sets.some((s) => s.hosted.includes(q!));
  const hosted = own || (await tile.getAttribute("data-hosted")) !== null;
  if (hosted) {
    await expect(tile).toHaveAttribute("data-hosted", "");
    await expect(tile.locator("video")).toHaveAttribute("src", own ? new RegExp(`^/demo/media/${q}\\.mp4#t=`) : /^\/demo\/media\/[a-z0-9-]+\.mp4#t=/);
    await expect(tile.getByRole("button", { name: /^Play the lecture from / })).toBeVisible();
  } else {
    await expect(tile.locator("video")).toHaveCount(0);
    await expect(tile.locator("[data-clip-video]")).toHaveCount(0);
  }
  await expect(tile.locator("[data-not-hosted]")).toHaveCount(0);
  await expect(tile).not.toContainText(NOT_HOSTED);
  return hosted;
}

const fallbackOnly = (page: Page) => page.route("**/api/demo/tutor", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson([{ t: "fallback", why: "no-key" }]) }));

test("topic switching: one greeting per switch, an unanswered one is replaced, a switch after a conversation adds one divider", async ({ page }) => {
  await fallbackOnly(page);
  await page.goto("/demo/study");
  const c = chat(page);
  // The session draws on the client: wait for its rail before reading it.
  await page.locator("aside [data-topic]").first().waitFor({ state: "attached" });
  const names = await page.locator("aside [data-topic]").evaluateAll((els) => els.map((e) => e.getAttribute("data-topic-name")));
  // Nothing said yet: switching just makes the first message that topic's (no greeting, no divider).
  await focusTopic(page, 1);
  await expect(c.locator("[data-study-intro]")).toContainText(`We're on ${names[1]}`);
  await expect(c.locator('[data-tutor-turn="greeting"], [data-divider]')).toHaveCount(0);
  // A conversation, then switches without replying: one divider and one greeting, for the last topic only.
  await c.getByRole("button", { name: "Explain this topic" }).click();
  await c.locator("[data-saved]").first().waitFor();
  await focusTopic(page, 2);
  await focusTopic(page, 0);
  await expect(c.locator('[data-tutor-turn="greeting"]')).toHaveCount(1);
  await expect(c.locator("[data-divider]")).toHaveCount(1);
  await expect(c.locator("[data-divider]")).toHaveText(names[0]!);
  await expect(c).not.toContainText("Now on");
  // After a reply, a new switch adds its own divider and greeting.
  await c.getByRole("button", { name: "Quiz me" }).click();
  await focusTopic(page, 1);
  await expect(c.locator('[data-tutor-turn="greeting"]')).toHaveCount(2);
  await expect(c.locator("[data-divider]")).toHaveCount(2);
  await shot(page, "after-switch");
});

test("every clip in a topic's turns comes from that topic's stop, for each demo topic", async ({ page }) => {
  await fallbackOnly(page);
  await page.goto("/demo/study");
  const c = chat(page);
  await page.locator("aside [data-topic]").first().waitFor({ state: "attached" });
  const n = await page.locator("aside [data-topic], dialog [data-topic]").evaluateAll((els) => new Set(els.map((e) => e.getAttribute("data-topic"))).size);
  const dateOf = new Map(bundle.sets.flatMap((s) => s.questions.map((q) => [q.id, s.id] as const)));
  for (let i = 0; i < n; i++) {
    await focusTopic(page, i);
    // Quiz me, answer it, then open its source moment: a clip tile in this topic's turn.
    await c.getByRole("button", { name: "Quiz me" }).click();
    const card = c.locator("[data-similar-card]").last();
    await card.getByRole("radio").first().click();
    await card.getByRole("button", { name: "Check" }).click();
    const chip = card.locator('[data-chip="tape"]');
    if (await chip.count()) await chip.click();
    await c.getByRole("button", { name: "Explain this topic" }).click();
    await c.locator("[data-saved]").last().waitFor();
  }
  const ids = new Map(await page.locator("aside [data-topic], dialog [data-topic]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-topic")!, (e.getAttribute("data-question-ids") ?? "").split(" ")] as [string, string[]])));
  const tiles = await c.locator("[data-turn-topic]").evaluateAll((els) =>
    els.flatMap((t) => [...t.querySelectorAll("[data-clip-tile]")].map((tile) => ({ topic: t.getAttribute("data-turn-topic")!, q: tile.getAttribute("data-question")!, date: tile.getAttribute("data-date") }))),
  );
  expect(tiles.length).toBeGreaterThan(0);
  for (const t of tiles) {
    expect(ids.get(t.topic), `${t.q} in ${t.topic}`).toContain(t.q);
    expect(t.date).toBe(dateOf.get(t.q));
  }
});

test("the clip tile: nothing over the picture, the slide at full brightness, one caption row with the chip and the quote", async ({ page }) => {
  await fallbackOnly(page);
  await page.goto("/demo/study");
  const c = chat(page);
  await c.getByRole("button", { name: "Quiz me" }).click();
  const card = c.locator("[data-similar-card]").last();
  await card.getByRole("radio").first().click();
  await card.getByRole("button", { name: "Check" }).click();
  await card.locator('[data-chip="tape"]').click();
  const tile = c.locator("[data-clip-tile]").last();
  const picture = tile.locator("> div").first();
  // Only the picture (and a play control for hosted video) inside it: no chip, banner or note laid over it.
  await expect(picture.locator("[data-tape-chip], [data-not-hosted], p, span")).toHaveCount(0);
  const img = picture.locator("img");
  if (await img.count()) expect(await img.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
  const caption = tile.locator("figcaption");
  await expect(caption.locator("[data-tape-chip]")).toBeVisible();
  await expect(caption.locator("q")).not.toBeEmpty();
  // The chip comes first, then the quote, on one row.
  // (the quote's first line fragment: a long quote wraps under the chip as running text)
  const chipBox = await caption.locator("[data-tape-chip]").boundingBox();
  const quoteStart = await caption.locator("q").evaluate((e) => {
    const r = e.getClientRects()[0];
    return { x: r.x, y: r.y };
  });
  expect(quoteStart.x).toBeGreaterThan(chipBox!.x + chipBox!.width - 1);
  expect(Math.abs(quoteStart.y - chipBox!.y)).toBeLessThan(chipBox!.height);
  // Hosted: the video with its play control. Not hosted: no empty 16:9 box, no "not hosted" note.
  await expectTileSource(tile);
});

test("the miss marker replaces the ring: a red-pen ✕n after the topic name in the rail and on the Course tape, and the legends show the bare ✕", async ({ page }) => {
  await page.goto("/demo/study");
  const r = await rail(page);
  // The demo's example history has misses.
  const mark = r.locator("[data-miss]").first();
  await expect(mark).toBeVisible();
  await expect(mark).toHaveText(/^✕\d+$/);
  expect(await mark.evaluate((e) => getComputedStyle(e).color)).toBe("rgb(154, 46, 34)");
  await expect(r.getByText(/missed \d+ of \d+/).first()).toBeVisible();
  // To the right of the topic's name, on its line, never over the dot.
  const topic = r.locator("[data-topic]").filter({ has: page.locator("[data-miss]") }).first();
  const [mb, nb, db] = await Promise.all([mark.boundingBox(), topic.getByText(/\S/).locator("xpath=..").first().boundingBox(), topic.locator("[aria-hidden] > span:last-child").first().boundingBox()]);
  expect(mb!.x).toBeGreaterThan(db!.x + db!.width);
  expect(mb!.y + mb!.height).toBeGreaterThan(nb!.y);
  // The legend: the bare mark, no number.
  await expect(r.locator("[data-miss-key]")).toHaveText("✕");
  await expect(r).toContainText("= times you missed it");
  await expect(r).not.toContainText("you missed 3");
  await expect(page.locator("body")).not.toContainText("Ring");
  // Rail padding: 24 px each side, nothing against the edge.
  if (!phone(page)) {
    const aside = page.getByRole("complementary", { name: "Topics" });
    expect(await aside.evaluate((e) => [getComputedStyle(e).paddingLeft, getComputedStyle(e).paddingRight])).toEqual(["24px", "24px"]);
  }
  await page.goto("/demo/tape");
  await expect(page.locator("[data-miss]").first()).toBeAttached();
  await expect(page.locator("body")).not.toContainText("Ring:");
  await expect(page.getByText("= times you missed it").first()).toBeAttached();
  await expect(page.locator("[data-miss-key]").first()).toHaveText("✕");
  await shot(page, "tape");
});

test("the demo Course tape: no minute-driven glow, and glow wording only when a stop glows", async ({ page }) => {
  await page.goto("/demo/tape");
  await expect(page.locator("[data-stop-id]").first()).toBeAttached();
  // Without topic-stats.json the demo glows only from flags and reviews; with it, from those numbers too.
  const glowing = await page.locator("[data-glow]").count();
  if (!glowing) {
    await expect(page.getByText(/flagged it/)).toHaveCount(0);
    await expect(page.getByText("Glow:")).toHaveCount(0);
  } else await expect(page.locator("[data-glow-legend]:visible")).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText(/\b(?:he|his|him)\b flagged/);
});
