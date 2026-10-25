// Word-level times from the lecture audio: cuts a clip around a moment with ffmpeg
// and transcribes it with Gemini Transcribe (cached by lib/gemini.ts, paid for once per clip).

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { hashKey, transcribe } from "../../lib/gemini.ts";
import { tokens, type TimedWord } from "./align.ts";

export const CLIP_HALF_SEC = 240;

// Cuts [from, from + len] out of the audio as 16 kHz mono 48 kbps MP3 (about 4 MB for 12 min, small enough to send inline).
async function cutClip(audio: string, from: number, len: number): Promise<string> {
  const dir = join(".cache", "clips");
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${hashKey([audio, from, len]).slice(0, 16)}.mp3`);
  await promisify(execFile)("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(from), "-t", String(len), "-i", audio, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", out]);
  return out;
}

/** Words with times in seconds from the start of the recording, for ±4 minutes around `around`. */
export async function audioWords(audio: string, around: number): Promise<TimedWord[]> {
  // Clip boundaries snap to 4-minute steps so nearby moments share one cached transcription.
  const from = Math.max(0, Math.floor(around / CLIP_HALF_SEC) * CLIP_HALF_SEC - CLIP_HALF_SEC);
  const t = await transcribe(await cutClip(audio, from, 3 * CLIP_HALF_SEC));
  return t.words.flatMap((w) => tokens(w.word).map((word) => ({ word, start: from + w.start })));
}
