"use client";

// Keeps the demo course working offline after the first visit: registers public/demo-sw.js for the
// demo pages only (scope /demo/), versioned by the build, then hands it an explicit list: this page,
// the scripts, styles and fonts the document itself names under /_next/static/, and the bundle's clip
// and slides. Sets data-demo-offline on <html> to "ready" once all of it is cached, or "partial" when
// something couldn't be (logged with what and why). The e2e test waits for "ready".

import { useEffect } from "react";

/** The built assets this document names in its own tags (not whatever else the page happened to fetch). */
function documentAssets(): string[] {
  const urls: string[] = [];
  for (const s of document.querySelectorAll<HTMLScriptElement>("script[src]")) urls.push(s.src);
  for (const l of document.querySelectorAll<HTMLLinkElement>("link[href][rel~=stylesheet], link[href][rel~=preload]")) urls.push(l.href);
  return urls.filter((u) => new URL(u).pathname.startsWith("/_next/static/"));
}

type Report = { cached: string[]; failed: string[]; skipped: string[] };

export function DemoOffline({ assets }: { assets: string[] }) {
  const key = assets.join("\n");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    let cancelled = false;
    (async () => {
      const version = encodeURIComponent(process.env.REWIND_BUILD_ID ?? "dev");
      const reg = await navigator.serviceWorker.register(`/demo-sw.js?v=${version}`, { scope: "/demo/", type: "module" });
      // A new build's worker: wait until it replaces the old one, so the files land in this build's cache.
      const next = reg.installing ?? reg.waiting;
      if (next) {
        await new Promise<void>((resolve) => {
          const done = () => (next.state === "activated" || next.state === "redundant") && resolve();
          next.addEventListener("statechange", done);
          done();
        });
      }
      if (cancelled || !reg.active) return;
      const urls = [location.pathname, ...key.split("\n").filter(Boolean), ...documentAssets()];
      const channel = new MessageChannel();
      channel.port1.onmessage = (e: MessageEvent<Report>) => {
        if (cancelled || !e.data || !Array.isArray(e.data.failed)) return;
        document.documentElement.dataset.demoOffline = e.data.failed.length ? "partial" : "ready";
        if (e.data.failed.length) console.warn("Demo offline: not cached:", e.data.failed.join("; "));
      };
      reg.active.postMessage({ type: "cache", urls }, [channel.port2]);
    })().catch(() => {
      // No service worker (private window, blocked): the demo still works online.
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return null;
}
