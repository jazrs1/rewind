// The extension popup (extension/popup/), its real code in Chromium with a fake chrome API and invented courses: the
// course picker (the current tab's course preselected, real courses first, "Other enrollments" collapsed, arrow keys),
// each state (exporting, done, error with Retry, not on Canvas, a Zoom recording), no raw Canvas errors outside
// "Details", 44 px targets. Screenshots of each state at 1x and 2x go to .cache/popup-shots/.
import { mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const EXT = "http://extension.test";
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const SHOTS = ".cache/popup-shots";
mkdirSync(SHOTS, { recursive: true });

const FALL = { id: 9, name: "Fall 2026", start_at: "2026-08-24T04:00:00Z" };
const COURSES = [
  { id: 1, name: "AlcoholEdu for College", course_code: "AlcoholEdu", term: { id: 1, name: "Default Term" } },
  { id: 2, name: "Data Structures and Algorithms", course_code: "COP3530", term: FALL },
  { id: 3, name: "Hazing Prevention 101", course_code: "HAZING", term: FALL },
  { id: 4, name: "Computational Linear Algebra", course_code: "MAS3114", term: FALL },
  { id: 5, name: "Title IX Training", course_code: "TitleIX", term: { id: 1, name: "Default Term" } },
  { id: 6, name: "Physics 2 with a much longer name than fits on one line of the popup", course_code: "PHY2049", term: FALL },
];
const DONE = {
  ok: true,
  filename: "MAS3114.course.json",
  counts: { modules: 6, pages: 41, files: 59, announcements: 11 },
  errors: [
    { endpoint: "/api/v1/courses/4/pages", status: 404 },
    { endpoint: "/api/v1/courses/4/files", status: 403 },
  ],
};

type Fake = { tabUrl: string; courses?: unknown[]; result?: unknown; transcript?: unknown };

/** chrome.* for the popup: the active tab's URL, and a content script that answers. Export waits for window.__finish. */
function fakeChrome(o: Fake) {
  const listeners: ((m: unknown, s: unknown) => void)[] = [];
  const w = window as unknown as { chrome: unknown; __finish: (r: unknown) => void; __exports: number; __progress: (t: string) => void };
  w.__exports = 0;
  let finish: (r: unknown) => void = () => {};
  w.__finish = (r) => finish(r);
  w.__progress = (text) => listeners.forEach((f) => f({ type: "rewind:progress", text }, { tab: { id: 7 } }));
  w.chrome = {
    runtime: { onMessage: { addListener: (f: (m: unknown, s: unknown) => void) => listeners.push(f) } },
    tabs: {
      query: async () => [{ id: 7, url: o.tabUrl }],
      sendMessage: async (_tab: number, msg: { type: string }) => {
        if (msg.type === "rewind:listCourses") return { courses: o.courses ?? [], errors: [] };
        if (msg.type === "rewind:export") {
          w.__exports++;
          return new Promise((resolve) => (finish = resolve));
        }
        if (msg.type === "rewind:exportTranscript") return o.transcript;
        return null;
      },
    },
  };
}

async function open(page: Page, fake: Fake) {
  await page.route(`${EXT}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    route.fulfill({ body: readFileSync(join("extension", p)), contentType: TYPES[extname(p)] ?? "application/octet-stream" });
  });
  await page.addInitScript(fakeChrome, fake);
  await page.goto(`${EXT}/popup/popup.html`);
  await page.evaluate(() => document.fonts.ready);
}

/** The popup's card at 1x and 2x. */
async function shot(page: Page, name: string, scale: number) {
  await page.locator(".card").screenshot({ path: `${SHOTS}/${name}@${scale}x.png` });
}

/** Every visible control is at least 44 px tall (and wide). */
async function targets(page: Page) {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("button, a, [role=option], summary")]
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => ({ t: (e.textContent ?? "").trim().slice(0, 30), r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.height < 43.5 || r.width < 43.5)
      .map(({ t, r }) => `${t} ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
  expect(small).toEqual([]);
}

for (const scale of [1, 2]) {
  test.describe(`popup at ${scale}x`, () => {
    test.use({ viewport: { width: 360, height: 640 }, deviceScaleFactor: scale, hasTouch: false });
    test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "one run per scale"));

    test("picker: the current tab's course, real courses first, Other collapsed, arrow keys", async ({ page }) => {
      await open(page, { tabUrl: "https://ufl.instructure.com/courses/4/modules", courses: COURSES });
      const main = page.getByRole("listbox", { name: "Your courses" });
      await expect(main.getByRole("option")).toHaveText([/COP3530/, /MAS3114/, /PHY2049/]);
      await expect(main.getByRole("option", { selected: true })).toContainText("Computational Linear Algebra");
      // Orientation and compliance: collapsed under Other enrollments.
      const toggle = page.getByRole("button", { name: /Other enrollments \(3\)/ });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("listbox", { name: "Other enrollments" })).toBeHidden();
      await expect(page.getByRole("button", { name: "Export course" })).toBeEnabled();
      await targets(page);
      await shot(page, "1-pick", scale);
      // Keyboard: arrows move the selection, Home and End go to the ends.
      await main.focus();
      await page.keyboard.press("ArrowDown");
      await expect(main.getByRole("option", { selected: true })).toContainText("PHY2049");
      await page.keyboard.press("Home");
      await expect(main.getByRole("option", { selected: true })).toContainText("COP3530");
      await toggle.click();
      await expect(page.getByRole("listbox", { name: "Other enrollments" }).getByRole("option")).toHaveText([/AlcoholEdu/, /Hazing/, /Title IX/]);
      await shot(page, "2-pick-other-open", scale);
    });

    test("exporting, then done: Saved to Downloads, plain notes, Details, and the link to Quick build", async ({ page }) => {
      await open(page, { tabUrl: "https://ufl.instructure.com/courses/4", courses: COURSES });
      await page.getByRole("button", { name: "Export course" }).click();
      await page.evaluate(() => (window as unknown as { __progress: (t: string) => void }).__progress("Module files 12 of 59"));
      await expect(page.locator("#progress-text")).toHaveText("Module files 12 of 59");
      await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
      await expect(page.locator("#progress-course")).toHaveText("Exporting MAS3114");
      await shot(page, "3-exporting", scale);
      await page.evaluate((r) => (window as unknown as { __finish: (r: unknown) => void }).__finish(r), DONE);
      await expect(page.getByText("Saved to Downloads")).toBeVisible();
      await expect(page.getByText("MAS3114.course.json")).toBeVisible();
      await expect(page.locator("#done-notes")).toHaveText(["Your course doesn't let students list its files; the ones linked in modules came through."]);
      // Never a raw Canvas error on screen; the technical lines only inside the closed Details.
      expect(await page.locator(".card").innerText()).not.toMatch(/\/api\/|error \d{3}/i);
      await expect(page.locator("#done-details")).not.toHaveAttribute("open", "");
      await expect(page.getByRole("link", { name: "Build practice on rewindit.org" })).toHaveAttribute("href", "https://rewindit.org/extension");
      await targets(page);
      await shot(page, "4-done", scale);
      await page.locator("#done-details summary").click();
      await expect(page.locator("#done-details-list li")).toHaveCount(2);
    });

    test("error: plain words and Try again, which retries", async ({ page }) => {
      await open(page, { tabUrl: "https://ufl.instructure.com/courses/2", courses: COURSES });
      await page.getByRole("button", { name: "Export course" }).click();
      await page.evaluate(() => (window as unknown as { __finish: (r: unknown) => void }).__finish({ ok: false, error: "Error: Could not establish connection. Receiving end does not exist." }));
      await expect(page.getByRole("alert")).toHaveText("Couldn't reach Canvas from this tab. Reload the Canvas tab, then try again.");
      expect(await page.locator(".card").innerText()).not.toMatch(/Receiving end/);
      await targets(page);
      await shot(page, "5-error", scale);
      await page.getByRole("button", { name: "Try again" }).click();
      expect(await page.evaluate(() => (window as unknown as { __exports: number }).__exports)).toBe(2);
      await expect(page.locator("#state-progress")).toBeVisible();
    });

    test("not on Canvas: an empty state, no course list", async ({ page }) => {
      await open(page, { tabUrl: "https://example.com/news" });
      await expect(page.getByText("Open a Canvas course to export it")).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to Canvas" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Export course" })).toBeHidden();
      await targets(page);
      await shot(page, "6-not-on-canvas", scale);
    });

    test("on a Zoom recording: Export lecture transcript", async ({ page }) => {
      await open(page, { tabUrl: "https://ufl.zoom.us/rec/play/FAKE", transcript: { ok: true, filename: "Lecture_2026-10-22.transcript.json", segments: 812 } });
      await expect(page.getByText("This is a lecture recording")).toBeVisible();
      await page.getByRole("button", { name: "Export lecture transcript" }).click();
      await expect(page.getByText("Saved to Downloads")).toBeVisible();
      await expect(page.locator("#done-counts")).toContainText("812");
      await shot(page, "7-transcript-done", scale);
    });
  });
}
