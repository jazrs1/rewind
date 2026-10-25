// The Ask tab's local course data never leaves `next dev`: /ask is a 404 and /api/ask a 404 in production and demo
// builds, lib/ask/local.ts reads nothing there even with a private/ folder present, it is server-only, and no client
// file imports it (or the invented fixture).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAskCourses, loadLocalAskCourses } from "./local";

const root = process.cwd();
afterEach(() => {
  vi.unstubAllEnvs();
  process.chdir(root);
});

/** A temp folder with a private/ course in it, as cwd. */
function withPrivateCourse() {
  const dir = mkdtempSync(join(tmpdir(), "rewind-ask-"));
  mkdirSync(join(dir, "private"));
  writeFileSync(join(dir, "private", "FAKE1234.course.json"), JSON.stringify({ course: { name: "Fake Course" }, assignments: [{ id: 1, name: "Quiz 1", due_at: "2026-11-02T03:59:00Z", points_possible: 5 }] }));
  process.chdir(dir);
}

const builds: [string, Record<string, string>][] = [
  ["a production build", { NODE_ENV: "production" }],
  ["demo mode", { NODE_ENV: "development", REWIND_DEMO: "1" }],
  ["Vercel", { NODE_ENV: "development", VERCEL: "1" }],
  ["tests", { NODE_ENV: "test" }],
];

describe("lib/ask/local.ts reads only under next dev", () => {
  it("reads the private/ course in development (the control)", async () => {
    withPrivateCourse();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("REWIND_DEMO", "");
    vi.stubEnv("VERCEL", "");
    const courses = await loadLocalAskCourses();
    expect(courses?.map((c) => c.code)).toEqual(["FAKE1234"]);
  });
  for (const [name, env] of builds)
    it(`reads nothing in ${name}, even with private/ there`, async () => {
      withPrivateCourse();
      vi.stubEnv("REWIND_DEMO", "");
      vi.stubEnv("VERCEL", "");
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      expect(await loadLocalAskCourses()).toBeNull();
      expect(await loadAskCourses(undefined)).toBeNull();
      expect(await loadAskCourses("e2e-ask")).toBeNull();
    });
});

describe("/ask and /api/ask outside next dev", () => {
  for (const [name, env] of builds.slice(0, 3))
    it(`/ask is a 404 and /api/ask answers 404 in ${name}`, async () => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const { default: AskPage } = await import("../../app/ask/page");
      let thrown: unknown;
      try {
        AskPage({ searchParams: Promise.resolve({}) } as never);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as { digest?: string })?.digest).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404/);
      const { POST } = await import("../../app/api/ask/route");
      const res = await POST(new Request("http://x/api/ask", { method: "POST", body: JSON.stringify({ message: "hi" }) }));
      expect(res.status).toBe(404);
    });
});

describe("/api/ask in next dev", () => {
  it("takes JSON only (415 otherwise), so a cross-origin page can't POST to it without a preflight", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("REWIND_DEMO", "");
    vi.stubEnv("VERCEL", "");
    const { POST } = await import("../../app/api/ask/route");
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await POST(new Request("http://x/api/ask", { method: "POST", ...(type ? { headers: { "content-type": type } } : {}), body: JSON.stringify({ message: "hi" }) }));
      expect(res.status, String(type)).toBe(415);
    }
  });
});

describe("never in a client bundle", () => {
  it("lib/ask/local.ts is server-only", () => {
    expect(readFileSync(join(root, "lib/ask/local.ts"), "utf8")).toMatch(/^import "server-only";$/m);
  });
  it('no "use client" file imports the local loader or the invented fixture', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
      });
    const client = ["app", "components", "lib"].flatMap((d) => files(join(root, d))).filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(client.length).toBeGreaterThan(5);
    for (const f of client) expect(readFileSync(f, "utf8"), f).not.toMatch(/lib\/ask\/(local|fixture)|["']\.\/(local|fixture)(\.ts)?["']/);
  });
});
