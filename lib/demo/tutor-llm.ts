// The one place the deployed demo calls a model: the live tutor (app/api/demo/tutor/route.ts), Claude Sonnet, with
// the key in the server variable REWIND_DEMO_ANTHROPIC_API_KEY and nothing else. It is a separate key ("rewind-demo",
// a $10 Console limit), so the main key is never in the deployed environment and this code never reads it.
//
// Why not lib/llm.ts: that module keeps a disk cache and usage log (the deployed filesystem is read-only, and a cache
// would store students' messages and replies) and reads ANTHROPIC_API_KEY. This wrapper keeps nothing: no cache, no
// log, no retries, a seven-second timeout, 500 output tokens, no server-side fallback to a dearer model.

import Anthropic from "@anthropic-ai/sdk";
import type { TutorReplyJSON } from "../prompts/tutor.ts";
import { PRICES } from "../spend.ts";

export const DEMO_KEY_VAR = "REWIND_DEMO_ANTHROPIC_API_KEY";
export const DEMO_MODEL = "claude-sonnet-5-5";
export const DEMO_MAX_TOKENS = 500;
/** A similar question (a stem, four choices, maybe code, a quote) needs more room than a tutor turn. */
export const DEMO_SIMILAR_MAX_TOKENS = 800;
export const DEMO_TIMEOUT_MS = 7000;

type Env = Record<string, string | undefined>;

/** The demo key, or null when it isn't set (then the route answers from the saved replies). Reads only DEMO_KEY_VAR. */
export function demoKey(env: Env = process.env): string | null {
  const k = env[DEMO_KEY_VAR];
  return typeof k === "string" && k.trim().length >= 8 ? k.trim() : null;
}

export interface ModelResult {
  reply: TutorReplyJSON;
  inputTokens: number;
  outputTokens: number;
}
export type DemoModel = (prompt: string, schema: object, opts?: { maxTokens?: number }) => Promise<ModelResult>;

/** Claude's structured outputs want additionalProperties: false on every object. */
function strict(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strict);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, strict(pv)])) : strict(v);
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

/** Worst-case cost of a call in millionths of a dollar, from its input size and the output cap. */
export function estimateMicro(inputChars: number, maxTokens = DEMO_MAX_TOKENS): number {
  const p = PRICES[DEMO_MODEL];
  // One token per 3 characters, billed at the input price; every output token billed at the output price.
  return Math.ceil(((inputChars / 3) * p.input + maxTokens * p.output));
}

export function actualMicro(inputTokens: number, outputTokens: number): number {
  const p = PRICES[DEMO_MODEL];
  return Math.ceil(inputTokens * p.input + outputTokens * p.output);
}

/** The model call, with an explicit key: the SDK's own environment defaults (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL) are all overridden. */
export function createDemoModel(key: string, Ctor: typeof Anthropic = Anthropic): DemoModel {
  const client = new Ctor({ apiKey: key, authToken: null, baseURL: "https://api.anthropic.com", maxRetries: 0, timeout: DEMO_TIMEOUT_MS });
  return async (prompt, schema, opts = {}) => {
    const res = await client.beta.messages.create({
      model: DEMO_MODEL,
      max_tokens: opts.maxTokens ?? DEMO_MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort: "low", format: { type: "json_schema", schema: strict(schema) as Record<string, unknown> } },
    });
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") throw new Error(res.stop_reason);
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const reply = JSON.parse(text) as TutorReplyJSON;
    return { reply, inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 };
  };
}
