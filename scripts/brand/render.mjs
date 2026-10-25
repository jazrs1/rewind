// Renders every brand image from one file, the "Tape talk" mark (public/brand/rewind-mark.svg: a cassette
// that is also a chat bubble), and the outlined wordmark (scripts/brand/wordmark.json): app/icon.svg,
// the favicons and app icons, the link-preview image, the extension's icons, and the hackathon assets
// in docs/brand/. Square icons centre the mark optically: the bubble's tail hangs low, so the mark
// sits 2 units higher than its box (NUDGE). Headless Chromium draws each one;
// text set in a font (the og.png line, the cards, and the video cards' "Rewind" wordmark) loads Bricolage Grotesque and Atkinson Hyperlegible
// from Google Fonts. No model calls.
//
//   node scripts/brand/render.mjs                         (DEMO_URL=… sets the end card's link)
//   PW_CHROMIUM=/path/to/chrome node scripts/brand/render.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";

const DECK = "#1E2B30";
const CREAM = "#F3E9D2";
const MUTED = "#C9C3B3";
const TAPES = ["#3D6FD9", "#F26B3A", "#E9B43C", "#7FC8A9"];
const LINE = "Practice quizzes made in your professor's style. Confused? <span style=\"color:#FA4616\">Rewind</span> to their explanation.";
const SUB = "Your real course · their lectures · their slides";
const DEMO_URL = process.env.DEMO_URL ?? "rewindit.org";

const SOURCE = "public/brand/rewind-mark.svg";
const markInner = readFileSync(SOURCE, "utf8").trim().replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
/** Units the mark moves up in a square icon, so the bubble (not the box with its tail) looks centred. */
const NUDGE = 2;
/** The mark in a square, optically centred (transparent background). */
const squareMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${NUDGE} 64 64">${markInner}</svg>`;
const word = JSON.parse(readFileSync("scripts/brand/wordmark.json", "utf8"));

/** The bubble's middle (y 8 to 46): the wordmark's capitals centre on it, as in the app header. */
const BUBBLE_MID = 27;

/** Mark + wordmark, as in the app header (mark 24 px, text 22 px, 8 px apart), in 64-unit mark space. */
function lockupSvg(textColor) {
  const k = (22 / 24) * (64 / word.size);
  const gap = (8 / 24) * 64;
  const width = Math.ceil(64 + gap + word.width * k);
  const baseline = BUBBLE_MID + (word.capHeight * k) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 64" role="img" aria-label="Rewind">${markInner}<path transform="translate(${(64 + gap).toFixed(2)} ${baseline.toFixed(2)}) scale(${k.toFixed(5)})" fill="${textColor}" d="${word.d}"/></svg>`;
}

/**
 * The same lockup with "Rewind" set in Bricolage Grotesque 800 itself (the app's display font, loaded by the card page)
 * rather than the outlined path: the video cards. htmlPng fits it once the font is in (fitWordmarks): the capitals centre
 * on the bubble and the viewBox ends where the word does.
 */
function lockupFontSvg(textColor) {
  const size = (22 / 24) * 64;
  const gap = (8 / 24) * 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(64 + gap + size * 3.2)} 64" role="img" aria-label="Rewind" data-fit="${BUBBLE_MID}">${markInner}<text x="${(64 + gap).toFixed(2)}" y="${BUBBLE_MID}" fill="${textColor}" font-family="Bricolage Grotesque" font-weight="800" font-size="${size.toFixed(3)}" letter-spacing="${(-0.023 * size).toFixed(3)}">Rewind</text></svg>`;
}

/** The mark on a rounded deck tile (apple-icon, manifest "any"). `pad` is the tile's margin around the mark, 0 to 1. */
function tileSvg(rounded, pad) {
  const inset = 64 * pad;
  const s = 64 - inset * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${rounded ? 14 : 0}" fill="${DECK}"/><g transform="translate(${inset} ${inset - NUDGE * (s / 64)}) scale(${s / 64})">${markInner}</g></svg>`;
}

