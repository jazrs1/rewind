# Chrome Web Store listing: Rewind

This is the copy for the store form, matched to `extension/manifest.json` as of this commit. The screenshots are in
`docs/brand/store/` (1280 x 800). Re-render them with `node scripts/brand/store-screens.mjs`. The icons are
`extension/icons/icon-128.png` and the rest of that folder (`scripts/brand/render.mjs`).

- **Name:** Rewind importer (the manifest's `name`)
- **Category:** Education
- **Language:** English
- **Homepage:** https://rewindit.org
- **Privacy policy:** https://rewindit.org/privacy
- **Support:** https://rewindit.org/extension. The contact email is still to come: the lead is confirming John's address.

## Single purpose

Rewind importer brings a student's own Canvas course and lecture transcripts into Rewind, a practice app, and plays
the lecture moment Rewind points to when the student misses a question.

## Short description (132 characters at most)

> Export your own Canvas course and lecture transcripts to Rewind, and replay the moment your professor explained what you missed.

(128 characters.)

## Long description

> Rewind turns your course into practice in your professor's style. Miss a question, and Rewind plays the moment
> they explained it in lecture.
>
> This extension is how your own course gets into Rewind:
>
> • **Export a Canvas course.** Open ufl.instructure.com, click the Rewind icon, pick one of your courses and click
>   Export. The modules, pages, files, assignments and announcements you can already see are saved to one
>   .course.json file in your Downloads folder. It uses your own Canvas sign-in and never reads your password,
>   cookies or tokens.
> • **Export a lecture transcript.** On a UF Zoom recording you can open, click "Rewind: export transcript" to save
>   its transcript as a file.
> • **Replay the moment.** When you miss a question on rewindit.org, Rewind can start the lecture recording at the
>   cited second. The extension only plays, pauses, seeks and sets the speed of the recording you already have open.
>
> Your course content stays on your computer: the extension saves files to your Downloads folder and sends them
> nowhere. Only rewindit.org can talk to the extension, and no page can ask it for a course export.
>
> You don't need the extension for the demo at rewindit.org: it runs on a real UF course, used with permission, with nothing to install.
>
> Privacy: https://rewindit.org/privacy

## Why each permission

The manifest asks for no API permissions (`permissions` is empty). It downloads files through an ordinary link in
the page, not the `downloads` API, and it reads tab addresses only on the hosts below.

| Manifest entry | Why |
| --- | --- |
| Host permission `https://ufl.instructure.com/*` | To read the courses, modules, pages, files, assignments and announcements the student can already see, through the Canvas API with their own sign-in, when they click Export. |
| Host permission `https://ufl.zoom.us/*` | To find the student's open UF Zoom recording tab, so Rewind can play the lecture moment the student asks for. |
| Content script on `https://ufl.instructure.com/*` (`canvas/canvas-api.js`, `canvas/content.js`) | Runs the export inside the student's own Canvas tab, so the requests use their session, and saves the result as a file. |
| Content script on `https://ufl.zoom.us/rec/*`, in all frames (`zoom/*.js`) | Adds the "export transcript" button and plays, pauses, seeks or sets the speed of that recording when the student asks. It runs in frames too, for a recording shown inside rewindit.org. |
| `background` service worker (`background.js`) | Passes play, pause and seek requests from rewindit.org to the student's Zoom recording, and passes back the time and play state. |
| `externally_connectable`: `https://rewindit.org/*`, `https://www.rewindit.org/*` | Lets only Rewind's site send those playback requests. The code checks the exact sender origin a second time. |
| `externally_connectable`: `http://localhost:3000/*` | Rewind's local development server, on the developer's own computer. |
| `action` (popup) | The course picker and the Export button. |

## Privacy practices (store form)

**Single purpose:** as above.

**Permission justifications:** as in the table above. For the host permission field, combined:
"Reads the student's own Canvas course (ufl.instructure.com) through their own sign-in when they click Export, and
controls playback of their own UF Zoom recording (ufl.zoom.us) when they ask Rewind to replay a lecture moment."

**Remote code:** No. All of the extension's code is in the package. It loads no remote scripts, no `eval`, and
no WebAssembly.

**Data usage.** What the extension collects, meaning sends off the student's device to the developer:

| Category | Collected? | Notes |
| --- | --- | --- |
| Personally identifiable information | No | |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | No | It never reads passwords, cookies or tokens. |
| Personal communications | No | |
| Location | No | |
| Web history | No | |
| User activity | No | Playback time and play state go only to the rewindit.org page open in the student's own browser. They aren't stored or sent to Rewind's server. |
| Website content | No | Canvas course content and Zoom transcripts are saved to files on the student's computer and sent nowhere. |

**Certify (all three):**
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://rewindit.org/privacy

## Screenshots

| File | Shows |
| --- | --- |
| `docs/brand/store/1-popup.png` | The popup on a Canvas tab, listing courses to pick from (invented courses). |
| `docs/brand/store/2-import.png` | A finished import: "Downloaded COP3530.course.json" and what it held (invented counts). |

The popup in both is the real `extension/popup/` code, run with a fake `chrome` API, so it matches the shipped UI.

## Before submitting

- **Contact email:** add John's email to the store's developer account, and set `CONTACT_EMAIL` in
  `lib/brand/site.ts` so `/privacy` shows it.
- **Extension ID:** the zip from `/extension` pins its ID with a public `key` in `manifest.json`, so every unpacked
  install gets `obplkjkoolikmejjcmkbbmcjhpcpbppp`, and rewindit.org reaches it by default (`lib/extension.ts`). The
  private key that matches it is NOT in the repo: it's kept outside the repo by the maintainer. Keep it safe and never commit it. The store may give the listing a
  different ID. If so, add it to `NEXT_PUBLIC_REWIND_EXTENSION_IDS` on Vercel, comma-separated after the pinned one, and
  the site will try both.
- **The package:** upload the same files as the download, `/extension/rewind-extension.zip`, built from
  `extension/` by `lib/extension-package.ts` (only the files the manifest loads, never tests, docs, keys or source
  maps). The store wants the files at the zip's root, so zip the inside of the `rewind-extension/` folder.
