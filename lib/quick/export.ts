// Quick build (beta), in the browser: the student's exported files become the chunks that are sent.
//   - Canvas pages: only `pages[].title` and `pages[].body`, as plain text (DOMParser; nothing is put into the page).
//     Files, modules, announcements, submissions and grades are never read here. Assignments are read only by
//     "Coming up" (lib/quick/upcoming.ts): name, due date and link, kept on this device, never sent.
//   - PDFs (slides, study guides): each page's text, read in a Web Worker (lib/quick/pdf.ts), with its file and page.
//   - Course logistics (syllabus, schedule, grading, access codes, platform setup, office hours...) never go: pages and
//     PDFs are filtered (lib/quick/logistics.ts) before chunking.
//   - Zoom transcripts: only the lecturer's lines, with their times. The lecturer is the speaker with the most words;
//     a line whose speaker isn't the lecturer, or has no label, is dropped.
//   - Chunks are about 800 characters (splitText, the pipeline's chunking), and a chunk the server's check would
//     refuse is dropped here rather than sent.

import { CHUNK_CHARS, MIN_ANCHOR_CHARS, OVERLAP_CHARS, splitText } from "../pipeline/chunk.ts";
import { ensureSentences } from "../transcript.ts";
import type { Transcript } from "../schema.ts";
import { gradedWhy } from "./graded.ts";
import { namesToStrip, stripNames } from "./names.ts";
import { isLogisticsTitle, subjectText, withoutLogistics } from "./logistics.ts";
import type { PdfFile } from "./pdf.ts";
import { parseRequest } from "./schema.ts";
import { LIMITS, type QuickChunk, type QuickRequest } from "./types.ts";

/**
 * A Canvas equation image's LaTeX, inline as "$...$"; null for any other image. Canvas keeps the LaTeX in
 * data-equation-content (and in alt/title, sometimes as "LaTeX: ..."), and MathML in data-mathml: its text is the
 * fallback when there's no LaTeX.
 */
export function equationText(img: Element): string | null {
  const attr = (n: string) => (typeof img.getAttribute === "function" ? img.getAttribute(n) : null)?.trim() || "";
  const cls = attr("class");
  const src = attr("src");
  const latex = attr("data-equation-content");
  const isEquation = !!latex || /\bequation_image\b/.test(cls) || /\/equation_images\//.test(src) || !!attr("data-mathml");
  if (!isEquation) return null;
  const fromAlt = (s: string) => s.replace(/^LaTeX:\s*/i, "").trim();
  let tex = latex || fromAlt(attr("alt")) || fromAlt(attr("title"));
  if (!tex) tex = attr("data-mathml").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
  // "a<b ... c>d" isn't a tag: a space after "<" keeps it text for the route's no-HTML check (as for PDF text).
  tex = tex.replace(/\s+/g, " ").replace(/<(?=[!?/a-zA-Z])/g, "< ").trim();
  return tex ? `$${tex}$` : null;
}

/** A page's HTML as lines of plain text, with equation images as inline LaTeX. `parse` is DOMParser's, or a test's. */
export function htmlToText(html: string, parse: (html: string) => Document = (h) => new DOMParser().parseFromString(h, "text/html")): string {
  const doc = parse(html);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "SVG", "HEAD"]);
  const BLOCK = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BR", "TR", "PRE", "BLOCKQUOTE", "TABLE", "SECTION", "ARTICLE", "HR"]);
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) out += n.nodeValue ?? "";
    else if (n.nodeType === 1) {
      const tag = (n as Element).tagName.toUpperCase();
      if (SKIP.has(tag)) return;
      if (tag === "MATH") {
        // MathML beside an equation image (Canvas adds one for screen readers) is the same equation: kept once.
        const tex = (n.textContent ?? "").replace(/\s+/g, " ").trim();
        if (tex && !/\$\s*$/.test(out)) out += ` $${tex.replace(/<(?=[!?/a-zA-Z])/g, "< ")}$ `;
        return;
      }
      if (tag === "IMG") {
        const eq = equationText(n as Element);
        if (eq) out += ` ${eq} `;
        return;
      }
      if (BLOCK.has(tag)) out += "\n";
      n.childNodes.forEach(walk);
      if (BLOCK.has(tag)) out += "\n";
    }
  };
  walk(doc.body ?? doc.documentElement);
  return out
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * splitText adds about 100 characters of overlap to the start of each piece after the first, so a piece can run that far
 * past its limit. Cutting at 690 keeps every chunk inside the 800 the server accepts.
 */