const fonts =
  '<link rel="preconnect" href="https://fonts.gstatic.com"><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@800&family=Atkinson+Hyperlegible:wght@400;700&display=block" rel="stylesheet">';
const strip = (h) => `<div style="position:absolute;left:0;right:0;bottom:0;height:${h}px;display:flex">${TAPES.map((c) => `<div style="flex:1;background:${c}"></div>`).join("")}</div>`;

/** A card: deck background, the lockup, the line, the sub-line, the tape strip. */
function card({ w, h, lockup, line, lineSize, sub, subSize, extra = "", stripH, pad, center = false, fontWordmark = false }) {
  const align = center ? "align-items:center;text-align:center;justify-content:center" : "justify-content:center";
  return `<!doctype html><html><head>${fonts}<style>
    html,body{margin:0;width:${w}px;height:${h}px;background:${DECK};overflow:hidden}
    .c{position:relative;box-sizing:border-box;width:${w}px;height:${h}px;padding:${pad}px ${pad}px ${pad + stripH}px;display:flex;flex-direction:column;gap:${Math.round(lineSize * 0.55)}px;${align}}
    .l{height:${lockup}px}.l svg{height:100%;width:auto;display:block}
    .line{font-family:'Bricolage Grotesque';font-weight:800;color:${CREAM};font-size:${lineSize}px;line-height:1.06;letter-spacing:-0.02em;margin:0;max-width:${center ? w - pad * 2 : w * 0.86}px;text-wrap:balance}
    .sub{font-family:'Atkinson Hyperlegible';color:${MUTED};font-size:${subSize}px;margin:0}
  </style></head><body><div class="c"><div class="l">${fontWordmark ? lockupFontSvg(CREAM) : lockupSvg(CREAM)}</div>${line ? `<p class="line">${line}</p>` : ""}${sub ? `<p class="sub">${sub}</p>` : ""}${extra}${strip(stripH)}</div></body></html>`;
}

/** A PNG-in-ICO file holding each PNG (the browser picks the size). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

const out = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`${path} (${data.length} bytes)`);
};

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();

/** An SVG drawn at w x h, transparent unless the SVG fills itself. */
async function svgPng(svg, w, h = w) {
  // Chromium's screenshots of very small viewports come out wrong: draw in at least 256 px and clip.
  await page.setViewportSize({ width: Math.max(w, 256), height: Math.max(h, 256) });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${w}" height="${h}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
}

async function htmlPng(html, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => Promise.all([document.fonts.load("800 20px 'Bricolage Grotesque'"), document.fonts.load("20px 'Atkinson Hyperlegible'")]));
  const missing = await page.evaluate(() => ["800 20px 'Bricolage Grotesque'", "20px 'Atkinson Hyperlegible'"].filter((f) => !document.fonts.check(f)));
  if (missing.length) throw new Error(`fonts not loaded: ${missing.join(", ")}`);
  // Font wordmarks: the baseline puts the capitals' middle on the bubble's, and the viewBox ends with the word.
  const fitted = await page.evaluate(() =>
    [...document.querySelectorAll("svg[data-fit]")].map((svg) => {
      const t = svg.querySelector("text");
      const size = Number(t.getAttribute("font-size"));
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = `800 ${size}px 'Bricolage Grotesque'`;
      const cap = ctx.measureText("R").actualBoundingBoxAscent;
      t.setAttribute("y", (Number(svg.dataset.fit) + cap / 2).toFixed(2));
      svg.setAttribute("viewBox", `0 0 ${Math.ceil(Number(t.getAttribute("x")) + t.getComputedTextLength())} 64`);
      return getComputedStyle(t).fontFamily;
    }),
  );
  if (fitted.some((f) => !/Bricolage Grotesque/.test(f))) throw new Error(`a wordmark isn't set in Bricolage Grotesque: ${fitted.join(", ")}`);
  return page.screenshot({ clip: { x: 0, y: 0, width: w, height: h } });
}

