// The static half of npm run lint:design (CLI: scripts/design/lint.ts): reads app/ and components/ and fails on
//   1. raw hex colours outside the tokens (app/globals.css @theme blocks are the only place for them);
//   2. fonts outside the four (display, serif, hand, sans; mono only for code);
//   3. durations and easings outside the motion tokens (--dur-*, --ease-*, --stagger, --stagger-stop, the two
//      loops), and any motion token declared in an @theme block that isn't one of them (MOTION_TOKENS);
//   4. type sizes off the scale (deck 13/15/18/22/30/44, question serif 22–30) — a warning list, since the
//      mockups pin some sizes (e.g. the 60 px course code); `--strict` makes them errors.
// The rendered half (tap targets under 44 px, more than one primary per screen) is e2e/design-lint.spec.ts.
// Pure helpers, tested in lib/design/lint.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Finding {
  rule: "hex" | "font" | "motion" | "type" | "pronoun";
  file: string;
  line: number;
  text: string;
}

const MOTION_MS = new Set([150, 200, 320, 900]);

/** The motion tokens and their values: the only --dur-*, --ease-* and --stagger* an @theme block may declare. */
export const MOTION_TOKENS: Record<string, string> = {
  "--dur-1": "150ms",
  "--dur-2": "200ms",
  "--dur-3": "320ms",
  "--dur-rewind": "900ms",
  "--dur-loop-reel": "2400ms",
  "--dur-loop-shimmer": "1500ms",
  "--ease-out": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  "--ease-in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
  "--ease-settle": "cubic-bezier(0.2, 0.9, 0.3, 1.15)",
  "--ease-overshoot": "var(--ease-settle)",
  "--stagger": "60ms",
  "--stagger-entrance": "40ms",
  /** The course tape's stops coming in along the tape (app/tape-screen.css). */
  "--stagger-stop": "40ms",
};
export const TYPE_SCALE = new Set([13, 15, 18, 22, 30, 44]);
const SERIF_RANGE = [22, 30];

/** Tokens and their values live in @theme blocks; everything else must use them. */
function themeRanges(css: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /@theme(?:\s+static)?\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    out.push([m.index, i]);
  }
  return out;
}

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/[^\n]*/g, (c, p) => p + c.slice(p.length).replace(/[^\n]/g, " "));

/** Raw hex colours, ignoring comments and the @theme blocks of a stylesheet. */
export function hexFindings(file: string, src: string, isCss: boolean): Finding[] {
  const clean = strip(src);
  const skip = isCss ? themeRanges(clean) : [];
  const out: Finding[] = [];
  for (const m of clean.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const i = m.index!;
    if (skip.some(([a, b]) => i >= a && i < b)) continue;
    // Not a colour: a URL fragment like url(#abc123).
    if (/url\($/.test(clean.slice(Math.max(0, i - 4), i))) continue;
    out.push({ rule: "hex", file, line: lineOf(clean, i), text: m[0] });
  }
  return out;
}

/** font-family set outside the four (CSS font-family or font: shorthands, inline fontFamily, Tailwind font-[...]). */
export function fontFindings(file: string, src: string): Finding[] {
  const clean = strip(src);
  const out: Finding[] = [];
  const ok = /var\(--font-(display|serif|hand|sans|bricolage|source-serif|caveat|atkinson|mono)\)|ui-monospace|monospace/;
  for (const m of clean.matchAll(/font-family\s*:\s*([^;}\n]+)|fontFamily\s*:\s*([^,}\n]+)|\bfont-\[([^\]]+)\]/g)) {
    const val = m[1] ?? m[2] ?? m[3];
    if (ok.test(val) || /^--font-/.test(val.trim())) continue;
    out.push({ rule: "font", file, line: lineOf(clean, m.index!), text: m[0] });
  }
  return out;
}

