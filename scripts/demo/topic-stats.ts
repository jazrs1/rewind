// Writes the demo's topic stats (public/demo/course/topic-stats.json, lib/demo/topic-stats.ts) and its report
// (private/pipeline/COP3530/topic-stats-report.md). $0: no model calls. Deterministic.
//
//   node scripts/demo/topic-stats.ts
//
// Minutes: a slide timeline over the FULL recordings, from the pipeline's cached embeddings (scripts/demo/cached-embed.ts
// throws on a miss, so it can never pay for one). Each 40 s lecturer window (lib/pipeline/retrieve.ts buildIndex) is
// matched to its closest page among the numbered lecture decks that lecture teaches (retrieval's deck-to-lecture score
// reaches TAUGHT), never a Discussion, Review or game deck; under OFF_SLIDES it is off the slides; labels are smoothed
// over ±SMOOTH windows; a page's topic is its title's by the demo topics table. Flags: the regex radar
// (scripts/radar/scan.mjs) over the full transcripts, lecturer only, as kind and second, on a topic only when the second
// falls inside that topic's taught span (lib/demo/topic-stats.ts taughtSpans); outside every span a flag is dropped.
// The file holds numbers only (and the stop ids, dates and flag kinds).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBundle, BUNDLE_DIR } from "../../lib/demo/bundle.ts";
import { stopIdOf } from "../../lib/demo/tape.ts";
import {
  bestPages,
  isLectureDeck,
  labelAt,
  mergeFlags,
  OFF,
  OFF_SLIDES,
  pageKey,
  pageTopics,
  parseTopicStats,
  smooth,
  SMOOTH,
  taughtSpans,
  TOPIC_STATS_FILE,
  TOPIC_STATS_VERSION,
  windowSpans,
  type TopicStatsFile,
  type TopicStatsRow,
} from "../../lib/demo/topic-stats.ts";
import type { TopicTable } from "../../lib/demo/topics.ts";
import { formatTime } from "../../lib/format.ts";
import { buildIndex, deckLectureScores, TAUGHT } from "../../lib/pipeline/retrieve.ts";
import type { PipelineChunk, PipelineTranscript } from "../../lib/pipeline/types.ts";
import { loadPhrases, scanTranscript } from "../radar/scan.mjs";
import { cachedEmbedder } from "./cached-embed.ts";

const ROOT = process.cwd();
const PIPE = join(ROOT, "private", "pipeline", "COP3530");
const OUT = join(ROOT, "public", BUNDLE_DIR, TOPIC_STATS_FILE);
const REPORT = join(PIPE, "topic-stats-report.md");

const read = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;
const transcripts = read<PipelineTranscript[]>(join(PIPE, "transcripts.json"));
const chunks = read<PipelineChunk[]>(join(PIPE, "chunks.json"));
const docs = read<{ name: string; pages?: { page: number; text: string }[] }[]>(join(PIPE, "docs.json"));
const table = read<TopicTable>(join(ROOT, "scripts", "demo", "demo-topics.json"));
const bundle = parseBundle(read(join(ROOT, "public", BUNDLE_DIR, "course.json")));

// The tape's stops: one per lecture and topic (lib/demo/tape.ts), by name.
const stopsOf = new Map(bundle.sets.map((s) => [s.id, [...new Set(s.seed.questions.map((q) => q.topic!))]]));
const stopNames = new Set([...stopsOf.values()].flat());
const nameOfStop = new Map([...stopNames].map((n) => [stopIdOf(n), n]));
if (nameOfStop.size !== stopNames.size) throw new Error("Two demo topics have the same stop id");

