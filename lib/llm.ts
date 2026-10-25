// Provider-neutral text and JSON generation for Anthropic (Claude) and Gemini.
// Same disk cache idea as lib/gemini.ts: every call is keyed by a hash of
// provider + model + input + options and cached in <shared cache>/llm/ (the main checkout's
// .cache, shared by every worktree; see lib/spend.ts), so the same input is never paid for twice.
// Every paid call appends tokens and cost (never content) to the usage log: $LLM_USAGE_LOG,
// else <shared cache>/llm/usage.jsonl. Gemini calls go through lib/gemini.ts (its own cap).
// Before each Claude call its worst-case cost is reserved under a lock; the call is refused if
// logged Claude cost + calls in flight + it would pass CLAUDE_BUDGET_USD.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createDiskCache, hashKey } from "./cache.ts";
import { assertNotDemo } from "./demo/guard.ts";
import { createGemini, type GeminiClient, MODELS } from "./gemini.ts";
import { costOf, createLedger, defaultCacheDir, geminiTokens, PRICES, type Price } from "./spend.ts";

export { costOf, PRICES, type Price, SpendCapError, SpendCapError as ClaudeBudgetError } from "./spend.ts";

export type Provider = "anthropic" | "gemini";

export interface ModelRef {
  provider: Provider;
  model: string;
}

/** Claude model IDs (from the claude-api skill, 2026-10). */
export const CLAUDE_OPUS = "claude-opus-5-5";
export const CLAUDE_SONNET = "claude-sonnet-5-5";

/** Which model does which job (John's decision after the blind A/B, Oct 23; see docs/BRIEF.md). */
export const LLM_MODELS = {
  questions: { provider: "anthropic", model: CLAUDE_OPUS },
  answerCheck: { provider: "anthropic", model: CLAUDE_OPUS },
  tutor: { provider: "anthropic", model: CLAUDE_SONNET },
  // Interim (Oct 23, pending John): Sonnet's setup lines failed the strict grounding check 4/4
  // in T18's run; Gemini Flash passed 4/5 in the spike. Switch back to CLAUDE_SONNET if John prefers.
  setupLines: { provider: "gemini", model: MODELS.flash },
  geminiFlash: { provider: "gemini", model: MODELS.flash },
} as const satisfies Record<string, ModelRef>;

/** Refuse a Claude call once logged Claude cost + calls in flight + its worst case would pass this. */
export const CLAUDE_BUDGET_USD = 40;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LLMOptions {
  system?: string;
  /** Claude only. Default 16000. */
  maxTokens?: number;
  /** Claude only. Default "medium" (Opus 5.5's default, set explicitly). */
  effort?: Effort;
  /** false: no disk cache for this call (its prompt carries the student's course text: the Ask tab stores nothing). */
  cache?: boolean;
}

export interface UsageRecord {
  at: string;
  provider: Provider;
  /** Model requested. */
  model: string;
  /** Model that answered, when the provider says (differs after a Claude fallback). */
  servedModel: string | null;
  kind: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null when the model has no price in PRICES. */
  costUsd: number | null;
}

/** Claude's safety classifiers declined the request (stop_reason "refusal"), even after fallback. */
export class ClaudeRefusalError extends Error {
  readonly category: string | null;
  constructor(model: string, category: string | null) {
    super(`Claude ${model} declined (${category ?? "no category"})`);
    this.category = category;
    this.name = "ClaudeRefusalError";
  }
}

/** The slice of the Anthropic SDK we use, so tests can pass a fake. */
export interface AnthropicClient {
  beta: { messages: Pick<Anthropic["beta"]["messages"], "create"> };
}

/**
 * Claude structured outputs need additionalProperties: false on every object and reject
 * numeric and string-length constraints. Gemini takes the schema as written.
 */
export function toClaudeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toClaudeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength"].includes(k)) continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toClaudeSchema(pv)])) : toClaudeSchema(v);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

/** The dearest Claude price (server-side fallback can bill a call at another model's price). */
const CLAUDE_WORST_PRICE: Price = Object.entries(PRICES)
  .filter(([m]) => m.startsWith("claude-"))
  .map(([, p]) => p)
  .reduce((a, p) => ({
    input: Math.max(a.input, p.input),
    output: Math.max(a.output, p.output),
    cacheRead: Math.max(a.cacheRead, p.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, p.cacheWrite),
  }));

/** A Claude call's worst case: one input token per character (at the cache-write price) and every output token. */
export function claudeWorstCost(inputChars: number, maxTokens: number): number {
  return (inputChars * Math.max(CLAUDE_WORST_PRICE.input, CLAUDE_WORST_PRICE.cacheWrite) + maxTokens * CLAUDE_WORST_PRICE.output) / 1e6;
}

