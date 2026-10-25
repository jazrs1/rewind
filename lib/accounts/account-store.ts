// The account-backed attempt store: the same AttemptStore the screens use, kept on this device first
// (so it works offline) and copied to the signed-in student's account. Every sync sends this device's
// real attempts the account hasn't confirmed yet, stripped to the account fields (lib/accounts/schema.ts),
// and merges back whatever the account holds; the merge is by id, so syncing twice never duplicates anything. Records from the
// account get their topic and stem back from the course bundle on this page, never from the server.
// Only the signed-in student's own attempts, and those answered signed out since the last sign-out,
// are ever on the device to send (lib/accounts/device.ts).

import type { AttemptRecord, AttemptStore } from "../attempts/store.ts";
import type { DeviceOwner } from "./device.ts";
import { FUTURE_SLACK_MS, type Refused } from "./handler.ts";
import { MAX_ATTEMPTS, MAX_BYTES } from "./schema.ts";
import { toAccountAttempt, type AccountAttempt } from "./schema.ts";

/** The account API as the browser sees it (lib/accounts/api.ts; a fake in tests). */
export interface AccountApi {
  /** The account's records, and its deletion mark (ISO time, null when there is none). Rejects on any failure or partial reply. */
  get(): Promise<{ attempts: AccountAttempt[]; deletedBefore: string | null; serverTime: string }>;
  /** The account's attempts after the merge, and every record it refused with the reason (lib/accounts/handler.ts). */
  post(attempts: AccountAttempt[]): Promise<{ attempts: AccountAttempt[]; refused: Refused[]; deletedBefore: string | null; serverTime: string }>;
  /** Without a course: every key for the user. */
  del(course?: string): Promise<void>;
}

/** What a question id means on this page: its topic and stem, from the bundle already loaded. */
export type QuestionLookup = (questionId: string) => { topic: string; stem: string | null } | null;

export function fromAccountAttempt(a: AccountAttempt, lookup: QuestionLookup): AttemptRecord {
  const q = lookup(a.questionId);
  return { id: a.id, questionId: a.questionId, topic: q?.topic ?? "", stem: q?.stem ?? null, choice: a.choice, correct: a.correct, confidence: a.confidence, answeredAt: a.answeredAt, example: false };
}

/** What a sync uploads: this device's real attempts for the course, examples dropped and course text stripped. */
export function uploadOf(local: AttemptRecord[], course: string): AccountAttempt[] {
  return local.map((r) => toAccountAttempt(r, course)).filter((a): a is AccountAttempt => a !== null);
}

/** This user's answers on this device that their account doesn't have. */
export interface DeviceState {
  /** Kept because the account was full (sent again once there is room). */
  full: number;
  /** Refused as dated before a "Delete my data" (kept here; not saved). */
  stale: number;
  /** Not in the account yet, for any reason: removed, unsent, if someone else signs in on this device. */
  unsynced: number;
}

/** One POST's share of a backlog: well under the server's 2,000 answers and 256 KB per body (lib/accounts/schema.ts). */
export const BATCH_ATTEMPTS = 500;
export const BATCH_BYTES = Math.floor(MAX_BYTES * 0.75);

/** The first batch of `all`: at most BATCH_ATTEMPTS answers and BATCH_BYTES of JSON (always at least one answer). */
export function firstBatch(all: AccountAttempt[]): AccountAttempt[] {
  let bytes = 16;
  let n = 0;
  for (const a of all) {
    const size = new TextEncoder().encode(JSON.stringify(a)).length + 1;
    if (n >= BATCH_ATTEMPTS || (n > 0 && bytes + size > BATCH_BYTES)) break;
    bytes += size;
    n++;
  }
  return all.slice(0, n);
}

