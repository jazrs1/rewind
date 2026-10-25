# Rewind importer (Chrome extension)

Exports a Canvas course you can already see into `<course_code>.course.json` (format in `AGENT_TASKS.md`, "Course export JSON"). Plain JavaScript, Manifest V3, no build step.

It fetches the Canvas API from inside your logged-in `ufl.instructure.com` tab with `credentials: 'include'`, so it uses your own session. It never reads, stores or sends cookies or tokens, and it only talks to `ufl.instructure.com`.


> After updating the extension, click Reload in chrome://extensions AND reload any open Canvas tab; an open tab keeps the old script.
## Layout

- `manifest.json`: MV3 manifest. Content scripts on Canvas and Zoom recordings, a background service worker, and `externally_connectable` for the app.
- `background.js` + `bridge.js`: the app-to-extension router (T4). The router is a plain function that takes the `chrome` APIs, so it can be tested.
- `canvas/canvas-api.js`: pagination (`Link: rel="next"`), `while(1);` stripping, error recording, the export itself.
- `canvas/content.js`: answers the popup, runs the export, downloads the file.
- `popup/`: course picker, Export button, progress line, result summary.
- `test/pagination.test.js`: unit tests with a fake `fetch`.
- `test/bridge.test.js`: router tests with fake `chrome.tabs`.
- `zoom/transcript.js`: Zoom transcript parsing. Every DOM selector is in its `SELECTORS` object.
- `zoom/player.js`: controls the Zoom page's own `<audio>`/`<video>` (play, pause, rate, seek) and reports its state. It reads only `currentTime`, `paused`, `playbackRate` and `duration`.
- `zoom/content.js`: the in-page "Rewind: export transcript" button, and the wiring between the bridge and `player.js`.
- `zoom/embed.js`: embed mode for a recording shown in an iframe inside the app (T9). It hides Zoom's own UI and makes the media fill the frame.
- `zoom/test/`: `parse.test.js`, `player.test.js` (fake media element), `embed.test.js` (embed mode on the fake DOM), plus `mini-dom.js`, a tiny HTML parser so the real selectors run in Node with no packages.

## Load it unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension/` folder.
4. Pin "Rewind importer" from the puzzle-piece menu.
5. Open or **reload** a `https://ufl.instructure.com` tab and log in. (Tabs opened before the extension was loaded need a reload.)
6. Click the Rewind icon, pick a course, click **Export**. The progress line shows each step ("Pages 12 of 40"). The file lands in Downloads. You can close the popup while it runs.

Keep exported files in `private/`. They hold real course content and grades and must never be committed.

## Run the tests

```sh
node extension/test/pagination.test.js
node extension/test/bridge.test.js
node extension/zoom/test/parse.test.js   # also checks private/fixtures/zoom-recording.html if present
node extension/zoom/test/player.test.js
node extension/zoom/test/embed.test.js
for f in $(find extension -name '*.js'); do node --check "$f"; done
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8'))"
```

## Test checklist for John

- [ ] The popup lists your active courses, and COP3530 and MAS3114 are both there.
- [ ] On a non-Canvas tab, the popup says to open ufl.instructure.com.
- [ ] **COP3530**: export finishes and downloads `COP3530….course.json`.
  - [ ] `files` has 50 or more entries. If Canvas showed more than 100 files, this confirms that pagination across pages worked.
  - [ ] `modules`, `pages` (each with a `body`), `assignments`, `announcements` (the "Action Items Week N" posts) and `submissions` are filled.
  - [ ] `errors` is empty, or lists only endpoints you expect to fail.
- [ ] **MAS3114**: export finishes.
  - [ ] `errors` contains `{ "endpoint": "/api/v1/courses/<id>/files", "status": 401 }`.
  - [ ] `modules` (with `items`) and `pages` are present and not empty.
- [ ] Quick count check: `node -e "const c=require('./private/COP3530.course.json');console.log(c.files.length,c.modules.length,c.pages.length,c.errors)"` (adjust the filename).
- [ ] The DevTools Network tab for the Canvas tab shows only `ufl.instructure.com/api/v1/...` requests from the export.

