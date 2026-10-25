import { describe, expect, it } from "vitest";
import { byteRange, CACHE_PREFIX, cacheName, kindOf } from "../../public/demo-sw-policy.js";

const ORIGIN = "http://127.0.0.1:3000";
const kind = (path: string, origin = ORIGIN) => kindOf(new URL(path, origin), ORIGIN);

describe("what the demo's service worker may cache", () => {
  it("keeps the demo pages, Next's built assets and the demo bundle's files", () => {
    expect(kind("/demo")).toBe("page");
    expect(kind("/demo/practice")).toBe("page");
    expect(kind("/demo/practice/2026-10-22")).toBe("page");
    expect(kind("/demo/tape")).toBe("page");
    // The bundle (lib/demo/bundle.ts bundleAssets): slide images and the hosted clips.
    expect(kind("/demo/course/slides/l20261022-q1.png")).not.toBeNull();
    expect(kind("/demo/media/l20261022-q1.mp4")).not.toBeNull();
    expect(kind("/_next/static/chunks/app.js")).toBe("static");
    expect(kind("/_next/static/media/font.woff2?v=1")).toBe("static");
    // A bundle in another folder (REWIND_DEMO_BUNDLE=demo-kapoor).
    expect(kind("/demo-kapoor/clip.mp4")).toBe("asset");
    expect(kind("/demo-kapoor/slides/q1.png")).toBe("asset");
    // The header's mark, that one brand file only.
    expect(kind("/brand/rewind-mark.svg")).toBe("asset");
    for (const path of ["/brand/other.svg", "/brand/rewind-mark.svg?x=1", "/Brand/rewind-mark.svg", "/brand/../private/a.json"]) expect(kind(path), path).toBeNull();
  });

  it("never caches the dev routes, private data, the course pages, RSC data or another origin", () => {
    for (const path of [
      "/practice",
      "/practice?set=seed",
      "/course",
      "/course/tape",
      "/course/import",
      "/radar",
      "/",
      "/api/dev-slides/deck-p3.png",
      "/dev/embed-test",
      "/dev/throw",
      "/private/demo/seed.json",
      "/practice/x.json",
      "/demo/practice?_rsc=abc",
      "/_next/data/x.json",
      "/demo/../private/a.json",
    ]) {
      expect(kind(path), path).toBeNull();
    }
    expect(kind("/demo/practice", "https://example.com")).toBeNull();
  });

  it("is an allowlist: other folders, in any letter case, are refused", () => {
    for (const path of ["/API/x.png", "/PRIVATE/demo/seed.json", "/Practice/x.json", "/Api/dev-slides/a.png", "/Dev/x.json", "/Demo/clip.mp3", "/slides/q1.png", "/x/clip.mp3"]) {
      expect(kind(path), path).toBeNull();
    }
  });

  it("names one cache per build, and only safe characters", () => {
    expect(cacheName("abc123")).toBe("rewind-demo-abc123");
    expect(cacheName("../x y")).toBe("rewind-demo-xy");
    expect(cacheName(null)).toBe("rewind-demo-dev");
    expect(cacheName("abc").startsWith(CACHE_PREFIX)).toBe(true);
  });
});

describe("byteRange: a media Range request against a cached whole file", () => {
  it("reads the three forms", () => {
    expect(byteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(byteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });

  it("returns null for what it can't serve", () => {
    expect(byteRange("bytes=100-", 100)).toBeNull();
    expect(byteRange("bytes=20-10", 100)).toBeNull();
    expect(byteRange("bytes=-", 100)).toBeNull();
    expect(byteRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(byteRange("items=0-1", 100)).toBeNull();
    expect(byteRange("bytes=0-", 0)).toBeNull();
  });
});
