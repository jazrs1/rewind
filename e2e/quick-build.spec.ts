// Quick build (beta): flag off, nothing; flag on, the whole build on SYNTHETIC export files with the fake model
// (no key, no network): choose the files, Build my practice with its progress bar, practice, a miss shows the exact
// quote and its source line, Delete clears it. Screenshots for John go to .cache/quick-build-shots/.
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "./test";
import { OFF_BASE, QUICK_BASE } from "../playwright.config";
import { makePdf } from "../lib/quick/test-pdf";

const SHOTS = ".cache/quick-build-shots";
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string, project: string) => page.screenshot({ path: `${SHOTS}/${name}-${project}.png`, fullPage: false });

const TOPICS = [
  "A hash table maps keys to buckets and finds a key in constant time on average when the table is not too full.",
  "With linear probing, a collision moves the key to the next free slot in the table and keeps looking from there.",
  "A graph is connected if there is a path between every pair of vertices, however long the path might be.",
  "A binary search tree keeps smaller keys on the left and larger keys on the right of every node it holds.",
  "Merge sort splits the array in half, sorts each half on its own, and then merges the two sorted halves.",
  "A stack removes the item that was added last, and a queue removes the item that was added first of all.",
];

/** A synthetic Canvas export: 14 pages of HTML (two topics each, so every page is long enough to anchor a question), plus fields the browser must never send. */
const courseExport = {
  exportedAt: "2026-10-24T21:00:00Z",
  course: { id: 424242, name: "Data Structures (Demo)", course_code: "FAKE1001" },
  pages: Array.from({ length: 14 }, (_, i) => ({ page_id: i + 1, title: `Module ${i + 1}: ${["Hash tables", "Graphs", "Trees", "Sorting", "Stacks", "Queues", "Heaps"][i % 7]}`, url: `m${i}`, body: `<h2>Notes ${i}</h2><p>${TOPICS[i % 6]}</p><script>alert(1)</script><p>${TOPICS[(i + 1) % 6]}</p><p>Page ${i} ends here.</p>` })),
  files: [{ id: 7, display_name: "SECRET-FILE.pdf" }],
  modules: [],
  assignments: [{ name: "SECRET-ASSIGNMENT", points_possible: 100 }],
  announcements: [],
  submissions: [{ grade: "SECRET-GRADE", user: { name: "SECRET-STUDENT" } }],
  errors: [],
};

/** A synthetic Zoom transcript: the lecturer, plus a student whose lines must not be sent. */
const transcriptExport = {
  title: "Lecture, Oct 22",
  recordedAt: "2026-10-22T17:48:09Z",
  recordingUrl: "https://example.zoom.us/rec/play/FAKE-TOKEN",
  segments: [
    ...TOPICS.flatMap((t, i) => t.split(/(?<=\.)\s+/).map((text, k) => ({ start: 3463 + i * 20 + k * 8, end: 3470 + i * 20 + k * 8, speaker: "Lecturer", text: `${text} Part ${i}.` }))),
    { start: 3500, end: 3502, speaker: "Student", text: "SECRET-STUDENT-LINE could you say that again please." },
  ],
};

const file = (name: string, json: unknown) => ({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(json)) });

test.describe("flag off", () => {
  test.use({ baseURL: OFF_BASE });

  test("there is no entry point, no page and no route", async ({ page, request }) => {
    await page.goto("/extension");
    await expect(page.getByRole("heading", { name: "The Rewind extension" })).toBeVisible();
    await expect(page.locator("[data-quick-build]")).toHaveCount(0);
    await expect(page.getByText("Build my practice")).toHaveCount(0);
    expect((await page.goto("/quick/practice"))?.status()).toBe(404);
    const res = await request.post("/api/quick/generate", { data: { course: { code: "X", name: "Y" }, chunks: [] } });
    expect(res.status()).toBe(404);
  });
});

