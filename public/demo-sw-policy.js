// What the demo's service worker (public/demo-sw.js) may keep for offline use. Plain ES module so the
// worker can import it as is and lib/demo/offline.test.ts can test it. Only three kinds of request:
// - "page": the demo pages themselves (/demo, /demo/...), which show the precomputed demo bundle only;
// - "static": Next's built assets (/_next/static/...): scripts, styles, fonts;
// - "asset": a file in a demo bundle folder under public/ (/demo/..., /demo-kapoor/...): the clip, slide images;
//   and the header's mark (/brand/rewind-mark.svg), that one file only.
// An allowlist: every other path, in any letter case (/api, /API, /private, /Practice, the dev routes, RSC
// data), is never cached. A bundle folder whose name doesn't start with "demo" works online only.

/** Every cache this worker makes starts with this; demo-sw.js adds the build's version and deletes the rest. */
export const CACHE_PREFIX = "rewind-demo-";

/**
 * This build's cache: the prefix and the version the page registered the worker with (?v=, the build id).
 * @param {string | null} version
 * @returns {string}
 */
export function cacheName(version) {
  const v = (version ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return CACHE_PREFIX + (v || "dev");
}

const PAGE =/^\/demo(?:\/|$)/;
/** Brand files the demo pages show (components/brand/Wordmark.tsx). */
const BRAND = new Set(["/brand/rewind-mark.svg"]);
const ASSET = /^\/demo[A-Za-z0-9_-]*\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:mp3|m4a|mp4|webm|svg|png|jpe?g|webp|json)$/;

/**
 * "page", "static", "asset" or null (not ours to cache) for a URL requested from `origin`.
 * @param {URL} url
 * @param {string} origin
 * @returns {"page" | "static" | "asset" | null}
 */
export function kindOf(url, origin) {
  if (url.origin !== origin) return null;
  const path = url.pathname;
  if (path.includes("..") || path.includes("//")) return null;
  // Built assets may carry a version query; nothing else does (a query could be RSC data or a dev switch).
  if (path.startsWith("/_next/static/")) return "static";
  if (url.search) return null;
  if (PAGE.test(path)) return "page";
  return ASSET.test(path) || BRAND.has(path) ? "asset" : null;
}

/**
 * The bytes a Range header asks for, inclusive, or null when it can't be served from `size` bytes.
 * Handles one range: "bytes=a-b", "bytes=a-" and "bytes=-n" (the last n).
 * @param {string} header
 * @param {number} size
 * @returns {{ start: number; end: number } | null}
 */
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "") || size <= 0) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n > 0 ? { start: Math.max(0, size - n), end: size - 1 } : null;
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end && start < size ? { start, end } : null;
}
