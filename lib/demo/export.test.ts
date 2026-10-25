import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROGRESS_DOTS } from "../../components/paper/ScantronSheet.tsx";
import { fixtureOutput, fixtureTranscripts } from "../pipeline/fixtures/practice-real.ts";
import type { ChoiceLabel } from "../schema.ts";
import type { PipelineOutput, PipelineTranscript, PracticeQuestion } from "../pipeline/types.ts";
import { BUNDLE_DIR, BUNDLE_FORMAT, parseBundle, PERMISSION_LABEL, type DemoBundleFile } from "./bundle.ts";
import { answerSlide, CLIP_KEYS, exportDemoBundle, LINE_KEYS, namedSetup, OPTIONAL_SLIDE_KEYS, parseRedactList, QUESTION_KEYS, redact, SLIDE_KEYS, slideProblem, type ExportOptions } from "./export.ts";

// Invented data only (lib/pipeline/fixtures): two lectures, a clipped question in each, one with no clip,
// plus an exam-set question and one whose clip names another lecture's transcript, added here.
const A = fixtureTranscripts[0];
const B = fixtureTranscripts[1];
const byId = (id: string) => fixtureOutput.questions.find((q) => q.id === id)!;
const examQ: PracticeQuestion = { ...structuredClone(byId("q-code-clip")), id: "q-exam", examId: "exam:exam-2" };
const strayQ: PracticeQuestion = structuredClone(byId("q-other-lecture"));
strayQ.id = "q-stray";
strayQ.retrieval.clip!.transcriptId = "fake-lecture-a"; // its clip's recording is lecture B's
const output: PipelineOutput = { ...fixtureOutput, questions: [...fixtureOutput.questions, examQ, strayQ] };
// A student speaks inside lecture B's clip, and the lecturer names another one.
const transcripts: PipelineTranscript[] = [
  A,
  {
    ...B,
    segments: [
      ...B.segments.slice(0, 2),
      { start: 305, end: 309, speaker: "Pat Quill", text: "Can a chain get long?" },
      { start: 309, end: 314, speaker: "Dr. Fake Lee", text: "Good question Pat, and Robin asked it too." },
      ...B.segments.slice(2),
    ],
  },
];
const opts: ExportOptions = {
  ids: {},
  // l20261003-q9 isn't a question: a hosted id that isn't exported is simply not there.
  hosted: ["l20261001-q1", "l20261003-q9"],
  slideText: (deck) => (deck === "Fake Heaps Deck" ? "Min Heaps: inserting pushes a value up from the bottom" : "Hashing with chains"),
  topics: {
    min: 1,
    max: 10,
    topics: [
      { topic: "Heaps", patterns: ["\\bHeaps?\\b", "\\broot\\b"] },
      { topic: "Hashing", patterns: ["^Hashing"] },
    ],
    untitled: [],
    merges: [],
  },
  lecturer: { name: "Professor Lee", short: "Lee" },
  slideImage: (q) => `${q.id}-render.png`,
  redactNames: ["Robin"],
};