### Re-export after T12 (announcements since course start, module items one by one)

> Note: fetching pages and files through the API may count as page views in Canvas. It can mark module "must view" requirements as done and shows up in instructor analytics.

Reload the extension, reload the Canvas tab, then re-export both courses into `private/`:

- [ ] **COP3530**: `announcements` has about 10 or more "Action Items" posts (it was 3). `announcementsRange` shows the start date and where it came from (`course`, `term` or `fallback`).
- [ ] **MAS3114**: `pages` and `files` are no longer 0, even though `errors` still lists `/files` (403) and `/pages` (404). They now come from the module items and from file links inside those pages.
- [ ] Any item that failed is listed in `errors` as `/api/v1/courses/<id>/pages/<slug>` or `/files/<id>`; the rest exported.
- [ ] Counts: `node -e "const c=require('./private/MAS3114.course.json');console.log(c.files.length,c.pages.length,c.announcements.length,c.announcementsRange,c.errors.length)"` (adjust the filename).

How it works: the course request adds `include[]=term`. Announcements are requested from `start_date` to `end_date`. The start is 30 days before the course's `start_at`, else the term's, else `2026-08-01`, taken as the calendar date in America/New_York; both the base and the shifted start are in `announcementsRange`. The end is tomorrow (local date). After the list endpoints, every module item of type `Page` or `File` is fetched by itself unless a list already returned it, at most 4 at a time. Same-course `/courses/<id>/files/<fileId>` links inside page bodies are fetched too. Everything is merged into `pages` and `files` as raw Canvas objects. One-by-one fetches are capped at 1000 per export. They also stop early when Canvas signals a rate limit (a 403 "Rate Limit Exceeded", or `X-Rate-Limit-Remaining` below 50). Anything left out is reported as one `errors` row `{ endpoint: "module-items", status: null, skipped: N }`, with `rateLimited: true` when the rate limit was the cause.

## Zoom transcripts (T2)

On a `https://ufl.zoom.us/rec/...` recording page, open the **Audio Transcript** tab, then click the orange **Rewind: export transcript** button (bottom right). It downloads `<title>_<date>.transcript.json`:

- `segments`: one per page transcript item. Its start is the item's real time, taken from the visible label or the item's `aria-label`. An item longer than 20 s is split into sentences by the shared splitting rule in `AGENT_TASKS.md` (same as `splitChunk` in `lib/transcript.ts`). The first piece keeps the real start; later pieces are placed by character position and marked `"estimated": true`. Each item ends at the next item's start, and the last ends at the media duration.
- `chunks`: the page's own items, unsplit. Present only if some item was split.
- `recordedAt`: UTC, from the `GMT20261022-174809` stamp in the audio URL. Without one, it falls back to the header date as page-local time with no zone.
- `recordingUrl`: origin and path only, with no query string.

The page was saved with the panel fully in the DOM (not virtualized): 795 items over 1:41:21.

Inside the extension, the bridge sends the tab `rewind:status`, `rewind:play`, `rewind:pause`, `rewind:rate` and `rewind:seek`, and the tab sends back `rewind:state` (see "App bridge"). Seek: `{ type: 'rewind:seek', seconds }` sets `currentTime` on the page's `audio, video`, or clicks the closest transcript item if there is no media element. The seek is held until the media has loaded its metadata, re-applied if Zoom replaces the element, and confirmed by reading `currentTime` back (within 1 s); it retries for about 3 s. The reply is `{ ok: true, method: 'media' | 'transcript-click', state }` or `{ ok: false, error: 'seek-failed', state }`. `{ type: 'rewind:play', seconds }` seeks and confirms first, then plays. `{ type: 'rewind:zoomTranscript' }` replies with `{ ok, transcript, filename }`.

### Test checklist for John (Zoom)

