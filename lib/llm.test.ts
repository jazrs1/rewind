import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeminiClient } from "./gemini";
import { type AnthropicClient, ClaudeBudgetError, CLAUDE_OPUS, costOf, createLLM, toClaudeSchema } from "./llm";

const OPUS = { provider: "anthropic", model: CLAUDE_OPUS } as const;
const FLASH = { provider: "gemini", model: "gemini-3.8-flash" } as const;

function fakeAnthropic(reply: (n: number) => string = (n) => JSON.stringify({ n })) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return {
            model: params.model,
            stop_reason: "end_turn",
            stop_details: null,
            content: [
              { type: "thinking", thinking: "", signature: "s" },
              { type: "text", text: reply(calls.length) },
            ],
            usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      },
    },
  } as unknown as AnthropicClient;
  return { client, calls };
}

function fakeGemini() {
  const calls = { generate: 0 };
  const client = {
    models: {
      generateContent: async () => {
        calls.generate++;
        return {
          text: JSON.stringify({ g: calls.generate }),
          usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 100, thoughtsTokenCount: 300 },
        };
      },
    },
  } as unknown as GeminiClient;
  return { client, calls };
}

describe("llm", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rewind-llm-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const make = (extra: Parameters<typeof createLLM>[0] = {}) =>
    // usagePath is explicit so a shared LLM_USAGE_LOG in the environment is never written by tests.
    createLLM({ cacheDir: join(dir, "llm"), usagePath: join(dir, "llm", "usage.jsonl"), geminiCacheDir: join(dir, "gemini"), ...extra });

  it("pays for the same Claude input once, even across instances", async () => {
    const { client, calls } = fakeAnthropic();
    expect(await make({ anthropic: client }).generateJSON(OPUS, "hi", { type: "object" })).toEqual({ n: 1 });
    expect(await make({ anthropic: client }).generateJSON(OPUS, "hi", { type: "object" })).toEqual({ n: 1 });
    expect(calls.length).toBe(1);
  });

  it("keys on provider, model, prompt, schema and options", async () => {
    const { client, calls } = fakeAnthropic();
    const llm = make({ anthropic: client });
    await llm.generateJSON(OPUS, "hi", { type: "object" });
    await llm.generateJSON({ provider: "anthropic", model: "claude-sonnet-5-5" }, "hi", { type: "object" });
    await llm.generateJSON(OPUS, "hello", { type: "object" });
    await llm.generateJSON(OPUS, "hi", { type: "array" });
    await llm.generateJSON(OPUS, "hi", { type: "object" }, { effort: "high" });
    expect(calls.length).toBe(5);
  });

  it("sends a strict schema, effort and fallback to Claude and parses the JSON", async () => {
    const { client, calls } = fakeAnthropic(() => '{"stem":"Q?","answer":"B"}');
    const out = await make({ anthropic: client }).generateJSON<{ stem: string; answer: string }>(OPUS, "p", {
      type: "object",
      properties: { stem: { type: "string", minLength: 3 }, answer: { type: "string" } },
      required: ["stem", "answer"],
    });
    expect(out).toEqual({ stem: "Q?", answer: "B" });
    const params = calls[0] as { output_config: { effort: string; format: { schema: Record<string, unknown> } }; fallbacks: string; temperature?: number };
    expect(params.output_config.effort).toBe("medium");
    expect(params.output_config.format.schema.additionalProperties).toBe(false);
    expect((params.output_config.format.schema.properties as Record<string, object>).stem).toEqual({ type: "string" });
    expect(params.fallbacks).toBe("default");
    expect(params.temperature).toBeUndefined();
  });

  it("returns text from text blocks only", async () => {
    const { client } = fakeAnthropic(() => "plain answer");
    expect(await make({ anthropic: client }).generateText(OPUS, "p")).toBe("plain answer");
  });

  it("throws on JSON Claude did not close", async () => {
    const { client } = fakeAnthropic(() => '{"stem": "cut off');
    await expect(make({ anthropic: client }).generateJSON(OPUS, "p", { type: "object" })).rejects.toThrow();
  });

  it("logs Claude usage and cost without content", async () => {
    const { client } = fakeAnthropic();
    const llm = make({ anthropic: client });
    await llm.generateJSON(OPUS, "secret course text", { type: "object" }, { system: "secret system" });
    const log = await readFile(join(dir, "llm", "usage.jsonl"), "utf8");
    expect(log).not.toContain("secret");
    const [rec] = await llm.readUsage();
    expect(rec).toMatchObject({ provider: "anthropic", model: CLAUDE_OPUS, inputTokens: 1000, outputTokens: 500 });
    expect(rec.costUsd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6);
  });

  it("routes Gemini through lib/gemini.ts, caches it and logs usage without content", async () => {
    const { client, calls } = fakeGemini();
    const llm = make({ geminiClient: client });
    expect(await llm.generateJSON(FLASH, "secret course text", { type: "object" })).toEqual({ g: 1 });
    expect(await llm.generateJSON(FLASH, "secret course text", { type: "object" })).toEqual({ g: 1 });
    expect(calls.generate).toBe(1);
    const log = await readFile(join(dir, "llm", "usage.jsonl"), "utf8");
    expect(log).not.toContain("secret");
    const [rec] = await llm.readUsage();
    expect(rec).toMatchObject({ provider: "gemini", inputTokens: 2000, outputTokens: 400 });
    expect(rec.costUsd).toBeCloseTo((2000 * 0.75 + 400 * 3.75) / 1e6);
    // lib/gemini.ts keeps its own log too.
    expect(await readFile(join(dir, "gemini", "usage.jsonl"), "utf8")).not.toContain("secret");
  });

  it("refuses Claude calls once logged Claude cost passes the budget", async () => {
    const { client, calls } = fakeAnthropic();
    await mkdir(join(dir, "llm"), { recursive: true });
    const line = { provider: "anthropic", model: CLAUDE_OPUS, costUsd: 0.6 };
    await appendFile(join(dir, "llm", "usage.jsonl"), JSON.stringify(line) + "\n" + JSON.stringify({ ...line, provider: "gemini", costUsd: 5 }) + "\n");
    const llm = make({ anthropic: client, claudeBudgetUsd: 0.5 });
    await expect(llm.generateText(OPUS, "p")).rejects.toThrow(ClaudeBudgetError);
    expect(calls.length).toBe(0);
    // Gemini spend doesn't count toward the Claude budget.
    expect(await llm.claudeSpent()).toBeCloseTo(0.6);
  });

  it("logs to LLM_USAGE_LOG when set, so spend across worktrees adds up", async () => {
    const shared = join(dir, "shared", "usage.jsonl");
    const before = process.env.LLM_USAGE_LOG;
    process.env.LLM_USAGE_LOG = shared;
    try {
      const { client } = fakeAnthropic();
      const llm = createLLM({ anthropic: client, cacheDir: join(dir, "llm") });
      expect(llm.usagePath).toBe(shared);
      await llm.generateText(OPUS, "p");
      expect(await readFile(shared, "utf8")).toContain(CLAUDE_OPUS);
      // A second instance (another worktree) sees the same spend.
      expect(await createLLM({ cacheDir: join(dir, "other") }).claudeSpent()).toBeGreaterThan(0);
    } finally {
      if (before === undefined) delete process.env.LLM_USAGE_LOG;
      else process.env.LLM_USAGE_LOG = before;
    }
  });

  it("prices cache reads and unknown models", () => {
    expect(costOf(CLAUDE_OPUS, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6, cacheWriteTokens: 0 })).toBeCloseTo(0.2);
    expect(costOf("mystery", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  it("makes nested objects strict for Claude", () => {
    expect(toClaudeSchema({ type: "object", properties: { c: { type: "object", properties: { A: { type: "string" } } } } })).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { c: { type: "object", additionalProperties: false, properties: { A: { type: "string" } } } },
    });
  });
});
