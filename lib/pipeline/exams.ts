// Pipeline stage (T17): the course's exams, from the syllabus (body and files), assignments and
// announcements. Nothing is guessed: every field is a Sourced value whose quote appears word for
// word (whitespace normalised) in the cited source, or it is null ("not found").
//   - assignments named like an exam or quiz give a name straight from Canvas; their due_at is
//     the submission window's close (metadata, `windowCloses`), never the exam's date or a quote
//   - Gemini Flash (lib/prompts/syllabus-parse.ts) reads the syllabus, syllabus files, Canvas pages that mention an exam
//     and announcements; its quotes are checked here (word for word, and that they back the value), never trusted
//   - several sources for one exam: a newer announcement beats the syllabus, which beats an
//     assignment; when they disagree, both quotes are kept in `conflicts`

import type { Sourced } from "../schema.ts";
import {
  SYLLABUS_PARSE_SCHEMA,
  SYLLABUS_PARSE_SYSTEM,
  VERSION as SYLLABUS_PARSE_VERSION,
  syllabusParsePrompt,
  type ExamSourceText,
  type ParsedExam,
  type QuotedField,
  type SyllabusParseReply,
} from "../prompts/syllabus-parse.ts";
import type { ExtractedDoc, PipelineExam, SourceRef } from "./types.ts";

export { SYLLABUS_PARSE_VERSION };

/** Assignment names that are exams or quizzes... */
export const EXAM_NAME = /\b(exams?|midterms?|final exams?|quiz(zes)?|tests?)\b/i;
/** ...but not practice material, participation quizzes, reviews, project scores, programming assignments ("Unit Tests"), corrections, extra credit, or an orientation / syllabus quiz (a course-start check, not an exam). */
export const NOT_AN_EXAM = /\b(practice|participation|discussion|review|project|survey|assignments?|homework|hw|labs?|unit tests|test cases?|corrections?|extra credit|orientation|syllabus (quiz|test)|getting started|welcome)\b/i;

/** A Canvas page is read for exams only if it mentions one. */
const EXAM_WORDS = /\b(exams?|midterms?|finals?|quiz(zes)?|tests?)\b/i;

export function isExamName(name: string): boolean {
  return EXAM_NAME.test(name) && !NOT_AN_EXAM.test(name);
}

/**
 * One key per exam across sources: "Exam 1: Fall 2026 - In Class" and "Exam 1" are the same
 * exam, as are "Midterm 2" and "Midterm 2 (Canvas)", and "Exam II" and "Exam 2". Other names
 * key on their own words.
 */
export function examKey(name: string): string {
  const m = name.trim().match(/^(exam|midterm|quiz)\s*#?\s*(\d+|[ivx]+)\b/i);
  if (m && Number.isFinite(examNumber(m[2]))) return `${m[1].toLowerCase()}-${examNumber(m[2])}`;
  if (/^final exam\b/i.test(name.trim())) return "final-exam";
  return slug(name);
}
const CANVAS = "https://ufl.instructure.com";
/** Keeps one prompt well inside Flash's context; the syllabus and announcements come first. */
const MAX_PROMPT_CHARS = 250_000;

type FieldName = "name" | "date" | "location" | "format" | "notesRule" | "topics";
const FIELDS: FieldName[] = ["name", "date", "location", "format", "notesRule", "topics"];

/**
 * Two sources disagree on a field: both quotes with their sources, which won, and why
 * (PipelineExam.conflicts in lib/pipeline/types.ts), plus each side's value.
 */
export interface ExamConflict {
  field: FieldName;
  kept: { value: unknown; quote: string; source: SourceRef };
  other: { value: unknown; quote: string; source: SourceRef };
  reason: string;
}

export const WINDOW_CLOSES_FROM = "Canvas assignment due_at (metadata, not a quote)";

/**
 * When the exam's Canvas assignment stops taking submissions (its `due_at`, in Eastern time).
 * Metadata, not a quote: it is not the exam's start and never fills `date`.
 */
export interface WindowCloses {
  value: string;
  itemId: string;
  from: typeof WINDOW_CLOSES_FROM;
}

/** PipelineExam with `conflicts` always set (each side also carries its value) plus `windowCloses` (proposed addition to lib/pipeline/types.ts). */
export type FoundExam = PipelineExam & { conflicts: ExamConflict[]; windowCloses: WindowCloses | null };

export interface ExamSource extends ExamSourceText {
  kind: "syllabus" | "announcement" | "page" | "assignment";
  ref: SourceRef;
  postedAt: string | null;
}

/** The parts of the course export this stage reads. */
export interface ExamExport {
  course: { id: number; name: string | null; course_code: string | null };
  announcements?: { id: number; title?: string; posted_at?: string | null }[];
  assignments?: { id: number; name?: string; due_at?: string | null }[];
}

export type GenerateJSON = <T>(model: string, prompt: string, schema: object, options?: { system?: string; temperature?: number }) => Promise<T>;

const ws = (s: string) => s.replace(/\s+/g, " ").trim();

/** Is `quote` in `text`, word for word? Only whitespace is normalised. */
export function quoteIn(text: string, quote: string | null | undefined): boolean {
  if (!quote || !quote.trim()) return false;
  return ws(text).includes(ws(quote));
}

/** UTC ISO -> the same instant as ISO 8601 in America/New_York with its offset. */
export function easternIso(utc: string): string | null {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d)) parts[p.type] = p.value;
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((local - d.getTime()) / 60000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const hhmm = `${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hhmm}`;
}

