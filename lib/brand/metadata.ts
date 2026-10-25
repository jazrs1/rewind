// Link previews and titles for every route: the root layout sets the site-wide metadata, and each page
// calls pageMetadata(title) so its og:title and twitter:title match its own title. Next merges metadata
// shallowly (a page's openGraph replaces the layout's whole openGraph), so the image and description
// are repeated here, never left to inheritance.

import type { Metadata } from "next";

type Env = Record<string, string | undefined>;

export const SITE_NAME = "Rewind";
export const DESCRIPTION = "Practice quizzes made in your professor's style. Confused? Rewind to their explanation.";
/** The static link-preview image (scripts/brand/render.mjs). */
export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "Rewind: practice quizzes made in your professor's style" };
export const THEME = "#1E2B30";

/**
 * The absolute base for og:image and other URLs: NEXT_PUBLIC_SITE_URL if set, else the project's
 * production domain on Vercel (VERCEL_PROJECT_PRODUCTION_URL, set at build time), else local dev.
 */
export function siteUrl(env: Env = process.env): URL {
  if (env.NEXT_PUBLIC_SITE_URL) return new URL(env.NEXT_PUBLIC_SITE_URL);
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return new URL(`https://${env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return new URL(`http://localhost:${env.PORT ?? 3000}`);
}

function previews(title: string, description: string): Pick<Metadata, "openGraph" | "twitter"> {
  return {
    openGraph: { type: "website", siteName: SITE_NAME, title, description, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE.url] },
  };
}

/** The root layout's metadata: the base URL, the "%s · Rewind" template, the description and previews. */
export function rootMetadata(env: Env = process.env): Metadata {
  return {
    metadataBase: siteUrl(env),
    title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
    description: DESCRIPTION,
    applicationName: SITE_NAME,
    ...previews(SITE_NAME, DESCRIPTION),
  };
}

/** A page's metadata: "Practice" becomes "Practice · Rewind" in the tab and in its link previews. */
export function pageMetadata(title: string, extra: Metadata = {}): Metadata {
  const full = `${title} · ${SITE_NAME}`;
  return { title, ...previews(full, DESCRIPTION), ...extra };
}

/** Every demo route: "Demo · Rewind". */
export const demoMetadata = (extra: Metadata = {}): Metadata => pageMetadata("Demo", extra);
