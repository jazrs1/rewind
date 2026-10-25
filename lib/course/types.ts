// The course tape: the whole semester as one cassette. Supply reel = first lecture, take-up
// reel = final exam, the tape head at "You are here", and every topic a stop in course order.
// This is the data the Course tape screen draws; lib/course/build.ts fills it (pure), and
// lib/course/local.ts feeds it the local private/ data in dev.
//
// Every number is evidence, not a prediction: each score is the sum of the `points` in its
// evidence list, rounded to 2 decimals, and a topic with no evidence scores 0. Unknown facts
// stay null (never guessed).

import type { TranscriptSegment } from "../schema.ts";
import type { ImportItem } from "../import/types.ts";

// ---------- Output ----------

export type EvidenceKind =
  /** He flagged it in a lecture ("this will be on the exam"), from the exam radar. */
  | "radar"
  /** Minutes of lecture he spent on it. */
  | "minutes"
  /** A past exam or review file names it. */
  | "review"
  /** A course announcement mentions it. */
  | "announcement"
  /** The student's own practice answer. */
  | "practice"
  /** A Canvas grade on an assignment about it. */
  | "grade";

export interface Evidence {
  kind: EvidenceKind;
  /** What this piece adds to its score (see WEIGHTS in build.ts). Can be 0 (a right answer, a full score). */
  points: number;
  /** Word for word from the source (a transcript line, a file name, an announcement line), or null. */
  quote: string | null;
  /** Where it came from, for people: "Lecture, Oct 20", "Canvas grade", "Announcement". */
  source: string;
  /** One short line on what it shows: "12 min of lecture", "6.7 / 10", "He flagged it (exam)". */
  detail: string;
  /** Date (YYYY-MM-DD, Eastern) or null when unknown. */
  at: string | null;
  /** Seconds into the lecture recording, for lecture evidence. */
  sec?: number;
  lectureId?: string;
  /** Canvas or recording link. */
  href?: string;
  /** Example practice history (the demo course), never the student's own answer: always labelled on screen. */
  example?: true;
  /** Radar evidence: the kinds of flag ("exam", "importance"…). An "exam" or "importance" flag can carry a full glow. */
  flags?: string[];
}

export interface Score {
  /** Sum of evidence points, 2 decimals. 0 when there is no evidence. */
  score: number;
  /**
   * 0..1, for glow and ring strength. Missed: score / the highest missed score on the tape. Stressed: an absolute scale
   * (lib/course/build.ts stressHeat): nothing under STRESS.floor points without a flag or review, full only with an
   * "exam" or "importance" flag or a past review, never just for the most minutes.
   */
  heat: number;
  evidence: Evidence[];
}

/** A moment in a lecture recording to play. */
export interface Clip {
  id: string;
  lectureId: string;
  lectureTitle: string;
  /** Eastern date of the lecture (YYYY-MM-DD) or null. */
  lectureDate: string | null;
  recordingUrl: string;
  /** Seconds from the start of the recording. start is a real transcript line time. */
  start: number;
  end: number;
  /**
   * practice-match: a practice question's rewind (the matcher, checked by ear);
   * radar: from the line where he flagged it; lecture-span: where his longest stretch on the topic starts.
   */
  from: "practice-match" | "radar" | "lecture-span";
  /** The first line of the clip, word for word. */
  quote: string | null;
  slide: { deck: string; page: number } | null;
  /** practice-match from the pipeline: its grounded setup line and where the example starts. */
  setup?: string | null;
  exampleStart?: number | null;
}

/** What a course without a recording shows instead of a clip. */
export interface Fallback {
  kind: "slides" | "reading";
  label: string;
  href: string | null;
}

export type StopState = "past" | "current" | "future" | "unknown";

