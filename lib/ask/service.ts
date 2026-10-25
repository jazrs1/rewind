// One model step of an Ask turn, shared by the dev route (/api/ask) and the demo route (/api/demo/ask): the request is
// checked and capped, the prompt built (lib/prompts/ask.ts), the model asked once, and its reply checked before any of
// it goes back: tool calls only from the list, at most MAX_CALLS_PER_ROUND, none after MAX_TOOL_ROUNDS; the answer
// capped, and each claim kept only when its quote is word for word in the passage it cites (the passages this turn's
// search results carried). The server stores nothing: no cache, no log of text.

import { askPrompt, ASK_SCHEMA, type AskInput, type AskReplyJSON } from "../prompts/ask.ts";
import { found } from "../tutor/claims.ts";
import { cleanCall } from "./tools.ts";
import { MAX_CALLS_PER_ROUND, MAX_TOOL_ROUNDS, type ToolCall, type ToolRound } from "./types.ts";

export type AskGenerate = (prompt: string, schema: object) => Promise<AskReplyJSON>;

export const MAX_MESSAGE = 500;
export const MAX_HISTORY = 8;
export const MAX_HISTORY_CHARS = 1200;
export const MAX_RESULT_CHARS = 5000;
export const MAX_ANSWER_CHARS = 1200;

export const ROUNDS_USED_UP = "I couldn't finish looking that up. Try asking about one course or one thing at a time.";
export const EMPTY_ANSWER = "I couldn't put an answer together just now. Try asking again.";

export type AskStep = { kind: "tools"; calls: ToolCall[] } | { kind: "answer"; text: string; claims: { quote: string; source: string }[] };

/** The signature an Ask reply carries (lib/tutor/sign.ts replySig, bound to the Ask tab and its kind). */
export const ASK_SIG_ID = "ask";
export const ASK_SIG_KIND = "answer";

/**
 * The request body, checked: anything the wrong shape is dropped, everything capped. Null when unusable. With
 * `replyOk` (the demo route's signer), an assistant turn counts as one only if its signature is valid, as in the
 * tutor's history (lib/tutor/history.ts); otherwise it is student text.
 */
export function cleanAskInput(raw: unknown, replyOk?: (q: string, kind: string, text: string, sig: unknown) => boolean): AskInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const message = typeof b.message === "string" ? b.message.trim().slice(0, MAX_MESSAGE) : "";
  if (!message) return null;
  const history = (Array.isArray(b.history) ? b.history : [])
    .filter((t): t is { role: string; text: string; sig?: unknown } => !!t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string")
    .filter((t) => t.role === "student" || t.role === "assistant")
    .slice(-MAX_HISTORY)
    .map((t) => {
      const text = t.text.slice(0, MAX_HISTORY_CHARS);
      if (t.role === "assistant" && (!replyOk || replyOk(ASK_SIG_ID, ASK_SIG_KIND, text, t.sig))) return { role: "assistant" as const, text };
      return { role: "student" as const, text };
    });
  const rounds: ToolRound[] = (Array.isArray(b.rounds) ? b.rounds : []).slice(0, MAX_TOOL_ROUNDS).flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const calls = (Array.isArray((r as ToolRound).calls) ? (r as ToolRound).calls : []).slice(0, MAX_CALLS_PER_ROUND).map(cleanCall);
    const results = Array.isArray((r as ToolRound).results) ? (r as ToolRound).results : [];
    if (!calls.length || calls.some((c) => !c)) return [];
    return [{ calls: calls as ToolCall[], results: calls.map((_, i) => (typeof results[i] === "string" ? (results[i] as string).slice(0, MAX_RESULT_CHARS) : "{}")) }];
  });
  const g = b.guide as { title?: unknown; code?: unknown } | null | undefined;
  const guide = g && typeof g.title === "string" && typeof g.code === "string" ? { title: g.title.slice(0, 120), code: g.code.slice(0, 20) } : null;
  // Open card ids: plain short strings only (the routes resolve them against their own question banks).
  const open = (Array.isArray(b.open) ? b.open : []).filter((x): x is string => typeof x === "string" && /^[\w.:-]{1,64}$/.test(x)).slice(0, 30);
  return { message, history, rounds, guide, open };
}

/** The passages this turn's search results carried, by id: what a claim may quote. */
export function passagesOf(rounds: ToolRound[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rounds)
    r.calls.forEach((c, i) => {
      if (c.tool !== "search_course") return;
      try {
        const parsed = JSON.parse(r.results[i]) as { passages?: { id?: unknown; text?: unknown }[] };
        for (const p of parsed.passages ?? []) if (typeof p.id === "string" && typeof p.text === "string") out.set(p.id, p.text);
      } catch {
        // A result that isn't JSON carries no passages.
      }
    });
  return out;
}

const MIN_WORDS = 5;
const MIN_CHARS = 20;

/** Claims whose quote is word for word in the passage they cite (and long enough to mean something). */
export function checkClaims(claims: unknown, passages: Map<string, string>): { quote: string; source: string }[] {
  if (!Array.isArray(claims)) return [];
  const out: { quote: string; source: string }[] = [];
  for (const c of claims.slice(0, 6)) {
    const quote = typeof c?.quote === "string" ? c.quote.trim() : "";
    const source = typeof c?.source === "string" ? c.source.trim() : "";
    if (quote.length < MIN_CHARS || quote.split(/\s+/).length < MIN_WORDS) continue;
    const text = passages.get(source);
    if (text && found(text, quote) && !out.some((o) => o.quote === quote)) out.push({ quote, source });
  }
  return out;
}

export async function askStep(input: AskInput, generate: AskGenerate): Promise<AskStep> {
  const reply = await generate(askPrompt(input), ASK_SCHEMA);
  const calls = (Array.isArray(reply?.tool_calls) ? reply.tool_calls : []).map(cleanCall).filter((c): c is ToolCall => !!c).slice(0, MAX_CALLS_PER_ROUND);
  const text = typeof reply?.text === "string" ? reply.text.trim().slice(0, MAX_ANSWER_CHARS) : "";
  if (calls.length) {
    if (input.rounds.length < MAX_TOOL_ROUNDS) return { kind: "tools", calls };
    return { kind: "answer", text: text || ROUNDS_USED_UP, claims: [] };
  }
  return { kind: "answer", text: text || EMPTY_ANSWER, claims: checkClaims(reply?.claims, passagesOf(input.rounds)) };
}
