// Where things sit on the desktop course tape (docs/design/CourseTape.dc.html, renderVals): the tape
// winds as a serpentine road through an 860 x 792 panel, four rows joined by half-turns around guide
// rollers, from the supply reel (first lecture, top left) to the take-up reel (final exam, bottom
// left). Pure: the screen turns these numbers into SVG and absolutely placed buttons.

export const PANEL = { w: 860, h: 792 } as const;
const X0 = 130;
const X1 = 740;
const R = 85;
const ROWS = [150, 320, 490, 660] as const;
const W = X1 - X0;
const TURN = Math.PI * R;
/** Road length from the first row's start (X0) to the last row's end. */
export const ROAD = 4 * W + 3 * TURN;
/** The lead-in from the supply reel to X0 (and out to the take-up reel). */
export const LEAD = 70;

export type RoadPoint = { x: number; y: number } & ({ kind: "row"; row: number } | { kind: "turn"; side: "left" | "right" });

/** The road as an SVG path, lead-in and lead-out included. */
export function roadPath(): string {
  const [a, b, c, d] = ROWS;
  return (
    `M${X0 - LEAD} ${a} H${X1} A${R} ${R} 0 0 1 ${X1} ${b}` +
    ` H${X0} A${R} ${R} 0 0 0 ${X0} ${c}` +
    ` H${X1} A${R} ${R} 0 0 1 ${X1} ${d} H${X0 - LEAD}`
  );
}

/** The point at `dist` along the road from X0 (clamped to the road). */
export function pointAt(dist: number): RoadPoint {
  let rest = Math.max(0, Math.min(ROAD, dist));
  for (let i = 0; i < 4; i++) {
    if (rest <= W) {
      const ltr = i % 2 === 0;
      return { x: ltr ? X0 + rest : X1 - rest, y: ROWS[i], kind: "row", row: i };
    }
    rest -= W;
    if (i < 3) {
      if (rest <= TURN) {
        const a = rest / R;
        const right = i % 2 === 0;
        const cy = (ROWS[i] + ROWS[i + 1]) / 2;
        return { x: right ? X1 + Math.sin(a) * R : X0 - Math.sin(a) * R, y: cy - Math.cos(a) * R, kind: "turn", side: right ? "right" : "left" };
      }
      rest -= TURN;
    }
  }
  return { x: X0, y: ROWS[3], kind: "row", row: 3 };
}

/** A position on the tape (0 = first lecture, 1 = final exam) as a point on the road. */
export const atPosition = (p: number) => pointAt(p * ROAD);

/** The road's dim overlay starts past the tape head: an SVG dash array leaving the lead-in and the taught part bright. */
export function aheadDash(here: number | null): string {
  if (here === null) return `0 ${ROAD + 2 * LEAD + 300}`;
  return `0 ${here * ROAD + LEAD} ${ROAD + 300}`;
}

export interface StopPlace {
  /** Dot centre. */
  x: number;
  y: number;
  /** Label box (150 px wide) top-left and text alignment. */
  label: { x: number; y: number; align: "left" | "right" | "center" };
  /** Where the "◀◀ n" route badge goes. */
  badge: { x: number; y: number };
}

/**
 * A stop's dot, label and badge, as in the mockup: labels alternate above and below on rows and sit
 * inside the turns. A label that would sit above the tape under one of `avoid` (flags and the tape
 * head, which stand above the tape) goes below instead.
 */
export function placeStop(position: number, index: number, avoid: { x: number; y: number }[] = []): StopPlace {
  const p = atPosition(position);
  if (p.kind === "turn") {
    const right = p.side === "right";
    return {
      x: p.x,
      y: p.y,
      label: { x: right ? p.x - 170 : p.x + 20, y: p.y - 8, align: right ? "right" : "left" },
      badge: { x: right ? p.x - 82 : p.x + 20, y: p.y + 14 },
    };
  }
  const above = index % 2 === 0 && !avoid.some((a) => Math.abs(a.y - p.y) < 1 && Math.abs(a.x - p.x) < 160);
  return { x: p.x, y: p.y, label: { x: p.x - 75, y: above ? p.y - 38 : p.y + 20, align: "center" }, badge: { x: p.x - 22, y: above ? p.y + 16 : p.y - 44 } };
}

/** Guide rollers inside the three turns (160 px discs, top-left corners). */
export const ROLLERS = [
  { x: X1 - 80, y: (ROWS[0] + ROWS[1]) / 2 - 80 },
  { x: X0 - 80, y: (ROWS[1] + ROWS[2]) / 2 - 80 },
  { x: X1 - 80, y: (ROWS[2] + ROWS[3]) / 2 - 80 },
] as const;

/** Counter marks along the tape (fractions of the road), as in the mockup. */
export const COUNTER_AT = [480, 1250, 1880, 2520, 3400].map((s) => s / 3441);

/**
 * The counter at a point: minutes of lecture on the stops at or before it. Counts only minutes we have
 * (recorded lectures), so it reads 0000 before the first recording.
 */
export function counterAt(position: number, stops: { position: number; lectureMinutes: number }[]): string {
  const min = stops.filter((s) => s.position <= position).reduce((a, s) => a + s.lectureMinutes, 0);
  return String(Math.round(min)).padStart(4, "0");
}

/** Glow strength 0..5 from a stop's stressed heat (0..1); none below 1. Only stops with stressed evidence glow. */
export function glowLevel(heat: number, score: number): number {
  // No heat, no glow: the stressed heat has its own floor (lib/course/build.ts stressHeat).
  if (!(score > 0) || !(heat > 0)) return 0;
  return Math.max(1, Math.round(heat * 5));
}

/** Does any stop glow? The glow legend shows only then (a legend for a mark that isn't on screen explains nothing). */
export const anyGlow = (stops: { stressed: { heat: number; score: number } }[]): boolean => stops.some((s) => glowLevel(s.stressed.heat, s.stressed.score) > 0);

/**
 * A score as the screen says it, from the same number the glow and ring use: whole numbers from 10,
 * one decimal below, two below 0.1, "under 0.01" below that, so a stop that glows never reads "stressed 0".
 */
export function scoreText(n: number): string {
  if (!(n > 0)) return "0";
  if (n < 0.01) return "under 0.01";
  if (n < 0.1) return n.toFixed(2);
  if (n < 10) return String(Math.round(n * 10) / 10);
  return String(Math.round(n));
}

const TERMS: Record<string, string> = { fa: "Fall", fall: "Fall", sp: "Spring", spring: "Spring", su: "Summer", summer: "Summer" };

/** The term from the course's Canvas name ("COP3530 - Fa26" → "Fall 2026"), or null when it doesn't say. */
export function termLabel(courseName: string | null | undefined): string | null {
  const m = courseName?.match(/\b(fa|fall|sp|spring|su|summer)\s*'?(\d{4}|\d{2})\b/i);
  if (!m) return null;
  const year = m[2].length === 2 ? `20${m[2]}` : m[2];
  return `${TERMS[m[1].toLowerCase()]} ${year}`;
}