export interface Stop {
  id: string;
  topic: string;
  /** 0-based place on the tape (by first-taught date, then course order). */
  order: number;
  /** Where the topic name came from. */
  topicFrom: "module" | "slides" | "lecture";
  /** The module it belongs to (for the tape shell color), or null for a slides-only stop. */
  module: { id: string; name: string; position: number } | null;
  /** Earliest date we have evidence it was taught (YYYY-MM-DD), or null when unknown. */
  firstTaughtAt: string | null;
  /** The evidence that date comes from (a lecture or a week's announcement), or null. */
  firstTaughtFrom: Pick<Evidence, "kind" | "source" | "quote" | "at"> | null;
  /** 0..1 along the tape, supply reel (0) to take-up reel (1). See CourseTape.positionBasis. */
  position: number;
  /** past: taught before the current stop; current: the most recent topic taught; unknown: no dates at all. */
  state: StopState;
  /** Glow: how much the professor stressed it. */
  stressed: Score;
  /** Missed: how much the student misses it (shown as the red-pen ✕n by the dot). */
  missed: Score;
  /** On the next exam: true/false when its coverage is known, null when it isn't. */
  onNextExam: boolean | null;
  /** Playable moments, best first (practice-match, then radar, then lecture-span). */
  clips: Clip[];
  /** Slide decks for this topic (the no-recording fallback). */
  slides: Fallback[];
  /** Practice question ids on this topic. */
  practiceIds: string[];
  /** Lecture minutes on this topic (sum of the minutes evidence). */
  lectureMinutes: number;
}

export interface RouteStep {
  /** 1 = first stop on the route back. */
  rank: number;
  stopId: string;
  topic: string;
  /** stressed.score × missed.score. */
  product: number;
  /** stressed-and-missed: ranked by the product; stressed-only: filler when fewer than 3 stops have both. */
  reason: "stressed-and-missed" | "stressed-only" | "missed-only";
  /** What plays: the stop's best clip, else its slides, else nothing. */
  play: { kind: "clip"; clip: Clip } | { kind: "fallback"; fallback: Fallback } | { kind: "none" };
  /** Up to 3 practice questions for the short set after the clips. */
  practiceIds: string[];
}

export interface Route {
  /** next-exam: only topics on the next exam; overall: its coverage isn't known, so every taught topic. */
  basis: "next-exam" | "overall";
  /** One line for the screen, e.g. "for Quiz 8" or "next exam's topics unknown: ranked over the whole course". */
  label: string;
  exam: { name: string; at: string | null; coverageQuote: string | null; coverageSource: string | null } | null;
  steps: RouteStep[];
}

export interface Marker {
  id: string;
  /** Assessment name as Canvas shows it. */
  label: string;
  /** Due date (YYYY-MM-DD) or null. */
  at: string | null;
  score: number | null;
  possible: number | null;
  /** 0..1 on the tape, or null when it can't be placed. */
  position: number | null;
  isNext: boolean;
  href?: string;
}

export interface CourseTape {
  /**
   * What the glow is made of: "lectures" when some lecture's minutes count (whole recordings or slide timelines), "flags"
   * when only flags and reviews do (every lecture is clip excerpts, as in the demo): the legend then says "he flagged it".
   */
  glowFrom: "lectures" | "flags";
  course: { code: string; name: string | null };
  /** ISO date-time the tape was built for. */
  now: string;
  /** Course week from an announcement title ("Week - 10"), with its quote, or null. */
  week: { n: number; quote: string; source: string } | null;
  /** The tape head: the current stop and where it sits, or nulls when no stop has a date. */
  here: { stopId: string | null; position: number | null };
  /**
   * dates: positions follow first-taught dates between the first lecture and the final exam;
   * order: those dates aren't both known, so stops are evenly spaced in tape order.
   */
  positionBasis: "dates" | "order";
  stops: Stop[];
  route: Route;
  /** Exams and quizzes along the tape (flags). */
  markers: Marker[];
  totals: {
    stops: number;
    lectures: number;
    /** Minutes of lecturer speech across all lectures. */
    lectureMinutes: number;
    radarMoments: number;
    /** Seconds of clips on the route. */
    listenSec: number;
    /** Practice questions after the route's clips. */
    questions: number;
  };
  /** Evidence we found but couldn't tie to a stop (shown, never dropped). */
  unplaced: Evidence[];
  /** Plain notes on what's missing or approximated, for the screen and for us. */
  notes: string[];
}

/** What the tape screen needs to play a stop's clip: the lecturer's lines around it, and who he is. */
export interface ClipContext {
  segments: TranscriptSegment[];
  /** Short name for the player ("Kapoor"), or "the lecturer" when unknown. */
  lecturer: string;
}

// ---------- Input ----------

/** A module in course order. From Canvas (modulesFromCanvas) or from lecture openings (modulesFromLectures). */
export interface ModuleInput {
  id: string;
  name: string;
  position: number;
  /** Titles of its items (pages, quizzes, files), used for the topic and to tie quizzes to it. */
  itemTitles: string[];
  from: "canvas" | "lecture";
}

