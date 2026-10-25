// Quick build (beta): "Coming up", the course's exams, quizzes and assignments from Canvas's own due dates.
//   - Read from the course export on this device only. Only each assignment's name, due date and Canvas link are
//     kept; descriptions, points, submissions and grades are never read. Nothing here is sent anywhere.
//   - No model: a due date is Canvas's own `due_at`, so there is nothing to guess. An assignment with no due date
//     isn't shown.
//   - Kept in its own localStorage key per course ("rewind.quick-upcoming.v1.COP3530"), apart from the question bank,
//     with every read and write in try/catch (memory only when storage fails), like lib/quick/store.ts.
//   - `exams` is the slot for exam details read from the syllabus and announcements (date, title, the word-for-word
//     quote); this file only stores and shows them.

import { courseKey, type StorageLike } from "../attempts/store.ts";

type Env = Record<string, string | undefined>;

/** Behind its own flag, off by default (and only where Quick build is on). */
export function upcomingOn(env: Env = process.env): boolean {
  return env.NEXT_PUBLIC_REWIND_UPCOMING === "1";
}
/** Client-side: Next inlines NEXT_PUBLIC_ values at build, so this literal read is the one the browser sees. */
export const UPCOMING_ON = process.env.NEXT_PUBLIC_REWIND_UPCOMING === "1";

export type DueKind = "exam" | "quiz" | "assignment";

export interface DueItem {
  title: string;
  kind: DueKind;
  /** ISO time, from Canvas's due_at. */
  dueAt: string;
  /** The assignment's Canvas page, when the export has one on https. */
  url?: string;
}

/** An exam read from the syllabus or announcements: its date and the exact words it came from. */
export interface SourcedExam {
  title: string;
  /** ISO date or time. */
  date: string;
  quote: string;
  source: string;
}

export interface Upcoming {
  v: number;
  course: { code: string; name: string };
  readAt: string;
  /** The export's Canvas host (canvasHostOf); every stored link must be https on it, checked again on read. */
  host?: string;
  items: DueItem[];
  exams?: SourcedExam[];
}

export const UPCOMING_VERSION = 1;
export const UPCOMING_PREFIX = `rewind.quick-upcoming.v${UPCOMING_VERSION}.`;
export const upcomingKey = (course: string) => UPCOMING_PREFIX + courseKey(course);

/** Items kept per course. */
export const MAX_ITEMS = 60;
/** Something due earlier today still shows (as "Today") for this long after its time. */
const GRACE_MS = 6 * 60 * 60 * 1000;

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

const EXAM = /\b(exam|midterm|mid-term|final)\b/i;
/** "Exam 2 review", "Practice midterm": practice for an exam, not the exam. */
const NOT_EXAM = /\b(review|practice|prep|sample|mock|study guide|request|survey|accommodation|conflict|makeup form|wrapper)\b/i;

/** Exam, quiz or assignment, from the assignment's name and Canvas's own quiz markers. */
export function kindOf(a: Record<string, unknown>): DueKind {
  const name = typeof a.name === "string" ? a.name : "";
  if (EXAM.test(name) && !NOT_EXAM.test(name)) return "exam";
  const types = Array.isArray(a.submission_types) ? a.submission_types : [];
  if (a.is_quiz_assignment === true || a.quiz_id != null || types.includes("online_quiz") || /\bquiz(zes)?\b/i.test(name)) return "quiz";
  return "assignment";
}

