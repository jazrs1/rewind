// The course pipeline's contract. Every stage reads and writes these shapes under
// private/pipeline/<COURSE>/ (real course data, never committed), so stages can be built,
// cached and rerun independently:
//
//   download → extract → chunk → embed → exams → generate → check → retrieve → output
//
//   files/<fileId>.<ext>   downloaded course files              (download, Tier 2)
//   docs.json              ExtractedDoc[]                        (extract)
//   chunks.json            PipelineChunk[] (embeddings cached by lib/gemini.ts)  (chunk, embed)
//   exams.json             PipelineExam[]                        (exams: syllabus + announcements)
//   questions.json         PracticeQuestion[]                    (generate, check, retrieve)
//   output.json            PipelineOutput                        (what the app reads)

import type { ChoiceLabel, Exam, ItemRole, Transcript } from "../schema.ts";

/** Where a piece of text or a claim comes from. Every chunk and every citation carries one. */
export type SourceRef =
  | { kind: "slide"; itemId: string; fileId: number; page: number; deck: string; href?: string }
  | { kind: "document"; itemId: string; fileId: number; page: number; name: string; href?: string }
  | { kind: "page"; itemId: string; pageUrl: string; title: string; href?: string }
  | { kind: "announcement"; itemId: string; title: string; postedAt: string; href?: string }
  | { kind: "syllabus"; itemId: string; href?: string }
  | { kind: "assignment"; itemId: string; name: string; dueAt: string | null; href?: string }
  | { kind: "lecture"; itemId: string; recordingUrl: string; start: number; end: number; title: string };

/** One course file or page with its text, page by page. */
export interface ExtractedDoc {
  itemId: string;
  fileId: number | null;
  name: string;
  role: ItemRole;
  /** 1-based pages (slides for decks). A page-less item (a Canvas page) has one entry, page 1. */
  pages: { page: number; text: string }[];
  /** Why extraction gave nothing usable, e.g. "scanned PDF, no text layer". */
  problem?: string;
}

export interface PipelineChunk {
  id: string;
  text: string;
  role: ItemRole;
  source: SourceRef;
}

/** An exam from the syllabus, assignments or announcements. Each field is Sourced: a word-for-word quote or null ("not found"). */
export interface PipelineExam extends Exam {
  /** Which sources were read, so "not found" can say where we looked. */
  searched: SourceRef[];
  /** Sources that disagree on a field (e.g. a newer announcement moves the date): both quotes, which won, and why. */
  conflicts?: { field: string; kept: { quote: string; source: SourceRef }; other: { quote: string; source: SourceRef }; reason: string }[];
}

export interface Retrieval {
  /** The lecture moment that explains it; null when the course has no recording of it. */
  clip: {
    recordingUrl: string;
    start: number;
    end: number;
    exampleStart: number | null;
    setup: string | null;
    sourceLines: number[];
    transcriptId: string;
  } | null;
  slide: Extract<SourceRef, { kind: "slide" | "document" }> | null;
  /** The Canvas page the quote is from, when it is from one (a course with no slides or files): shown as text, no image. */
  page?: Extract<SourceRef, { kind: "page" }> | null;
  /** What the rewind shows without a clip. */
  fallback: "slide" | "reading" | "none" | null;
}

export interface PracticeQuestion {
  id: string;
  examId: string | null;
  topic: string;
  stem: string;
  /**
   * Code the question depends on, shown in the question as a code block (on paper: monospace
   * with print-green rules). A question never refers to code, a solution or an example that
   * isn't on screen: it either carries the exact lines here (cited) or stands alone.
   */
  code?: { language: string; lines: string[]; source: SourceRef } | null;
  choices: { label: ChoiceLabel; text: string }[];
  answer: ChoiceLabel;
  explanation: string;
  /** Word for word from `quoteSource`'s text, or the question isn't kept. */
  quote: string;
  quoteSource: SourceRef;
  /** The past review whose style it follows, if any. */
  styleItemId: string | null;
  check: { agreed: boolean; attempts: number; reason: string | null };
  retrieval: Retrieval;
  /** Prompt versions used (lib/prompts/*), for reproducibility. */
  prompts: Record<string, string>;
}

export interface PipelineOutput {
  course: { id: number; code: string; name: string };
  generatedAt: string;
  counts: { docs: number; chunks: number; exams: number; questions: number; withClip: number; withSlide: number };
  exams: PipelineExam[];
  questions: PracticeQuestion[];
  transcripts: { id: string; title: string; recordingUrl: string; recordedAt: string | null }[];
  cost: { geminiUsd: number; claudeUsd: number };
}

/** Lecture transcripts the pipeline was given (Zoom exports or recorded tapes). */
export type PipelineTranscript = Transcript & { id: string };