/** A real calendar day, or a datetime carrying the Eastern offset right for that day (-04:00 EDT, -05:00 EST). Z and naive times are refused. */
export function isEasternDate(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(-0[45]:00))?$/);
  if (!m) return false;
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (day.getUTCMonth() !== +m[2] - 1 || day.getUTCDate() !== +m[3]) return false;
  if (!m[4]) return true;
  const eastern = easternIso(v);
  return eastern === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7]}`;
}
const slug = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The sources an exam can come from, with their text and SourceRef. */
export function examSources(docs: ExtractedDoc[], exp: ExamExport): ExamSource[] {
  const course = `${CANVAS}/courses/${exp.course.id}`;
  const ann = new Map((exp.announcements ?? []).map((a) => [`announcement:${a.id}`, a]));
  const asg = new Map((exp.assignments ?? []).map((a) => [`assignment:${a.id}`, a]));
  const text = (d: ExtractedDoc) => d.pages.map((p) => p.text).filter(Boolean).join("\n");
  const out: ExamSource[] = [];
  for (const d of docs) {
    const t = text(d);
    if (!t) continue;
    if (d.itemId.startsWith("syllabus:")) {
      out.push({ id: d.itemId, label: "syllabus", kind: "syllabus", text: t, postedAt: null, ref: { kind: "syllabus", itemId: d.itemId, href: `${course}/assignments/syllabus` } });
    } else if (d.role === "syllabus" && d.itemId.startsWith("file:") && d.fileId) {
      out.push({ id: d.itemId, label: `syllabus file "${d.name}"`, kind: "syllabus", text: t, postedAt: null, ref: { kind: "document", itemId: d.itemId, fileId: d.fileId, page: 1, name: d.name, href: `${course}/files/${d.fileId}` } });
    } else if (d.itemId.startsWith("announcement:")) {
      const a = ann.get(d.itemId);
      const postedAt = a?.posted_at ?? null;
      out.push({ id: d.itemId, label: `announcement posted ${postedAt ?? "(date unknown)"}`, kind: "announcement", text: t, postedAt, ref: { kind: "announcement", itemId: d.itemId, title: a?.title ?? d.name, postedAt: postedAt ?? "", href: `${course}/discussion_topics/${d.itemId.slice(13)}` } });
    } else if (d.itemId.startsWith("page:") && EXAM_WORDS.test(t)) {
      // Canvas pages that mention an exam (e.g. a unit review page listing what Exam 2 covers).
      const pageUrl = d.itemId.slice(5);
      out.push({ id: d.itemId, label: `Canvas page "${d.name}"`, kind: "page", text: t, postedAt: null, ref: { kind: "page", itemId: d.itemId, pageUrl, title: d.name, href: `${course}/pages/${pageUrl}` } });
    } else if (d.itemId.startsWith("assignment:") && isExamName(d.name)) {
      const a = asg.get(d.itemId);
      const closes = a?.due_at ? easternIso(a.due_at) : null;
      const label = closes ? `assignment; Canvas metadata, not quotable: submission window closes ${closes}` : "assignment";
      out.push({ id: d.itemId, label, kind: "assignment", text: t, postedAt: null, ref: { kind: "assignment", itemId: d.itemId, name: a?.name ?? d.name, dueAt: a?.due_at ?? null, href: `${course}/assignments/${d.itemId.slice(11)}` } });
    }
  }
  return out;
}

const none = <T>(): Sourced<T> => ({ value: null, quote: null, itemId: null });

interface Candidate {
  source: ExamSource;
  fields: Record<FieldName, Sourced<unknown>>;
  windowCloses?: WindowCloses | null;
}

/**
 * Exams straight from Canvas assignments: the name, quoted from the assignment's text. Its
 * `due_at` is when the submission window closes, not when the exam starts, and it isn't text
 * Canvas printed, so it never becomes `date` or a quote: it's kept as `windowCloses` metadata.
 */
export function assignmentCandidates(sources: ExamSource[], exp: ExamExport): Candidate[] {
  const asg = new Map((exp.assignments ?? []).map((a) => [`assignment:${a.id}`, a]));
  return sources.filter((s) => s.kind === "assignment").map((s) => {
    const a = asg.get(s.id);
    const name = a?.name ?? "";
    const fields = Object.fromEntries(FIELDS.map((f) => [f, none()])) as Record<FieldName, Sourced<unknown>>;
    if (name && quoteIn(s.text, name)) fields.name = { value: name, quote: name, itemId: s.id };
    const closes = a?.due_at ? easternIso(a.due_at) : null;
    return { source: s, fields, windowCloses: closes ? { value: closes, itemId: s.id, from: WINDOW_CLOSES_FROM } : null };
  });
}

/** A quote shorter than this can't support a value (names excepted: "Exam 2" is enough). */
export const MIN_QUOTE_CHARS = 8;
const STOP = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "are", "will", "room", "its", "all", "via"]);
/** Lowercase alphanumeric words, a trailing plural "s" dropped ("graphs" ~ "graph"). */
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
/** A value's main words: 3+ letters or with a digit, not a stop word ("in CSE A101" -> cse, a101). */
const mainWords = (s: string) => words(s).filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w));
/** Does the quote contain this word (or, for room numbers like "A101", the same characters run together)? */
function hasWord(quote: string, w: string): boolean {
  if (words(quote).includes(w)) return true;
  return /\d/.test(w) && quote.toLowerCase().replace(/[^a-z0-9]/g, "").includes(w);
}

/** Month names and their usual abbreviations, as whole tokens ("Mar." yes, "Marston" no). */
const MONTH_TOKENS = [
  "jan(uary)?", "feb(ruary)?", "mar(ch)?", "apr(il)?", "may", "june?", "july?", "aug(ust)?",
  "sept?(ember)?", "oct(ober)?", "nov(ember)?", "dec(ember)?",
];
/** A number right after one of these words is a count or a label, never a day or an hour ("Exam 2", "chapters 10-15"). */
const NUMBER_LABEL = /\b(exams?|midterms?|quiz(zes)?|tests?|chapters?|chs?|pages?|pp?|units?|modules?|weeks?|lectures?|sections?|sec|problems?|questions?|hw|homework|labs?|parts?|lessons?|rooms?|no|nos|numbers?)\.?\s*#?\s*$/i;
/** Does the number at `index` in `q` follow a label like "Exam" or "chapters"? */
const afterLabel = (q: string, index: number) => NUMBER_LABEL.test(q.slice(Math.max(0, index - 20), index));

/**
 * The quote names the value's month and day: "October 15", "Oct. 15th", "15 October", "10/15",
 * "2026-10-15". The month must be a real month token, and a numeric date is m/d (with a slash)
 * or ISO: ranges like "chapters 10-15" or "pages 3-5" are never dates.
 */
function quoteHasDay(quote: string, month: number, day: number): boolean {
  const q = quote.toLowerCase();
  const mon = `(${MONTH_TOKENS[month - 1]})(?![a-z])\\.?`;
  const d = `0?${day}(st|nd|rd|th)?(?![0-9])`;
  const forms = [
    new RegExp(`\\b${mon},?\\s+${d}`, "g"),
    new RegExp(`(?<![0-9/.:-])${d}\\s+(of\\s+)?${mon}`, "g"),
    new RegExp(`(?<![0-9/.:-])0?${month}/0?${day}(?![0-9])`, "g"),
    new RegExp(`(?<![0-9/.:-])\\d{4}-0?${month}-0?${day}(?![0-9])`, "g"),
  ];
  return forms.some((re) => [...q.matchAll(re)].some((m) => !afterLabel(q, m.index)));
}

/** A 12-hour clock hour with its meridiem as 0-23. */
const to24 = (h12: number, pm: boolean) => (h12 % 12) + (pm ? 12 : 0);
const MERIDIEM = "([ap])\\.?\\s?m\\b\\.?";
const CLOCK = "(\\d{1,2})(?::([0-5]\\d))?";

/**
 * The times of day the quote states, as [hour 0-23, minute]: "8 PM", "8:00 p.m.", "8-10 pm" (the
 * start takes the end's meridiem; "11-1 pm" starts at 11 am), 24-hour "20:00" or "08:00", "noon",
 * "midnight". A bare number ("Exam 2 - October 15") or an "8:00" with no meridiem states no time.
 */
export function quoteTimes(quote: string): [number, number][] {
  const q = quote.toLowerCase();
  const out: [number, number][] = [];
  if (/\bnoon\b/.test(q)) out.push([12, 0]);
  if (/\bmidnight\b/.test(q)) out.push([0, 0]);
  const h12ok = (h: string) => Number(h) >= 1 && Number(h) <= 12;
  // "8 PM", "8:20 p.m."
  for (const m of q.matchAll(new RegExp(`(?<![0-9:/.-])${CLOCK}\\s*${MERIDIEM}`, "g"))) {
    if (h12ok(m[1]) && !afterLabel(q, m.index)) out.push([to24(Number(m[1]), m[3] === "p"), Number(m[2] ?? 0)]);
  }
  // "8-10 pm", "8:30 to 10:10 pm"
  for (const m of q.matchAll(new RegExp(`(?<![0-9:/.-])${CLOCK}\\s*(?:-|–|—|to)\\s*${CLOCK}\\s*${MERIDIEM}`, "g"))) {
    if (!h12ok(m[1]) || !h12ok(m[3]) || afterLabel(q, m.index)) continue;
    const start = Number(m[1]);
    const pm = m[5] === "p" && !(start !== 12 && start > Number(m[3]) % 12);
    out.push([to24(start, pm), Number(m[2] ?? 0)]);
  }
  // 24-hour "20:00", "08:00": zero-padded or 13-23, and no meridiem after it (or after a range end).
  for (const m of q.matchAll(new RegExp(`(?<![0-9:/.-])(0\\d|1[3-9]|2[0-3]):([0-5]\\d)(?![0-9])(?!\\s*((?:-|–|—|to)\\s*${CLOCK}\\s*)?[ap]\\.?\\s?m\\b)`, "g"))) {
    if (!afterLabel(q, m.index)) out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}
/** The quote states this time of day: its hour (AM and PM count) and its minute. */
const quoteHasTime = (quote: string, hour: number, minute: number) => quoteTimes(quote).some(([h, m]) => h === hour && m === minute);

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
/** "Exam II" -> 2, "Exam 2" -> 2. */
const examNumber = (n: string) => (/^\d+$/.test(n) ? Number(n) : (ROMAN[n.toLowerCase()] ?? NaN));
/** A negation in a clause: "No printed notes", "not allowed", "without notes", "can't". */
const NEGATION = /\b(no|not|without|cannot|never|nor|prohibited|forbidden|banned)\b|n['’]t\b/i;
/** Clauses: split at sentence ends and at turns like "but" or "although", where a negation stops applying. */
const clauses = (q: string) => q.split(/[.;!?]+|\b(?:but|however|although|though|whereas|while|except)\b/i);
const NOTES_WORD = "\\b(notes?|cheat ?sheets?|crib ?sheets?|formula ?sheets?|aids?)\\b";
/** Notes themselves negated: "closed notes", "no (printed) notes", "without any notes", "notes are not allowed", "notes are prohibited". */
const NO_NOTES = [
  /\bclosed[- ](notes?|book)\b/i,
  new RegExp(`\\b(no|without(\\s+any)?)\\s+([a-z-]+,?\\s+){0,3}?${NOTES_WORD}`, "i"),
  new RegExp(`${NOTES_WORD}[^]{0,40}\\b(not|cannot|never)\\b[^]{0,20}\\b(allowed|permitted|used|brought)\\b`, "i"),
  new RegExp(`${NOTES_WORD}[^]{0,40}n['’]t\\b[^]{0,20}\\b(allowed|permitted|used|brought)\\b`, "i"),
  new RegExp(`${NOTES_WORD}[^]{0,40}\\b(prohibited|forbidden|banned)\\b`, "i"),
];
/**
 * The notes rule the quote states. "printed" and "handwritten" need their keyword in a clause with
 * no negation ("No printed notes are allowed" supports neither); "none" needs a clause that negates
 * notes ("no ... notes", "notes are not allowed", "without notes") or says closed notes/book.
 */
