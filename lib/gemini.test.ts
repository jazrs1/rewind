import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGemini, type GeminiClient } from "./gemini";

function fakeClient() {
  const calls = { generate: 0, embed: 0, embedTexts: [] as string[] };
  const client = {
    models: {
      generateContent: async () => {
        calls.generate++;
        return { text: JSON.stringify({ n: calls.generate }), usageMetadata: { totalTokenCount: 7 } };
      },
      embedContent: async ({ contents }: { contents: { parts: { text: string }[] }[] }) => {
        calls.embed++;
        const texts = contents.map((c) => c.parts[0].text);
        calls.embedTexts.push(...texts);
        return { embeddings: texts.map((t) => ({ values: [t.length, 1] })) };
      },
      list: async () => [],
    },
  } as unknown as GeminiClient;
  return { client, calls };
}

describe("gemini cache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rewind-gemini-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("pays for the same generateJSON input once, even across instances", async () => {
    const { client, calls } = fakeClient();
    const a = createGemini({ client, cacheDir: dir });
    expect(await a.generateJSON("m", "hi", { type: "object" })).toEqual({ n: 1 });
    expect(await a.generateJSON("m", "hi", { type: "object" })).toEqual({ n: 1 });
    const b = createGemini({ client, cacheDir: dir });
    expect(await b.generateJSON("m", "hi", { type: "object" })).toEqual({ n: 1 });
    expect(calls.generate).toBe(1);
  });

  it("keys on model, prompt and schema", async () => {
    const { client, calls } = fakeClient();
    const g = createGemini({ client, cacheDir: dir });
    await g.generateJSON("m", "hi", { type: "object" });
    await g.generateJSON("m2", "hi", { type: "object" });
    await g.generateJSON("m", "hello", { type: "object" });
    await g.generateJSON("m", "hi", { type: "array" });
    expect(calls.generate).toBe(4);
  });

  it("shares one request between concurrent identical calls", async () => {
    const { client, calls } = fakeClient();
    const g = createGemini({ client, cacheDir: dir });
    await Promise.all([g.generateJSON("m", "x", {}), g.generateJSON("m", "x", {})]);
    expect(calls.generate).toBe(1);
  });

  it("embeds only texts not seen before and keeps input order", async () => {
    const { client, calls } = fakeClient();
    const g = createGemini({ client, cacheDir: dir });
    expect(await g.embed(["a", "bb"])).toEqual([[1, 1], [2, 1]]);
    expect(await g.embed(["ccc", "a", "ccc", "bb"])).toEqual([[3, 1], [1, 1], [3, 1], [2, 1]]);
    expect(calls.embedTexts).toEqual(["a", "bb", "ccc"]);
  });

  it("logs usage without content", async () => {
    const { client } = fakeClient();
    const g = createGemini({ client, cacheDir: dir });
    await g.generateJSON("m", "secret course text", {});
    const log = await readFile(join(dir, "usage.jsonl"), "utf8");
    expect(log).toContain('"totalTokenCount":7');
    expect(log).not.toContain("secret course text");
  });
});
