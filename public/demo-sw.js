// The demo course offline: after the first visit, the demo pages, their scripts, styles and fonts,
// and the demo bundle's clip and slides load with the network off. Registered by
// components/demo/DemoOffline.tsx with scope /demo/, so it only ever controls the demo pages, and
// it only caches what demo-sw-policy.js allows (never the dev routes or anything from private/).
// Network first: online, everything is fresh; offline, it comes from the cache.

import { byteRange, CACHE_PREFIX, cacheName, kindOf } from "./demo-sw-policy.js";

const origin = self.location.origin;
/** One cache per build (registered as /demo-sw.js?v=<build id>); activate deletes the older builds' caches. */
const CACHE = cacheName(new URL(self.location.href).searchParams.get("v"));

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

/**
 * The page sends its explicit list (itself, its own scripts and styles, the bundle's files); keep those that
 * are ours. Answers { cached, failed, skipped }: what is now in the cache, what couldn't be fetched or stored,
 * and what the policy refused.
 */
self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache" || !Array.isArray(event.data.urls)) return;
  const port = event.ports[0];
  event.waitUntil(
    precache(event.data.urls).then(
      (report) => port?.postMessage(report),
      (err) => port?.postMessage({ cached: [], failed: [`cache: ${err?.message ?? err}`], skipped: [] }),
    ),
  );
});

/** A cache key: the URL alone, so a request's headers never pick a different entry. */
const keyOf = (url) => {
  const u = new URL(url);
  u.hash = "";
  return u.href;
};

/** A response worth keeping: a whole file from this origin, not a redirect's destination. */
const keepable = (res) => res.status === 200 && res.type === "basic" && !res.redirected;

async function precache(urls) {
  const cache = await caches.open(CACHE);
  const report = { cached: [], failed: [], skipped: [] };
  await Promise.all(
    [...new Set(urls.filter((u) => typeof u === "string"))].map(async (raw) => {
      let url;
      try {
        url = new URL(raw, origin);
      } catch {
        report.skipped.push(raw);
        return;
      }
      if (!kindOf(url, origin)) {
        report.skipped.push(raw);
        return;
      }
      try {
        const res = await fetch(url.href, { credentials: "same-origin" });
        if (!keepable(res)) {
          report.failed.push(`${url.pathname}: ${res.redirected ? "redirected" : res.status}`);
          return;
        }
        await cache.put(keyOf(url.href), res);
        report.cached.push(url.pathname + url.search);
      } catch (err) {
        // Offline already, or the cache is full: whatever is cached stays.
        report.failed.push(`${url.pathname}: ${err?.message ?? err}`);
      }
    }),
  );
  return report;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("rsc") || req.headers.has("next-router-prefetch")) return;
  const url = new URL(req.url);
  if (!kindOf(url, origin)) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const key = keyOf(req.url);
  const range = req.headers.get("range");
  try {
    const res = await fetch(req);
    // Whole files only: a partial (206) answer to a media range request can't be cached.
    if (!range && keepable(res)) void cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (!hit) throw err;
    return range ? slice(hit, range) : hit;
  }
}

/** A cached whole file, cut to the bytes a media element's Range request asks for. */
async function slice(res, header) {
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const r = byteRange(header, size);
  if (!r) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(buf.slice(r.start, r.end + 1), {
    status: 206,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Range": `bytes ${r.start}-${r.end}/${size}`,
      "Content-Length": String(r.end - r.start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}
