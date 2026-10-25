// The extension's allowed origins are exactly the app's production origins plus the dev server: a domain
// change on one side without the other fails here. No vercel.app origin is ever allowed.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { siteUrl } from "./metadata.ts";
import { DEV_ORIGIN, PRODUCTION_ORIGINS, PRODUCTION_URL } from "./site.ts";

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")) as { externally_connectable: { matches: string[] } };
const allowed = (): string[] => {
  const ctx: { ALLOWED_APP_ORIGINS?: string[] } = {};
  runInNewContext(`${readFileSync("extension/allowed-origins.js", "utf8")}\nthis.ALLOWED_APP_ORIGINS = ALLOWED_APP_ORIGINS;`, ctx);
  return ctx.ALLOWED_APP_ORIGINS ?? [];
};
const expected = [DEV_ORIGIN, ...PRODUCTION_ORIGINS].sort();

describe("the extension's allowed origins match the app's production URL", () => {
  it("allowed-origins.js lists the dev server and the production origins, nothing else", () => {
    expect([...allowed()].sort()).toEqual(expected);
  });

  it("manifest.json's externally_connectable lists the same origins", () => {
    expect(manifest.externally_connectable.matches.map((m) => m.replace(/\/\*$/, "")).sort()).toEqual(expected);
  });

  it("the production URL is https, a bare origin, and the first production origin; www is the only alias", () => {
    expect(new URL(PRODUCTION_URL).origin).toBe(PRODUCTION_URL);
    expect(PRODUCTION_URL.startsWith("https://")).toBe(true);
    expect(PRODUCTION_ORIGINS).toEqual([PRODUCTION_URL, PRODUCTION_URL.replace("https://", "https://www.")]);
    // No wildcard host and no vercel.app origin, in either list.
    for (const o of [...allowed(), ...manifest.externally_connectable.matches]) expect(new URL(o.replace(/\/\*$/, "")).host).not.toMatch(/vercel\.app|\*/);
  });

  it("link previews on the production deployment use an allowed origin", () => {
    expect(PRODUCTION_ORIGINS).toContain(siteUrl({ NEXT_PUBLIC_SITE_URL: PRODUCTION_URL }).origin);
    expect(PRODUCTION_ORIGINS).toContain(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "rewindit.org" }).origin);
  });
});
