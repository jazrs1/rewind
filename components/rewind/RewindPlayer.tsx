"use client";

// The rewind: the slide with a live caption, reels and counter, and clip controls.
// Plays from the student's Zoom tab (zoom-remote) or a clip we host (hosted-media: video of
// the screen share, shown in the slide frame, or audio).

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from "react";
import { formatTime } from "@/lib/format";
import { DUR, easeInOut, prefersReducedMotion } from "@/lib/motion";
import { captionIndex, clipProgress, createClipController, displayTime, hostedTranscriptLines, lineScrollTarget, showsCaptionBand, transcriptPanelHeight, type Clip, type ClipController, type ClipState } from "@/lib/player/clip";
import { createHostedMediaSource, createNoMediaSource, isVideo, LOAD_FAILED, NOT_HOSTED } from "@/lib/player/hosted-media";
import { clipTimeAt, createSeekThrottle, keyTarget, scrubValueText, type SeekThrottle } from "@/lib/player/scrub";
import type { PlayerSource, SourceConfig } from "@/lib/player/types";
import { createEmbedWithFallback, createZoomEmbedSource, type EmbedMedia } from "@/lib/player/zoom-embed";
import { createZoomRemoteSource, extensionSender, NO_EXTENSION } from "@/lib/player/zoom-remote";
import type { TranscriptSegment } from "@/lib/schema";
import { LateLine, SlideFrameSkeleton } from "./DeckSkeleton";
import { EmbedSetupCard } from "./EmbedSetupCard";
import { PACK_MIN, Reels, type ReelMode } from "./Reels";
import { Back10, KeepListening, Pause, Play } from "@/components/icons";
import { SourceLabel } from "@/components/source/SourceLabel";

export interface RewindPlayerProps {
  source: SourceConfig;
  clip: Clip;
  /** Lecturer lines around the clip, for captions and the transcript. */
  segments: TranscriptSegment[];
  lecturer: string;
  /** The matching slide. Without one (e.g. an exam-radar moment) the frame shows the caption large instead. */
  slide?: {
    /** The source label under the frame, e.g. "Slide 84 · Sets, Maps & Hash Tables". */
    label: string;
    imageSrc?: string;
    alt?: string;
    /** Opens the slide: its deck in Canvas, or the slide image. */
    href?: string;
    /** "Open in Canvas", or "Open slide" for the image. */
    hrefLabel?: string;
  };
  /** The counter rolls back from here to the clip start. Defaults to 4 minutes after the start. */
  rollFrom?: number;
  /** One grounded line on what he's in the middle of (RewindMatch.setup). */
  setup?: string | null;
  /** Where the example the clip is part of begins (RewindMatch.exampleStart). */
  exampleStart?: number | null;
  /** The handwritten line above the controls. */
  rewoundText?: string;
  /** The module's tape colour (CSS colour): it carries into the player header so the student feels where they are. */
  accent?: string;
  /** Milliseconds to hold before the rewind starts, e.g. while the answer sheet folds into its strip. */
  rollDelay?: number;
  /** Told whether the clip has the stage: rewinding, loading to play, or playing. Not when paused, ended or failed. */
  onActiveChange?(active: boolean): void;
  /** With this, the page shows the embed setup card where it has room (told when it's needed); without, the player shows it under the controls. */
  onSetupCardChange?(show: boolean): void;
  /**
   * False: mounted ahead (e.g. hidden during the grading beat) so the recording cues at the clip start,
   * but the rewind and playback wait. True starts the rewind; back to false pauses. Default true.
   */
  started?: boolean;
  /** Shown between the player's header and the slide (the page's compact graded summary while the tutor is open). */
  aboveSlide?: ReactNode;
  /** The tutor is open beside the player (desktop): no setup line, a two-line transcript, and the page's next step is the one primary. */
  tutorMode?: boolean;
  /** With no slide (and no video), leave the picture frame out instead of filling it with the caption. */
  frameless?: boolean;
}

/** The rewind: the counter rolls down and the reels spin back, slowing at the end (--dur-rewind). */
const ROLL_MS = DUR.rewind;
/** How far the reels turn back over the rewind: a multiple of 60 degrees (six hub teeth), so the play spin picks up seamlessly. */
const REEL_TURN = -840;
/** Real time a counter digit takes to roll over to the next one. */
const DIGIT_ROLL_S = 0.08;

/** How long the embedded frame gets to report a ready player before we fall back to a Zoom tab. */
const EMBED_GRACE_MS = 8000;
/** After this long without a ready recording (any source, the Zoom fallback included), the player falls back to the transcript. */
const STUCK_MS = 25_000;

function createSource(config: SourceConfig, media: HTMLMediaElement | null, onMedia: (m: EmbedMedia) => void): PlayerSource {
  if (config.kind === "zoom-remote") {
    return createZoomRemoteSource({ recordingUrl: config.recordingUrl, send: extensionSender(config.extensionId) });
  }
  if (config.kind === "zoom-embed") {
    const send = extensionSender(config.extensionId);
    return createEmbedWithFallback({
      embed: createZoomEmbedSource({ recordingUrl: config.recordingUrl, send, onMedia }),
      makeFallback: () => createZoomRemoteSource({ recordingUrl: config.recordingUrl, send }),
      graceMs: EMBED_GRACE_MS,
    });
  }
  if (config.kind === "none") return createNoMediaSource();
  if (!media) throw new Error("hosted-media needs its media element");
  return createHostedMediaSource(media, undefined, undefined, undefined, config.offset ?? 0);
}

function spokenTime(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [h && `${h} hour${h > 1 ? "s" : ""}`, `${m} minute${m === 1 ? "" : "s"}`, `${s % 60} seconds`];
  return parts.filter(Boolean).join(" ");
}

/** The counter's wheels, left to right, as in formatTime: h:mm:ss, or m:ss under an hour. */
const WHEELS = [
  { id: "h", unit: 3600, base: 10 },
  { id: ":h" },
  { id: "m10", unit: 600, base: 6 },
  { id: "m1", unit: 60, base: 10 },
  { id: ":m" },
  { id: "s10", unit: 10, base: 6 },
  { id: "s1", unit: 1, base: 10 },
] as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * The time the counter shows at counter time `v`, moving at `speed` counter-seconds per second: whole
 * seconds, plus how far the seconds wheel is through rolling to its next digit. The roll lasts about
 * DIGIT_ROLL_S of real time; when the seconds change faster than every 3 frames they snap to whole digits,
 * so every frame stays readable. At rest (speed 0) it is the whole second, as formatTime shows it.
 */
