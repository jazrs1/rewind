// Disk cache shared by lib/gemini.ts and lib/llm.ts: one JSON file per key under
// <cacheDir>/<kind>/, written atomically. Concurrent calls with the same key share
// one computation, so the same input is never paid for twice.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function hashKey(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function createDiskCache(cacheDir: string) {
  const inFlight = new Map<string, Promise<unknown>>();
  const pathOf = (kind: string, key: string) => join(cacheDir, kind, `${key}.json`);

  /** The cached value, or undefined. */
  async function read<T>(kind: string, key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(pathOf(kind, key), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async function store(kind: string, key: string, value: unknown) {
    const path = pathOf(kind, key);
    await mkdir(join(cacheDir, kind), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, path);
  }

  /** Returns the cached value for key, or computes, stores and returns it. */
  async function cached<T>(kind: string, key: string, compute: () => Promise<T>): Promise<T> {
    const hit = await read<T>(kind, key);
    if (hit !== undefined) return hit;
    const path = pathOf(kind, key);
    const pending = inFlight.get(path);
    if (pending) return pending as Promise<T>;
    const p = (async () => {
      const value = await compute();
      await store(kind, key, value);
      return value;
    })();
    inFlight.set(path, p);
    try {
      return await p;
    } finally {
      inFlight.delete(path);
    }
  }

  return { read, store, cached };
}
