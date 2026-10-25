// Re-picks the slide of every COP3530 question that shows a non-lecture deck (Discussion, Review, game), once, on the
// pipeline's output. John, Oct 24: the lecturer never opens the Discussion slides in lecture; they're for the TA
// sections. Each such question gets a page of its lecture's own numbered deck (retrieve.ts lectureDecks: Oct 13 →
// "6 - Sorting", Oct 20 → "7 - Sets, Maps, HashTables", Oct 22 → "8a - …"), or, with no lecture date, its module's
// numbered deck (lib/pipeline/lecture-slides.ts moduleDeck); the page closest to the clip's lecturer windows and the
// quote's own page (rankLecturePages), when it reaches LECTURE_SLIDE_MIN; else no slide. The quote and its source
// are untouched (the words are still from the page they came from). Deterministic, $0: the embeddings come from the
// cache only (cached-embed.ts throws on a miss), no model calls.
//
//   node scripts/demo/repick-lecture-slides.ts
//
// Reads private/pipeline/COP3530/output.pre-repick.json when it's there (the output as it was before the first
// run, saved then), so a re-run gives the same result. Writes output.json and repick-report.md (with
// repick-spotcheck.md, the hand-written moment check, appended when it's there). Then render the new pages
// (`node scripts/pipeline/run.ts --course COP3530 --slides-only`) and re-export the demo.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatTime } from "../../lib/format.ts";
import { isLectureDeck, LECTURE_SLIDE_MIN, moduleDeck, rankLecturePages } from "../../lib/pipeline/lecture-slides.ts";
import { buildIndex, lectureDecks, pageIndexOf, shownSlide, windowsIn } from "../../lib/pipeline/retrieve.ts";
import type { PipelineChunk, PipelineOutput, PipelineTranscript, Retrieval } from "../../lib/pipeline/types.ts";
import { cachedEmbedder } from "./cached-embed.ts";

const ROOT = process.cwd();
const PIPE = join(ROOT, "private", "pipeline", "COP3530");
const BEFORE = join(PIPE, "output.pre-repick.json");
const read = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;

if (!existsSync(BEFORE)) writeFileSync(BEFORE, readFileSync(join(PIPE, "output.json")));
const output = read<PipelineOutput>(BEFORE);
const transcripts = read<PipelineTranscript[]>(join(PIPE, "transcripts.json"));
const chunks = read<PipelineChunk[]>(join(PIPE, "chunks.json"));
const course = read<{ modules: { position: number; name: string; items?: { title: string }[] }[] }>(join(ROOT, "private", "COP3530.course.json"));
const ids = read<Record<string, string>>(join(ROOT, "scripts", "demo", "demo-ids.json"));

// A module's topic: its overview page's title ("Module 8: Sorting" → "Sorting"), else its name.
const modules = course.modules.map((m) => ({
  position: m.position,
  topic: m.items?.map((i) => i.title.match(/^Module\s+\d+\s*:\s*(.+)$/i)?.[1]).find(Boolean) ?? m.name,
}));

/**
 * Picks set by hand after the moment spot-check, pipeline id → page of the question's lecture deck: the ranking's
 * pick was the wrong slide, and the right one (a mostly-diagram slide) ranks low on embeddings.
 */
const OVERRIDES: Record<string, { page: number; why: string }> = {
  // Oct 22 q3 (which sequence is a valid path): the clip is the "path" definition, 54:24; ranked p13 is "Simple Graph".
  "discussion-10-graphs-definitions-implementations-and-searching-l20261022-10": { page: 14, why: "the Path slide the clip teaches from" },
};

const embed = cachedEmbedder();
const index = await buildIndex(transcripts, chunks, { embed });
const taught = lectureDecks(index);
if (!taught) throw new Error("No numbered lecture deck in the course");
const deckOf = (s: { kind: "slide"; deck: string } | { kind: "document"; name: string }) => (s.kind === "slide" ? s.deck : s.name);
const numbered = [...new Set(index.pages.map((p) => deckOf(p.source)))].filter(isLectureDeck).sort();
const dayOf = (t: number) => index.transcripts[t].t.recordedAt?.slice(0, 10) ?? null;