test.describe("flag on", () => {
  test.use({ baseURL: QUICK_BASE });

  test("export, Build my practice, progress, practice, a miss with its quote and source, Delete", async ({ page }, info) => {
    test.setTimeout(120_000);
    const project = info.project.name;
    const bodies: string[] = [];
    const accountCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/quick/generate")) bodies.push(r.postData() ?? "");
      if (r.url().includes("/api/account")) accountCalls.push(r.url());
    });
    // Slow the answers a little so the progress bar is seen.
    await page.route("**/api/quick/generate", async (route) => {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });

    await page.goto("/extension");
    await expect(page.locator("[data-quick-bank]")).toHaveCount(0);
    await page.locator("[data-quick-files]").setInputFiles([file("FAKE1001.course.json", courseExport), file("Lecture_Oct22.transcript.json", transcriptExport)]);
    await expect(page.locator("[data-quick-found]")).toContainText("14 pages");
    await expect(page.locator("[data-quick-found]")).toContainText("0 PDFs");
    await expect(page.locator("[data-quick-found]")).toContainText("1 recording");
    await page.locator("[data-quick-build]").scrollIntoViewIfNeeded();
    await shot(page, "p1-1-build-step", project);

    await page.locator("[data-quick-build-button]").click();
    const bar = page.getByRole("progressbar", { name: "Building your practice" });
    await expect(bar).toBeVisible();
    await shot(page, "p1-2-build-progress", project);
    await expect(page.locator("[data-quick-status]")).toContainText(/Done: \d+ questions/, { timeout: 60_000 });
    await expect(page.locator("[data-quick-bank]")).toContainText("Saving is local to this browser");

    // Stored on this device, under the versioned key; none of it went to an account route.
    const stored = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => x.startsWith("rewind.quick.v1."));
      return k ? { key: k, bank: JSON.parse(localStorage.getItem(k)!) } : null;
    });
    expect(stored?.key).toBe("rewind.quick.v1.AKE1001");
    expect(stored!.bank.questions.length).toBeGreaterThanOrEqual(5);
    expect(stored!.bank.questions.length).toBeLessThanOrEqual(15);

    // What was sent: page text and the lecturer's lines only.
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const sent = bodies.join("\n");
    expect(sent).not.toMatch(/SECRET|alert\(1\)|<h2>|<p>/);
    expect(sent).toContain("hash table maps keys");
    expect(sent).toContain("recordingUrl");

    await page.getByRole("link", { name: "Start practicing" }).click();
    await page.locator("main[data-hydrated]").waitFor({ state: "attached", timeout: 15_000 });
    await expect(page).toHaveURL(/\/quick\/practice/);

    // A miss: the fake's key is B, so A is wrong.
    await page.getByRole("radio", { name: /^Option A,/ }).click();
    await shot(page, "p1-3-practice-asking", project);
    await page.getByRole("button", { name: "Check answer" }).click();
    const title = page.locator("[data-source-title]").filter({ visible: true }).first();
    await expect(title).toHaveText(/^(Lecture, Oct 22 · \d+:\d{2}|Page: Module \d+: .+)$/);
    const quote = page.locator("[data-page-excerpt]").filter({ visible: true }).first();
    await expect(quote).toBeVisible();
    const first = stored!.bank.questions[0];
    expect((await quote.textContent())!.replace(/\s+/g, " ").trim()).toBe(first.quote.replace(/\s+/g, " ").trim());
    await page.waitForTimeout(1500); // the grading beat settles before the picture
    await shot(page, "p1-4-miss-quote-source", project);

    // Delete clears it.
    await page.goto("/extension");
    await page.locator("[data-quick-delete]").click();
    await page.locator("[data-quick-delete-yes]").click();
    await expect(page.locator("[data-quick-bank]")).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("rewind.quick.v1.")))).toBe(false);
    await page.goto("/quick/practice");
    await expect(page.getByRole("heading", { name: "No questions on this device" })).toBeVisible();

    expect(accountCalls).toEqual([]);
  });

  test("a lecture question names its recording and the second, and shows the exact words", async ({ page }) => {
    const bank = {
      v: 1,
      course: { code: "FAKE1001", name: "Data Structures (Demo)" },
      builtAt: "2026-10-24T21:00:00Z",
      questions: [
        {
          id: "qb-lecture1",
          stem: "What does a graph need to be connected?",
          code: null,
          choices: [
            { label: "A", text: "No cycles" },
            { label: "B", text: "A path between every pair" },
            { label: "C", text: "Exactly one edge" },
            { label: "D", text: "A single vertex" },
          ],
          answer: "B",
          explanation: "That is the definition.",
          quote: "A graph is connected if there is a path between every pair of vertices.",
          source: { kind: "lecture", title: "Lecture, Oct 22", sec: 2290, recordingUrl: "https://example.zoom.us/rec/play/FAKE-TOKEN" },
        },
      ],
    };
    await page.addInitScript((b) => localStorage.setItem("rewind.quick.v1.AKE1001", JSON.stringify(b)), bank);
    await page.goto("/quick/practice");
    await page.locator("main[data-hydrated]").waitFor({ state: "attached", timeout: 15_000 });
    await page.getByRole("radio", { name: /^Option A,/ }).click();
    await page.getByRole("button", { name: "Check answer" }).click();
    await expect(page.locator("[data-source-title]").first()).toHaveText("Lecture, Oct 22 · 38:10");
    await expect(page.locator("[data-page-excerpt]").first()).toHaveText("A graph is connected if there is a path between every pair of vertices.");
  });

  // Phase 2: Rewind seeks the student's own recording through the extension (a fake one here).
  test("Rewind seeks the student's own Zoom recording to the quote's second", async ({ page }, info) => {
    const bank = {
      v: 1,
      course: { code: "FAKE1001", name: "Data Structures (Demo)" },
      builtAt: "2026-10-24T21:00:00Z",
      questions: [
        {
          id: "qb-lecture1",
          stem: "What does a graph need to be connected?",
          code: null,
          choices: [
            { label: "A", text: "No cycles" },
            { label: "B", text: "A path between every pair" },
            { label: "C", text: "Exactly one edge" },
            { label: "D", text: "A single vertex" },
          ],
          answer: "B",
          explanation: "That is the definition.",
          quote: "A graph is connected if there is a path between every pair of vertices.",
          source: {
            kind: "lecture",
            title: "Lecture, Oct 22",
            sec: 2290,
            recordingUrl: "https://example.zoom.us/rec/play/FAKE-TOKEN",
            lines: [
              { start: 2280, text: "First we define a graph." },
              { start: 2290, text: "A graph is connected if there is a path between every pair of vertices." },
              { start: 2300, text: "A tree is a connected graph with no cycles." },
            ],
          },
        },
      ],
    };
    await page.addInitScript((b) => {
      localStorage.setItem("rewind.quick.v1.AKE1001", JSON.stringify(b));
      const w = window as unknown as { __sent: { type: string; seconds?: number; recordingUrl?: string }[]; chrome: unknown };
      w.__sent = [];
      let cur = 0;
      w.chrome = {
        runtime: {
          sendMessage(_id: string, msg: { type: string; seconds?: number; recordingUrl?: string }, cb: (r: unknown) => void) {
            w.__sent.push({ type: msg.type, seconds: msg.seconds, recordingUrl: msg.recordingUrl });
            if (msg.seconds !== undefined) cur = msg.seconds;
            setTimeout(() => cb({ ok: true, tabId: 1, state: { currentTime: cur, paused: msg.type !== "play", rate: 1, duration: 6000 } }), 10);
          },
        },
      };
    }, bank);
    await page.goto("/quick/practice");
    await page.locator("main[data-hydrated]").waitFor({ state: "attached", timeout: 15_000 });
    await page.getByRole("radio", { name: /^Option A,/ }).click();
    await page.getByRole("button", { name: "Check answer" }).click();
    await expect(page.getByText("explains this at 38:10").filter({ visible: true }).first()).toBeVisible();
    await expect(page.locator("[data-source-title]").first()).toHaveText("Lecture, Oct 22 · 38:10");
    await page.getByRole("button", { name: /^Rewind to .+ explanation$/ }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __sent: { type: string; seconds?: number }[] }).__sent.some((m) => (m.type === "seek" || m.type === "play") && m.seconds === 2290)), { timeout: 10_000 })
      .toBe(true);
    const sent = await page.evaluate(() => (window as unknown as { __sent: { recordingUrl?: string }[] }).__sent);
    expect(sent.some((m) => m.recordingUrl === "https://example.zoom.us/rec/play/FAKE-TOKEN")).toBe(true);
    // A quick-build course has no lecturer's name: the player says "your professor", never "where  explains it".
    await expect(page.getByText("Rewound to where your professor explains it").filter({ visible: true }).first()).toBeVisible();
    // A lecture moment with no slide image: the live line, never a grey slide placeholder that doesn't resolve (John, 2:55).
    await expect(page.locator("[data-skel=slide]")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator("[data-slide-caption]").filter({ visible: true }).first()).toBeVisible();
    await page.waitForTimeout(2000); // the player opens before the picture
    await shot(page, "p2-1-rewind-playing", info.project.name);
  });

  test("without the extension a lecture question shows the stored lines", async ({ page }) => {
    // This server has a fake extension id but no chrome.runtime in the page: the player says so and the lines stay readable.
    const bank = {
      v: 1,
      course: { code: "FAKE1001", name: "Data Structures (Demo)" },
      builtAt: "2026-10-24T21:00:00Z",
      questions: [
        {
          id: "qb-lecture1",
          stem: "What does a graph need to be connected?",
          code: null,
          choices: ["A", "B", "C", "D"].map((l) => ({ label: l, text: `Option text ${l}` })),
          answer: "B",
          explanation: "x",
          quote: "A graph is connected if there is a path between every pair of vertices.",
          source: { kind: "lecture", title: "Lecture, Oct 22", sec: 2290, recordingUrl: "https://example.zoom.us/rec/play/FAKE-TOKEN", lines: [{ start: 2290, text: "A graph is connected if there is a path between every pair of vertices." }] },
        },
      ],
    };
    await page.addInitScript((b) => localStorage.setItem("rewind.quick.v1.AKE1001", JSON.stringify(b)), bank);
    await page.goto("/quick/practice");
    await page.locator("main[data-hydrated]").waitFor({ state: "attached", timeout: 15_000 });
    await page.getByRole("radio", { name: /^Option A,/ }).click();
    await page.getByRole("button", { name: "Check answer" }).click();
    await page.getByRole("button", { name: /^Rewind to .+ explanation$/ }).click();
    await expect(page.getByText("A graph is connected if there is a path between every pair of vertices.").filter({ visible: true }).first()).toBeVisible();
  });
});

