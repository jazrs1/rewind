// Pipeline stage 2 (T17): text out of everything the pipeline reads, page by page.
//   - downloaded files: PDF per page (unpdf, injected), PPTX per slide (only downloaded when no
//     PDF version exists), DOCX as one page, VTT/SRT/TXT/MD as one page
//   - from the export itself: the syllabus body, Canvas pages, announcements and assignments
//     (HTML to text, links kept as "text (url)")
// A PDF with no text layer gets `problem: "no text layer"` (no OCR now). No new packages: PPTX
// and DOCX are zip files, read here with node:zlib.

import { inflateRawSync } from "node:zlib";
import type { ItemRole } from "../schema.ts";
import type { DownloadResult } from "./download.ts";
import type { ExtractedDoc } from "./types.ts";

/** Pages with less text than this count as empty (scanned slides, title-only pages). */
const MIN_PAGE_CHARS = 15;

export interface ExtractDeps {
  /** Bytes of a downloaded file, by its name in files/ (e.g. "1234.pdf"). */
  read: (file: string) => Promise<Uint8Array>;
  /** Per-page text of a PDF (unpdf's extractText with mergePages: false). */
  pdfText: (bytes: Uint8Array) => Promise<string[]>;
}

/** The parts of the course export this stage reads (raw Canvas objects). */
export interface ExtractExport {
  course: { id: number; name: string | null; course_code: string | null };
  pages?: { url: string; title?: string; body?: string | null }[];
  announcements?: { id: number; title?: string; message?: string | null; posted_at?: string | null }[];
  assignments?: { id: number; name?: string; description?: string | null; due_at?: string | null }[];
  syllabus_body?: string | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** A URL without its query string (Canvas puts per-user `verifier=` tokens there) or fragment. */
export const stripQuery = (url: string) => url.replace(/[?#][\s\S]*$/, "");
/** Any http(s) URL in plain text, up to whitespace or a closing bracket. */
const BARE_URL = /\bhttps?:\/\/[^\s)<>"']+/g;

/** Canvas HTML to plain text: block tags become line breaks, links keep their URL (without its query string). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      const url = stripQuery(decodeEntities(href));
      const shown = stripQuery(decodeEntities(label));
      return !label ? url : shown === url ? url : `${label} (${url})`;
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|blockquote|pre|section)>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(BARE_URL, (u) => stripQuery(u))
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- zip (PPTX, DOCX) ----------

/** Reads the entries of a zip file (stored or deflated), by name. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (view.getUint32(local, true) !== 0x04034b50) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(data)));
  }
  return out;
}

function xmlRuns(xml: string, para: RegExp, run: RegExp): string {
  return xml
    .split(para)
    .map((p) => [...p.matchAll(run)].map((m) => decodeEntities(m[1])).join(""))
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/** One entry per slide, in slide order (ppt/slides/slideN.xml). */
export function pptxSlides(bytes: Uint8Array): string[] {
  const zip = readZip(bytes);
  const slides = [...zip.keys()]
    .map((k) => ({ k, n: Number(k.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n);
  const decoder = new TextDecoder();
  return slides.map((s) => xmlRuns(decoder.decode(zip.get(s.k)), /<\/a:p>/, /<a:t>([\s\S]*?)<\/a:t>/g));
}

/** A Word document's text (word/document.xml), paragraphs on lines. */
export function docxText(bytes: Uint8Array): string {
  const xml = readZip(bytes).get("word/document.xml");
  if (!xml) return "";
  return xmlRuns(new TextDecoder().decode(xml), /<\/w:p>/, /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g);
}

/** Caption text of a WebVTT or SRT file, without cue numbers and timings. */
export function captionText(src: string): string {
  return src
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !/^WEBVTT/.test(l) && !/-->/.test(l) && !/^\d+$/.test(l.trim()) && !/^(NOTE|STYLE)\b/.test(l))
    .map((l) => l.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .join("\n");
}

const stripExt = (name: string) => name.replace(/\.[a-z0-9]+$/i, "");
const clean = (t: string) => t.replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** One downloaded file to an ExtractedDoc. */
export async function extractFile(d: DownloadResult, deps: ExtractDeps): Promise<ExtractedDoc> {
  const base = { itemId: d.itemId, fileId: d.fileId, name: stripExt(d.name), role: d.role as ItemRole };
  if (!d.file) return { ...base, pages: [], problem: d.reason ?? "not downloaded" };
  try {
    const bytes = await deps.read(d.file);
    if (d.ext === "pdf") {
      const pages = (await deps.pdfText(bytes)).map((t, i) => ({ page: i + 1, text: t.replace(/\s+/g, " ").trim() }));
      const withText = pages.filter((p) => p.text.length >= MIN_PAGE_CHARS).length;
      return withText ? { ...base, pages } : { ...base, pages, problem: "no text layer" };
    }
    if (d.ext === "pptx") return { ...base, pages: pptxSlides(bytes).map((t, i) => ({ page: i + 1, text: clean(t) })) };
    if (d.ext === "docx") return { ...base, pages: [{ page: 1, text: clean(docxText(bytes)) }] };
    const src = new TextDecoder().decode(bytes);
    if (d.ext === "vtt" || d.ext === "srt") return { ...base, pages: [{ page: 1, text: captionText(src) }] };
    if (d.ext === "html" || d.ext === "htm") return { ...base, pages: [{ page: 1, text: htmlToText(src) }] };
    if (d.ext === "txt" || d.ext === "md") return { ...base, pages: [{ page: 1, text: clean(src) }] };
    return { ...base, pages: [], problem: `can't read .${d.ext} yet` };
  } catch (e) {
    return { ...base, pages: [], problem: `couldn't read the file: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * A Canvas page's role from its title's role (lib/import classify): its text is course content
 * ("page", which generate can write questions from) unless the title says admin, syllabus or review.
 */
export function canvasPageRole(titleRole: ItemRole): ItemRole {
  return titleRole === "admin" || titleRole === "syllabus" || titleRole === "review" ? titleRole : "page";
}

/** Everything the course export itself carries as text. */
export function extractExportText(exp: ExtractExport, pageRole: (title: string) => ItemRole = () => "unknown"): ExtractedDoc[] {
  const docs: ExtractedDoc[] = [];
  const syllabus = htmlToText(exp.syllabus_body);
  if (syllabus) docs.push({ itemId: `syllabus:${exp.course.id}`, fileId: null, name: "Syllabus", role: "syllabus", pages: [{ page: 1, text: syllabus }] });
  for (const p of exp.pages ?? []) {
    const text = htmlToText(p.body);
    if (!text) continue;
    const title = p.title ?? p.url;
    docs.push({ itemId: `page:${p.url}`, fileId: null, name: title, role: pageRole(title), pages: [{ page: 1, text }] });
  }
  for (const a of exp.announcements ?? []) {
    const title = a.title ?? "Announcement";
    docs.push({ itemId: `announcement:${a.id}`, fileId: null, name: title, role: "admin", pages: [{ page: 1, text: clean(`${title}\n${htmlToText(a.message)}`) }] });
  }
  for (const a of exp.assignments ?? []) {
    // Only Canvas's own text: the name and description. `due_at` is metadata (the window's
    // close), carried on the chunk's SourceRef, never written into the text where it could be
    // quoted as if Canvas had printed it.
    const name = a.name ?? `Assignment ${a.id}`;
    const desc = htmlToText(a.description);
    docs.push({ itemId: `assignment:${a.id}`, fileId: null, name, role: "homework", pages: [{ page: 1, text: clean([name, desc].filter(Boolean).join("\n")) }] });
  }
  return docs;
}

export async function extractCourse(exp: ExtractExport, downloads: DownloadResult[], deps: ExtractDeps, opts: { pageRole?: (title: string) => ItemRole } = {}): Promise<ExtractedDoc[]> {
  const fileDocs: ExtractedDoc[] = [];
  for (const d of downloads) {
    const doc = await extractFile(d, deps);
    // File text (PDFs, captions) can carry pasted Canvas links too: no query strings anywhere.
    fileDocs.push({ ...doc, pages: doc.pages.map((p) => ({ ...p, text: p.text.replace(BARE_URL, (u) => stripQuery(u)) })) });
  }
  return [...fileDocs, ...extractExportText(exp, opts.pageRole)];
}
