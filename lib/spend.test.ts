import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGemini, type GeminiClient } from "./gemini";
import { type AnthropicClient, ClaudeBudgetError, claudeWorstCost, createLLM } from "./llm";
import { createLedger, defaultCacheDir, sharedCacheRoot, SpendCapError } from "./spend";

const OPUS = { provider: "anthropic", model: "claude-opus-5-5" } as const;

/**
 * A Claude fake whose calls wait until `release()`, so no call can finish (and free its hold) before the others
 * reserve. `onCall` runs each time a call reaches it.
 */
function slowAnthropic(onCall: () => void = () => {}) {
  const calls: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const client = {
    beta: {
      messages: {
        create: async (params: unknown) => {
          calls.push(params);
          onCall();
          await gate;
          return {
            model: "claude-opus-5-5",
            stop_reason: "end_turn",
            stop_details: null,
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      },
    },
  } as unknown as AnthropicClient;
  return { client, calls, release };
}

function fakeGemini() {
  const calls = { generate: 0 };
  const client = {
    models: {
      generateContent: async () => {
        calls.generate++;
        return { text: "ok", usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 100, thoughtsTokenCount: 300 } };
      },
    },
  } as unknown as GeminiClient;
  return { client, calls };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

describe("spend caps", () => {
  let dir: string;
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), "rewind-spend-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A main checkout with one commit and a worker worktree beside it. */
  function repoWithWorktree() {
    const main = join(dir, "main");
    const wt = join(dir, "worker");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", wt);
    return { main, wt };
  }

  it("resolves the default cache and usage logs to the main checkout's .cache from every worktree", () => {
    const { main, wt } = repoWithWorktree();
    expect(sharedCacheRoot({ cwd: main, env: {} })).toBe(join(main, ".cache"));
    expect(sharedCacheRoot({ cwd: wt, env: {} })).toBe(join(main, ".cache"));
    expect(defaultCacheDir("llm", { cwd: wt, env: {} })).toBe(defaultCacheDir("llm", { cwd: main, env: {} }));
    // An override wins; a root inside private/ is refused.
    expect(sharedCacheRoot({ cwd: wt, env: { REWIND_CACHE_DIR: join(dir, "elsewhere") } })).toBe(join(dir, "elsewhere"));
    expect(() => sharedCacheRoot({ cwd: wt, env: { REWIND_CACHE_DIR: join(main, "private", "cache") } })).toThrow(/private/);
    expect(() => sharedCacheRoot({ cwd: wt, env: { REWIND_CACHE_DIR: join(dir, "p", "c"), REWIND_PRIVATE_ROOT: join(dir, "p") } })).toThrow(/private/);
  });

  it("shares the Gemini cache between worktrees, so the same input is paid for once", async () => {
    const { main, wt } = repoWithWorktree();
    const { client, calls } = fakeGemini();
    await createGemini({ client, cacheDir: defaultCacheDir("gemini", { cwd: main, env: {} }) }).generateText("gemini-3.8-flash", "hi");
    const fromWorker = createGemini({ client, cacheDir: defaultCacheDir("gemini", { cwd: wt, env: {} }) });
    expect(await fromWorker.generateText("gemini-3.8-flash", "hi")).toBe("ok");
    expect(calls.generate).toBe(1);
    expect(fromWorker.usagePath).toBe(join(main, ".cache", "gemini", "usage.jsonl"));
  });

  it("concurrent reservations can't pass the cap together", async () => {
    const usagePath = join(dir, "usage.jsonl");
    const ledger = createLedger({ provider: "Test", usagePath, capUsd: 1, costOfLine: (l) => Number(l.costUsd ?? 0), how: "" });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => ledger.reserve(0.3)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof SpendCapError)).toBe(true);
    // Settling swaps a hold for the actual cost, freeing the rest of it.
    const holds = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    await Promise.all(holds.map((h) => h.settle({ costUsd: 0.1 })));
    expect(await ledger.spent()).toBeCloseTo(0.3);
    await expect(ledger.reserve(0.7)).resolves.toBeTruthy();
    await expect(ledger.reserve(0.01)).rejects.toThrow(SpendCapError);
  });

  it("concurrent Claude calls stop at the cap, and a finished call releases its hold", async () => {
    // The admitted calls finish only once every call has been decided (reached the model, or refused), so a
    // finished call can never free its hold for one still waiting. No timer: under load the refusals can take
    // longer than any fixed wait (a 2 s fallback let a third call in).
    let refused = 0;
    let reached = 0;
    const decided = () => reached + refused === 5 && release();
    const { client, calls, release } = slowAnthropic(() => {
      reached++;
      decided();
    });
    const worst = claudeWorstCost(2, 1000);
    const llm = createLLM({ anthropic: client, cacheDir: join(dir, "llm"), usagePath: join(dir, "usage.jsonl"), claudeBudgetUsd: worst * 2.5 });
    const pending = ["p1", "p2", "p3", "p4", "p5"].map((p) => llm.generateText(OPUS, p, { maxTokens: 1000 }));
    for (const p of pending)
      p.catch(() => {
        refused++;
        decided();
      });
    const results = await Promise.allSettled(pending);
    expect(calls).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof ClaudeBudgetError)).toBe(true);
    // The two calls logged their actual cost ($0.014 each), well under their holds, so more fit now.
    expect(await llm.claudeSpent()).toBeCloseTo(2 * (1000 * 4 + 500 * 20) / 1e6);
    expect(await llm.generateText(OPUS, "p6", { maxTokens: 1000 })).toBe("ok");
  });

  it("drops the hold when the call fails", async () => {
    const usagePath = join(dir, "usage.jsonl");
    const ledger = createLedger({ provider: "Test", usagePath, capUsd: 1, costOfLine: (l) => Number(l.costUsd ?? 0), how: "" });
    await expect(ledger.guarded(0.9, () => Promise.reject(new Error("boom")), () => ({ costUsd: 0.9 }))).rejects.toThrow("boom");
    await expect(ledger.reserve(0.9)).resolves.toBeTruthy();
  });

  it("blocks Gemini calls at the Gemini cap, counting old log lines, and says which cap and the total", async () => {
    const cacheDir = join(dir, "gemini");
    await mkdir(cacheDir, { recursive: true });
    // A line from before costUsd: priced from its tokens (1M input tokens of Flash = $0.75).
    await writeFile(join(cacheDir, "usage.jsonl"), JSON.stringify({ kind: "generate", model: "gemini-3.8-flash", usage: { promptTokenCount: 1e6 } }) + "\n");
    const { client, calls } = fakeGemini();
    const g = createGemini({ client, cacheDir, budgetUsd: 0.8 });
    expect(await g.geminiSpent()).toBeCloseTo(0.75);
    const err = await g.generateText("gemini-3.8-flash", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendCapError);
    expect((err as Error).message).toMatch(/^Gemini spend cap hit: \$0\.75 of \$0\.8 used/);
    expect(calls.generate).toBe(0);
  });

  it("logs each Gemini call's cost and reads the cap from GEMINI_BUDGET_USD", async () => {
    const cacheDir = join(dir, "gemini");
    const { client } = fakeGemini();
    await createGemini({ client, cacheDir }).generateText("gemini-3.8-flash", "hi");
    const [line] = (await readFile(join(cacheDir, "usage.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(line.costUsd).toBeCloseTo((2000 * 0.75 + 400 * 3.75) / 1e6);
    process.env.GEMINI_BUDGET_USD = "0.001";
    try {
      await expect(createGemini({ client, cacheDir }).generateText("gemini-3.8-flash", "new")).rejects.toThrow(/Gemini spend cap hit.*of \$0\.001/);
    } finally {
      delete process.env.GEMINI_BUDGET_USD;
    }
  });
});
