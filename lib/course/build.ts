// Builds the course tape from what we know about a course. Pure: no I/O, no Gemini, no clock
// (the caller passes `now`). Every score is the sum of its evidence points; unknowns stay null.
//
// How the tape is put together:
// 1. Stops: one per module topic, in module order ("Module 3: Lists, Stacks, Queues" → "Lists,
//    Stacks, Queues"). Modules about orientation, reviews or exams are flags, not stops. Numbered
//    slide decks ("7 - Sets, Maps, HashTables.pdf") attach to the stop they name; a deck that
//    names no module becomes its own stop, placed after the deck numbered just before it. So a
//    course without recordings still gets stops from its modules and slides.
// 2. Lecture minutes: each lecture's lecturer lines are cut into 60 s windows, and a window
//    belongs to the topic whose keywords it says most (at least MIN_WINDOW_SCORE).
// 3. First taught: the earliest lecture with at least FIRST_TAUGHT_MIN minutes on it, or the
//    earliest week announcement whose title names it (its "(Oct 12-18)" start, else its post date).
// 4. Order: by first-taught date; stops without a date keep their course-order place between
//    dated ones. The current stop is the last one taught on or before `now`.
// 5. Route back: among taught stops on the next exam (all taught stops when its coverage is
//    unknown), the top 3 by stressed × missed; fewer than 3 with both → filled by stressed alone.

import type { CanvasModule, ImportItem } from "../import/types.ts";
import type { TranscriptSegment } from "../schema.ts";
import { bestTopic, pickTopic, slug, titleSimilarity, topicIndex, topicScores, topicsIn, type TopicIndex } from "./topics.ts";
import type {
  Clip,
  CourseTape,
  CourseTapeInputs,
  Evidence,
  Fallback,
  LectureInput,
  Marker,
  ModuleInput,
  Route,
  RouteStep,
  Score,
  Stop,
  StopState,
} from "./types.ts";

/**
 * Points per piece of evidence. Stressed: an explicit "this is on the exam" is the strongest
 * thing he can do, a past review naming the topic is nearly as direct, lecture time is broad
 * but real (10 minutes ≈ one flag of the weakest kind), and an announcement mention is cheap.
 * Missed: one wrong practice answer = 1; a grade adds 3 × the share of points lost, so a fully
 * failed quiz counts like three wrong answers and a perfect score adds 0.
 */
export const WEIGHTS = {
  radar: { exam: 3, importance: 2, "common-mistake": 2, interview: 1, recall: 1, other: 1 } as Record<string, number>,
  minutePoints: 0.1,
  review: 2,
  announcement: 1,
  practiceWrong: 1,
  practiceRight: 0,
  gradeLost: 3,
};

/**
 * "Stressed" on an absolute scale, not against the tape's top topic (which always glowed fully, even on thin evidence):
 * under `floor` points nothing glows unless he flagged it or a past review names it; `full` points is a full glow, but
 * without an "exam" or "importance" flag or a past review the glow stops at `capWithoutFlag`, so minutes alone never
 * make a topic glow fully.
 */
export const STRESS = { floor: 1.5, full: 6, capWithoutFlag: 0.6 };
/** Flag kinds strong enough to carry a full glow. */
const STRONG_FLAGS = new Set(["exam", "importance"]);

/** The stressed heat (0..1) of a stop's evidence, on the absolute scale above. */
export function stressHeat(ev: Evidence[]): number {
  const s = evidenceScore(ev);
  const strong = ev.some((e) => e.kind === "review" || (e.kind === "radar" && (e.flags ?? []).some((f) => STRONG_FLAGS.has(f))));
  const flagged = strong || ev.some((e) => e.kind === "radar");
  if (!(s > 0) || (s < STRESS.floor && !flagged)) return 0;
  const h = Math.min(1, s / STRESS.full);
  return round2(strong ? h : Math.min(h, STRESS.capWithoutFlag));
}

/** A Discussion deck (worked problems in a discussion section), never a lecture deck: its slides add no lecture minutes. */
export const isDiscussionDeck = (deck: string) => /^\s*discussion\b/i.test(deck);

