// zoom-remote source: the student's Zoom recording plays in a background tab, driven by
// the Rewind extension (message contract: T7 in AGENT_TASKS.md). State is polled.

import { createStore, INITIAL_STATE, type PlayerSource, type PlayerState } from "./types.ts";

export interface RemoteState {
  currentTime: number;
  paused: boolean;
  rate: number;
  duration: number | null;
}

export type Reply = { ok: true; state?: RemoteState } | { ok: false; error: string };
export type Send = (msg: Record<string, unknown>) => Promise<Reply>;

export const POLL_PLAYING_MS = 250;
export const POLL_PAUSED_MS = 1000;
/** A seek counts once the extension reports currentTime within this many seconds of the target. */
export const SEEK_TOLERANCE = 1;
/** Seeks the extension accepted but status doesn't confirm, before giving up with seek-failed. */
export const SEEK_CONFIRM_TRIES = 3;
export const SEEK_FAILED = "The recording didn't jump to the clip.";
export const NO_EXTENSION = "The Rewind extension isn't installed in this browser.";

const MESSAGES: Record<string, string> = {
  "seek-failed": SEEK_FAILED,
  "no-extension": NO_EXTENSION,
  "no-extension-id": "Rewind doesn't know the extension's ID yet: set NEXT_PUBLIC_REWIND_EXTENSION_IDS (or NEXT_PUBLIC_REWIND_EXTENSION_ID) in .env.local (from chrome://extensions) and restart the dev server.",
  "needs-gesture": "Chrome needs one click in the Zoom tab before it can play.",
};

/** One chrome.runtime.sendMessage to one extension ID, as a promise. */
function sendTo(id: string, msg: Record<string, unknown>): Promise<Reply> {
  return new Promise((resolve) => {
    const runtime = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
    if (!runtime?.sendMessage) return resolve({ ok: false, error: "no-extension" });
    try {
      runtime.sendMessage(id, msg, (reply?: Reply) => {
        // Chrome says "Receiving end does not exist" when no extension has this ID.
        const lastError = runtime.lastError?.message;
        resolve(reply ?? { ok: false, error: !lastError || /receiving end does not exist/i.test(lastError) ? "no-extension" : lastError });
      });
    } catch {
      resolve({ ok: false, error: "no-extension" });
    }
  });
}

/**
 * chrome.runtime.sendMessage to the extension, as a promise. `extensionIds` is one ID or several, comma-separated
 * (lib/extension.ts: the zip's pinned ID, the store's): each is tried in order until one is there, and the one that
 * answered is asked first from then on.
 */
export function extensionSender(extensionIds: string): Send {
  const ids = extensionIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let found: string | null = null;
  return async (msg) => {
    if (!ids.length) return { ok: false, error: "no-extension-id" };
    let last: Reply = { ok: false, error: "no-extension" };
    for (const id of found ? [found, ...ids.filter((x) => x !== found)] : ids) {
      last = await sendTo(id, msg);
      if (last.ok || last.error !== "no-extension") {
        found = id;
        return last;
      }
    }
    return last;
  };
}

interface ChromeRuntime {
  sendMessage(id: string, msg: unknown, cb: (reply?: Reply) => void): void;
  lastError?: { message?: string };
}

