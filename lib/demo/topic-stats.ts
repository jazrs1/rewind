// The demo's topic stats (public/demo/course/topic-stats.json): per Course tape stop and lecture, the minutes the full
// recording spends on it and where the professor flagged it, as numbers only (no lecture text). The demo's lectures
// hold only the clips behind its questions, so without this file the tape glows only from flags and reviews.
// scripts/demo/topic-stats.ts writes it from the pipeline's cached embeddings (a slide timeline) and the regex radar;
// readDemoBundle reads it when it's there, and buildDemoTape passes it to the tape as derived numbers.
// Pure: the reading and writing are the script's.

import { isLectureDeck, LECTURE_SLIDE_MIN } from "../pipeline/lecture-slides.ts";
import { cosine } from "../rewind.ts";
import type { DerivedTopic } from "../course/types.ts";
import { slideTitle, slideTopic, type TopicTable } from "./topics.ts";

export const TOPIC_STATS_FILE = "topic-stats.json";
export const TOPIC_STATS_VERSION = 1;
export const FLAG_KINDS = ["exam", "importance", "common-mistake", "interview", "recall", "other"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export interface TopicStatsRow {
  /** A demo tape stop id (the topic's slug). */
  topic: string;
  /** The lecture's date, YYYY-MM-DD. */
  lecture: string;
  minutes: number;
  flags: { kind: FlagKind; sec: number }[];
}

export interface TopicStatsFile {
  version: typeof TOPIC_STATS_VERSION;
  course: string;
  topics: TopicStatsRow[];
}

/** The only strings the file may hold: these keys, each in its own narrow shape (so no lecture text gets in). */
export const STRING_SHAPES: Record<string, RegExp> = {
  course: /^[A-Z]{3}\d{4}[A-Z]?$/,
  topic: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  lecture: /^\d{4}-\d{2}-\d{2}$/,
  kind: new RegExp(`^(?:${FLAG_KINDS.join("|")})$`),
};

const exactKeys = (o: object, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** Checks topic-stats.json; throws with what's wrong, so a bad file fails the build. */
export function parseTopicStats(raw: unknown): TopicStatsFile {
  const fail = (msg: string): never => {
    throw new Error(`Demo topic stats public/demo/course/${TOPIC_STATS_FILE}: ${msg}`);
  };
  const f = raw as Partial<TopicStatsFile> | null;
  if (!f || typeof f !== "object" || !exactKeys(f, ["version", "course", "topics"])) fail("must have exactly version, course and topics");
  if (f!.version !== TOPIC_STATS_VERSION) fail(`version must be ${TOPIC_STATS_VERSION}`);
  if (typeof f!.course !== "string" || !STRING_SHAPES.course.test(f!.course)) fail("course must be a course code");
  if (!Array.isArray(f!.topics)) fail("topics must be a list");
  const seen = new Set<string>();
  for (const [i, r] of f!.topics!.entries()) {
    const at = `topics[${i}]`;
    if (!r || typeof r !== "object" || !exactKeys(r, ["topic", "lecture", "minutes", "flags"])) fail(`${at} must have exactly topic, lecture, minutes and flags`);
    if (typeof r.topic !== "string" || !STRING_SHAPES.topic.test(r.topic)) fail(`${at}.topic must be a stop id`);
    if (typeof r.lecture !== "string" || !STRING_SHAPES.lecture.test(r.lecture)) fail(`${at}.lecture must be a date`);
    if (seen.has(`${r.topic} ${r.lecture}`)) fail(`${at}: ${r.topic} on ${r.lecture} is listed twice`);
    seen.add(`${r.topic} ${r.lecture}`);
    if (!isNum(r.minutes)) fail(`${at}.minutes must be a number, 0 or more`);
    if (!Array.isArray(r.flags)) fail(`${at}.flags must be a list`);
    for (const [k, x] of r.flags.entries()) {
      if (!x || typeof x !== "object" || !exactKeys(x, ["kind", "sec"])) fail(`${at}.flags[${k}] must have exactly kind and sec`);
      if (!(FLAG_KINDS as readonly string[]).includes(x.kind)) fail(`${at}.flags[${k}].kind must be one of ${FLAG_KINDS.join(", ")}`);
      if (!isNum(x.sec)) fail(`${at}.flags[${k}].sec must be a number, 0 or more`);
    }
  }
  return f as TopicStatsFile;
}

/** The tape's derived numbers from the stats: one per row whose stop the tape has (stop id → its topic name). */
export function derivedTopics(stats: TopicStatsFile | null | undefined, topicOfStop: Map<string, string>): DerivedTopic[] {
  return (stats?.topics ?? []).flatMap((r) => {
    const topic = topicOfStop.get(r.topic);
    return topic ? [{ topic, lecture: r.lecture, minutes: r.minutes, flags: r.flags.map((f) => ({ kind: f.kind, sec: f.sec })) }] : [];
  });
}

// ---------- the slide timeline (scripts/demo/topic-stats.ts) ----------

/** A numbered lecture deck: never a Discussion, Review or game deck (the matcher's rule, lib/pipeline/lecture-slides.ts). */
export { isLectureDeck };
/** A window whose best slide scores under this is off the slides. */
export const OFF_SLIDES = LECTURE_SLIDE_MIN;
/** Labels are smoothed over this many windows on each side. */
export const SMOOTH = 2;
/** Radar moments of the same kind closer than this are one flag. */
export const MERGE_SEC = 15;

export const OFF = "~off";
/** A window's label: a stop id, OFF, or "~<deck>#<page>" for a slide with no demo topic. */
export const pageKey = (deck: string, page: number) => `~${deck}#${page}`;
/** A page titled like this is the deck's agenda. */
const AGENDA = /^(?:agenda|outline)\b/i;

/**
 * Each page's demo stop topic (a name the tape has), or null. From its title by the topics table (lib/demo/topics.ts);
 * a page with no text title takes the topic of the page before it; then the table's merges are followed until the name
 * is one of the stops (a fine topic the demo merged away lands on the stop it was merged into). An agenda page lists
 * the deck's topics and teaches none, so it has none (its title would match whichever topic it names first).
 */
export function pageTopics(pages: { deck: string; page: number; text: string | null }[], table: TopicTable, stops: Set<string>): Map<string, string | null> {
  const resolve = (name: string | null): string | null => {
    for (let hops = 0; name && !stops.has(name) && hops <= table.merges.length; hops++) name = table.merges.find((m) => m.from.includes(name!))?.into ?? null;
    return name && stops.has(name) ? name : null;
  };
  const out = new Map<string, string | null>();
  const byDeck = new Map<string, typeof pages>();
  for (const p of pages) byDeck.set(p.deck, [...(byDeck.get(p.deck) ?? []), p]);
  for (const list of byDeck.values()) {
    let prev: string | null = null;
    for (const p of [...list].sort((a, b) => a.page - b.page)) {
      const own = AGENDA.test(slideTitle(p.text) ?? "") ? null : (slideTopic(table, p.deck, p.page, p.text)?.topic ?? null);
      const topic: string | null = own ? resolve(own) : slideTitle(p.text) === null ? prev : null;
      out.set(`${p.deck}#${p.page}`, topic);
      prev = topic;
    }
  }
  return out;
}

/** Each window's best page among `pages` (indexes into pageVecs) and its score. */
export function bestPages(windowVecs: number[][], pageVecs: number[][], pages: number[]): { page: number; score: number }[] {
  return windowVecs.map((w) => {
    let best = { page: -1, score: -Infinity };
    for (const p of pages) {
      const s = cosine(w, pageVecs[p]);
      if (s > best.score) best = { page: p, score: s };
    }
    return best;
  });
}

/** Each label replaced by the most common label within ±k (ties keep its own, then the earliest). */
export function smooth(labels: string[], k = SMOOTH): string[] {
  return labels.map((own, i) => {
    const count = new Map<string, number>();
    for (let j = Math.max(0, i - k); j <= Math.min(labels.length - 1, i + k); j++) count.set(labels[j], (count.get(labels[j]) ?? 0) + 1);
    const top = Math.max(...count.values());
    return count.get(own) === top ? own : [...count].find(([, n]) => n === top)![0];
  });
}

/**
 * The seconds each window stands for: from its start to the next window's start (windows overlap), never past its own
 * end (a gap where someone else talks belongs to nobody). Windows in time order.
 */
export function windowSpans(windows: { start: number; end: number }[]): { start: number; end: number }[] {
  return windows.map((w, i) => ({ start: w.start, end: Math.max(w.start, Math.min(w.end, windows[i + 1]?.start ?? w.end)) }));
}

/**
 * Where each label is taught: every run of a smoothed label, trimmed to its first and last window whose own (unsmoothed)
 * label is that one, so a window smoothing pulled in (a title slide, an off-slides aside) is not inside it. A run with
 * no window of its own label is no span. Spans in time order, from windowSpans.
 */
export function taughtSpans(spans: { start: number; end: number }[], raw: string[], labels: string[]): { label: string; start: number; end: number }[] {
  const out: { label: string; start: number; end: number }[] = [];
  for (let i = 0; i < labels.length; ) {
    let j = i;
    while (j + 1 < labels.length && labels[j + 1] === labels[i]) j++;
    const own = [...Array(j - i + 1).keys()].map((d) => i + d).filter((k) => raw[k] === labels[i]);
    if (own.length) out.push({ label: labels[i], start: spans[own[0]].start, end: spans[own.at(-1)!].end });
    i = j + 1;
  }
  return out;
}

/** The label taught at a second: the taught span holding it, else null (a flag outside every span counts for nobody). */
export function labelAt(taught: { label: string; start: number; end: number }[], sec: number): string | null {
  return taught.find((s) => sec >= s.start && sec < s.end)?.label ?? null;
}

/** Radar moments as flags: kinds outside FLAG_KINDS are "other", same-kind moments under `gap` s apart are one (the first). */
export function mergeFlags(hits: { sec: number; kind: string | null }[], gap = MERGE_SEC): { kind: FlagKind; sec: number }[] {
  const kindOf = (k: string | null): FlagKind => ((FLAG_KINDS as readonly string[]).includes(k ?? "") ? (k as FlagKind) : "other");
  const out: { kind: FlagKind; sec: number }[] = [];
  const last = new Map<FlagKind, number>();
  for (const h of [...hits].sort((a, b) => a.sec - b.sec)) {
    const kind = kindOf(h.kind);
    const prev = last.get(kind);
    last.set(kind, h.sec);
    if (prev !== undefined && h.sec - prev < gap) continue;
    out.push({ kind, sec: Math.floor(h.sec) });
  }
  return out;
}
