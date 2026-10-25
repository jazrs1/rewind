import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLE_DIR, readDemoBundle } from "./bundle.ts";
import { DEADLINES_FILE } from "./deadlines.ts";
import { EXAMS_FILE } from "./exams.ts";
import { BUNDLE_KEEP } from "./export.ts";
import { stopIdOf } from "./tape.ts";
import {
  derivedTopics,
  isLectureDeck,
  labelAt,
  mergeFlags,
  pageTopics,
  parseTopicStats,
  smooth,
  STRING_SHAPES,
  taughtSpans,
  TOPIC_STATS_FILE,
  windowSpans,
} from "./topic-stats.ts";
import type { TopicTable } from "./topics.ts";

const FILE = join(process.cwd(), "public", BUNDLE_DIR, TOPIC_STATS_FILE);

/** Every string in a JSON value, with the key it sits under. */
function strings(v: unknown, key = ""): { key: string; value: string }[] {
  if (typeof v === "string") return [{ key, value: v }];
  if (Array.isArray(v)) return v.flatMap((x) => strings(x, key));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => strings(x, k));
  return [];
}

describe("the committed topic-stats.json", () => {
  it.skipIf(!existsSync(FILE))("holds numbers only: no string but a stop id, a lecture date, a flag kind and the course code", () => {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    const all = strings(raw);
    expect(all.length).toBeGreaterThan(0);
    for (const { key, value } of all) {
      expect(["course", "topic", "lecture", "kind"], `"${value}" under "${key}"`).toContain(key);
      expect(value, key).toMatch(STRING_SHAPES[key]);
    }
    expect(strings(raw).filter((s) => s.key === "course")).toHaveLength(1);
    expect(() => parseTopicStats(raw)).not.toThrow();
  });

  it.skipIf(!existsSync(FILE))("names every demo tape stop, and only those, each on a bundle lecture", async () => {
    const bundle = (await readDemoBundle())!;
    const stops = new Set(bundle.sets.flatMap((s) => s.seed.questions.map((q) => stopIdOf(q.topic!))));
    expect(stops.size).toBe(10);
    const rows = bundle.stats!.topics;
    expect(new Set(rows.map((r) => r.topic))).toEqual(stops);
    for (const r of rows) expect(bundle.sets.map((s) => s.id)).toContain(r.lecture);
  });

  it("the bundle directory holds only what the exporter writes (course.json, slides/, deadlines.json, exams.json) and the kept files", () => {
    const dir = join(process.cwd(), "public", BUNDLE_DIR);
    const allowed = new Set<string>(["course.json", "slides", DEADLINES_FILE, EXAMS_FILE, ...BUNDLE_KEEP]);
    for (const f of readdirSync(dir)) expect(allowed, f).toContain(f);
  });
});

describe("parseTopicStats", () => {
  const ok = { version: 1, course: "COP3530", topics: [{ topic: "merge-sort", lecture: "2026-10-13", minutes: 11.5, flags: [{ kind: "exam", sec: 2290 }] }] };
  it("takes the approved format", () => {
    expect(parseTopicStats(structuredClone(ok)).topics[0].minutes).toBe(11.5);
  });
  it("refuses text anywhere: an extra key, prose in a field, a quote on a flag, an unknown kind, a string minute", () => {
    const bad = (f: (x: typeof ok & Record<string, unknown>) => void) => {
      const x = structuredClone(ok) as typeof ok & Record<string, unknown>;
      f(x);
      return () => parseTopicStats(x);
    };
    expect(bad((x) => (x.note = "he said"))).toThrow(/exactly/);
    expect(bad((x) => ((x.topics[0] as Record<string, unknown>).quote = "this is on the exam"))).toThrow(/exactly/);
    expect(bad((x) => (x.topics[0].topic = "Merge sort, as he put it"))).toThrow(/stop id/);
    expect(bad((x) => ((x.topics[0].flags[0] as Record<string, unknown>).text = "on the exam"))).toThrow(/exactly kind and sec/);
    expect(bad((x) => (x.topics[0].flags[0].kind = "rumour"))).toThrow(/kind/);
    expect(bad((x) => ((x.topics[0] as Record<string, unknown>).minutes = "11.5"))).toThrow(/minutes/);
    expect(bad((x) => (x.topics[0].lecture = "Oct 13"))).toThrow(/date/);
    expect(bad((x) => x.topics.push(structuredClone(x.topics[0])))).toThrow(/twice/);
  });
});