function shownTime(v: number, speed: number): number {
  const whole = Math.floor(v);
  const span = Math.min(0.5, speed * DIGIT_ROLL_S);
  let frac = span > 0 ? smooth(clamp01((v - whole - (1 - span)) / span)) : 0;
  const readable = speed > 0 ? clamp01((1 / speed - 0.05) / 0.05) : 1;
  frac = readable * frac + (1 - readable) * Math.round(frac);
  return whole + frac;
}

/**
 * Where one wheel sits (in digits) when the counter shows `t` (from shownTime). Like a tape counter, a wheel
 * only moves while every wheel to its right rolls over from its last digit, and exactly as far as the seconds
 * wheel has rolled, so the carry and the wrap happen together and every frame reads one time between the
 * start and the target (never 16:01 then 16:57).
 */
function wheelPos(t: number, unit: number, base: number): number {
  const whole = Math.floor(t / unit);
  return (whole % base) + clamp01(t - whole * unit - (unit - 1));
}

/** Positions and visibility of every wheel; leading zeros drop out exactly as formatTime drops them. */
function wheelLayout(v: number, speed: number) {
  const pos: Record<string, number> = {};
  const t = shownTime(Math.max(0, v), speed);
  for (const w of WHEELS) if ("unit" in w) pos[w.id] = wheelPos(t, w.unit, w.base);
  const showH = pos.h > 0;
  const shown: Record<string, boolean> = { h: showH, ":h": showH, m10: showH || pos.m10 > 0, m1: true, ":m": true, s10: true, s1: true };
  return { pos, shown };
}

/** The counter at rest: the same drums (one per digit) and separators as while it rolls, so it reads as wheels. */
function Counter({ time }: { time: number }) {
  return (
    <div className="flex font-display text-[22px] leading-none font-extrabold tabular-nums lg:text-[26px] @max-[260px]:text-[22px] @max-[200px]:text-[18px]" aria-hidden="true" data-counter="">
      {[...formatTime(time)].map((ch, i) =>
        ch === ":" ? (
          <span key={i} data-sep="">
            :
          </span>
        ) : (
          <span key={i} data-drum="" className="h-[1em]">
            {ch}
          </span>
        ),
      )}
    </div>
  );
}

