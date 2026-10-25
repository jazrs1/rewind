// Warms every dev server the tests use before the first test: each route is loaded once in a browser (its
// server and client code compiled, its chunks fetched), and each API route is asked once, so a test's own
// timeout never pays for a first compile (rewind-controls on the phone timed out at first compile; the
// accounts server's first page was slow for design-lint). A route that answers an error is fine here: the
// point is the compile, and the tests say what's wrong.
import { readFileSync } from "node:fs";
import { chromium, type FullConfig } from "@playwright/test";

/** Pages per server (the main one gets the dev pages; the accounts and KV-down servers only serve the demo). */
const MAIN_PAGES = ["/", "/course", "/course/import", "/course/tape", "/practice", "/practice?set=seed", "/radar", "/demo/practice", "/demo/tape", "/demo/radar", "/dev/embed-test", "/dev/shelf"];
const DEMO_PAGES = ["/demo/practice", "/demo/tape"];
const API = ["/api/tutor", "/api/demo/tutor", "/api/account/attempts"];

/** A server is up when it answers anything at all. */
async function waitUp(base: string, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(10_000) });
      return;
    } catch (e) {
      if (Date.now() > until) throw new Error(`${base} didn't come up in ${ms / 1000} s: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export default async function globalSetup(config: FullConfig) {
  const main = config.projects[0]?.use.baseURL;
  if (!main) return;
  const servers = new Map<string, string[]>([[main, MAIN_PAGES]]);
  const webServers = Array.isArray(config.webServer) ? config.webServer : config.webServer ? [config.webServer] : [];
  for (const w of webServers) if (w.url && !servers.has(w.url)) servers.set(w.url, DEMO_PAGES);
  let lectures: string[] = [];
  try {
    lectures = (JSON.parse(readFileSync("public/demo/course/course.json", "utf8")) as { sets: { id: string }[] }).sets.map((s) => `/demo/practice/${s.id}`);
  } catch {
    // no demo bundle: the demo specs say so themselves
  }

  const exe = (config.projects[0]?.use.launchOptions as { executablePath?: string } | undefined)?.executablePath;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    await Promise.all(
      [...servers].map(async ([base, pages]) => {
        await waitUp(base, 180_000);
        const page = await browser.newPage();
        for (const path of [...pages, ...(base === main ? lectures : lectures.slice(0, 1))]) {
          await page.goto(base + path, { waitUntil: "load", timeout: 180_000 }).catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
        }
        await page.close();
        // GET compiles the route (it answers 405 or an error); never a POST, which a route could count against its limits.
        for (const path of API) await fetch(base + path, { signal: AbortSignal.timeout(120_000) }).catch(() => {});
      }),
    );
  } finally {
    await browser.close();
  }
}
