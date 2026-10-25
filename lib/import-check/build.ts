// The import check (pure): what the course pipeline found, from its own report data. Files by role
// with what came from the local folder, what was downloaded, what download being off held back and
// what couldn't be fetched (each said as it is); every exam field with its source or "not found"
// (a quiz with no quoted date uses its Canvas due date, labelled as such, as on the course home);
// gaps (modules and exam topics with no material, after looking every way we can); and the practice
// questions. Counts only come from the files; nothing is estimated.

import { easternDate, formatExamDate, isMajorExam, searchedText, sourceLabel, stems, topicStems } from "../home/build.ts";
import type { HomeModuleInput } from "../home/types.ts";
import type { PipelineExam, SourceRef } from "../pipeline/types.ts";
import type { Sourced } from "../schema.ts";

/** The reason the download stage gives when downloading is switched off (lib/pipeline/download.ts). */
export const DOWNLOAD_OFF_REASON = "download disabled";

// ---------- Input ----------

export interface ImportCheckInputs {
  course: { code: string; name: string | null; importedAt: string | null };
  /** When the pipeline wrote its output (ISO), or null. */
  ranAt: string | null;
  /** ISO date-time the check is built for (exams before today are "already taken"). */
  now: string;
  /** Lecture recordings with a transcript the pipeline read, or null when not reported. */
  recordings: number | null;
  /** downloads.json: one row per course file the pipeline wanted. status: local | downloaded | present | failed (with a reason). */
  downloads: { role: string; status: string; reason?: string | null; ext?: string | null }[];
  /** Files in the local folder that matched no course file, or null when not reported. */
  localUnmatched: number | null;
  /** docs.json: every file and page the pipeline read, by role, with its text (empty when it had none). */
  docs: { name: string; role: string; hasText: boolean; problem: string | null; text?: string }[];
  /** The Canvas export's own items (null when there's no export). */
  canvas: { pages: number | null; announcements: number | null; assignments: number | null };
  exams: (PipelineExam & { windowCloses?: { value: string; itemId: string } | null })[];
  modules: HomeModuleInput[];
  /** The practice questions: topic, the file their quote is from, and what their rewind shows. */
  questions: { topic: string; source: string; clip: boolean; slide: "slide" | "document" | null; fallback: string | null }[];
  /** The generator's tally (kept / dropped by the checks), or null when not reported. */
  generated: { kept: number; dropped: number } | null;
}

// ---------- Output ----------

export interface FileRow {
  role: string;
  label: string;
  /** File types and counts ("PDF 78, PPTX 43"), from the data. */
  types: string | null;
  total: number;
  local: number;
  downloaded: number;
  /** Not downloaded because downloading is off. */
  off: number;
  /** Tried and couldn't be fetched (a link that needs a Canvas login, a bad id...). */
  failed: number;
}

export type CheckField =
  | { state: "found"; text: string; source: string; link: { href: string; label: string } | null }
  | { state: "missing" };

export interface ExamRow {
  id: string;
  name: string;
  date: CheckField;
  /** quote: a word-for-word date; canvas-due: a quiz's Canvas due date (metadata, labelled). */
  dateKind: "quote" | "canvas-due" | null;
  /** Eastern day of the date or due date, or null when neither was found. */
  day: string | null;
  fields: { label: string; field: CheckField }[];
  /** Fields not found, in words ("room, format"), or null when everything was found. */
  missing: string | null;
  past: boolean;
  searched: string;
}

export interface Gap {
  kind: "module" | "exam-topic";
  label: string;
  docs: number;
  questions: number;
  /** Files named for it whose text isn't there (not downloaded). */
  noText: number;
  text: string;
}

export interface ImportCheck {
  course: ImportCheckInputs["course"];
  ranAt: string | null;
  recordings: number | null;
  files: { rows: FileRow[]; lines: string[]; canvas: { label: string; count: number | null }[] };
  /** Next one first; then exams whose date wasn't found; past ones last (already taken). */
  exams: { upcoming: ExamRow[]; undated: ExamRow[]; past: ExamRow[] };
  gaps: Gap[];
  /** Modules and exam topics with material and questions. */
  covered: number;
  /** What the gap check looked through, in words. */
  searched: string;
  questions: { total: number; kept: number | null; dropped: number | null; withClip: number; withSlide: number; withDocument: number; fallbacks: { label: string; count: number }[] } | null;
}

