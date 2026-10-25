// The only place that calls Gemini. Every paid call is keyed by a hash of
// model + input and cached on disk in <shared cache>/gemini/ (the main checkout's .cache, so
// every worktree shares it; see lib/spend.ts), so the same input is never paid for twice.
// Uncached calls append token usage and cost (never content) to <cache>/gemini/usage.jsonl
// ($GEMINI_USAGE_LOG overrides). Before each paid call its worst-case cost is reserved against
// the Gemini cap ($GEMINI_BUDGET_USD, default GEMINI_BUDGET_USD).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { GoogleGenAI, type Part } from "@google/genai";
import { createDiskCache, hashKey } from "./cache.ts";
import { assertNotDemo } from "./demo/guard.ts";
import { createLedger, defaultCacheDir, GEMINI_FALLBACK_PRICE, geminiTokens, PRICES, priceWith } from "./spend.ts";

export { hashKey };

/** Model IDs confirmed on our key by scripts/spike/models.ts (see docs/BRIEF.md). */
export const MODELS = {
  flash: "gemini-3.8-flash",
  flashLite: "gemini-3.5-flash-lite",
  embed: "gemini-embedding-2",
  transcribe: "gemini-3.5-transcribe",
} as const;

export type Prompt = string | Part[];

export interface GenerateOptions {
  system?: string;
  temperature?: number;
}

export interface EmbedOptions {
  model?: string;
  /** e.g. RETRIEVAL_QUERY, RETRIEVAL_DOCUMENT, SEMANTIC_SIMILARITY */
  taskType?: string;
  dimensions?: number;
}

export interface ModelInfo {
  name: string;
  displayName: string | null;
  supportedActions: string[];
  inputTokenLimit: number | null;
}

export interface TranscribedWord {
  word: string;
  start: number;
  end: number;
}

export interface Transcription {
  text: string;
  /** Times in seconds from the start of the audio file. */
  words: TranscribedWord[];
  /** Speaker turns, when diarization is on. */
  turns: { speaker: string | null; start: number | null; end: number | null; text: string }[];
}

const AUDIO_TYPES: Record<string, string> = {
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".mp3": "audio/mp3",
  ".m4a": "audio/aac",
  // What browsers record: Chrome's MediaRecorder writes webm/opus, iPhone Safari writes mp4/aac.
  ".webm": "audio/webm",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".aiff": "audio/aiff",
};
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

/** "12.340s" → 12.34 */
function seconds(offset: string | undefined): number | null {
  if (!offset) return null;
  const n = parseFloat(offset);
  return Number.isFinite(n) ? n : null;
}

/** The slice of the SDK we use, so tests can pass a fake. */
export interface GeminiClient {
  models: Pick<GoogleGenAI["models"], "generateContent" | "embedContent" | "list">;
}

const EMBED_BATCH = 100;
const RETRIES = 4;

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 500 || status === 503) return true;
  // Network blips (e.g. "fetch failed" mid-run on Oct 13) have no status; retry those too.
  return status === undefined && /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String((err as Error)?.message ?? err));
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRIES - 1 || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** Refuse further Gemini calls once logged Gemini cost + calls in flight would pass this ($GEMINI_BUDGET_USD overrides). */
export const GEMINI_BUDGET_USD = 20;

/** The most a generate call can write (Gemini 3.x output limit); a call's reservation assumes it. */
const MAX_OUTPUT_TOKENS = 65536;

const priceOf = (model: string) => PRICES[model] ?? GEMINI_FALLBACK_PRICE;

/** An upper bound on a prompt's input tokens: one per character of text, and inline data at one per 64 bytes. */
function inputTokenBound(prompt: Prompt, system?: string): number {
  const parts = typeof prompt === "string" ? [{ text: prompt } as Part] : prompt;
  const n = parts.reduce((t, p) => t + (p.text?.length ?? 0) + Math.ceil(((p.inlineData?.data?.length ?? 0) * 3) / 4 / 64), 0);
  return n + (system?.length ?? 0);
}

/** Embedding responses carry no token count: about 4 characters per token, at the input price. */
const embedCost = (model: string, chars: number) => (Math.ceil(chars / 4) * priceOf(model).input) / 1e6;

/** What a line of the Gemini usage log cost (lines from before costUsd are priced from their usage). */
export function geminiLineCost(line: Record<string, unknown>): number {
  if (typeof line.costUsd === "number") return line.costUsd;
  const model = String(line.model ?? "");
  const u = line.usage as Record<string, number> | null | undefined;
  if (!u) return 0;
  if (line.kind === "embed") return embedCost(model, u.chars ?? 0);
  return priceWith(priceOf(model), geminiTokens(u));
}

