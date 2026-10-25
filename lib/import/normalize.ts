// Turns a `*.course.json` export into a clean, deduped list of course files.
// Pure: no network, no Gemini.

import type {
  CanvasFile,
  CourseExport,
  FoundIn,
  ImportItem,
  ImportRole,
  NormalizedCourse,
  SkippedFile,
} from "./types.ts";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "heic", "tif", "tiff"]);
const SLIDE_EXT = new Set(["ppt", "pptx"]);

/** What a rule sees: the raw name, its words, and its stem (words without the extension). */
interface RuleInput {
  raw: string;
  /** Words: underscores to spaces, CamelCase and letter/digit boundaries split ("Exam1Review" -> "Exam 1 Review"). */
  text: string;
  /** `text` without the file extension(s) and a "(N)" copy suffix. */
  stem: string;
  /** The file was found inside at least one module. */
  inModule: boolean;
}

interface RoleRule {
  role: Exclude<ImportRole, "unknown">;
  label: string;
  test: (n: RuleInput) => boolean;
  /** Shape rules look at the whole filename; they never run on module names. */
  filenameOnly?: boolean;
}

const re = (r: RegExp) => (n: RuleInput) => r.test(n.text);

// Checked in this order; the first match wins. Filename rules beat module-name rules.
// Shape rules come last, so a keyword ("Discussion 3 - Trees", "Exam 2 - Review") wins over them.
const ROLE_RULES: RoleRule[] = [
  { role: "transcript", label: "transcript", test: re(/\btranscripts?\b/i) },
  { role: "syllabus", label: "syllabus", test: re(/\bsyllabus\b/i) },
  {
    role: "review",
    label: "review or past exam",
    test: re(/\breview\b|\b(?:past|old|previous|sample|practice|mock)[\s_-]*(?:exams?|midterms?|finals?)\b/i),
  },
  { role: "review", label: "study guide", test: re(/\bstudy[\s-]*guides?\b/i) },
  // "Exam2.pdf" alone is a past exam.
  { role: "review", label: "past exam (Exam N)", test: (n) => /^exam\s*\d+$/i.test(n.stem), filenameOnly: true },
  {
    role: "practice",
    label: "discussion, handout or practice",
    test: re(/\bdiscussions?\b|\bhandouts?\b|\bworksheets?\b|\bpractice\b|\bproblem[\s_-]*sets?\b|\bexercises?\b/i),
  },
  { role: "lecture", label: "lecture or slides", test: re(/\blectures?\b|\blec[\s_-]*\d+|\bslides?\b/i) },
  {
    role: "admin",
    label: "schedule or policy",
    test: re(/\bschedule\b|\bcalendar\b|\bpolic(?:y|ies)\b|\bhonor[\s_-]*code\b|\baccommodations?\b|\boffice[\s_-]*hours\b|\bgrading\b/i),
  },
  {
    role: "lecture",
    label: "slide version (accessible or revised)",
    test: (n) => /\b(?:accessible|revised)$/i.test(n.stem),
    filenameOnly: true,
  },
  // "M3_2_ABC1234_..." (module 3, deck 2).
  { role: "lecture", label: "module-numbered deck (M#_#_)", test: (n) => /^M\d+_\d+_/i.test(n.raw), filenameOnly: true },
  // "7 - Topic", "8b - Topic".
  { role: "lecture", label: "numbered deck (N - Topic)", test: (n) => /^\d+[a-z]?\s+-\s+\S/i.test(n.raw), filenameOnly: true },
  { role: "lecture", label: "lesson (L#) in a module", test: (n) => n.inModule && /^L\s*\d+$/i.test(n.stem), filenameOnly: true },
];

export function extensionOf(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

export function isImage(name: string, contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().startsWith("image/") || IMAGE_EXT.has(extensionOf(name));
}

/** "Lecture 4-1.pdf" -> "lecture 4". Drops the extension and one Canvas "-N" duplicate suffix. */
export function baseName(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/-\d+$/, "")
    .replace(/[\s_]+/g, " ")
    .trim()
    .toLowerCase();
}

