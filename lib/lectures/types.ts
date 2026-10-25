// Types for the record-a-lecture pipeline (T11): phone recording chunks in, a tape out.

import type { Transcription } from "../gemini.ts";
import type { Transcript } from "../schema.ts";

/** One piece of the phone recording. MediaRecorder cuts one every 5 minutes. */
export interface RecordingChunk {
  index: number;
  /** Seconds from the start of the whole recording. */
  startSec: number;
  mimeType: string;
  path: string;
  /** Wall-clock start of this chunk (ISO), when the recorder knows it. */
  recordedAt?: string | null;
  /** Length of this chunk in seconds, when known; else its last word's end is used. */
  durationSec?: number | null;
}

/** One page of the day's slides. */
export interface SlidePage {
  deck: string;
  page: number;
  text: string;
}

/** The lead's `transcribe` from lib/gemini.ts, injected so tests never call Gemini. */
export type TranscribeFn = (path: string, options: { diarization: boolean }) => Promise<Transcription>;

/** A word placed on the recording's timeline, with its chunk-local speaker label. */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
  chunk: number;
  /** Diarization label as Gemini gave it in this chunk ("spk:0", ...), or null. */
  label: string | null;
}

export interface SlideSpan {
  deck: string;
  page: number;
  /** First and last lecture time (seconds) where the lecturer's words best match the page. */
  from: number;
  to: number;
}

/** A chunk dropped whole because the lecturer couldn't be told apart (privacy guard, T11b). */
export interface SkippedChunk {
  index: number;
  startSec: number;
  endSec: number;
  reason: "unclear speaker";
}

/** A recorded lecture: only the lecturer's voice, real word-level times, matched to slides. */
export interface LectureTape extends Transcript {
  source: "phone";
  /** Other voices are never stored; only how much was dropped (in chunks that were kept). */
  dropped: { speakers: number; seconds: number };
  /** Whole chunks left out because no speaker clearly was the lecturer. */
  skipped: SkippedChunk[];
  slides: SlideSpan[];
}