/** The Gemini usage log: $GEMINI_USAGE_LOG, else <cacheDir>/usage.jsonl (default: the shared cache). */
export const geminiUsagePath = (cacheDir = defaultCacheDir("gemini")) => resolve(process.env.GEMINI_USAGE_LOG || join(cacheDir, "usage.jsonl"));

/** Called after every paid (uncached) call with its token usage; lib/llm.ts uses it to price calls. */
export type UsageHook = (kind: string, model: string, usage: unknown) => void | Promise<void>;

export function createGemini(
  opts: {
    client?: GeminiClient;
    /** Default: <shared cache root>/gemini. */
    cacheDir?: string;
    /** Default: $GEMINI_USAGE_LOG, else <cacheDir>/usage.jsonl. */
    usagePath?: string;
    /** Default: $GEMINI_BUDGET_USD, else GEMINI_BUDGET_USD. */
    budgetUsd?: number;
    onUsage?: UsageHook;
  } = {},
) {
  const cacheDir = opts.cacheDir ?? defaultCacheDir("gemini");
  const usagePath = opts.usagePath ? resolve(opts.usagePath) : geminiUsagePath(cacheDir);
  const envBudget = Number(process.env.GEMINI_BUDGET_USD);
  const ledger = createLedger({
    provider: "Gemini",
    usagePath,
    capUsd: opts.budgetUsd ?? (process.env.GEMINI_BUDGET_USD && Number.isFinite(envBudget) ? envBudget : GEMINI_BUDGET_USD),
    costOfLine: geminiLineCost,
    how: "Raise GEMINI_BUDGET_USD only if John agrees.",
  });
  let client = opts.client;
  const { read, store, cached } = createDiskCache(cacheDir);

  function getClient(): GeminiClient {
    if (client) return client;
    assertNotDemo("Calling Gemini");
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Put it in .env.local.");
    client = new GoogleGenAI({ apiKey });
    return client;
  }

  const usageLine = (kind: string, model: string, usage: unknown, costUsd: number) => ({ at: new Date().toISOString(), kind, model, usage: usage ?? null, costUsd });

  /** One paid generateContent call: reserves its worst case, then logs its actual cost. */
  async function paidGenerate(kind: string, model: string, worstInputTokens: number, call: () => ReturnType<GeminiClient["models"]["generateContent"]>) {
    const worst = priceWith(priceOf(model), { inputTokens: worstInputTokens, outputTokens: MAX_OUTPUT_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const res = await ledger.guarded(worst, () => withRetry(call), (r) =>
      usageLine(kind, model, r.usageMetadata, priceWith(priceOf(model), geminiTokens(r.usageMetadata))),
    );
    await opts.onUsage?.(kind, model, res.usageMetadata);
    return res;
  }

  /** Generates JSON matching `schema` (a JSON Schema object). */
  async function generateJSON<T>(
    model: string,
    prompt: Prompt,
    schema: object,
    options: GenerateOptions = {},
  ): Promise<T> {
    const key = hashKey(["generateJSON", model, prompt, schema, options]);
    return cached<T>("generate", key, async () => {
      const res = await paidGenerate("generate", model, inputTokenBound(prompt, options.system) + JSON.stringify(schema).length, () =>
        getClient().models.generateContent({
          model,
          contents: typeof prompt === "string" ? prompt : [{ role: "user", parts: prompt }],
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: schema,
            systemInstruction: options.system,
            temperature: options.temperature,
          },
        }),
      );
      const text = res.text;
      if (!text) throw new Error(`Gemini ${model} returned no text`);
      return JSON.parse(text) as T;
    });
  }

  /** Generates plain text. */
  async function generateText(model: string, prompt: Prompt, options: GenerateOptions = {}): Promise<string> {
    const key = hashKey(["generateText", model, prompt, options]);
    return cached<string>("generate", key, async () => {
      const res = await paidGenerate("generate", model, inputTokenBound(prompt, options.system), () =>
        getClient().models.generateContent({
          model,
          contents: typeof prompt === "string" ? prompt : [{ role: "user", parts: prompt }],
          config: { systemInstruction: options.system, temperature: options.temperature },
        }),
      );
      const text = res.text;
      if (!text) throw new Error(`Gemini ${model} returned no text`);
      return text;
    });
  }

  /** Embeds each text; each text is cached on its own, so overlapping batches only pay for new texts. */
  async function embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    const model = options.model ?? MODELS.embed;
    const keyOf = (t: string) => hashKey(["embed", model, options.taskType ?? null, options.dimensions ?? null, t]);
    const out: (number[] | null)[] = await Promise.all(
      texts.map(async (t) => (await read<number[]>("embed", keyOf(t))) ?? null),
    );
    const missing = [...new Set(texts.filter((_, i) => out[i] === null))];
    const fresh = new Map<string, number[]>();
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      const chars = batch.reduce((n, t) => n + t.length, 0);
      const usage = { texts: batch.length, chars };
      // Worst case: one token per character.
      const res = await ledger.guarded(
        (chars * priceOf(model).input) / 1e6,
        () =>
          withRetry(() =>
            getClient().models.embedContent({
              model,
              // One Content per text. A bare string[] is merged into a single multimodal
              // input by gemini-embedding-2 and comes back as one embedding.
              contents: batch.map((text) => ({ role: "user", parts: [{ text }] })),
              config: { taskType: options.taskType, outputDimensionality: options.dimensions },
            }),
          ),
        () => usageLine("embed", model, usage, embedCost(model, chars)),
      );
      await opts.onUsage?.("embed", model, usage);
      const vectors = res.embeddings?.map((e) => e.values ?? []) ?? [];
      if (vectors.length !== batch.length || vectors.some((v) => v.length === 0)) {
        throw new Error(`Gemini ${model} returned ${vectors.length} embeddings for ${batch.length} texts`);
      }
      batch.forEach((t, j) => fresh.set(t, vectors[j]));
      await Promise.all(batch.map((t, j) => store("embed", keyOf(t), vectors[j])));
    }
    return texts.map((t, i) => out[i] ?? fresh.get(t)!);
  }

  /**
   * Transcribes an audio file with word-level timestamps (and speaker turns with diarization).
   * Audio is sent inline, so files must be under 18 MB: cut long recordings into clips first.
   * Cached by a hash of the audio bytes.
   */
  async function transcribe(
    audioPath: string,
    options: { model?: string; diarization?: boolean } = {},
  ): Promise<Transcription> {
    const model = options.model ?? MODELS.transcribe;
    const mimeType = AUDIO_TYPES[extname(audioPath).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported audio type: ${extname(audioPath)}`);
    const bytes = await readFile(audioPath);
    if (bytes.length > MAX_INLINE_BYTES) throw new Error(`${audioPath} is over 18 MB; cut it into clips first.`);
    const audioHash = createHash("sha256").update(bytes).digest("hex");
    const key = hashKey(["transcribe", model, audioHash, options.diarization ?? false]);
    return cached<Transcription>("transcribe", key, async () => {
      const res = await paidGenerate("transcribe", model, Math.ceil(bytes.length / 64), () =>
        getClient().models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: bytes.toString("base64") } }] }],
          config: { audioTranscriptionConfig: { wordTimestamp: true, diarization: options.diarization ?? false } },
        }),
      );
      const parts = res.candidates?.[0]?.content?.parts ?? [];
      const found = parts.map((p) => p.audioTranscription).filter((t) => t !== undefined);
      if (!found.length) {
        const kinds = parts.map((p) => Object.keys(p).join("+")).join(", ") || "none";
        throw new Error(`Gemini ${model} returned no audioTranscription (parts: ${kinds})`);
      }
      return {
        text: found.map((t) => t.text ?? "").join(" ").trim(),
        words: found.flatMap((t) =>
          (t.words ?? []).flatMap((w) => {
            const start = seconds(w.startOffset);
            return w.word && start !== null ? [{ word: w.word, start, end: seconds(w.endOffset) ?? start }] : [];
          }),
        ),
        turns: found.map((t) => ({
          speaker: t.speakerLabel ?? null,
          start: seconds(t.startOffset),
          end: seconds(t.endOffset),
          text: t.text ?? "",
        })),
      };
    });
  }

  /** Lists models available on the key. Metadata only, free, not cached. */
  async function listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    for await (const m of await getClient().models.list()) {
      models.push({
        name: (m.name ?? "").replace(/^models\//, ""),
        displayName: m.displayName ?? null,
        supportedActions: m.supportedActions ?? [],
        inputTokenLimit: m.inputTokenLimit ?? null,
      });
    }
    return models;
  }

  return { generateJSON, generateText, embed, transcribe, listModels, cacheDir, usagePath, geminiSpent: ledger.spent };
}

let defaultInstance: ReturnType<typeof createGemini> | null = null;
function gemini() {
  return (defaultInstance ??= createGemini());
}

export const generateJSON = <T>(model: string, prompt: Prompt, schema: object, options?: GenerateOptions) =>
  gemini().generateJSON<T>(model, prompt, schema, options);
export const generateText = (model: string, prompt: Prompt, options?: GenerateOptions) =>
  gemini().generateText(model, prompt, options);
export const embed = (texts: string[], options?: EmbedOptions) => gemini().embed(texts, options);
export const transcribe = (audioPath: string, options?: { model?: string; diarization?: boolean }) =>
  gemini().transcribe(audioPath, options);
export const listModels = () => gemini().listModels();
