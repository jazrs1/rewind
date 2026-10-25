// The demo's saved replies for its example prompts: public/demo/course/ask.json (in the bundle, the one place real
// lecture text may be committed: its claims quote the lecture). When the live assistant is capped, slow, erroring or
// has no key, the page plays one, labelled "Saved reply". Only the words are saved: the tool calls run on the page as a
// live turn's would (so the cards are the same cards) and the claims are checked against what they return
// (lib/ask/ask.test.ts proves every quote is found). A guide-mode turn gets SAVED_GUIDE; any other prompt SAVED_OTHER.

import { cleanCall } from "./tools.ts";
import type { ToolCall } from "./types.ts";

export const ASK_SAVED_FORMAT = "rewind-demo-ask/1";
export const ASK_SAVED_FILE = "ask.json";

export interface SavedAsk {
  prompt: string;
  calls: ToolCall[];
  text: string;
  claims: { quote: string }[];
}

/** The examples in a saved file; anything the wrong shape is left out. */
export function parseSaved(raw: unknown): SavedAsk[] {
  const f = raw as { format?: unknown; examples?: unknown } | null;
  if (!f || f.format !== ASK_SAVED_FORMAT || !Array.isArray(f.examples)) return [];
  return f.examples.flatMap((e: Partial<SavedAsk>) => {
    if (!e || typeof e.prompt !== "string" || typeof e.text !== "string" || !Array.isArray(e.calls)) return [];
    const calls = e.calls.map(cleanCall);
    if (calls.some((c) => !c)) return [];
    const claims = (Array.isArray(e.claims) ? e.claims : []).filter((c): c is { quote: string } => typeof c?.quote === "string");
    return [{ prompt: e.prompt, calls: calls as ToolCall[], text: e.text, claims }];
  });
}

/** Graded work (a quiz or exam row, or a message naming one): the saved reply guides and never solves. */
export const SAVED_GUIDE =
  "This is graded work, so I won't give answers or solve problems, but I'll guide you through the ideas. Which question or topic are you stuck on? Tell me what you've tried.";

export const SAVED_OTHER = "The live assistant is busy right now, so here's what I can do from saved replies: try one of the examples below.";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function savedFor(message: string, saved: SavedAsk[]): SavedAsk | null {
  return saved.find((e) => norm(e.prompt) === norm(message)) ?? null;
}
