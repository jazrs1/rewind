// zoom-embed: the recording plays in an iframe inside our page, driven by the extension
// through the frame's content script (T9). If the frame's player isn't ready in time
// (no extension, no third-party-cookie exception, or the frame never loads), the player
// falls back to zoom-remote (a background Zoom tab, T7) on its own.

import { createStore, type PlayerSource, type PlayerState } from "./types.ts";
import { createZoomRemoteSource, SEEK_FAILED, type Reply, type Send } from "./zoom-remote.ts";

export type EmbedMedia = { kind: "video" | "audio"; videoWidth: number | null; videoHeight: number | null };

/** zoom-remote's client with `embed: true` on every message; remembers the frame's media kind. */
export function createZoomEmbedSource(opts: {
  recordingUrl: string;
  send: Send;
  onMedia?: (m: EmbedMedia) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): PlayerSource {
  let embedModeSent = false;
  const send: Send = async (msg) => {
    const reply = (await opts.send({ ...msg, embed: true })) as Reply & { media?: EmbedMedia };
    if (reply.ok && reply.media) {
      opts.onMedia?.(reply.media);
      // Once the frame's player answers, hide Zoom's own UI so only the media shows under our controls.
      if (!embedModeSent) {
        embedModeSent = true;
        void opts.send({ type: "embedMode", recordingUrl: opts.recordingUrl, embed: true, on: true });
      }
    }
    // A missing frame just means "not ready yet" here; the fallback decides when to give up.
    return reply.ok || reply.error !== "no-frame" ? reply : { ok: false, error: "no-tab" };
  };
  const src = createZoomRemoteSource({ ...opts, send });
  return {
    ...src,
    kind: "zoom-embed",
    async reveal() {
      // Nothing to bring forward: the frame is already on the page.
    },
  };
}

/** Embed first, then zoom-remote if the embedded player isn't ready within `graceMs`. */
export function createEmbedWithFallback(opts: {
  embed: PlayerSource;
  makeFallback: () => PlayerSource;
  graceMs: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): PlayerSource & { activeKind(): "zoom-embed" | "zoom-remote" } {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let current = opts.embed;
  let switched = false;
  // The student's latest intent, replayed on the fallback so nothing is lost in the switch.
  let intent: { type: "play"; from?: number } | { type: "seek"; seconds: number } | null = null;
  const store = createStore<PlayerState>(current.getState());
  let timer: unknown = null;

  function fallBack() {
    if (switched) return;
    switched = true;
    if (timer !== null) clearTimer(timer);
    unsubscribe();
    current.dispose();
    current = opts.makeFallback();
    unsubscribe = current.subscribe(() => store.set(current.getState()));
    store.set(current.getState());
    if (intent?.type === "play") void current.play(intent.from);
    else if (intent?.type === "seek") void current.seek(intent.seconds);
  }

  let unsubscribe = current.subscribe(() => {
    // The frame's recording wouldn't move to the clip: try a Zoom tab before giving up.
    if (current.getState().error === SEEK_FAILED) fallBack();
    else store.set(current.getState());
  });

  timer = setTimer(() => {
    if (!current.getState().ready) fallBack();
  }, opts.graceMs);

  return {
    kind: "zoom-embed",
    activeKind: () => (switched ? "zoom-remote" : "zoom-embed"),
    getState: store.get,
    subscribe: store.subscribe,
    play(from) {
      // A resume keeps a seek that hasn't been played yet (the clip start from cue()).
      const pending = intent?.type === "seek" ? intent.seconds : intent?.type === "play" ? intent.from : undefined;
      intent = { type: "play", from: from ?? pending };
      return current.play(from);
    },
    pause() {
      if (intent?.type === "play") intent = null;
      return current.pause();
    },
    seek(seconds) {
      intent = intent?.type === "play" ? { type: "play", from: seconds } : { type: "seek", seconds };
      return current.seek(seconds);
    },
    setRate: (r) => current.setRate(r),
    reveal: () => current.reveal?.() ?? Promise.resolve(),
    dispose() {
      clearTimer(timer);
      unsubscribe();
      current.dispose();
    },
  };
}
