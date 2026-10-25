// Quick build (beta): a stored bank as the practice seed the Scantron sheet and the grading beat already run on.
// Each question carries `quick`: its source line ("Lecture, Oct 22 · 38:10", "Slide 12 · <deck>" or "Page: <title>")
// and its quote. A slide or document question has no recording: Rewind opens nothing; the sheet shows the quote and the line.

import { formatTime } from "../format.ts";
import type { PracticeSeed, SeedQuestion } from "../demo/types.ts";
import type { TranscriptSegment } from "../schema.ts";
import type { QuickBank } from "./store.ts";
import type { QuickQuestion } from "./types.ts";

const isPdf = (s: QuickQuestion["source"]) => (s.kind === "slide" || s.kind === "document") && typeof s.page === "number" && !!s.deck;
/** A PDF question's place: "Slide 12" in slides, "Page 3" in a document. */
const pdfPlace = (s: QuickQuestion["source"]) => `${s.kind === "slide" ? "Slide" : "Page"} ${s.page}`;

/** "Lecture, Oct 22 · 38:10", "Slide 12 · Week 3 Hashing", "Page 3 · Study guide" or "Page: Module 3: Hash tables". */
export function sourceLine(s: QuickQuestion["source"]): string {
  if (s.kind === "lecture" && typeof s.sec === "number") return `${s.title} · ${formatTime(s.sec)}`;
  if (isPdf(s)) return `${pdfPlace(s)} · ${s.deck}`;
  return `Page: ${s.title}`;
}

/** Completes "It's on …". */
function whereWords(s: QuickQuestion["source"]): string {
  if (s.kind === "lecture" && typeof s.sec === "number") return `${s.title} at ${formatTime(s.sec)}`;
  if (isPdf(s)) return `${pdfPlace(s).toLowerCase()} of "${s.deck}"`;
  return `the page "${s.title}"`;
}

/** How far a lecture question's clip runs from its quote, at most (the player's clips are at most 75 s). */
export const CLIP_SECONDS = 45;

/** The stored lines as the player's transcript: each runs to the next one's start. */
export function linesToSegments(lines: { start: number; text: string }[]): TranscriptSegment[] {
  return lines.map((l, i) => ({ start: l.start, end: lines[i + 1]?.start ?? l.start + 7, speaker: null, text: l.text }));
}

/** The lecture moment of a question: from the quote's line, for up to 45 s but not past the stored lines. */
export function clipOf(s: QuickQuestion["source"]): { start: number; end: number } | null {
  if (s.kind !== "lecture" || typeof s.sec !== "number" || !s.recordingUrl) return null;
  const segs = linesToSegments(s.lines ?? []);
  const last = segs.at(-1)?.end ?? s.sec + 7;
  return { start: s.sec, end: Math.max(s.sec + 7, Math.min(s.sec + CLIP_SECONDS, last)) };
}

export function questionToSeed(q: QuickQuestion, n: number): SeedQuestion {
  const clip = clipOf(q.source);
  return {
    id: q.id,
    n,
    stem: q.stem,
    code: q.code,
    choices: q.choices,
    answer: q.answer,
    // A lecture question has a clip on the student's own recording (Rewind seeks it through the extension); a page
    // question has none, and the sheet shows where it comes from.
    match: {
      start: (clip?.start ?? null) as number,
      end: (clip?.end ?? null) as number,
      recordingUrl: q.source.recordingUrl,
      exampleStart: null,
      setup: null,
      sourceLines: [],
      slide: { deck: q.source.title, page: 0, image: "", kind: "page", excerpt: q.quote },
    },
    segments: linesToSegments(q.source.lines ?? []),
    explanation: q.explanation,
    quick: { label: sourceLine(q.source), where: whereWords(q.source), quote: q.quote },
  };
}

export function bankToSeed(bank: QuickBank): PracticeSeed {
  return {
    course: bank.course,
    set: "Quick build (beta)",
    lecturer: { name: "", short: "" },
    recordingUrl: "",
    questions: bank.questions.map((q, i) => questionToSeed(q, i + 1)),
    questionSet: "generated",
  };
}