test.describe("flag on, PDFs", () => {
  test.use({ baseURL: QUICK_BASE });

  test("a synthetic slide PDF: read in the browser, image-only pages counted, a miss says \"Slide N · <deck>\" and opens nothing", async ({ page }, info) => {
    test.setTimeout(120_000);
    const bodies: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/quick/generate")) bodies.push(r.postData() ?? "");
    });
    // Three slides of text (long enough to write from) and one picture-only slide, landscape: a deck of slides.
    const slides = makePdf(
      [
        { lines: [TOPICS[0], TOPICS[1]] },
        { image: true },
        { lines: [TOPICS[2], TOPICS[3]] },
        { lines: [TOPICS[4], TOPICS[5]] },
      ],
      { landscape: true },
    );
    await page.goto("/extension");
    await page.locator("[data-quick-files]").setInputFiles([
      { name: "Week 3 Hashing.pdf", mimeType: "application/pdf", buffer: Buffer.from(slides) },
      { name: "Study guide.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK fake") },
    ]);
    await expect(page.locator("[data-quick-found]")).toContainText("1 PDF", { timeout: 30_000 });
    await expect(page.locator("[data-quick-details]")).toContainText("3 pages of text");
    await expect(page.locator("[data-quick-image-pages]")).toContainText("1 page with only pictures and no text was skipped");
    await expect(page.locator("[data-quick-not-read]")).toContainText("Not read yet: Study guide.docx");
    await page.locator("[data-quick-build]").scrollIntoViewIfNeeded();
    await shot(page, "pdf-1-found", info.project.name);

    await page.locator("[data-quick-build-button]").click();
    await expect(page.locator("[data-quick-status]")).toContainText(/Done: \d+ question/, { timeout: 60_000 });
    const sent = bodies.join("\n");
    expect(sent).toContain('"kind":"slide"');
    expect(sent).toContain('"doc":{"deck":"Week 3 Hashing","page":');
    expect(sent).not.toContain("PK fake");

    await page.getByRole("link", { name: "Start practicing" }).click();
    await page.locator("main[data-hydrated]").waitFor({ state: "attached", timeout: 15_000 });
    await page.getByRole("radio", { name: /^Option A,/ }).click();
    await page.getByRole("button", { name: "Check answer" }).click();
    await expect(page.locator("[data-source-title]").filter({ visible: true }).first()).toHaveText(/^Slide [134] · Week 3 Hashing$/);
    await expect(page.locator("[data-page-excerpt]").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Rewind to/ })).toHaveCount(0);
    await page.waitForTimeout(1500);
    await shot(page, "pdf-2-miss-slide-source", info.project.name);

    await page.goto("/extension");
    await page.locator("[data-quick-delete]").click();
    await page.locator("[data-quick-delete-yes]").click();
    await expect(page.locator("[data-quick-bank]")).toHaveCount(0);
  });
});