const embed = cachedEmbedder();
const index = await buildIndex(transcripts, chunks, { embed });
const slideText = (deck: string, page: number) => docs.find((d) => d.name === deck)?.pages?.find((p) => p.page === page)?.text ?? null;
const deckOf = (i: number) => {
  const s = index.pages[i].source;
  return s.kind === "slide" ? s.deck : s.name;
};
const lectureDecks = [...new Set(index.pages.map((_, i) => deckOf(i)))].filter(isLectureDeck).sort();
const topicOfPage = pageTopics(
  index.pages.flatMap((p, i) => (isLectureDeck(deckOf(i)) ? [{ deck: deckOf(i), page: p.source.page, text: slideText(deckOf(i), p.source.page) }] : [])),
  table,
  stopNames,
);
const deckScores = new Map(lectureDecks.map((d) => [d, deckLectureScores(index, d)]));
const phrases = loadPhrases();

const rows: TopicStatsRow[] = [];
const report: string[] = [];
const perStop = new Map<string, { minutes: string[]; flags: string[] }>();
let windowsSeen = 0;

for (const set of [...bundle.sets].sort((a, b) => a.id.localeCompare(b.id))) {
  const t = index.transcripts.findIndex((x) => x.t.recordedAt?.slice(0, 10) === set.id);
  if (t < 0) throw new Error(`No full recording for the ${set.id} lecture`);
  const tr = index.transcripts[t];
  const decks = lectureDecks.filter((d) => deckScores.get(d)![t] >= TAUGHT);
  if (!decks.length) throw new Error(`No numbered lecture deck reaches TAUGHT (${TAUGHT}) in the ${set.id} lecture`);
  const wins = index.windows.map((w, i) => ({ w, i })).filter(({ w }) => w.t === t).sort((a, b) => a.w.start - b.w.start);
  windowsSeen += wins.length;
  const pages = index.pages.flatMap((_, i) => (decks.includes(deckOf(i)) ? [i] : []));
  const best = bestPages(wins.map(({ i }) => index.windowVecs[i]), index.pageVecs, pages);
  const raw = best.map((b) => {
    if (b.score < OFF_SLIDES) return OFF;
    const deck = deckOf(b.page);
    const page = index.pages[b.page].source.page;
    const name = topicOfPage.get(`${deck}#${page}`);
    return name ? stopIdOf(name) : pageKey(deck, page);
  });
  const labels = smooth(raw);
  const spans = windowSpans(wins.map(({ w }) => w));
  const secs = new Map<string, number>();
  spans.forEach((s, k) => secs.set(labels[k], (secs.get(labels[k]) ?? 0) + (s.end - s.start)));

  // Radar over the whole recording, the lecturer's lines only.
  const hits = (scanTranscript(tr.t, tr.t.id, phrases, { speaker: tr.lecturer }) as { start: number; kind: string | null }[]).map((h) => ({ sec: h.start, kind: h.kind }));
  // A flag counts for a topic only inside that topic's taught span; outside every span it counts for nobody.
  const taught = taughtSpans(spans, raw, labels);
  const flags = mergeFlags(hits).map((f) => ({ ...f, at: labelAt(taught, f.sec) }));

  const own = (stopsOf.get(set.id) ?? []).map(stopIdOf);
  const visiting = [...secs.keys()].filter((k) => nameOfStop.has(k) && !own.includes(k));
  const ids = [...own, ...visiting.sort()];
  const minutes = (id: string) => Math.round(((secs.get(id) ?? 0) / 60) * 10) / 10;
  for (const id of ids) {
    const fl = flags.filter((f) => f.at === id).map(({ kind, sec }) => ({ kind, sec }));
    rows.push({ topic: id, lecture: set.id, minutes: minutes(id), flags: fl });
  }

  // Report.
  const dur = Math.round(tr.t.durationSec / 60);
  report.push(`## ${set.id} (${set.title}): ${dur} min recording; decks: ${decks.join(", ")}`, "", "| topic (stop id) | minutes | flags |", "|---|---|---|");
  const flagText = (fs: { kind: string; sec: number }[]) => (fs.length ? fs.map((f) => `${f.kind} ${formatTime(f.sec)}`).join(", ") : "none");
  for (const id of [...ids].sort()) {
    const fl = flags.filter((f) => f.at === id);
    report.push(`| ${nameOfStop.get(id)} (${id}) | ${minutes(id)} | ${flagText(fl)} |`);
    const ps = perStop.get(id) ?? { minutes: [], flags: [] };
    ps.minutes.push(`${minutes(id)} (${set.id.slice(5)})`);
    ps.flags.push(...fl.map((f) => f.kind));
    perStop.set(id, ps);
  }
  const notCounted = [...secs].filter(([k]) => !nameOfStop.has(k)).reduce((a, [, s]) => a + s, 0);
  const loose = flags.filter((f) => !f.at || !nameOfStop.has(f.at));
  report.push(`| (off the slides, or a slide with no demo topic) | ${Math.round((notCounted / 60) * 10) / 10} | ${loose.length ? `${loose.length} not counted: ${flagText(loose)}` : "none"} |`, "");
  const where = [...secs].filter(([k, s]) => !nameOfStop.has(k) && s >= 30).sort((a, b) => b[1] - a[1]);
  if (where.length) {
    report.push("Not counted, by where (30 s or more):", "");
    for (const [k, s] of where) {
      const m = k.match(/^~(.*)#(\d+)$/);
      const what = k === OFF ? `off the slides (best match under ${OFF_SLIDES})` : `${m![1]}, slide ${m![2]} ("${(slideText(m![1], Number(m![2])) ?? "").replace(/\s+/g, " ").trim().slice(0, 50) || "no text"}")`;
      report.push(`- ${what}: ${(s / 60).toFixed(1)} min`);
    }
    report.push("");
  }
}

const file: TopicStatsFile = { version: TOPIC_STATS_VERSION, course: bundle.course.code, topics: rows };
parseTopicStats(file);
const missing = [...nameOfStop.keys()].filter((id) => !rows.some((r) => r.topic === id));
if (missing.length) throw new Error(`No stats row for the stops ${missing.join(", ")}`);
writeFileSync(OUT, JSON.stringify(file, null, 1) + "\n");

const head = [
  "# Demo topic stats (topic-stats.json)",
  "",
  `Written by scripts/demo/topic-stats.ts. Minutes from a slide timeline built from the pipeline's cached embeddings (${windowsSeen} lecturer windows, ${index.pages.length} pages; ${embed.hits()} vectors, every one a cache hit, no model calls, no keyword fallback needed). Each 40 s lecturer window is matched to its closest slide in the numbered lecture decks that lecture teaches (retrieval's deck-to-lecture score, at least TAUGHT = ${TAUGHT}), never a Discussion, Review or game deck; a window whose best match is under ${OFF_SLIDES} is off the slides; labels are smoothed over ±${SMOOTH} windows. A page's topic is its title's by scripts/demo/demo-topics.json (the table's merges followed to a stop); a page with no text title takes the topic of the page before it; an Agenda or Outline page has none. Minutes a lecture spends on another lecture's topic are their own row (that topic, this lecture). Flags: the regex radar (scripts/radar/phrases.json) over the full transcripts, lecturer only, same-kind moments under 15 s apart merged, placed on a topic only inside its taught span (a run of the smoothed timeline, trimmed to its first and last window whose own best slide is that topic); a flag outside every span is not counted. The file holds numbers only.`,
  "",
];
const tail = ["## Per stop (all lectures)", "", "| stop | minutes | flags |", "|---|---|---|"];
for (const [id, ps] of perStop) tail.push(`| ${nameOfStop.get(id)} (${id}) | ${ps.minutes.join(", ")} | ${ps.flags.length}: ${ps.flags.join(", ") || "none"} |`);
writeFileSync(REPORT, [...head, ...report, ...tail, ""].join("\n"));
console.log(`wrote public/${BUNDLE_DIR}/${TOPIC_STATS_FILE}: ${rows.length} rows, ${rows.reduce((a, r) => a + r.flags.length, 0)} flags; report ${REPORT.replace(ROOT + "/", "")}`);
for (const r of rows) console.log(`  ${r.lecture} ${r.topic.padEnd(32)} ${String(r.minutes).padStart(5)} min  ${r.flags.map((f) => f.kind).join(", ")}`);