const ROLE_LABEL: Record<string, string> = {
  lecture: "Lecture slides",
  review: "Past exam reviews",
  practice: "Practice handouts",
  syllabus: "Syllabus",
  transcript: "Transcripts",
  homework: "Homework",
  admin: "Course admin",
  unknown: "Unclassified",
};
const ROLE_ORDER = ["lecture", "review", "practice", "syllabus", "transcript"];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Files by role (from the download plan), with what happened to them in plain words. */
export function fileRows(inp: Pick<ImportCheckInputs, "downloads" | "localUnmatched">): { rows: FileRow[]; lines: string[] } {
  const by = new Map<string, FileRow & { exts: Map<string, number> }>();
  const failedWhy = new Map<string, number>();
  for (const d of inp.downloads) {
    const r = by.get(d.role) ?? { role: d.role, label: ROLE_LABEL[d.role] ?? d.role, types: null, total: 0, local: 0, downloaded: 0, off: 0, failed: 0, exts: new Map<string, number>() };
    r.total++;
    if (d.ext) r.exts.set(d.ext.toUpperCase(), (r.exts.get(d.ext.toUpperCase()) ?? 0) + 1);
    if (d.status === "local") r.local++;
    else if (d.status === "downloaded" || d.status === "present") r.downloaded++;
    else if (d.status === "failed" && d.reason === DOWNLOAD_OFF_REASON) r.off++;
    else if (d.status === "failed") {
      r.failed++;
      const why = d.reason || "no reason given";
      failedWhy.set(why, (failedWhy.get(why) ?? 0) + 1);
    }
    by.set(d.role, r);
  }
  const rows: FileRow[] = [...by.values()]
    .sort((a, b) => (ROLE_ORDER.indexOf(a.role) + 1 || 99) - (ROLE_ORDER.indexOf(b.role) + 1 || 99) || a.role.localeCompare(b.role))
    .map(({ exts, ...r }) => ({ ...r, types: exts.size ? [...exts].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(", ") : null }));
  const sum = (k: "local" | "downloaded" | "off" | "failed") => rows.reduce((a, r) => a + r[k], 0);
  const lines: string[] = [];
  if (sum("local")) lines.push(`${plural(sum("local"), "file")} came from your local folder.`);
  if (sum("downloaded")) lines.push(`${plural(sum("downloaded"), "file was", "files were")} downloaded.`);
  if (sum("off")) lines.push(`${plural(sum("off"), "file wasn't", "files weren't")} downloaded: download is off.`);
  for (const [why, n] of [...failedWhy].sort((a, b) => b[1] - a[1])) lines.push(`${plural(n, "file")} couldn't be fetched (${why}).`);
  if (inp.localUnmatched) lines.push(`${plural(inp.localUnmatched, "file")} in your local folder matched no course file.`);
  if (!rows.length) lines.push("The pipeline's download plan wasn't found.");
  return { rows, lines };
}

/** "12 local · 109 couldn't be fetched" for one row, with the verbs agreeing. */
export function rowDetail(r: FileRow): string {
  const bits = [`${r.local} local`];
  if (r.downloaded) bits.push(`${r.downloaded} downloaded`);
  if (r.off) bits.push(`${r.off} not downloaded (download is off)`);
  if (r.failed) bits.push(`${r.failed} couldn't be fetched`);
  return `${r.total}${r.types ? ` (${r.types})` : ""} · ${bits.join(" · ")}`;
}

// ---------- Exams ----------

const EXAM_FIELDS: { key: "location" | "format" | "notesRule" | "topics"; label: string }[] = [
  { key: "location", label: "room" },
  { key: "format", label: "format" },
  { key: "notesRule", label: "notes rule" },
  { key: "topics", label: "topics" },
];

function refFor(searched: SourceRef[], itemId: string | null) {
  const ref = searched.find((r) => r.itemId === itemId);
  const href = ref && "href" in ref ? ref.href : undefined;
  return { ref, link: href ? { href, label: "Open in Canvas" } : null };
}

function checkField(s: Sourced<unknown> | null | undefined, searched: SourceRef[], text: (v: unknown) => string | null): CheckField {
  if (!s || s.value == null || !s.quote) return { state: "missing" };
  const shown = text(s.value);
  if (!shown) return { state: "missing" };
  const { ref, link } = refFor(searched, s.itemId);
  return { state: "found", text: shown, source: ref ? sourceLabel(ref) : "Canvas item", link };
}

const asText = (v: unknown): string | null => (Array.isArray(v) ? (v.length ? v.join(", ") : null) : typeof v === "string" ? v : null);

/**
 * Each exam with every field's source or "not found", in the order to read them: upcoming (next one
 * first), then those whose date wasn't found, then past ones. A quiz (not an exam) with no quoted
 * date uses its Canvas due date, labelled "Canvas due date (not a quote)", as on the course home.
 */