export const WINDOW_SEC = 60;
/** Keyword weight a 60 s window needs to count toward a topic. */
export const MIN_WINDOW_SCORE = 2;
/** Share of each neighboring window's score added to a window's own. */
export const NEIGHBOR_SHARE = 0.5;
/** Minutes in one lecture before it can set the first-taught date. */
export const FIRST_TAUGHT_MIN = 5;
/** How far (s) a radar hit or clip may sit from a window with a topic and still take it. */
const NEAR_SEC = 120;
/** Radar clips run up to this long, over the lecturer's following lines. */
const RADAR_CLIP_SEC = 40;
const SPAN_CLIP_SEC = 60;
const MAX_CLIP_SEC = 75;
const ROUTE_LEN = 3;
const QUESTIONS_PER_STOP = 3;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** YYYY-MM-DD in Eastern time (UF), or null. Plain YYYY-MM-DD passes through. */
export function easternDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Action Items Week - 9 : Sorting (Oct 12-18)" → the range start as YYYY-MM-DD (year from postedAt). */
export function weekStart(title: string, postedAt: string | null): string | null {
  const m = title.match(/\(\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-–]/);
  const posted = easternDate(postedAt);
  if (!m || !posted) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  let year = Number(posted.slice(0, 4));
  // A range in January posted in December belongs to the next year.
  if (month === 0 && posted.slice(5, 7) === "12") year += 1;
  return `${year}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function shortDate(d: string | null): string {
  if (!d) return "date unknown";
  const [, mm, dd] = d.split("-").map(Number);
  return `${MONTHS[mm - 1][0].toUpperCase()}${MONTHS[mm - 1].slice(1)} ${dd}`;
}

// ---------- Modules ----------

const GENERIC_MODULE = /^(?:module|week|unit|chapter|lesson|topic)\s*\d+[a-z]?$/i;
const PREFIXED = /^(?:module|week|unit|chapter|lesson|topic)\s*\d+[a-z]?\s*[:\-–]\s*(.+)$/i;
/** Module topics that aren't course content: they become flags or nothing, not stops. */
const NOT_A_TOPIC = /^(?:course\s+)?(?:orientation|introduction|intro|welcome|getting started|syllabus|course information)$|\b(?:review|exams?|midterms?|finals?)\b/i;

/** Canvas modules (raw, from the export) → ModuleInput in course order. */
export function modulesFromCanvas(modules: CanvasModule[]): ModuleInput[] {
  return modules
    .map((m, i) => ({
      id: String(m.id),
      name: m.name ?? `Module ${i + 1}`,
      position: typeof m.position === "number" ? m.position : i + 1,
      itemTitles: (m.items ?? []).map((it) => it.title ?? "").filter(Boolean),
      from: "canvas" as const,
    }))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * No Canvas export: modules from lecture openings ("Hi all, this is the second lecture of
 * Module 5, which is Heaps"). Only lines that say the module number and its name count.
 */
export function modulesFromLectures(lectures: LectureInput[]): ModuleInput[] {
  const found = new Map<number, ModuleInput>();
  const re = /\bmodules?\s+(?:number\s+)?(\d{1,2})[,.]?\s+which is\s+([^.?!]+)/i;
  const sorted = [...lectures].sort((a, b) => (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""));
  for (const l of sorted) {
    for (const s of l.segments) {
      if (l.lecturer && s.speaker !== l.lecturer) continue;
      const m = s.text.match(re);
      if (!m) continue;
      const n = Number(m[1]);
      if (found.has(n)) continue;
      const name = m[2].replace(/^the\s+/i, "").replace(/\s+(?:module|and we|so)\b.*$/i, "").trim();
      found.set(n, { id: `lecture-module-${n}`, name: `Module ${n}: ${name}`, position: n, itemTitles: [], from: "lecture" });
    }
  }
  return [...found.values()].sort((a, b) => a.position - b.position);
}

function moduleTopic(m: ModuleInput): string {
  const pre = m.name.match(PREFIXED);
  if (pre) return pre[1].trim();
  if (GENERIC_MODULE.test(m.name.trim())) {
    const esc = m.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}\\s*[:\\-–]\\s*(.+)$`, "i");
    for (const t of m.itemTitles) {
      const hit = t.trim().match(re);
      if (hit) return hit[1].trim();
    }
  }
  return m.name.trim();
}

// ---------- Stops (before evidence) ----------

interface Draft {
  key: string;
  topic: string;
  topicFrom: Stop["topicFrom"];
  module: Stop["module"];
  itemTitles: string[];
  /** Course order key (module position × 100, slides-only stops in between). */
  courseOrder: number;
  slides: Fallback[];
}

const DECK = /^(\d{1,2})([a-z]?)\s*[-–]\s*(.+?)(?:[_\s-]*revised)?\.(?:pdf|pptx?)$/i;

function draftStops(modules: ModuleInput[], items: ImportItem[], notes: string[]): Draft[] {
  const drafts: Draft[] = [];
  const used = new Set<string>();
  const uniqueKey = (topic: string) => {
    let key = slug(topic);
    for (let i = 2; used.has(key); i++) key = `${slug(topic)}-${i}`;
    used.add(key);
    return key;
  };
  for (const m of modules) {
    const topic = moduleTopic(m);
    if (NOT_A_TOPIC.test(topic)) {
      notes.push(`"${m.name}" (${topic}) isn't a topic (orientation, review or exam), so it isn't a stop.`);
      continue;
    }
    drafts.push({
      key: uniqueKey(topic),
      topic,
      topicFrom: m.from === "lecture" ? "lecture" : "module",
      module: { id: m.id, name: m.name, position: m.position },
      itemTitles: m.itemTitles,
      courseOrder: m.position * 100,
      slides: [],
    });
  }

  // Numbered slide decks, lowest number first; review, practice, syllabus and admin files aren't decks.
  const decks = items
    .filter((it) => it.role === "lecture" || it.role === "unknown")
    .map((it) => ({ it, m: it.name.match(DECK) }))
    .filter((d): d is { it: ImportItem; m: RegExpMatchArray } => !!d.m)
    .map(({ it, m }) => ({ it, num: Number(m[1]) + (m[2] ? (m[2].toLowerCase().charCodeAt(0) - 96) / 30 : 0), title: m[3].trim() }))
    .filter((d) => !NOT_A_TOPIC.test(d.title))
    .sort((a, b) => a.num - b.num || a.it.name.localeCompare(b.it.name));

  const idx0 = topicIndex(drafts.map((d) => ({ key: d.key, topic: d.topic })));
  const deckOrder: { num: number; order: number }[] = [];
  for (const d of decks) {
    let best: { draft: Draft; sim: number } | null = null;
    for (const draft of drafts) {
      if (draft.topicFrom === "slides") continue;
      const sim = titleSimilarity(d.title, draft.topic, idx0.weight);
      if (sim > 0.5 && (!best || sim > best.sim)) best = { draft, sim };
    }
    const fallback: Fallback = { kind: "slides", label: d.it.name, href: d.it.url };
    if (best) {
      if (!best.draft.slides.some((s) => s.label === fallback.label)) best.draft.slides.push(fallback);
      deckOrder.push({ num: d.num, order: best.draft.courseOrder });
      continue;
    }
    const existing = drafts.find((x) => x.topicFrom === "slides" && x.topic.toLowerCase() === d.title.toLowerCase());
    if (existing) {
      existing.slides.push(fallback);
      continue;
    }
    // After the stop holding the deck numbered just before this one (or by number when there are no modules).
    const before = deckOrder.filter((o) => o.num < d.num).sort((a, b) => b.num - a.num || b.order - a.order)[0];
    const courseOrder = before ? before.order + 1 + deckOrder.filter((o) => o.order > before.order && o.order < before.order + 100).length : d.num * 100 + 50;
    const draft: Draft = { key: uniqueKey(d.title), topic: d.title, topicFrom: "slides", module: null, itemTitles: [], courseOrder, slides: [fallback] };
    drafts.push(draft);
    deckOrder.push({ num: d.num, order: courseOrder });
  }
  return drafts.sort((a, b) => a.courseOrder - b.courseOrder || a.topic.localeCompare(b.topic));
}

