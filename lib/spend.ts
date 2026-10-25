// Model spend caps (adversary sweep M4). Two pieces:
//   - one shared cache root for the model caches and usage logs: $REWIND_CACHE_DIR if set, else the
//     MAIN checkout's .cache (the parent of `git rev-parse --git-common-dir`, as
//     lib/pipeline/private-fs.ts finds private/), so every worktree pays once and adds to one log.
//     A root inside private/ is refused.
//   - a ledger per usage log: before a paid call, its worst-case cost is reserved under a lock
//     (logged spend + calls in flight + this call must stay within the cap), so N concurrent calls
//     can't all pass; after the call the hold is swapped for the logged line with the actual cost.
// Prices live here (lib/llm.ts re-exports them) so lib/gemini.ts can price calls without an
// import cycle.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache writes: 1.25x input. */
  cacheWrite: number;
}

/**
 * Claude: Anthropic first-party prices from the claude-api skill (cached 2026-10-06).
 * Opus 5 and Opus 4.8 are listed only because server-side fallback can route a declined request there.
 * Gemini 3.8 Flash: ai.google.dev/gemini-api/docs/pricing, paid tier, standard, through
 * Dec 31, 2026 (page updated 2026-10-22; doubles to $1.50 / $7.50 on Jan 1, 2027).
 * Other Gemini models (Flash-Lite, embedding, transcribe) have no checked price yet: the Gemini
 * cap counts them at the Flash price (GEMINI_FALLBACK_PRICE), which is at least theirs.
 */
export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
};

/** What the Gemini cap charges for a Gemini model missing from PRICES. */
export const GEMINI_FALLBACK_PRICE = PRICES["gemini-3.8-flash"];

export interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function priceWith(p: Price, t: Tokens): number {
  return (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheReadTokens * p.cacheRead + t.cacheWriteTokens * p.cacheWrite) / 1e6;
}

export function costOf(model: string, t: Tokens): number | null {
  const p = PRICES[model];
  return p ? priceWith(p, t) : null;
}

/** Gemini usageMetadata as billed tokens (thinking tokens are billed as output). */
export function geminiTokens(usage: unknown): Tokens {
  const u = (usage ?? {}) as Record<string, number | undefined>;
  const cached = u.cachedContentTokenCount ?? 0;
  return {
    inputTokens: (u.promptTokenCount ?? 0) - cached,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

type Env = Record<string, string | undefined>;

/** Is `child` `parent` or inside it? */
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The main checkout (parent of the git common dir), or null outside a git checkout (e.g. a deploy). */
function mainCheckout(cwd: string): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // Real path: git prints the common dir relative from the main checkout but absolute (and
    // symlink-resolved) from a worktree, and both must give the same folder.
    return real(dirname(resolve(cwd, common)));
  } catch {
    return null;
  }
}

/**
 * The shared cache root: $REWIND_CACHE_DIR, else <main checkout>/.cache (the same folder from
 * every worktree), else <cwd>/.cache outside git. Refused if it is inside private/.
 */
export function sharedCacheRoot(opts: { env?: Env; cwd?: string } = {}): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const main = mainCheckout(cwd);
  const root = env.REWIND_CACHE_DIR ? resolve(cwd, env.REWIND_CACHE_DIR) : join(main ?? cwd, ".cache");
  const privates = [main && join(main, "private"), env.REWIND_PRIVATE_ROOT && resolve(cwd, env.REWIND_PRIVATE_ROOT)].filter((p): p is string => !!p);
  for (const p of privates) {
    if (inside(real(p), real(root)) || inside(p, root)) throw new Error(`the model cache (${root}) can't be inside private/`);
  }
  return root;
}

/** <shared cache root>/<name>, e.g. "llm" or "gemini". */
export const defaultCacheDir = (name: string, opts: { env?: Env; cwd?: string } = {}) => join(sharedCacheRoot(opts), name);

