// The Chrome Web Store screenshots (docs/brand/store/, 1280 x 800): the extension's real popup (extension/popup/),
// driven by a fake chrome API with invented courses, shown over a plain browser window with a caption. One shows
// the course picker, one a finished import. Headless Chromium; the caption font comes from Google Fonts. No model
// calls, no Canvas, no real course data.
//
//   node scripts/brand/store-screens.mjs
//   PW_CHROMIUM=/path/to/chrome node scripts/brand/store-screens.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "@playwright/test";

const DECK = "#1E2B30";
const CREAM = "#F3E9D2";
const MUTED = "#C9C3B3";
const TAPES = ["#3D6FD9", "#F26B3A", "#E9B43C", "#7FC8A9"];
const EXT = "http://extension.test";
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" };

// Invented courses and counts: the popup's real code renders them.
const COURSES = [
  { id: 101, course_code: "COP3530", name: "Data Structures and Algorithms" },
  { id: 102, course_code: "MAS3114", name: "Computational Linear Algebra" },
  { id: 103, course_code: "PHY2049", name: "Physics 2" },
];
const EXPORT = {
  ok: true,
  filename: "COP3530.course.json",
  counts: { modules: 14, pages: 62, files: 118, assignments: 23, announcements: 11 },
  errors: [],
};

/** Stands in for chrome.* inside the popup: an active Canvas tab whose content script answers with the data above. */
function fakeChrome({ courses, result }) {
  const listeners = [];
  window.chrome = {
    runtime: { onMessage: { addListener: (f) => listeners.push(f) } },
    tabs: {
      query: async () => [{ id: 7, url: "https://ufl.instructure.com/courses" }],
      sendMessage: async (_tabId, msg) => {
        if (msg.type === "rewind:listCourses") return { courses, errors: [] };
        if (msg.type === "rewind:export") return result;
        return null;
      },
    },
  };
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});

/** The popup in one state, as a 2x PNG of exactly its body. */
async function popup(state) {
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 332, height: 600 } });
  await page.route(`${EXT}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    route.fulfill({ body: readFileSync(join("extension", path)), contentType: TYPES[extname(path)] ?? "application/octet-stream" });
  });
  await page.addInitScript(fakeChrome, { courses: COURSES, result: EXPORT });
  await page.goto(`${EXT}/popup/popup.html`);
  await page.locator("#export").waitFor();
  if (state === "import") {
    await page.locator("#course").selectOption("101");
    await page.locator("#export").click();
    await page.getByText(`Downloaded ${EXPORT.filename}`).waitFor();
  }
  const png = await page.locator("body").screenshot();
  const box = await page.locator("body").boundingBox();
  await page.close();
  return { png, width: Math.round(box.width), height: Math.round(box.height) };
}

/** 1280 x 800: the caption on the left, a browser window on the right with the popup under the toolbar icon. */
function frame({ title, line, shot }) {
  const src = `data:image/png;base64,${shot.png.toString("base64")}`;
  const fonts =
    '<link rel="preconnect" href="https://fonts.gstatic.com"><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@800&family=Atkinson+Hyperlegible:wght@400;700&display=block" rel="stylesheet">';
  const strip = TAPES.map((c) => `<div style="flex:1;background:${c}"></div>`).join("");
  const rows = Array.from({ length: 7 }, (_, i) => `<div style="height:14px;width:${[78, 64, 88, 52, 70, 84, 60][i]}%;background:#E4E1DA;border-radius:4px"></div>`).join("");
  return `<!doctype html><html><head>${fonts}<style>
    html,body{margin:0;width:1280px;height:800px;background:${DECK};overflow:hidden;font-family:'Atkinson Hyperlegible'}
    .cap{position:absolute;left:72px;top:0;bottom:22px;width:380px;display:flex;flex-direction:column;justify-content:center;gap:18px}
    h1{margin:0;font:800 52px/1.02 'Bricolage Grotesque';letter-spacing:-1.5px;color:${CREAM}}
    p{margin:0;font-size:22px;line-height:1.35;color:${MUTED}}
    .win{position:absolute;left:500px;top:72px;width:720px;height:620px;border-radius:12px;background:#F7F6F3;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.45)}
    .bar{height:52px;background:#DEE1E6;display:flex;align-items:center;gap:10px;padding:0 14px}
    .dot{width:12px;height:12px;border-radius:50%;background:#B9BDC4}
    .url{flex:1;height:30px;border-radius:15px;background:#fff;display:flex;align-items:center;padding:0 14px;font-size:14px;color:#3C4043}
    .icon{width:24px;height:24px;border-radius:6px;background:${DECK};display:flex;align-items:center;justify-content:center}
    .body{display:flex;gap:24px;padding:28px}
    .side{width:150px;display:flex;flex-direction:column;gap:12px}
    .side div{height:12px;border-radius:4px;background:#D9D6CF}
    .main{flex:1;display:flex;flex-direction:column;gap:14px}
    .pop{position:absolute;right:18px;top:60px;width:${shot.width}px;height:${shot.height}px;border-radius:8px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.35)}
    .pop img{width:100%;height:100%;display:block}
    .strip{position:absolute;left:0;right:0;bottom:0;height:22px;display:flex}
  </style></head><body>
    <div class="cap"><h1>${title}</h1><p>${line}</p></div>
    <div class="win">
      <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><div class="url">ufl.instructure.com/courses</div><div class="icon"><img src="${EXT}/icons/icon-32.png" width="18" height="18" alt=""></div></div>
      <div class="body"><div class="side">${"<div></div>".repeat(8)}</div><div class="main">${rows}</div></div>
      <div class="pop"><img src="${src}" alt=""></div>
    </div>
    <div class="strip">${strip}</div>
  </body></html>`;
}

async function compose(path, spec) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route(`${EXT}/**`, (route) => route.fulfill({ body: readFileSync(join("extension", new URL(route.request().url()).pathname)), contentType: "image/png" }));
  await page.setContent(frame(spec), { waitUntil: "networkidle" });
  await page.evaluate(() => Promise.all([document.fonts.load("800 20px 'Bricolage Grotesque'"), document.fonts.load("20px 'Atkinson Hyperlegible'")]));
  const missing = await page.evaluate(() => ["800 20px 'Bricolage Grotesque'", "20px 'Atkinson Hyperlegible'"].filter((f) => !document.fonts.check(f)));
  if (missing.length) throw new Error(`fonts not loaded: ${missing.join(", ")}`);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 800 } });
  await page.close();
  mkdirSync("docs/brand/store", { recursive: true });
  writeFileSync(path, png);
  console.log(`${path} (${png.length} bytes)`);
}

await compose("docs/brand/store/1-popup.png", {
  title: "Your course, from the Canvas you already use",
  line: "Open Canvas, click Rewind and pick one of your courses. It uses your own sign-in.",
  shot: await popup("courses"),
});
await compose("docs/brand/store/2-import.png", {
  title: "One click, one file, on your computer",
  line: "The export lands in your Downloads as a .course.json file. Rewind turns it into practice in your professor's style.",
  shot: await popup("import"),
});

await browser.close();