test.describe("flag on, Add lecture recordings", () => {
  test.use({ baseURL: QUICK_BASE });

  /** A fake extension answering { type: 'transcripts' } with what window.__exported holds (the test adds to it). */
  const fakeBridge = () => {
    const w = window as unknown as { __exported: unknown[]; chrome: unknown };
    w.__exported = [];
    w.chrome = {
      runtime: {
        sendMessage(_id: string, msg: { type: string }, cb: (r: unknown) => void) {
          setTimeout(() => cb(msg.type === "transcripts" ? { ok: true, transcripts: w.__exported } : { ok: false, error: "unknown" }), 5);
        },
      },
    };
  };
  const lecture = (n: number) => ({ ...transcriptExport, title: `Lecture ${n}`, recordingUrl: `https://ufl.zoom.us/rec/play/FAKE-${n}` });

  test("three steps, a live count that rises as transcripts are exported, and the build uses them", async ({ page }, info) => {
    test.setTimeout(120_000);
    const bodies: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/quick/generate")) bodies.push(r.postData() ?? "");
    });
    await page.addInitScript(fakeBridge);
    await page.goto("/extension");
    await expect(page.locator("[data-quick-recordings]")).toHaveCount(0);
    await page.locator("[data-quick-files]").setInputFiles([file("FAKE1001.course.json", courseExport)]);
    const step = page.locator("[data-quick-recordings]");
    await expect(page.locator("[data-quick-step-recordings]").getByRole("heading", { name: "Add lecture recordings (optional)" })).toBeVisible();
    await expect(step.locator("[data-quick-recording-steps] li")).toHaveCount(3);
    await expect(step.locator("[data-quick-lectures-added]")).toHaveText("0 lectures added");

    await page.evaluate((t) => (window as unknown as { __exported: unknown[] }).__exported.push(t), lecture(1));
    await expect(step.locator("[data-quick-lectures-added]")).toHaveText("1 lecture added", { timeout: 6000 });
    await page.evaluate((t) => (window as unknown as { __exported: unknown[] }).__exported.push(t), lecture(2));
    await expect(step.locator("[data-quick-lectures-added]")).toHaveText("2 lectures added", { timeout: 6000 });
    await step.scrollIntoViewIfNeeded();
    await shot(page, "rec-1-lectures-added", info.project.name);

    await page.locator("[data-quick-build-button]").click();
    await expect(page.locator("[data-quick-status]")).toContainText(/Done: \d+ question/, { timeout: 60_000 });
    const sent = bodies.join("\n");
    expect(sent).toContain('"kind":"lecture"');
    expect(sent).toContain("https://ufl.zoom.us/rec/play/FAKE-1");
    expect(sent).not.toContain("SECRET-STUDENT-LINE");
    await page.locator("[data-quick-delete]").click();
    await page.locator("[data-quick-delete-yes]").click();
  });

  test("skipping the step keeps the page and PDF build working, and asks the extension nothing more", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      const w = window as unknown as { __asked: number; chrome: unknown };
      w.__asked = 0;
      w.chrome = { runtime: { sendMessage: (_i: string, _m: unknown, cb: (r: unknown) => void) => (w.__asked++, setTimeout(() => cb({ ok: true, transcripts: [] }), 5)) } };
    });
    await page.goto("/extension");
    const slides = makePdf([{ lines: [TOPICS[0], TOPICS[1]] }, { lines: [TOPICS[2], TOPICS[3]] }], { landscape: true });
    await page.locator("[data-quick-files]").setInputFiles([file("FAKE1001.course.json", courseExport), { name: "Week 3 Hashing.pdf", mimeType: "application/pdf", buffer: Buffer.from(slides) }]);
    await expect(page.locator("[data-quick-found]")).toContainText("1 PDF", { timeout: 30_000 });
    await page.locator("[data-quick-recordings-skip]").click();
    await expect(page.locator("[data-quick-recordings]")).toHaveCount(0);
    const asked = await page.evaluate(() => (window as unknown as { __asked: number }).__asked);
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(asked);
    await page.locator("[data-quick-build-button]").click();
    await expect(page.locator("[data-quick-status]")).toContainText(/Done: \d+ questions/, { timeout: 60_000 });
    await page.locator("[data-quick-delete]").click();
    await page.locator("[data-quick-delete-yes]").click();
  });
});

