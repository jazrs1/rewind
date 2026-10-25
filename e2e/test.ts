// The specs' `test`: Playwright's, with page.goto and page.reload waiting, on the practice pages, until the
// page is hydrated (PracticeFlow sets main[data-hydrated]). A click on an answer before hydration lands on the
// server's HTML and does nothing, so "Check answer" stayed disabled and the test timed out (grading R/N, Oct 24).
// Everything else is re-exported unchanged.
import { test as base, type Page } from "@playwright/test";

export * from "@playwright/test";

/** The routes that render PracticeFlow. */
const PRACTICE = /^\/(?:demo\/)?practice(?:\/|$|\?)/;

async function hydrated(page: Page) {
  if (!PRACTICE.test(new URL(page.url()).pathname + new URL(page.url()).search)) return;
  // A practice page with nothing to practice (no seed, no bundle) has no PracticeFlow: after 15 s the test goes on and says what's wrong.
  await page.locator("main[data-hydrated]").waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
}

export const test = base.extend({
  page: async ({ page }, provide) => {
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (...args: Parameters<Page["goto"]>) => {
      const res = await goto(...args);
      await hydrated(page);
      return res;
    };
    page.reload = async (...args: Parameters<Page["reload"]>) => {
      const res = await reload(...args);
      await hydrated(page);
      return res;
    };
    await provide(page);
  },
});
