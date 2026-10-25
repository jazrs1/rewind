// Exam scoring harness (item 15): how much of what the exam parser found (lib/pipeline/exams.ts,
// private/pipeline/<COURSE>/exams.json) is right, against John's truth.
//   npm run eval:exam-template  writes private/eval/exam-truth-template.json: every exam and quiz
//                               found, each field as { parsed, quote, truth: "" } for John to fill.
//                               Truth already filled in is kept (exams matched by id, then name).
//   npm run score:exams         "X of Y fields correct" overall and per course, and the wrong ones.
// Only fields with a filled truth are scored. Dates match when they are the same instant (or the
// same day, both without a time); other fields ignore case and spacing. "not found" is right only
// when the truth is "not found" (or "none", except for the notes rule, where "none" means no notes).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { easternIso } from "../../lib/pipeline/exams.ts";

export const COURSES = ["COP3530", "MAS3114"] as const;
export const NOT_FOUND = "not found";
export const TEMPLATE_PATH = "private/eval/exam-truth-template.json";

/** Template field -> the parsed exam's field (coverage is the parser's topics, notes its notesRule). */
export const FIELDS = { name: "name", date: "date", coverage: "topics", format: "format", notes: "notesRule", location: "location" } as const;
export type Field = keyof typeof FIELDS;
const FIELD_NAMES = Object.keys(FIELDS) as Field[];

export type Value = string | string[];
export interface TruthField {
  parsed: Value;
  quote: string | null;
  truth: Value;
}
export type TruthExam = { id: string; notInLatestParse?: true } & Record<Field, TruthField>;
export interface Template {
  about: string;
  courses: Record<string, TruthExam[]>;
}

/** The parts of a parsed exam (FoundExam) the template reads. */
interface Sourced {
  value: unknown;
  quote: string | null;
}
export type ParsedExam = { id: string } & Partial<Record<(typeof FIELDS)[Field], Sourced>>;

const ABOUT =
  "Fill each \"truth\" with what the course really says (dates as ISO, e.g. 2026-10-22T20:30-04:00 or 2026-10-22; coverage as a list or comma-separated; notes as printed, handwritten or none). Write \"not found\" when the course doesn't say. Leave \"\" to skip a field. Re-running the template keeps every truth filled in here.";

const ws = (s: string) => s.replace(/\s+/g, " ").trim();
const isEmpty = (v: Value | undefined) => v === undefined || (Array.isArray(v) ? v.length === 0 : ws(v) === "");

function parsedField(f: Sourced | undefined): Pick<TruthField, "parsed" | "quote"> {
  const v = f?.value;
  if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return { parsed: NOT_FOUND, quote: null };
  return { parsed: Array.isArray(v) ? v.map(String) : String(v), quote: f?.quote ?? null };
}

const nameKey = (e: TruthExam) => ws(String(isEmpty(e.name.truth) ? e.name.parsed : e.name.truth)).toLowerCase();

/**
 * The template for one course: one entry per parsed exam, with the truth from `previous` (matched
 * by id, then by name) kept as it was. Exams John filled that the parser no longer finds stay, with
 * every parsed value "not found", so their truth isn't lost.
 */
export function courseTemplate(parsed: ParsedExam[], previous: TruthExam[] = []): TruthExam[] {
  const byId = new Map(previous.map((e) => [e.id, e]));
  const byName = new Map(previous.map((e) => [nameKey(e), e]));
  const used = new Set<TruthExam>();
  const out: TruthExam[] = parsed.map((p) => {
    const fields = Object.fromEntries(FIELD_NAMES.map((k) => [k, { ...parsedField(p[FIELDS[k]]), truth: "" }])) as Record<Field, TruthField>;
    const fresh: TruthExam = { id: p.id, ...fields };
    const prev = [byId.get(p.id), byName.get(nameKey(fresh))].find((e) => e && !used.has(e));
    if (prev) {
      used.add(prev);
      for (const k of FIELD_NAMES) if (prev[k] && !isEmpty(prev[k].truth)) fresh[k].truth = prev[k].truth;
    }
    return fresh;
  });
  for (const prev of previous) {
    if (used.has(prev) || FIELD_NAMES.every((k) => !prev[k] || isEmpty(prev[k].truth))) continue;
    const fields = Object.fromEntries(FIELD_NAMES.map((k) => [k, { parsed: NOT_FOUND, quote: null, truth: prev[k]?.truth ?? "" }])) as Record<Field, TruthField>;
    out.push({ id: prev.id, notInLatestParse: true, ...fields });
  }
  return out;
}

export function buildTemplate(parsed: Record<string, ParsedExam[]>, previous: Template | null): Template {
  const courses: Record<string, TruthExam[]> = {};
  for (const [code, exams] of Object.entries(parsed)) courses[code] = courseTemplate(exams, previous?.courses?.[code] ?? []);
  // A course missing from this run keeps its template untouched.
  for (const [code, exams] of Object.entries(previous?.courses ?? {})) if (!(code in courses)) courses[code] = exams;
  return { about: ABOUT, courses };
}

// ---- Scoring ----

const isNotFound = (v: string) => /^(not found|none)$/i.test(ws(v));

