// A pipeline output in the real shape (lib/pipeline/types.ts, as private/pipeline/<COURSE>/output.json
// and transcripts.json are written), with invented text: no real course content. /practice serves it
// in dev at /practice?set=e2e-fixture so e2e tests run on generated questions without private data.
//   q-code-clip  a generated question with a code block and a clip in lecture A
//   q-no-clip    one with no lecture clip, cited to a document page (the slide fallback)
//   q-other-lecture  one whose clip is in lecture B (its own recording, not the set's)
// Slide renders for these live in e2e/fixtures/slides/ (served by the dev slide route when
// private/demo/slides has none); q-other-lecture's is stored under its older name only.

import type { PipelineOutput, PipelineTranscript } from "../types.ts";

const COURSE = { id: 7, code: "FAKE7", name: "Fake Data Structures" };
/** Extra clip-less questions so the set is longer than the progress row (lib/pipeline/fixtures is invented data). */
export const FILLERS = 12;
const A = "https://ufl.zoom.us/rec/play/fake-lecture-a";
const B = "https://ufl.zoom.us/rec/play/fake-lecture-b";
const href = (fileId: number, page: number) => `https://ufl.instructure.com/courses/7/files/${fileId}#page=${page}`;

const heaps = { kind: "slide" as const, itemId: "file:101", fileId: 101, page: 3, deck: "Fake Heaps Deck", href: href(101, 3) };
const notes = { kind: "document" as const, itemId: "file:102", fileId: 102, page: 2, name: "Fake Course Notes", href: href(102, 2) };
const hashing = { kind: "slide" as const, itemId: "file:103", fileId: 103, page: 5, deck: "Fake Hashing Deck", href: href(103, 5) };

const seg = (start: number, end: number, text: string, speaker = "Dr. Fake Lee") => ({ start, end, speaker, text });

export const fixtureTranscripts: PipelineTranscript[] = [
  {
    id: "fake-lecture-a",
    source: "zoom",
    recordingUrl: A,
    title: "Fake lecture, Oct 1",
    recordedAt: "2026-10-01T17:50:00Z",
    durationSec: 3000,
    segments: [
      seg(585, 592, "Let's take a small min heap and push a new value onto it."),
      seg(592, 600, "Watch where the new value lands before anything moves.", "Student"),
      seg(600, 612, "The new value goes in the next free slot at the bottom."),
      seg(612, 626, "Then it swaps with its parent while it is smaller than the parent."),
      seg(626, 640, "So a push walks up at most the height of the tree."),
      seg(640, 655, "That is why insert is logarithmic in the number of values."),
    ],
  },
  {
    id: "fake-lecture-b",
    source: "zoom",
    recordingUrl: B,
    title: "Fake lecture, Oct 3",
    recordedAt: "2026-10-03T17:50:00Z",
    durationSec: 3000,
    segments: [
      seg(290, 300, "A hash table turns a key into a bucket index."),
      seg(300, 314, "When two keys land in the same bucket we chain them in a list."),
      seg(314, 330, "With a good hash the chains stay short on average."),
      seg(330, 345, "So lookups stay constant time on average."),
    ],
  },
];