describe("derivedTopics", () => {
  it("gives the tape topic names for the stop ids it knows, and drops the rest", () => {
    const stats = parseTopicStats({ version: 1, course: "COP3530", topics: [
      { topic: "merge-sort", lecture: "2026-10-13", minutes: 4, flags: [{ kind: "recall", sec: 9 }] },
      { topic: "gone", lecture: "2026-10-13", minutes: 9, flags: [] },
    ] });
    expect(derivedTopics(stats, new Map([["merge-sort", "Merge sort"]]))).toEqual([{ topic: "Merge sort", lecture: "2026-10-13", minutes: 4, flags: [{ kind: "recall", sec: 9 }] }]);
    expect(derivedTopics(null, new Map())).toEqual([]);
  });
});

describe("the slide timeline", () => {
  it("uses numbered lecture decks only", () => {
    for (const d of ["6 - Sorting", "8a - Graph Terminology and Implementation", "10 - Tries"]) expect(isLectureDeck(d), d).toBe(true);
    for (const d of ["Discussion 8 - Sorting", "Exam 2 - Review A", "JeopardyTrees", "Exam 2 jeapordy!", "Balanced Trees_REVIEW-1", "Sorting_Review_revised", "M08_01_COP3530"]) expect(isLectureDeck(d), d).toBe(false);
  });

  it("a page takes its title's topic, an untitled page the one before it, and a merged-away topic its stop", () => {
    const table: TopicTable = {
      min: 1,
      max: 9,
      topics: [{ topic: "Widgets", patterns: ["^Widget"] }, { topic: "Gadget bits", patterns: ["^Gadget"] }],
      untitled: [],
      merges: [{ from: ["Gadget bits"], into: "Gizmos" }],
    };
    const t = pageTopics(
      [
        { deck: "1 - Things", page: 1, text: "Widget basics" },
        { deck: "1 - Things", page: 2, text: "● a bullet, no title" },
        { deck: "1 - Things", page: 3, text: "Unrelated heading" },
        { deck: "1 - Things", page: 4, text: "42 only a number" },
        { deck: "1 - Things", page: 5, text: "Gadget wiring" },
        { deck: "1 - Things", page: 6, text: "Agenda ▪ Widgets ▪ Gadget wiring" },
      ],
      table,
      new Set(["Widgets", "Gizmos"]),
    );
    expect([...t.values()]).toEqual(["Widgets", "Widgets", null, null, "Gizmos", null]);
  });

  it("smooths a lone label away, and keeps its own on a tie", () => {
    expect(smooth(["a", "a", "b", "a", "a"])).toEqual(["a", "a", "a", "a", "a"]);
    expect(smooth(["a", "b"], 1)).toEqual(["a", "b"]);
  });

  it("each window stands for the seconds to the next one, never past its end; a second takes its taught span's label", () => {
    const spans = windowSpans([{ start: 0, end: 38 }, { start: 20, end: 59 }, { start: 100, end: 130 }]);
    expect(spans).toEqual([{ start: 0, end: 20 }, { start: 20, end: 59 }, { start: 100, end: 130 }]);
    const taught = taughtSpans(spans, ["a", "b", "c"], ["a", "b", "c"]);
    expect(labelAt(taught, 25)).toBe("b");
    expect(labelAt(taught, 105)).toBe("c");
    expect(labelAt(taught, 79)).toBe(null);
    expect(labelAt(taught, 151)).toBe(null);
  });

  it("a taught span is its run trimmed to the windows of its own label: a title slide smoothing pulled in is outside it", () => {
    const spans = windowSpans([0, 20, 40, 60, 80, 100].map((s) => ({ start: s, end: s + 40 })));
    // Window 0 is the deck's title slide, smoothed into "sort"; window 5's own label is "~off", smoothed into "merge".
    const taught = taughtSpans(spans, ["~deck#1", "sort", "sort", "merge", "merge", "~off"], ["sort", "sort", "sort", "merge", "merge", "merge"]);
    expect(taught).toEqual([{ label: "sort", start: 20, end: 60 }, { label: "merge", start: 60, end: 100 }]);
    expect(labelAt(taught, 13)).toBe(null);
    expect(labelAt(taught, 33)).toBe("sort");
    expect(labelAt(taught, 110)).toBe(null);
    expect(taughtSpans(spans.slice(0, 1), ["~off"], ["sort"])).toEqual([]);
  });

  it("merges same-kind radar moments under 15 s apart and names unknown kinds other", () => {
    expect(mergeFlags([{ sec: 10.4, kind: "exam" }, { sec: 20, kind: "exam" }, { sec: 21, kind: "importance" }, { sec: 40, kind: "exam" }, { sec: 50, kind: null }])).toEqual([
      { kind: "exam", sec: 10 },
      { kind: "importance", sec: 21 },
      { kind: "exam", sec: 40 },
      { kind: "other", sec: 50 },
    ]);
  });
});
