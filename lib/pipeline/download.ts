// Pipeline stage 1 (T17, Tier 2): download the course files the pipeline reads, from the
// export's signed URLs, into private/pipeline/<COURSE>/files/<fileId>.<ext>.
//
// Rules: never send cookies or tokens (the request carries no credentials at all), at most 4
// at a time, PDFs first, skip what's already on disk, record every failure, never retry an
// expired or unsigned link (the student re-exports). Writes only inside the given directory:
// the name is always <integer fileId>.<allowed extension>, written to a temp file and renamed,
// so a half-written file never counts as present. Only the course's Canvas host and Canvas's
// file stores are contacted, every redirect included; each file has a size cap and a timeout.
//
// Finding (Oct 23): Canvas's file `url` in the API (`/files/<id>/download?download_frd=1`) is not
// signed; without the session it redirects to /login. Such links are recorded as
// "needs a signed URL" instead of being fetched with cookies.

import { inflateRawSync } from "node:zlib";
import type { ItemRole } from "../schema.ts";

/** Roles whose files the pipeline reads. */
export const DOWNLOAD_ROLES: readonly ItemRole[] = ["lecture", "review", "practice", "syllabus", "transcript"];

/** Extensions we may write, by what extract understands. */
const EXTENSIONS = ["pdf", "pptx", "ppt", "docx", "txt", "vtt", "srt", "md", "html", "htm"] as const;
export type FileExt = (typeof EXTENSIONS)[number];

export const MAX_IN_FLIGHT = 4;
const MAX_REDIRECTS = 5;
/** The course's Canvas host: the only Canvas origin a download may start from or pass through. */
export const CANVAS_HOST = "ufl.instructure.com";
/** Larger files are refused (a lecture PDF is a few MB; this only stops a runaway). */
export const MAX_BYTES = 100 * 1024 * 1024;
/** Per file, every redirect and the body included. */
export const TIMEOUT_MS = 60_000;
/** The failure reason when the network download path is off (the default). */
export const DOWNLOAD_DISABLED = "download disabled";

/**
 * Instructure's S3 bucket, by exact host only: anyone can register a bucket named
 * "instructure-uploads-<anything>", so no pattern. The bucket's global and us-east-1 regional
 * virtual-hosted names.
 */
export const S3_HOSTS: readonly string[] = ["instructure-uploads.s3.amazonaws.com", "instructure-uploads.s3.us-east-1.amazonaws.com"];

/**
 * Hosts a download may touch: the course's Canvas host and Canvas's file stores (inst-fs on
 * inscloudgate.net, Instructure's S3 bucket by exact host, canvas-user-content.com).
 */
export function allowedHost(host: string, canvasHost: string = CANVAS_HOST): boolean {
  const h = host.toLowerCase();
  return (
    h === canvasHost.toLowerCase() ||
    /^([a-z0-9-]+\.)+inscloudgate\.net$/.test(h) ||
    S3_HOSTS.includes(h) ||
    /^([a-z0-9-]+\.)+canvas-user-content\.com$/.test(h)
  );
}

/** A file id we may put in a file name: a positive integer. */
export const validFileId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
const validExt = (ext: unknown): ext is FileExt => typeof ext === "string" && (EXTENSIONS as readonly string[]).includes(ext);

/** The part of a Canvas file object the plan reads (raw export object). */
export interface ExportFile {
  id: number;
  display_name?: string;
  filename?: string;
  "content-type"?: string;
  url?: string;
  size?: number;
  created_at?: string;
}

/** The part of an import item the plan reads (lib/import ImportItem or a roles.json row). */
export interface PlanItem {
  fileId: number;
  name: string;
  role: ItemRole | string;
  /** Best version first (lib/import groupVersions); its first entry is the file to fetch. */
  versions?: number[];
}

export interface DownloadTarget {
  fileId: number;
  itemId: string;
  name: string;
  role: string;
  ext: FileExt;
  url: string | null;
  /** Canvas's stored file name and size, for matching a local copy. */
  filename?: string;
  size?: number;
  /** When Canvas says the file was uploaded (created_at), to order same-name versions. */
  createdAt?: string;
  /** The item's other versions with the same extension (best first), for matching a local copy. */
  alternates?: { fileId: number; name: string; filename?: string; size?: number; createdAt?: string }[];
}

