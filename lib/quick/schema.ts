// Quick build (beta): the strict check on a request body. Allowed keys only, length caps, https Zoom recording URLs,
// a PDF chunk's { deck, page } and nothing else, no HTML. Anything else is refused before a limit is counted or a model is asked.

import { LIMITS, type QuickChunk, type QuickRequest } from "./types.ts";

export type Parsed = { ok: true; request: QuickRequest } | { ok: false; why: string };

const ws = (s: string) => s.replace(/\s+/g, " ").trim();
const ID = /^[A-Za-z0-9_-]{1,40}$/;
/** A tag, a comment or a processing instruction. A bare "<" ("i < n") is text. */
const HTML = /<\/?[a-zA-Z][^>]*>|<!--|<\?|<!\[/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

function text(x: unknown, max: number): string | null {
  if (typeof x !== "string") return null;
  const s = x.trim();
  if (!s || s.length > max || HTML.test(s) || CONTROL.test(s)) return null;
  return s;
}

/** https://<anything>.zoom.us/..., no credentials, no port. */
export function isZoomUrl(x: unknown): x is string {
  if (typeof x !== "string" || x.length > 300) return false;
  let u: URL;
  try {
    u = new URL(x);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return u.protocol === "https:" && !u.username && !u.password && !u.port && (host === "zoom.us" || host.endsWith(".zoom.us"));
}

function chunkOf(x: unknown): QuickChunk | string {
  if (!isObject(x) || !onlyKeys(x, ["id", "kind", "title", "text", "lecture", "doc"])) return "chunk keys";
  if (typeof x.id !== "string" || !ID.test(x.id)) return "chunk id";
  if (x.kind !== "page" && x.kind !== "lecture" && x.kind !== "slide" && x.kind !== "document") return "chunk kind";
  const title = text(x.title, 120);
  if (title === null) return "chunk title";
  const body = text(x.text, LIMITS.chunkChars);
  if (body === null) return "chunk text";
  if (x.kind !== "lecture" && x.lecture !== undefined) return "page with a recording";
  if (x.kind === "page") {
    if (x.doc !== undefined) return "page with a file";
    return { id: x.id, kind: "page", title, text: body };
  }
  if (x.kind === "slide" || x.kind === "document") {
    const d = x.doc;
    if (!isObject(d) || !onlyKeys(d, ["deck", "page"])) return "doc keys";
    const deck = text(d.deck, 120);
    if (deck === null || deck !== title) return "doc deck";
    if (typeof d.page !== "number" || !Number.isInteger(d.page) || d.page < 1 || d.page > 5000) return "doc page";
    return { id: x.id, kind: x.kind, title, text: body, doc: { deck, page: d.page } };
  }
  if (x.doc !== undefined) return "lecture with a file";
  const l = x.lecture;
  if (!isObject(l) || !onlyKeys(l, ["recordingUrl", "recordedAt", "segments"])) return "lecture keys";
  if (!isZoomUrl(l.recordingUrl)) return "recording url";
  if (typeof l.recordedAt !== "string" || l.recordedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(l.recordedAt) || Number.isNaN(Date.parse(l.recordedAt))) return "recordedAt";
  if (!Array.isArray(l.segments) || !l.segments.length || l.segments.length > LIMITS.segments) return "segments";
  const segments = [];
  for (const s of l.segments) {
    if (!isObject(s) || !onlyKeys(s, ["start", "end", "text"])) return "segment keys";
    const t = text(s.text, LIMITS.chunkChars);
    const { start, end } = s;
    if (t === null || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return "segment";
    if (start < 0 || end < start || end > 200_000) return "segment times";
    segments.push({ start, end, text: t });
  }
  // The text is the lines, so what is sent is one thing, not two.
  if (ws(segments.map((s) => s.text).join(" ")) !== ws(body)) return "text is not the lines";
  return { id: x.id, kind: "lecture", title, text: body, lecture: { recordingUrl: l.recordingUrl, recordedAt: l.recordedAt, segments } };
}

/** The request as a typed value, or why it was refused (a short fixed tag, never the text). */
export function parseRequest(raw: string): Parsed {
  if (new TextEncoder().encode(raw).length > LIMITS.bodyBytes) return { ok: false, why: "too-large" };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, why: "json" };
  }
  if (!isObject(body) || !onlyKeys(body, ["course", "chunks"])) return { ok: false, why: "keys" };
  const c = body.course;
  if (!isObject(c) || !onlyKeys(c, ["code", "name"])) return { ok: false, why: "course" };
  const code = text(c.code, 40);
  const name = text(c.name, 120);
  if (code === null || name === null) return { ok: false, why: "course" };
  if (!Array.isArray(body.chunks) || !body.chunks.length || body.chunks.length > LIMITS.chunks) return { ok: false, why: "chunks" };
  const chunks: QuickChunk[] = [];
  const seen = new Set<string>();
  for (const x of body.chunks) {
    const k = chunkOf(x);
    if (typeof k === "string") return { ok: false, why: k };
    if (seen.has(k.id)) return { ok: false, why: "duplicate id" };
    seen.add(k.id);
    chunks.push(k);
  }
  return { ok: true, request: { course: { code, name }, chunks } };
}