- [ ] Reload the extension in `chrome://extensions`, then open a UF Zoom recording.
- [ ] The orange button appears. With the Audio Transcript tab open, click it. It says "Saved N segments" and a `.transcript.json` downloads. Move it into `private/`.
- [ ] Spot-check 3 chunks in the file against the panel: speaker, time and text.
- [ ] Seek: with the Zoom recording open, run the snippet in "Test checklist (bridge)" below with `type: 'seek'` and `seconds: 600`. The player jumps to 10:00. Close the Zoom tab and run it again: a new tab opens and jumps to 10:00 once the player loads.
- [ ] Radar: `node scripts/radar/scan.mjs --speaker Kapoor private/*.transcript.json > private/radar.json`

## App bridge (T4)

The web app talks to the extension with `chrome.runtime.sendMessage(EXTENSION_ID, msg)` for requests, and `chrome.runtime.connect(EXTENSION_ID)` for playback state events. Pages may use these only from the origins in `externally_connectable` in `manifest.json`:

- `http://localhost:3000/*` (dev)
- `https://rewindit.org/*` and `https://www.rewindit.org/*` (the site)

No `*.vercel.app` origin is listed, ever (the lead removed an unregistered placeholder on Oct 23: anyone who registered that name would have reached the bridge, Canvas export included). Chrome rejects calls from any origin not listed.

### Allowed origins (T13)

Two independent checks guard the bridge, so a mistake in one doesn't open it:

1. **Chrome:** `externally_connectable.matches` in `manifest.json`.
2. **Code:** `ALLOWED_APP_ORIGINS` in `allowed-origins.js`, loaded by the service worker before `bridge.js`.
   - `route()` and `connect` take the caller's origin from `sender.origin` whenever that field is a string (so an opaque `"null"` is refused, never replaced by `sender.url`), fall back to `sender.url` only when the field is missing, and require an exact match with an entry: same scheme, host and port, with no prefixes or subdomains.
   - Anything else gets `{ ok: false, error: 'origin' }`, and a port is sent that error and closed.
   - `http://localhost:3001`, `http://localhost.evil.com:3000`, `https://localhost:3000`, an opaque origin and a missing origin are all refused.

To change an origin, edit the bare origin in `ALLOWED_APP_ORIGINS` **and** `<origin>/*` in `externally_connectable.matches`, then reload the extension. `test/bridge.test.js` fails if the manifest lists anything outside `ALLOWED_APP_ORIGINS`, or ever contains a wildcard host or a `*.vercel.app` pattern. `lib/brand/site.test.ts` fails unless the list is exactly localhost:3000 plus the site's own origins (`PRODUCTION_ORIGINS` in `lib/brand/site.ts`).

### Player model

**Update (T9):** with the app's origin under "Allowed to use third-party cookies", a recording does load and play inside an iframe. That embedded player is now the primary source (see "Embedded player (T9)" below). The background tab described here is the fallback.

Without that setting, Zoom can't be embedded in an iframe (Chrome blocks Zoom's storage inside another site). So **Rewind's page is the player UI and a background Zoom tab is the audio source.**

1. The app sends `open`. The extension finds the recording's tab or opens it **in the background**.
2. Chrome only lets a tab start playing on its own after the user has clicked in it once. If `open` replies `needsGesture: true`, the app asks John to switch to the Zoom tab and click play once. `open` with `focus: true` brings the tab to the front for that.
3. After that, `play`, `pause`, `rate` and `seek` work while the Zoom tab stays in the background.
4. The tab reports `state` events (current time, paused, rate, duration) on every change and about 4 times a second while playing. The app draws its counter, reels and transcript highlight from them.

The extension never reads cookies, tokens or the media stream. It touches only `currentTime`, `paused`, `playbackRate` and `duration` on the Zoom page's own media element, plus `play()` and `pause()`.

### Finding the extension ID

