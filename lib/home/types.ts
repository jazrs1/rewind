// The course home: the next exam with its countdown, and one lecture tape per module.
// lib/home/build.ts fills it (pure); lib/home/local.ts feeds it the local private/ data in dev.
// Nothing is guessed: an exam field is either a value with its source, or "not found" with
// where we looked. A module with no recording is a blank tape, never a made-up one.

import type { Sourced } from "../schema.ts";
import type { SourceRef } from "../pipeline/types.ts";

// ---------- Input ----------

/** The exam fields the home reads (a PipelineExam has these and more). */
export interface HomeExamInput {
  id: string;
  name: Sourced<string>;
  /** "YYYY-MM-DD" or an ISO date-time; read in Eastern time. */
  date: Sourced<string>;
  location: Sourced<string>;
  topics: Sourced<string[]>;
  /** Every source that was read, so a quote's itemId can be named and "not found" can say where we looked. */
  searched: SourceRef[];
  /**
   * When the exam's Canvas assignment stops taking submissions (its due_at): metadata, not a quote. Never
   * an exam's date; a quiz with no quoted date uses it as its due date, labelled "Canvas due date".
   */
  windowCloses?: { value: string; itemId: string } | null;
}

export interface HomeModuleInput {
  id: string;
  /** Course order (Canvas position). */
  position: number;
  /** "Module 9" as Canvas names it. */
  name: string;
  /** The module's topic ("Sorting"), or null when the course doesn't name one. */
  topic: string | null;
  /** Titles of its items, to find the module an exam is in ("Review and Exam 1"). */
  itemTitles: string[];
  /** Eastern dates (YYYY-MM-DD) of its dated items (assignment due dates). */
  dates: string[];
}

export interface HomeLectureInput {
  id: string;
  /** Eastern date YYYY-MM-DD, or null when unknown. */
  date: string | null;
  /** Lecturer lines only, in order. */
  lines: string[];
}

/** One practice question /practice can serve: where it's from and the module it's on (lib/home/practice.ts). */
export interface PracticeIndexQuestion {
  id: string;
  /** Eastern date of the lecture it's from, or null. */
  lectureDate: string | null;
  /** Module position it's on, or null when it can't be told. */
  module: number | null;
  /** It plays a lecture clip (counted on /practice's line whatever lecture it's from). */
  clip?: boolean;
}

export interface HomeInputs {
  course: { code: string; name: string | null; importedAt: string | null };
  /** ISO date-time the home is built for. */
  now: string;
  exams: HomeExamInput[];
  modules: HomeModuleInput[];
  lectures: HomeLectureInput[];
  /** The questions practice can serve. "Ready" and tape links come only from these. */
  practice: PracticeIndexQuestion[];
}

// ---------- Output ----------

/** Where a value came from, in words, with a link to open it when there is one. */
export interface SourceInfo {
  /** The course item the quote is from (fields that share one share a source line). */
  itemId: string | null;
  label: string;
  link: { href: string; label: string } | null;
  /** The word-for-word quote the value comes from; null for Canvas metadata (a due date), which is labelled as such. */
  quote: string | null;
}

export type HomeField =
  | { state: "found"; text: string; source: SourceInfo }
  | { state: "missing"; searched: string };

export interface HomeExam {
  id: string;
  /** What to call it ("Exam 2"): the found name, else "Next exam". */
  title: string;
  name: HomeField;
  date: HomeField;
  location: HomeField;
  /** What it covers, topics joined ("Heaps, Sorting"). */
  topics: HomeField;
  /** Source lines under the fields: found fields with the same source merged ("Name and date"). */
  sources: { label: string; field: HomeField }[];
  /** Where the date came from, for the card's header ("From an announcement"), or null. */
  dateFrom: string | null;
  /** quote: the date is a word-for-word quote; canvas-due: a quiz's Canvas due date (metadata). */
  dateKind: "quote" | "canvas-due";
}

export type Countdown =
  /** The next exam whose date is known, in whole Eastern calendar days from today (0 = today). */
  | { kind: "days"; exam: HomeExam; days: number; text: string }
  /** No upcoming exam has a known date. `exam` is one whose date wasn't found, if any. */
  | { kind: "no-date"; exam: HomeExam | null; text: string };

/**
 * "Everything since Exam 1": the modules after the one holding the previous exam, up to the last module
 * with a date on or before the next exam. Our guess, which the student must confirm.
 */
export interface CoverageGuess {
  /** "Exam 1". */
  since: string;
  positions: number[];
  /** "Everything since Exam 1 (Modules 8 to 10)". */
  label: string;
  /** How it was worked out, for the confirm step. */
  why: string;
  /** Modules after the range with no dates, so not in it ("Module 15 has no dates yet, so it's left out."), or null. */
  leftOut: string | null;
}

export type Coverage =
  /** The exam's topics were found (quoted): practice can start for the exam. */
  | { kind: "known"; title: string; topics: string[] }
  /** Not found: never start practice silently. Offer the guess (when it can be worked out) or picking topics. */
  | { kind: "unknown"; text: string; guess: CoverageGuess | null; noGuess: string | null };

/** What a tape opens, said on the tape ("Practice the Oct 22 lecture"), and its lectures without questions. */
export type TapeLink = { href: string; label: string; note: string | null };

export interface HomeTape {
  moduleId: string;
  position: number;
  /** "Mod 9: Sorting" (or "Module 9" when no topic is known). */
  label: string;
  /** recorded: at least one lecture recording covers it; blank: none (a grey tape). */
  state: "recorded" | "blank";
  /** 1..4 for the shell color, in tape order among the modules; null for a blank tape. */
  shell: 1 | 2 | 3 | 4 | null;
  /** Eastern dates of the lectures on it, oldest first. */
  lectureDates: string[];
  link: TapeLink | null;
  /** On the next exam: true when its topics are known and name this module; null when unknown. */
  onNextExam: boolean | null;
}

export interface HomeModel {
  course: { code: string; name: string | null; importedAt: string | null };
  now: string;
  countdown: Countdown;
  tapes: HomeTape[];
  /** A quiz before the next exam whose date and topics were both found: shown first, it's this week's work. */
  quiz: {
    exam: HomeExam;
    days: number;
    text: string;
    /** Modules its found topics name, and the link to practise them (with what's ready), or null when none match. */
    practice: { modules: number[]; href: string; ready: string } | null;
  } | null;
  /** What the next exam covers, which decides how practice starts. */
  coverage: Coverage;
  /** Modules the practice set has questions for (from the lecture it comes from). */
  ready: { positions: number[]; lectureDates: string[] };
  /** The questions practice can serve (ids, lecture, module), for the chooser's ready lines. */
  practice: PracticeIndexQuestion[];
  /** Index of the last recorded tape, for the phone's short list; -1 when none. */
  latestRecorded: number;
}
