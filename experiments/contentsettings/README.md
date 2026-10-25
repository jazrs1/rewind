# contentSettings probe (T10, experiment, Tier 2)

**Not part of the shipped extension.** `contentSettings` changes a browser setting, so this lives in its own top-level folder with its own manifest, outside `extension/` (moved in T13 so loading `extension/` unpacked can never include it). Don't merge it into `extension/manifest.json` until the lead's adversary review and John's approval.

Question: can one click in an extension popup create the "Allowed to use third-party cookies" exception, so the Zoom recording embedded in the Rewind app gets its storage?

## Answer: yes in Chrome for Testing, on a local stand-in

Tested on a stand-in, not real Zoom. With third-party cookies blocked, one click in the popup that runs this call makes the cross-site frame's storage work:

```js
chrome.contentSettings.cookies.set({
  primaryPattern: 'https://ufl.zoom.us/*',      // the embedded site (the cookie's URL)
  secondaryPattern: 'http://localhost:3000/*',  // the top-level site (the Rewind app)
  setting: 'allow'
});
```

The probe in `probe.mjs` tested this in Chrome for Testing (`~/Library/Caches/ms-playwright/chromium-1234`) with `cookie_controls_mode: 1` (block third-party cookies). The top page was on `http://localhost:4100` and the frame on `http://127.0.0.1:4200` (a different site).

| Pattern pair (primary / secondary) | `cookies.get` | Frame: localStorage, cookie, hasStorageAccess |
| --- | --- | --- |
| none (baseline) | block | `SecurityError`, not set, false |
| embedded / top | allow | ok, ok, true |
| `<all_urls>` / top | allow | ok, ok, true |
| embedded / `<all_urls>` | allow | ok, ok, true |
| embedded, no secondary | allow | ok, ok, true |
| **top / embedded (reversed)** | **block** | **SecurityError, not set, false** |
| embedded host / top host, no ports | allow | ok, ok, true |

The results were the same with `--test-third-party-cookie-phaseout`. The narrowest working pair is **embedded / top**; the order matters. Full output is in `evidence/results.json`.

Not shown or not tested:
- The settings screenshots (`evidence/settings-cookies-*.png`) show "Block third-party cookies" selected. The exception list wasn't in the captured area, so they don't show the exception.
- Not tested with the real `ufl.zoom.us` page in a frame (no Zoom login in the test profile). For the real pair, the only evidence is `cookies.get` returning `allow`.
- Not tested in John's regular Chrome, or with enterprise policies that lock cookie settings.
- Not tested whether Chrome shows the exception as "controlled by an extension" or keeps it after the extension is removed.

Run it: `node experiments/contentsettings/probe.mjs`. It needs `node_modules` (playwright-core) and the cached Chrome for Testing, uses a throwaway profile, and writes `evidence/`.