export const SPLIT_MAX = CHUNK_CHARS - OVERLAP_CHARS - 10;

export interface ExportFiles {
  course: { code: string; name: string };
  pages: { title: string; text: string }[];
  transcripts: Transcript[];
  /** The course PDFs the student picked, read in the browser (lib/quick/pdf.ts). */
  pdfs?: PdfFile[];
  /** Names the export carries (the student's own, from their submissions): on this device only, to filter, never sent. */
  people?: string[];
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** What kind of file this is, read from its JSON: a course export, a transcript, or neither. Nothing else in it is kept. */
export function readFile(json: unknown, parse?: (html: string) => Document): { kind: "course"; course: { code: string; name: string }; pages: { title: string; text: string }[] } | { kind: "transcript"; transcript: Transcript } | null {
  if (!isObject(json)) return null;
  if (Array.isArray(json.pages) && isObject(json.course)) {
    const c = json.course;
    const pages: { title: string; text: string }[] = [];
    for (const p of json.pages) {
      if (!isObject(p) || typeof p.body !== "string" || !p.body.trim()) continue;
      const text = htmlToText(p.body, parse);
      if (text) pages.push({ title: typeof p.title === "string" && p.title.trim() ? p.title.trim().slice(0, 120) : "Untitled page", text });
    }
    return {
      kind: "course",
      course: { code: String(c.course_code ?? c.id ?? "course").slice(0, 40), name: String(c.name ?? c.course_code ?? "Course").slice(0, 120) },
      pages,
    };
  }
  if (Array.isArray(json.segments)) {
    const segments = json.segments.flatMap((s) =>
      isObject(s) && typeof s.text === "string" && typeof s.start === "number" && typeof s.end === "number" ? [{ start: s.start, end: s.end, speaker: typeof s.speaker === "string" && s.speaker.trim() ? s.speaker.trim() : null, text: s.text }] : [],
    );
    const url = typeof json.recordingUrl === "string" ? json.recordingUrl : "";
    return {
      kind: "transcript",
      transcript: {
        source: "zoom",
        recordingUrl: url,
        title: typeof json.title === "string" && json.title.trim() ? json.title.trim().slice(0, 120) : "Lecture",
        recordedAt: typeof json.recordedAt === "string" ? json.recordedAt : null,
        durationSec: typeof json.durationSec === "number" ? json.durationSec : 0,
        segments,
      },
    };
  }
  return null;
}

/** Page text as chunks of about 800 characters. */
export function pageChunks(pages: ExportFiles["pages"]): QuickChunk[] {
  const out: QuickChunk[] = [];
  pages.forEach((p, i) => splitText(p.text, SPLIT_MAX).forEach((t, k) => out.push({ id: `p${i}c${k}`, kind: "page", title: p.title, text: t })));
  return out;
}

/** The speaker with the most words: the lecturer. */
export function lecturerOf(t: Transcript): string | null {
  const words = new Map<string, number>();
  for (const s of t.segments) if (s.speaker) words.set(s.speaker, (words.get(s.speaker) ?? 0) + s.text.split(/\s+/).filter(Boolean).length);
  return [...words.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** The lecturer's lines, grouped (in order, a few seconds apart or not) into chunks of up to 800 characters, each keeping its lines' times. */
export function lectureChunks(t: Transcript, index: number, people: string[] = []): QuickChunk[] {
  const lecturer = lecturerOf(t);
  if (!lecturer || !t.recordingUrl || !t.recordedAt) return [];
  // Other people's names in the lecturer's lines become "a student" (lib/quick/names.ts): the other speakers, the
  // export's people, and common first names; the lecturer's own name stays.
  const names = namesToStrip({ speakers: t.segments.map((s) => s.speaker), lecturer, people });
  // Sentence-sized lines first; a line still over the chunk size is cut at sentence ends with its start kept.
  const lines = ensureSentences(t)
    .segments.filter((s) => s.speaker === lecturer && s.text.trim())
    .flatMap((s) => splitText(stripNames(s.text.replace(/\s+/g, " ").trim(), names), SPLIT_MAX).map((text) => ({ start: s.start, end: s.end, text })));
  const out: QuickChunk[] = [];
  let cur: typeof lines = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      id: `l${index}c${out.length}`,
      kind: "lecture",
      title: t.title,
      text: cur.map((l) => l.text).join(" "),
      lecture: { recordingUrl: t.recordingUrl, recordedAt: t.recordedAt!, segments: cur },
    });
    cur = [];
  };
  for (const l of lines) {
    const size = cur.reduce((n, x) => n + x.text.length + 1, 0) + l.text.length;
    if (cur.length && (size > LIMITS.chunkChars || cur.length >= LIMITS.segments)) flush();
    cur.push(l);
  }
  flush();
  return out;
}

