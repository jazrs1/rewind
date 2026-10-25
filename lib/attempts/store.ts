// Practice attempts, saved on this device. This module is the one place attempts are kept: when a
// student signs in (Accounts Lite, lib/accounts/), the account-backed store takes over through
// `setAccountStores` without touching the screens. Nothing here sends anything over the network.
//
// Storage: localStorage, one versioned key per course ("rewind.attempts.v1.COP3530"). Every read
// and write is wrapped in try/catch (private mode, blocked storage, quota): when storage fails,
// attempts are kept in memory for this page only. On the server there is no storage, so the
// list is empty (SSR-safe).
//
// Example history: for the judges' demo course the store starts with a few example attempts so
// the Course tape has misses to show. They are always `example: true` (the screens label them
// "Example practice history"), added only to an empty store, and removed as soon as the
// student answers for real. Once the examples were shown, answered over or cleared, they never
// come back for that course (a small "examples done" flag, no attempt data).

import type { ChoiceLabel, Confidence } from "../schema.ts";

export const STORE_VERSION = 1;
const PREFIX = `rewind.attempts.v${STORE_VERSION}.`;

/** One answer to a practice question, kept on this device. */
export interface AttemptRecord {
  id: string;
  questionId: string;
  /** What the question is about: its rewind's slide deck ("7 - Sets, Maps, HashTables"), for placing it on the tape. */
  topic: string;
  /** The question text, word for word (the evidence quote on the tape). */
  stem: string | null;
  choice: ChoiceLabel;
  correct: boolean;
  confidence: Confidence | null;
  /** ISO date-time. */
  answeredAt: string;
  /** true: example practice history for the demo course, never the student's own answer. */
  example: boolean;
}

export type NewAttempt = Omit<AttemptRecord, "id" | "example">;

export interface AttemptStore {
  /** Every attempt for the course, oldest first. The same array is returned until something changes. */
  list(): AttemptRecord[];
  /** Saves the student's real answer. Clears any example history first. */
  add(attempt: NewAttempt): AttemptRecord;
  /** Deletes every attempt for the course, examples included. */
  clear(): void;
  /** Calls `fn` after every change (here or in another tab). Returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** Adds the example history if the store is empty and examples were never shown. Returns whether it did. */
  seedExamples(examples: NewAttempt[]): boolean;
  /** Deletes these attempts (by id) from the course; the rest stay. */
  remove(ids: string[]): void;
  /** Merges real attempts kept elsewhere (the student's account) by id, keeping the newer one. Any real attempt removes the examples. */
  merge(records: AttemptRecord[]): void;
}

/** The parts of Web Storage we use, so tests can pass an in-memory fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Stored {
  v: number;
  attempts: AttemptRecord[];
}

const EMPTY: AttemptRecord[] = [];

/** "COP3530 - Fa26" or "cop3530" → "COP3530"; anything else is slugged. */
export function courseKey(code: string): string {
  const m = code.toUpperCase().match(/[A-Z]{3}\s?\d{4}[A-Z]?/);
  return m ? m[0].replace(/\s/g, "") : code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "course";
}

export function storageKey(course: string): string {
  return PREFIX + courseKey(course);
}

function isRecord(x: unknown): x is AttemptRecord {
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.questionId === "string" &&
    typeof a.topic === "string" &&
    typeof a.correct === "boolean" &&
    typeof a.answeredAt === "string" &&
    typeof a.example === "boolean" &&
    (a.choice === "A" || a.choice === "B" || a.choice === "C" || a.choice === "D")
  );
}

let counter = 0;
/** "att-" and 32 lowercase characters (accounts accept at most 40). */
function newId(): string {
  counter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 32);
  return `att-${rand}`;
}

/**
 * Ids saved before accounts ("att-<uuid>-<n>", 41+ characters) in the short form, the same every time,
 * so an older device's answers can still go to an account and come back as the same records.
 */
export function compactAttemptId(id: string): string {
  if (/^att-[a-z0-9]{8,36}$/.test(id)) return id;
  const uuid = id.match(/^att-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d+$/);
  if (uuid) return `att-${uuid[1].replace(/-/g, "")}`;
  return `att-${id.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^att/, "").slice(0, 32)}`;
}

export interface StoreOptions {
  course: string;
  /** Returns the storage to use, or null (server, blocked). Called on each read and write. */
  storage: () => StorageLike | null;
  /** For cross-tab updates: subscribe to the window's storage event. */
  onExternalChange?: (key: string, fn: () => void) => () => void;
}