const rows: string[] = [];
const counts = { repicked: 0, noSlide: 0, byLecture: 0, byModule: 0 };
const questions = output.questions.map((q) => {
  const old = shownSlide(q);
  if (!old || isLectureDeck(deckOf(old))) return q;
  // The question's lecture: its clip's, else the date in its id ("…-l20261022-8"); else none (its module's deck).
  const clip = q.retrieval.clip;
  const clipT = clip ? index.transcripts.findIndex((x) => x.t.recordingUrl === clip.recordingUrl) : -1;
  const tagged = q.id.match(/-l(\d{4})(\d{2})(\d{2})-\d+$/);
  const t = clipT >= 0 ? clipT : tagged ? index.transcripts.findIndex((_, k) => dayOf(k) === `${tagged[1]}-${tagged[2]}-${tagged[3]}`) : -1;
  const viaModule = t < 0 ? moduleDeck(deckOf(old), modules, numbered) : null;
  const decks = t >= 0 ? taught[t] : viaModule ? [viaModule] : [];
  if (t >= 0) counts.byLecture++;
  else counts.byModule++;

  const candidates = index.pages.flatMap((p, i) => (decks.includes(deckOf(p.source)) ? [i] : []));
  const qp = pageIndexOf(index, old);
  const ranked = rankLecturePages(index.pageVecs, candidates, {
    windowVecs: clip && clipT >= 0 ? windowsIn(index, clipT, clip.start, clip.end).map((i) => index.windowVecs[i]) : [],
    quoteVec: qp >= 0 ? index.pageVecs[qp] : null,
  });
  const hand = OVERRIDES[q.id] ? ranked.find((r) => index.pages[r.page].source.page === OVERRIDES[q.id].page) : undefined;
  if (OVERRIDES[q.id] && !hand) throw new Error(`${q.id}: override page ${OVERRIDES[q.id].page} isn't in ${decks.join(", ")}`);
  const best = hand ?? ranked[0];
  const pick = best && (hand || best.score >= LECTURE_SLIDE_MIN) ? index.pages[best.page].source : null;
  if (pick) counts.repicked++;
  else counts.noSlide++;

  const fmt = (x: number | null | undefined) => (x === null || x === undefined ? "–" : x.toFixed(3));
  const where = t >= 0 ? `lecture ${dayOf(t)}` : viaModule ? `module deck (no lecture date)` : "no lecture date, no module deck";
  const neu = pick ? `${deckOf(pick)} p${pick.page}${hand ? ` (by hand: ${OVERRIDES[q.id].why}; ranked first was p${index.pages[ranked[0].page].source.page})` : ""}` : best ? `no slide (best ${deckOf(index.pages[best.page].source)} p${index.pages[best.page].source.page})` : `no slide (${decks.length ? "nothing to rank by" : "no numbered deck"})`;
  rows.push(`| ${ids[q.id] ?? ""} | ${q.id} | ${where} | ${deckOf(old)} p${old.page} | ${neu} | ${fmt(best?.score)} | ${fmt(best?.clip)} | ${fmt(best?.quote)} |`);

  const retrieval: Retrieval = { ...q.retrieval, slide: pick, fallback: clip ? null : pick ? (pick.kind === "slide" ? "slide" : "reading") : q.retrieval.page ? "reading" : "none" };
  return { ...q, retrieval };
});

writeFileSync(join(PIPE, "output.json"), JSON.stringify({ ...output, questions, counts: { ...output.counts, withSlide: questions.filter((q) => q.retrieval.slide).length } }, null, 2));

// The demo's affected questions: their clip's lines, for the hand-written moment check (repick-spotcheck.md).
const demo = output.questions.filter((q) => ids[q.id] && rows.some((r) => r.includes(`| ${q.id} |`)));
const spot = join(PIPE, "repick-spotcheck.md");
const report = [
  "# Lecture-slide re-pick (repick-report.md)",
  "",
  `Written by scripts/demo/repick-lecture-slides.ts from ${BEFORE.replace(ROOT + "/", "")}. Every question showing a non-lecture deck (Discussion, Review, game) gets a page of its lecture's numbered deck (the decks retrieval says each lecture teaches: ${index.transcripts.map((_, k) => `${dayOf(k)} → ${taught[k].join(", ") || "none"}`).join("; ")}), or with no lecture date its module's numbered deck. Score = the mean of the page's mean similarity to the clip's lecturer windows ("clip") and its similarity to the quote's own page ("quote"); a page under ${LECTURE_SLIDE_MIN} (the slide timeline's on-the-slide line) isn't shown. Cached embeddings only (${embed.hits()} vectors, every one a cache hit), no model calls. The quote and its source are unchanged.`,
  "",
  `${rows.length} questions: ${counts.repicked} re-picked, ${counts.noSlide} with no slide now; ${counts.byLecture} by their lecture, ${counts.byModule} by their module.`,
  "",
  "| demo id | pipeline id | deck from | old slide | new slide | score | clip | quote |",
  "|---|---|---|---|---|---|---|---|",
  ...rows,
  "",
  existsSync(spot) ? readFileSync(spot, "utf8").trim() : "## Moment spot-check\n\nNot written yet (repick-spotcheck.md).",
  "",
];
writeFileSync(join(PIPE, "repick-report.md"), report.join("\n"));
console.log(`${rows.length} non-lecture slides: ${counts.repicked} re-picked, ${counts.noSlide} no slide (${counts.byLecture} by lecture, ${counts.byModule} by module); ${demo.length} in the demo`);
if (process.argv.includes("--lines"))
  for (const q of demo) {
    const c = q.retrieval.clip!;
    const tr = transcripts.find((x) => x.recordingUrl === c.recordingUrl)!;
    console.log(`\n=== ${ids[q.id]} ${formatTime(c.start)}–${formatTime(c.end)}: ${q.stem.slice(0, 120)}`);
    for (const s of tr.segments.filter((x) => x.start >= c.start - 30 && x.start < c.end + 30)) console.log(`${s.start < c.start || s.start >= c.end ? "  " : "> "}[${formatTime(s.start)}] ${s.text}`);
  }
