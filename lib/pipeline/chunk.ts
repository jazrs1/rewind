// Pipeline stage 3 (T17): ExtractedDoc[] -> PipelineChunk[], every chunk with a SourceRef that
// says where it came from and links back to Canvas.
//   - slide decks (lecture files): one chunk per slide
//   - other files, Canvas pages and the syllabus: ~800-character chunks on paragraph
//     boundaries, ~100 characters of overlap
//   - announcements and assignments: one chunk each

import type { PipelineChunk, SourceRef, ExtractedDoc } from "./types.ts";

export const CHUNK_CHARS = 800;
export const OVERLAP_CHARS = 100;
/** A chunk shorter than this is too thin to anchor a question (here, not in generate.ts, so the browser can import it). */
export const MIN_ANCHOR_CHARS = 150;
const CANVAS = "https://ufl.instructure.com";

/** The parts of the export the SourceRefs need. */
export interface ChunkExport {
  course: { id: number };
  pages?: { url: string; title?: string }[];
  announcements?: { id: number; title?: string; posted_at?: string | null }[];
  assignments?: { id: number; name?: string; due_at?: string | null }[];
}

/** The tail of `text` (about `n` characters), starting at a word boundary. */
function tail(text: string, n: number): string {
  if (text.length <= n) return text;
  const cut = text.slice(text.length - n);
  const space = cut.indexOf(" ");
  return space >= 0 && space < cut.length - 1 ? cut.slice(space + 1) : cut;
}

/** Splits a long paragraph at sentence ends, else word boundaries, into pieces under `max`. */
function splitLong(p: string, max: number): string[] {
  const out: string[] = [];
  let rest = p;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let at = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    at = at > max / 2 ? at + 1 : window.lastIndexOf(" ");
    if (at <= 0) at = max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** ~800-character pieces on paragraph (line) boundaries; each after the first starts with ~100 overlapping characters. */
export function splitText(text: string, max = CHUNK_CHARS, overlap = OVERLAP_CHARS): string[] {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean).flatMap((p) => splitLong(p, max));
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + 1 + p.length > max) {
      out.push(cur);
      cur = `${tail(cur, overlap)}\n${p}`;
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkDocs(docs: ExtractedDoc[], exp: ChunkExport): PipelineChunk[] {
  const course = `${CANVAS}/courses/${exp.course.id}`;
  const pages = new Map((exp.pages ?? []).map((p) => [p.url, p]));
  const announcements = new Map((exp.announcements ?? []).map((a) => [String(a.id), a]));
  const assignments = new Map((exp.assignments ?? []).map((a) => [String(a.id), a]));
  const chunks: PipelineChunk[] = [];
  const add = (id: string, text: string, d: ExtractedDoc, source: SourceRef) => {
    if (text.trim()) chunks.push({ id, text, role: d.role, source });
  };

  for (const d of docs) {
    const [kind, key] = [d.itemId.slice(0, d.itemId.indexOf(":")), d.itemId.slice(d.itemId.indexOf(":") + 1)];
    if (kind === "file") {
      const fileId = d.fileId ?? Number(key);
      for (const p of d.pages) {
        const href = `${course}/files/${fileId}#page=${p.page}`;
        if (d.role === "lecture") {
          add(`${d.itemId}#p${p.page}`, p.text, d, { kind: "slide", itemId: d.itemId, fileId, page: p.page, deck: d.name, href });
        } else {
          splitText(p.text).forEach((t, k) =>
            add(`${d.itemId}#p${p.page}c${k + 1}`, t, d, { kind: "document", itemId: d.itemId, fileId, page: p.page, name: d.name, href }));
        }
      }
    } else if (kind === "page") {
      const page = pages.get(key);
      const text = d.pages.map((p) => p.text).join("\n");
      splitText(text).forEach((t, k) =>
        add(`${d.itemId}#c${k + 1}`, t, d, { kind: "page", itemId: d.itemId, pageUrl: key, title: page?.title ?? d.name, href: `${course}/pages/${key}` }));
    } else if (kind === "syllabus") {
      splitText(d.pages.map((p) => p.text).join("\n")).forEach((t, k) =>
        add(`${d.itemId}#c${k + 1}`, t, d, { kind: "syllabus", itemId: d.itemId, href: `${course}/assignments/syllabus` }));
    } else if (kind === "announcement") {
      const a = announcements.get(key);
      add(d.itemId, d.pages.map((p) => p.text).join("\n"), d, {
        kind: "announcement", itemId: d.itemId, title: a?.title ?? d.name, postedAt: a?.posted_at ?? "", href: `${course}/discussion_topics/${key}`,
      });
    } else if (kind === "assignment") {
      const a = assignments.get(key);
      add(d.itemId, d.pages.map((p) => p.text).join("\n"), d, {
        kind: "assignment", itemId: d.itemId, name: a?.name ?? d.name, dueAt: a?.due_at ?? null, href: `${course}/assignments/${key}`,
      });
    }
  }
  return chunks;
}
