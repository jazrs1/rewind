// Accounts Lite. Flag off (the main dev server): the demo has no sign-in and makes no account request.
// Flag on with fake sign-in (the second dev server, playwright.config.ts): answers given signed out move
// into the account on sign-in, come back in a fresh browser, and "Delete my data" empties it. No Clerk,
// no Upstash: the fake keeps the account in the dev server's memory.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "./test";
import type { DemoBundleFile } from "../lib/demo/bundle";
import { PRIVACY_MENU, PRIVACY_SIGN_IN } from "../lib/accounts/privacy";
import { ACCOUNTS_BASE } from "../playwright.config";

const bundle: DemoBundleFile = JSON.parse(readFileSync("public/demo/course/course.json", "utf8"));
/** /demo/practice shows the latest lecture's set. */
const questions = [...bundle.sets].sort((a, b) => b.id.localeCompare(a.id))[0].questions;
const SIGN_IN = "Sign in to save your practice";
const IMPORT = "Import your own course: runs on your computer for now (beta)";

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*(zoom\.us|googleapis\.com|anthropic\.com|clerk\.com|clerk\.accounts\.dev|upstash\.io)\//, (route) => route.abort());
});

/** Answers the question on screen with `label` (keyboard: the letter, Enter checks). */
async function answer(page: Page, index: number, label: string) {
  await closeAccount(page);
  const q = questions[index];
  await expect(page.getByRole("heading", { level: 1 })).toContainText(q.stem.slice(0, 30));
  const option = page.getByRole("radio", { name: new RegExp(`^Option ${label},`) });
  await option.click();
  await expect(option).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Check answer" }).click();
}

const storedAttempts = (page: Page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem("rewind.attempts.v1.COP3530");
    return raw ? (JSON.parse(raw).attempts as { questionId: string; stem: string | null; topic: string; example: boolean }[]) : [];
  });

/** Phone: the header is the wordmark and Menu only; the account control is at the foot of the Menu sheet. */
async function revealAccount(page: Page) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if ((await menu.isVisible()) && !(await page.getByRole("dialog", { name: "Menu" }).isVisible())) await menu.click();
}

/** Closes the phone's Menu sheet if it's open. */
async function hideSheet(page: Page) {
  const sheet = page.getByRole("dialog", { name: "Menu" });
  if (await sheet.isVisible()) await sheet.getByRole("button", { name: "Close menu" }).click();
  await expect(sheet).toBeHidden();
}

/** The header shows only the account button: signed in, the status line, Sign out and Delete my data are in its menu. */
async function openAccount(page: Page) {
  await revealAccount(page);
  const button = page.locator('[data-account="signed-in"] [data-account-button]');
  await expect(button).toBeVisible();
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(page.getByRole("region", { name: "Your account" })).toBeVisible();
}

/** Closes the account menu if it's open (it sits over the sheet's right column). */
async function closeAccount(page: Page) {
  const open = page.locator('[data-account-button][aria-expanded="true"]');
  if (await open.count()) await open.click();
  await expect(open).toHaveCount(0);
  await hideSheet(page);
}

async function signIn(page: Page, email: string) {
  await revealAccount(page);
  await page.getByRole("button", { name: SIGN_IN }).click();
  await page.getByLabel("Email (test sign-in)").fill(email);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("flag off: the demo has no sign-in and never calls the account API", async ({ page }) => {
  const account: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/account") || /clerk/i.test(r.url())) account.push(r.url());
  });
  await page.goto("/demo/practice");
  const q = questions[0];
  await answer(page, 0, q.answer);
  await expect(page.getByText(/Correct/).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: SIGN_IN })).toHaveCount(0);
  await expect(page.getByText("Import your own course")).toHaveCount(0);
  // With accounts off, "Import your own course (beta)" is on the landing only.
  await page.goto("/");
  await expect(page.getByRole("link", { name: IMPORT })).toHaveAttribute("href", "/extension");
  expect(account).toEqual([]);
});