export class SpendCapError extends Error {
  readonly provider: string;
  readonly totalUsd: number;
  readonly capUsd: number;
  constructor(provider: string, spent: number, held: number, worst: number, cap: number, usagePath: string, how: string) {
    super(
      `${provider} spend cap hit: $${(spent + held).toFixed(2)} of $${cap} used ($${spent.toFixed(2)} logged in ${usagePath}` +
        `${held ? ` + $${held.toFixed(2)} held by calls in flight` : ""}); this call could cost up to $${worst.toFixed(2)}. ` +
        `No more ${provider} calls. ${how}`,
    );
    this.name = "SpendCapError";
    this.provider = provider;
    this.totalUsd = spent + held;
    this.capUsd = cap;
  }
}

interface HoldRec {
  usd: number;
  at: number;
  pid: number;
}

/** A hold older than this, or whose process is gone, no longer counts (a crashed run). */
const HOLD_TTL_MS = 60 * 60 * 1000;
/** A lock folder older than this is from a crashed process and is taken over. */
const STALE_LOCK_MS = 15_000;

function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs fn while holding <path>.lock (a folder: mkdir is atomic across processes). */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let tries = 0; ; tries++) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = await stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (tries > 3000) throw new Error(`timed out waiting for ${lock}`);
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export interface Hold {
  /** Appends the call's usage line (with its actual cost) and drops the hold; null just drops it. */
  settle(line: object | null): Promise<void>;
}

/**
 * The cap on one usage log. `costOfLine` says what a logged line counts toward this cap (0 for
 * lines of another provider). Holds live in <usagePath>.holds.json.
 */
export function createLedger(opts: {
  provider: string;
  usagePath: string;
  capUsd: number;
  costOfLine: (line: Record<string, unknown>) => number;
  /** How to raise the cap, for the error. */
  how: string;
}) {
  const { usagePath } = opts;
  const holdsPath = `${usagePath}.holds.json`;

  async function readLines(): Promise<Record<string, unknown>[]> {
    const src = await readFile(usagePath, "utf8").catch(() => "");
    return src
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  async function spent(): Promise<number> {
    return (await readLines()).reduce((n, l) => n + opts.costOfLine(l), 0);
  }

  async function readHolds(): Promise<Record<string, HoldRec>> {
    let all: Record<string, HoldRec>;
    try {
      all = JSON.parse(await readFile(holdsPath, "utf8")) as Record<string, HoldRec>;
    } catch {
      return {};
    }
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, h]) => now - h.at < HOLD_TTL_MS && alive(h.pid)));
  }

  async function writeHolds(holds: Record<string, HoldRec>) {
    const tmp = `${holdsPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(holds));
    await rename(tmp, holdsPath);
  }

  /** Reserves `worstUsd`, or throws SpendCapError if logged spend + holds + it would pass the cap. */
  async function reserve(worstUsd: number): Promise<Hold> {
    const id = `${process.pid}-${randomBytes(6).toString("hex")}`;
    await withLock(usagePath, async () => {
      const holds = await readHolds();
      const held = Object.values(holds).reduce((n, h) => n + h.usd, 0);
      const done = await spent();
      if (done + held + worstUsd > opts.capUsd) throw new SpendCapError(opts.provider, done, held, worstUsd, opts.capUsd, usagePath, opts.how);
      await writeHolds({ ...holds, [id]: { usd: worstUsd, at: Date.now(), pid: process.pid } });
    });
    let settled = false;
    return {
      async settle(line) {
        if (settled) return;
        settled = true;
        await withLock(usagePath, async () => {
          if (line) await appendFile(usagePath, JSON.stringify(line) + "\n");
          const holds = await readHolds();
          delete holds[id];
          await writeHolds(holds);
        });
      },
    };
  }

  /** Reserves, runs the call, then settles with `line(result)` (or just drops the hold if it threw). */
  async function guarded<T>(worstUsd: number, call: () => Promise<T>, line: (result: T) => object | null): Promise<T> {
    const hold = await reserve(worstUsd);
    let result: T;
    try {
      result = await call();
    } catch (e) {
      await hold.settle(null);
      throw e;
    }
    await hold.settle(line(result));
    return result;
  }

  return { reserve, guarded, spent, readLines, usagePath };
}