function notesRuleIn(q: string, value: string): boolean {
  const cs = clauses(q);
  if (value === "printed") return cs.some((c) => /\b(print(ed)?|typed)\b/i.test(c) && !NEGATION.test(c));
  if (value === "handwritten") return cs.some((c) => /\bhand[- ]?written\b/i.test(c) && !NEGATION.test(c));
  if (value === "none") return cs.some((c) => NO_NOTES.some((re) => re.test(c)));
  return false;
}

/** Every main word of `text` is in the quote (and there is at least one). */
const allWordsIn = (quote: string, text: string) => {
  const main = mainWords(text);
  return main.length > 0 && main.every((w) => hasWord(quote, w));
};

/**
 * Does the quote support the value, beyond appearing in the source? This applies to every field,
 * including any added later. Generic rule: the quote is at least MIN_QUOTE_CHARS long (a name may
 * be as short as itself, e.g. "Exam 2") and contains every main word of the value. Fields whose
 * value isn't written the way the quote words it have their own key tokens:
 *   - name: the exam's kind and number ("Exam II" ~ "Exam 2"), else the name as a phrase
 *   - date: a real month token and the day, or m/d (never a range like "10-15"); time: the hour
 *     and minute stated as a time ("8 PM", "8:00 p.m.", "20:00"), AM/PM matching (else only the
 *     day is kept)
 *   - notesRule: the keyword in a clause that doesn't negate it (printed / handwritten), or a
 *     negated notes clause (none)
 *   - topics: each topic's main words (topics the quote doesn't name are left out)
 * Returns the supported value, or null.
 */
