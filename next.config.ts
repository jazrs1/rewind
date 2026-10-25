import { readFileSync } from "node:fs";
import type { NextConfig } from "next";
import { coverageWarning, similarWarning } from "./lib/demo/tutor-coverage.ts";

// Demo mode (lib/demo/guard.ts, same rule): production builds and REWIND_DEMO=1. The pages that
// need private/ data or a model show the precomputed demo course instead.
const demoMode = process.env.REWIND_DEMO === "1" || process.env.NODE_ENV === "production" || !!process.env.VERCEL;

// Names this build's offline cache for the demo (public/demo-sw.js), so a new deploy drops the old one.
const buildId = process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? Date.now().toString(36);

// The demo tutor's saved replies must cover every demo question (lib/demo/tutor-coverage.ts); say so at build and start.
{
  const read = (path: string): unknown | null => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  const bundle = read("public/demo/course/course.json");
  const saved = read("public/demo/course/tutor.json");
  for (const warning of bundle ? [coverageWarning(bundle, saved), similarWarning(bundle, saved)] : []) if (warning) console.warn(`[demo tutor] ${warning}`);
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  // No dev badge: it covers the Rewind button on a phone and sits in every screenshot and recording.
  devIndicators: false,
  // The e2e's second dev server (accounts on, playwright.config.ts) builds into its own folder.
  distDir: process.env.REWIND_DIST_DIR || ".next",
  env: { REWIND_BUILD_ID: buildId },
  async redirects() {
    if (!demoMode) return [];
    return [
      { source: "/practice", destination: "/demo/practice", permanent: false },
      { source: "/radar", destination: "/demo/radar", permanent: false },
      { source: "/course/tape", destination: "/demo/tape", permanent: false },
      { source: "/study", destination: "/demo/study", permanent: false },
    ];
  },
  // The demo bundle's course.json is read at build time; keep it beside any server function too.
  outputFileTracingIncludes: { "/demo/**": ["./public/demo/course/course.json"], "/api/demo/**": ["./public/demo/course/course.json"] },
  // Real course data and caches are dev-only; never trace them into a deployed bundle.
  outputFileTracingExcludes: { "*": ["./private/**", "./.cache/**", "./.claude/**", "./.env*"] },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