describe("exportDemoBundle", () => {
  const { bundle, slides, skipped } = exportDemoBundle(output, transcripts, opts);
  const all = bundle.sets.flatMap((s) => s.questions);

  it("keeps only lecture practice with a clip from its own lecture, one set per lecture", () => {
    expect(bundle.sets.map((s) => [s.id, s.title, s.questions.length])).toEqual([
      ["2026-10-01", "Lecture practice, Oct 1", 1],
      ["2026-10-03", "Lecture practice, Oct 3", 1],
    ]);
    expect(all.map((q) => q.stem)).toEqual([byId("q-code-clip").stem, byId("q-other-lecture").stem]);
    expect(skipped).toEqual({ "exam set": 1, "no clip": 14, "clip not in its own lecture": 1 });
  });

  it("writes only the allowlisted fields", () => {
    expect(Object.keys(bundle).sort()).toEqual(["course", "format", "label", "lecturer", "sets"]);
    expect(bundle.format).toBe(BUNDLE_FORMAT);
    expect(bundle.label).toBe(PERMISSION_LABEL);
    for (const s of bundle.sets) expect(Object.keys(s).sort()).toEqual(["hosted", "id", "lecture", "questions", "title"]);
    for (const q of all) {
      expect(Object.keys(q).sort()).toEqual([...QUESTION_KEYS].sort());
      expect(Object.keys(q.slide).filter((k) => !(OPTIONAL_SLIDE_KEYS as readonly string[]).includes(k)).sort()).toEqual([...SLIDE_KEYS].sort());
      expect(Object.keys(q.clip).sort()).toEqual([...CLIP_KEYS].sort());
      for (const l of q.lines) expect(Object.keys(l).sort()).toEqual([...LINE_KEYS].sort());
      for (const c of q.choices) expect(Object.keys(c).sort()).toEqual(["label", "text"]);
      if (q.code) expect(Object.keys(q.code).sort()).toEqual(["language", "lines"]);
    }
    const text = JSON.stringify(bundle);
    for (const bad of ["zoom.us", "/rec/play/", "instructure", "fileId", "itemId", "href", "recordingUrl", "transcriptId", "fake-lecture", "q-code-clip", "check", "prompts", "private/", "exam:"]) {
      expect(text, bad).not.toContain(bad);
    }
  });

  it("keeps only the lecturer's lines inside the clip, with students' names redacted", () => {
    const [qa, qb] = all;
    expect(qa.clip).toEqual({ start: 600, end: 640, setup: "Lee is pushing a value onto a small min heap." });
    expect(qa.lines.map((l) => l.start)).toEqual([600, 612, 626]);
    expect(qb.lines.map((l) => l.text)).toEqual([
      "When two keys land in the same bucket we chain them in a list.",
      "Good question a student, and a student asked it too.",
      "With a good hash the chains stay short on average.",
    ]);
    expect(JSON.stringify(bundle)).not.toMatch(/Pat|Quill|Robin|Student/);
    expect(redact("Patrick and pat", ["Pat"])).toBe("Patrick and a student");
  });

  it("redacts multi-word and non-ASCII names, whole words only", () => {
    expect(redact("Jordan Smith asked, then Smith and jordan", ["Jordan Smith", "Jordan", "Smith"])).toBe("a student asked, then a student and a student");
    expect(redact("Zoë said Zoëlle", ["Zoë"])).toBe("a student said Zoëlle");
    expect(redact("über-Zoë", ["Zoë"])).toBe("über-a student");
  });

  it("redacts every string it ships, not only the lines", () => {
    const named = structuredClone(byId("q-other-lecture"));
    named.stem = `Robin asks: ${named.stem}`;
    named.explanation = `As robin said, ${named.explanation}`;
    named.choices = named.choices.map((c) => ({ ...c, text: `${c.text} (Robin)` }));
    named.code = { source: byId("q-code-clip").code!.source, language: "cpp", lines: ['string who = "Robin";'] };
    named.retrieval.clip!.setup = "He answers Robin.";
    const q = exportDemoBundle({ ...output, questions: [named] }, transcripts, opts).bundle.sets[0].questions[0];
    expect(JSON.stringify(q)).not.toMatch(/robin/i);
    // A name in the quote is a name on the slide: that question doesn't ship at all.
    const onSlide = { ...structuredClone(named), quote: `${named.quote} Robin` };
    expect(exportDemoBundle({ ...output, questions: [onSlide] }, transcripts, opts).skipped).toEqual({ "names on the slide": 1 });
    expect(q.stem).toMatch(/^a student asks: /);
    expect(q.code!.lines).toEqual(['string who = "a student";']);
    expect(q.clip.setup).toBe("Lee answers a student.");
  });

  it("names the lecturer in the setup line, never he/him/his; quotes and transcript lines are left alone", () => {
    expect(namedSetup("He is tracing merge sort.", "Kapoor")).toBe("Kapoor is tracing merge sort.");
    expect(namedSetup("he discusses the pivot.", "Kapoor")).toBe("Kapoor discusses the pivot.");
    expect(namedSetup("Kapoor is checking his mapper before he builds the graph.", "Kapoor")).toBe("Kapoor is checking their mapper before they build the graph.");
    expect(namedSetup("He asks a student to help him with the table.", "Kapoor")).toBe("Kapoor asks a student to help them with the table.");
    expect(namedSetup('He says "he who hesitates" and moves on.', "Kapoor")).toBe('Kapoor says "he who hesitates" and moves on.');
    expect(namedSetup("He explains that he has to rehash himself.", "Kapoor")).toBe("Kapoor explains that they have to rehash themself.");
    // Words that only contain "he" are untouched.
    expect(namedSetup("The heap: here he is.", "Kapoor")).toBe("The heap: here Kapoor is.");
    // A transcript line ships as it was said.
    const he = structuredClone(byId("q-other-lecture"));
    he.retrieval.clip!.setup = "He answers.";
    const tr = structuredClone(transcripts);
    const t = tr.find((x) => x.recordingUrl === he.retrieval.clip!.recordingUrl)!;
    const seg = t.segments.find((s) => s.start >= he.retrieval.clip!.start && s.start < he.retrieval.clip!.end && s.speaker === t.segments.find((x) => x.start >= he.retrieval.clip!.start)!.speaker)!;
    seg.text = "And he said his answer was right.";
    const out = exportDemoBundle({ ...output, questions: [he] }, tr, opts).bundle.sets[0].questions[0];
    expect(out.clip.setup).toBe("Lee answers.");
    expect(out.lines.map((l) => l.text)).toContain("And he said his answer was right.");
  });

  it("leaves out excluded questions and slides that show people or contradict the question", () => {
    const ex = exportDemoBundle(output, transcripts, { ...opts, exclude: { "q-code-clip": "looked at it" } });
    expect(ex.bundle.sets.map((s) => s.id)).toEqual(["2026-10-03"]);
    expect(ex.skipped["excluded by hand"]).toBe(1);

    const choices: { label: ChoiceLabel; text: string }[] = [
      { label: "A", text: "Insertion sort" },
      { label: "B", text: "Merge sort" },
      { label: "C", text: "Quicksort" },
    ];
    const at = (quote: string) => slideProblem({ quote, choices }, ["Robin"]);
    expect(at('Poll question #4 "Emma" gets inserted at index 11')).toBe("names on the slide");
    expect(at("Robin and Sam pair up on the merge step")).toBe("names on the slide");
    expect(at("Poll results: 12 responses")).toBe("poll results or participants on the slide");
    expect(at("Participants (31)")).toBe("poll results or participants on the slide");
    expect(at("Which sorts around a pivot? ● A. Bubble sort ● B. Quicksort")).toBe("the slide letters its options differently");
    expect(at("Which sorts around a pivot? ● A. Insertion sort ● C. Quicksort")).toBeNull();
    expect(at("Quick Sort: choose a pivot, swap around it")).toBeNull();
    // The rule runs inside the export too.
    const poll = structuredClone(byId("q-other-lecture"));
    poll.quote = "Poll results: 40 votes";
    expect(exportDemoBundle({ ...output, questions: [poll] }, transcripts, opts).skipped).toEqual({ "poll results or participants on the slide": 1 });
  });

  /** Lecture A's question again, under another pipeline id and clip start. */
  const at = (id: string, start: number): PracticeQuestion => {
    const q = structuredClone(byId("q-code-clip"));
    return { ...q, id, retrieval: { ...q.retrieval, clip: { ...q.retrieval.clip!, start, end: start + 15 } } };
  };

  it("puts the hosted-clip questions first, in the hosted list's order, then the rest in lecture order", () => {
    expect(bundle.sets.map((s) => s.hosted)).toEqual([["l20261001-q1"], []]);
    const more = { ...output, questions: [...output.questions, at("q-early", 585), at("q-late", 605), at("q-later", 620)] };
    const ids = { "q-early": "l20261001-q1", "q-code-clip": "l20261001-q2", "q-late": "l20261001-q3", "q-later": "l20261001-q4" };
    const set = exportDemoBundle(more, transcripts, { ...opts, ids, hosted: ["l20261001-q4", "l20261001-q2"] }).bundle.sets[0];
    expect(set.hosted).toEqual(["l20261001-q4", "l20261001-q2"]);
    expect(set.questions.map((q) => q.id)).toEqual(["l20261001-q4", "l20261001-q2", "l20261001-q1", "l20261001-q3"]);
  });

  it("keeps every id in the map; a new question gets its lecture's next free number, and a removed one leaves a gap", () => {
    // q-gone was l20261001-q2 and isn't in the output any more; q-new is new and comes before q1 in the lecture.
    const ids = { "q-code-clip": "l20261001-q1", "q-gone": "l20261001-q2", "q-other-lecture": "l20261003-q1" };
    const r = exportDemoBundle({ ...output, questions: [...output.questions, at("q-new", 585)] }, transcripts, { ...opts, ids });
    expect(r.ids).toEqual({ "q-code-clip": "l20261001-q1", "q-gone": "l20261001-q2", "q-new": "l20261001-q3", "q-other-lecture": "l20261003-q1" });
    // q1 is hosted, so it still leads.
    expect(r.bundle.sets[0].questions.map((q) => [q.id, q.clip.start])).toEqual([
      ["l20261001-q1", 600],
      ["l20261001-q3", 585],
    ]);
    // Fed back in, the map gives the same bundle.
    expect(exportDemoBundle({ ...output, questions: [...output.questions, at("q-new", 585)] }, transcripts, { ...opts, ids: r.ids })).toEqual(r);
    expect(() => exportDemoBundle(output, transcripts, { ...opts, ids: { "q-code-clip": "l20261001-q1", "q-other-lecture": "l20261001-q1" } })).toThrow(/same id/);
    expect(() => exportDemoBundle(output, transcripts, { ...opts, ids: { "q-code-clip": "l20261003-q5" } })).toThrow(/in the 2026-10-01 lecture/);
  });

  it("marks a poll or answer slide revealsAnswer, by its title or by hand", () => {
    expect(answerSlide("Poll Question #2 Which of the following are true? ● A. …", "Which of the following are true?")).toBe(true);
    expect(answerSlide("Poll Q#2 - Load Factors If we want…", "")).toBe(true);
    expect(answerSlide("Quick Sort ● Partition ○ Choose a pivot", "Quick Sort ● Partition")).toBe(false);
    // "poll" deep in a slide's body isn't its title.
    expect(answerSlide(`Hashing ${"x ".repeat(30)} we poll the table`, "")).toBe(false);
    const polled = exportDemoBundle(output, transcripts, { ...opts, slideText: (deck) => (deck === "Fake Heaps Deck" ? "Poll Question #1 Which is the root?" : "Hashing") });
    expect(polled.bundle.sets.map((s) => s.questions[0].slide.revealsAnswer)).toEqual([true, undefined]);
    const byHand = exportDemoBundle(output, transcripts, { ...opts, revealsAnswer: ["l20261003-q1"] });
    expect(byHand.bundle.sets.map((s) => s.questions[0].slide.revealsAnswer)).toEqual([undefined, true]);
    expect(parseBundle(byHand.bundle).sets[1].seed.questions[0].match.slide.revealsAnswer).toBe(true);
    expect(parseBundle(byHand.bundle).sets[0].seed.questions[0].match.slide.revealsAnswer).toBeUndefined();
  });

  it("gives every question a topic from its slide's title, or the table's hand list when the slide has none", () => {
    expect(all.map((q) => q.topic)).toEqual(["Heaps", "Hashing"]);
    expect(exportDemoBundle(output, transcripts, opts).untitled).toEqual([]);
    expect(parseBundle(bundle).sets[0].seed.questions[0].topic).toBe("Heaps");
    // Lecture B's slide has its title in an image (the text starts with a page number): only the hand list knows it.
    const imageTitle = { ...opts, slideText: (deck: string) => (deck === "Fake Heaps Deck" ? "Heaps" : "5 R(Hashcode) = Hashcode % TABLE_SIZE") };
    expect(() => exportDemoBundle(output, transcripts, imageTitle)).toThrow(/No topic for l20261003-q1 \(Fake Hashing Deck p5\)/);
    const hand = exportDemoBundle(output, transcripts, { ...imageTitle, topics: { ...opts.topics, untitled: [{ deck: "Fake Hashing Deck", page: 5, topic: "Hash tables", why: "title is an image" }] } });
    expect(hand.bundle.sets[1].questions[0].topic).toBe("Hash tables");
    expect(hand.untitled).toEqual(["l20261003-q1"]);
    // Too few or too many topics after the merges fails the export.
    expect(() => exportDemoBundle(output, transcripts, { ...opts, topics: { ...opts.topics, min: 3 } })).toThrow(/2 topics/);
  });

  it("names slide images by question and maps each to its render", () => {
    expect(all.map((q) => q.slide)).toEqual([
      { deck: "Fake Heaps Deck", page: 3, kind: "slide", image: "slides/l20261001-q1.png" },
      { deck: "Fake Hashing Deck", page: 5, kind: "slide", image: "slides/l20261003-q1.png" },
    ]);
    expect(slides).toEqual([
      { from: "q-code-clip-render.png", to: "slides/l20261001-q1.png" },
      { from: "q-other-lecture-render.png", to: "slides/l20261003-q1.png" },
    ]);
  });

  it("is deterministic: the same output in any order gives the same bundle", () => {
    const again = exportDemoBundle({ ...output, questions: [...output.questions].reverse() }, [...transcripts].reverse(), opts);
    expect(JSON.stringify(again)).toBe(JSON.stringify(exportDemoBundle(output, transcripts, opts)));
  });

  it("produces a bundle the demo pages accept", () => {
    const parsed = parseBundle(bundle, (id) => id === "l20261001-q1");
    expect(parsed.sets[0].hosted).toEqual([{ questionId: "l20261001-q1", src: "/demo/media/l20261001-q1.mp4", offset: 600, end: 640 }]);
    expect(parsed.sets[1].hosted).toEqual([]);
    expect(parsed.sets[0].seed.questions[0].match.slide.image).toBe("/demo/course/slides/l20261001-q1.png");
    expect(parseBundle(bundle).sets[0].hosted).toEqual([]);
  });
});

