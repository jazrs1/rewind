# Storage Access API probe (T14, experiment, timeboxed 30 min)

**Not part of the shipped extension.**

Question: instead of changing a browser setting (T10), can the embedded Zoom frame get its cookies through the Storage Access API? Our content script would put a "Play here" button over the frame and call `document.requestStorageAccess()` from its click, then reload the frame.

## Answer: did not work in any variant tested; one path untested

Every variant was tested, in Chrome for Testing (`~/Library/Caches/ms-playwright/chromium-1234`, headless, extension loaded with `--load-extension`, third-party cookies blocked via `cookie_controls_mode: 1`). In all of them, this call made from a real click inside the cross-site frame:

```js
document.requestStorageAccess()   // from the click handler of a button inside the frame
```

was rejected with **`NotAllowedError`**. Before and after, the frame's own request never carried its cookie (`serverSawCookie: false`), `hasStorageAccess()` stayed `false`, and `localStorage` threw `SecurityError`.

Each run did this:
1. Visited the frame's site first-party and clicked there, so it has prior top-level interaction and a `SameSite=None; Secure` session cookie, like logging in to Zoom.
2. Loaded the app page with the frame (`<iframe allow="storage-access">`).
3. Clicked "Play here" inside the frame for real (Playwright input, so a genuine user activation in that frame).
4. On success the frame would reload. Then the app page was loaded again to check for persistence.

| Stand-in | Button | Pre-granted `storage-access` (Playwright) | Result |
| --- | --- | --- | --- |
| `http://localhost:4300` + frame `http://127.0.0.1:4400` | extension content script | none / top origin / frame origin | `NotAllowedError` |
| same | page's own script (main world) | none / top origin / frame origin | `NotAllowedError` |
| `https://app.test:4301` + frame `https://zoom.test:4401` (self-signed, `--ignore-certificate-errors`) | extension content script | none / top origin / frame origin | `NotAllowedError` |
| same | page's own script | none / top origin / frame origin | `NotAllowedError` |

Two other observations:
- A no-gesture `requestStorageAccess()` on each frame load was also rejected.
- The frame's navigation requests carried `Sec-Fetch-Storage-Access: none`.

Full per-step output: `evidence/results.json`.

## Not tested, and why

- **A person clicking "Allow" on Chrome's storage-access prompt.** In headless automation there is no prompt UI. Pre-granting through Playwright's `grantPermissions(['storage-access'])` was accepted but changed nothing. So a headed run where the user approves the prompt is the one path left open. It would need John to try it by hand (load `experiments/storage-access/extension/`, open the stand-in pages, click "Play here", and answer the prompt).
- **Real `ufl.zoom.us`.** Even if access were granted, Zoom's player would need its storage for every request it makes after the reload. That can't be checked without a UF login in the test profile.
- **John's regular Chrome**, enterprise policies, and Related Website Sets.

Compared with T10: there, `chrome.contentSettings.cookies.set` turned the frame's storage on in this same stand-in setup.

Run it: `node experiments/storage-access/probe.mjs`. It needs `node_modules` (playwright-core), `openssl` and the cached Chrome for Testing. It uses throwaway profiles and a throwaway self-signed certificate (deleted afterwards), and writes `evidence/results.json`.