/** "2026-10-22", or a datetime: with an offset or Z it is that instant; without one it is Eastern time. */
export function parseWhen(s: string): { day: string; ms: number | null } | null {
  const m = ws(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return Number.isNaN(Date.parse(day)) ? null : { day, ms: null };
  let hour = Number(m[4]);
  if (m[7]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (/^p/i.test(m[7]) ? 12 : 0);
  }
  const hh = String(hour).padStart(2, "0");
  const local = `${day}T${hh}:${m[5]}:${m[6] ?? "00"}`;
  if (m[8]) {
    const off = m[8] === "Z" || m[8] === "z" ? "Z" : m[8].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
    const ms = Date.parse(local + off);
    return Number.isNaN(ms) ? null : { day, ms };
  }
  // No offset: Eastern, whichever of EDT/EST is right for that day.
  for (const off of ["-04:00", "-05:00"]) {
    const ms = Date.parse(local + off);
    if (!Number.isNaN(ms) && easternIso(new Date(ms).toISOString()) === local + off) return { day, ms };
  }
  return null;
}

const items = (v: Value) => (Array.isArray(v) ? v : v.split(/[,;\n]/)).map((s) => ws(s).toLowerCase()).filter(Boolean).sort();

/** Is the parsed value right? Truth must be filled. */
export function fieldCorrect(field: Field, parsed: Value, truth: Value): boolean {
  const p = Array.isArray(parsed) ? parsed : ws(parsed);
  const t = Array.isArray(truth) ? truth : ws(truth);
  // For the notes rule "none" is a value (no notes allowed), not "nothing found".
  const tNotFound = typeof t === "string" && (field === "notes" ? /^not found$/i.test(t) : isNotFound(t));
  if (p === NOT_FOUND) return tNotFound;
  if (tNotFound) return false;
  if (field === "date" && typeof p === "string" && typeof t === "string") {
    const a = parseWhen(p);
    const b = parseWhen(t);
    if (a && b) return a.ms === null || b.ms === null ? a.ms === b.ms && a.day === b.day : a.ms === b.ms;
  }
  if (field === "coverage" || Array.isArray(p) || Array.isArray(t)) return JSON.stringify(items(p)) === JSON.stringify(items(t));
  return String(p).toLowerCase() === String(t).toLowerCase();
}

export interface Wrong {
  course: string;
  exam: string;
  field: Field;
  parsed: Value;
  truth: Value;
}
export interface Score {
  correct: number;
  scored: number;
  byCourse: Record<string, { correct: number; scored: number }>;
  wrong: Wrong[];
}

export function scoreTemplate(t: Template): Score {
  const out: Score = { correct: 0, scored: 0, byCourse: {}, wrong: [] };
  for (const [course, exams] of Object.entries(t.courses ?? {})) {
    const c = (out.byCourse[course] = { correct: 0, scored: 0 });
    for (const e of exams) {
      for (const k of FIELD_NAMES) {
        const f = e[k];
        if (!f || isEmpty(f.truth)) continue;
        c.scored++;
        if (fieldCorrect(k, f.parsed, f.truth)) c.correct++;
        else out.wrong.push({ course, exam: String(isEmpty(e.name?.truth) ? e.name?.parsed : e.name.truth), field: k, parsed: f.parsed, truth: f.truth });
      }
    }
    out.correct += c.correct;
    out.scored += c.scored;
  }
  return out;
}

const show = (v: Value) => (Array.isArray(v) ? v.join("; ") : v);

export function report(s: Score): string {
  const lines = [`${s.correct} of ${s.scored} fields correct`];
  for (const [course, c] of Object.entries(s.byCourse)) lines.push(`  ${course}: ${c.correct} of ${c.scored} fields correct`);
  if (s.wrong.length) {
    lines.push("", "Wrong:");
    for (const w of s.wrong) lines.push(`  ${w.course} ${w.exam} · ${w.field}`, `    parsed: ${show(w.parsed)}`, `    truth:  ${show(w.truth)}`);
  }
  return lines.join("\n");
}

// ---- CLI ----

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function writeTemplateCli(path: string) {
  const parsed: Record<string, ParsedExam[]> = {};
  for (const code of COURSES) {
    const file = join(arg("pipeline") ?? "private/pipeline", code, "exams.json");
    const data = await readJson<{ exams?: ParsedExam[] }>(file);
    if (!data?.exams) {
      console.log(`  ${code}: no ${file}, its template entries (if any) are kept as they were`);
      continue;
    }
    parsed[code] = data.exams;
  }
  const previous = existsSync(path) ? await readJson<Template>(path) : null;
  if (existsSync(path) && !previous) throw new Error(`${path} isn't valid JSON; fix it by hand first (nothing was overwritten).`);
  const t = buildTemplate(parsed, previous);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(t, null, 2) + "\n");
  for (const [code, exams] of Object.entries(t.courses)) {
    const filled = exams.reduce((n, e) => n + FIELD_NAMES.filter((k) => !isEmpty(e[k]?.truth)).length, 0);
    console.log(`  ${code}: ${exams.length} exams and quizzes, ${filled} truth fields filled`);
  }
  console.log(`Wrote ${path}`);
}

async function scoreCli(path: string) {
  const t = await readJson<Template>(path);
  if (!t) throw new Error(`No template at ${path}; run npm run eval:exam-template first.`);
  console.log(report(scoreTemplate(t)));
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const path = arg("truth") ?? TEMPLATE_PATH;
  (process.argv.includes("--template") ? writeTemplateCli(path) : scoreCli(path)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
