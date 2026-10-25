// Builds the course home (pure): the countdown to the next exam whose date is known, each exam
// field with its source or "not found", and one tape per module (recorded or blank).
// See lib/home/types.ts for the rules.

import type { Sourced } from "../schema.ts";
import type { SourceRef } from "../pipeline/types.ts";
import type {
  Countdown,
  Coverage,
  CoverageGuess,
  HomeExam,
  HomeExamInput,
  HomeField,
  HomeInputs,
  HomeLectureInput,
  HomeModel,
  HomeModuleInput,
  HomeTape,
  PracticeIndexQuestion,
  SourceInfo,
} from "./types.ts";

const TZ = "America/New_York";

// ---------- Dates (Eastern) ----------

/** YYYY-MM-DD in Eastern time, or null. A plain YYYY-MM-DD passes through. */
export function easternDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** "Nov 18" for a date, "Nov 18, 7 pm" or "Nov 18, 7:30 pm" for a date-time, in Eastern time. */
export function formatExamDate(value: string): string | null {
  const day = easternDate(value);
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return date;
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ }).formatToParts(new Date(value));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const ampm = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase();
  return `${date}, ${hour}${minute === "00" ? "" : `:${minute}`} ${ampm}`;
}

/** "Oct 20" from YYYY-MM-DD. */
export function shortDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "5 minutes ago", "3 hours ago", "2 days ago" (null for a missing or future time). */
export function timeAgo(from: string | null, now: string): string | null {
  if (!from) return null;
  const sec = (Date.parse(now) - Date.parse(from)) / 1000;
  if (!Number.isFinite(sec) || sec < 0) return null;
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (sec < 60) return "just now";
  if (sec < 3600) return unit(Math.floor(sec / 60), "minute");
  if (sec < 86_400) return unit(Math.floor(sec / 3600), "hour");
  return unit(Math.floor(sec / 86_400), "day");
}

// ---------- Sources ----------

/** Names a source for people: "Syllabus", "Announcement · Week 9", "Canvas page · Exams". */
export function sourceLabel(ref: SourceRef): string {
  switch (ref.kind) {
    case "syllabus":
      return "Syllabus";
    case "document":
      return `${ref.name}, page ${ref.page}`;
    case "slide":
      return `Slide ${ref.page} · ${ref.deck}`;
    case "page":
      return `Canvas page · ${ref.title}`;
    case "announcement": {
      const day = easternDate(ref.postedAt);
      return `“${ref.title}” announcement${day ? `, ${shortDate(day)}` : ""}`;
    }
    case "assignment":
      return `Canvas assignment · ${ref.name}`;
    case "lecture":
      return `Lecture · ${ref.title}`;
  }
}

/** For the card header: "From the syllabus", "From an announcement". */
function fromLabel(ref: SourceRef | undefined): string | null {
  if (!ref) return null;
  const words: Record<SourceRef["kind"], string> = {
    syllabus: "From the syllabus",
    document: "From a syllabus file",
    slide: "From the slides",
    page: "From a Canvas page",
    announcement: "From an announcement",
    assignment: "From a Canvas assignment",
    lecture: "From a lecture",
  };
  return words[ref.kind];
}

const PLURAL: Record<SourceRef["kind"], [string, string]> = {
  syllabus: ["the syllabus", "the syllabus"],
  document: ["1 file", "files"],
  slide: ["1 slide", "slides"],
  page: ["1 Canvas page", "Canvas pages"],
  announcement: ["1 announcement", "announcements"],
  assignment: ["1 assignment", "assignments"],
  lecture: ["1 lecture", "lectures"],
};

