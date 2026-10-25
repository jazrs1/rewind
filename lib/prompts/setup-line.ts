// Setup-line prompt: one or two sentences telling a student what's on screen and what the
// professor is in the middle of when a clip starts cold, plus where the example began.
// Promoted from the rewind spike (scripts/spike/match.ts) with its rules unchanged: grounded in
// the lines before the clip only, no numbers, at most 35 words. The output is checked in code
// (lib/rewind.ts: setupGrounding, setupNumbers, wordCount) before it's shown.
// @2 (Oct 24): the professor is named or "they", never "he" (the demo showed "He is…" under
// "Where Kapoor is"); the spike's cached @1 answers no longer apply.

import { formatTime } from "../format.ts";
import type { TranscriptSegment } from "../schema.ts";

export const VERSION = "setup-line@2";

export const SETUP_MAX_WORDS = 35;

export interface SetupLineInput {
  /** The practice question the student missed. */
  question: string;
  /** The clip's text, start to end. */
  clipText: string;
  /** The lecturer's lines before the clip (same speaker run, up to 5 minutes), with their line IDs. */
  lines: { id: number; seg: TranscriptSegment }[];
  /** Words a previous attempt used that the lines don't contain. */
  avoid?: string[];
  /** The professor's name ("Professor Kapoor"), when it's known; else the setup says "the professor" or "they". */
  lecturer?: string;
}

export interface SetupLineReply {
  exampleLine: number;
  setup: string;
  sourceLines: number[];
}

export const SETUP_LINE_SCHEMA = {
  type: "object",
  properties: {
    exampleLine: { type: "integer" },
    setup: { type: "string" },
    sourceLines: { type: "array", items: { type: "integer" } },
  },
  required: ["exampleLine", "setup", "sourceLines"],
};

export function setupLinePrompt({ question, clipText, lines, avoid = [], lecturer }: SetupLineInput): string {
  const block = lines.map(({ id, seg }) => `#${id} [${formatTime(seg.start)}] ${seg.text}`).join("\n");
  const who = lecturer ? `${lecturer} (the professor), by name, or "they"` : `the professor, as "the professor" or "they"`;
  return `A student will hear this clip from a lecture, starting cold, because they missed this question:

${question}

The clip:
${clipText}

These are the lecture lines just before the clip, each with its line ID (#) and time:
${block}

1. exampleLine: the ID of the line where THIS specific problem or example begins (e.g. where the professor reads out or puts up the problem the clip is solving), not where the broader topic or section began. It's usually within a minute or two of the clip. If the clip already starts at the beginning of the problem, answer -1.
2. setup: one or two sentences, at most ${SETUP_MAX_WORDS} words, telling the student what is on screen and what the professor is in the middle of when the clip starts. Use only what these lines say, between exampleLine and the clip, and use their own words for things. Say what's on screen only if the professor says it (e.g. "let me open the Excel file"); never guess slides, code or a whiteboard. Don't add any fact, name or detail that isn't in them, and don't give away the answer. Use no numbers at all: describe what the professor is doing, not figures (they sometimes say a number and correct it a moment later). Write it about ${who}, never "he" or "she", in the present tense.
3. sourceLines: the IDs of the lines the setup is based on.${avoid.length ? `\n\nA previous attempt used words these lines don't contain (${avoid.join(", ")}). Rewrite without them.` : ""}`;
}