export interface AccountStore extends AttemptStore {
  /** Sends this device's attempts and merges the account's back. Rejects when the account can't be reached. Does nothing while a delete runs. */
  sync(): Promise<void>;
  /** Before signing out: one last sync, so answers given while signed in reach the account (failures are ignored). */
  flush(): Promise<void>;
  /** "Delete my data": stops syncing, deletes every key in the account, then removes from this device the attempts it had when the delete started. */
  deleteAll(): Promise<void>;
  /**
   * This store's session is over (signed out, or another user signed in). A sync still in flight stops at its next
   * step without touching this device's attempts or its owner record.
   */
  dispose(): void;
}

/**
 * Removes this device's attempts that an account confirmed (lib/accounts/device.ts) and forgets the owner.
 * Called whenever no one is signed in: what is left on the device is what was answered signed out, and any
 * user's answers the server hasn't confirmed yet (kept for them, never sent by anyone else).
 */
export function releaseDevice(local: AttemptStore, owner: DeviceOwner): void {
  local.remove(owner.owned());
  owner.release();
}

export function createAccountAttemptStore({
  course,
  userId,
  local,
  owner,
  api,
  lookup,
  onError,
  onState,
  onClearFailed,
}: {
  course: string;
  /** The signed-in user (from the session). */
  userId: string;
  local: AttemptStore;
  owner: DeviceOwner;
  api: AccountApi;
  lookup: QuestionLookup;
  onError?: (e: unknown) => void;
  /** After each change: this user's answers on the device that aren't in their account, and why (lib/accounts/device.ts). */
  onState?: (state: DeviceState) => void;
  /** A course cleared here couldn't be cleared in the account (it was cleared on this device only). */
  onClearFailed?: () => void;
}): AccountStore {
  // Signed in as someone other than the device's owner: their confirmed attempts go first, unsent, and so do
  // every other user's unconfirmed ones (lib/accounts/device.ts).
  if (owner.owner() !== null && owner.owner() !== userId) releaseDevice(local, owner);
  const others = owner.pendingOfOthers(userId);
  if (others.length) {
    local.remove(others);
    owner.dropOthers(userId);
  }
  owner.claim(userId, []);

  let running: Promise<void> | null = null;
  let again = false;
  let deleting = false;
  let disposed = false;

  const report = () => {
    if (disposed || !onState) return;
    const here = new Set(local.list().map((r) => r.id));
    const count = (ids: string[]) => ids.filter((id) => here.has(id)).length;
    onState({ full: count(owner.held(userId, "full")), stale: count(owner.held(userId, "stale")), unsynced: count(owner.pending(userId)) });
  };

  /** This device's attempts this user's sync may send or delete: not another user's pending ones. */
  const mine = () => {
    const others = new Set(owner.pendingOfOthers(userId));
    return local.list().filter((r) => !others.has(r.id));
  };
  // Refused as dated in the future (this device's clock runs ahead): held until the server's time reaches them, from the
  // last reply's serverTime, instead of being re-sent with every answer and retry.
  const future = new Set<string>();
  let skewMs = 0;
  const serverNow = () => Date.now() + skewMs;

  /**
   * What a sync sends: this user's attempts the account hasn't confirmed yet, less those held (account full, or older
   * than a delete) and future-dated ones the server's time hasn't reached. Confirmed ones are in the account already (and
   * a device's records never change), so sending them again would only grow the request: near the account's 2,000 that
   * alone passed the 256 KB body limit.
   */
  const toSend = () => {
    const skip = new Set([...owner.held(userId), ...(owner.owner() === userId ? owner.owned() : [])]);
    return uploadOf(
      mine().filter((r) => !skip.has(r.id) && !(future.has(r.id) && Date.parse(r.answeredAt) > serverNow() + FUTURE_SLACK_MS)),
      course,
    );
  };

  const syncOnce = async () => {
    if (disposed) return;
    // A backlog goes over several requests, one batch each (F1): the rest is sent by the next round of this sync.
    const pending = toSend();
    const sent = firstBatch(pending);
    // A request that fails, times out or answers only part of the reply rejects here: nothing below runs, so a failed
    // sync never changes the device.
    const res = sent.length ? await api.post(sent) : { ...(await api.get()), refused: [] };
    // After the request: a store whose session ended (or that a delete overtook) leaves the device alone.
    if (disposed || deleting) return;
    skewMs = Date.parse(res.serverTime) - Date.now();
    const why = new Map(res.refused.map((r) => [r.id, r.reason]));
    const sentWith = (reason: Refused["reason"]) => sent.filter((a) => why.get(a.id) === reason).map((a) => a.id);
    const confirmed = [...res.attempts.map((a) => a.id), ...sent.filter((a) => !why.has(a.id)).map((a) => a.id)];
    // Another user owns the device now: nothing from this account may land on it.
    if (!owner.claim(userId, confirmed)) return;
    local.merge(res.attempts.filter((a) => a.course === course).map((a) => fromAccountAttempt(a, lookup)));
    owner.unpend(userId, confirmed);
    // A "Delete my data" on any device: confirmed answers dated at or before the account's deletion mark were deleted,
    // so they leave this device too. That mark (or an explicit older-than-delete below) is the only reason a confirmed
    // answer is removed: one missing from the account's list stays.
    const mark = res.deletedBefore === null ? null : Date.parse(res.deletedBefore);
    if (mark !== null) {
      const owned = new Set(owner.owned());
      const deletedElsewhere = local
        .list()
        .filter((r) => owned.has(r.id) && Date.parse(r.answeredAt) <= mark)
        .map((r) => r.id);
      if (deletedElsewhere.length) local.remove(deletedElsewhere);
    }
    // Refused as dated at or before a "Delete my data": the account never confirmed them (only unconfirmed answers are
    // sent), so they may be real work from a device whose clock was off. Kept on the device, not sent again.
    owner.hold(userId, sentWith("older-than-delete"), "stale");
    // Dated in the future: this user's, kept on the device, sent again once the server's time reaches them.
    const ahead = sentWith("future");
    owner.pend(userId, ahead);
    for (const id of ahead) future.add(id);
    // The account is full: kept on the device, not sent again; the menu says so. Once the account has room again (a
    // delete elsewhere), they're let go to be sent: one more round sends them.
    owner.hold(userId, sentWith("over-limit"), "full");
    const waiting = owner.held(userId, "full");
    if (waiting.length && res.attempts.length < MAX_ATTEMPTS && !sentWith("over-limit").length) {
      owner.unhold(userId, waiting, "full");
      again = true;
    }
    if (pending.length > sent.length) again = true;
    report();
  };
  // One sync at a time; a change during one runs one more after it.
  const sync = (): Promise<void> => {
    if (deleting || disposed) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await syncOnce();
        } while (again && !deleting && !disposed);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  const background = () => {
    sync().catch((e) => onError?.(e));
  };

  report();

  return {
    list: local.list,
    subscribe: local.subscribe,
    merge: local.merge,
    remove: local.remove,
    // Examples stay on this device only (uploadOf drops them).
    seedExamples: local.seedExamples,
    add(attempt) {
      const record = local.add(attempt);
      if (disposed) return record;
      // This user's until the server confirms it: a sign-out before then (offline, storage down) keeps it here.
      owner.pend(userId, [record.id]);
      report();
      background();
      return record;
    },
    clear() {
      local.clear();
      api.del(course).catch((e) => {
        onError?.(e);
        onClearFailed?.();
      });
    },
    sync,
    async flush() {
      await sync().catch(() => {});
    },
    async deleteAll() {
      deleting = true;
      // What the student is deleting: the answers here now. Ones given while a running sync finishes, or while the delete
      // is in flight, aren't in it: they stay and are sent afterwards.
      const before = mine().map((a) => a.id);
      try {
        await running?.catch(() => {});
        await api.del();
        if (disposed) return;
        local.remove(before);
        owner.unpend(userId, before);
        owner.release();
        owner.claim(userId, []);
      } finally {
        deleting = false;
      }
      report();
      // One sync right after (F6): it sends answers given while the delete ran (newer than it), and its reply's deletion
      // mark removes any confirmed answer a sync in flight merged onto the device during the delete.
      background();
    },
    dispose() {
      disposed = true;
    },
  };
}