/** "local": copied from the student's own download of the Files tab (private/files/<COURSE>/). */
export type DownloadStatus = "downloaded" | "local" | "present" | "failed";

export interface DownloadResult {
  fileId: number;
  itemId: string;
  name: string;
  role: string;
  ext: FileExt;
  /** Relative to the files directory, e.g. "1234.pdf"; null when it failed. */
  file: string | null;
  status: DownloadStatus;
  bytes?: number;
  reason?: string;
}

export interface DownloadDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  exists: (file: string) => Promise<boolean>;
  /** Writes a temp file (e.g. "1234.pdf.part"); only `rename` makes it count. */
  write: (file: string, bytes: Uint8Array) => Promise<void>;
  /** Moves the finished temp file to its final name (atomic on one filesystem). */
  rename: (from: string, to: string) => Promise<void>;
  /** Removes a temp file left by a failed write (best effort). */
  remove?: (file: string) => Promise<void>;
  /** Copies a local file (a LocalFile.path) to a temp file in the files directory. */
  copyLocal?: (path: string, tmp: string) => Promise<void>;
}

export interface DownloadOptions {
  /** Local copies to use before any URL, by file id (from matchLocal). */
  local?: Map<number, LocalFile>;
  /**
   * Fetch signed links from the network. Off by default: without it nothing is fetched and every
   * file that isn't already present or local is recorded as failed with DOWNLOAD_DISABLED.
   */
  network?: boolean;
  onProgress?: (done: number, total: number) => void;
  canvasHost?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

export function extOf(name: string, contentType: string | null | undefined): FileExt | null {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const byName = m && validExt(m[1]) ? m[1] : null;
  if (byName) return byName;
  const ct = (contentType ?? "").toLowerCase();
  if (ct === "application/pdf") return "pdf";
  if (ct.includes("presentationml")) return "pptx";
  if (ct.includes("wordprocessingml")) return "docx";
  if (ct.startsWith("text/vtt")) return "vtt";
  if (ct.startsWith("text/plain")) return "txt";
  return null;
}

/**
 * Which files to fetch: every kept item's chosen version (PDF over slides, "revised" over plain,
 * as lib/import ordered `versions`), PDFs first, then by name. Items we can't read, or whose
 * file id isn't a positive integer, are left out.
 */
export function planDownloads(files: ExportFile[], items: PlanItem[], roles: readonly string[] = DOWNLOAD_ROLES): DownloadTarget[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const targets: DownloadTarget[] = [];
  for (const it of items) {
    if (!roles.includes(it.role)) continue;
    const fileId = it.versions && it.versions.length ? it.versions[0] : it.fileId;
    if (!validFileId(fileId)) continue;
    const f = byId.get(fileId);
    const name = f?.display_name ?? f?.filename ?? it.name;
    const ext = extOf(name, f?.["content-type"]);
    if (!ext) continue;
    const alternates: NonNullable<DownloadTarget["alternates"]> = [];
    for (const id of it.versions ?? []) {
      const v = byId.get(id);
      if (id === fileId || !validFileId(id) || !v) continue;
      const vName = v.display_name ?? v.filename;
      if (vName && extOf(vName, v["content-type"]) === ext) alternates.push({ fileId: id, name: vName, filename: v.filename, size: v.size, createdAt: v.created_at });
    }
    targets.push({ fileId, itemId: `file:${fileId}`, name, role: it.role, ext, url: f?.url ?? null, filename: f?.filename, size: f?.size, createdAt: f?.created_at, ...(alternates.length ? { alternates } : {}) });
  }
  const rank = (t: DownloadTarget) => (t.ext === "pdf" ? 0 : 1);
  return targets.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.fileId - b.fileId);
}

function isLogin(url: URL): boolean {
  return /^\/login(\/|$)/.test(url.pathname);
}

