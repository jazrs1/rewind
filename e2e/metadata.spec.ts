// Link previews and icons on every route: each page (found by walking app/ for page.tsx, so a new route
// can't be missed) has og:title, og:description, an absolute og:image and twitter:card, with titles from
// the "%s · Rewind" template; the icons and the manifest are ours, never Next.js or Vercel defaults.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "@playwright/test";

const bundle = JSON.parse(readFileSync("public/demo/course/course.json", "utf8")) as { sets: { id: string }[] };

/** Every page route, with dynamic segments filled from the demo bundle. */
function routes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "page.tsx") out.push(`/${relative("app", dir).split(sep).join("/")}`.replace(/\/$/, "") || "/");
    }
  };
  walk("app");
  return out.flatMap((r) => (r.includes("[lecture]") ? bundle.sets.map((s) => r.replace("[lecture]", s.id)) : [r])).sort();
}

/** What each route's title should be (template "%s · Rewind"; the landing page is just "Rewind"). */
const EXPECTED: Record<string, string> = {
  "/": "Rewind",
  "/practice": "Practice · Rewind",
  "/course/tape": "Course tape · Rewind",
  "/study": "Study · Rewind",
  "/demo/practice": "Demo · Rewind",
  "/demo/tape": "Demo · Rewind",
  "/demo/study": "Demo · Rewind",
  "/demo/radar": "Demo · Rewind",
  "/extension": "Chrome extension · Rewind",
  "/privacy": "Privacy · Rewind",
};

const meta = (html: string, key: string) => {
  const m = html.match(new RegExp(`<meta[^>]*(?:property|name)="${key.replace(/[:]/g, "\\$&")}"[^>]*content="([^"]*)"`)) ?? html.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*(?:property|name)="${key}"`));
  return m ? m[1].replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&") : null;
};

test.describe("link previews", () => {
  // One project is enough: the HTML doesn't depend on the viewport.
  test.skip(({ isMobile, viewport }) => !!isMobile || (viewport?.width ?? 0) < 1000, "desktop project only");

  for (const route of routes()) {
    test(`${route} has og:title, og:description, an absolute og:image and twitter:card`, async ({ request }) => {
      // A link-preview bot's user agent: Next puts the metadata in <head> for these (no streaming).
      const res = await request.get(route, { headers: { "User-Agent": "facebookexternalhit/1.1" }, maxRedirects: 0 });
      const html = await res.text();
      const title = meta(html, "og:title");
      expect(title, "og:title").toBeTruthy();
      expect(title!.endsWith("Rewind"), `og:title "${title}" follows the template`).toBe(true);
      if (EXPECTED[route]) {
        expect(title).toBe(EXPECTED[route]);
        expect(html).toContain(`<title>${EXPECTED[route]}</title>`);
      }
      expect(meta(html, "og:description")).toBe("Practice quizzes made in your professor's style. Confused? Rewind to their explanation.");
      expect(meta(html, "og:image")).toMatch(/^https?:\/\/[^/]+\/og\.png$/);
      expect(meta(html, "twitter:card")).toBe("summary_large_image");
      expect(meta(html, "twitter:image")).toMatch(/^https?:\/\/[^/]+\/og\.png$/);
      expect(meta(html, "theme-color")?.toLowerCase()).toBe("#1e2b30");
      // Our icons and manifest, and no default ones.
      expect(html).toMatch(/<link rel="icon" href="\/icon\.svg[^"]*"[^>]*type="image\/svg\+xml"/);
      expect(html).toMatch(/<link rel="icon" href="\/favicon\.ico[^"]*"/);
      expect(html).toMatch(/<link rel="apple-touch-icon" href="\/apple-icon\.png[^"]*"[^>]*sizes="180x180"/);
      expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/);
      expect(html).not.toMatch(/vercel\.svg|next\.svg/);
    });
  }

  test("a 404 has the previews too", async ({ request }) => {
    const res = await request.get("/no-such-page", { headers: { "User-Agent": "facebookexternalhit/1.1" } });
    expect(res.status()).toBe(404);
    const html = await res.text();
    expect(meta(html, "og:title")).toBe("Page not found · Rewind");
    expect(meta(html, "og:image")).toMatch(/^https?:\/\/[^/]+\/og\.png$/);
  });

  test("the preview image, the icons and the manifest are served, at their sizes", async ({ request, page }) => {
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "Rewind", theme_color: "#1E2B30", background_color: "#1E2B30" });
    expect(manifest.icons).toEqual([
      expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ src: "/icons/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" }),
    ]);
    const sizes: Record<string, [number, number]> = { "/og.png": [1200, 630], "/apple-icon.png": [180, 180], "/icons/icon-192.png": [192, 192], "/icons/icon-512.png": [512, 512], "/icons/icon-maskable-512.png": [512, 512] };
    for (const [url, [w, h]] of Object.entries(sizes)) {
      const res = await request.get(url);
      expect(res.status(), url).toBe(200);
      const png = await res.body();
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], url).toEqual([w, h]);
    }
    // favicon.ico holds 16, 32 and 48.
    const ico = await (await request.get("/favicon.ico")).body();
    expect(ico.readUInt16LE(2)).toBe(1);
    expect([0, 1, 2].map((i) => ico.readUInt8(6 + 16 * i))).toEqual([16, 32, 48]);
    // One source for the mark: app/icon.svg is public/brand/rewind-mark.svg, nudged 2 units up (scripts/brand/render.mjs).
    const inner = (svg: string) => svg.trim().replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    const source = readFileSync("public/brand/rewind-mark.svg", "utf8");
    expect(inner(await (await request.get("/icon.svg")).text())).toBe(inner(source));
    expect((await request.get("/brand/rewind-mark.svg")).status()).toBe(200);
    await page.goto("/");
    await expect(page.locator("main").getByText("Rewind").first()).toBeVisible();
  });
});
