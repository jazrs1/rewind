// An embedder that only reads the shared Gemini cache (the vectors the pipeline already paid for) and throws on a miss,
// so a demo script can rebuild the retrieve index at $0 and can never make a model call. Same keys as lib/gemini.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashKey } from "../../lib/cache.ts";
import { MODELS } from "../../lib/gemini.ts";
import type { Embedder } from "../../lib/pipeline/generate.ts";
import { defaultCacheDir } from "../../lib/spend.ts";

export function cachedEmbedder(cacheDir = defaultCacheDir("gemini")): Embedder & { hits: () => number } {
  let hits = 0;
  const embed = async (texts: string[], options: { taskType?: string; model?: string; dimensions?: number } = {}) =>
    texts.map((t) => {
      const key = hashKey(["embed", options.model ?? MODELS.embed, options.taskType ?? null, options.dimensions ?? null, t]);
      const path = join(cacheDir, "embed", `${key}.json`);
      if (!existsSync(path)) throw new Error(`No cached embedding for "${t.slice(0, 60)}…" (${options.taskType ?? "no task type"}): refusing to call the model`);
      hits++;
      return JSON.parse(readFileSync(path, "utf8")) as number[];
    });
  return Object.assign(embed as Embedder, { hits: () => hits });
}