describe("parseRedactList", () => {
  const md = (list: string) => `# Clips\n\n## The three clips\n- not a name list\n\n## Names to redact\n\nIntro line.\n\n${list}\n## After\n- Later Section\n`;

  it("reads plain, multi-word, accented and annotated entries, and each word of a full name", () => {
    expect(parseRedactList(md("- Jordan Smith\n- Zoë\n- Riley (TA)\n"))).toEqual(["Riley", "Jordan", "Jordan Smith", "Smith", "Zoë"]);
  });

  it("fails when the section is missing or lists nobody", () => {
    expect(() => parseRedactList("# Clips\n\n## The three clips\n- Jordan\n")).toThrow(/no "## Names to redact" section/);
    expect(() => parseRedactList(md(""))).toThrow(/lists no/);
    expect(() => parseRedactList(md("Nobody yet.\n"))).toThrow(/lists no/);
  });

  it("fails on an entry that isn't a name, rather than skipping it", () => {
    expect(() => parseRedactList(md("- Jordan, Riley\n"))).toThrow(/isn't a name entry/);
  });
});

describe("the committed bundle (public/demo/course)", () => {
  const path = join(process.cwd(), "public", BUNDLE_DIR, "course.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as DemoBundleFile;
  const all = file.sets.flatMap((s) => s.questions);

  it("carries the permission label and the three lecture sets, each led by its hosted-clip questions (private/demo-clips.md)", () => {
    expect(file.label).toBe("Demo course, materials used with Professor Kapoor's permission");
    expect(file.sets.map((s) => s.title)).toEqual(["Lecture practice, Oct 13", "Lecture practice, Oct 20", "Lecture practice, Oct 22"]);
    expect(file.sets.map((s) => s.hosted)).toEqual([
      ["l20261013-q1", "l20261013-q6", "l20261013-q7", "l20261013-q13"],
      ["l20261020-q1", "l20261020-q6"],
      ["l20261022-q1", "l20261022-q6", "l20261022-q4"],
    ]);
    for (const s of file.sets) expect(s.questions.slice(0, s.hosted.length).map((q) => q.id)).toEqual(s.hosted);
  });

  it("never calls the lecturer he/him/his in a \"Where Kapoor is\" summary", () => {
    const setups = all.map((q) => q.clip.setup).filter((s): s is string => !!s);
    expect(setups.length).toBeGreaterThan(20);
    for (const s of setups) expect(s, s).not.toMatch(/\b(he|him|his)\b/i);
  });

  it("shows only numbered lecture decks, never a Discussion, Review or game deck", () => {
    for (const q of all) expect(q.slide.deck, q.id).toMatch(/^\d{1,2}[a-z]? - /);
  });

  it("marks the poll slides revealsAnswer, and only them", () => {
    expect(all.filter((q) => q.slide.revealsAnswer).map((q) => q.id)).toEqual(["l20261013-q2", "l20261020-q3"]);
  });

  it("keeps every demo id on the question it was first given to (scripts/demo/demo-ids.json)", () => {
    const ids = JSON.parse(readFileSync(join(process.cwd(), "scripts", "demo", "demo-ids.json"), "utf8")) as Record<string, string>;
    for (const [pipelineId, demoId] of Object.entries(FROZEN_IDS)) expect(ids[pipelineId], pipelineId).toBe(demoId);
    expect(new Set(Object.values(ids)).size).toBe(Object.keys(ids).length);
    // The ids the demo shipped with are all still there, on the same clip (l20261020-q5, l20261022-q13 and q14 left out by hand).
    const byId = new Map(all.map((q) => [q.id, q]));
    for (const [id, start] of Object.entries(FROZEN_CLIPS)) expect(byId.get(id)?.clip.start, id).toBe(start);
    // With the pipeline output here (private/, never committed): each id's question is the pipeline question it names.
    const out = join(process.cwd(), "private", "pipeline", "COP3530", "output.json");
    if (!existsSync(out)) return;
    const pipeline = new Map((JSON.parse(readFileSync(out, "utf8")) as PipelineOutput).questions.map((q) => [q.id, q]));
    for (const [pipelineId, demoId] of Object.entries(FROZEN_IDS)) {
      if (!(demoId in FROZEN_CLIPS)) continue;
      const p = pipeline.get(pipelineId)!;
      expect(p, pipelineId).toBeDefined();
      expect([p.retrieval.clip?.start, p.retrieval.clip?.end, p.answer], demoId).toEqual([byId.get(demoId)!.clip.start, byId.get(demoId)!.clip.end, byId.get(demoId)!.answer]);
      expect(p.explanation.length, demoId).toBe(byId.get(demoId)!.explanation.length);
    }
  });

  it("holds only allowlisted fields, every line inside its clip, and no links or ids", () => {
    for (const q of all) {
      expect(Object.keys(q).sort()).toEqual([...QUESTION_KEYS].sort());
      expect(Object.keys(q.slide).filter((k) => !(OPTIONAL_SLIDE_KEYS as readonly string[]).includes(k)).sort(), q.id).toEqual([...SLIDE_KEYS].sort());
      expect(Object.keys(q.clip).sort()).toEqual([...CLIP_KEYS].sort());
      expect(q.lines.length).toBeGreaterThan(0);
      for (const l of q.lines) {
        expect(Object.keys(l).sort()).toEqual([...LINE_KEYS].sort());
        expect(l.start).toBeGreaterThanOrEqual(q.clip.start);
        expect(l.start).toBeLessThan(q.clip.end);
      }
    }
    const text = readFileSync(path, "utf8");
    expect(text).not.toMatch(/https?:|zoom|instructure|\/rec\/|fileId|itemId|private\//i);
    // No Canvas ids (course, file, assignment): no number of 6+ digits anywhere.
    expect(text).not.toMatch(/(?<![\w.])\d{6,}(?![\d.])/);
  });

  it("names only slide images that are in the bundle, and the bundle holds nothing else", () => {
    const dir = join(process.cwd(), "public", BUNDLE_DIR);
    for (const q of all) expect(existsSync(join(dir, q.slide.image)), q.slide.image).toBe(true);
    expect(parseBundle(file).sets).toHaveLength(3);
  });

  it("has every set short enough for one progress oval per question", () => {
    for (const s of file.sets) expect(s.questions.length, s.id).toBeLessThanOrEqual(PROGRESS_DOTS);
  });

  it("ships no slide the exporter's rule turns down", () => {
    for (const q of all) expect(slideProblem(q, []), q.id).toBeNull();
  });
});

/** The demo ids as first shipped (Oct 24): pipeline question id → demo id. Never edit these; add to demo-ids.json instead. */
const FROZEN_IDS: Record<string, string> = {
  "discussion-8-sorting-l20261013-20": "l20261013-q1",
  "discussion-8-sorting-l20261013-18": "l20261013-q2",
  "6-sorting-l20261013-19": "l20261013-q3",
  "discussion-8-sorting-l20261013-16": "l20261013-q4",
  "6-sorting-1": "l20261013-q5",
  "discussion-8-sorting-1": "l20261013-q6",
  "6-sorting-l20261013-17": "l20261013-q7",
  "6-sorting-l20261013-21": "l20261013-q8",
  "6-sorting-2": "l20261013-q9",
  "discussion-8-sorting-l20261013-22": "l20261013-q10",
  "6-sorting-3": "l20261013-q11",
  "discussion-8-sorting-3": "l20261013-q12",
  "6-sorting-l20261013-15": "l20261013-q13",
  "7-sets-maps-hashtables-l20261020-29": "l20261020-q1",
  "7-sets-maps-hashtables-l20261020-23": "l20261020-q2",
  "discussion-9-sets-maps-and-hash-tables-1": "l20261020-q3",
  "7-sets-maps-hashtables-l20261020-27": "l20261020-q4",
  "7-sets-maps-hashtables-l20261020-25": "l20261020-q5",
  "discussion-9-sets-maps-and-hash-tables-l20261020-28": "l20261020-q6",
  "7-sets-maps-hashtables-2": "l20261020-q7",
  "discussion-9-sets-maps-and-hash-tables-l20261020-24": "l20261020-q8",
  "8a-graph-terminology-and-implementation-1": "l20261022-q1",
  "8a-graph-terminology-and-implementation-l20261022-7": "l20261022-q2",
  "discussion-10-graphs-definitions-implementations-and-searching-l20261022-10": "l20261022-q3",
  "discussion-10-graphs-definitions-implementations-and-searching-l20261022-6": "l20261022-q4",
  "discussion-10-graphs-definitions-implementations-and-searching-1": "l20261022-q5",
  "8a-graph-terminology-and-implementation-l20261022-1": "l20261022-q6",
  "8a-graph-terminology-and-implementation-l20261022-3": "l20261022-q7",
  "8a-graph-terminology-and-implementation-l20261022-13": "l20261022-q8",
  "discussion-10-graphs-definitions-implementations-and-searching-l20261022-2": "l20261022-q9",
  "8a-graph-terminology-and-implementation-l20261022-5": "l20261022-q10",
  "discussion-10-graphs-definitions-implementations-and-searching-l20261022-4": "l20261022-q11",
  "8a-graph-terminology-and-implementation-l20261022-9": "l20261022-q12",
  "discussion-10-graphs-definitions-implementations-and-searching-2": "l20261022-q13",
  "8a-graph-terminology-and-implementation-l20261022-11": "l20261022-q14",
};

/** Each first-shipped demo id still exported → its clip start (s), from the Oct 24 course.json. */
const FROZEN_CLIPS: Record<string, number> = {
  "l20261013-q1": 2284,
  "l20261013-q2": 83,
  "l20261013-q3": 91,
  "l20261013-q4": 152,
  "l20261013-q5": 157,
  "l20261013-q6": 246,
  "l20261013-q7": 321,
  "l20261013-q8": 713,
  "l20261013-q9": 1102,
  "l20261013-q10": 1274,
  "l20261013-q11": 2009,
  "l20261013-q12": 2563,
  "l20261013-q13": 2722,
  "l20261020-q1": 2056,
  "l20261020-q2": 553,
  "l20261020-q3": 553,
  "l20261020-q4": 699,
  "l20261020-q6": 1148,
  "l20261020-q7": 1221,
  "l20261020-q8": 2200,
  "l20261022-q1": 3463,
  "l20261022-q2": 3108,
  "l20261022-q3": 3264,
  "l20261022-q4": 3300,
  "l20261022-q5": 3366,
  "l20261022-q6": 3864,
  "l20261022-q7": 4565.3,
  "l20261022-q8": 4713,
  "l20261022-q9": 4857,
  "l20261022-q10": 5023,
  "l20261022-q11": 5168,
  "l20261022-q12": 5577,
};