/** Durations and easings that aren't the motion tokens: Tailwind classes, CSS declarations, WAAPI options. */
export function motionFindings(file: string, src: string, isCss: boolean): Finding[] {
  const clean = strip(src);
  const skip = isCss ? themeRanges(clean) : [];
  const out: Finding[] = [];
  const add = (i: number, text: string) => {
    if (!skip.some(([a, b]) => i >= a && i < b)) out.push({ rule: "motion", file, line: lineOf(clean, i), text });
  };
  for (const m of clean.matchAll(/\b(?:duration|delay)-(\d+)\b/g)) if (!MOTION_MS.has(Number(m[1]))) add(m.index!, m[0]);
  for (const m of clean.matchAll(/\b(?:duration|delay|ease)-\[[^\]]+\]/g)) add(m.index!, m[0]);
  if (isCss) {
    // Motion tokens declared in @theme: only the known ones, at their values.
    for (const [a, b] of skip) {
      const block = clean.slice(a, b);
      for (const m of block.matchAll(/(--(?:dur|ease|stagger)[\w-]*)\s*:\s*([^;}]+)/g)) {
        if (MOTION_TOKENS[m[1]] !== m[2].trim()) out.push({ rule: "motion", file, line: lineOf(clean, a + m.index!), text: `${m[1]}: ${m[2].trim()}` });
      }
    }
    for (const m of clean.matchAll(/(?:animation|transition)(?:-duration|-delay|-timing-function)?\s*:\s*([^;}]+)/g)) {
      const v = m[1];
      // Instant swaps (reduced motion) and the 3 s "say what's happening" step aren't motion.
      if (/!important/.test(v) || /\b1ms\s+3s\b/.test(v)) continue;
      if (/\b\d+(\.\d+)?m?s\b/.test(v) || /cubic-bezier\(/.test(v)) add(m.index!, m[0].trim());
    }
  } else {
    for (const m of clean.matchAll(/\b(duration|easing)\s*:\s*([^,}\n]+)/g)) {
      const v = m[2].trim();
      if (m[1] === "duration" && /^\d/.test(v)) add(m.index!, m[0]);
      if (m[1] === "easing" && /cubic-bezier|"ease/.test(v)) add(m.index!, m[0]);
    }
  }
  return out;
}

/** Arbitrary type sizes off the scale. Serif (question) text may sit anywhere in 22–30. */
export function typeFindings(file: string, src: string): Finding[] {
  const clean = strip(src);
  const out: Finding[] = [];
  for (const m of clean.matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)) {
    const px = Number(m[1]);
    if (TYPE_SCALE.has(px)) continue;
    const near = clean.slice(Math.max(0, m.index! - 120), m.index! + 120);
    if (/font-serif/.test(near) && px >= SERIF_RANGE[0] && px <= SERIF_RANGE[1]) continue;
    out.push({ rule: "type", file, line: lineOf(clean, m.index!), text: m[0] });
  }
  return out;
}

/**
 * No he/him/his for professors in UI strings (John, Oct 24): generic copy says "your professor" or "they", and a
 * known professor is named. Lecture quotes are verbatim transcript and live in course data, never in this source,
 * so every he/him/his left in app/ or components/ code (comments aside) is UI copy. The Ask tab's files belong to
 * another session and are skipped; ALLOW lists lines another branch is rewriting.
 */
const PRONOUN_SKIP = /^(app\/ask|app\/demo\/ask|components\/ask)\//;
const PRONOUN_ALLOW: { file: string; text: RegExp }[] = [];
export function pronounFindings(file: string, src: string): Finding[] {
  if (PRONOUN_SKIP.test(file)) return [];
  const clean = strip(src);
  const out: Finding[] = [];
  for (const m of clean.matchAll(/\b(he|him|his)\b/gi)) {
    const lineText = clean.split("\n")[lineOf(clean, m.index!) - 1];
    if (PRONOUN_ALLOW.some((a) => a.file === file && a.text.test(lineText))) continue;
    out.push({ rule: "pronoun", file, line: lineOf(clean, m.index!), text: lineText.trim().slice(0, 80) });
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

export function lintTree(root: string): Finding[] {
  const files = ["app", "components"].flatMap((d) => walk(join(root, d)));
  return files.flatMap((f) => {
    const src = readFileSync(f, "utf8");
    const rel = relative(root, f);
    const css = f.endsWith(".css");
    return [...hexFindings(rel, src, css), ...fontFindings(rel, src), ...motionFindings(rel, src, css), ...typeFindings(rel, src), ...(css ? [] : pronounFindings(rel, src))];
  });
}
