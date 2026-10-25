// Writes the demo bundle (public/demo/course/: course.json and the slide images) from the real
// COP3530 pipeline output, with Professor Kapoor's permission. Only lecture practice with an
// own-lecture clip, only the allowlisted fields (lib/demo/export.ts). Deterministic: re-running it
// on the same output changes nothing. No network, no keys.
//
//   node scripts/demo/export-demo.ts
//
// The hosted-clip questions are HOSTED below; private/demo-clips.md lists what John captures for each
// (public/demo/media/<questionId>.mp4). Demo ids are frozen in scripts/demo/demo-ids.json (pipeline
// question id → demo id): a new question is added to it with its lecture's next free number, and
// nothing is ever removed from it, so an id (a clip's file name, a saved tutor reply) never moves.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_DIR, parseBundle } from "../../lib/demo/bundle.ts";
import { buildDeadlines, DEADLINES_FILE } from "../../lib/demo/deadlines.ts";
import { buildDemoExams, EXAMS_FILE, type FoundExamInput } from "../../lib/demo/exams.ts";
import { BUNDLE_KEEP, exportDemoBundle, parseRedactList, redact } from "../../lib/demo/export.ts";
import type { TopicTable } from "../../lib/demo/topics.ts";
import { shownSlide } from "../../lib/pipeline/retrieve.ts";
import { legacySlideName, parsePageKinds, slideImageName } from "../../lib/pipeline/run.ts";
import type { PipelineOutput, PipelineTranscript } from "../../lib/pipeline/types.ts";

const ROOT = process.cwd();
const PIPE = join(ROOT, "private", "pipeline", "COP3530");
const SLIDES = join(ROOT, "private", "demo", "slides");
const OUT = join(ROOT, "public", BUNDLE_DIR);
const IDS = join(ROOT, "scripts", "demo", "demo-ids.json");
/** Written by other scripts, not by this one: kept across a re-export (lib/demo/export.ts BUNDLE_KEEP). */
const KEEP = BUNDLE_KEEP;

/** The questions whose clip John captures (private/demo-clips.md), by demo id; each lecture's play first, in this order. */
const HOSTED = [
  "l20261013-q1",
  "l20261013-q6",
  "l20261013-q7",
  "l20261013-q13",
  "l20261020-q1",
  "l20261020-q6",
  "l20261022-q1",
  "l20261022-q6",
  "l20261022-q4",
];

/**
 * Poll or answer slides by hand (their quote is the answer), on top of the ones the "Poll" rule
 * (lib/demo/export.ts answerSlide) finds, e.g. an answer key coloured in: never shown before the student answers.
 */
const REVEALS_ANSWER = ["l20261013-q2", "l20261020-q3"];

const output = JSON.parse(readFileSync(join(PIPE, "output.json"), "utf8")) as PipelineOutput;
const transcripts = JSON.parse(readFileSync(join(PIPE, "transcripts.json"), "utf8")) as PipelineTranscript[];
const docs = JSON.parse(readFileSync(join(PIPE, "docs.json"), "utf8")) as { name: string; pages?: { page: number; text: string }[] }[];
const slideText = (deck: string, page: number) => docs.find((d) => d.name === deck)?.pages?.find((p) => p.page === page)?.text ?? null;
const ids = JSON.parse(readFileSync(IDS, "utf8")) as Record<string, string>;
const topics = JSON.parse(readFileSync(join(ROOT, "scripts", "demo", "demo-topics.json"), "utf8")) as TopicTable;
const kindsFile = join(SLIDES, "slides-kinds.json");
const pageKinds = existsSync(kindsFile) ? parsePageKinds(readFileSync(kindsFile, "utf8")) : {};

/** The rendered slide (or page) a question shows, as the practice page picks it; null when it isn't rendered. */
function slideFile(q: PipelineOutput["questions"][number]): string | null {
  const s = shownSlide(q);
  if (!s) return null;
  const name = slideImageName(s.kind === "slide" ? s.deck : s.name, s.page, s.fileId);
  if (existsSync(join(SLIDES, name))) return name;
  const legacy = legacySlideName(name);
  return legacy && existsSync(join(SLIDES, legacy)) ? legacy : null;
}

// Students' names he says in the clips: the "## Names to redact" list in private/demo-clips.md (or
// .cache/demo-clips.md before it's moved there), so the names themselves are never committed.
// parseRedactList throws when the section is missing or empty: no list, no export.
const clipsNotes = [join(ROOT, "private", "demo-clips.md"), join(ROOT, ".cache", "demo-clips.md")].find((p) => existsSync(p));
if (!clipsNotes) throw new Error("private/demo-clips.md (with its Names to redact list) is missing: refusing to export unredacted text");
const redactNames = parseRedactList(readFileSync(clipsNotes, "utf8"));