export function supportedValue(name: FieldName | string, value: unknown, quote: string): unknown {
  const q = ws(quote);
  const minChars = name === "name" ? Math.min(MIN_QUOTE_CHARS, ws(String(value)).length) : MIN_QUOTE_CHARS;
  if (q.length < minChars) return null;
  if (name === "name") {
    const v = String(value);
    const m = v.trim().match(/^(exam|midterm|quiz|test)\s*#?\s*(\d+|[ivx]+)\b/i);
    if (m) {
      const n = examNumber(m[2]);
      const roman = Object.keys(ROMAN).find((k) => ROMAN[k] === n);
      return new RegExp(`\\b${m[1]}\\s*#?\\s*(0?${n}${roman ? `|${roman}` : ""})\\b`, "i").test(q) ? v : null;
    }
    return q.toLowerCase().includes(ws(v).toLowerCase()) ? v : null;
  }
  if (name === "date") {
    const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2}))?/);
    if (!m || !quoteHasDay(q, Number(m[2]), Number(m[3]))) return null;
    if (m[4] && !quoteHasTime(q, Number(m[5]), Number(m[6]))) return String(value).slice(0, 10);
    return value;
  }
  if (name === "notesRule") return notesRuleIn(q, String(value)) ? value : null;
  if (Array.isArray(value)) {
    // topics, and any list field: keep the items the quote names.
    const kept = value.filter((t) => typeof t === "string" && allWordsIn(q, t));
    return kept.length ? kept : null;
  }
  // location, format, and any other field: every main word of the value is in the quote.
  if (typeof value !== "string" && typeof value !== "number") return null;
  return allWordsIn(q, String(value)) ? value : null;
}