// ---------- Lectures ----------

interface LectureTopics {
  lecture: LectureInput;
  date: string | null;
  lines: TranscriptSegment[];
  /** Topic key per window index (absent = no topic). */
  windowTopic: Map<number, string>;
}

function analyzeLecture(lecture: LectureInput, idx: TopicIndex, fixedKey: string | null = null): LectureTopics {
  const lines = lecture.segments.filter((s) => !lecture.lecturer || s.speaker === lecture.lecturer);
  const byWindow = new Map<number, string[]>();
  for (const s of lines) {
    const w = Math.floor(s.start / WINDOW_SEC);
    byWindow.set(w, [...(byWindow.get(w) ?? []), s.text]);
  }
  // The caller named its module: every window is that stop's.
  if (fixedKey) return { lecture, date: easternDate(lecture.recordedAt), lines, windowTopic: new Map([...byWindow.keys()].map((w) => [w, fixedKey])) };
  const raw = new Map([...byWindow].map(([w, texts]) => [w, topicScores(texts.join(" "), idx)]));
  const windowTopic = new Map<number, string>();
  for (const w of byWindow.keys()) {
    // A window's score is its own plus half of each neighbor's, so a steady topic that he names
    // about once a minute still counts, while one stray word doesn't.
    const smooth = new Map<string, number>();
    for (const [dw, f] of [[-1, NEIGHBOR_SHARE], [0, 1], [1, NEIGHBOR_SHARE]] as const) {
      for (const [k, v] of raw.get(w + dw) ?? []) smooth.set(k, (smooth.get(k) ?? 0) + v * f);
    }
    const best = pickTopic(smooth, idx, MIN_WINDOW_SCORE);
    if (best && (raw.get(w)?.get(best.key) ?? 0) > 0) windowTopic.set(w, best.key);
  }
  return { lecture, date: easternDate(lecture.recordedAt), lines, windowTopic };
}

/** His line in these windows that names the topic most (word for word). */
function bestLine(lt: LectureTopics, windows: number[], key: string, idx: TopicIndex): TranscriptSegment | null {
  const set = new Set(windows);
  let best: { s: TranscriptSegment; v: number } | null = null;
  for (const s of lt.lines) {
    if (!set.has(Math.floor(s.start / WINDOW_SEC))) continue;
    const v = topicScores(s.text, idx).get(key) ?? 0;
    if (v > 0 && (!best || v > best.v)) best = { s, v };
  }
  return best?.s ?? null;
}

/** The topic at a time in a lecture: its window's, else the nearest window with a topic within NEAR_SEC. */
function topicAt(lt: LectureTopics, sec: number): string | null {
  const w = Math.floor(sec / WINDOW_SEC);
  const reach = Math.ceil(NEAR_SEC / WINDOW_SEC);
  for (let d = 0; d <= reach; d++) {
    const before = lt.windowTopic.get(w - d);
    const after = lt.windowTopic.get(w + d);
    if (before) return before;
    if (after) return after;
  }
  return null;
}

/**
 * A lecture's slide timeline as on-screen stretches per topic: each span is its deck's topic (a Discussion deck's span
 * belongs to no topic, key null). A timeline that names no lecture-deck topic at all is no timeline: the windows decide.
 */
function slideTimeline(lecture: LectureInput, topicOf: (deck: string) => string | null): { key: string | null; start: number; end: number }[] {
  const spans = [...(lecture.slideTimeline ?? [])].filter((s) => s.endSec > s.startSec).sort((a, b) => a.startSec - b.startSec);
  const out = spans.map((s) => ({ key: isDiscussionDeck(s.deck) ? null : topicOf(s.deck), start: s.startSec, end: s.endSec }));
  return out.some((t) => t.key) ? out : [];
}