export function createAttemptStore({ course, storage, onExternalChange }: StoreOptions): AttemptStore {
  const key = storageKey(course);
  const flagKey = `${key}.examples-done`;
  const listeners = new Set<() => void>();
  /** Used when storage is missing or failing, so this page still works. */
  let memory: AttemptRecord[] = EMPTY;
  let memoryFlag = false;
  /** Set when a write fails: from then on this page reads its in-memory copy. */
  let broken = false;
  let cache: { raw: string | null; list: AttemptRecord[] } = { raw: null, list: EMPTY };

  const get = (k: string): string | null | undefined => {
    try {
      const s = storage();
      return s ? s.getItem(k) : undefined;
    } catch {
      return undefined;
    }
  };
  const set = (k: string, value: string | null): boolean => {
    try {
      const s = storage();
      if (!s) return false;
      if (value === null) s.removeItem(k);
      else s.setItem(k, value);
      return true;
    } catch {
      return false;
    }
  };

  const read = (): AttemptRecord[] => {
    const raw = broken ? undefined : get(key);
    if (raw === undefined) return memory;
    if (raw === cache.raw) return cache.list;
    let list: AttemptRecord[] = EMPTY;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Stored;
        if (parsed && parsed.v === STORE_VERSION && Array.isArray(parsed.attempts)) list = parsed.attempts.filter(isRecord).map((a) => (a.id.length > 40 ? { ...a, id: compactAttemptId(a.id) } : a));
      } catch {
        list = EMPTY;
      }
    }
    cache = { raw, list };
    return list;
  };

  const write = (list: AttemptRecord[]) => {
    memory = list;
    const ok = list.length ? set(key, JSON.stringify({ v: STORE_VERSION, attempts: list } satisfies Stored)) : set(key, null);
    if (!ok) broken = true;
    emit();
  };

  const examplesDone = (): boolean => {
    const v = get(flagKey);
    return v === undefined ? memoryFlag : v === "1";
  };
  const markExamplesDone = () => {
    memoryFlag = true;
    set(flagKey, "1");
  };

  const emit = () => {
    for (const fn of [...listeners]) fn();
  };

  let unlistenExternal: (() => void) | null = null;

  return {
    list: read,
    add(attempt) {
      const record: AttemptRecord = { ...attempt, id: newId(), example: false };
      markExamplesDone();
      write([...read().filter((a) => !a.example), record]);
      return record;
    },
    clear() {
      markExamplesDone();
      write(EMPTY);
    },
    subscribe(fn) {
      listeners.add(fn);
      if (listeners.size === 1 && onExternalChange) unlistenExternal = onExternalChange(key, emit);
      return () => {
        listeners.delete(fn);
        if (!listeners.size && unlistenExternal) {
          unlistenExternal();
          unlistenExternal = null;
        }
      };
    },
    seedExamples(examples) {
      if (!examples.length || examplesDone() || read().length) return false;
      markExamplesDone();
      write(examples.map((a) => ({ ...a, id: newId(), example: true })));
      return true;
    },
    remove(ids) {
      const drop = new Set(ids);
      const list = read();
      if (list.some((a) => drop.has(a.id))) write(list.filter((a) => !drop.has(a.id)));
    },
    merge(records) {
      const real = records.filter((a) => isRecord(a) && !a.example);
      if (!real.length) return;
      const byId = new Map(read().filter((a) => !a.example).map((a) => [a.id, a]));
      let changed = read().some((a) => a.example);
      for (const a of real) {
        const had = byId.get(a.id);
        if (had && Date.parse(had.answeredAt) >= Date.parse(a.answeredAt)) continue;
        byId.set(a.id, a);
        changed = true;
      }
      if (!changed) return;
      markExamplesDone();
      write([...byId.values()].sort((a, b) => Date.parse(a.answeredAt) - Date.parse(b.answeredAt)));
    },
  };
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function onStorageEvent(key: string, fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: StorageEvent) => {
    if (e.key === null || e.key === key) fn();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

const stores = new Map<string, AttemptStore>();

/** The store for a course on this device (one shared instance per course). */
export function browserAttemptStore(course: string): AttemptStore {
  const k = courseKey(course);
  let s = stores.get(k);
  if (!s) {
    s = createAttemptStore({ course: k, storage: browserStorage, onExternalChange: onStorageEvent });
    stores.set(k, s);
  }
  return s;
}

let accountStores: ((course: string) => AttemptStore) | null = null;

/** While a student is signed in, their account-backed stores replace the browser ones (null: back to the browser). */
export function setAccountStores(factory: ((course: string) => AttemptStore) | null): void {
  accountStores = factory;
}

/** The store the screens use: the signed-in account's, else this device's. */
export function attemptStore(course: string): AttemptStore {
  return accountStores?.(course) ?? browserAttemptStore(course);
}

/** For useSyncExternalStore's server snapshot: always the same empty list. */
export function emptyAttempts(): AttemptRecord[] {
  return EMPTY;
}
