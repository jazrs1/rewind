# Rewind

Practice for your real course, in your professor's own words. Rewind turns a course's slides, pages and lecture recordings into practice questions. Each question carries the exact words it comes from. When you miss one, Rewind plays the lecture from the moment your professor explains it.

**Live:** [rewindit.org](https://rewindit.org). Try the demo course (no login), or import your own course with Quick build (beta).

The demo course's lecture materials aren't included; they're used on the live site with Professor Kapoor's permission.

## Run it locally

```bash
npm i
npm run dev        # http://localhost:3000
npm test           # unit tests (vitest)
npx playwright test  # end-to-end tests
```

Without the demo course's materials, the `/demo` pages have no course to show. Quick build works with your own course export.

Features are behind flags, all off by default. Set them in `.env.local`:

| Flag | What it turns on |
|---|---|
| `NEXT_PUBLIC_REWIND_QUICK_BUILD=1` | Quick build: import your own course (export, PDFs, lecture transcripts) and practice it |
| `NEXT_PUBLIC_REWIND_UPCOMING=1` | "Coming up": your course's due dates, on your device only |
| `NEXT_PUBLIC_REWIND_ACCOUNTS=1` | Sign-in and answer sync (needs Clerk keys and an Upstash Redis / Vercel KV store) |
| `NEXT_PUBLIC_REWIND_EXTENSION_IDS` | The Chrome extension IDs the site talks to (default: the pinned ID in `lib/extension.ts`) |

The live tutor and Quick build call Claude with `REWIND_DEMO_ANTHROPIC_API_KEY` and keep their own daily caps in a KV store (`KV_REST_API_URL`, `KV_REST_API_TOKEN`). The Chrome extension is in `extension/`; see `extension/README.md`.

---

## Quick start

### 1. Try the demo (no login, no keys)

Open the demo link on our Devpost page and press **Try the demo**. The demo course is real lecture practice from COP3530 (Oct 13, 20 and 22), used with Professor Kapoor's permission, and every demo screen says so. It is a precomputed bundle in `public/demo/course/` (questions, slide images and the lecture lines inside each clip), written by `node scripts/demo/export-demo.ts` from the course pipeline's output. A few approved clips are hosted in `public/demo/media/`; for every other question the rewind shows the slide and what he said in the clip. The Course tape starts with labelled example practice history.

In the demo:

1. Pick an answer on the Scantron sheet (A to D on a keyboard).
2. Press **Check answer**. The sheet is graded in place: the right oval turns green and says "Correct", your oval gets a red-pen loop that says "You marked", and a margin note gives the lecture time where it's explained.
3. Press **Rewind**. The sheet folds away, the reels spin back, the counter lands on the clip start, and the clip plays with captions, the slide and a one-line setup (or, without a hosted clip, his words from the clip with the slide).
4. Open **Course tape** in the demo bar: the three lectures as stops, with tonight's route back.

### 2. Run the demo locally

```sh
npm install
REWIND_DEMO=1 npm run dev        # then open http://localhost:3000 and press "Try the demo"
```

Demo mode never reads `private/` and never calls a model (`lib/demo/guard.ts`), so it needs no API keys.

### 3. Run it on your own course (developer setup)

Model calls need two keys in `.env.local` at the repo root. Never commit this file (`.gitignore` covers `.env*`), and never paste the values anywhere else:

- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`

Then:

1. Load `extension/` unpacked in Chrome (steps in `extension/README.md`) and export your course from a logged-in Canvas tab. Save the `.course.json` in `private/`.
2. Optional: put your own download of the course's Files tab in `private/files/<COURSE>/`.
3. Run the pipeline scripts (below), then `npm run dev` and open `/practice`. Without demo mode, `/practice` reads the local course data in `private/` and only works under `next dev`.

Checks: `npm run check` (typecheck, lint, vitest and the extension's node tests) and `npm run e2e` (Playwright, phone and desktop widths).

## How it works

### 1. The extension reads Canvas and Zoom through your own login

UF no longer issues Canvas API tokens, so a Chrome extension (Manifest V3, plain JavaScript, in `extension/`) reads the course from inside the student's logged-in Canvas tab. It sees only what the student can already see.

- **Canvas export:** files, modules (fetched item by item when the Files or Pages tab is hidden), pages, assignments, announcements for the whole term, the syllabus and the student's own submissions. It follows `Link: rel="next"` pagination. A failing endpoint is recorded in `errors` and the export keeps going.
- **Zoom transcripts:** on a UF Zoom recording page it reads the Audio Transcript panel's per-line times and speakers, and never the chat.
- **Player control:** the app can drive a Zoom recording through the extension's bridge (play, pause, seek, speed). The bridge accepts only listed app origins and only `https://ufl.zoom.us/rec/` URLs.

### 2. The pipeline turns course files into practice and clips

The contract is in `lib/pipeline/types.ts`. Every stage reads and writes under `private/pipeline/<COURSE>/`, so each stage can be cached and rerun:

```
download → extract → chunk → embed → exams → generate → check → retrieve → output
```

| Stage | What it does |
| --- | --- |
| download | Takes the student's own Files-tab download from `private/files/<COURSE>/`. Network download is off by default (see Privacy). |
| extract | Text page by page from PDFs, PPTX and DOCX, and from Canvas pages, announcements and assignments. |
| chunk | One chunk per slide. Documents and pages are cut into about 800-character chunks. Every chunk keeps its source: file, page and Canvas link. |
| embed | Lecture windows and slide pages are embedded with Gemini Embedding 2, cached per text. |
| exams | Gemini 3.8 Flash proposes each exam's name, date, location, format, notes rule and topics. Each field is kept only if its quote appears word for word in the cited source and supports the value. Otherwise the field is null and the app shows "not found". |
| generate | Claude Opus 5.5 writes multiple-choice questions in the style of the course's past reviews. Each question cites the slide or lecture line its quote comes from. Deterministic rules run first: exactly one defensible answer (pair-sum and BFS/DFS-order questions are brute-forced in code), nothing referenced that isn't shown, and short, parallel options. |
| check | A separate Opus call answers each question blind, without seeing the key, and judges every rule. A question is kept only if that answer matches the key. A rejected question is regenerated with the reason up to 2 times, then dropped. |
| retrieve | Searches only the lecturer's lines, in 40 s windows that never cross a speaker change. Flash rewrites the question as a lecture-style explanation and picks the moment and the slide. A clip is at most 75 s and starts on a real transcript line. With no recording, the rewind falls back to the slide, then a reading. |
| output | `output.json`: exams, questions, transcripts, counts and cost. This is what the app reads. |

On this branch, the stages run through `scripts/pipeline/front-half.ts` (download, extract, chunk, exams) and `scripts/pipeline/back-half.ts` (generate, check, retrieve). The single `npm run pipeline` runner is on the `pipeline-integration` branch and isn't merged yet.

Every model call goes through `lib/gemini.ts` or `lib/llm.ts`. Each call is cached on disk, keyed by a hash of the model and input, so the same input is never paid for twice. Token usage is logged, never content. Claude calls stop once the logged Claude cost passes $40.

### 3. The player has three sources

`lib/player/` and `components/rewind/RewindPlayer.tsx`:

- **`zoom-embed`** (primary): the Zoom recording plays in a frame on our page, driven through the extension. Play from a time is seek, confirm, then play: the app waits until the player reports a time within 1 s of the target before it plays. This fixes a bug where the clip started from 0:00.
- **`zoom-remote`** (automatic fallback): a background Zoom tab. The player switches to it by itself if the frame isn't ready within 8 s, or if a seek fails. Only one source plays at a time.
- **`hosted-media`** (demo mode): an approved clip hosted as a static file.

Captions are always on. The player has back 10 s, play or pause, speed (1x, 1.25x, 1.5x), a scrub bar inside the clip window and a transcript. A blocked `play()` always shows a way forward.

## Privacy

- **Secrets live in `.env.local` only.** It is gitignored and never read by the deployed app.
- **The preview deploy has no API keys.** Deployed builds run in demo mode: they show only the precomputed bundle and refuse model calls. Previews go out only through `scripts/deploy/preview.sh`. The script builds in a clean checkout with no `.env*` and no `private/`, scans the build output for secret values and course-data markers, and deploys only if the scan is clean.
- **Course data stays in `private/` on the device.** Real course files, exports, transcripts and pipeline output live in the gitignored `private/` folder, and the build excludes it from tracing. None of it is in this repo. Committed fixtures are invented.
- **Practice attempts stay on the device unless the student signs in.** They are kept in this browser's localStorage, and no request carries them. With accounts on (below), a signed-in student's own answers are also copied to their account. For the COP3530 demo course, Rewind adds a few example attempts so the Course tape has misses to show. They are always labelled "Example practice history". A real answer removes every example. "Clear my practice data" really clears.
- **Canvas file download is off by default.** The pipeline reads only files the student already downloaded from the Files tab into `private/files/<COURSE>/`. The network path runs only with `--download` or `REWIND_ENABLE_DOWNLOAD=1`. Even then it sends no credentials, accepts only Canvas and exact storage hosts, refuses links that carry a username or password, and writes only inside `private/`.
- **Accounts store only the student's own answers.** Accounts Lite is off unless `NEXT_PUBLIC_REWIND_ACCOUNTS=1`. Then the demo's header offers "Sign in to save your practice" (Clerk, email code only). An account holds, per answer, only `id`, `questionId`, `course`, `choice`, `correct`, `confidence` and `answeredAt`, in Upstash Redis (`lib/accounts/`). It never holds the question text, the topic, a quote, transcript text or example history: the browser re-derives those from the bundle it already has. "Delete my data" removes every answer in the account (it doesn't delete the Clerk sign-in itself). On a shared browser, signing out takes that account's answers off the device, and the next student's account never gets them. If the store is down, saving says it's unavailable and practice stays on the device. Off, the app makes no account request and loads no account code.
- **Credentials are never sent.** No Canvas cookie, token or GatorLink password is ever read, stored or sent to Rewind. The extension's Canvas requests stay inside the student's own Canvas tab.

## Results so far

| Number | What it means | Source |
| --- | --- | --- |
| 5 of 5 | The rewind spike found the right lecture moment for 5 of 5 practice questions on one real COP3530 lecture (Oct 22, 1:41:21). John listened to each clip from its start and marked it right or wrong. All 5 slide matches were right too. | `docs/BRIEF.md`; `npm run spike:score` |
| 74 of 75 | COP3530 questions kept after the rules and the blind check (61 on the first attempt, 12 on the second, 1 on the third, 1 dropped). An offline re-check of the 74 against the rules found 0 failing. 8 of them carry code cited word for word from the material. | COP3530 pipeline run, Oct 24 |
| 15 of 74 | Kept COP3530 questions with a lecture clip (20%). We had transcripts for 3 lectures. 74 of 74 (100%) have a slide or page. | same run |
| 24 | COP3530 exams and quizzes found, each date with a word-for-word quote, or "not found" | same run |
| about $5.09 | That run's model cost: Claude $3.30 plus Gemini about $1.79. The Gemini figure is estimated from token counts, using an assumed embedding price. | same run |
| 1 of 295 | COP3530 import items left with an unknown role after the rules and a Flash-Lite pass (MAS3114: 0 of 82) | `AGENT_REPORTS.md`, T15 |

## Limits

- **Clips exist only where lecture transcripts exist.** On COP3530, 15 of 74 kept questions have a clip, because we had transcripts for 3 lectures. MAS3114 has no transcripts, so its questions get no clip. Without a clip, the rewind shows the slide instead.
- **Exam topics come only from a source that states them.** Otherwise the field says "not found" and the student confirms what to practise. For example, no COP3530 source we read states Exam 2's topics, so its practice set fell back to one group per lecture deck.
- **The pipeline's retrieval is not fully verified by ear.** Scored against John's hand-marked ranges for the Oct 22 lecture, the pipeline's retrieval put 4 of 5 clips in the right place. The other 10 clips are still to be checked by ear. (The 5 of 5 above is the spike's matcher, on the same lecture.)
- **Canvas download links in the export aren't signed.** A request without the student's session is sent to the login page. That is why the pipeline uses the student's own Files-tab download.
- **The embedded Zoom player needs one browser setting.** The app must be allowed to use third-party cookies, and the app shows a setup card for it. Without the setting, the player uses the background Zoom tab.
- **Some pieces are not on this branch yet.** The course home with the exam card and confirm step, the Course tape's cassette visual, record-a-lecture's screen and the single pipeline runner are on branches waiting for review. The demo's Course tape and radar pages are placeholders.
- **Not built:** the tutor (its prompt exists in `lib/prompts/tutor.ts`, with no screen yet), the weak-spot map, the import-check screen and the notes-sheet planner.
- **Accounts are light.** Behind a flag, a student can sign in to keep their own practice answers across devices; everyone still practices on the demo course, and importing your own course runs only on your computer for now. Without the flag, the app runs locally for one student, and the deploy is the demo only.

## Repo map

- `app/`, `components/`: Next.js 16 screens (practice, rewind player, course tape, radar, demo)
- `extension/`: Chrome extension (Canvas export, Zoom transcript and player control, app bridge)
- `lib/pipeline/`, `lib/prompts/`, `lib/questions/`: the course pipeline, versioned prompts and question rules
- `lib/player/`: player sources and scrub rules
- `lib/gemini.ts`, `lib/llm.ts`, `lib/cache.ts`: cached model wrappers and cost control
- `docs/`: the plan, the brief and design mockups
- `FEATURES.md`: each feature's invariants and the tests that prove them