export const fixtureOutput: PipelineOutput = {
  course: COURSE,
  generatedAt: "2026-10-24T05:21:00.000Z",
  counts: { docs: 4, chunks: 13, exams: 1, questions: 4 + FILLERS, withClip: 2, withSlide: 3 + FILLERS },
  exams: [
    {
      id: "exam:exam-2",
      courseId: "7",
      name: { value: "Exam 2", quote: "Exam 2", itemId: "syllabus:7" },
      date: { value: "2026-11-18T20:30:00-05:00", quote: "Exam 2 is on November 18 at 8:30 PM", itemId: "syllabus:7" },
      location: { value: null, quote: null, itemId: null },
      format: { value: null, quote: null, itemId: null },
      notesRule: { value: null, quote: null, itemId: null },
      topics: { value: null, quote: null, itemId: null },
      searched: [],
      conflicts: [],
    },
  ],
  questions: [
    {
      id: "q-code-clip",
      examId: null,
      topic: "Fake Heaps Deck",
      stem: "After push(2) on this min heap, at which index does 2 end up?",
      code: {
        language: "cpp",
        lines: [
          "int heap[] = {3, 5, 8, 9, 6};",
          "push(heap, 2);",
          "// the new value starts at index 5",
          "int i = 5;",
          "while (i > 0 && heap[i] < heap[(i - 1) / 2])",
          "  swap(heap[i], heap[(i - 1) / 2]), i = (i - 1) / 2;",
          "// which index holds 2 now?",
        ],
        source: heaps,
      },
      choices: [
        { label: "A", text: "Index 0" },
        { label: "B", text: "Index 2" },
        { label: "C", text: "Index 5" },
        { label: "D", text: "Index 1" },
      ],
      answer: "A",
      explanation: "2 is smaller than every value on its path, so it sifts up to the root.",
      quote: "it swaps with its parent while it is smaller than the parent",
      quoteSource: { kind: "lecture", itemId: "lecture:fake-lecture-a", recordingUrl: A, start: 612, end: 626, title: "Fake lecture, Oct 1" },
      styleItemId: null,
      check: { agreed: true, attempts: 1, reason: null },
      retrieval: {
        clip: { recordingUrl: A, start: 600, end: 640, exampleStart: 585, setup: "He is pushing a value onto a small min heap.", sourceLines: [0, 2], transcriptId: "fake-lecture-a" },
        slide: heaps,
        fallback: null,
      },
      prompts: { "question-gen": "fixture", "answer-check": "fixture" },
    },
    {
      id: "q-no-clip",
      examId: null,
      topic: "Fake Course Notes",
      stem: "How many late days does the fake course allow in total?",
      code: null,
      choices: [
        { label: "A", text: "None" },
        { label: "B", text: "Two" },
        { label: "C", text: "Three" },
        { label: "D", text: "Five" },
      ],
      answer: "C",
      explanation: "The notes give three late days for the whole term.",
      quote: "three late days for the whole term",
      quoteSource: notes,
      styleItemId: null,
      check: { agreed: true, attempts: 1, reason: null },
      retrieval: { clip: null, slide: notes, fallback: "slide" },
      prompts: { "question-gen": "fixture", "answer-check": "fixture" },
    },
    {
      id: "q-other-lecture",
      examId: null,
      topic: "Fake Hashing Deck",
      stem: "Two keys land in the same bucket. What does separate chaining do?",
      code: null,
      choices: [
        { label: "A", text: "Rehashes the table" },
        { label: "B", text: "Drops the second key" },
        { label: "C", text: "Links both keys in a list" },
        { label: "D", text: "Moves to the next bucket" },
      ],
      answer: "C",
      explanation: "Chaining keeps colliding keys together in that bucket's list.",
      quote: "we chain them in a list",
      quoteSource: { kind: "lecture", itemId: "lecture:fake-lecture-b", recordingUrl: B, start: 300, end: 314, title: "Fake lecture, Oct 3" },
      styleItemId: null,
      check: { agreed: true, attempts: 1, reason: null },
      retrieval: {
        clip: { recordingUrl: B, start: 300, end: 330, exampleStart: null, setup: null, sourceLines: [1], transcriptId: "fake-lecture-b" },
        slide: hashing,
        fallback: null,
      },
      prompts: { "question-gen": "fixture", "answer-check": "fixture" },
    },
    {
      // A course with only Canvas pages of text: the question quotes a page, which has no image.
      id: "q-canvas-page",
      examId: null,
      topic: "Fake Lesson 3",
      stem: "In the fake lesson, what is a vector made of two numbers called?",
      code: null,
      choices: [
        { label: "A", text: "A scalar" },
        { label: "B", text: "A matrix" },
        { label: "C", text: "A pair" },
        { label: "D", text: "A set" },
      ],
      answer: "C",
      explanation: "The lesson calls a vector of two numbers a pair.",
      quote: "a vector made of two numbers is called a pair",
      quoteSource: { kind: "page", itemId: "page:fake-lesson-3", pageUrl: "fake-lesson-3", title: "Fake Lesson 3", href: "https://ufl.instructure.com/courses/7/pages/fake-lesson-3" },
      styleItemId: null,
      check: { agreed: true, attempts: 1, reason: null },
      retrieval: { clip: null, slide: null, page: { kind: "page", itemId: "page:fake-lesson-3", pageUrl: "fake-lesson-3", title: "Fake Lesson 3", href: "https://ufl.instructure.com/courses/7/pages/fake-lesson-3" }, fallback: "reading" },
      prompts: { "question-gen": "fixture", "answer-check": "fixture" },
    },
    // A long set (the real one has 74): the progress row must stay one line, never scroll sideways.
    ...Array.from({ length: FILLERS }, (_, i) => ({
      id: `q-filler-${i + 1}`,
      examId: null,
      topic: "Fake Course Notes",
      stem: `Filler question ${i + 1}: how many values does a list of ${i + 2} values hold?`,
      code: null,
      choices: [
        { label: "A" as const, text: `${i + 1}` },
        { label: "B" as const, text: `${i + 2}` },
        { label: "C" as const, text: `${i + 3}` },
        { label: "D" as const, text: `${i + 4}` },
      ],
      answer: "B" as const,
      explanation: "It holds as many values as were put in.",
      quote: "three late days for the whole term",
      quoteSource: notes,
      styleItemId: null,
      check: { agreed: true, attempts: 1, reason: null },
      retrieval: { clip: null, slide: notes, fallback: "slide" as const },
      prompts: { "question-gen": "fixture", "answer-check": "fixture" },
    })),
  ],
  transcripts: fixtureTranscripts.map((t) => ({ id: t.id, title: t.title, recordingUrl: t.recordingUrl, recordedAt: t.recordedAt })),
  cost: { geminiUsd: 0, claudeUsd: 0 },
};
