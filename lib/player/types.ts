// The Rewind player plays a clip from one of these sources:
// - zoom-embed (primary): the student's Zoom recording in an iframe on our page, driven by the
//   extension through the frame (T9); needs the third-party-cookie exception for our origin.
//   Falls back to zoom-remote on its own if the frame's player isn't ready in time.
// - zoom-remote: the student's own Zoom recording, playing in a background tab that the
//   extension drives (Zoom can't be embedded). See T7 in AGENT_TASKS.md.
// - hosted-media: an approved clip we host, for demo mode: video of the professor's screen
//   share (mp4) or audio. `offset`: the lecture second the file starts at (a clip cut from the
//   lecture), so the player still speaks lecture time.
// - none: demo mode, a clip whose recording we don't host; the player shows the clip's transcript.

export type SourceConfig =
  | { kind: "hosted-media"; src: string; offset?: number }
  | { kind: "none" }
  | { kind: "zoom-remote"; extensionId: string; recordingUrl: string }
  | { kind: "zoom-embed"; extensionId: string; recordingUrl: string };

export interface PlayerState {
  /** The source can be played and reports time. */
  ready: boolean;
  currentTime: number;
  paused: boolean;
  rate: number;
  duration: number | null;
  /** The browser blocked play() until the student clicks (in the Zoom tab, for zoom-remote). */
  needsGesture: boolean;
  error: string | null;
  /** performance.now() when currentTime was read, so the UI can extrapolate between updates. */
  sampledAt: number;
}

export const INITIAL_STATE: PlayerState = {
  ready: false,
  currentTime: 0,
  paused: true,
  rate: 1,
  duration: null,
  needsGesture: false,
  error: null,
  sampledAt: 0,
};

export interface PlayerSource {
  kind: SourceConfig["kind"];
  getState(): PlayerState;
  subscribe(listener: () => void): () => void;
  /** Plays, seeking first when `from` is given. */
  play(from?: number): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  /** zoom-remote: bring the Zoom tab forward (after needsGesture). */
  reveal?(): Promise<void>;
  dispose(): void;
}

/** Current time, extrapolated from the last sample while playing. */
export function liveTime(s: PlayerState, now: number): number {
  if (s.paused || !s.ready) return s.currentTime;
  return s.currentTime + (Math.max(0, now - s.sampledAt) / 1000) * s.rate;
}

/** A tiny observable state holder shared by the sources and the clip controller. */
export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T>) {
      state = { ...state, ...patch };
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