/** The counter while it rolls: one drum of digits per place, moved by paintOdometer. */
function Odometer({ value, ref }: { value: number; ref: Ref<HTMLDivElement> }) {
  const { pos, shown } = wheelLayout(value, 0);
  return (
    <div ref={ref} className="flex font-display text-[22px] leading-none font-extrabold tabular-nums lg:text-[26px] @max-[260px]:text-[22px] @max-[200px]:text-[18px]" aria-hidden="true" data-odometer="">
      {WHEELS.map((w) =>
        "unit" in w ? (
          <span key={w.id} data-w={w.id} data-drum="" className="h-[1em] overflow-hidden" style={{ display: shown[w.id] ? undefined : "none" }}>
            <span className="flex flex-col will-change-transform" style={{ transform: `translateY(${-pos[w.id]}em)` }}>
              {Array.from({ length: w.base + 1 }, (_, d) => (
                <span key={d} className="block h-[1em]">
                  {d % w.base}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span key={w.id} data-w={w.id} data-sep="" style={{ display: shown[w.id] ? undefined : "none" }}>
            :
          </span>
        ),
      )}
    </div>
  );
}

function paintOdometer(root: HTMLElement | null, v: number, speed: number) {
  if (!root) return;
  const { pos, shown } = wheelLayout(v, speed);
  for (const el of root.querySelectorAll<HTMLElement>("[data-w]")) {
    const id = el.dataset.w!;
    el.style.display = shown[id] ? "" : "none";
    const drum = el.firstElementChild as HTMLElement | null;
    if (drum) drum.style.transform = `translateY(${-pos[id]}em)`;
  }
}

function paintReels(svg: HTMLElement | null, angle: number | null, wound: number | null = null) {
  for (const g of svg?.querySelectorAll<SVGGElement>(".reel") ?? []) g.style.transform = angle === null ? "" : `rotate(${angle}deg)`;
  // The tape packs: rewinding winds the tape back onto the left reel, so its pack grows as the right one shrinks.
  for (const c of svg?.querySelectorAll<SVGCircleElement>("[data-pack]") ?? []) {
    if (wound === null) c.style.transform = c.dataset.pack === "left" ? "" : `scale(${PACK_MIN})`;
    else c.style.transform = `scale(${c.dataset.pack === "left" ? PACK_MIN + (1 - PACK_MIN) * wound : 1 - (1 - PACK_MIN) * wound})`;
  }
}

/** Rate of change of --ease-in-out at k (per unit of k), for the counter's digit blur. */
const easeInOutSlope = (k: number) => (easeInOut(Math.min(1, k + 0.01)) - easeInOut(Math.max(0, k - 0.01))) / (Math.min(1, k + 0.01) - Math.max(0, k - 0.01));


const noopSubscribe = () => () => {};

function useClipState(controller: ClipController | null): ClipState | null {
  return useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    () => controller?.getState() ?? null,
    () => null,
  );
}

const subscribeResize = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};

/** Rows the hosted transcript shows at this window height (5 on the server, before the window is known). */
function useHostedTranscriptLines(): number {
  return useSyncExternalStore(subscribeResize, () => hostedTranscriptLines(window.innerHeight), () => hostedTranscriptLines(900));
}

/** performance.now(), refreshed about 10 times a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 100) {
        last = t;
        setNow(t);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return now;
}

export function RewindPlayer({ source: config, clip, segments, lecturer, slide, rollFrom, setup, exampleStart, rewoundText, accent, rollDelay = 0, onActiveChange, onSetupCardChange, started = true, aboveSlide, tutorMode = false, frameless = false }: RewindPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [embedMedia, setEmbedMedia] = useState<EmbedMedia | null>(null);
  const hostedVideo = config.kind === "hosted-media" && isVideo(config.src);
  const [controller, setController] = useState<ClipController | null>(null);
  const [source, setSource] = useState<PlayerSource | null>(null);
  const [throttle, setThrottle] = useState<SeekThrottle | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const drag = useRef<{ id: number; x: number; started: boolean; last: number | null } | null>(null);
  // With reduced motion there is no rewind to watch: the counter starts at the clip time.
  const [rolling, setRolling] = useState(() => !prefersReducedMotion());
  const odometerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const reelsRef = useRef<HTMLDivElement>(null);
  const rollStart = Math.floor(rollFrom ?? clip.start + 240);
  const [announced, setAnnounced] = useState("");
  /** Without the recording: where the student is reading in the transcript (J, L, -10, the scrub bar and the lines move it). */
  const [readAt, setReadAt] = useState<number | null>(null);
  /** null: automatic (open only when the recording fails); true/false: the student's choice. */
  const [transcriptPref, setTranscriptPref] = useState<boolean | null>(null);
  const state = useClipState(controller);
  const firstPlayer = useMemo(() => controller?.getState().player, [controller]);
  const player = state?.player;
  // Whatever the source, a recording that hasn't loaded after STUCK_MS counts as failed: the transcript shows, nothing spins forever.
  const loading = !!controller && started && !player?.ready && !player?.error && !player?.needsGesture;
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setStuck(true), STUCK_MS);
    return () => {
      clearTimeout(t);
      setStuck(false);
    };
  }, [loading]);
  // No media reports NOT_HOSTED from the start; known before the controller exists (it's created after mount), so the
  // first frame has no caption band to drop a frame later (the band's height sets the player column's width).
  const error = player?.error ?? (!controller && config.kind === "none" ? NOT_HOSTED : null) ?? (stuck && loading ? LOAD_FAILED : null);
  const failed = !!error;
  // What a key that can't act says on hover: the demo has no recordings at all (John, Oct 25).
  const keyReason = error === NOT_HOSTED ? "No recording in the demo" : "No recording to play here: the transcript below follows the clip";
  // Given up on: stop asking for it, so a recording that answers late doesn't start playing under the transcript.
  useEffect(() => {
    if (stuck) void controller?.pause();
  }, [stuck, controller]);
  // A failed recording is stopped, whatever its element last said (a hung one still reads as not paused).
  const playing = !!player && !player.paused && !failed;
  const now = useNow(playing);
  const configKey = JSON.stringify(config);
  // The slide image shows once it has loaded; until then its frame is a skeleton. A cached (preloaded)
  // image is complete at mount and shows in the first frame.
  const [slideLoaded, setSlideLoaded] = useState(() => {
    if (!slide?.imageSrc || typeof window === "undefined") return false;
    const probe = new Image();
    probe.src = slide.imageSrc;
    return probe.complete && probe.naturalWidth > 0;
  });

  // One source per clip; preload it at the clip start.
  useEffect(() => {
    const src = createSource(JSON.parse(configKey) as SourceConfig, mediaRef.current, setEmbedMedia);
    const ctl = createClipController(src, { start: clip.start, end: clip.end });
    void ctl.cue();
    // The scrub's seeks, throttled; the scrub time clears once they have all settled and the drag is over.
    const th = createSeekThrottle((t) => ctl.seekTo(t), {
      onIdle: () => {
        if (!drag.current) setScrub(null);
      },
    });
    // The media element and extension polling are browser-only, so they are created after mount.
    setSource(src);
    setController(ctl);
    setThrottle(th);
    return () => {
      th.dispose();
      ctl.dispose();
      src.dispose();
    };
  }, [configKey, clip.start, clip.end]);

  // The rewind: after `rollDelay`, the reels spin back while the counter rolls down to the clip start
  // (--dur-rewind on --ease-in-out: they spin up, run, and slow to land, all on one curve, with the tape
  // packs resizing as the tape winds back), then it plays. Painted straight to the DOM each frame
  // (transform only) so the rest of the player doesn't re-render 60 times a second.
  useEffect(() => {
    if (!controller || !started) return;
    const to = Math.floor(clip.start);
    const finish = () => {
      paintReels(reelsRef.current, null);
      setRolling(false);
      setAnnounced(`Rewound to ${spokenTime(clip.start)}`);
      void controller.play(true);
    };
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    let raf = 0;
    let first = true;
    const t0 = performance.now() + rollDelay;
    const step = (t: number) => {
      // A second rewind (after going back to the question) rolls again from the top.
      if (first) {
        first = false;
        setRolling(true);
      }
      const k = clamp01((t - t0) / ROLL_MS);
      const e = easeInOut(k);
      const v = rollStart + (to - rollStart) * e;
      const speed = (Math.abs(to - rollStart) * easeInOutSlope(k)) / (ROLL_MS / 1000);
      paintOdometer(odometerRef.current, v, k > 0 && k < 1 ? speed : 0);
      paintReels(reelsRef.current, REEL_TURN * e, e);
      if (k < 1) raf = requestAnimationFrame(step);
      else finish();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [controller, clip.start, rollStart, rollDelay, started]);

  // Stopped (back to the question): pause, so nothing plays out of sight.
  const wasStarted = useRef(started);
  useEffect(() => {
    if (wasStarted.current && !started) void controller?.pause();
    wasStarted.current = started;
  }, [started, controller]);

  // Until the source reports it is at the clip start (the Zoom frame may answer at 0:00 before its
  // seek lands), show the clip start.
  // While the student scrubs (drags, taps or steps with the keys), the counter and the caption follow the
  // scrub at once; the seeks follow it, throttled to about 4 a second, through source.seek. The scrub time
  // holds until every seek has settled, so the counter never jumps back to where the recording was.
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  // No recording (no extension, it failed or it hung; `failed` above): the controls act on the transcript instead.
  const time = failed ? (readAt ?? clip.start) : (scrub ?? (state ? displayTime(state, clip, now) : clip.start));
  // After "Keep listening" the scrub window grows past the clip (in 2-minute steps, never past the recording), so the counter and bar follow the playback.
  const keep = !!state?.keepListening;
  const win: Clip = keep ? { start: clip.start, end: Math.min(player?.duration ?? Infinity, clip.end + 120 * Math.ceil(Math.max(0, time - clip.end + 20) / 120)) } : clip;
  const progress = clipProgress(win, time);
  const pastEnd = keep && time > clip.end;
  // Keep listening only when the recording goes on past the clip: a hosted clip trimmed to its window ends where the
  // clip does, so it isn't offered (the transcript still reads on past the clip).
  const playsOn = !error && (player?.duration == null || player.duration > clip.end + 1);
  // The clip's first line: the first one still going at the clip start (the line before may end in the gap just before it).
  const clipFirst = segments.findIndex((s) => s.end > clip.start);
  // With no recording to follow, the transcript starts at the clip's first line until the student moves it.
  const current = failed && readAt === null ? clipFirst : captionIndex(segments, time);
  /** Says it aloud (and again when it's the same words: a live region skips a repeat). */
  const announce = useCallback((text: string) => setAnnounced((prev) => (prev === text ? `${text} ` : text)), []);
  const cantPlay = "The recording can't play here; the transcript below follows the clip.";
  /** Without a recording Play and the speed key are disabled, with this as their reason (and the alert in the transcript panel). */
  const reasonId = useId();
  /** Play or speed was pressed without the recording: the note shows, not just its announcement. */
  const [triedPlay, setTriedPlay] = useState(false);
  /** Without the recording: move the reading position, and say the line it lands on. */
  const readTo = useCallback(
    (t: number) => {
      const at = Math.min(clip.end, Math.max(clip.start, t));
      setReadAt(at);
      const line = segments[captionIndex(segments, at)];
      announce(line ? `${formatTime(line.start)}: ${line.text}` : formatTime(at));
    },
    [clip.start, clip.end, segments, announce],
  );
  const caption = current >= 0 && time <= (keep ? (segments.at(-1)?.end ?? clip.end) : clip.end) + 2 ? segments[current].text : "";
  const reelMode: ReelMode = rolling ? "rewind" : playing ? "play" : "idle";
  // Played to the end, then scrubbed (or stepped) back into the clip: it's no longer at its end.
  const ended = !!state?.ended && time >= clip.end - 0.5;
  // Phone: the pinned Next bar must never hide the controls. Once the clip has the stage (and again at its end, when
  // Replay and Keep listening appear) the controls card is scrolled up above the bar (the page's scroll-padding keeps it clear).
  useEffect(() => {
    if (!started || rolling || !window.matchMedia("(max-width: 1023.98px)").matches) return;
    const card = cardRef.current;
    if (!card) return;
    // Only when the bar (or the top of the screen) hides it: controls already in view stay where they are, so the page
    // never glides under the reader (or under the landing, which can't know yet whether the recording will answer).
    const r = card.getBoundingClientRect();
    const clear = window.innerHeight - (parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0);
    if (r.top >= 0 && r.bottom <= clear + 0.5) return;
    card.scrollIntoView({ block: "end", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [started, rolling, ended]);

  const togglePlay = useCallback(() => {
    if (failed) {
      setTriedPlay(true);
      return announce(cantPlay);
    }
    if (!controller) return;
    const s = controller.getState();
    // The clip ended and the student moved back into it: play on from there, not from the clip start.
    if (s.ended && s.player.paused && s.player.currentTime < clip.end - 0.5) return void source?.play();
    return void controller.toggle();
  }, [controller, source, clip.end, failed, announce, cantPlay]);
  const skip = useCallback((sec: number) => (failed ? readTo(time + sec) : void (sec < 0 ? controller?.back() : controller?.forward())), [failed, readTo, time, controller]);

  // Keyboard: Space plays or pauses, J and L skip 10 s (without the recording: through the transcript).
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (!controller || !started || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === " " && el?.tagName !== "BUTTON") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "j" || e.key === "J") skip(-10);
      else if (e.key === "l" || e.key === "L") skip(10);
    },
    [controller, togglePlay, skip, started],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  // Keep the current line (or the clip's first line before playback) in view inside the transcript list.
  const listRef = useRef<HTMLOListElement>(null);
  const focusLine = current >= 0 ? current : clipFirst;
  useEffect(() => {
    const list = listRef.current;
    const item = list?.children[focusLine] as HTMLElement | undefined;
    if (!list || !item) return;
    // The rows' exact offsets in the list's content (offsetTop rounds, and rows can sit on fractional pixels).
    const target = () => {
      const base = list.getBoundingClientRect().top - list.scrollTop;
      const rows = Array.from(list.children, (li) => {
        const r = li.getBoundingClientRect();
        return { top: r.top - base, height: r.height };
      });
      // On a row boundary, so no line is cut at the top, a long paragraph included (lineScrollTarget in lib/player/clip.ts).
      return lineScrollTarget(rows, focusLine, { scrollTop: list.scrollTop, height: list.clientHeight }) ?? list.scrollTop;
    };
    if (Math.abs(target() - list.scrollTop) >= 1) {
      // Following the line as it plays is smooth. Landing on the clip (nothing playing yet) is a jump, so the list is
      // in place when the screen settles, and it lands again once the fonts are in (they can move the rows a pixel),
      // unless the reader has scrolled it meanwhile.
      if (current >= 0 && !prefersReducedMotion()) {
        list.scrollTo({ top: target(), behavior: "smooth" });
      } else {
        list.scrollTop = target();
        const landed = list.scrollTop;
        void document.fonts?.ready.then(() => {
          if (Math.abs(list.scrollTop - landed) < 1) list.scrollTop = target();
        });
      }
    }
    // Again once shown: a list scrolled while out of sight (the grading beat) may not have moved.
  }, [focusLine, current, transcriptPref, failed, started]);

  // zoom-embed: the recording's own page in an iframe. For a video recording the frame IS the slide
  // (his screen share); for audio-only it stays out of sight and our slide image shows.
  const embedActive = config.kind === "zoom-embed" && (source as { activeKind?: () => string } | null)?.activeKind?.() !== "zoom-remote";
  const embedIsSlide = embedActive && embedMedia?.kind === "video" && !!player?.ready;
  const embedFrame = embedActive ? (
    <iframe
      src={config.recordingUrl}
      title={`${lecturer}'s lecture recording`}
      allow="autoplay; encrypted-media; fullscreen"
      aria-hidden={embedIsSlide ? undefined : true}
      tabIndex={embedIsSlide ? undefined : -1}
      className={embedIsSlide ? "absolute inset-0 h-full w-full border-0 bg-black" : "pointer-events-none absolute top-0 left-0 size-px border-0 opacity-0"}
    />
  ) : null;

  // Until the source reports ready, what depends on it is a skeleton in the same boxes: the play controls,
  // the time left, and a slide frame with nothing to show yet. The counter stays: it carries the rewind
  // and the time it lands on, which we already know. Only once the source has answered (its state is no longer
  // the one it started with): an answer that comes at once (ready, or no extension) shows no skeleton frame.
  const answered = !!player && player !== firstPlayer;
  const waiting = answered && !player.ready && !error && !player.needsGesture;
  // The transcript opens by itself when the recording fails; the student can still close it.
  const transcriptOpen = transcriptPref ?? !!error;
  const linkCls = "btn btn-tertiary";
  const waitText =
    config.kind === "hosted-media"
      ? "Loading the clip…"
      : embedActive
        ? "Loading the Zoom recording…"
        : "Opening the recording in a Zoom tab…";
  const secondsLeft = Math.ceil(clip.end - Math.min(time, clip.end));
  const leftText = pastEnd ? "Past the clip" : `${secondsLeft} seconds left`;
  const shortLeft = pastEnd ? "Past the clip" : `${secondsLeft} s left`;
  // Shown for the first 3 s of a wait as a bar, then as the line saying what's happening (PLAN, Usability).
  const waitLine = <LateLine key={waitText} bar="w-28">{waitText}</LateLine>;
  // Balanced, so a two-line wrap on a phone never leaves "IT" alone on the second line.
  const rewoundLine = <p data-eyebrow="" className="text-[13px] leading-none font-bold tracking-[0.06em] text-balance text-peach uppercase">{rewoundText ?? `Rewound to where ${lecturer} explains it`}</p>;
  const slideShown = !!slide?.imageSrc && slideLoaded;

  // When the recording fails the transcript is what he said, so it opens inside the panel right under
  // "Here's what he said", in a list short enough to stay on screen (it scrolls).
  // One primary button per screen: while the clip has the stage, Play/Pause is it and the page's next step steps back.
  const active = !error && (rolling || playing || waiting || !answered);
  // Exactly one orange control: Play/Pause while the clip has the stage, the page's next step otherwise.
  // A page with no next step to hand it to (the radar) keeps Play/Pause as its primary.
  // A disabled key (no recording) is never the primary.
  const playPrimary = !tutorMode && !failed && (active || !onActiveChange);

  // Scrubbing needs the recording: not during the rewind or while it loads. Once it has failed, the
  // scrub bar moves through the transcript instead.
  const scrubbable = !rolling && (failed || (!!throttle && !!player?.ready));
  const timeAtX = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return clipTimeAt(win, (clientX - r.left) / r.width);
  };
  const scrubTo = (t: number, final: boolean) => {
    if (failed) {
      // A drag moves the line quietly (the slider's value text says where); a tap or key says the line.
      if (final || !drag.current) readTo(t);
      else setReadAt(t);
      return;
    }
    if (drag.current) drag.current.last = t;
    setScrub(t);
    if (final) void throttle?.flush(t);
    else throttle?.request(t);
  };
  // A mouse scrubs from the press. A finger scrubs once it moves sideways (or lifts: a tap jumps), so a
  // vertical swipe that starts on the bar still scrolls the page and seeks nothing.
  const onScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbable || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    const mouse = e.pointerType === "mouse";
    drag.current = { id: e.pointerId, x: e.clientX, started: mouse, last: null };
    if (mouse) scrubTo(timeAtX(e.clientX), false);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbable) return;
    if (e.pointerType === "mouse") {
      const r = trackRef.current!.getBoundingClientRect();
      setHover({ t: timeAtX(e.clientX), x: Math.min(r.width, Math.max(0, e.clientX - r.left)) });
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.started && Math.abs(e.clientX - d.x) < 6) return;
    d.started = true;
    scrubTo(timeAtX(e.clientX), false);
  };
  const onScrubUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    scrubTo(timeAtX(e.clientX), true);
    drag.current = null;
  };
  const onScrubCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    // The page took the gesture over: keep where the drag got to, or, if it never started, change nothing.
    if (d.started && d.last !== null) void throttle?.flush(d.last);
  };
  const onScrubKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!scrubbable || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = keyTarget(win, time, e.key, e.shiftKey);
    if (t === null) return;
    e.preventDefault();
    scrubTo(t, false);
  };
  const hoverLine = hover ? segments[captionIndex(segments, hover.t)]?.text : undefined;
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);
  const setupCard = config.kind === "zoom-embed" && !embedActive && !error;
  useEffect(() => {
    onSetupCardChange?.(setupCard);
  }, [setupCard, onSetupCardChange]);

  /** Play from where the example begins. Seeking and listening on need the recording, so it waits for it. */
  // Phone: an outlined button under the controls. Desktop: a quiet one in the transcript's header, so it costs no row.
  const exampleButton = (where: string, quiet = false) =>
    !error && exampleStart != null && exampleStart < clip.start - 1 ? (
      waiting ? (
        <span aria-hidden="true" data-skel="example" className={`skeleton h-11 w-64 max-w-full rounded-[10px] bg-tape-blank ${where}`} />
      ) : (
        <button
          type="button"
          onClick={() => controller?.seekTo(exampleStart).then(() => controller.play())}
          className={quiet ? `btn btn-tertiary min-h-11 text-sm whitespace-nowrap ${where}` : `btn btn-secondary min-h-11 self-start px-3 text-[15px] ${where}`}
        >
          From the start of the example (−{formatTime(clip.start - exampleStart)})
        </button>
      )
    ) : null;

  const captionBand = showsCaptionBand({ slide: !!slide, failed: !!error, hostedVideo: config.kind === "hosted-media" && hostedVideo });
  const hostedLines = useHostedTranscriptLines();
  // Under a hosted clip: whole rows plus the panel's padding, and the header row (min-h-5 + gap-1) above the list.
  const hostedPanel = !tutorMode && !captionBand && !!slide && !error && hostedVideo;
  // Desktop: the panel has a fixed height (about three lines; two while the caption band already shows the line he's
  // on; five to six under a hosted clip, which has no band), so a line above the list that wraps in a narrow column
  // takes room from the list, never from the page.
  const transcript = (
    <div className="flex min-h-0 flex-col gap-1 lg:flex-1">
      {error ? null : (
        <div className="flex min-h-5 items-center justify-between gap-3 px-1 text-[13px] text-label-faint">
          <span className="font-bold text-label-muted">Transcript</span>
          {exampleButton("hidden lg:inline-flex -my-3", true) ?? <span>Click a line to jump there</span>}
        </div>
      )}
      <ol ref={listRef} aria-label="Transcript" className="thin-scroll fade-end relative flex max-h-44 flex-col overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1">
        {segments.map((s, i) => {
          const now = i === current;
          return (
            <li key={`${s.start}-${i}`}>
              <button
                type="button"
                onClick={() => (failed ? readTo(s.start) : controller?.seekTo(s.start).then(() => controller.play()))}
                aria-current={now ? "true" : undefined}
                className={`flex min-h-11 w-full items-baseline gap-3.5 rounded-lg px-3 py-1.5 text-left text-sm leading-snug lg:text-[15px] ${
                  now ? "bg-deck font-bold text-label" : "text-label-muted"
                }`}
              >
                <span className={`w-12 flex-none text-[13px] font-normal tabular-nums ${now ? "text-peach" : ""}`}>{formatTime(s.start)}</span>
                <span>{s.text}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );

  return (
    <section aria-label="Lecture clip" aria-busy={waiting} className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-1 lg:gap-1.5">
        {/* The player's header: where the rewind landed, in his hand, above the picture it is about. */}
        {/* With the tutor open on desktop the summary strip says where this is, so the line gives its height to the slide. */}
        <div data-player-head="" style={accent ? { borderLeftColor: accent } : undefined} className={`flex items-baseline justify-between gap-3 ${accent ? "border-l-[6px] pl-3" : ""} ${tutorMode ? "lg:hidden" : ""}`}>
          {rewoundLine}
        </div>
        {setup && !tutorMode ? (
          // While the rewind's overlay shows this sentence, it holds its place here unseen (no double, no shift).
          <div className={`flex flex-col gap-0.5 ${rolling ? "invisible" : ""}`}>
            <p title={setup} className="line-clamp-2 max-w-[60ch] text-sm leading-snug text-label-muted">
              <span className="font-bold text-label">Where {lecturer} is: </span>
              {setup}
            </p>
            {/* The setup is a summary of what he said just before the clip: it keeps its source. */}
            {exampleStart != null && exampleStart < clip.start ? (
              <SourceLabel tone="deck">
                From the lecture, {formatTime(exampleStart)} to {formatTime(clip.start)}
              </SourceLabel>
            ) : null}
          </div>
        ) : null}
        {aboveSlide}
        {/* The slide or video fills the frame's width at 16:9, 12 px in from its edges: as big as its column
            lets it be (John's call, Oct 24: no height cap). When the recording failed there's no video to
            watch, so on desktop it gives up height to keep the transcript on screen. */}
        {frameless && !slide && !hostedVideo && !embedIsSlide ? null : (
        <figure data-player-figure="" className="flex w-full flex-col gap-1">
          <div data-slide-panel="" className={`relative flex w-full flex-col gap-2 overflow-hidden rounded-[10px] bg-slide p-3 text-deck lg:rounded-xl ${tutorMode ? "lg:p-2" : ""}`}>
          <div
            data-media=""
            className={`relative mx-auto aspect-video w-full overflow-hidden rounded-md ${
              ""
            }`}
          >
          {embedFrame}
          <div className={`absolute inset-0 flex items-center justify-center ${embedIsSlide ? "invisible" : ""}`}>
            {config.kind === "hosted-media" && hostedVideo ? (
              <video
                ref={mediaRef}
                src={config.src}
                preload="auto"
                playsInline
                aria-label={`${lecturer}'s lecture${slide ? `, ${slide.label}` : ""}`}
                className="h-full w-full object-contain"
              />
            ) : !slide || !slide.imageSrc ? (
              // No slide image (a Quick build lecture moment, an exam-radar moment): the live line, large. A grey
              // skeleton only while a real slide image is coming, never for a picture that doesn't exist.
              waiting && !slide ? (
                <SlideFrameSkeleton />
              ) : (
                // Fits the frame at every width: smaller on a phone, and a long line ends in an ellipsis (the transcript has it whole).
                <p data-slide-caption="" className="line-clamp-4 px-2 text-center font-sans text-base leading-snug text-deck sm:text-lg lg:line-clamp-6 lg:px-4 lg:text-2xl" aria-hidden="true">
                  {caption || "\u00a0"}
                </p>
              )
            ) : slide.imageSrc ? (
              <>
                {slideShown ? null : <SlideFrameSkeleton />}
                {/* Slides are page renders we host; next/image adds nothing for these. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={slide.imageSrc}
                  alt={slide.alt ?? slide.label}
                  onLoad={() => setSlideLoaded(true)}
                  className={`h-full w-full object-contain ${slideShown ? "" : "absolute opacity-0"}`}
                />
              </>
            ) : null}
          </div>
          </div>
          {/* The live caption has its own band under the picture, so it never covers the slide. The band
              always holds two lines (a shorter line sits in its middle), so nothing moves as lines change.
              No recording, no caption: the transcript says it. A hosted clip has Zoom's captions burned in, so
              no band either: the transcript's highlighted line is ours (John, Oct 25). */}
          {captionBand && slide?.imageSrc ? (
            // The box pads and the text inside it clamps, so a third line never shows in the padding.
            <p
              aria-hidden="true"
              data-caption-band=""
              className={`box-content flex h-[2lh] items-center justify-center rounded-md bg-deck px-2.5 py-1 text-center text-[13px] leading-snug text-label lg:text-sm ${tutorMode ? "lg:h-[1lh]" : ""}`}
            >
              {/* With the tutor open the band is one line (the transcript beside it has the words), so the slide keeps its width. */}
              <span data-caption="" className={tutorMode ? "line-clamp-2 lg:line-clamp-1" : "line-clamp-2"}>
                {caption || " "}
              </span>
            </p>
          ) : null}
          {rolling && setup ? (
            <p className="absolute inset-0 flex items-center justify-center bg-deck/90 px-6 text-center text-base leading-snug text-label lg:text-lg">
              <span className="block max-w-[60ch]">{setup}</span>
            </p>
          ) : null}
          </div>
          {/* The slide's source, under the frame: what it is, and a quiet way to open it. */}
          {/* Its link keeps a 44 px hit area but overlaps the gaps around it, so the row costs only its text; the row
              itself starts under the frame. */}
          <figcaption className="px-0.5 [&_a]:-my-2">
            <SourceLabel tone="deck" oneLine link={slide?.href ? { href: slide.href, label: slide.hrefLabel ?? "Open slide" } : null}>
              {slide ? slide.label : "No slide matched this moment"}
            </SourceLabel>
          </figcaption>
        </figure>
        )}
        {config.kind === "hosted-media" && !hostedVideo ? <audio ref={mediaRef} src={config.src} preload="auto" hidden /> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        {/* The transport: ONE tape-deck unit (brief B §2). Row 1, the deck face: on desktop the matched keys on the left
            (Play at the left edge, over where the scrub bar starts), then the tape window (reels and counter as one
            object), tops and bottoms on one line; on a phone the window, then the keys under it. Row 2: the scrub bar. */}
        <div ref={cardRef} data-transport="" className="deck-panel transport flex flex-col gap-2 rounded-xl bg-deck-raised p-3 lg:gap-2 lg:p-4">
          {/* Phone: the window on its own row and the keys under it, so both keep their spec sizes (40 px reels, 56x48 keys). */}
          <div className="flex flex-col items-center gap-2 lg:flex-row lg:items-stretch lg:gap-4">
            <div data-tape-window="" className="tape-window @container flex h-14 w-full min-w-0 items-center justify-center rounded-[10px] px-3 lg:h-auto lg:w-auto lg:flex-1 lg:px-2">
              {/* The reels take what the counter leaves, shrinking (never hiding: John, Oct 25) so h:mm:ss always fits beside them. */}
              <Reels ref={reelsRef} mode={reelMode} className="h-10 w-full max-w-[260px] gap-2 @max-[260px]:h-8 @max-[260px]:gap-1.5 @max-[200px]:h-6 @max-[200px]:gap-1">
                <div data-counter-group="" className="counter-plate flex items-center rounded-md px-2 py-1 lg:px-2.5">
                  {rolling ? (
                    <Odometer ref={odometerRef} value={rollStart} />
                  ) : (
                    <Counter time={time} />
                  )}
                </div>
              </Reels>
            </div>
            {/* The keys: a matched set of cream keycaps with engraved glyphs. Play stays down while it plays; the
                speed key stays down off 1×; a latched key shows its small orange light. */}
            <div className="tkeys lg:order-first" role="group" aria-label="Transport">
              {waiting ? (
                <>
                  <span className="tkey-slot"><span aria-hidden="true" data-skel="back" className="skeleton tkey-ph" /></span>
                  <span className="tkey-slot lg:order-first"><span aria-hidden="true" data-skel="play" className="skeleton tkey-ph" /></span>
                  <span className="tkey-slot"><span aria-hidden="true" data-skel="speed" className="skeleton tkey-ph" /></span>
                </>
              ) : (
                <>
                  <span className="tkey-slot">
                    <button type="button" aria-label="Back 10 seconds" onClick={() => skip(-10)} className="tkey">
                      <Back10 size={24} />
                    </button>
                  </span>
                  <span className="tkey-slot lg:order-first">
                    <button
                      type="button"
                      aria-label={playing ? "Pause clip" : "Play clip"}
                      onClick={togglePlay}
                      disabled={failed}
                      title={failed ? keyReason : undefined}
                      aria-describedby={failed ? reasonId : undefined}
                      data-primary={playPrimary ? "" : undefined}
                      data-latched={playing ? "" : undefined}
                      className="tkey"
                    >
                      {playing ? <Pause size={24} /> : <Play size={24} />}
                    </button>
                  </span>
                  <span className="tkey-slot">
                    <button
                      type="button"
                      aria-label={`Playback speed ${player?.rate ?? 1}x`}
                      onClick={() => controller?.cycleRate()}
                      disabled={failed}
                      title={failed ? keyReason : undefined}
                      aria-describedby={failed ? reasonId : undefined}
                      data-latched={(player?.rate ?? 1) !== 1 ? "" : undefined}
                      className="tkey"
                    >
                      <span className="tkey-text">{player?.rate ?? 1}×</span>
                    </button>
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Row 2: the scrub bar at full width, the clip's start and end at its ends, the time left above it on the right. */}
          <div className="relative flex flex-col">
            {/* Desktop: Replay, Keep listening and Open in Zoom at hand on the left of this line, the time left on its right. */}
            <div className="hidden h-6 items-center justify-between gap-3 text-[13px] leading-none text-label-muted tabular-nums lg:flex">
              <span className="-my-2.5 -ml-2 flex items-center gap-1 text-sm">
                {ended ? (
                  <button type="button" onClick={() => controller?.play(true)} className={linkCls}>
                    Replay
                  </button>
                ) : null}
                {playsOn ? (
                  <button type="button" onClick={() => controller?.keepListening()} className={linkCls}>
                    <KeepListening />
                    Keep listening
                  </button>
                ) : null}
                {config.kind === "zoom-remote" ? (
                  <button type="button" onClick={() => source?.reveal?.()} className={linkCls}>
                    Open in Zoom
                  </button>
                ) : null}
              </span>
              <span>{waiting ? waitLine : shortLeft}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden w-12 flex-none text-[13px] text-label-muted tabular-nums lg:inline">{formatTime(clip.start)}</span>
              {/* The scrub bar: the clip window, start to end. It looks thin, but its hit area (::before) is 44 px tall. */}
              <div
                ref={trackRef}
                role="slider"
                tabIndex={scrubbable ? 0 : -1}
                aria-label="Clip position"
                aria-disabled={scrubbable ? undefined : true}
                aria-valuemin={0}
                aria-valuemax={Math.round(progress.total)}
                aria-valuenow={Math.floor(progress.elapsed)}
                aria-valuetext={scrubValueText(win, time)}
                data-scrub=""
                data-scrubbing={scrub !== null ? "" : undefined}
                onPointerDown={onScrubDown}
                onPointerMove={onScrubMove}
                onPointerUp={onScrubUp}
                onPointerCancel={onScrubCancel}
                onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
                onKeyDown={onScrubKey}
                className={`relative my-[19px] h-1.5 min-w-0 flex-1 touch-pan-y rounded-[3px] bg-tape-blank select-none before:absolute before:-inset-x-2 before:-top-[19px] before:-bottom-[19px] before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-label lg:mt-2.5 lg:mb-2 lg:h-2 lg:rounded lg:before:-top-[18px] lg:before:-bottom-[18px] ${
                  scrubbable ? "cursor-pointer" : ""
                }`}
              >
                <div className="pointer-events-none absolute inset-y-0 left-0 rounded-[3px] bg-action lg:rounded" style={{ width: `${progress.fraction * 100}%` }} />
                {/* The knob jumps with the time; it never animates (a scrub must feel direct, and reduced motion needs no rule). */}
                <div
                  data-knob=""
                  className="pointer-events-none absolute top-1/2 -mt-[9px] -ml-[9px] size-[18px] rounded-full bg-label shadow-[0_1px_3px_rgb(0_0_0/0.5)]"
                  style={{ left: `${progress.fraction * 100}%` }}
                />
                {hover ? (
                  <div
                    data-scrub-label=""
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-full z-10 mb-5 flex w-max max-w-64 -translate-x-1/2 flex-col gap-0.5 rounded-md bg-deck px-2.5 py-1.5 text-[13px] leading-snug text-label shadow-[0_2px_8px_rgb(0_0_0/0.35)]"
                    style={{ left: hover.x }}
                  >
                    <span className="font-bold text-peach tabular-nums">{formatTime(hover.t)}</span>
                    {hoverLine ? <span className="line-clamp-2">{hoverLine}</span> : null}
                  </div>
                ) : null}
              </div>
              <span className="hidden w-12 flex-none text-right text-[13px] text-label-muted tabular-nums lg:inline">{formatTime(win.end)}</span>
            </div>
          </div>

          <p className="sr-only" aria-live="polite">
            {announced}
          </p>

          {player?.needsGesture && config.kind === "zoom-remote" ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Chrome needs one click in the Zoom tab before it can play.</span>
              <button type="button" onClick={() => source?.reveal?.()} className={linkCls}>
                Open the Zoom tab
              </button>
            </div>
          ) : null}

          {/* Phone: time left and the transcript toggle, or Replay / Keep listening at the end. Right under the
              scrub bar, above the example button, so the sticky Next question bar never covers them. */}
          <div className="flex items-center justify-between gap-2.5 text-[13px] text-label-muted lg:hidden">
            {ended ? (
              <span className="flex flex-wrap items-center gap-2.5">
                <span>End of the clip.</span>
                <button type="button" onClick={() => controller?.play(true)} className="btn btn-secondary">
                  Replay
                </button>
                {playsOn ? (
                  <button type="button" onClick={() => controller?.keepListening()} className="btn btn-secondary">
                    Keep listening
                  </button>
                ) : null}
              </span>
            ) : (
              <span>{waiting ? waitLine : pastEnd ? "Listening past the clip" : `${leftText} of the clip`}</span>
            )}
            <button type="button" aria-expanded={transcriptOpen} onClick={() => setTranscriptPref(!transcriptOpen)} className={`${linkCls} flex-none`}>
              {transcriptOpen ? "Hide transcript" : "Read transcript"}
            </button>
          </div>
          {/* Phone: the example button under the controls (desktop has it in the transcript's header). */}
          {exampleButton("lg:hidden")}
        </div>

        {setupCard && !onSetupCardChange ? <EmbedSetupCard origin={typeof window === "undefined" ? "" : window.location.origin} /> : null}

        {/* The transcript: a fixed-height panel under the transport (about three lines; five under a hosted clip,
            in the height the caption band gave up; it scrolls inside). When the recording failed it opens by itself,
            under the line saying why. */}
        <div data-transcript-panel="" className={`${transcriptOpen ? "flex" : "hidden"} transcript-panel flex-col gap-1 rounded-xl bg-deck-raised p-2.5 lg:flex lg:px-2 lg:py-2 ${tutorMode ? "lg:h-[96px]" : captionBand ? "lg:h-[128px]" : hostedPanel ? "lg:h-[var(--transcript-h)]" : "lg:h-[144px]"}`}
          style={hostedPanel ? ({ "--transcript-h": `${transcriptPanelHeight(hostedLines) + 24}px` } as CSSProperties) : undefined}>
          {error ? (
            <p id={reasonId} role="alert" className="px-1 text-sm lg:px-1.5">
              {error === NO_EXTENSION ? (
                `The Rewind extension isn't installed, so here's what ${lecturer} said:`
              ) : error === LOAD_FAILED ? (
                <>Couldn&apos;t load the recording, so here&apos;s what {lecturer} said:</>
              ) : error === NOT_HOSTED ? (
                <>The recording isn&apos;t available in the demo. Here&apos;s what {lecturer} said:</>
              ) : (
                `${error} Here's what ${lecturer} said:`
              )}
            </p>
          ) : null}
          {error && triedPlay ? (
            // Announced through the live region above; shown here so a click on Play visibly answers.
            <p aria-hidden="true" data-cant-play="" className="px-1 text-sm text-label-muted">
              {cantPlay} J, L and the bar move through it.
            </p>
          ) : null}
          {transcript}
        </div>
      </div>
    </section>
  );
}
