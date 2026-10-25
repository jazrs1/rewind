import { defineConfig } from "@playwright/test";

// Uses the Chromium build already cached on this machine (no browser downloads).
// On John's Windows desktop, the build Playwright 1.64 itself installs (revision 1248).
const CACHED_CHROMIUM =
  process.platform === "win32"
    ? `${process.env.LOCALAPPDATA}/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe`
    : `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

// E2E_PORT runs a worktree's own dev server beside another one on 3000 (default 3000).
const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE = `http://127.0.0.1:${PORT}`;
/** A second dev server with accounts on and fake sign-in (e2e/accounts.spec.ts), on the next port. */
export const ACCOUNTS_BASE = `http://127.0.0.1:${PORT + 1}`;
/** A third dev server whose tutor has a demo key and an Upstash that can't be reached (e2e/tutor-kv-down.spec.ts), on the port after. */
export const KVDOWN_BASE = `http://127.0.0.1:${PORT + 2}`;
/**
 * A fourth with accounts on and real (not fake) sign-in, so the Clerk path runs (e2e/accounts-clerk.spec.ts). Its keys
 * are dummies in Clerk's format: the test checks that a visit that never signs in never loads Clerk, so they're never used.
 */
export const CLERK_BASE = `http://127.0.0.1:${PORT + 3}`;
/**
 * A fifth with Quick build on (NEXT_PUBLIC_REWIND_QUICK_BUILD=1) and the fake model (e2e/quick-build.spec.ts), on the next port.
 * E2E_QUICK_BASE points the spec at a server that is already running; E2E_OFF_BASE at a flag-off server other than the main one.
 */
export const QUICK_BASE = process.env.E2E_QUICK_BASE ?? `http://127.0.0.1:${PORT + 4}`;
export const OFF_BASE = process.env.E2E_OFF_BASE ?? BASE;

/**
 * The fake values every dev server the tests start gets (no .env.test file: nothing to create, nothing to commit): the
 * fake extension ID the player tests need, and the fake tutor model (lib/tutor/fake.ts: no key, no network). Set in
 * the server's environment, they win over any .env file Next would read; .env.local's real secrets are never used.
 */
const TEST_ENV: Record<string, string> = {
  NEXT_PUBLIC_REWIND_EXTENSION_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  REWIND_FAKE_LLM: "1",
};
const testEnv = () => TEST_ENV;

export default defineConfig({
  testDir: "e2e",
  outputDir: ".cache/e2e",
  // Every route on every server compiled before the first test (first-compile time isn't a test's timeout).
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: BASE,
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? CACHED_CHROMIUM },
  },
  projects: [
    { name: "phone", use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    { command: `npm run dev -- -p ${PORT}`, url: BASE, reuseExistingServer: true, timeout: 120_000, env: { ...(process.env as Record<string, string>), ...testEnv() } },
    {
      command: `npm run dev -- -p ${PORT + 1}`,
      url: ACCOUNTS_BASE,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { ...(process.env as Record<string, string>), ...testEnv(), NEXT_PUBLIC_REWIND_ACCOUNTS: "1", REWIND_FAKE_AUTH: "1", REWIND_DIST_DIR: ".cache/next-accounts" },
    },
    {
      command: `npm run dev -- -p ${PORT + 2}`,
      url: KVDOWN_BASE,
      reuseExistingServer: true,
      timeout: 120_000,
      // Port 9 (https, as required) refuses connections at once: Upstash "set but down". The demo key is fake and must never be used.
      env: { ...(process.env as Record<string, string>), ...testEnv(), REWIND_DEMO_ANTHROPIC_API_KEY: "fake-demo-key-never-used", KV_REST_API_URL: "https://127.0.0.1:9", KV_REST_API_TOKEN: "fake-token", REWIND_DIST_DIR: ".cache/next-kvdown" },
    },
    {
      command: `npm run dev -- -p ${PORT + 3}`,
      url: CLERK_BASE,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        ...(process.env as Record<string, string>),
        ...testEnv(),
        NEXT_PUBLIC_REWIND_ACCOUNTS: "1",
        // "example.clerk.accounts.dev$" in base64: the shape Clerk checks, pointing nowhere real.
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
        CLERK_SECRET_KEY: "sk_test_fake_never_used",
        REWIND_DIST_DIR: ".cache/next-clerk",
      },
    },
    {
      command: `npm run dev -- -p ${PORT + 4}`,
      url: QUICK_BASE,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { ...(process.env as Record<string, string>), ...testEnv(), NEXT_PUBLIC_REWIND_QUICK_BUILD: "1", NEXT_PUBLIC_REWIND_UPCOMING: "1", REWIND_DIST_DIR: ".cache/next-quick" },
    },
  ],
});