function hasDupSuffix(name: string): boolean {
  return /-\d+$/.test(name.replace(/\.[a-z0-9]+$/i, ""));
}

/**
 * Word boundaries for the rules: "Lecture_04" -> "Lecture 04", "Exam1ReviewAnswers" ->
 * "Exam 1 Review Answers", "PDFNotes" -> "PDF Notes", "COP3530" -> "COP 3530".
 */
export function words(s: string): string {
  return s
    .replace(/_+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");
}

/** Strips document extensions (".pdf", also doubled ones like ".pdf.docx") and a "(N)" copy suffix. */
function stripExt(name: string): string {
  return name
    .replace(/(?:\.(?:pdf|pptx?|docx?|xlsx?|txt|md|html?|zip|key|odp|odt|rtf|csv|mp4|m4a|mp3))+$/i, "")
    .replace(/\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,5}$/i, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim();
}

function ruleInput(name: string, inModule: boolean): RuleInput {
  return { raw: name, text: words(name), stem: words(stripExt(name)).trim(), inModule };
}

export function classify(name: string, moduleNames: string[]): { role: ImportRole; reason: string | null } {
  const file = ruleInput(name, moduleNames.length > 0);
  for (const rule of ROLE_RULES) {
    if (rule.test(file)) return { role: rule.role, reason: `filename matches ${rule.label}` };
  }
  for (const m of moduleNames) {
    const mod = ruleInput(m, true);
    mod.stem = mod.text;
    for (const rule of ROLE_RULES) {
      if (!rule.filenameOnly && rule.test(mod)) return { role: rule.role, reason: `module "${m}" matches ${rule.label}` };
    }
  }
  return { role: "unknown", reason: null };
}

const VERSION_SUFFIX = /^(?:accessible|revised)$/i;

/**
 * Key shared by versions of one document: the stem's words, lowercased, without trailing
 * "accessible"/"revised", in order (sorting them would merge "M2_3_..." with "M3_2_...").
 * A Canvas "-N" suffix is kept: those are separate files unless name + size match.
 */
export function versionKey(name: string): { key: string; suffix: "revised" | "accessible" | null } {
  const tokens = words(stripExt(name)).toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);
  let suffix: "revised" | "accessible" | null = null;
  while (tokens.length > 1 && VERSION_SUFFIX.test(tokens[tokens.length - 1])) {
    const t = tokens.pop() as "revised" | "accessible";
    suffix ??= t;
  }
  return { key: tokens.join(" "), suffix };
}