const httpsHost = (x: unknown): string | undefined => {
  if (typeof x !== "string") return undefined;
  try {
    const u = new URL(x);
    return u.protocol === "https:" && u.hostname ? u.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

/** A link kept only when it's https on the course's own Canvas host; query and fragment are dropped. */
export function canvasUrl(x: unknown, host: string | undefined): string | undefined {
  if (!host || httpsHost(x) !== host.toLowerCase()) return undefined;
  const u = new URL(x as string);
  return u.port ? undefined : `${u.origin}${u.pathname}`;
}

/**
 * The export's Canvas host: the host most of its own https links (pages, module items, assignments) are on, when
 * more than half are. No such host, no links.
 */
export function canvasHostOf(json: unknown): string | undefined {
  if (!isObject(json)) return undefined;
  const urls: unknown[] = [];
  const add = (xs: unknown) => {
    if (Array.isArray(xs)) for (const x of xs) if (isObject(x)) urls.push(x.html_url);
  };
  add(json.pages);
  add(json.assignments);
  if (Array.isArray(json.modules)) for (const m of json.modules) if (isObject(m)) add(m.items);
  const counts = new Map<string, number>();
  let total = 0;
  for (const u of urls) {
    const h = httpsHost(u);
    if (!h) continue;
    total++;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  for (const [h, n] of counts) if (n * 2 > total) return h;
  return undefined;
}

/**
 * What's coming up, from a course export's assignments: due from today on, soonest first. Only the name, due date
 * and link are read; a link is kept only on the export's own Canvas host (canvasHostOf). Anything without a due
 * date, unpublished, or not an object is skipped.
 */
export function upcomingOf(json: unknown, now: Date = new Date()): DueItem[] {
  if (!isObject(json) || !Array.isArray(json.assignments)) return [];
  const host = canvasHostOf(json);
  const from = now.getTime() - GRACE_MS;
  const seen = new Set<string>();
  const out: DueItem[] = [];
  for (const a of json.assignments) {
    if (!isObject(a) || a.published === false) continue;
    const name = typeof a.name === "string" ? a.name.replace(/\s+/g, " ").trim().slice(0, 140) : "";
    if (!name || typeof a.due_at !== "string") continue;
    const t = Date.parse(a.due_at);
    if (!Number.isFinite(t) || t < from) continue;
    const dueAt = new Date(t).toISOString();
    const id = `${name}|${dueAt}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const url = canvasUrl(a.html_url, host);
    out.push({ title: name, kind: kindOf(a), dueAt, ...(url ? { url } : {}) });
  }
  return out.sort((x, y) => x.dueAt.localeCompare(y.dueAt) || x.title.localeCompare(y.title)).slice(0, MAX_ITEMS);
}

/** Items still ahead of `now` (with the same grace as upcomingOf), for a stored list read later. */
export function stillAhead(items: DueItem[], now: Date = new Date()): DueItem[] {
  const from = now.getTime() - GRACE_MS;
  return items.filter((i) => Date.parse(i.dueAt) >= from);
}

const dayKey = (d: Date, timeZone?: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Calendar days from `now` to `at`, in the given time zone (the browser's by default). */
export function daysUntil(at: Date, now: Date = new Date(), timeZone?: string): number {
  const a = Date.parse(dayKey(at, timeZone));
  const b = Date.parse(dayKey(now, timeZone));
  return Math.round((a - b) / 86_400_000);
}

/** "Today", "Tomorrow", "In 5 days", "In 3 weeks". */
export function whenText(at: Date, now: Date = new Date(), timeZone?: string): string {
  const d = daysUntil(at, now, timeZone);
  if (d <= 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d < 14) return `In ${d} days`;
  return `In ${Math.round(d / 7)} weeks`;
}

/** "Tue, Oct 28 · 11:59 PM". */
export function dueText(at: Date, timeZone?: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  return `${day} · ${time}`;
}

function isItem(x: unknown): x is DueItem {
  return isObject(x) && typeof x.title === "string" && typeof x.dueAt === "string" && ["exam", "quiz", "assignment"].includes(x.kind as string) && (x.url === undefined || typeof x.url === "string");
}
function isExam(x: unknown): x is SourcedExam {
  return isObject(x) && typeof x.title === "string" && typeof x.date === "string" && typeof x.quote === "string" && typeof x.source === "string";
}

export function parseUpcoming(raw: string | null): Upcoming | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as unknown;
    if (!isObject(u) || u.v !== UPCOMING_VERSION || !isObject(u.course) || typeof u.course.code !== "string" || typeof u.course.name !== "string") return null;
    if (!Array.isArray(u.items) || !u.items.every(isItem)) return null;
    const host = typeof u.host === "string" && /^[a-z0-9.-]+$/i.test(u.host) ? u.host.toLowerCase() : undefined;
    // A stored link gets the same check as when it was read from the export; an item whose link fails is dropped.
    const items = u.items.filter((i) => i.url === undefined || canvasUrl(i.url, host) === i.url);
    const exams = Array.isArray(u.exams) ? u.exams.filter(isExam) : undefined;
    return { v: UPCOMING_VERSION, course: { code: u.course.code, name: u.course.name }, readAt: typeof u.readAt === "string" ? u.readAt : "", ...(host ? { host } : {}), items, ...(exams ? { exams } : {}) };
  } catch {
    return null;
  }
}

export interface UpcomingStore {
  read(course: string): Upcoming | null;
  write(u: Omit<Upcoming, "v">): void;
  clear(course: string): void;
  subscribe(fn: () => void): () => void;
}

export function createUpcomingStore(storage: () => StorageLike | null): UpcomingStore {
  const memory = new Map<string, Upcoming>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  return {
    read(course) {
      const key = upcomingKey(course);
      try {
        const s = storage();
        if (s) return parseUpcoming(s.getItem(key)) ?? memory.get(key) ?? null;
      } catch {
        // blocked: memory only
      }
      return memory.get(key) ?? null;
    },
    write(u) {
      const full: Upcoming = { v: UPCOMING_VERSION, ...u };
      const key = upcomingKey(u.course.code);
      memory.set(key, full);
      try {
        storage()?.setItem(key, JSON.stringify(full));
      } catch {
        // quota or blocked: memory copy for this page
      }
      emit();
    },
    clear(course) {
      const key = upcomingKey(course);
      memory.delete(key);
      try {
        storage()?.removeItem(key);
      } catch {
        // nothing to remove
      }
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

let shared: UpcomingStore | null = null;

/** This device's Coming up lists (server: none). */
export function browserUpcoming(): UpcomingStore {
  return (shared ??= createUpcomingStore(() => {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  }));
}