/** Keeps a model field only if its quote is in the source it cites, is well formed, and supports the value. */
export function checkField(f: QuotedField<unknown> | undefined, name: FieldName, sources: Map<string, ExamSource>): Sourced<unknown> {
  if (!f || f.value === null || f.value === undefined || !f.sourceId) return none();
  const src = sources.get(f.sourceId);
  if (!src || !quoteIn(src.text, f.quote)) return none();
  if (name === "date" && !isEasternDate(f.value)) return none();
  if (name === "notesRule" && !["printed", "handwritten", "none"].includes(String(f.value))) return none();
  if (name === "topics" && !(Array.isArray(f.value) && f.value.length && f.value.every((t) => typeof t === "string"))) return none();
  if ((name === "name" || name === "location" || name === "format") && typeof f.value !== "string") return none();
  const value = supportedValue(name, f.value, f.quote!);
  if (value === null) return none();
  return { value, quote: ws(f.quote!), itemId: src.id };
}

/** Higher wins: newer announcements, then the syllabus and Canvas pages, then assignments. */
function priority(s: ExamSource): [number, string] {
  return s.kind === "announcement" ? [2, s.postedAt ?? ""] : s.kind === "syllabus" || s.kind === "page" ? [1, ""] : [0, ""];
}
function better(a: ExamSource, b: ExamSource): boolean {
  const [pa, ta] = priority(a);
  const [pb, tb] = priority(b);
  return pa !== pb ? pa > pb : ta > tb;
}

const sameValue = (field: FieldName, a: unknown, b: unknown) => {
  if (field === "date" && typeof a === "string" && typeof b === "string") return a.slice(0, 10) === b.slice(0, 10) && (a.length === 10 || b.length === 10 || a === b);
  if (typeof a === "string" && typeof b === "string") return ws(a).toLowerCase() === ws(b).toLowerCase();
  return JSON.stringify(a) === JSON.stringify(b);
};

function conflictNote(kept: ExamSource, other: ExamSource): string {
  if (kept.kind === "announcement" && other.kind === "announcement") return `newer announcement (posted ${kept.postedAt}) overrides an older one (posted ${other.postedAt})`;
  if (kept.kind === "announcement") return `newer announcement (posted ${kept.postedAt}) overrides the ${other.kind}`;
  return `the ${kept.kind} is preferred over the ${other.kind}`;
}