`manifest.json` carries a public `key`, so every unpacked install of this folder (and of the zip from `/extension`) gets the same ID: **`obplkjkoolikmejjcmkbbmcjhpcpbppp`** (`PINNED_EXTENSION_ID` in `lib/extension.ts`; a test checks that the key derives it). The site talks to the IDs in `NEXT_PUBLIC_REWIND_EXTENSION_IDS` (comma-separated), which defaults to the pinned one, so nothing needs setting. Add the Chrome Web Store version's ID there if it differs. The private key is not in the repo: it's kept outside the repo by the maintainer.rewind\rewind-extension-key.pem`. Don't commit it.

```js
// In the app (browser). window.chrome.runtime exists only if an installed extension lists this origin.
const ID = 'obplkjkoolikmejjcmkbbmcjhpcpbppp'; // the pinned ID (lib/extension.ts)

function callExtension(msg) {
  return new Promise((resolve) => {
    if (!window.chrome?.runtime?.sendMessage) return resolve({ ok: false, error: 'Rewind extension not installed' });
    chrome.runtime.sendMessage(ID, msg, (reply) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(reply);
    });
  });
}

// State events. Reconnect on disconnect: the service worker can restart.
function watchPlayer(onState) {
  const port = chrome.runtime.connect(ID);
  port.onMessage.addListener((e) => { if (e.type === 'state') onState(e); });
  port.onDisconnect.addListener(() => setTimeout(() => watchPlayer(onState), 1000));
  return port;
}

await callExtension({ type: 'ping' }); // { ok: true, version: '0.1.0' }
```

A wrong ID, or an extension that isn't installed, shows up as `chrome.runtime.lastError` ("Could not establish connection…"), not as a reply.

### Messages

Every reply is `{ ok: true, ... }` or `{ ok: false, error: string }`. Fields are checked before any tab is touched. `recordingUrl` must start with `https://ufl.zoom.us/rec/`; its query string is ignored when matching tabs.

| Request | Success reply | Errors |
| --- | --- | --- |
| `{ type: 'ping' }` | `{ ok: true, version }` | none |
| `{ type: 'status', recordingUrl }` | `{ ok: true, tabId, needsGesture, state }`. The app polls this (T7). It never opens a tab | **`'no-tab'`** if that recording isn't open; tab without the content script |
| `{ type: 'open', recordingUrl, focus? }`, where `focus` defaults to `false` | `{ ok: true, needsGesture, tabId, opened, state }`. `needsGesture` is true for a tab just opened, or one the user hasn't clicked in yet | new tab did not finish loading (30 s); tab without the content script (reload it) |
| `{ type: 'play', recordingUrl?, seconds?, background? }` | `{ ok: true, tabId, opened, state }`. With `recordingUrl`, it opens the tab if needed (in the background unless `background: false`), seeks to `seconds` if given, then plays | **`'needs-gesture'`** when Chrome rejects `play()` (returned at once, not retried); `'no-tab'`; no media element yet |
| `{ type: 'pause', recordingUrl? }` | `{ ok: true, tabId, state }` | `'no-tab'`; no media element yet |
| `{ type: 'rate', value, recordingUrl? }`, where `value` is from 0.5 to 2 | `{ ok: true, tabId, state }` | as for pause |
| `{ type: 'seek', recordingUrl, seconds, background? }`, where `seconds` is a number ≥ 0 | `{ ok: true, tabId, opened, method, seconds, state }`: `method` is `'media'` or `'transcript-click'`. It opens the tab if needed; in the background unless `background: false`, which also focuses an open tab | new tab did not finish loading; the seek failed in the tab |
| `{ type: 'focus', recordingUrl }` | `{ ok: true, tabId }`: brings the Zoom tab and its window forward so the student can click play once after `needs-gesture` | `'no-tab'` |
| `{ type: 'transcripts' }` | `{ ok: true, transcripts }`: the transcripts the student exported with "Rewind: export transcript" (newest first, one per recording, at most 40), each cleaned to `{ source, recordingUrl, title, recordedAt, durationSec, segments: [{ start, end, speaker, text }] }`. Quick build's "Add lecture recordings" step counts them. The Zoom content script hands each export to the service worker (`rewind:transcript-exported`, accepted only from a Zoom recording frame for its own recording), which keeps it in the extension's own IndexedDB: no new permission. The app can't start an export | none |
| anything else | | `Unknown type: …` or a field error |