test.describe("flag on, fake sign-in", () => {
  test("the sign-in step and the account menu say what the account keeps and how to delete it", async ({ page }, info) => {
    await page.goto("/demo/practice");
    await revealAccount(page);
    await page.getByRole("button", { name: SIGN_IN }).click();
    const form = page.getByRole("form", { name: "Test sign-in" });
    await expect(form.locator("[data-account-privacy]")).toHaveText(PRIVACY_SIGN_IN);
    await page.getByLabel("Email (test sign-in)").fill(`privacy-${info.project.name}-${Date.now()}@ufl.edu`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await openAccount(page);
    await expect(page.getByRole("region", { name: "Your account" }).locator("[data-account-privacy]")).toHaveText(PRIVACY_MENU);
  });

  test.use({ baseURL: ACCOUNTS_BASE });

  test("answers given signed out move into the account, follow to a fresh browser, and Delete my data empties it", async ({ page, browser }, info) => {
    test.setTimeout(90_000);
    const email = `student-${info.project.name}-${Date.now()}@ufl.edu`;
    const [q1, q2] = questions;
    const wrong = q2.choices.find((c) => c.label !== q2.answer)!.label;
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/account") && r.method() === "POST") posts.push(r.postData() ?? "");
    });

    // Signed out: two answers, kept on this device only.
    // "Import your own course (beta)" is on the landing (and in the account menu), not in the header.
    await page.goto("/");
    await expect(page.getByRole("link", { name: IMPORT })).toHaveAttribute("href", "/extension");
    await page.goto("/demo/practice");
    await revealAccount(page);
    await expect(page.getByRole("button", { name: SIGN_IN })).toBeVisible();
    await answer(page, 0, q1.answer);
    await page.keyboard.press("n");
    await answer(page, 1, wrong);
    await expect.poll(() => storedAttempts(page).then((a) => a.length)).toBe(2);
    expect(posts).toEqual([]);

    // Sign in: both attempts are in the account, without any course text.
    await signIn(page, email);
    await openAccount(page);
    await expect(page.getByRole("status").filter({ hasText: "2 practice answers saved in your account." })).toBeVisible();
    // The account menu also holds the import link.
    await expect(page.getByRole("region", { name: "Your account" }).getByRole("link", { name: IMPORT })).toHaveAttribute("href", "/extension");
    const res = await page.request.get("/api/account/attempts");
    expect(res.status()).toBe(200);
    const { attempts } = (await res.json()) as { attempts: Record<string, unknown>[] };
    expect(attempts.map((a) => a.questionId).sort()).toEqual([q1.id, q2.id].sort());
    for (const a of attempts) expect(Object.keys(a).sort()).toEqual(["answeredAt", "choice", "confidence", "correct", "course", "id", "questionId"]);
    for (const p of posts) {
      expect(p).not.toContain(q1.stem.slice(0, 20));
      expect(p).not.toContain(q2.stem.slice(0, 20));
      expect(p).not.toMatch(/"(stem|topic|example)"/);
    }

    // A fresh browser (nothing on the device): sign in and the two answers come back, with their stems from the bundle.
    const fresh = await browser.newContext({ baseURL: ACCOUNTS_BASE });
    const other = await fresh.newPage();
    await other.goto("/demo/practice");
    expect(await storedAttempts(other)).toEqual([]);
    await signIn(other, email);
    await openAccount(other);
    await expect(other.getByRole("status").filter({ hasText: "2 practice answers saved in your account." })).toBeVisible();
    await expect.poll(() => storedAttempts(other).then((a) => a.length)).toBe(2);
    const back = await storedAttempts(other);
    expect(back.map((a) => a.stem).sort()).toEqual([q1.stem, q2.stem].sort());
    expect(back.every((a) => !a.example)).toBe(true);

    // Reload: still there, and still 2 (signing in again duplicates nothing).
    await other.reload();
    await openAccount(other);
    await expect(other.getByRole("status").filter({ hasText: "2 practice answers saved in your account." })).toBeVisible();

    // Delete my data (with a confirm step): the account is empty.
    await openAccount(other);
    await other.getByRole("button", { name: "Delete my data" }).click();
    // The confirm leads with the question and says the sign-in stays (one short line, no text dump).
    await expect(other.getByText("Delete your practice data?")).toBeVisible();
    await expect(other.getByText(/Your sign-in stays/)).toBeVisible();
    // Honest about the one case it can't reach: another device that hasn't synced yet.
    await expect(other.getByText("Answers on another device that hasn't synced yet may come back when it next syncs.", { exact: false })).toBeVisible();
    await other.getByRole("button", { name: "Yes, delete my data" }).click();
    await openAccount(other);
    await expect(other.getByRole("status").filter({ hasText: "Deleted. Your account has no practice data." })).toBeVisible();
    // Empty, with the deletion mark other devices use to drop their copies.
    expect(await (await other.request.get("/api/account/attempts")).json()).toEqual({ attempts: [], deletedBefore: expect.any(String), serverTime: expect.any(String) });
    expect(await storedAttempts(other)).toEqual([]);
    await fresh.close();

    // The first browser's session sees the empty account too; signing out shows the sign-in again.
    // Empty, with the deletion mark other devices use to drop their copies.
    expect(await (await page.request.get("/api/account/attempts")).json()).toEqual({ attempts: [], deletedBefore: expect.any(String), serverTime: expect.any(String) });
    await openAccount(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: SIGN_IN })).toBeVisible();
    expect((await page.request.get("/api/account/attempts")).status()).toBe(401);
  });

  test("a shared browser: A's answers leave the device on sign-out and never reach B; answers given signed out in between do", async ({ page }, info) => {
    test.setTimeout(90_000);
    const stamp = `${info.project.name}-${Date.now()}`;
    const q = questions[0];
    const wrong = q.choices.find((c) => c.label !== q.answer)!.label;
    const accountIds = async () => ((await (await page.request.get("/api/account/attempts")).json()) as { attempts: { id: string }[] }).attempts.map((a) => a.id);

    await page.goto("/demo/practice");
    await signIn(page, `a-${stamp}@ufl.edu`);
    await openAccount(page);
    await expect(page.getByRole("status").filter({ hasText: "0 practice answers saved in your account." })).toBeVisible();
    await answer(page, 0, q.answer);
    await openAccount(page);
    await expect(page.getByRole("status").filter({ hasText: "1 practice answer saved in your account." })).toBeVisible();
    const aIds = await accountIds();
    expect(aIds.length).toBe(1);
    await openAccount(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: SIGN_IN })).toBeVisible();
    // A's answer is no longer on this device.
    await expect.poll(() => storedAttempts(page)).toEqual([]);

    // Signed out, the next student answers; then signs in as B.
    await page.reload();
    await answer(page, 0, wrong);
    await expect.poll(() => storedAttempts(page).then((a) => a.length)).toBe(1);
    await signIn(page, `b-${stamp}@ufl.edu`);
    await openAccount(page);
    await expect(page.getByRole("status").filter({ hasText: "1 practice answer saved in your account." })).toBeVisible();
    const bIds = await accountIds();
    expect(bIds.length).toBe(1);
    expect(bIds).not.toContain(aIds[0]);
  });

  test("account storage down (stopped or unreachable): saving says it's unavailable and practice stays on the device", async ({ page }, info) => {
    const q = questions[0];
    await page.route("**/api/account/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Saving is unavailable right now" }) }));
    await page.goto("/demo/practice");
    await signIn(page, `down-${info.project.name}-${Date.now()}@ufl.edu`);
    await openAccount(page);
    await expect(page.getByRole("status").filter({ hasText: "Saving is unavailable right now. Your practice stays on this device." })).toBeVisible();
    await answer(page, 0, q.answer);
    await expect(page.getByText(/Correct/).filter({ visible: true }).first()).toBeVisible();
    await expect.poll(() => storedAttempts(page).then((a) => a.map((x) => x.questionId))).toEqual([q.id]);
    await openAccount(page);
    await expect(page.getByRole("status").filter({ hasText: "Saving is unavailable right now" })).toBeVisible();
    // The answer isn't in the account yet: the menu says it goes if someone else signs in here (LOW-1).
    await expect(page.locator("[data-account-unsynced]")).toHaveText("1 answer isn't saved yet and will be removed if someone else signs in here.");
  });

  test("everyone's reads for today used up: the menu says syncing is paused, and practice stays on the device", async ({ page }, info) => {
    const q = questions[0];
    await page.route("**/api/account/**", (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "reads-paused" }) }) : route.fallback(),
    );
    await page.goto("/demo/practice");
    await signIn(page, `paused-${info.project.name}-${Date.now()}@ufl.edu`);
    await openAccount(page);
    await expect(page.getByRole("status").filter({ hasText: "Syncing is paused for today. Everything stays on this device and syncs when it resumes." })).toBeVisible();
    await expect(page.locator('[data-account-button][aria-label="Your account: syncing is paused"]')).toBeVisible();
    await closeAccount(page);
    await answer(page, 0, q.answer);
    await expect.poll(() => storedAttempts(page).then((a) => a.map((x) => x.questionId))).toEqual([q.id]);
  });

  test("Esc closes the sign-in form and the Delete confirm; Cancel and Esc put focus back", async ({ page }, info) => {
    await page.goto("/demo/practice");
    await revealAccount(page);
    const signInButton = page.getByRole("button", { name: SIGN_IN });
    await signInButton.click();
    await expect(page.getByLabel("Email (test sign-in)")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Email (test sign-in)")).toHaveCount(0);
    await expect(signInButton).toBeFocused();

    await signIn(page, `esc-${info.project.name}-${Date.now()}@ufl.edu`);
    await openAccount(page);
    const del = page.getByRole("button", { name: "Delete my data" });
    await del.click();
    await expect(page.getByRole("button", { name: "Yes, delete my data" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Yes, delete my data" })).toHaveCount(0);
    await expect(del).toBeFocused();
    await del.click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(del).toBeFocused();
  });
});

test.describe("flag on, the account's storage is down (stopped, unreachable)", () => {
  test.use({ baseURL: ACCOUNTS_BASE });

  test("sign-in still works, practice stays on the device and on the Course tape after a reload, Delete says it couldn't, and a retry loses nothing", async ({ page }, info) => {
    test.setTimeout(90_000);
    const down = (route: import("@playwright/test").Route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "storage-unavailable" }) });
    await page.route("**/api/account/attempts**", down);
    const [q1, q2] = questions;
    const wrong = q1.choices.find((c) => c.label !== q1.answer)!.label;

    await page.goto("/demo/practice");
    await signIn(page, `down-${info.project.name}-${Date.now()}@ufl.edu`);
    // Signing in works; saving doesn't, and the strip says so quietly.
    const status = page.getByRole("status").filter({ hasText: "Saving is unavailable right now" });
    await openAccount(page);
    await expect(status).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // An answer is kept on this device, and stays after a reload.
    await answer(page, 0, wrong);
    await expect.poll(() => storedAttempts(page).then((a) => a.length)).toBe(1);
    await page.reload();
    await openAccount(page);
    await expect(status).toBeVisible();
    expect((await storedAttempts(page)).map((a) => a.questionId)).toEqual([q1.id]);

    // The Course tape counts it: the question's topic stop shows the miss.
    await page.goto("/demo/tape");
    await expect(page.getByRole("button", { name: new RegExp(`^${q1.topic}, Taught Oct 22, .*missed 1`) }).filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });

    // Delete my data can't reach the account: it says so, and the local copy stays.
    await page.goto("/demo/practice");
    await openAccount(page);
    await page.getByRole("button", { name: "Delete my data" }).click();
    await page.getByRole("button", { name: "Yes, delete my data" }).click();
    await openAccount(page);
    await expect(page.getByRole("status").filter({ hasText: "Couldn't delete your data right now" })).toBeVisible();
    expect((await storedAttempts(page)).length).toBe(1);

    // The storage comes back: the next answer syncs everything, nothing given in the meantime is lost.
    await page.unroute("**/api/account/attempts**", down);
    await page.getByRole("button", { name: "Cancel" }).click();
    await closeAccount(page);
    await page.getByRole("button", { name: "Skip for now" }).click();
    await answer(page, 1, q2.answer);
    await openAccount(page);
    await expect(page.getByRole("status").filter({ hasText: "2 practice answers saved in your account." })).toBeVisible({ timeout: 15_000 });
    const res = await page.request.get("/api/account/attempts");
    expect(((await res.json()) as { attempts: { questionId: string }[] }).attempts.map((a) => a.questionId).sort()).toEqual([q1.id, q2.id].sort());
  });
});