/** Lower is better: PDF first, then "revised", then plain, then "accessible"; then lowest ID. */
function versionRank(it: { name: string; contentType: string | null; fileId: number }): number[] {
  const pdf = extensionOf(it.name) === "pdf" || it.contentType === "application/pdf" ? 0 : 1;
  const suffix = versionKey(it.name).suffix;
  return [pdf, suffix === "revised" ? 0 : suffix === null ? 1 : 2, it.fileId];
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Groups versions of the same document into one item (the best version), with every version's
 * file ID in `versions`. The role comes from the best version that has one (a plain "X.pdf"
 * the rules can't place takes the role of its "X_revised.pptx").
 */
export function groupVersions(items: ImportItem[]): ImportItem[] {
  const groups = new Map<string, ImportItem[]>();
  const order: string[] = [];
  for (const it of items) {
    const { key } = versionKey(it.name);
    const k = key || `#${it.fileId}`;
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k)!.push(it);
  }
  return order.map((k) => {
    const members = groups.get(k)!;
    if (members.length === 1) return { ...members[0], versions: [] };
    const sorted = [...members].sort((a, b) => compareRank(versionRank(a), versionRank(b)));
    const best = sorted[0];
    const roled = sorted.find((m) => m.role !== "unknown") ?? best;
    const foundIn: FoundIn[] = [];
    for (const m of sorted) for (const f of m.foundIn) if (!foundIn.some((x) => sameSource(x, f))) foundIn.push(f);
    return {
      ...best,
      role: roled.role,
      roleReason: roled.roleReason,
      foundIn,
      mergedFileIds: sorted.flatMap((m) => m.mergedFileIds),
      versions: sorted.map((m) => m.fileId),
    };
  });
}

// `/courses/:id/files/:fileId` in hrefs and Canvas's data-api-endpoint (`/api/v1/courses/:id/files/:fileId`).
const FILE_LINK = /\/courses\/(\d+)\/files\/(\d+)/g;

/**
 * File links in a page body: fileId, the best name the anchor offers (title attr, else text),
 * and whether the file is only ever embedded as an <img> (a banner or picture).
 */
export function fileLinksIn(html: string): { fileId: number; name: string | null; image: boolean }[] {
  const out = new Map<number, string | null>();
  const imgIds = new Set<number>();
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    for (const m of tag.matchAll(FILE_LINK)) imgIds.add(Number(m[2]));
  }
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  for (const a of anchors) {
    const open = a.match(/^<a\b[^>]*>/i)?.[0] ?? "";
    for (const m of open.matchAll(FILE_LINK)) {
      const id = Number(m[2]);
      const title = open.match(/\btitle\s*=\s*"([^"]*)"/i)?.[1];
      const text = decodeEntities(a.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
      const name = (title ? decodeEntities(title).trim() : "") || text || null;
      if (!out.has(id) || (out.get(id) === null && name)) out.set(id, name);
    }
  }
  const anchored = new Set(out.keys());
  // Links outside anchors (e.g. <img src> or iframes) still count, without a name.
  for (const m of html.matchAll(FILE_LINK)) {
    const id = Number(m[2]);
    if (!out.has(id)) out.set(id, null);
  }
  return [...out].map(([fileId, name]) => ({ fileId, name, image: imgIds.has(fileId) && !anchored.has(fileId) }));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface Candidate {
  fileId: number;
  name: string | null;
  contentType: string | null;
  size: number | null;
  fromFilesTab: boolean;
  /** Seen only as an <img> embed in a page. */
  imageEmbed: boolean;
  foundIn: FoundIn[];
}

type Named = Candidate & { name: string };

function sameSource(a: FoundIn, b: FoundIn): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function moduleNamesOf(c: { foundIn: FoundIn[] }): string[] {
  const names = c.foundIn.map((f) => (f.kind === "files" ? null : f.moduleName)).filter((n): n is string => !!n);
  return [...new Set(names)];
}

export function normalizeCourse(exp: CourseExport): NormalizedCourse {
  const courseId = exp.course.id;
  const byId = new Map<number, Candidate>();

  function add(fileId: number, info: Partial<Omit<Candidate, "fileId" | "foundIn">>, where: FoundIn) {
    let c = byId.get(fileId);
    if (!c) {
      c = { fileId, name: null, contentType: null, size: null, fromFilesTab: false, imageEmbed: true, foundIn: [] };
      byId.set(fileId, c);
    }
    // The Files tab is authoritative; other sources only fill gaps.
    if (info.fromFilesTab) {
      c.name = info.name ?? c.name;
      c.contentType = info.contentType ?? c.contentType;
      c.size = info.size ?? c.size;
      c.fromFilesTab = true;
    } else {
      c.name = c.name ?? info.name ?? null;
    }
    c.imageEmbed = c.imageEmbed && info.imageEmbed === true;
    if (!c.foundIn.some((f) => sameSource(f, where))) c.foundIn.push(where);
  }

  for (const f of exp.files ?? []) {
    add(f.id, fileInfo(f), { kind: "files" });
  }

  const pagesBySlug = new Map((exp.pages ?? []).map((p) => [p.url, p]));
  const scannedFromModule = new Set<string>();

  function scanPage(slug: string, moduleId: number | null, moduleName: string | null) {
    const page = pagesBySlug.get(slug);
    if (!page?.body) return;
    for (const link of fileLinksIn(page.body)) {
      add(link.fileId, { name: link.name, imageEmbed: link.image }, {
        kind: "page",
        pageUrl: page.url,
        pageTitle: page.title ?? null,
        moduleId,
        moduleName,
      });
    }
  }

  for (const mod of exp.modules ?? []) {
    const moduleName = mod.name ?? null;
    for (const item of mod.items ?? []) {
      if (item.type === "File" && typeof item.content_id === "number") {
        add(item.content_id, { name: item.title ?? null }, { kind: "module", moduleId: mod.id, moduleName });
      } else if (item.type === "Page" && item.page_url) {
        scanPage(item.page_url, mod.id, moduleName);
        scannedFromModule.add(item.page_url);
      }
    }
  }
  // Pages not reached through a module are still scanned.
  for (const page of exp.pages ?? []) {
    if (!scannedFromModule.has(page.url)) scanPage(page.url, null, null);
  }

  const skipped: SkippedFile[] = [];
  let candidates: Named[] = [];
  for (const c of byId.values()) {
    const name = c.name ?? `file ${c.fileId}`;
    if (c.imageEmbed || isImage(name, c.contentType)) skipped.push({ fileId: c.fileId, name, reason: "image" });
    else candidates.push({ ...c, name });
  }

  const merged = new Map<number, number[]>();
  function absorb(keep: Named, drop: Named) {
    for (const f of drop.foundIn) if (!keep.foundIn.some((k) => sameSource(k, f))) keep.foundIn.push(f);
    merged.set(keep.fileId, [...(merged.get(keep.fileId) ?? []), drop.fileId, ...(merged.get(drop.fileId) ?? [])]);
    merged.delete(drop.fileId);
  }

  // Name + size duplicates: same base name (ignoring a "-N" suffix), same extension, same known size.
  // Keep the copy without a suffix, else the lowest ID.
  candidates = dedupe(candidates, (c) => (c.size === null ? null : `${baseName(c.name)}|${extensionOf(c.name)}|${c.size}`), (a, b) => {
    const sa = hasDupSuffix(a.name);
    const sb = hasDupSuffix(b.name);
    if (sa !== sb) return sa ? b : a;
    return a.fileId <= b.fileId ? a : b;
  }, absorb);

  // PDF over PPTX of the same deck.
  const pdfByBase = new Map<string, Named>();
  for (const c of candidates) if (extensionOf(c.name) === "pdf") pdfByBase.set(baseName(c.name), c);
  candidates = candidates.filter((c) => {
    if (!SLIDE_EXT.has(extensionOf(c.name))) return true;
    const pdf = pdfByBase.get(baseName(c.name));
    if (!pdf) return true;
    absorb(pdf, c);
    return false;
  });

  const ruled: ImportItem[] = candidates.map((c) => {
    const { role, reason } = classify(c.name, moduleNamesOf(c));
    return {
      fileId: c.fileId,
      name: c.name,
      contentType: c.contentType,
      size: c.size,
      url: `/courses/${courseId}/files/${c.fileId}`,
      role,
      roleReason: reason,
      foundIn: c.foundIn,
      mergedFileIds: merged.get(c.fileId) ?? [],
    };
  });

  return { courseId, items: groupVersions(ruled), skipped };
}

function fileInfo(f: CanvasFile): Partial<Candidate> {
  return {
    name: f.display_name ?? f.filename ?? null,
    contentType: f["content-type"] ?? null,
    size: typeof f.size === "number" ? f.size : null,
    fromFilesTab: true,
  };
}

function dedupe<T>(
  list: T[],
  key: (x: T) => string | null,
  pick: (a: T, b: T) => T,
  onMerge: (keep: T, drop: T) => void,
): T[] {
  const kept = new Map<string, T>();
  const out: T[] = [];
  for (const x of list) {
    const k = key(x);
    if (k === null) {
      out.push(x);
      continue;
    }
    const prev = kept.get(k);
    if (!prev) {
      kept.set(k, x);
      out.push(x);
      continue;
    }
    const keep = pick(prev, x);
    const drop = keep === prev ? x : prev;
    onMerge(keep, drop);
    kept.set(k, keep);
    out[out.indexOf(prev)] = keep;
  }
  return out;
}