/** "Looked in the syllabus, 12 Canvas pages and 18 announcements" (or that nothing was searched). */
export function searchedText(searched: SourceRef[]): string {
  const counts = new Map<SourceRef["kind"], number>();
  for (const r of searched) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const order: SourceRef["kind"][] = ["syllabus", "document", "page", "announcement", "assignment", "slide", "lecture"];
  const parts = order
    .filter((k) => counts.has(k))
    .map((k) => {
      const n = counts.get(k)!;
      return k === "syllabus" ? PLURAL.syllabus[0] : n === 1 ? PLURAL[k][0] : `${n} ${PLURAL[k][1]}`;
    });
  if (!parts.length) return "No course sources were read";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Looked in ${list}`;
}

function sourceInfo(s: Sourced<unknown>, searched: SourceRef[]): SourceInfo {
  const ref = searched.find((r) => r.itemId === s.itemId);
  const href = ref && "href" in ref ? ref.href : ref?.kind === "lecture" ? ref.recordingUrl : undefined;
  return {
    itemId: s.itemId,
    label: ref ? sourceLabel(ref) : "Canvas item",
    link: href ? { href, label: ref?.kind === "lecture" ? "Open in Zoom" : "Open in Canvas" } : null,
    quote: s.quote!,
  };
}

/** A value is shown only with its word-for-word quote; anything else is "not found". */
function field(s: Sourced<string> | null | undefined, searched: SourceRef[], text: (v: string) => string | null = (v) => v): HomeField {
  const shown = s && s.value != null && s.quote ? text(s.value) : null;
  if (!s || !shown) return { state: "missing", searched: searchedText(searched) };
  return { state: "found", text: shown, source: sourceInfo(s, searched) };
}

// ---------- Exams ----------

const MAJOR_NAME = /^(?:exam|midterm)\s*#?\s*(?:\d+|[ivx]+)\b|^final exam\b/i;
const MAJOR_ID = /^(?:exam:)?(?:(?:exam|midterm)-\d+|final-exam)$/i;

/** Exams and midterms (not quizzes), by their found name, else their id. */
export function isMajorExam(e: HomeExamInput): boolean {
  const name = e.name.value && e.name.quote ? e.name.value.trim() : null;
  return name ? MAJOR_NAME.test(name) : MAJOR_ID.test(e.id);
}

/** "Name", "Name and date", "Name, date and room". */
function fieldList(names: string[]): string {
  const words = names.map((n, i) => (i === 0 ? n : n.toLowerCase()));
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** One source line per source: found fields that share a source are merged ("Name and date"); each missing field gets its own line. */
export function sourceRows(fields: [string, HomeField][]): HomeExam["sources"] {
  const byItem = new Map<string, { names: string[]; field: HomeField }>();
  const rows: { names: string[]; field: HomeField }[] = [];
  for (const [name, f] of fields) {
    // Same item and same kind of source (a quote vs Canvas metadata never merge).
    const key = f.state === "found" && f.source.itemId ? `${f.source.itemId}|${f.source.label}` : null;
    const hit = key ? byItem.get(key) : undefined;
    if (hit) {
      hit.names.push(name);
      continue;
    }
    const row = { names: [name], field: f };
    if (key) byItem.set(key, row);
    rows.push(row);
  }
  return rows.map((r) => ({ label: fieldList(r.names), field: r.field }));
}

/** Exams list Name, Date and Room; quizzes Name, Date and what they cover. */
/** A quiz's Canvas due date as a field: shown, but labelled as Canvas metadata, never as a quote. */
function canvasDueField(w: { value: string; itemId: string }, searched: SourceRef[]): HomeField {
  const text = formatExamDate(w.value);
  if (!text) return { state: "missing", searched: searchedText(searched) };
  const ref = searched.find((r) => r.itemId === w.itemId);
  const href = ref && "href" in ref ? ref.href : undefined;
  return { state: "found", text, source: { itemId: w.itemId, label: "Canvas due date (not a quote)", link: href ? { href, label: "Open in Canvas" } : null, quote: null } };
}

/**
 * Exams list Name, Date and Room; quizzes Name, Date (or Due, from Canvas, when no date is quoted)
 * and what they cover.
 */
function toHomeExam(e: HomeExamInput, kind: "exam" | "quiz" = "exam"): HomeExam {
  const name = field(e.name, e.searched);
  const canvasDue = kind === "quiz" && !quoted(e.date) && !!e.windowCloses;
  const date = canvasDue ? canvasDueField(e.windowCloses!, e.searched) : field(e.date, e.searched, formatExamDate);
  const location = field(e.location, e.searched);
  const topics = field({ value: e.topics.value?.length ? e.topics.value.join(", ") : null, quote: e.topics.quote, itemId: e.topics.itemId }, e.searched);
  return {
    id: e.id,
    title: name.state === "found" ? name.text : kind === "quiz" ? "Next quiz" : "Next exam",
    name,
    date,
    location,
    topics,
    sources: sourceRows([
      ["Name", name],
      [canvasDue ? "Due" : "Date", date],
      kind === "quiz" ? ["Covers", topics] : ["Room", location],
    ]),
    dateFrom: canvasDue ? "Due date from Canvas" : date.state === "found" ? fromLabel(e.searched.find((r) => r.itemId === e.date.itemId)) : null,
    dateKind: canvasDue ? "canvas-due" : "quote",
  };
}

/** The countdown: the next exam (not quiz) whose date is known and not past, in Eastern days. */
export function countdownOf(exams: HomeExamInput[], now: string): { countdown: Countdown; exam: HomeExamInput | null } {
  const today = easternDate(now)!;
  const majors = exams.filter(isMajorExam);
  const dated = majors
    .map((e, i) => {
      const day = e.date.value && e.date.quote ? easternDate(e.date.value) : null;
      return { e, i, day, days: day ? daysBetween(today, day) : null };
    })
    .filter((x) => x.days !== null);
  const next = dated
    .filter((x) => x.days! >= 0)
    .sort((a, b) => a.days! - b.days! || (Date.parse(a.e.date.value!) || 0) - (Date.parse(b.e.date.value!) || 0) || a.i - b.i)[0];
  if (next) {
    const exam = toHomeExam(next.e);
    const n = next.days!;
    const text = n === 0 ? `${exam.title} is today` : `${exam.title} in ${n} ${n === 1 ? "day" : "days"}`;
    return { countdown: { kind: "days", exam, days: n, text }, exam: next.e };
  }
  // No upcoming date: name an exam whose date wasn't found, after the last one already past.
  const lastPast = Math.max(-1, ...dated.map((x) => x.i));
  const undated = majors.find((e, i) => i > lastPast && !(e.date.value && e.date.quote)) ?? null;
  const exam = undated ? toHomeExam(undated) : null;
  return { countdown: { kind: "no-date", exam, text: exam && exam.title !== "Next exam" ? `${exam.title}: date not found` : "No exam date found" }, exam: undated };
}

// ---------- Tapes ----------

/** Topic words too general to tie a lecture to a module. */
const STOP = new Set([
  "and", "the", "with", "from", "into", "data", "structure", "algorithm", "analysis", "intro", "introduction",
  "part", "review", "exam", "module", "week", "unit", "topic", "basic", "advanced", "all",
]);

/** A word without its plural ending, so "Heaps"/"heap", "Glazes"/"glaze" and "Hashes"/"hash" match. */
function stem(w: string): string {
  if (/(?:ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (/[^siu]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lowercase word stems of 3+ letters. */
export function stems(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .map(stem)
    .filter((w) => w.length >= 3);
}

export function topicStems(topic: string): string[] {
  return [...new Set(stems(topic).filter((w) => !STOP.has(w)))];
}

/** A lecture's opening "Module 8, which is Sorting" names its module. */
const OPENING = /\bmodules?\s+(?:number\s+)?(\d{1,2})[,.]?\s+which is\b/i;
/** Topic words a lecture must say this often to count as covering a module... */
export const MIN_TOPIC_HITS = 20;
/** ...and at least this share of the best module's count (a lecture can span two modules). */
export const TOPIC_SHARE = 0.3;

/** Module positions a lecture covers: the one its opening names, plus every module whose topic words it says often. */
export function modulesForLecture(lines: string[], modules: HomeModuleInput[]): number[] {
  const out = new Set<number>();
  const positions = new Set(modules.map((m) => m.position));
  for (const l of lines) {
    const m = l.match(OPENING);
    if (m && positions.has(Number(m[1]))) {
      out.add(Number(m[1]));
      break;
    }
  }
  const counts = new Map<string, number>();
  for (const l of lines) for (const w of stems(l)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const scores = modules.map((m) => ({ position: m.position, score: m.topic ? topicStems(m.topic).reduce((a, w) => a + (counts.get(w) ?? 0), 0) : 0 }));
  const top = Math.max(0, ...scores.map((s) => s.score));
  for (const s of scores) if (s.score >= MIN_TOPIC_HITS && s.score >= TOPIC_SHARE * top) out.add(s.position);
  return [...out].sort((a, b) => a - b);
}

function onExam(topic: string | null, examTopics: string[] | null): boolean | null {
  if (!examTopics) return null;
  if (!topic) return false;
  const mine = new Set(topicStems(topic));
  return examTopics.some((t) => topicStems(t).some((w) => mine.has(w)));
}

const byOrder = (modules: HomeModuleInput[]) => [...modules].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

/** The lectures on each module (by position). */
export function lecturesByModule(modules: HomeModuleInput[], lectures: HomeLectureInput[]): Map<number, HomeLectureInput[]> {
  const byPosition = new Map<number, HomeLectureInput[]>();
  for (const l of lectures) {
    for (const p of modulesForLecture(l.lines, modules)) byPosition.set(p, [...(byPosition.get(p) ?? []), l]);
  }
  return byPosition;
}

export function buildTapes(modules: HomeModuleInput[], lectures: HomeLectureInput[], examTopics: string[] | null, practice: PracticeIndexQuestion[] = []): HomeTape[] {
  const sorted = byOrder(modules);
  const byPosition = lecturesByModule(sorted, lectures);
  return sorted.map((m, i) => {
    const on = byPosition.get(m.position) ?? [];
    const recorded = on.length > 0;
    const dates = [...new Set(on.map((l) => l.date).filter((d): d is string => !!d))].sort();
    return {
      moduleId: m.id,
      position: m.position,
      label: m.topic ? `Mod ${m.position}: ${m.topic}` : m.name,
      state: recorded ? "recorded" : "blank",
      shell: recorded ? (((i % 4) + 1) as 1 | 2 | 3 | 4) : null,
      lectureDates: dates,
      link: !recorded ? null : (tapePracticeLink(dates, practice) ?? { href: "/course/tape", label: "Open the course tape", note: dates.length ? `${dates.map(shortDate).join(", ")}: no questions yet` : null }),
      onNextExam: onExam(m.topic, examTopics),
    };
  });
}

const PHONE_TAPES = 5;

/** The tapes the phone shows before "See all" ([from, to) indexes): five, ending one past the latest recording. */
export function phoneWindow(count: number, latestRecorded: number): [number, number] {
  const end = Math.min(count, Math.max(PHONE_TAPES, latestRecorded + 2));
  return [Math.max(0, end - PHONE_TAPES), end];
}

// ---------- Practice index (lib/home/practice.ts reads it for /practice) ----------

/** Modules with at least one question. */
export function readyModules(index: PracticeIndexQuestion[]): number[] {
  return [...new Set(index.map((q) => q.module).filter((m): m is number => m !== null))].sort((a, b) => a - b);
}

/** Lecture dates with at least one question. */
export function practicedLectures(index: PracticeIndexQuestion[]): string[] {
  return [...new Set(index.map((q) => q.lectureDate).filter((d): d is string => !!d))].sort();
}

/** "the Oct 22 lecture", "the Oct 20 and Oct 22 lectures". */
export const lectureWords = (dates: string[]) => {
  const names = dates.map(shortDate);
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `the ${list} lecture${dates.length === 1 ? "" : "s"}`;
};

/** The link a tape opens for its own lectures: practice for the ones with questions, naming any without. */
export function tapePracticeLink(tapeDates: string[], index: PracticeIndexQuestion[]): { href: string; label: string; note: string | null } | null {
  const have = new Set(practicedLectures(index));
  const yes = tapeDates.filter((d) => have.has(d));
  if (!yes.length) return null;
  const none = tapeDates.filter((d) => !have.has(d));
  return {
    href: `/practice?lecture=${yes.join(",")}`,
    label: `Practice ${lectureWords(yes)}`,
    note: none.length ? `${none.map(shortDate).join(", ")}: no questions yet` : null,
  };
}

// ---------- Home ----------

// ---------- Quiz first, coverage, the guess ----------

const quoted = <T,>(s: Sourced<T>): T | null => (s.value != null && s.quote ? s.value : null);

/**
 * A quiz (not an exam) whose topics were found and whose date is known (quoted, or else its Canvas due
 * date, labelled as such), not past, and before the next exam (or with no next exam date): the nearest
 * one. Shown above the exam, since it's this week's work. Its practice: the modules its topics name.
 */
export function nextQuiz(
  exams: HomeExamInput[],
  now: string,
  examDay: string | null,
  modules: HomeModuleInput[] = [],
  practice: PracticeIndexQuestion[] = [],
): HomeModel["quiz"] {
  const today = easternDate(now)!;
  const q = exams
    .filter((e) => !isMajorExam(e) && quoted(e.topics)?.length)
    .map((e, i) => ({ e, i, day: quoted(e.date) ? easternDate(e.date.value) : e.windowCloses ? easternDate(e.windowCloses.value) : null }))
    .filter((x) => x.day && x.day >= today && (!examDay || x.day < examDay))
    .sort((a, b) => a.day!.localeCompare(b.day!) || a.i - b.i)[0];
  if (!q) return null;
  const exam = toHomeExam(q.e, "quiz");
  const days = daysBetween(today, q.day!);
  const words = new Set(q.e.topics.value!.flatMap(topicStems));
  const named = byOrder(modules).filter((m) => m.topic && topicStems(m.topic).some((w) => words.has(w))).map((m) => m.position);
  return {
    exam,
    days,
    text: days === 0 ? `${exam.title} is today` : `${exam.title} in ${days} ${days === 1 ? "day" : "days"}`,
    practice: named.length ? { modules: named, href: `/practice?modules=${named.join(",")}`, ready: readyText(named, readyModules(practice)).text } : null,
  };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Module 9" / "Modules 8 to 10" / "Modules 8, 10". */
export function modulesText(positions: number[], to = " to "): string {
  const p = [...positions].sort((a, b) => a - b);
  if (p.length === 1) return `Module ${p[0]}`;
  const consecutive = p.every((x, i) => i === 0 || x === p[i - 1] + 1);
  return consecutive ? `Modules ${p[0]}${to}${p[p.length - 1]}` : `Modules ${p.join(", ")}`;
}

/**
 * Our guess at what the next exam covers when its topics weren't found: the modules after the one
 * holding the previous exam (named in a module's items, else the last module dated on or before
 * it), up to the last module with a date on or before the next exam. Module dates are its items'
 * due dates and its lectures. Returns why not, instead of guessing, when any piece isn't found.
 */
export function guessCoverage(
  modules: HomeModuleInput[],
  lectureDates: Map<number, string[]>,
  prev: { name: string; day: string } | null,
  next: { name: string; day: string | null },
): { guess: CoverageGuess | null; noGuess: string | null } {
  if (!next.day) return { guess: null, noGuess: `${next.name}'s date wasn't found, so we can't guess what it covers.` };
  if (!prev) return { guess: null, noGuess: `No earlier exam has a date, so we can't guess what ${next.name} covers.` };
  const sorted = byOrder(modules);
  const earliest = (m: HomeModuleInput) => [...m.dates, ...(lectureDates.get(m.position) ?? [])].sort()[0] ?? null;
  const mention = new RegExp(`\\b${esc(prev.name)}(?![\\w])`, "i");
  let hold = sorted.findIndex((m) => [m.name, m.topic ?? "", ...m.itemTitles].some((t) => mention.test(t)));
  let holdWhy = "is in";
  if (hold < 0) {
    sorted.forEach((m, i) => {
      const d = earliest(m);
      if (d && d <= prev.day) hold = i;
    });
    holdWhy = "falls during";
  }
  if (hold < 0) return { guess: null, noGuess: `We couldn't tell which module ${prev.name} came after, so we won't guess.` };
  const after = sorted.slice(hold + 1);
  let last = -1;
  after.forEach((m, i) => {
    const d = earliest(m);
    if (d && d <= next.day!) last = i;
  });
  if (last < 0) return { guess: null, noGuess: `No module after ${prev.name} has a date before ${next.name}, so we won't guess.` };
  const positions = after.slice(0, last + 1).map((m) => m.position);
  const trailing: number[] = [];
  for (const m of after.slice(last + 1)) {
    if (earliest(m)) break;
    trailing.push(m.position);
  }
  const lastPos = positions[positions.length - 1];
  return {
    guess: {
      since: prev.name,
      positions,
      label: `Everything since ${prev.name} (${modulesText(positions)})`,
      why: `${prev.name} ${holdWhy} Module ${sorted[hold].position}; Module ${lastPos} is the last module with a date before ${next.name}.`,
      leftOut: trailing.length ? `${modulesText(trailing)} ${trailing.length === 1 ? "has" : "have"} no dates yet, so ${trailing.length === 1 ? "it's" : "they're"} left out.` : null,
    },
    noGuess: null,
  };
}

