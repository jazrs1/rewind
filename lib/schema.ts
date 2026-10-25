// Shared data types. Transcript and CourseExport match the shared formats in
// AGENT_TASKS.md exactly; the rest follow docs/PLAN.md "Architecture and data".

// ---------- Shared formats (contract with the worker) ----------

/**
 * One sentence (or short Zoom item) of a lecture transcript.
 * Times are seconds from the start of the recording.
 */
export interface TranscriptSegment {
  start: number;
  end: number;
  /** Exactly as Zoom shows it, or null. */
  speaker: string | null;
  text: string;
  /** true when start/end were interpolated inside a longer chunk (see splitChunk in lib/transcript.ts). */
  estimated?: boolean;
}

/** A raw chunk as Zoom shows it: often a whole speaker turn, minutes long. */
export interface TranscriptChunk {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

/** `*.transcript.json`, written by the Zoom extractor (and the spike parser). */
export interface Transcript {
  /** zoom: a Zoom cloud recording; phone: a lecture the student recorded in class. */
  source: "zoom" | "phone";
  recordingUrl: string;
  title: string;
  /** ISO date or null. */
  recordedAt: string | null;
  durationSec: number;
  segments: TranscriptSegment[];
  /** The raw Zoom chunks the segments were split from, when they were split. */
  chunks?: TranscriptChunk[];
}

/** A failed Canvas endpoint, recorded instead of stopping the export. */
export interface ExportError {
  endpoint: string;
  /** null for a network failure. */
  status: number | null;
}

/**
 * Raw Canvas API object, unchanged. Only the fields we read are typed;
 * lib/import/ narrows these further.
 */
export type CanvasObject = Record<string, unknown>;

/** `*.course.json`, written by the Canvas exporter. */
export interface CourseExport {
  exportedAt: string;
  /** name and course_code are null only when the course details request failed. */
  course: { id: number; name: string | null; course_code: string | null };
  files: CanvasObject[];
  modules: CanvasObject[];
  pages: CanvasObject[];
  assignments: CanvasObject[];
  announcements: CanvasObject[];
  submissions: CanvasObject[];
  syllabus_body: string | null;
  /** Announcements are fetched for this date window (Canvas defaults to the last 14 days otherwise). */
  announcementsRange?: {
    /** 30 days before baseStart, so "welcome" posts made before day 1 are included. */
    start: string;
    end: string;
    /** The course (or term) start the window is based on. */
    baseStart: string;
    startFrom: "course" | "term" | "fallback";
  };
  errors: ExportError[];
}

// ---------- App records ----------

/**
 * A value pulled from course material, with the exact quote it came from.
 * The quote must appear word for word in the source; otherwise value and quote
 * are both null and the UI shows "not found". Nothing is guessed.
 */
export interface Sourced<T> {
  value: T | null;
  quote: string | null;
  /** Item the quote was found in. */
  itemId: string | null;
}

export type CourseLayout = "files" | "modules" | "mixed" | "unknown";

export interface Course {
  id: string;
  canvasId: number;
  name: string;
  courseCode: string | null;
  layout: CourseLayout;
}

export type ItemRole =
  | "lecture"
  | "transcript"
  | "review" // past exam or review
  | "practice"
  | "homework"
  | "syllabus"
  | "admin"
  | "page" // a Canvas page's own text that the title rules can't place (no file behind it)
  | "unknown";

/** A file, page or recording in a course. */
export interface Item {
  id: string;
  courseId: string;
  kind: "file" | "page" | "recording";
  name: string;
  role: ItemRole;
  topic: string | null;
  /** Canvas link, or the recording URL. */
  url: string;
  canvasFileId: number | null;
}

/** Where a chunk of text came from. */
export type ChunkSource =
  | { kind: "slide"; itemId: string; page: number }
  | { kind: "page"; itemId: string }
  | { kind: "recording"; itemId: string; recordingUrl: string; start: number; end: number };

export interface Chunk {
  id: string;
  text: string;
  source: ChunkSource;
}

/** A line of a transcript: its index in `Transcript.segments`. */
export type TranscriptLineId = number;

/** Where a question's rewind lands in a lecture recording. */
export interface RewindMatch {
  questionId: string;
  recordingUrl: string;
  /** Clip start and end, seconds from the start of the recording. */
  start: number;
  end: number;
  /**
   * Where the example or explanation the clip is part of begins (at or before `start`),
   * within the ~5 minutes before it and never across a speaker change. null if the clip
   * already starts at the beginning.
   */
  exampleStart: number | null;
  /**
   * At most 35 words on what's on screen and what he's in the middle of, summarizing only
   * the lines in `sourceLines` (between exampleStart and start). Never new facts; null if it
   * couldn't be grounded.
   */
  setup: string | null;
  sourceLines: TranscriptLineId[];
  slide: { deck: string; page: number };
}

export interface Exam {
  id: string;
  courseId: string;
  name: Sourced<string>;
  /** ISO date-time in Eastern time. */
  date: Sourced<string>;
  location: Sourced<string>;
  format: Sourced<string>;
  notesRule: Sourced<"printed" | "handwritten" | "none">;
  topics: Sourced<string[]>;
}

export type ChoiceLabel = "A" | "B" | "C" | "D";

export interface Question {
  id: string;
  courseId: string;
  topic: string;
  stem: string;
  choices: { label: ChoiceLabel; text: string }[];
  answer: ChoiceLabel;
  /** Chunks (slides, lecture moments) the question and answer cite. */
  citedChunkIds: string[];
  /** The past review whose style this question follows. */
  styleItemId: string | null;
}

export type Confidence = "guessing" | "fairly-sure" | "certain";

export interface Attempt {
  id: string;
  studentId: string;
  questionId: string;
  choice: ChoiceLabel;
  correct: boolean;
  confidence: Confidence | null;
  answeredAt: string;
}

/** Per-student, per-topic knowledge-tracing estimate. */
export interface Mastery {
  studentId: string;
  courseId: string;
  topic: string;
  /** Probability the student knows the topic, 0 to 1. */
  pKnown: number;
  attempts: number;
  updatedAt: string;
}