export interface LectureInput {
  id: string;
  title: string;
  /** ISO date-time or null. */
  recordedAt: string | null;
  recordingUrl: string;
  durationSec: number;
  /** Only this speaker's lines count (the lecturer); null counts every line. */
  lecturer: string | null;
  segments: TranscriptSegment[];
  /**
   * The slide timeline, when the lecture has one: the spans where each slide is on screen (seconds of the recording).
   * A topic's lecture minutes are then the time its lecture-deck slides are on screen, never Discussion decks; keyword
   * windows are only the fallback for lectures without one. (Made from the recordings by a separate job.)
   */
  slideTimeline?: { startSec: number; endSec: number; deck: string; page: number }[];
  /**
   * Only excerpts of the lecture are here (the demo bundle's clips behind its questions), not the whole class: its
   * minutes don't count toward "stressed", which then comes from flags and reviews only.
   */
  clipOnly?: boolean;
  /**
   * The module the whole input is about, when the caller already knows (the demo course: one input per topic).
   * Every window is then that module's stop, with no keyword guessing, and its date is the stop's first-taught date.
   */
  moduleId?: string;
}

/** One exam-radar moment (merged hits), from scripts/radar/scan.mjs. */
export interface RadarInput {
  lectureId: string;
  start: number;
  kinds: string[];
  phrases: string[];
  text: string;
}

export interface PracticeInput {
  id: string;
  /** The question stem. */
  text: string;
  /** The pipeline's topic for it, used when nothing else places it. */
  topic?: string;
  lectureId: string | null;
  /** The module it belongs to, when the caller already knows (the demo course); placed there before anything else. */
  moduleId?: string;
  /** The matcher's (or the pipeline's) rewind for this question, if any, with its setup line. */
  clip: { start: number; end: number; slide: { deck: string; page: number } | null; setup?: string | null; exampleStart?: number | null } | null;
  /** The student's answers; null when unknown (then it adds no missed evidence). */
  attempts: { correct: boolean; answeredAt: string }[] | null;
}

export interface GradeInput {
  id: string;
  name: string;
  score: number;
  possible: number;
  /** ISO or null. */
  gradedAt: string | null;
  href?: string;
}

export interface AnnouncementInput {
  id: string;
  title: string;
  postedAt: string | null;
  /** Plain text, one line per paragraph or list item. */
  lines: string[];
  href?: string;
}

export interface ExamInput {
  id: string;
  name: string;
  /** Due date-time (ISO) or null. */
  at: string | null;
  score: number | null;
  possible: number | null;
  href?: string;
}

export interface NextExamInput {
  id: string | null;
  name: string;
  at: string | null;
  /** Text that states what it covers (e.g. the quiz title), word for word; null when coverage is unknown. */
  coverage: { quote: string; source: string } | null;
}

export interface CourseTapeInputs {
  course: { code: string; name: string | null };
  /** ISO date-time. */
  now: string;
  /** Both needed for date positions; otherwise stops are spaced by order. */
  term?: { firstLectureAt: string | null; finalExamAt: string | null };
  modules: ModuleInput[];
  /** The import normalizer's items (slide decks, reviews). */
  items: ImportItem[];
  lectures: LectureInput[];
  radar: RadarInput[];
  practice: PracticeInput[];
  /** Canvas grades. Counted in "missed" only with includeGrades (off by default: reading grades waits on John, Tier 2). */
  grades: GradeInput[];
  /** Count Canvas grades in "missed". Default false: missed comes from saved practice attempts only. */
  includeGrades?: boolean;
  announcements: AnnouncementInput[];
  exams: ExamInput[];
  nextExam: NextExamInput | null;
  /** Notes from the adapter (e.g. "no Canvas export: modules come from lecture openings"). */
  notes?: string[];
  /**
   * Per-topic numbers derived from the full recordings, with no lecture text: the minutes spent on a topic and where
   * the professor flagged it. A slot for the demo bundle, if such numbers are approved for it; unused until then.
   */
  derived?: DerivedTopic[];
}

/** Numbers about a topic from the full recordings, without quotes (CourseTapeInputs.derived). */
export interface DerivedTopic {
  /** The topic as the tape names it (a module or deck topic). */
  topic: string;
  /** The lecture's date (YYYY-MM-DD) when the numbers are one lecture's: a flag's second is into that recording. */
  lecture?: string;
  minutes: number;
  flags: { kind: string; sec: number }[];
}