export function examRows(exams: ImportCheckInputs["exams"], now: string): ImportCheck["exams"] {
  const today = easternDate(now) ?? "";
  const rows = exams.map((e, i) => {
    const searched = e.searched ?? [];
    let date = checkField(e.date, searched, (v) => (typeof v === "string" ? formatExamDate(v) : null));
    let dateKind: ExamRow["dateKind"] = date.state === "found" ? "quote" : null;
    let day = date.state === "found" ? easternDate(e.date.value) : null;
    if (date.state === "missing" && e.windowCloses && !isMajorExam(e)) {
      const text = formatExamDate(e.windowCloses.value);
      if (text) {
        date = { state: "found", text: `Due ${text}`, source: "Canvas due date (not a quote)", link: refFor(searched, e.windowCloses.itemId).link };
        dateKind = "canvas-due";
        day = easternDate(e.windowCloses.value);
      }
    }
    const fields = EXAM_FIELDS.map(({ key, label }) => ({ label, field: checkField(e[key] as Sourced<unknown>, searched, asText) }));
    const missing = [...(date.state === "missing" ? ["date"] : []), ...fields.filter((f) => f.field.state === "missing").map((f) => f.label)];
    const row: ExamRow = {
      id: e.id,
      name: e.name?.value && e.name.quote ? e.name.value : e.id.replace(/^exam:/, ""),
      date,
      dateKind,
      day,
      fields,
      missing: missing.length ? missing.join(", ") : null,
      past: !!day && day < today,
      searched: searchedText(searched),
    };
    return { row, i };
  });
  const byDay = (a: { row: ExamRow; i: number }, b: { row: ExamRow; i: number }) => a.row.day!.localeCompare(b.row.day!) || a.i - b.i;
  return {
    upcoming: rows.filter((r) => r.row.day && !r.row.past).sort(byDay).map((r) => r.row),
    undated: rows.filter((r) => !r.row.day).map((r) => r.row),
    past: rows.filter((r) => r.row.past).sort((a, b) => -byDay(a, b)).map((r) => r.row),
  };
}

// ---------- Gaps ----------

/** Material roles that can cover a topic (not homework, admin or transcripts, whose titles just restate topics). */
const MATERIAL = new Set(["lecture", "review", "practice", "syllabus", "unknown"]);
/** A file's text covers a topic when it says the topic's words together this often. */
export const TEXT_MIN = 3;

/** A name's word stems, with CamelCase split ("HashTables" → hash, table). */
const nameStems = (s: string) => new Set(stems(s.replace(/([a-z])([A-Z])/g, "$1 $2")));

/** Does `text` name `topic`? At least half its topic words (rounded up) appear. Topics with no such words can't be checked. */
export function names(topic: string, text: string): boolean | null {
  const want = topicStems(topic);
  if (!want.length) return null;
  const have = nameStems(text);
  return want.filter((w) => have.has(w)).length >= Math.ceil(want.length / 2);
}

/** "Dynamic Programming" → "DP", "Binary Search Trees" → "BST" (two words or more), else null. */
export function acronym(topic: string): string | null {
  const words = topicStems(topic);
  return words.length >= 2 ? words.map((w) => w[0].toUpperCase()).join("") : null;
}

/** Does a title use the topic's acronym as a word ("Discussion 14_ DP and ...")? */
export function namesByAcronym(topic: string, title: string): boolean {
  const a = acronym(topic);
  if (!a) return false;
  return title.split(/[^A-Za-z]+/).some((w) => w === a || w === `${a}s`);
}