/** Merges every source's candidate for one exam into one FoundExam. */
export function mergeCandidates(key: string, cands: Candidate[], courseId: string, searched: SourceRef[]): FoundExam {
  const exam: Record<FieldName, Sourced<unknown>> = Object.fromEntries(FIELDS.map((f) => [f, none()])) as Record<FieldName, Sourced<unknown>>;
  const conflicts: ExamConflict[] = [];
  const refs = new Map(searched.map((r) => [r.itemId, r]));
  const refOf = (itemId: string): SourceRef => refs.get(itemId) ?? { kind: "syllabus", itemId };
  for (const f of FIELDS) {
    const withValue = cands.filter((c) => c.fields[f].value !== null);
    if (!withValue.length) continue;
    let best = withValue[0];
    for (const c of withValue.slice(1)) if (better(c.source, best.source)) best = c;
    // A date-only value gives way to a same-day value with a time, whatever its source.
    if (f === "date" && String(best.fields.date.value).length === 10) {
      const timed = withValue.find((c) => String(c.fields.date.value).length > 10 && String(c.fields.date.value).slice(0, 10) === best.fields.date.value);
      if (timed) best = timed;
    }
    exam[f] = best.fields[f];
    const seen = new Set<string>();
    for (const c of withValue) {
      if (c === best || sameValue(f, c.fields[f].value, best.fields[f].value)) continue;
      const k = `${c.source.id}|${JSON.stringify(c.fields[f].value)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      conflicts.push({
        field: f,
        kept: { value: best.fields[f].value, quote: best.fields[f].quote!, source: refOf(best.fields[f].itemId!) },
        other: { value: c.fields[f].value, quote: c.fields[f].quote!, source: refOf(c.fields[f].itemId!) },
        reason: conflictNote(best.source, c.source),
      });
    }
  }
  // The earliest window close among the exam's assignments (e.g. in class before the DRC sitting).
  const closes = cands.map((c) => c.windowCloses).filter((w): w is WindowCloses => !!w);
  const windowCloses = closes.sort((a, b) => Date.parse(a.value) - Date.parse(b.value))[0] ?? null;
  return {
    id: `exam:${key}`,
    courseId,
    name: exam.name as Sourced<string>,
    date: exam.date as Sourced<string>,
    location: exam.location as Sourced<string>,
    format: exam.format as Sourced<string>,
    notesRule: exam.notesRule as Sourced<"printed" | "handwritten" | "none">,
    topics: exam.topics as Sourced<string[]>,
    searched,
    conflicts,
    windowCloses,
  };
}

/**
 * Groups that are one event under two names ("Final Exam" and "Optional Cumulative Final Exam") are
 * merged under the shorter name's key; mergeCandidates keeps both names' quotes (the other name
 * becomes a conflict, so it stays on record). Two names are one event (`sameExamName`) when they
 * have the same kind words anywhere in the name (Conceptual vs Programming Quiz, Quiz vs "Chapter
 * Test"), the same number and the same part/section letter, and either the shorter is the bare
 * "<kind> [N]" form ("Final Exam", "Exam 2", "Midterm") or every word the longer adds is filler
 * ("Optional", "Cumulative", "In-Class"). Two groups that state the same date with a time are merged
 * too, but only if their names agree that way or carry the same exam number ("Exam 2" and "Exam 3" at
 * the same time stay apart), and neither way when one name is a separate sitting (SITTING: a make-up,
 * DRC, late or remote sitting is its own event, even at the same date and time).
 */
const SITTING = /\b(make[- ]?ups?|re[- ]?takes?|re[- ]?tests?|conflicts?|alternates?|alt|drc|accommodated|late|remote|extended[- ]time|attempt\s*#?\s*(?:2|ii|two))\b/i;
/** Unicode dashes (‐ ‑ ‒ – — ― − ﹘ ﹣ －) as "-", so "Make–up" and "Exam 2 — DRC" read like their ASCII spellings. */
const asciiDashes = (s: string) => s.replace(/[‐-―−﹘﹣－]/g, "-");
/** Does this name mention a sitting word at all (make-up, DRC, late, remote…)? */
const mentionsSitting = (s: string) => SITTING.test(asciiDashes(s));
/**
 * Is this name a separate sitting? As mentionsSitting, except that a sitting it leaves out doesn't count:
 * "In Class (all students except DRC)" and "non-DRC" are the main sitting. Used with a shared date and time,
 * where the time already ties the two names to one event.
 */
const isSitting = (s: string) =>
  mentionsSitting(
    asciiDashes(s)
      .replace(/\b(?:except|excluding|other than|not)\b[^)\],;]*/gi, " ")
      .replace(/\bnon-?\s*\w+/gi, " "),
  );
/** Words that say what kind of exam it is. Matched in the whole name, so "Dynamic Programming" counts. */
const KIND = new Set(words("conceptual programming coding written oral practical lab quiz exam midterm final test"));
/** Words a longer name may add to the same exam's name. */
const FILLER = new Set(words("optional cumulative comprehensive in class inclass online proctored scheduled official the a an of for course"));
/** Every word of a name, short ones too ("in", "a"), plural "s" dropped (as `words` does, so "class" reads "clas" on both sides). */
const nameWords = words;
/** The first exam number ("Exam II" and "Exam 2" are both 2), or null. */
const nameNumber = (s: string) => {
  const m = s.match(/\b(\d+|[ivx]+)\b/i);
  return m ? examNumber(m[1]) : null;
};
/**
 * "Part A", "Section 2", "Form B", a lone letter ("Exam 1 B") or a number's letter ("2A"): which part or
 * sitting of an exam a name is. Lone a, i, v and x are left out (an article or a Roman numeral).
 */
const PART = /\b(part|section|sec|form|version|group)\s*#?\s*([a-z]|\d+|[ivx]+)\b/gi;
function designators(s: string): string {
  const out = new Set<string>();
  for (const m of s.matchAll(PART)) out.add(`${m[1].toLowerCase().replace(/^sec$/, "section")} ${m[2].toLowerCase()}`);
  for (const m of s.replace(PART, " ").matchAll(/\b\d+([a-z])\b|(?:^|[\s\-–:(])([b-hj-uwyz])(?=$|[\s\-–:),])/gi)) out.add(`letter ${(m[1] ?? m[2]).toLowerCase()}`);
  return [...out].sort().join("|");
}
const kinds = (s: string) => [...new Set(nameWords(s).filter((w) => KIND.has(w)))].sort().join(" ");

/** Do these two names name the same exam? (See the comment on SITTING.) */
export function sameExamName(rawA: string, rawB: string): boolean {
  const [a, b] = [asciiDashes(rawA), asciiDashes(rawB)];
  const [short, long] = nameWords(a).length <= nameWords(b).length ? [a, b] : [b, a];
  if (!EXAM_NAME.test(short) || !EXAM_NAME.test(long)) return false;
  // A make-up or alternate sitting is its own event even when its name contains the exam's.
  if (mentionsSitting(long) !== mentionsSitting(short)) return false;
  if (kinds(short) !== kinds(long) || nameNumber(short) !== nameNumber(long) || designators(short) !== designators(long)) return false;
  const sw = nameWords(short);
  const lw = nameWords(long);
  if (!sw.every((w) => lw.includes(w))) return false;
  const numberWord = (w: string) => /^\d+$/.test(w) || Object.hasOwn(ROMAN, w);
  if (sw.every((w) => KIND.has(w) || numberWord(w))) return true;
  return lw.filter((w) => !sw.includes(w)).every((w) => FILLER.has(w));
}

/**
 * Same exam number (and kind and part), and both or neither a separate sitting: the test for two names
 * stated for the same date and time ("Exam 2" and "Exam 2 DRC" at 8:30 pm are two sittings).
 */
export function sameNumbered(rawA: string, rawB: string): boolean {
  const [a, b] = [asciiDashes(rawA), asciiDashes(rawB)];
  const n = nameNumber(a);
  return n !== null && Number.isFinite(n) && n === nameNumber(b) && kinds(a) === kinds(b) && designators(a) === designators(b) && isSitting(a) === isSitting(b);
}

/** At most this many focused passes per run (one per exam still missing a field), each this small. */
export const FILL_PASSES = 6;
const FILL_MAX_CHARS = 60_000;

/** Does the text name this exam ("Exam 1" also as "Exam I" or "Exam #1"; other names as a phrase)? */
export function namesExam(text: string, name: string): boolean {
  const m = name.trim().match(/^(exam|midterm|quiz|test)\s*#?\s*(\d+|[ivx]+)\b/i);
  if (m) {
    const n = examNumber(m[2]);
    const roman = Object.keys(ROMAN).find((k) => ROMAN[k] === n);
    return new RegExp(`\\b${m[1]}\\s*#?\\s*(0?${n}${roman ? `|${roman}` : ""})\\b`, "i").test(text);
  }
  return ws(text).toLowerCase().includes(ws(name).toLowerCase());
}

export function sameEventGroups(groups: Map<string, Candidate[]>): Map<string, Candidate[]> {
  const nameOf = (cs: Candidate[]) => String(cs.find((c) => c.fields.name.value)?.fields.name.value ?? "");
  const timed = (cs: Candidate[]) => new Set(cs.map((c) => c.fields.date.value).filter((d): d is string => typeof d === "string" && d.length > 10));
  const keys = [...groups.keys()];
  const into = new Map<string, string>(keys.map((k) => [k, k]));
  const root = (k: string): string => (into.get(k) === k ? k : root(into.get(k)!));
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const [a, b] = [root(keys[i]), root(keys[j])];
      if (a === b) continue;
      const [ga, gb] = [groups.get(keys[i])!, groups.get(keys[j])!];
      const [na, nb] = [nameOf(ga), nameOf(gb)];
      const sameTime = [...timed(ga)].some((d) => timed(gb).has(d));
      if (!sameExamName(na, nb) && !(sameTime && sameNumbered(na, nb))) continue;
      // The shorter name's key is the event's key ("final-exam").
      const keep = mainWords(na).length <= mainWords(nb).length ? a : b;
      into.set(keep === a ? b : a, keep);
    }
  const out = new Map<string, Candidate[]>();
  for (const k of keys) out.set(root(k), [...(out.get(root(k)) ?? []), ...groups.get(k)!]);
  return out;
}

