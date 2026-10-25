// Accounts on with real (not fake) sign-in: a visit to the demo that never signs in never starts Clerk. No
// request to Clerk or any other origin, no Clerk script, no Clerk cookie, no window.Clerk; "Sign in to save" is
// there and ready. (Clerk mounts only on that click, or when this site already has a Clerk session cookie:
// components/accounts/AccountMenu.tsx.) In a production build the visit doesn't even download Clerk's code; the dev
// server's Turbopack preloads that lazy chunk from this origin, so this checks what Clerk would do once it ran.
import { expect, test, type Page } from "./test";
import { CLERK_BASE } from "../playwright.config";

test.use({ baseURL: CLERK_BASE });

/** Phone: the account control is at the foot of the Menu sheet (as in e2e/accounts.spec.ts). */
async function revealAccount(page: Page) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if ((await menu.isVisible()) && !(await page.getByRole("dialog", { name: "Menu" }).isVisible())) await menu.click();
}

test("a signed-out demo visit makes no Clerk request and sets no cookie", async ({ page, context }) => {
  const clerkish: string[] = [];
  page.on("request", (r) => {
    const url = r.url();
    if (!url.startsWith(CLERK_BASE) && !url.startsWith("data:")) clerkish.push(url);
  });
  await page.goto("/demo/practice");
  await revealAccount(page);
  const signIn = page.getByRole("button", { name: "Sign in to save your practice" });
  await expect(signIn).toBeVisible();
  await expect(signIn).toBeEnabled();
  await page.waitForLoadState("networkidle");
  // Move around the page too: still nothing.
  await page.reload();
  await revealAccount(page);
  await expect(signIn).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(clerkish).toEqual([]);
  expect((await context.cookies()).map((c) => c.name).filter((n) => /^__(session|client|clerk)/.test(n))).toEqual([]);
  expect(await page.evaluate(() => typeof (window as { Clerk?: unknown }).Clerk)).toBe("undefined");
  // Clerk's loader marks its own script tag (and would fetch it from Clerk's origin, which the check above forbids).
  expect(await page.locator("script[data-clerk-js-script]").count()).toBe(0);
});
