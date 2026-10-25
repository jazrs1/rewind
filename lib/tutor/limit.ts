// Server-side counters for the tutor route, kept on globalThis (the dev server may load the route twice).
//   - a per-minute rate limit on calls (each one is paid for);
//   - hints given, counted here per page visit and question, so a history the browser edits can't give a
//     student more than two.

const KEY = Symbol.for("rewind.tutor.limits");
interface Store {
  calls: number[];
  hints: Map<string, number>;
}
const store = (): Store => {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[KEY] ??= { calls: [], hints: new Map() });
};

export const RATE_LIMIT_PER_MINUTE = 60;

/** Counts this call; false when the last minute already had `max`. */
export function allowCall(now = Date.now(), max = RATE_LIMIT_PER_MINUTE, s = store()): boolean {
  s.calls = s.calls.filter((t) => now - t < 60_000);
  if (s.calls.length >= max) return false;
  s.calls.push(now);
  return true;
}

const hintKey = (nonce: string, questionId: string) => `${nonce}|${questionId}`;
export const hintsGivenOn = (nonce: string, questionId: string, s = store()): number => s.hints.get(hintKey(nonce, questionId)) ?? 0;
export function noteHint(nonce: string, questionId: string, s = store()): void {
  const k = hintKey(nonce, questionId);
  s.hints.set(k, (s.hints.get(k) ?? 0) + 1);
  // A visit's counts are a few entries; keep the map small anyway.
  if (s.hints.size > 500) s.hints.delete(s.hints.keys().next().value!);
}
export const resetLimitsForTest = () => {
  const s = store();
  s.calls = [];
  s.hints.clear();
};