/** Builds the prompt's source list, longest-lived sources first, within the size budget. */
function promptSources(sources: ExamSource[]): ExamSource[] {
  const order = { syllabus: 0, announcement: 1, page: 2, assignment: 3 } as const;
  const sorted = [...sources].sort((a, b) => order[a.kind] - order[b.kind] || (a.postedAt ?? "").localeCompare(b.postedAt ?? ""));
  const out: ExamSource[] = [];
  let used = 0;
  for (const s of sorted) {
    if (used + s.text.length > MAX_PROMPT_CHARS) continue;
    out.push(s);
    used += s.text.length;
  }
  return out;
}

export interface FindExamsResult {
  exams: FoundExam[];
  /** For the report: what the model proposed and what the quote check refused. */
  checked: { proposed: number; refusedFields: number; prompt: string };
}

export async function findExams(
  input: { docs: ExtractedDoc[]; exp: ExamExport },
  deps: { generateJSON: GenerateJSON; model: string },
): Promise<FindExamsResult> {
  const { docs, exp } = input;
  const sources = examSources(docs, exp);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const searched = sources.map((s) => s.ref);
  const cands: Candidate[] = assignmentCandidates(sources, exp);

  let proposed = 0;
  let refusedFields = 0;
  const forModel = promptSources(sources.filter((s) => s.kind !== "assignment").concat(sources.filter((s) => s.kind === "assignment")));
  if (forModel.some((s) => s.kind !== "assignment")) {
    const prompt = syllabusParsePrompt(exp.course.name ?? exp.course.course_code ?? String(exp.course.id), forModel);
    const reply = await deps.generateJSON<SyllabusParseReply>(deps.model, prompt, SYLLABUS_PARSE_SCHEMA, { system: SYLLABUS_PARSE_SYSTEM, temperature: 0 });
    for (const pe of reply.exams ?? []) {
      proposed++;
      const fields = Object.fromEntries(FIELDS.map((f) => [f, checkField((pe as ParsedExam)[f], f, byId)])) as Record<FieldName, Sourced<unknown>>;
      refusedFields += FIELDS.filter((f) => (pe as ParsedExam)[f]?.value != null && fields[f].value === null).length;
      if (fields.name.value === null) continue;
      const src = byId.get(fields.name.itemId!)!;
      cands.push({ source: src, fields });
    }
  }

  const groups = new Map<string, Candidate[]>();
  for (const c of cands) {
    const name = String(c.fields.name.value ?? "");
    // Assignments must look like an exam by name; the model was asked only for exams and
    // quizzes (and its quote checked), so short names like "CQ3 - Heaps" stay unless excluded.
    if (c.source.kind === "assignment" && c.fields.name.itemId === c.source.id ? !isExamName(name) : NOT_AN_EXAM.test(name)) continue;
    const key = examKey(name);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const merged = sameEventGroups(groups);

  // A second, focused look for an exam the whole-course pass left without a location, format, notes
  // rule or topics: only the sources that name it (a unit review page saying "Exam 1 ... in CAR 100"
  // gets lost among 60 sources). Same prompt, same quote checks; at most FILL_PASSES calls.
  let fills = 0;
  // Main exams (Exam N, Midterm N, Final Exam) first: the passes are capped.
  const main = (k: string) => (/^(exam|midterm)-\d+$|^final-exam$/.test(k) ? 0 : 1);
  for (const [, cs] of [...merged].sort((a, b) => main(a[0]) - main(b[0]))) {
    if (fills >= FILL_PASSES) break;
    const name = String(cs.find((c) => c.fields.name.value)?.fields.name.value ?? "");
    const missing = (["location", "format", "notesRule", "topics"] as const).filter((f) => !cs.some((c) => c.fields[f].value !== null));
    if (!name || !missing.length) continue;
    const named = sources.filter((s) => s.kind !== "assignment" && namesExam(s.text, name));
    if (!named.length || named.reduce((n, s) => n + s.text.length, 0) > FILL_MAX_CHARS) continue;
    fills++;
    const reply = await deps.generateJSON<SyllabusParseReply>(deps.model, syllabusParsePrompt(exp.course.name ?? exp.course.course_code ?? String(exp.course.id), named), SYLLABUS_PARSE_SCHEMA, { system: SYLLABUS_PARSE_SYSTEM, temperature: 0 });
    for (const pe of reply.exams ?? []) {
      const fields = Object.fromEntries(FIELDS.map((f) => [f, checkField((pe as ParsedExam)[f], f, byId)])) as Record<FieldName, Sourced<unknown>>;
      if (fields.name.value === null || examKey(String(fields.name.value)) !== examKey(name)) continue;
      // Only the fields still missing are taken from the focused pass.
      for (const f of FIELDS) if (!(missing as readonly string[]).includes(f) && f !== "name") fields[f] = none();
      cs.push({ source: byId.get(fields.name.itemId!)!, fields });
    }
  }
  const exams = [...merged].map(([key, cs]) => mergeCandidates(key, cs, String(exp.course.id), searched));
  const when = (e: FoundExam) => e.date.value ?? e.windowCloses?.value ?? "9999";
  exams.sort((a, b) => when(a).localeCompare(when(b)) || a.id.localeCompare(b.id));
  return { exams, checked: { proposed, refusedFields, prompt: SYLLABUS_PARSE_VERSION } };
}