test.describe("flag on, when the build can't happen", () => {
  test.use({ baseURL: QUICK_BASE });

  for (const [name, status, body, text] of [
    ["off (404)", 404, { error: "not found" }, "Couldn't build practice right now. Your files never left this device; try again in a minute."],
    ["capped (429, today's limit)", 429, { error: "visitor", questions: [], refused: [{ reason: "visitor" }] }, "Couldn't build practice right now (today's limit reached). Your files never left this device; try again tomorrow."],
    ["unavailable (503)", 503, { error: "unavailable", questions: [], refused: [] }, "Couldn't build practice right now. Your files never left this device; try again in a minute."],
    ["erroring (502)", 502, { error: "error", questions: [], refused: [] }, "Couldn't build practice right now. Your files never left this device; try again in a minute."],
  ] as const) {
    test(`${name}: says it couldn't build, never "Done: 0 questions"`, async ({ page }) => {
      await page.route("**/api/quick/generate", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
      await page.goto("/extension");
      await page.locator("[data-quick-files]").setInputFiles([file("FAKE1001.course.json", courseExport)]);
      await page.locator("[data-quick-build-button]").click();
      await expect(page.locator("[data-quick-failed-build]")).toHaveText(text);
      await expect(page.getByText(/Done: 0/)).toHaveCount(0);
      await expect(page.locator("[data-quick-bank]")).toHaveCount(0);
    });
  }

  test("PDFs from another course: a notice, and Build anyway builds", async ({ page }, info) => {
    test.setTimeout(120_000);
    const otherCourse = { ...courseExport, course: { id: 7, name: "Differential Equations (Demo)", course_code: "MAP2302" } };
    const slides = makePdf([{ lines: ["COP 3530 Data Structures", TOPICS[0], TOPICS[1]] }, { lines: [TOPICS[2], TOPICS[3]] }], { landscape: true });
    // A canned answer: this checks the notice and Build anyway, not the route (whose per-minute cap this spec can reach).
    const question = { id: "qb-1", stem: "What does a hash table map?", code: null, choices: ["Keys to buckets", "Pages to slides", "Edges to nodes", "Nothing"].map((t, i) => ({ label: "ABCD"[i], text: t })), answer: "A", explanation: "The slide says so.", quote: "A hash table maps keys to buckets", source: { kind: "slide", title: "COP3530 Lecture 3", deck: "COP3530 Lecture 3", page: 1 } };
    let asked = 0;
    await page.route("**/api/quick/generate", (route) => (asked++, route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ questions: [question], refused: [] }) })));
    await page.goto("/extension");
    await page.locator("[data-quick-files]").setInputFiles([file("MAP2302.course.json", otherCourse), { name: "COP3530 Lecture 3.pdf", mimeType: "application/pdf", buffer: Buffer.from(slides) }]);
    const notice = page.locator("[data-quick-mismatch]");
    await expect(notice).toContainText("These files look like they're from COP3530, not MAP2302. Build anyway?", { timeout: 30_000 });
    await expect(page.locator("[data-quick-build-button]")).toBeDisabled();
    await notice.scrollIntoViewIfNeeded();
    await shot(page, "mismatch-notice", info.project.name);
    expect(asked).toBe(0);
    await page.locator("[data-quick-build-anyway]").click();
    await expect(page.locator("[data-quick-status]")).toContainText(/Done: \d+ questions?/, { timeout: 60_000 });
    await expect(notice).toHaveCount(0);
    await page.locator("[data-quick-delete]").click();
    await page.locator("[data-quick-delete-yes]").click();
  });
});