export function createLLM(
  opts: {
    anthropic?: AnthropicClient;
    geminiClient?: GeminiClient;
    /** Default: <shared cache root>/llm. */
    cacheDir?: string;
    /** Usage log. Default: $LLM_USAGE_LOG, else <cacheDir>/usage.jsonl. */
    usagePath?: string;
    /** Default: <shared cache root>/gemini. */
    geminiCacheDir?: string;
    /** Gemini's own usage log, where its cap is counted. Default: see lib/gemini.ts. */
    geminiUsagePath?: string;
    claudeBudgetUsd?: number;
    geminiBudgetUsd?: number;
  } = {},
) {
  const cacheDir = opts.cacheDir ?? defaultCacheDir("llm");
  const usagePath = resolve(opts.usagePath ?? (process.env.LLM_USAGE_LOG || join(cacheDir, "usage.jsonl")));
  const ledger = createLedger({
    provider: "Claude",
    usagePath,
    capUsd: opts.claudeBudgetUsd ?? CLAUDE_BUDGET_USD,
    costOfLine: (r) => (r.provider === "anthropic" && typeof r.costUsd === "number" ? r.costUsd : 0),
    how: "Raise CLAUDE_BUDGET_USD in lib/llm.ts only if John agrees.",
  });
  const { cached } = createDiskCache(cacheDir);
  let anthropic = opts.anthropic;

  const usageLine = (rec: Omit<UsageRecord, "at" | "costUsd">): UsageRecord => ({
    at: new Date().toISOString(),
    ...rec,
    costUsd: costOf(rec.servedModel ?? rec.model, rec),
  });

  async function logUsage(rec: Omit<UsageRecord, "at" | "costUsd">) {
    await mkdir(dirname(usagePath), { recursive: true });
    await appendFile(usagePath, JSON.stringify(usageLine(rec)) + "\n");
  }

  const gemini = createGemini({
    client: opts.geminiClient,
    cacheDir: opts.geminiCacheDir,
    usagePath: opts.geminiUsagePath,
    budgetUsd: opts.geminiBudgetUsd,
    onUsage: (kind, model, usage) => logUsage({ provider: "gemini", model, servedModel: model, kind, ...geminiTokens(usage) }),
  });

  function getAnthropic(): AnthropicClient {
    if (anthropic) return anthropic;
    assertNotDemo("Calling Claude");
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set. Put it in .env.local.");
    anthropic = new Anthropic();
    return anthropic;
  }

  /** Every usage line logged so far. */
  async function readUsage(): Promise<UsageRecord[]> {
    let src: string;
    try {
      src = await readFile(usagePath, "utf8");
    } catch {
      return [];
    }
    return src
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as UsageRecord);
  }

  /** Logged Claude cost (calls in flight not included). */
  const claudeSpent = () => ledger.spent();

  async function callClaude(kind: string, model: string, prompt: string, schema: object | null, options: LLMOptions): Promise<string> {
    const maxTokens = options.maxTokens ?? 16000;
    const inputChars = prompt.length + (options.system?.length ?? 0) + (schema ? JSON.stringify(schema).length : 0);
    const client = getAnthropic();
    const res = await ledger.guarded(
      claudeWorstCost(inputChars, maxTokens),
      () =>
        client.beta.messages.create({
          model,
          max_tokens: maxTokens,
          // Server-side fallback (claude-api skill default): a safety decline is retried on
          // Anthropic's recommended model instead of coming back empty. servedModel records it.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          ...(options.system ? { system: options.system } : {}),
          messages: [{ role: "user", content: prompt }],
          output_config: {
            effort: options.effort ?? "medium",
            ...(schema ? { format: { type: "json_schema", schema: toClaudeSchema(schema) as Record<string, unknown> } } : {}),
          },
        }),
      (r) =>
        usageLine({
          provider: "anthropic",
          model,
          servedModel: r.model ?? null,
          kind,
          inputTokens: r.usage.input_tokens ?? 0,
          outputTokens: r.usage.output_tokens ?? 0,
          cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0,
        }),
    );
    if (res.stop_reason === "refusal") throw new ClaudeRefusalError(model, res.stop_details?.category ?? null);
    if (res.stop_reason === "max_tokens") throw new Error(`Claude ${model} hit max_tokens; raise options.maxTokens`);
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text) throw new Error(`Claude ${model} returned no text`);
    return text;
  }

  /** Generates plain text. */
  async function generateText(ref: ModelRef, prompt: string, options: LLMOptions = {}): Promise<string> {
    const key = hashKey(["generateText", ref.provider, ref.model, prompt, options]);
    return cached<string>("text", key, () =>
      ref.provider === "anthropic"
        ? callClaude("text", ref.model, prompt, null, options)
        : gemini.generateText(ref.model, prompt, { system: options.system }),
    );
  }

  /** Generates JSON matching `schema` (a JSON Schema object). */
  async function generateJSON<T>(ref: ModelRef, prompt: string, schema: object, options: LLMOptions = {}): Promise<T> {
    const run = async () =>
      ref.provider === "anthropic"
        ? (JSON.parse(await callClaude("json", ref.model, prompt, schema, options)) as T)
        : gemini.generateJSON<T>(ref.model, prompt, schema, { system: options.system });
    if (options.cache === false) return run();
    const key = hashKey(["generateJSON", ref.provider, ref.model, prompt, schema, options]);
    return cached<T>("json", key, run);
  }

  return { generateText, generateJSON, readUsage, claudeSpent, geminiSpent: gemini.geminiSpent, usagePath, geminiUsagePath: gemini.usagePath };
}

let defaultInstance: ReturnType<typeof createLLM> | null = null;
function llm() {
  return (defaultInstance ??= createLLM());
}

export const generateText = (ref: ModelRef, prompt: string, options?: LLMOptions) => llm().generateText(ref, prompt, options);
export const generateJSON = <T>(ref: ModelRef, prompt: string, schema: object, options?: LLMOptions) =>
  llm().generateJSON<T>(ref, prompt, schema, options);
export const readUsage = () => llm().readUsage();
export const claudeSpent = () => llm().claudeSpent();
