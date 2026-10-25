// The site's own address. The Chrome extension lets only these origins (plus localhost:3000 for dev) talk to
// its bridge (extension/allowed-origins.js and manifest.json); lib/brand/site.test.ts keeps the two in step.

/** The canonical production URL: the end card, the download page and the privacy page name it. */
export const PRODUCTION_URL = "https://rewindit.org";
/** Every origin the site is served from in production (the www name redirects or serves the same app). */
export const PRODUCTION_ORIGINS = [PRODUCTION_URL, "https://www.rewindit.org"] as const;
/** The dev server's origin, also allowed by the extension. */
export const DEV_ORIGIN = "http://localhost:3000";

/** Where people reach the team about privacy and the extension. Set to John's address once the lead confirms it. */
export const CONTACT_EMAIL: string | null = null;
/** Until then (and as well): the project's public issue tracker. */
export const CONTACT_ISSUES = "https://github.com/jazrs1/rewind-app/issues";