`state` is always `{ currentTime, paused, rate, duration }` in seconds. `duration` is `null` until the media knows it, and `state` itself is `null` before the media element exists.

The app can follow playback either way: **poll `status`** (T7's plan: about 4/s while playing, 1/s paused) or **listen on a port** for pushed state events. Both read the same fields.

**State event**, posted on every port from `chrome.runtime.connect(ID)`:

```js
{ type: 'state', currentTime: 612.25, paused: false, rate: 1.5, duration: 6081, tabId: 123, recordingUrl: 'https://ufl.zoom.us/rec/play/...' }
```

- It is sent on play, pause, seek, rate or duration change, and about every 250 ms while playing. (Zoom's `timeupdate` drives it, so the background tab's throttled timers don't matter.)
- `duration` is `null` until the media knows it.
- After an `open` or `seek`, only that tab's events are forwarded. Before either, every Zoom recording tab's events are forwarded, labeled with `tabId` and `recordingUrl`.

Notes:
- **Which tab:** `play`, `pause` and `rate` go to the tab for `recordingUrl` if given. Otherwise they go to the tab from the last `open` or `seek`, or else the only open Zoom recording tab. With none, or several and no current tab, the reply says to send `open`. The extension forgets the current tab if its service worker restarts, so passing `recordingUrl` is safest.
- **No export over the bridge:** the Canvas export runs only from the popup. A page can't ask for it (an `export` message is `Unknown type`), so no page ever receives a course export.
- Nothing steals focus unless asked: `open` with `focus: true`, `play`/`seek` with `background: false`, or `focus`. (Before this change, `seek` brought the Zoom tab to the front.)

### Test checklist (bridge)

- [ ] Reload the extension, run the app on `localhost:3000`, and set `NEXT_PUBLIC_REWIND_EXTENSION_ID`.
- [ ] In the app's DevTools console, paste `ID`, `callExtension` and `watchPlayer` from above. Then:
  - [ ] `await callExtension({ type: 'ping' })` returns `{ ok: true, version: '0.1.0' }`.
  - [ ] `watchPlayer(console.log)`.
  - [ ] `const rec = '<a ufl.zoom.us/rec/play/... URL>'` then `await callExtension({ type: 'open', recordingUrl: rec })`. A Zoom tab opens **in the background**, and the reply has `needsGesture: true`.
  - [ ] `await callExtension({ type: 'play' })` before clicking anything gives `{ ok: false, error: 'needs-gesture' }`. If it plays instead, note it: Chrome allowed it.
  - [ ] `await callExtension({ type: 'focus', recordingUrl: rec })` brings the Zoom tab forward. Click play once, pause it, and come back to the app tab. `open` again: `needsGesture: false`.
  - [ ] T7 path: `await callExtension({ type: 'play', recordingUrl: rec, seconds: 600, background: true })` plays from 10:00 while the app tab stays in front. `await callExtension({ type: 'status', recordingUrl: rec })` shows `currentTime` moving.
  - [ ] `play`, then `seek` with `seconds: 600`, then `rate` with `value: 1.5` (allowed: 0.5 to 2), then `pause`. You hear each change while the app tab stays in front. `state` lines print about 4 a second while playing, show `currentTime` near 600 after the seek and `rate: 1.5`, and stop when paused.
  - [ ] `await callExtension({ type: 'nope' })` gives `Unknown type: "nope"`.

## Embedded player (T9, zoom-embed)

With `http://localhost:3000` under chrome://settings/cookies → "Allowed to use third-party cookies", a `ufl.zoom.us/rec/play/...` recording loads and plays inside an iframe in the app. The app (`lib/player/zoom-embed.ts`) drives that frame through the extension. The background-tab path above (`zoom-remote`) is the fallback.

How the extension finds the frame, with no new permissions:

1. The Zoom content scripts also run inside frames (`"all_frames": true` on the `https://ufl.zoom.us/rec/*` entry).
2. Inside a frame, once the page's media element exists, the content script sends `{ type: 'rewind:frame-ready', recordingUrl }`, and again every 5 s, because the service worker keeps the list in memory and may restart.
3. The bridge registers `(tabId, frameId)` from the message's **sender**, and only for a subframe whose own URL starts with `https://ufl.zoom.us/rec/`. The recording is taken from the frame's real URL, not the message.
4. The frame is forgotten on `pagehide` (`rewind:frame-gone`), when its tab closes, or when a send to it fails.

App → extension (`chrome.runtime.sendMessage(ID, msg)`). This is the same as T7 plus `embed: true`, and `recordingUrl` is required. The target is the Zoom frame inside **the sender's own tab** whose recording path matches; with two such frames, the most recently loaded wins. A frame in any other tab is never reachable.

| Request | Reply |
| --- | --- |
| `{ type: 'status', recordingUrl, embed: true }` | `{ ok: true, state, media, needsGesture }`, or `{ ok: false, error: 'no-frame' }` when no Zoom frame with a ready player is in the sender's tab |
| `{ type: 'play', recordingUrl, embed: true, seconds? }` | `{ ok: true, state }`. With `seconds` it seeks first. `{ ok: false, error: 'needs-gesture' }` if Chrome blocks `play()` |
| `{ type: 'pause', recordingUrl, embed: true }` | `{ ok: true, state }` |
| `{ type: 'seek', recordingUrl, embed: true, seconds }` | `{ ok: true, state }` |
| `{ type: 'rate', recordingUrl, embed: true, value }`, where `value` is from 0.5 to 2 | `{ ok: true, state }` |
| `{ type: 'embedMode', recordingUrl, embed: true, on }` | `{ ok: true }`. `on: true` hides Zoom's own UI (title bar, controls, transcript panel, our export button) and makes the media fill the frame (video: `object-fit: contain` on black). `on: false` restores the page. |

- `state` is `{ currentTime, paused, rate, duration }` (`duration` is null until known).
- `media` is `{ kind: 'video' | 'audio', videoWidth, videoHeight }`. The sizes are null for audio, or before the video's metadata loads.
- Only these numbers and booleans ever leave the Zoom frame; the bridge rebuilds every reply from them.
- `embed: true` with `open` or `focus` is rejected. Embedded requests never open or focus tabs.

Embed mode works by putting one class on `<html>` and one on the media element, plus one `<style>`. That style hides `body` with `visibility: hidden` and shows only the media element, fixed to fill the frame. It relies on no Zoom selector other than `audio, video`, so changes to Zoom's own layout don't break it. Untested in a real browser: whether an ancestor of Zoom's `<video>` uses a CSS `transform`, which would stop `position: fixed` from filling the frame.

### Test checklist for John (embed)

- [ ] Reload the extension in `chrome://extensions`; `all_frames` only applies after a reload. Keep `localhost:3000` under "Allowed to use third-party cookies".
- [ ] Run the app, open `/practice`, and miss a question. The clip plays in the embedded frame, starting at the cited moment.
- [ ] In the app's DevTools console (with `ID` and `callExtension` from above), and `rec` set to the embedded recording's URL:
  - [ ] `await callExtension({ type: 'status', recordingUrl: rec, embed: true })` shows `media.kind` and `state.currentTime` moving while it plays.
  - [ ] `embedMode` with `on: true`: only the video (or black, for an audio-only recording) fills the frame; no Zoom header, controls or transcript. `on: false` brings Zoom's page back.
  - [ ] `pause`, `seek` with `seconds: 600`, `rate` with `value: 1.5`, then `play`: each takes effect in the frame.
  - [ ] Remove the frame (navigate away in the app), then `status` gives `{ ok: false, error: 'no-frame' }`.
  - [ ] From a second app tab with no frame, `status` gives `no-frame` (frames in other tabs are unreachable).
