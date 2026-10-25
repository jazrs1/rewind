// The tape window of the deck face (brief B §2): two reels, each with a dashed ring for a hub (14 of the
// reel's 32 px, a 3 px dashed border, like the Cassette mockup's) round a pale centre, the brown tape
// running between them, and whatever sits between the reels (the counter) laid over the tape, so the reels
// and counter read as one object. Still, turning while the clip plays, or spinning back during the rewind.
// The rewind spin is driven frame by frame by the player (it decelerates with the counter), so "rewind" has
// no CSS animation of its own: the player sets each reel's rotation.
//
// The reels shrink with the room the window gets, and hide when there's too little, so the counter always fits.

import type { ReactNode, Ref } from "react";

export type ReelMode = "idle" | "play" | "rewind";

/** Dashes on each hub ring. The rewind turns a whole number of dashes (REEL_TURN), so the play spin picks up seamlessly. */
export const HUB_DASHES = 6;
/** The tape pack on a nearly empty reel, as a share of a full one (the packs resize during the rewind). */
export const PACK_MIN = 0.8;

/** The reel is 18 units across (32 px in the mockup); its hub ring is 14/32 of that, with a 3/32 border. */
const REEL_R = 9;
const RING_OUTER = (REEL_R * 2 * 14) / 32 / 2;
const RING_W = (REEL_R * 2 * 3) / 32;
const RING_R = RING_OUTER - RING_W / 2;
const DASH_PERIOD = (2 * Math.PI * RING_R) / HUB_DASHES;

/** One reel with its wound tape pack: 26 units square, the pack filling it when full. */
function Reel({ side, mode }: { side: "left" | "right"; mode: ReelMode }) {
  return (
    <svg viewBox="0 0 26 26" aria-hidden="true" className="relative h-full w-auto flex-none">
      <circle data-pack={side} cx="13" cy="13" r="12.5" className="reel-pack fill-tape-ribbon" style={side === "right" ? { transform: `scale(${PACK_MIN})` } : undefined} />
      <g className={`reel ${mode === "play" ? "reel-play" : ""}`}>
        <circle cx="13" cy="13" r={REEL_R} className="fill-label" />
        <circle
          data-hub=""
          cx="13"
          cy="13"
          r={RING_R}
          fill="none"
          strokeWidth={RING_W}
          strokeDasharray={`${DASH_PERIOD * 0.55} ${DASH_PERIOD * 0.45}`}
          className="stroke-deck"
        />
      </g>
    </svg>
  );
}

export function Reels({ mode, className = "", children, ref }: { mode: ReelMode; className?: string; children?: ReactNode; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} data-reels="" className={`relative flex items-center ${className}`}>
      {/* The tape between the reels, under the counter. */}
      <span aria-hidden="true" data-ribbon="" className="absolute inset-x-[18%] top-1/2 h-[30%] -translate-y-1/2 rounded-[2px] bg-tape-ribbon" />
      <Reel side="left" mode={mode} />
      <div className="relative flex min-w-0 flex-1 justify-center">{children}</div>
      <Reel side="right" mode={mode} />
    </div>
  );
}
