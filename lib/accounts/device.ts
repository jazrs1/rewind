// Which account this device's attempts belong to, so a shared browser never moves one student's
// answers into the next student's account. Per course, one small localStorage entry
// ("rewind.account.v1.COP3530"), with no answers in it:
// - `owner` and `ids`: the user id signed in here and the attempts their account has confirmed (sent and
//   kept by the server, or brought back from it);
// - `pending`: per user, the attempts that are theirs but not confirmed yet: answered while they were
//   signed in and not synced (offline, storage down), or refused by the server for their time;
// - `full` and `stale`: per user, those of their pending attempts the server refused because their account
//   was full, or as dated at or before a "Delete my data" (an answer that never synced: it may be real work
//   from a device whose clock was off, so it is kept, not dropped). They stay on the device and aren't sent again.
//
// Signed out (by the button, or the session ended): the confirmed attempts leave the device; pending ones
// stay, so the same student loses nothing unsynced. Signing in as someone else: the previous owner's
// confirmed attempts and every other user's pending ones are removed before anything is sent (privacy
// over keeping another student's unsynced answers on a shared device), and no sync ever sends another
// user's pending attempts. Only attempts answered signed out since then merge into the new account.

import { courseKey, type StorageLike } from "../attempts/store.ts";

export interface DeviceOwner {
  owner(): string | null;
  /** The owner's confirmed attempt ids. */
  owned(): string[];
  /**
   * Records `userId` as the owner, with these ids added to their confirmed ones. Refuses (false, nothing
   * written) when the device belongs to another user: a store left over from an earlier session can't
   * take it back.
   */
  claim(userId: string, ids: string[]): boolean;
  /** No owner, no confirmed ids; pending ids stay. */
  release(): void;
  /** Marks these ids as `userId`'s, not yet confirmed. */
  pend(userId: string, ids: string[]): void;
  /** These ids are no longer pending for `userId` (confirmed, or deleted). */
  unpend(userId: string, ids: string[]): void;
  /** Pending ids of everyone except `userId`: never sent by their sync. */
  pendingOfOthers(userId: string): string[];
  /** Forgets every other user's pending ids (after they were removed from the device). */
  dropOthers(userId: string): void;
  /** Marks these ids as `userId`'s, kept on the device but not sent: their account was full, or they predate a delete. */
  hold(userId: string, ids: string[], why: HoldReason): void;
  /** `userId`'s held ids: for one reason, or (no reason) for either. */
  held(userId: string, why?: HoldReason): string[];
  /** These ids are no longer held for `why` (they stay pending: the next sync sends them). */
  unhold(userId: string, ids: string[], why: HoldReason): void;
  /** `userId`'s pending ids: answers of theirs not confirmed yet (held ones included). */
  pending(userId: string): string[];
}

export type HoldReason = "full" | "stale";

interface Stored {
  owner: string | null;
  ids: string[];
  pending: Record<string, string[]>;
  full: Record<string, string[]>;
  stale: Record<string, string[]>;
}

const EMPTY: Stored = { owner: null, ids: [], pending: {}, full: {}, stale: {} };
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : []);

export function deviceOwner(course: string, storage: () => StorageLike | null): DeviceOwner {
  const key = `rewind.account.v1.${courseKey(course)}`;
  let memory: Stored = EMPTY;
  const read = (): Stored => {
    try {
      const raw = storage()?.getItem(key);
      if (raw === undefined) return memory;
      if (!raw) return EMPTY;
      const s = JSON.parse(raw) as Partial<Stored>;
      const perUser = (x: unknown) => {
        const out: Record<string, string[]> = {};
        if (x && typeof x === "object") for (const [u, ids] of Object.entries(x)) if (strings(ids).length) out[u] = strings(ids);
        return out;
      };
      return { owner: typeof s.owner === "string" ? s.owner : null, ids: strings(s.ids), pending: perUser(s.pending), full: perUser(s.full), stale: perUser(s.stale) };
    } catch {
      return memory;
    }
  };
  const write = (s: Stored) => {
    memory = s;
    try {
      const st = storage();
      if (!s.owner && !Object.keys(s.pending).length && !Object.keys(s.full).length && !Object.keys(s.stale).length) st?.removeItem(key);
      else st?.setItem(key, JSON.stringify(s));
    } catch {
      // kept in memory for this page
    }
  };
  const setFor = (map: Record<string, string[]>, userId: string, ids: string[]) => {
    const out = { ...map };
    if (ids.length) out[userId] = ids;
    else delete out[userId];
    return out;
  };
  const setPending = (s: Stored, userId: string, ids: string[]): Stored => ({ ...s, pending: setFor(s.pending, userId, ids) });
  return {
    owner: () => read().owner,
    owned: () => read().ids,
    claim(userId, ids) {
      const s = read();
      if (s.owner !== null && s.owner !== userId) return false;
      write({ ...s, owner: userId, ids: [...new Set([...(s.owner === userId ? s.ids : []), ...ids])] });
      return true;
    },
    release: () => write({ ...read(), owner: null, ids: [] }),
    pend(userId, ids) {
      const s = read();
      write(setPending(s, userId, [...new Set([...(s.pending[userId] ?? []), ...ids])]));
    },
    unpend(userId, ids) {
      const s = read();
      const drop = new Set(ids);
      write({
        ...s,
        pending: setFor(s.pending, userId, (s.pending[userId] ?? []).filter((i) => !drop.has(i))),
        full: setFor(s.full, userId, (s.full[userId] ?? []).filter((i) => !drop.has(i))),
        stale: setFor(s.stale, userId, (s.stale[userId] ?? []).filter((i) => !drop.has(i))),
      });
    },
    pendingOfOthers: (userId) =>
      Object.entries(read().pending)
        .filter(([u]) => u !== userId)
        .flatMap(([, ids]) => ids),
    dropOthers(userId) {
      const s = read();
      const only = (m: Record<string, string[]>) => (m[userId] ? { [userId]: m[userId] } : {});
      write({ ...s, pending: only(s.pending), full: only(s.full), stale: only(s.stale) });
    },
    hold(userId, ids, why) {
      const s = read();
      write({
        ...s,
        pending: setFor(s.pending, userId, [...new Set([...(s.pending[userId] ?? []), ...ids])]),
        [why]: setFor(s[why], userId, [...new Set([...(s[why][userId] ?? []), ...ids])]),
      });
    },
    unhold(userId, ids, why) {
      const s = read();
      const drop = new Set(ids);
      write({ ...s, [why]: setFor(s[why], userId, (s[why][userId] ?? []).filter((i) => !drop.has(i))) });
    },
    pending: (userId) => read().pending[userId] ?? [],
    held: (userId, why) => {
      const s = read();
      return why ? (s[why][userId] ?? []) : [...(s.full[userId] ?? []), ...(s.stale[userId] ?? [])];
    },
  };
}
