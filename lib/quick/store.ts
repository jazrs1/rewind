// Quick build (beta): the questions, kept on this device only. One versioned localStorage key per course
// ("rewind.quick.v1.COP3530"), the pattern of lib/attempts/store.ts: every read and write is in try/catch, and when
// storage fails the bank is kept in memory for this page only. Nothing here touches the network; the question banks
// never go to a server (practice answers are attempts and go through lib/attempts/store.ts, without any bank text).

import { courseKey, type StorageLike } from "../attempts/store.ts";
import type { QuickQuestion } from "./types.ts";

export const QUICK_VERSION = 1;
export const QUICK_PREFIX = `rewind.quick.v${QUICK_VERSION}.`;

export interface QuickBank {
  v: number;
  course: { code: string; name: string };
  builtAt: string;
  questions: QuickQuestion[];
}

export const quickKey = (course: string) => QUICK_PREFIX + courseKey(course);

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function isQuestion(x: unknown): x is QuickQuestion {
  if (!isObject(x) || typeof x.id !== "string" || typeof x.stem !== "string" || typeof x.quote !== "string" || typeof x.explanation !== "string") return false;
  if (!["A", "B", "C", "D"].includes(x.answer as string)) return false;
  if (!Array.isArray(x.choices) || x.choices.length !== 4 || !x.choices.every((c) => isObject(c) && typeof c.label === "string" && typeof c.text === "string")) return false;
  if (x.code !== null && !(isObject(x.code) && Array.isArray(x.code.lines))) return false;
  const s = x.source;
  if (!isObject(s) || typeof s.title !== "string" || (s.sec !== undefined && typeof s.sec !== "number")) return false;
  if (s.kind === "page" || s.kind === "lecture") return true;
  // A PDF question: its file and page are what its source line says.
  return (s.kind === "slide" || s.kind === "document") && typeof s.deck === "string" && typeof s.page === "number";
}

/** A bank read back from storage: the right version and every question well formed, else null. */
export function parseBank(raw: string | null): QuickBank | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as unknown;
    if (!isObject(b) || b.v !== QUICK_VERSION || !isObject(b.course) || typeof b.course.code !== "string" || typeof b.course.name !== "string" || !Array.isArray(b.questions)) return null;
    if (!b.questions.length || !b.questions.every(isQuestion)) return null;
    return { v: QUICK_VERSION, course: { code: b.course.code, name: b.course.name }, builtAt: typeof b.builtAt === "string" ? b.builtAt : "", questions: b.questions as QuickQuestion[] };
  } catch {
    return null;
  }
}

export interface BankStore {
  read(course: string): QuickBank | null;
  /** Every bank on this device. */
  list(): QuickBank[];
  write(bank: Omit<QuickBank, "v">): void;
  /** "Delete these questions". */
  clear(course: string): void;
  subscribe(fn: () => void): () => void;
}

export function createBankStore(storage: () => StorageLike & { key?(i: number): string | null; readonly length?: number } | null): BankStore {
  const memory = new Map<string, QuickBank>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  let snapshot: { raw: string | null; bank: QuickBank | null; key: string } = { raw: null, bank: null, key: "" };
  return {
    read(course) {
      const key = quickKey(course);
      let raw: string | null | undefined;
      try {
        const s = storage();
        raw = s ? s.getItem(key) : undefined;
      } catch {
        raw = undefined;
      }
      if (raw === undefined) return memory.get(key) ?? null;
      // The same object until the stored text changes (useSyncExternalStore wants a stable snapshot).
      if (snapshot.key === key && snapshot.raw === raw) return snapshot.bank;
      snapshot = { key, raw, bank: parseBank(raw) };
      return snapshot.bank;
    },
    list() {
      const found: QuickBank[] = [];
      try {
        const s = storage();
        if (s && typeof s.key === "function" && typeof s.length === "number") {
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (k?.startsWith(QUICK_PREFIX)) {
              const b = parseBank(s.getItem(k));
              if (b) found.push(b);
            }
          }
        }
      } catch {
        // storage blocked: memory only
      }
      for (const [k, b] of memory) if (!found.some((f) => quickKey(f.course.code) === k)) found.push(b);
      return found;
    },
    write(bank) {
      const full: QuickBank = { v: QUICK_VERSION, ...bank };
      const key = quickKey(bank.course.code);
      memory.set(key, full);
      try {
        storage()?.setItem(key, JSON.stringify(full));
      } catch {
        // quota or blocked: this page keeps its memory copy
      }
      emit();
    },
    clear(course) {
      const key = quickKey(course);
      memory.delete(key);
      try {
        storage()?.removeItem(key);
      } catch {
        // nothing to remove
      }
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key.startsWith(QUICK_PREFIX)) fn();
      };
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(fn);
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
  };
}

let shared: BankStore | null = null;

/** The banks on this device (server: none). */
export function browserBanks(): BankStore {
  return (shared ??= createBankStore(() => {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  }));
}