/** "Ready: Modules 9 to 10 · not yet: 8": which picked modules the practice set has questions for. Never claims more. */
export function readyText(picked: number[], ready: number[]): { ready: number[]; notYet: number[]; text: string } {
  const has = new Set(ready);
  const r = [...new Set(picked)].filter((p) => has.has(p)).sort((a, b) => a - b);
  const n = [...new Set(picked)].filter((p) => !has.has(p)).sort((a, b) => a - b);
  if (!picked.length) return { ready: r, notYet: n, text: "Pick at least one module." };
  if (!r.length) return { ready: r, notYet: n, text: `No questions yet for ${modulesText(n, "–")}.` };
  return { ready: r, notYet: n, text: `Ready: ${modulesText(r, "–")}${n.length ? ` · not yet: ${n.join(", ")}` : ""}` };
}

export function buildHome(inp: HomeInputs): HomeModel {
  const { countdown, exam } = countdownOf(inp.exams, inp.now);
  const examTopics = exam ? quoted(exam.topics) : null;
  const sorted = byOrder(inp.modules);
  const tapes = buildTapes(sorted, inp.lectures, examTopics, inp.practice);
  let latestRecorded = -1;
  tapes.forEach((t, i) => {
    if (t.state === "recorded") latestRecorded = i;
  });
  const examDay = exam && quoted(exam.date) ? easternDate(exam.date.value) : null;

  const byPosition = lecturesByModule(sorted, inp.lectures);
  const lectureDates = new Map([...byPosition].map(([p, ls]) => [p, ls.map((l) => l.date).filter((d): d is string => !!d)]));
  const title = countdown.exam?.title ?? "Next exam";
  let coverage: Coverage;
  if (examTopics?.length) coverage = { kind: "known", title, topics: examTopics };
  else {
    // The previous exam: the latest exam with a found date before this one.
    const prev = examDay
      ? inp.exams
          .filter((e) => isMajorExam(e) && e !== exam && quoted(e.date) && quoted(e.name))
          .map((e) => ({ name: e.name.value!.trim(), day: easternDate(e.date.value)! }))
          .filter((e) => e.day < examDay)
          .sort((a, b) => a.day.localeCompare(b.day))
          .pop() ?? null
      : null;
    const { guess, noGuess } = exam ? guessCoverage(sorted, lectureDates, prev, { name: title, day: examDay }) : { guess: null, noGuess: "No exam was found, so there's nothing to guess from." };
    coverage = { kind: "unknown", text: `${exam ? title : "Exam"} topics: not found in the syllabus or announcements.`, guess, noGuess };
  }


  return {
    course: inp.course,
    now: inp.now,
    countdown,
    quiz: nextQuiz(inp.exams, inp.now, examDay, sorted, inp.practice),
    coverage,
    ready: { positions: readyModules(inp.practice), lectureDates: practicedLectures(inp.practice) },
    practice: inp.practice,
    tapes,
    latestRecorded,
  };
}