// Web app icons. app/icon.svg is the source, optically centred.
out("app/icon.svg", `${squareMarkSvg}\n`);
// One at a time: they share the one page.
const favicons = [];
for (const size of [16, 32, 48]) favicons.push({ size, png: await svgPng(squareMarkSvg, size) });
out("app/favicon.ico", ico(favicons));
// The 16 and 32 px favicons as they are, and 8x (pixels kept square) to review them.
for (const { size, png } of favicons.filter((f) => f.size <= 32)) {
  out(`docs/brand/preview/favicon-${size}.png`, png);
  const z = size * 8;
  await page.setViewportSize({ width: Math.max(z, 256), height: Math.max(z, 256) });
  await page.setContent(`<body style="margin:0;background:${DECK}"><img src="data:image/png;base64,${png.toString("base64")}" style="width:${z}px;height:${z}px;image-rendering:pixelated;display:block">`);
  out(`docs/brand/preview/favicon-${size}-x8.png`, await page.screenshot({ clip: { x: 0, y: 0, width: z, height: z } }));
}
out("app/apple-icon.png", await svgPng(tileSvg(true, 0.1), 180));
out("public/icons/icon-192.png", await svgPng(tileSvg(true, 0.08), 192));
out("public/icons/icon-512.png", await svgPng(tileSvg(true, 0.08), 512));
// Maskable: full bleed, the mark inside the central 80% safe zone.
out("public/icons/icon-maskable-512.png", await svgPng(tileSvg(false, 0.2), 512));

// Link preview.
out("public/og.png", await htmlPng(card({ w: 1200, h: 630, lockup: 64, line: LINE, lineSize: 58, sub: SUB, subSize: 30, stripH: 18, pad: 72 }), 1200, 630));

// Chrome extension.
for (const size of [16, 32, 48, 128]) out(`extension/icons/icon-${size}.png`, await svgPng(squareMarkSvg, size));

// Hackathon assets.
const lockups = { "on-dark": lockupSvg(CREAM), "on-light": lockupSvg(DECK) };
for (const [name, svg] of Object.entries(lockups)) {
  out(`docs/brand/rewind-logo-${name}.svg`, `${svg}\n`);
  const [, vw, vh] = svg.match(/viewBox="0 0 (\d+) (\d+)"/).map(Number);
  for (const w of [512, 1024]) out(`docs/brand/rewind-logo-${name}-${w}.png`, await svgPng(svg, w, Math.round((w * vh) / vw)));
}
for (const w of [512, 1024]) out(`docs/brand/rewind-mark-${w}.png`, await svgPng(squareMarkSvg, w));
out("docs/brand/rewind-mark-tile-1024.png", await svgPng(tileSvg(true, 0.1), 1024));
out("docs/brand/devpost-thumbnail.png", await htmlPng(card({ w: 1200, h: 800, lockup: 80, line: LINE, lineSize: 66, sub: SUB, subSize: 32, stripH: 22, pad: 80 }), 1200, 800));
out("docs/brand/video-title-card.png", await htmlPng(card({ w: 1920, h: 1080, lockup: 150, line: LINE, lineSize: 72, sub: SUB, subSize: 40, stripH: 28, pad: 120, center: true, fontWordmark: true }), 1920, 1080));
const endExtra = `<p style="font-family:'Atkinson Hyperlegible';font-weight:700;color:${CREAM};font-size:52px;margin:24px 0 0">Try the demo</p><p style="font-family:'Atkinson Hyperlegible';color:${MUTED};font-size:44px;margin:0">${DEMO_URL}</p>`;
out("docs/brand/video-end-card.png", await htmlPng(card({ w: 1920, h: 1080, lockup: 150, line: "", lineSize: 72, sub: SUB, subSize: 40, extra: endExtra, stripH: 28, pad: 120, center: true, fontWordmark: true }), 1920, 1080));

await browser.close();