/** A clip from a line: runs over his following lines while it stays under `maxSec`, ending at a line end. */
function clipFromLine(lt: LectureTopics, start: number, maxSec: number): { start: number; end: number; quote: string } | null {
  const i = lt.lines.findIndex((s) => s.start >= start - 0.05);
  if (i < 0) return null;
  const first = lt.lines[i];
  let end = first.end;
  for (let j = i + 1; j < lt.lines.length; j++) {
    const s = lt.lines[j];
    // Stop at a gap (another speaker talked) or past the length.
    if (s.start - end > 3 || s.end - first.start > maxSec) break;
    end = s.end;
  }
  return { start: first.start, end: Math.min(end, first.start + MAX_CLIP_SEC), quote: first.text };
}

// ---------- Build ----------

export function buildCourseTape(inp: CourseTapeInputs): CourseTape {
  const notes = [...(inp.notes ?? [])];
  const nowDate = easternDate(inp.now)!;
  const drafts = draftStops(inp.modules, inp.items, notes);
  const idx = topicIndex(drafts.map((d) => ({ key: d.key, topic: d.topic })));
  const stressed = new Map<string, Evidence[]>(drafts.map((d) => [d.key, []]));
  const missed = new Map<string, Evidence[]>(drafts.map((d) => [d.key, []]));
  const clips = new Map<string, Clip[]>(drafts.map((d) => [d.key, []]));
  const practiceIds = new Map<string, string[]>(drafts.map((d) => [d.key, []]));
  const minutesOf = new Map<string, number>(drafts.map((d) => [d.key, 0]));
  const dates = new Map<string, { at: string; from: NonNullable<Stop["firstTaughtFrom"]> }>();
  const unplaced: Evidence[] = [];
  /** A module the caller named → its stop's key (null when it isn't a stop). */
  const keyOfModule = (id: string | undefined) => (id ? (drafts.find((d) => d.module?.id === id)?.key ?? null) : null);

  const offerDate = (key: string, at: string | null, from: NonNullable<Stop["firstTaughtFrom"]>) => {
    if (!at) return;
    const cur = dates.get(key);
    if (!cur || at < cur.at) dates.set(key, { at, from });
  };

  /** Stops a short text names, plus the module it's listed in (by item title). */
  const stopsFor = (name: string): string[] => {
    const n = name.trim().toLowerCase();
    const listed = n.length >= 6
      ? drafts.filter((d) => d.itemTitles.some((t) => {
          const tt = t.trim().toLowerCase();
          return tt.startsWith(n) || n.startsWith(tt);
        })).map((d) => d.key)
      : [];
    return [...new Set([...listed, ...topicsIn(name, idx)])].sort((a, b) => idx.rank.get(a)! - idx.rank.get(b)!);
  };

  // Lectures: minutes per topic, first-taught dates, lecture-span clips. Minutes come from the slide timeline when the
  // lecture has one (how long each topic's lecture-deck slides are on screen), else from keyword windows. A lecture of
  // clip excerpts only still dates its topics and gives clips, but its minutes add nothing to "stressed".
  const deckTopic = (deck: string): string | null => {
    const d = deck.trim().toLowerCase();
    const byDeck = drafts.find((x) => x.slides.some((s) => s.label.replace(/\.[a-z0-9]+$/i, "").toLowerCase() === d));
    return byDeck?.key ?? topicsIn(deck.replace(/^\s*\d{1,2}[a-z]?\s*[-–]\s*/, ""), idx)[0] ?? null;
  };
  const lectures = new Map<string, LectureTopics>();
  let lecturerSec = 0;
  let minutesCount = false;
  for (const lecture of inp.lectures) {
    const lt = analyzeLecture(lecture, idx, keyOfModule(lecture.moduleId));
    lectures.set(lecture.id, lt);
    lecturerSec += lt.lines.reduce((s, l) => s + Math.max(0, l.end - l.start), 0);
    const timeline = slideTimeline(lecture, deckTopic);
    // Seconds per topic and where its stretches start, from the slides when there are any, else from the windows.
    const spans = new Map<string, [number, number][]>();
    if (timeline.length) {
      for (const t of timeline) if (t.key) spans.set(t.key, [...(spans.get(t.key) ?? []), [t.start, t.end]]);
      // The windows follow the slides too, so a flag or a practice clip lands on the topic on screen.
      lt.windowTopic.clear();
      for (const t of timeline) for (let w = Math.floor(t.start / WINDOW_SEC); w * WINDOW_SEC < t.end; w++) if (t.key) lt.windowTopic.set(w, t.key);
    } else {
      for (const [w, key] of lt.windowTopic) spans.set(key, [...(spans.get(key) ?? []), [w * WINDOW_SEC, (w + 1) * WINDOW_SEC]]);
    }
    if (!lecture.clipOnly) minutesCount = true;
    for (const [key, list] of [...spans].sort((x, y) => x[1][0][0] - y[1][0][0])) {
      list.sort((x, y) => x[0] - y[0]);
      const minutes = round2(list.reduce((t, [s, e]) => t + (e - s), 0) / 60);
      minutesOf.set(key, round2(minutesOf.get(key)! + minutes));
      // His main stretch on the topic: the longest span (slides) or run of windows.
      let best = list[0];
      let run = list[0];
      for (let i = 1; i < list.length; i++) {
        run = list[i][0] <= run[1] + 0.5 ? [run[0], list[i][1]] : list[i];
        if (run[1] - run[0] > best[1] - best[0]) best = run;
      }
      const firstLine = timeline.length ? lt.lines.find((l) => l.start >= best[0] - 0.05 && l.start < best[1]) ?? null : bestLine(lt, list.map(([s]) => Math.floor(s / WINDOW_SEC)), key, idx);
      const source = `${lecture.title}${lt.date ? `, ${shortDate(lt.date)}` : ""}`;
      if (!lecture.clipOnly) {
        stressed.get(key)!.push({
          kind: "minutes",
          points: round2(minutes * WEIGHTS.minutePoints),
          quote: firstLine?.text ?? null,
          source,
          detail: `${minutes} min of lecture${timeline.length ? " (its slides on screen)" : ""}`,
          at: lt.date,
          sec: firstLine?.start ?? best[0],
          lectureId: lecture.id,
          href: lecture.recordingUrl || undefined,
        });
      }
      if (minutes >= FIRST_TAUGHT_MIN || lecture.moduleId || (lecture.clipOnly && minutes > 0)) offerDate(key, lt.date, { kind: "minutes", source, quote: firstLine?.text ?? null, at: lt.date });
      const span = clipFromLine(lt, best[0], SPAN_CLIP_SEC);
      if (span) {
        clips.get(key)!.push({
          id: `${lecture.id}@${span.start}`,
          lectureId: lecture.id,
          lectureTitle: lecture.title,
          lectureDate: lt.date,
          recordingUrl: lecture.recordingUrl,
          start: span.start,
          end: span.end,
          from: "lecture-span",
          quote: span.quote,
          slide: null,
        });
      }
    }
  }

  // Radar moments: the topic of the window he said it in.
  for (const r of inp.radar) {
    const lt = lectures.get(r.lectureId);
    // Strongest kind wins when a moment has several.
    const points = Math.max(...(r.kinds.length ? r.kinds : ["other"]).map((k) => WEIGHTS.radar[k] ?? WEIGHTS.radar.other));
    const ev: Evidence = {
      kind: "radar",
      points,
      quote: r.text,
      source: lt ? `${lt.lecture.title}${lt.date ? `, ${shortDate(lt.date)}` : ""}` : "Lecture",
      detail: `Flagged in lecture (${r.kinds.join(", ") || "flag"})`,
      flags: r.kinds,
      at: lt?.date ?? null,
      sec: r.start,
      lectureId: r.lectureId,
      href: lt?.lecture.recordingUrl || undefined,
    };
    const key = (lt && topicAt(lt, r.start)) || topicsIn(r.text, idx)[0] || null;
    if (!key) {
      unplaced.push(ev);
      continue;
    }
    stressed.get(key)!.push(ev);
    const c = lt && clipFromLine(lt, r.start, RADAR_CLIP_SEC);
    if (c && lt) {
      clips.get(key)!.push({
        id: `${r.lectureId}@${c.start}`,
        lectureId: r.lectureId,
        lectureTitle: lt.lecture.title,
        lectureDate: lt.date,
        recordingUrl: lt.lecture.recordingUrl,
        start: c.start,
        end: c.end,
        from: "radar",
        quote: c.quote,
        slide: null,
      });
    }
  }

  // Numbers derived from the full recordings (no lecture text): minutes and flags per topic, when a course has them.
  for (const d of inp.derived ?? []) {
    const key = drafts.find((x) => x.topic.toLowerCase() === d.topic.trim().toLowerCase())?.key ?? topicsIn(d.topic, idx)[0];
    if (!key) continue;
    if (d.minutes > 0) {
      minutesCount = true;
      minutesOf.set(key, round2(minutesOf.get(key)! + d.minutes));
      stressed.get(key)!.push({ kind: "minutes", points: round2(d.minutes * WEIGHTS.minutePoints), quote: null, source: "The full recordings", detail: `${round2(d.minutes)} min of lecture`, at: null });
    }
    for (const f of d.flags) {
      stressed.get(key)!.push({
        kind: "radar",
        points: WEIGHTS.radar[f.kind] ?? WEIGHTS.radar.other,
        quote: null,
        source: "The full recordings",
        detail: `Flagged (${f.kind})`,
        at: d.lecture ?? null,
        sec: f.sec,
        flags: [f.kind],
      });
    }
  }

  // Past reviews: a review file that names the topic (one per file, "-1" and "revised" copies count once).
  const seenReview = new Set<string>();
  for (const it of inp.items.filter((i) => i.role === "review")) {
    const base = it.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_\s-]*revised$/i, "").replace(/-\d+$/, "").trim().toLowerCase();
    if (seenReview.has(base)) continue;
    seenReview.add(base);
    for (const key of topicsIn(it.name, idx)) {
      stressed.get(key)!.push({ kind: "review", points: WEIGHTS.review, quote: it.name, source: "Past review", detail: "A past review covers it", at: null, href: it.url });
    }
  }

  // Announcements: one mention per announcement per topic; week titles also date topics.
  for (const a of inp.announcements) {
    const posted = easternDate(a.postedAt);
    const titleTopics = topicsIn(a.title, idx);
    const start = weekStart(a.title, a.postedAt) ?? posted;
    for (const key of titleTopics) offerDate(key, start, { kind: "announcement", source: "Announcement", quote: a.title, at: start });
    const done = new Set<string>();
    for (const line of [a.title, ...a.lines]) {
      for (const key of topicsIn(line, idx)) {
        if (done.has(key)) continue;
        done.add(key);
        stressed.get(key)!.push({ kind: "announcement", points: WEIGHTS.announcement, quote: line, source: "Announcement", detail: `Mentioned ${shortDate(posted)}`, at: posted, href: a.href });
      }
    }
  }

  // Practice: the stop holding its rewind's slide deck, else the topic of the lecture moment the
  // rewind lands on, else what the question names.
  for (const p of inp.practice) {
    const lt = p.lectureId ? lectures.get(p.lectureId) : undefined;
    const deck = p.clip?.slide?.deck.toLowerCase();
    const byDeck = deck ? drafts.find((d) => d.slides.some((s) => s.label.replace(/\.[a-z0-9]+$/i, "").toLowerCase() === deck))?.key : undefined;
    const key =
      keyOfModule(p.moduleId) ||
      byDeck ||
      (lt && p.clip && topicAt(lt, p.clip.start)) ||
      topicsIn(p.text, idx)[0] ||
      (p.topic ? topicsIn(p.topic, idx)[0] : undefined) ||
      bestTopic(`${p.topic ?? ""} ${p.text}`, idx, 1)?.key ||
      null;
    if (!key) {
      for (const at of p.attempts ?? []) unplaced.push(practiceEvidence(p.text, at));
      continue;
    }
    practiceIds.get(key)!.push(p.id);
    for (const at of p.attempts ?? []) missed.get(key)!.push(practiceEvidence(p.text, at));
    if (lt && p.clip) {
      const first = lt.lines.find((s) => s.start >= p.clip!.start - 0.05);
      clips.get(key)!.push({
        id: `${lt.lecture.id}@${p.clip.start}`,
        lectureId: lt.lecture.id,
        lectureTitle: lt.lecture.title,
        lectureDate: lt.date,
        recordingUrl: lt.lecture.recordingUrl,
        start: p.clip.start,
        end: Math.min(p.clip.end, p.clip.start + MAX_CLIP_SEC),
        from: "practice-match",
        quote: first?.text ?? null,
        slide: p.clip.slide,
        ...(p.clip.setup !== undefined ? { setup: p.clip.setup } : {}),
        ...(p.clip.exampleStart !== undefined ? { exampleStart: p.clip.exampleStart } : {}),
      });
    }
  }

  // Grades (only with includeGrades; off by default): 3 × the share of points lost, on every topic the
  // assignment names or is listed under.
  for (const g of inp.includeGrades ? inp.grades : []) {
    if (!(g.possible > 0) || /participation/i.test(g.name)) continue;
    const lost = Math.max(0, Math.min(1, 1 - g.score / g.possible));
    const ev: Evidence = {
      kind: "grade",
      points: round2(WEIGHTS.gradeLost * lost),
      quote: g.name,
      source: "Canvas grade",
      detail: `${round2(g.score)} / ${round2(g.possible)}`,
      at: easternDate(g.gradedAt),
      href: g.href,
    };
    for (const key of stopsFor(g.name)) missed.get(key)!.push({ ...ev });
  }

  // Order: dated stops by date; undated ones keep their course-order place between them.
  const sortKey = new Map<string, [number, number]>();
  drafts.forEach((d, i) => {
    const own = dates.get(d.key)?.at;
    if (own) return sortKey.set(d.key, [Date.parse(own), i]);
    const prev = drafts.slice(0, i).reverse().find((x) => dates.has(x.key));
    const next = drafts.slice(i + 1).find((x) => dates.has(x.key));
    const t = prev ? Date.parse(dates.get(prev.key)!.at) : next ? Date.parse(dates.get(next.key)!.at) - 1 : 0;
    sortKey.set(d.key, [t, i]);
  });
  const ordered = [...drafts].sort((a, b) => {
    const [ta, ia] = sortKey.get(a.key)!;
    const [tb, ib] = sortKey.get(b.key)!;
    return ta - tb || ia - ib;
  });

  // The tape head: the last stop (in tape order) first taught on or before today.
  const anyDate = dates.size > 0;
  let currentIdx = -1;
  ordered.forEach((d, i) => {
    const at = dates.get(d.key)?.at;
    if (at && at <= nowDate) currentIdx = i;
  });
  const stateOf = (i: number): StopState => {
    if (!anyDate) return "unknown";
    if (currentIdx < 0) return "future";
    return i < currentIdx ? "past" : i === currentIdx ? "current" : "future";
  };

  // Positions.
  const first = easternDate(inp.term?.firstLectureAt);
  const final = easternDate(inp.term?.finalExamAt);
  const positionBasis: CourseTape["positionBasis"] = first && final && final > first ? "dates" : "order";
  const frac = (d: string) => Math.min(1, Math.max(0, (Date.parse(d) - Date.parse(first!)) / (Date.parse(final!) - Date.parse(first!))));
  const positions = ordered.map((_, i) => (i + 1) / (ordered.length + 1));
  if (positionBasis === "dates") {
    const known = ordered.map((d) => (dates.get(d.key) ? frac(dates.get(d.key)!.at) : null));
    for (let i = 0; i < ordered.length; i++) {
      if (known[i] !== null) {
        positions[i] = known[i]!;
        continue;
      }
      let a = i - 1;
      while (a >= 0 && known[a] === null) a--;
      let b = i + 1;
      while (b < ordered.length && known[b] === null) b++;
      const pa = a >= 0 ? known[a]! : 0;
      const pb = b < ordered.length ? known[b]! : 1;
      positions[i] = pa + ((pb - pa) * (i - a)) / (b - a);
    }
    if (!dates.size) notes.push("No stop has a first-taught date, so they are spaced evenly.");
  } else {
    notes.push(
      !first && !final
        ? "First lecture and final exam dates unknown: stops are spaced evenly in tape order."
        : !final
          ? "Final exam date unknown: stops are spaced evenly in tape order."
          : "First lecture date unknown: stops are spaced evenly in tape order.",
    );
  }

  // Next exam coverage.
  const covered = inp.nextExam?.coverage ? new Set(stopsFor(inp.nextExam.coverage.quote)) : null;
  if (inp.nextExam && !inp.nextExam.coverage) notes.push(`What ${inp.nextExam.name} covers isn't known, so the route ranks every taught topic.`);
  if (!inp.nextExam) notes.push("No upcoming exam found, so the route ranks every taught topic.");

  const maxMiss = Math.max(0, ...drafts.map((d) => evidenceScore(missed.get(d.key)!)));
  const clipRank = { "practice-match": 0, radar: 1, "lecture-span": 2 } as const;

  const stops: Stop[] = ordered.map((d, i) => {
    const date = dates.get(d.key) ?? null;
    const stopClips = dedupeClips(clips.get(d.key)!).sort(
      (a, b) => clipRank[a.from] - clipRank[b.from] || (a.lectureDate ?? "").localeCompare(b.lectureDate ?? "") || a.start - b.start,
    );
    const st = stressed.get(d.key)!;
    return {
      id: d.key,
      topic: d.topic,
      order: i,
      topicFrom: d.topicFrom,
      module: d.module,
      firstTaughtAt: date?.at ?? null,
      firstTaughtFrom: date?.from ?? null,
      position: round3(positions[i]),
      state: stateOf(i),
      stressed: { ...toScore(st, 0), heat: stressHeat(st) },
      missed: toScore(missed.get(d.key)!, maxMiss),
      onNextExam: covered ? covered.has(d.key) : null,
      clips: stopClips,
      slides: d.slides,
      practiceIds: practiceIds.get(d.key)!,
      lectureMinutes: minutesOf.get(d.key)!,
    };
  });

  const route = buildRoute(stops, inp, covered);
  const { listenSec, questions } = routeTotals(route.steps);
  if (!inp.lectures.length) notes.push("No lecture recordings: stops come from modules and slides, and the route shows slides instead of clips.");

  const here = currentIdx >= 0 ? { stopId: stops[currentIdx].id, position: stops[currentIdx].position } : { stopId: null, position: anyDate ? 0 : null };
  if (positionBasis === "dates") here.position = round3(frac(nowDate));

  return {
    course: inp.course,
    now: inp.now,
    glowFrom: minutesCount ? "lectures" : "flags",
    week: weekOf(inp, nowDate),
    here,
    positionBasis,
    stops,
    route,
    markers: markersOf(inp, stops, nowDate, positionBasis === "dates" ? frac : null),
    totals: {
      stops: stops.length,
      lectures: inp.lectures.length,
      lectureMinutes: Math.round(lecturerSec / 60),
      radarMoments: inp.radar.length,
      listenSec,
      questions,
    },
    unplaced,
    notes,
  };

  function weekOf(input: CourseTapeInputs, today: string): CourseTape["week"] {
    let best: { n: number; quote: string; start: string } | null = null;
    for (const a of input.announcements) {
      const m = a.title.match(/\bweek\s*[-:#]?\s*(\d{1,2})\b/i);
      const start = weekStart(a.title, a.postedAt) ?? easternDate(a.postedAt);
      if (!m || !start || start > today) continue;
      if (!best || start > best.start) best = { n: Number(m[1]), quote: a.title, start };
    }
    return best ? { n: best.n, quote: best.quote, source: "Announcement" } : null;
  }

  function markersOf(input: CourseTapeInputs, list: Stop[], today: string, byDate: ((d: string) => number) | null): Marker[] {
    const isNext = (e: { id: string; name: string }) =>
      !!input.nextExam && (input.nextExam.id !== null ? input.nextExam.id === e.id : input.nextExam.name === e.name);
    return input.exams
      .map((e) => {
        const at = easternDate(e.at);
        let position: number | null = null;
        if (at && byDate) position = round3(byDate(at));
        else if (at) {
          // Between the last stop taught on or before it and the first taught after it. Past the
          // last dated stop, only the next exam is placed (just ahead of it); the rest are unknown.
          const after = list.findIndex((s) => s.firstTaughtAt !== null && s.firstTaughtAt > at);
          const beforeIdx = list.map((s) => s.firstTaughtAt !== null && s.firstTaughtAt <= at).lastIndexOf(true);
          if (after >= 0 && beforeIdx >= 0) position = round3((list[after].position + list[after - 1].position) / 2);
          else if (after < 0 && beforeIdx >= 0 && isNext(e)) {
            position = round3((list[beforeIdx].position + (beforeIdx + 1 < list.length ? list[beforeIdx + 1].position : 1)) / 2);
          }
        }
        return {
          id: e.id,
          label: e.name,
          at,
          score: e.score,
          possible: e.possible,
          position,
          isNext: isNext(e),
          href: e.href,
        };
      })
      .sort((a, b) => (a.at ?? "9999").localeCompare(b.at ?? "9999") || a.label.localeCompare(b.label))
      .filter((m) => m.at !== null || m.isNext)
      .map((m) => ({ ...m, isNext: m.isNext && (m.at === null || m.at >= today) }));
  }
}

/** A practice answer as evidence. Example history (never the student's own) says so in its source. */
export function practiceEvidence(text: string | null, at: { correct: boolean; answeredAt: string; example?: boolean }): Evidence {
  return {
    kind: "practice",
    points: at.correct ? WEIGHTS.practiceRight : WEIGHTS.practiceWrong,
    quote: text,
    source: at.example ? "Example practice history" : "Your practice",
    detail: at.correct ? "You got it right" : "You missed it",
    at: easternDate(at.answeredAt),
    ...(at.example ? { example: true as const } : {}),
  };
}

/** Sum of evidence points, 2 decimals. */
export function evidenceScore(ev: Evidence[]): number {
  return round2(ev.reduce((s, e) => s + e.points, 0));
}

/** A score from its evidence; heat is relative to `max`, the highest score of its kind on the tape. */
export function toScore(ev: Evidence[], max: number): Score {
  const s = evidenceScore(ev);
  return { score: s, heat: max > 0 ? round2(s / max) : 0, evidence: sortEvidence(ev) };
}

/** Seconds of clips and number of practice questions on a route. */
export function routeTotals(steps: RouteStep[]): { listenSec: number; questions: number } {
  return {
    listenSec: round2(steps.reduce((s, st) => s + (st.play.kind === "clip" ? st.play.clip.end - st.play.clip.start : 0), 0)),
    questions: steps.reduce((s, st) => s + st.practiceIds.length, 0),
  };
}

function buildRoute(stops: Stop[], inp: CourseTapeInputs, covered: Set<string> | null): Route {
  const exam = inp.nextExam;
  return {
    basis: covered ? "next-exam" : "overall",
    label: covered
      ? `for ${exam!.name}`
      : exam
        ? `${exam.name} coverage unknown: ranked over every topic so far`
        : "No exam date yet, so this covers every topic so far.",
    exam: exam ? { name: exam.name, at: easternDate(exam.at), coverageQuote: exam.coverage?.quote ?? null, coverageSource: exam.coverage?.source ?? null } : null,
    steps: routeSteps(stops, covered),
  };
}

/**
 * The route back: among taught stops (only those in `covered` when the next exam's coverage is
 * known), the top 3 by stressed × missed, filled by stressed alone when fewer have both, then by missed alone (a
 * course whose stress comes only from flags, like the demo's clip excerpts, still gets a route from what you miss).
 */
export function routeSteps(stops: Stop[], covered: Set<string> | null): RouteStep[] {
  const taught = stops.filter((s) => s.state === "past" || s.state === "current" || s.state === "unknown");
  const pool = covered ? taught.filter((s) => covered.has(s.id)) : taught;
  const product = (s: Stop) => Math.round(s.stressed.score * s.missed.score * 10000) / 10000;
  const byProduct = pool
    .filter((s) => product(s) > 0)
    .sort((a, b) => product(b) - product(a) || b.stressed.score - a.stressed.score || b.missed.score - a.missed.score || a.order - b.order);
  const filler = pool
    .filter((s) => product(s) === 0 && s.stressed.score > 0)
    .sort((a, b) => b.stressed.score - a.stressed.score || a.order - b.order);
  const missedOnly = pool
    .filter((s) => product(s) === 0 && !(s.stressed.score > 0) && s.missed.score > 0)
    .sort((a, b) => b.missed.score - a.missed.score || a.order - b.order);
  const picked = [
    ...byProduct.map((s) => ({ s, reason: "stressed-and-missed" as const })),
    ...filler.map((s) => ({ s, reason: "stressed-only" as const })),
    ...missedOnly.map((s) => ({ s, reason: "missed-only" as const })),
  ].slice(0, ROUTE_LEN);

  const steps: RouteStep[] = picked.map(({ s, reason }, i) => ({
    rank: i + 1,
    stopId: s.id,
    topic: s.topic,
    product: product(s),
    reason,
    play: s.clips[0]
      ? { kind: "clip", clip: s.clips[0] }
      : s.slides[0]
        ? { kind: "fallback", fallback: s.slides[0] }
        : { kind: "none" },
    practiceIds: s.practiceIds.slice(0, QUESTIONS_PER_STOP),
  }));
  return steps;
}

const EVIDENCE_ORDER = { radar: 0, review: 1, minutes: 2, announcement: 3, grade: 4, practice: 5 } as const;

export function sortEvidence(ev: Evidence[]): Evidence[] {
  return [...ev].sort(
    (a, b) => EVIDENCE_ORDER[a.kind] - EVIDENCE_ORDER[b.kind] || b.points - a.points || (a.at ?? "").localeCompare(b.at ?? "") || (a.sec ?? 0) - (b.sec ?? 0),
  );
}

function dedupeClips(list: Clip[]): Clip[] {
  const out: Clip[] = [];
  for (const c of list) {
    // Same lecture and overlapping by more than half: keep the better kind (list order is insertion; sort later).
    const dup = out.findIndex((o) => o.lectureId === c.lectureId && Math.min(o.end, c.end) - Math.max(o.start, c.start) > 0.5 * Math.min(o.end - o.start, c.end - c.start));
    if (dup < 0) out.push(c);
    else if (rank(c) < rank(out[dup])) out[dup] = c;
  }
  return out;
  function rank(c: Clip) {
    return c.from === "practice-match" ? 0 : c.from === "radar" ? 1 : 2;
  }
}