test.describe("flag on, course text quality", () => {
  test.use({ baseURL: QUICK_BASE });

  test("equation images become inline LaTeX in what is sent (the browser's own DOMParser)", async ({ page }) => {
    const det = String.raw`\det(A) = ad - bc`;
    const matrix = String.raw`A = \begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}`;
    const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const img = (tex: string) => `<img class="equation_image" title="${attr(tex)}" src="/equation_images/${encodeURIComponent(tex)}?scale=1" alt="LaTeX: ${attr(tex)}" data-equation-content="${attr(tex)}" data-ignore-a11y-check="">`;
    const mathExport = {
      ...courseExport,
      course: { id: 3114, name: "Computational Linear Algebra (Demo)", course_code: "MAS3114" },
      pages: [{ page_id: 1, title: "Determinants", url: "det", body: `<h2>Determinants</h2><p>For a 2 by 2 matrix, ${img(det)} so for ${img(matrix)} the determinant is 1 times 4 minus 2 times 3, which is -2. A matrix is invertible exactly when its determinant is not zero.</p>` }],
    };
    const bodies: string[] = [];
    await page.route("**/api/quick/generate", async (route) => {
      bodies.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ questions: [], refused: [{ reason: "checks" }] }) });
    });
    await page.goto("/extension");
    await page.locator("[data-quick-files]").setInputFiles([file("MAS3114.course.json", mathExport)]);
    await page.locator("[data-quick-build-button]").click();
    await expect(page.locator("[data-quick-message]")).toBeVisible();
    const sent = bodies.map((b) => JSON.parse(b) as { chunks: { text: string }[] }).flatMap((b) => b.chunks.map((c) => c.text)).join("\n");
    expect(sent).toContain(`$${det}$`);
    expect(sent).toContain(`$${matrix}$`);
    expect(sent).not.toMatch(/equation_image|<img/);
  });

  test("a logistics-only course page sends nothing and says there wasn't enough course text", async ({ page }) => {
    const logistics = {
      ...courseExport,
      pages: [
        { page_id: 1, title: "Start Here", url: "start", body: "<p>Purchase your MyLab Math access code before the first class.</p><p>Click Modules in the left menu of Canvas to find each week.</p><p>Homework 1 is due Friday, Sep 4 at 11:59 PM.</p><p>Grading: Homework 20%, Quizzes 10%, Exams 70%.</p><p>Office hours: Tuesdays 2-3 PM, or email instructor@example.edu.</p>" },
        { page_id: 2, title: "Syllabus", url: "syllabus", body: `<p>${TOPICS[0]} ${TOPICS[1]}</p>` },
      ],
    };
    let asked = 0;
    await page.route("**/api/quick/generate", (route) => (asked++, route.abort()));
    await page.goto("/extension");
    await page.locator("[data-quick-files]").setInputFiles([file("FAKE1001.course.json", logistics)]);
    await page.locator("[data-quick-build-button]").click();
    await expect(page.locator("[data-quick-message]")).toHaveText("There wasn't enough course text to write questions from.");
    expect(asked).toBe(0);
    await expect(page.getByText(/Done: 0/)).toHaveCount(0);
  });
});

test.describe("flag on, math", () => {
  test.use({ baseURL: QUICK_BASE });

  test("LaTeX in a stem, choices and the quote card renders with KaTeX, and a bmatrix never widens the page", async ({ page }, info) => {
    const quote = String.raw`$\begin{bmatrix} 2a-4b\\3a+2b\\0\\3b \end{bmatrix} = \begin{bmatrix} 2a\\3a\\0\\0 \end{bmatrix} + \begin{bmatrix} -4b\\2b\\0\\3b \end{bmatrix}$`;
    const bank = {
      v: 1,
      course: { code: "MAS3114", name: "Computational Linear Algebra (Demo)" },
      builtAt: "2026-10-24T21:00:00Z",
      questions: [
        {
          id: "qb-math1",
          stem: String.raw`Let W be the set of all vectors of the form (2a-4b, 3a+2b, 0, 3b). Which pair spans W, with $a, b \in \mathbb{R}$?`,
          code: null,
          choices: [
            { label: "A", text: String.raw`$\begin{bmatrix} 1\\0 \end{bmatrix}$ only` },
            { label: "B", text: String.raw`$(2,3,0,0)$ and $(-4,2,0,3)$` },
            { label: "C", text: "Every vector in four dimensions" },
            { label: "D", text: "The zero vector only" },
          ],
          answer: "B",
          explanation: "W is a sum of a multiples and b multiples.",
          quote,
          source: { kind: "page", title: "Module 4: Spanning sets" },
        },
      ],
    };
    await page.addInitScript((b) => localStorage.setItem("rewind.quick.v1.MAS3114", JSON.stringify(b)), bank);
    await page.goto("/quick/practice");
    await page.locator("main[data-hydrated]").waitFor({ state: "attached", timeout: 15_000 });
    // The stem and a choice: math drawn, no "$" or "\" on screen in them.
    await expect(page.locator("h1 .katex").first()).toBeVisible();
    await page.getByRole("radio", { name: /^Option A,/ }).click();
    await page.getByRole("button", { name: "Check answer" }).click();
    const card = page.locator("[data-page-excerpt]").filter({ visible: true }).first();
    await expect(card.locator(".katex").first()).toBeVisible();
    const shown = await card.locator(".katex-html").first().innerText();
    expect(shown).not.toMatch(/\begin|bmatrix|\$/);
    // Never wider than the screen: the matrix scrolls inside its own box instead.
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.view);
    const box = await card.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(widths.view);
    await page.waitForTimeout(1200);
    await shot(page, "math-1-miss-bmatrix", info.project.name);
  });
});