/** The body, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

type Limits = { canvasHost: string; maxBytes: number; signal: AbortSignal };

/** Fetches one URL with no credentials, following https redirects by hand, allowed hosts only. */
async function fetchSigned(deps: DownloadDeps, url: string, lim: Limits): Promise<{ bytes: Uint8Array } | { reason: string }> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { reason: "bad URL" };
  }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== "https:") return { reason: "not https" };
      // Real fetch refuses these already; checked here too because deps.fetch is swappable.
      if (current.username || current.password) return { reason: "link carries a username or password" };
      if (!allowedHost(current.hostname, lim.canvasHost)) return { reason: `host not allowed: ${current.hostname}` };
      if (isLogin(current)) return { reason: "needs a signed URL: Canvas asked for a login (re-export)" };
      // credentials: "omit" and no headers: nothing identifying the student is ever sent.
      const res = await deps.fetch(current.toString(), { credentials: "omit", redirect: "manual", signal: lim.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { reason: `HTTP ${res.status} without a location` };
        current = new URL(loc, current);
        continue;
      }
      if (res.status === 401 || res.status === 403) return { reason: `HTTP ${res.status}: link expired or not signed (re-export)` };
      if (!res.ok) return { reason: `HTTP ${res.status}` };
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type.startsWith("text/html")) return { reason: "got an HTML page instead of the file (login or expired link; re-export)" };
      const length = Number(res.headers.get("content-length"));
      const cap = lim.maxBytes >= 1024 * 1024 ? `${Math.round(lim.maxBytes / 1024 / 1024)} MB` : `${lim.maxBytes} bytes`;
      const tooLarge = { reason: `larger than ${cap}` };
      if (Number.isFinite(length) && length > lim.maxBytes) return tooLarge;
      const bytes = await readCapped(res, lim.maxBytes);
      return bytes ? { bytes } : tooLarge;
    }
    return { reason: "too many redirects" };
  } catch (e) {
    if (lim.signal.aborted) return { reason: "timed out" };
    return { reason: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** At most `limit` calls of fn at once, results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function downloadAll(targets: DownloadTarget[], deps: DownloadDeps, opts: DownloadOptions = {}): Promise<DownloadResult[]> {
  const canvasHost = opts.canvasHost ?? CANVAS_HOST;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  let done = 0;
  return mapLimit(targets, MAX_IN_FLIGHT, async (t): Promise<DownloadResult> => {
    const base = { fileId: t.fileId, itemId: t.itemId, name: t.name, role: t.role, ext: t.ext };
    let result: DownloadResult;
    if (!validFileId(t.fileId) || !validExt(t.ext)) {
      result = { ...base, file: null, status: "failed", reason: "bad file id or extension" };
    } else {
      const local = opts.local?.get(t.fileId);
      // The local copy is another version of the item: that version becomes the item's file.
      if (local?.version && validFileId(local.version.fileId)) {
        Object.assign(base, { fileId: local.version.fileId, itemId: `file:${local.version.fileId}`, name: local.version.name });
      }
      const file = `${base.fileId}.${t.ext}`;
      if (await deps.exists(file)) {
        result = { ...base, file, status: "present" };
      } else if (local && deps.copyLocal) {
        const tmp = `${file}.part`;
        try {
          await deps.copyLocal(local.path, tmp);
          await deps.rename(tmp, file);
          result = { ...base, file, status: "local", bytes: local.size };
        } catch (e) {
          await deps.remove?.(tmp).catch(() => {});
          result = { ...base, file: null, status: "failed", reason: `couldn't copy the local file: ${e instanceof Error ? e.message : String(e)}` };
        }
      } else if (!opts.network) {
        result = { ...base, file: null, status: "failed", reason: DOWNLOAD_DISABLED };
      } else if (!t.url) {
        result = { ...base, file: null, status: "failed", reason: "no URL in the export" };
      } else {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const got = await fetchSigned(deps, t.url, { canvasHost, maxBytes, signal: ctrl.signal }).finally(() => clearTimeout(timer));
        if ("bytes" in got) {
          const tmp = `${file}.part`;
          try {
            await deps.write(tmp, got.bytes);
            await deps.rename(tmp, file);
            result = { ...base, file, status: "downloaded", bytes: got.bytes.length };
          } catch (e) {
            await deps.remove?.(tmp).catch(() => {});
            result = { ...base, file: null, status: "failed", reason: `couldn't save: ${e instanceof Error ? e.message : String(e)}` };
          }
        } else {
          result = { ...base, file: null, status: "failed", reason: got.reason };
        }
      }
    }
    opts.onProgress?.(++done, targets.length);
    return result;
  });
}

// ---------- local files: the student's own download of the Files tab ----------
//
// private/files/<COURSE>/ holds what the student downloaded from Canvas's Files tab: loose files,
// or the .zip Canvas makes (unpacked by the caller with zipEntries/zipEntryBytes, safely). Each
// planned file is matched by its display name (then Canvas's stored name), and by size when the
// export knows it.

/** A regular file found under the local folder (symlinks are never listed). */
export interface LocalFile {
  /** Relative to the local folder, e.g. "Week 3/Heaps.pdf". */
  path: string;
  /** Its base name, e.g. "Heaps.pdf". */
  name: string;
  size: number;
  /** Set by matchLocal when this copy is another version of the item than the chosen one. */
  version?: { fileId: number; name: string };
}

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase();

/** A target whose local copy can't be told apart (see matchLocal): not guessed, reported. */
export interface AmbiguousLocal {
  fileId: number;
  name: string;
  /** The matching local paths (relative to the local folder). */
  paths: string[];
}

type Version = NonNullable<DownloadTarget["alternates"]>[number];
type Pick = { kind: "none" } | { kind: "ambiguous"; paths: string[] } | { kind: "match"; version: Version; file: LocalFile };

/**
 * Which local file is each target's, keyed by the target's file id. Files over the size cap never
 * match. A local file matches a version of the item when its name is that version's display name
 * (then Canvas's stored name) and, when the export knows it, its size. Every version is tried, not
 * only the chosen one: a copy whose display name matches the export exactly is used even when its
 * size is a non-chosen version's (it is then that version, `version`). Nothing is guessed:
 *   - a version with more than one local copy left after the name and size filter is ambiguous
 *     (same name and size may still be different content);
 *   - versions with the chosen file's exact display name come first. When several of them have a
 *     local copy, the newest upload wins only if the export's sizes tell the copies apart and its
 *     dates (created_at) order them; otherwise the target is ambiguous;
 *   - then the item's other versions, in the import's order.
 * Ambiguous targets are left unmatched and pushed to `ambiguous` (if given) for the report.
 */
export function matchLocal(targets: DownloadTarget[], local: LocalFile[], maxBytes: number = MAX_BYTES, ambiguous?: AmbiguousLocal[]): Map<number, LocalFile> {
  const byName = new Map<string, LocalFile[]>();
  for (const f of local) {
    if (f.size > maxBytes) continue;
    const k = norm(f.name);
    byName.set(k, [...(byName.get(k) ?? []), f]);
  }
  const candidates = (v: Version): LocalFile[] => {
    let cands = byName.get(norm(v.name)) ?? [];
    if (!cands.length && v.filename) cands = byName.get(norm(v.filename)) ?? [];
    return typeof v.size === "number" ? cands.filter((f) => f.size === v.size) : cands;
  };
  const paths = (fs: LocalFile[]) => [...new Set(fs.map((f) => f.path))].sort();
  /** One version's copy: none, ambiguous (no size and several copies), or the copy. */
  const one = (v: Version): Pick => {
    const c = candidates(v);
    if (!c.length) return { kind: "none" };
    // Several copies left after the name and size filter may differ in content: never take one at random.
    if (c.length > 1) return { kind: "ambiguous", paths: paths(c) };
    return { kind: "match", version: v, file: c[0] };
  };
  /** Same-name versions: one copy, or the newest when sizes and dates make it unambiguous. */
  const newest = (vs: Version[]): Pick => {
    const picks = vs.map(one).filter((p) => p.kind !== "none");
    if (!picks.length) return { kind: "none" };
    const bad = picks.filter((p) => p.kind === "ambiguous");
    if (bad.length) return { kind: "ambiguous", paths: [...new Set(picks.flatMap((p) => (p.kind === "ambiguous" ? p.paths : p.kind === "match" ? [p.file.path] : [])))].sort() };
    const hits = picks as Extract<Pick, { kind: "match" }>[];
    if (hits.length === 1) return hits[0];
    const distinctFiles = new Set(hits.map((h) => h.file.path)).size === hits.length;
    const distinctSizes = hits.every((h) => typeof h.version.size === "number") && new Set(hits.map((h) => h.version.size)).size === hits.length;
    const times = hits.map((h) => Date.parse(h.version.createdAt ?? ""));
    const dated = times.every((x) => Number.isFinite(x)) && new Set(times).size === hits.length;
    if (!distinctFiles || !distinctSizes || !dated) return { kind: "ambiguous", paths: paths(hits.map((h) => h.file)) };
    return hits[times.indexOf(Math.max(...times))];
  };
  const out = new Map<number, LocalFile>();
  for (const t of targets) {
    const all: Version[] = [{ fileId: t.fileId, name: t.name, filename: t.filename, size: t.size, createdAt: t.createdAt }, ...(t.alternates ?? [])];
    const sameName = all.filter((v) => norm(v.name) === norm(t.name));
    let pick = newest(sameName);
    for (const v of all.filter((x) => !sameName.includes(x))) {
      if (pick.kind !== "none") break;
      pick = one(v);
    }
    if (pick.kind === "ambiguous") ambiguous?.push({ fileId: t.fileId, name: t.name, paths: pick.paths });
    else if (pick.kind === "match") out.set(t.fileId, pick.version.fileId === t.fileId ? pick.file : { ...pick.file, version: { fileId: pick.version.fileId, name: pick.version.name } });
  }
  return out;
}

/** Total uncompressed bytes one zip may unpack to. */
export const MAX_ZIP_TOTAL = 4 * 1024 * 1024 * 1024;

/**
 * A zip entry's name as a safe relative path, or null: no absolute paths (/x, \x, C:), no `..`,
 * no backslashes or NUL, no empty segments. "./" segments are dropped.
 */
export function safeZipPath(name: string): string | null {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split("/").filter((p) => p !== ".");
  if (parts.some((p) => p === ".." || p === "")) return null;
  return parts.length ? parts.join("/") : null;
}

export interface ZipEntry {
  path: string;
  size: number;
  method: number;
  compressedSize: number;
  dataStart: number;
}

/** The entries of a zip that are safe to unpack, and the ones refused with why. Directories and macOS metadata are skipped. */
export function zipEntries(bytes: Uint8Array, maxBytes: number = MAX_BYTES): { entries: ZipEntry[]; refused: { name: string; reason: string }[] } {
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
  if (count === 0xffff || p === 0xffffffff) throw new Error("zip64 archives aren't supported (unzip it in Finder instead)");
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  const refused: { name: string; reason: string }[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip central directory");
    const madeBy = view.getUint16(p + 4, true) >> 8;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const attrs = view.getUint32(p + 38, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name)) continue;
    const refuse = (reason: string) => refused.push({ name, reason });
    const path = safeZipPath(name);
    if (!path) refuse("unsafe path");
    else if (madeBy === 3 && ((attrs >>> 16) & 0o170000) === 0o120000) refuse("symlink");
    else if (flags & 1) refuse("encrypted");
    else if (method !== 0 && method !== 8) refuse(`compression method ${method}`);
    else if (size === 0xffffffff || compressedSize === 0xffffffff || local === 0xffffffff) refuse("zip64 entry");
    else if (size > maxBytes) refuse("over the size cap");
    else if (total + size > MAX_ZIP_TOTAL) refuse("zip total over the cap");
    else if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) refuse("bad local header");
    else {
      const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (dataStart + compressedSize > bytes.length) refuse("truncated");
      else {
        total += size;
        entries.push({ path, size, method, compressedSize, dataStart });
      }
    }
  }
  return { entries, refused };
}

/** One entry's bytes; throws if it inflates past its declared size or the cap (zip bombs). */
export function zipEntryBytes(bytes: Uint8Array, e: ZipEntry, maxBytes: number = MAX_BYTES): Uint8Array {
  const data = bytes.subarray(e.dataStart, e.dataStart + e.compressedSize);
  const out = e.method === 0 ? data : new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.min(maxBytes, Math.max(e.size, 1)) }));
  if (out.length !== e.size) throw new Error("size doesn't match the zip directory");
  return out;
}