/** Each PDF page's text as chunks of about 800 characters, each keeping its file and page. */
export function pdfChunks(files: PdfFile[]): QuickChunk[] {
  const out: QuickChunk[] = [];
  files.forEach((f, i) =>
    f.pages.forEach((p) => splitText(p.text, SPLIT_MAX).forEach((text, k) => out.push({ id: `d${i}p${p.page}c${k}`, kind: f.kind, title: f.deck, text, doc: { deck: f.deck, page: p.page } }))),
  );
  return out;
}

/** Pages without course logistics (lib/quick/logistics.ts): a logistics page is dropped, and logistics lines in the rest. */
export function subjectPages(pages: ExportFiles["pages"]): ExportFiles["pages"] {
  return pages.flatMap((p) => {
    const text = subjectText(p.title, p.text);
    return text ? [{ title: p.title, text }] : [];
  });
}

/** The picked PDFs that look like graded work or submissions (lib/quick/graded.ts): never sent; the page says how many. */
export function gradedPdfs(pdfs: PdfFile[], people: string[] = []): PdfFile[] {
  return pdfs.filter((f) => gradedWhy(f.deck, f.pages[0]?.text ?? "", people) !== null);
}

/**
 * PDFs the same way: graded work or a submission is dropped whole, so is a logistics file (a syllabus, a schedule), and
 * logistics lines on every page.
 */
export function subjectPdfs(pdfs: PdfFile[], people: string[] = []): PdfFile[] {
  const graded = new Set(gradedPdfs(pdfs, people));
  return pdfs.flatMap((f) => {
    if (graded.has(f) || isLogisticsTitle(f.deck)) return [];
    const pages = f.pages.flatMap((p) => {
      const text = withoutLogistics(p.text);
      return text ? [{ page: p.page, text }] : [];
    });
    return pages.length ? [{ ...f, pages }] : [];
  });
}

/** Every chunk the check would accept, in the order of the course: the pages, the PDFs, then each recording. */
export function chunksOf(files: ExportFiles): { chunks: QuickChunk[]; dropped: number } {
  const all = [...pageChunks(subjectPages(files.pages)), ...pdfChunks(subjectPdfs(files.pdfs ?? [], files.people)), ...files.transcripts.flatMap((t, i) => lectureChunks(t, i, files.people))];
  const chunks = all.filter((c) => parseRequest(JSON.stringify({ course: { code: "x", name: "x" }, chunks: [c] })).ok);
  return { chunks, dropped: all.length - chunks.length };
}

/** At most `limit` chunks to write from: long enough, lectures and the rest (pages, slides, documents) both, spread over the course and kept in order. */
export function pickChunks(chunks: QuickChunk[], limit = 3 * LIMITS.chunks): QuickChunk[] {
  const long = chunks.filter((c) => c.text.length >= MIN_ANCHOR_CHARS);
  const half = Math.floor(limit / 2);
  const lectures = long.filter((c) => c.kind === "lecture");
  const pages = long.filter((c) => c.kind !== "lecture");
  const take = <T,>(xs: T[], n: number): T[] => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor(((i + 0.5) * xs.length) / n)]));
  const nl = Math.min(lectures.length, Math.max(half, limit - pages.length));
  const np = Math.min(pages.length, limit - nl);
  const chosen = new Set([...take(lectures, nl), ...take(pages, np)]);
  return long.filter((c) => chosen.has(c));
}

/** Contiguous batches of up to 12. */
export function batchesOf(chunks: QuickChunk[], course: QuickRequest["course"]): QuickRequest[] {
  const out: QuickRequest[] = [];
  for (let i = 0; i < chunks.length; i += LIMITS.chunks) out.push({ course, chunks: chunks.slice(i, i + LIMITS.chunks) });
  return out;
}