/** How often `text` says the topic's words together ("binary search tree(s)"), plurals folded. */
export function phraseCount(topic: string, text: string): number {
  const words = topic
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2 && !/^(and|or|the|of|a|an)$/.test(w));
  if (!words.length) return 0;
  const esc = (w: string) => w.replace(/s$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${words.map((w) => `${esc(w)}(?:e?s)?`).join("[\\s-]+(?:and\\s+|&\\s+)?")}\\b`, "gi");
  return (text.match(re) ?? []).length;
}

/**
 * Gaps: every module (by its topic) and every exam topic found, against the material that exists. A file
 * covers a topic when its title names it, uses its acronym (DP, BST), names the module the topic is
 * listed in (by the module's own items), or its text says the topic TEXT_MIN+ times. A question covers it
 * when it names it or is quoted from a covering file. Nothing found: "No material found for X";
 * material but no questions: "No practice questions yet for X". Topics with no checkable words are
 * skipped, never guessed.
 */
export function findGaps(
  modules: HomeModuleInput[],
  examTopics: string[],
  docs: ImportCheckInputs["docs"],
  questions: ImportCheckInputs["questions"],
): { gaps: Gap[]; covered: number; searched: string } {
  const material = docs.filter((d) => MATERIAL.has(d.role));
  const sorted = [...modules].sort((a, b) => a.position - b.position);
  const subjects: { kind: Gap["kind"]; label: string; topic: string; module: HomeModuleInput | null }[] = [
    ...sorted.filter((m) => m.topic).map((m) => ({ kind: "module" as const, label: `Mod ${m.position}: ${m.topic}`, topic: m.topic!, module: m })),
    ...[...new Set(examTopics.map((t) => t.trim()).filter(Boolean))].map((t) => ({ kind: "exam-topic" as const, label: t, topic: t, module: null })),
  ];
  const gaps: Gap[] = [];
  let covered = 0;
  for (const s of subjects) {
    if (names(s.topic, "x") === null) continue;
    // The modules it belongs to: its own, or any whose items name it (a quiz "… Binary Search Trees" in Module 4).
    const homes = s.module ? [s.module] : sorted.filter((m) => m.topic && m.itemTitles.some((t) => names(s.topic, t) || namesByAcronym(s.topic, t)));
    const covers = (d: ImportCheckInputs["docs"][number]) =>
      names(s.topic, d.name) ||
      namesByAcronym(s.topic, d.name) ||
      homes.some((m) => m !== s.module && names(m.topic!, d.name)) ||
      (!!d.text && phraseCount(s.topic, d.text) >= TEXT_MIN);
    const docsWith = material.filter(covers);
    const usable = docsWith.filter((d) => d.hasText);
    const noText = docsWith.length - usable.length;
    const sources = new Set(usable.map((d) => d.name));
    const qs = questions.filter((q) => names(s.topic, `${q.topic} ${q.source}`) || namesByAcronym(s.topic, q.source) || sources.has(q.source)).length;
    if (!usable.length && !qs) {
      gaps.push({ kind: s.kind, label: s.label, docs: 0, questions: 0, noText, text: `No material found for ${s.label}${noText ? ` (${plural(noText, "file names", "files name")} it but ${verb(noText, "isn't", "aren't")} downloaded)` : ""}.` });
    } else if (!qs) {
      gaps.push({ kind: s.kind, label: s.label, docs: usable.length, questions: 0, noText, text: `No practice questions yet for ${s.label} (${plural(usable.length, "file")} with text).` });
    } else covered++;
  }
  const searched = `Searched ${plural(material.length, "file")}' titles and text, ${plural(sorted.length, "module")}' items and ${plural(questions.length, "practice question")}`;
  return { gaps, covered, searched: searched.replace("1 file'", "1 file's").replace("1 module'", "1 module's") };
}

// ---------- All ----------

export function buildImportCheck(inp: ImportCheckInputs): ImportCheck {
  const { rows, lines } = fileRows(inp);
  const examTopics = inp.exams.flatMap((e) => (e.topics?.value && e.topics.quote ? e.topics.value : []));
  const { gaps, covered, searched } = findGaps(inp.modules, examTopics, inp.docs, inp.questions);
  const q = inp.questions;
  const fallbackCounts = new Map<string, number>();
  for (const x of q) if (!x.clip && x.fallback) fallbackCounts.set(x.fallback, (fallbackCounts.get(x.fallback) ?? 0) + 1);
  const FALLBACK: Record<string, string> = { slide: "point to a slide instead", reading: "point to a reading instead", none: "have nothing to play" };
  return {
    course: inp.course,
    ranAt: inp.ranAt,
    recordings: inp.recordings,
    files: {
      rows,
      lines,
      canvas: [
        { label: "Canvas pages", count: inp.canvas.pages },
        { label: "Announcements", count: inp.canvas.announcements },
        { label: "Assignments", count: inp.canvas.assignments },
      ],
    },
    exams: examRows(inp.exams, inp.now),
    gaps,
    covered,
    searched,
    questions:
      q.length || inp.generated
        ? {
            total: q.length,
            kept: inp.generated?.kept ?? null,
            dropped: inp.generated?.dropped ?? null,
            withClip: q.filter((x) => x.clip).length,
            withSlide: q.filter((x) => x.slide === "slide").length,
            withDocument: q.filter((x) => x.slide === "document").length,
            fallbacks: [...fallbackCounts].map(([k, n]) => ({ label: FALLBACK[k] ?? k, count: n })),
          }
        : null,
  };
}

/** "20%" of a whole, or "not found" when there's nothing to count. */
export const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "not found");
