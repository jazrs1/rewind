# Rewind brand

The mark is **"Tape talk"**: a cassette that is also a chat bubble. Its one source is
[`public/brand/rewind-mark.svg`](../../public/brand/rewind-mark.svg) (viewBox 0 0 64 64). Every other
size and file is rendered from it by `node scripts/brand/render.mjs` (headless Chromium; no model calls):

| File | What it is |
| --- | --- |
| `app/icon.svg`, `app/favicon.ico` (16/32/48) | Browser tab icons |
| `app/apple-icon.png` (180) | iOS home screen, on a deck (#1E2B30) rounded tile |
| `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Web app manifest (`app/manifest.ts`) |
| `public/og.png` (1200x630) | Link previews (Open Graph and Twitter) |
| `extension/icons/icon-16/32/48/128.png` | Chrome extension and its toolbar button |
| `rewind-logo-on-dark.svg` / `-512.png` / `-1024.png` | Mark + wordmark, cream text, for dark backgrounds |
| `rewind-logo-on-light.svg` / `-512.png` / `-1024.png` | Mark + wordmark, deck text, for light backgrounds |
| `rewind-mark-512.png`, `rewind-mark-1024.png`, `rewind-mark-tile-1024.png` | The mark alone, and on its tile |
| `devpost-thumbnail.png` (1200x800) | Devpost gallery thumbnail (3:2) |
| `video-title-card.png`, `video-end-card.png` (1920x1080) | Video title and end cards |
| `preview/favicon-16.png`, `favicon-32.png` and their `-x8` zooms | To review the smallest sizes |

Square icons centre the mark optically: its tail hangs low, so it sits 2 units higher than its box.

- **Colours:** shell #FA4616 (action orange), window and deck #1E2B30, reels #F3E9D2 (label cream), muted
  text #C9C3B3, and the four tape colours #3D6FD9, #F26B3A, #E9B43C, #7FC8A9.
- **Type:** "Rewind" in Bricolage Grotesque ExtraBold (800). In the logo SVGs it's outlined
  (`scripts/brand/wordmark.json`, made by `scripts/brand/wordmark-path.py`), so they need no font.
- **Words:** "Practice quizzes made in your professor's style. Confused? Rewind to their explanation." ("Rewind" in #FA4616 on the cards)
  and "Your real course · their lectures · their slides".
- **The end card's link:** rewindit.org, the script's default. Render another with
  `DEMO_URL=your-domain node scripts/brand/render.mjs`.