export function createZoomRemoteSource(opts: {
  recordingUrl: string;
  send: Send;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): PlayerSource {
  const { recordingUrl, send } = opts;
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const store = createStore<PlayerState>({ ...INITIAL_STATE });
  let timer: unknown = null;
  let disposed = false;
  // Where the recording should be before it plays, until the extension confirms it got there.
  // Kept while the tab or frame isn't there yet (no-tab), and sent again once it is.
  let target: number | null = null;
  // The student asked to play; the play request goes out only after `target` is confirmed.
  let wantPlay = false;
  // The confirmed position the play request carries, so the extension seeks again before playing.
  let playFrom: number | null = null;
  let unconfirmed = 0;
  // Sticky until a later seek is confirmed, so status polls don't clear the error state.
  let seekFailed = false;
  let running: Promise<void> | null = null;

  function apply(reply: Reply) {
    if (reply.ok) {
      if (reply.state) {
        store.set({ ...reply.state, ready: true, needsGesture: false, error: seekFailed ? SEEK_FAILED : null, sampledAt: now() });
      }
    } else if (reply.error === "no-tab") {
      store.set({ ready: false });
    } else if (reply.error === "needs-gesture") {
      store.set({ needsGesture: true, paused: true });
    } else {
      store.set({ error: MESSAGES[reply.error] ?? reply.error });
    }
  }

  const near = (state: RemoteState | null | undefined, t: number) =>
    !!state && typeof state.currentTime === "number" && Math.abs(state.currentTime - t) <= SEEK_TOLERANCE;

  function failSeek() {
    target = null;
    wantPlay = false;
    unconfirmed = 0;
    seekFailed = true;
    store.set({ error: SEEK_FAILED });
  }

  // Seek, confirm with status, then play, one step at a time, so play never reaches the recording
  // before it is at the target. Stops while the tab/frame isn't there; the next status poll resumes.
  async function drive() {
    while (!disposed) {
      if (target !== null) {
        const t = target;
        const r = await send({ type: "seek", seconds: t, background: true, recordingUrl });
        if (disposed) return;
        if (!r.ok) {
          if (r.error === "seek-failed") return failSeek();
          apply(r);
          if (r.error !== "no-tab") {
            target = null;
            wantPlay = false;
          }
          return;
        }
        apply(r);
        const st = await send({ type: "status", recordingUrl });
        if (disposed) return;
        apply(st);
        if (!st.ok) return;
        if (target !== t) continue; // a newer seek came in meanwhile
        if (near(st.state, t)) {
          target = null;
          unconfirmed = 0;
          playFrom = t;
          if (seekFailed) {
            seekFailed = false;
            store.set({ error: null });
          }
        } else if (++unconfirmed >= SEEK_CONFIRM_TRIES) {
          return failSeek();
        }
        continue;
      }
      if (wantPlay) {
        wantPlay = false;
        const from = playFrom;
        playFrom = null;
        const r = await send({ type: "play", background: true, recordingUrl, ...(from === null ? {} : { seconds: from }) });
        if (disposed) return;
        if (!r.ok && r.error === "seek-failed") return failSeek();
        apply(r);
        continue;
      }
      return;
    }
  }

  function run(): Promise<void> {
    if (!running) {
      running = drive().finally(() => {
        running = null;
        schedule();
      });
    }
    return running;
  }

  async function poll() {
    timer = null;
    if (disposed) return;
    const reply = await send({ type: "status", recordingUrl });
    apply(reply);
    // The tab or frame is there now: deliver a seek (and play) that found nobody earlier.
    if (reply.ok && (target !== null || wantPlay) && !running) void run();
    schedule();
  }

  function schedule() {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    const fast = !store.get().paused || target !== null || wantPlay;
    timer = setTimer(poll, fast ? POLL_PLAYING_MS : POLL_PAUSED_MS);
  }

  async function command(msg: Record<string, unknown>) {
    apply(await send({ ...msg, recordingUrl }));
    schedule();
  }

  void poll();

  return {
    kind: "zoom-remote",
    getState: store.get,
    subscribe: store.subscribe,
    /** With `from`: seek there, wait for the extension to confirm it, then play (the request carries the seek again). */
    play(from) {
      if (from !== undefined) {
        target = Math.max(0, from);
        unconfirmed = 0;
      } else if (target === null) {
        playFrom = null;
      }
      wantPlay = true;
      return run();
    },
    pause() {
      wantPlay = false;
      return command({ type: "pause" });
    },
    seek(seconds) {
      target = Math.max(0, seconds);
      unconfirmed = 0;
      return run();
    },
    setRate: (value) => command({ type: "rate", value }),
    async reveal() {
      await send({ type: "focus", recordingUrl });
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
    },
  };
}