test.describe("flag on, the build page's steps", () => {
  test.use({ baseURL: QUICK_BASE });

  const question = (id: string, kind: "page" | "lecture") => ({
    id,
    stem: `Question ${id}: what does a hash table map?`,
    code: null,
    choices: ["Keys to buckets", "Pages to slides", "Edges to nodes", "Nothing"].map((t, i) => ({ label: "ABCD"[i], text: t })),
    answer: "A",
    explanation: "The page says so.",
    quote: "A hash table maps keys to buckets",
    source: kind === "page" ? { kind: "page", title: "Module 1: Hash tables" } : { kind: "lecture", title: "Lecture, Oct 22", sec: 3463, recordingUrl: "https://ufl.zoom.us/rec/play/FAKE-1" },
  });

  test("Import, Recordings (optional), Build; the result says what it's from; Rebuild with recordings; Delete asks first", async ({ page }, info) => {
    test.setTimeout(120_000);
    const project = info.project.name;
    // A fake extension whose exported transcripts the test adds to, and a canned route (this checks the page, not the
    // route, whose per-minute cap this spec can reach).
    await page.addInitScript(() => {
      const w = window as unknown as { __exported: unknown[]; chrome: unknown };
      w.__exported = [];
      w.chrome = { runtime: { sendMessage: (_i: string, m: { type: string }, cb: (r: unknown) => void) => setTimeout(() => cb(m.type === "transcripts" ? { ok: true, transcripts: w.__exported } : { ok: false }), 5) } };
    });
    let calls = 0;
    await page.route("**/api/quick/generate", (route) => {
      calls++;
      const body = route.request().postData() ?? "";
      const qs = body.includes('"kind":"lecture"') ? [question(`l${calls}`, "lecture"), question(`p${calls}`, "page")] : [question(`p${calls}`, "page")];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ questions: qs, refused: [] }) });
    });

    await page.goto("/extension");
    await expect(page.locator("[data-quick-step-import]")).toHaveAttribute("data-step-state", "current");
    await expect(page.locator("[data-quick-step-build]")).toHaveAttribute("data-step-state", "upcoming");
    await page.locator("[data-quick-build]").scrollIntoViewIfNeeded();
    await shot(page, "u-1-empty", project);

    await page.locator("[data-quick-files]").setInputFiles([file("FAKE1001.course.json", courseExport)]);
    await expect(page.locator("[data-quick-step-import]")).toHaveAttribute("data-step-state", "done");
    await expect(page.locator("[data-quick-step-recordings]")).toHaveAttribute("data-step-state", "optional");
    await expect(page.locator("[data-quick-found] li")).toHaveText(["14 pages", "0 PDFs", "0 recordings"]);
    await page.locator("[data-quick-step-import]").scrollIntoViewIfNeeded();
    await shot(page, "u-2-imported", project);

    await page.locator("[data-quick-build-button]").click();
    const result = page.locator("[data-quick-result]");
    // 14 pages are two batches: one canned question each.
    await expect(result).toHaveText(/^\d+ questions? from your course pages$/);
    await expect(page.locator("[data-quick-first]")).toHaveText("First up: Page: Module 1: Hash tables");
    // The one orange primary on the page is now Start practicing (the download button stepped down).
    await expect(page.getByRole("link", { name: "Start practicing" })).toHaveClass(/btn-primary/);
    await expect(page.locator("[data-extension-download]")).toHaveClass(/btn-secondary/);
    await expect(page.locator("[data-quick-rebuild]")).toHaveCount(0);
    await page.locator("[data-quick-bank]").scrollIntoViewIfNeeded();
    await shot(page, "u-3-result", project);

    // A recording arrives after the build: Rebuild with recordings.
    await page.evaluate(() => (window as unknown as { __exported: unknown[] }).__exported.push({ title: "Lecture, Oct 22", recordedAt: "2026-10-22T17:48:09Z", recordingUrl: "https://ufl.zoom.us/rec/play/FAKE-1", segments: [{ start: 3463, end: 3470, speaker: "Lecturer", text: "A hash table maps keys to buckets and finds a key in constant time on average when the table is not too full." }, { start: 3471, end: 3480, speaker: "Lecturer", text: "With linear probing, a collision moves the key to the next free slot in the table and keeps looking from there." }] }));
    await expect(page.locator("[data-quick-rebuild]")).toBeVisible({ timeout: 6000 });
    await expect(page.locator("[data-quick-rebuild-note]")).toContainText("1 new recording");
    await expect(page.locator("[data-quick-found] li").nth(2)).toHaveText("1 recording");
    await page.locator("[data-quick-step-build]").scrollIntoViewIfNeeded();
    await shot(page, "u-4-rebuild", project);
    await page.locator("[data-quick-rebuild]").click();
    await expect(result).toHaveText(/^\d+ questions from your (lectures and course pages|course pages and lectures)$/);
    await expect(page.locator("[data-quick-rebuild]")).toHaveCount(0);

    // Delete asks first; Keep them keeps them.
    await page.locator("[data-quick-delete]").click();
    await expect(page.locator("[data-quick-delete-confirm]")).toContainText(/Delete \d+ questions from this browser\?/);
    await page.locator("[data-quick-delete-confirm]").scrollIntoViewIfNeeded();
    await shot(page, "u-5-delete-confirm", project);
    await page.getByRole("button", { name: "Keep them" }).click();
    await expect(page.locator("[data-quick-bank]")).toBeVisible();
    await page.locator("[data-quick-delete]").click();
    await page.locator("[data-quick-delete-yes]").click();
    await expect(page.locator("[data-quick-bank]")).toHaveCount(0);
    await expect(page.locator("[data-extension-download]")).toHaveClass(/btn-primary/);
  });
});

