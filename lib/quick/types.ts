// Quick build (beta): the shapes shared by the browser and the server route. Behind NEXT_PUBLIC_REWIND_QUICK_BUILD=1.
// The browser sends a batch of its own course text; the route answers with questions; the browser keeps them.

import type { ChoiceLabel } from "../schema.ts";

/** What one request may carry (lib/quick/schema.ts enforces all of it). */
export const LIMITS = {
  /** Chunks per batch. */
  chunks: 12,
  /** Characters per chunk (the pipeline's CHUNK_CHARS). */
  chunkChars: 800,
  /** Bytes per request body. */
  bodyBytes: 32 * 1024,
  /** Timed lines in one lecture chunk. */
  segments: 40,
  /** Questions one build makes (the browser stops there). */
  questionsPerBuild: 15,
  /** Questions one visitor gets per day, all builds together (the route's cap; John, Sun 3:1x: 60 through judging, so a
   *  visitor can rebuild a few times; the $4/day Quick budget still caps cost). */
  questionsPerDay: 60,
  /** Questions written from one batch. */
  perBatch: 5,
} as const;

export interface QuickSegment {
  start: number;
  end: number;
  text: string;
}

/** Where course text comes from: a Canvas page, a lecture's transcript, or a page of a PDF the student picked (slides or a document). */
export type QuickKind = "page" | "lecture" | "slide" | "document";

export interface QuickChunk {
  id: string;
  kind: QuickKind;
  /** A page's title, the recording's ("Lecture, Oct 22"), or the PDF's name. */
  title: string;
  text: string;
  lecture?: { recordingUrl: string; recordedAt: string; segments: QuickSegment[] };
  /** Slide or document: the PDF's name without its extension, and the 1-based page the text is on. */
  doc?: { deck: string; page: number };
}

export interface QuickRequest {
  course: { code: string; name: string };
  chunks: QuickChunk[];
}

export interface QuickSource {
  kind: QuickKind;
  title: string;
  /** Slide or document: the PDF's name and the page ("Slide 12 · <deck>"). */
  deck?: string;
  page?: number;
  /** Lecture: the start (seconds into the recording) of the first line holding the quote. */
  sec?: number;
  recordingUrl?: string;
  /** Lecture: the lines of the chunk the quote is in (the student's own text, sent back), shown when the recording can't be played. */
  lines?: { start: number; text: string }[];
}

export interface QuickQuestion {
  id: string;
  stem: string;
  code: { language: string; lines: string[] } | null;
  choices: { label: ChoiceLabel; text: string }[];
  answer: ChoiceLabel;
  explanation: string;
  /** Word for word from the chunk it cites. */
  quote: string;
  source: QuickSource;
}

export interface QuickResponse {
  questions: QuickQuestion[];
  refused: { reason: string }[];
}