/**
 * Questions left out by hand after looking at their slides (the exporter's slideProblem rule
 * catches these too; the list keeps them out even if the slide text changes).
 */
const EXCLUDE: Record<string, string> = {
  // Oct 20 "Poll question #4": the hash table's keys are classmates' first names.
  "discussion-9-sets-maps-and-hash-tables-2": "students' names on the slide",
  // Oct 13 "Poll Question #4": the slide letters Quicksort B and Selection sort C; the question has Quicksort C.
  "discussion-8-sorting-2": "the slide letters its options differently",
  // Bundle review (Oct 25): a student is called on and answers in these windows (Oct 20 q5; Oct 22 q13, q14).
  "7-sets-maps-hashtables-l20261020-25": "a student's exchange in the window",
  "discussion-10-graphs-definitions-implementations-and-searching-2": "a student's answer in the window",
  "8a-graph-terminology-and-implementation-l20261022-11": "a student's answer in the window",
};

const result = exportDemoBundle(output, transcripts, {
  ids,
  hosted: HOSTED,
  revealsAnswer: REVEALS_ANSWER,
  slideText,
  topics,
  lecturer: { name: "Professor Kapoor", short: "Kapoor" },
  slideImage: slideFile,
  pageKinds,
  redactNames,
  exclude: EXCLUDE,
});
const { bundle, slides, skipped } = result;
// The same checks the demo pages run: a bundle that wouldn't load is never written.
parseBundle(bundle);
const exported = new Set(bundle.sets.flatMap((s) => s.hosted));
for (const id of HOSTED) if (!exported.has(id)) throw new Error(`Hosted question ${id} isn't exported`);
const gone = Object.values(ids).filter((id) => !bundle.sets.some((s) => s.questions.some((q) => q.id === id)));
if (gone.length) console.log(`not exported now (their ids stay reserved): ${gone.join(", ")}`);

// Replace the directory's contents, except the files other scripts write (a re-run with the same input writes the same bytes).
const kept = KEEP.flatMap((f) => (existsSync(join(OUT, f)) ? [[f, readFileSync(join(OUT, f))] as const] : []));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "slides"), { recursive: true });
for (const [f, bytes] of kept) writeFileSync(join(OUT, f), bytes);
for (const s of slides) copyFileSync(join(SLIDES, s.from), join(OUT, s.to));
writeFileSync(join(OUT, "course.json"), JSON.stringify(bundle, null, 1) + "\n");
// The deadlines (lib/demo/deadlines.ts): each quiz and exam the exam finder found, its kind, when and where from.
const exams = JSON.parse(readFileSync(join(PIPE, "exams.json"), "utf8")) as { exams: Parameters<typeof buildDeadlines>[1] };
const syllabusFiles = (docs as { itemId?: string; role?: string }[]).filter((d) => d.role === "syllabus" && d.itemId).map((d) => d.itemId!);
const deadlines = buildDeadlines(bundle.course.code, exams.exams, syllabusFiles);
writeFileSync(join(OUT, DEADLINES_FILE), JSON.stringify(deadlines, null, 1) + "\n");
// The exams (lib/demo/exams.ts), for the exam card behind NEXT_PUBLIC_REWIND_DEMO_EXAMS: title, date, coverage and the
// one quote they're from, each quote checked word for word against its course item's text.
const itemText = (itemId: string) => {
  const d = (docs as { itemId?: string; pages?: { text: string }[] }[]).find((x) => x.itemId === itemId);
  return d?.pages ? d.pages.map((p) => p.text).join("\n") : null;
};
const demoExams = buildDemoExams(bundle.course.code, exams.exams as unknown as FoundExamInput[], itemText, (s) => redact(s, redactNames) !== s);
writeFileSync(join(OUT, EXAMS_FILE), JSON.stringify(demoExams.file, null, 1) + "\n");
writeFileSync(IDS, JSON.stringify(result.ids, null, 1) + "\n");

const files = readdirSync(join(OUT, "slides")).length + 1;
const n = bundle.sets.reduce((a, s) => a + s.questions.length, 0);
console.log(`public/${BUNDLE_DIR}: ${bundle.sets.length} sets, ${n} questions, ${files} files`);
console.log(`exams: ${demoExams.file.exams.length} (left out: ${Object.entries(demoExams.skipped).map(([k, v]) => `${v} ${k}`).join(", ") || "none"})`);
console.log(`left out: ${Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(", ")}`);
const topicCount = new Set(bundle.sets.flatMap((s) => s.questions.map((q) => `${s.id} ${q.topic}`))).size;
console.log(`${topicCount} topics; no slide title (topic from the table's hand list): ${result.untitled.join(", ") || "none"}`);