test.describe("flag on, graded work", () => {
  test.use({ baseURL: QUICK_BASE });

  test("a picked PDF that looks like graded work is skipped with a notice, and never sent", async ({ page }, info) => {
    const bodies: string[] = [];
    await page.route("**/api/quick/generate", async (route) => {
      bodies.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ questions: [], refused: [{ reason: "checks" }] }) });
    });
    const slides = makePdf([{ lines: [TOPICS[0], TOPICS[1]] }, { lines: [TOPICS[2], TOPICS[3]] }], { landscape: true });
    const quiz = makePdf([{ lines: ["Score: 18/20", `SECRET-GRADED ${TOPICS[4]}`] }]);
    await page.goto("/extension");
    await page.locator("[data-quick-files]").setInputFiles([
      { name: "Week 3 Hashing.pdf", mimeType: "application/pdf", buffer: Buffer.from(slides) },
      { name: "Quiz 4 graded.pdf", mimeType: "application/pdf", buffer: Buffer.from(quiz) },
    ]);
    await expect(page.locator("[data-quick-graded]")).toHaveText("Skipped 1 file that looks like graded work or submissions.", { timeout: 30_000 });
    await expect(page.locator("[data-quick-found] li").nth(1)).toHaveText("1 PDF");
    await page.locator("[data-quick-step-import]").scrollIntoViewIfNeeded();
    await shot(page, "sec-1-graded-skipped", info.project.name);
    await page.locator("[data-quick-build-button]").click();
    await expect(page.locator("[data-quick-message]")).toBeVisible();
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join("\n")).not.toMatch(/SECRET|Score: 18|Quiz 4/);
  });
});

test.describe("flag on, Coming up", () => {
  test.use({ baseURL: QUICK_BASE });

  test("the course file's due dates show soonest first, exams marked, and none of it is sent", async ({ page }, info) => {
    const bodies: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET") bodies.push(r.postData() ?? "");
    });
    const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
    const withDates = {
      ...courseExport,
      assignments: [
        { name: "SECRET-ASSIGNMENT", points_possible: 100 },
        { name: "Project 2: Hash map", due_at: inDays(12), html_url: "https://canvas.example.edu/courses/1/assignments/9", description: "<p>SECRET-DESCRIPTION</p>" },
        { name: "Exam 2", due_at: inDays(5) },
        { name: "Quiz 7: Graphs", due_at: inDays(2), is_quiz_assignment: true },
        { name: "Homework 1", due_at: inDays(-20) },
      ],
    };
    await page.goto("/extension");
    await page.locator("[data-quick-files]").setInputFiles([file("FAKE1001.course.json", withDates)]);
    const card = page.locator("[data-upcoming]");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading")).toHaveText("Coming up in Data Structures (Demo)");
    const rows = card.locator("[data-upcoming-list] > li");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Quiz 7: Graphs");
    await expect(rows.nth(1)).toHaveAttribute("data-upcoming-item", "exam");
    await expect(rows.nth(1)).toContainText("In 5 days");
    await expect(rows.nth(2).getByRole("link")).toHaveAttribute("href", "https://canvas.example.edu/courses/1/assignments/9");
    await expect(card).not.toContainText(/SECRET|Homework 1/);
    await card.scrollIntoViewIfNeeded();
    await shot(page, "upcoming-1-card", info.project.name);
    expect(bodies.join("\n")).not.toMatch(/Exam 2|Quiz 7|Project 2|SECRET/);
  });
});
