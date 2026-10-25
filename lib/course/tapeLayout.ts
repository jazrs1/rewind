// Geometry of the course tape (docs/design/CourseTape.dc.html): a serpentine "road" of tape
// from the supply reel (top left) to the take-up reel, rows joined by half-turns around guide
// rollers. Desktop (deskFrame/deskLayout) is 740 wide with as many rows as the stops need (two to
// four), stops spread evenly and labels on the free side of each stop; the mockup's own four-row frame
// is DESKTOP_FRAME. A phone frame winds the same tape in a narrow frame, two stops to a row in course
// order (slotAt). Either way the tape head and flags are mapped between the stops (positionMap).

export interface TapeFrame {
  width: number;
  height: number;
  /** Left and right ends of the straight rows. */
  x0: number;
  x1: number;
  /** Half-turn radius (rows are 2r apart). */
  r: number;
  /** Row centre lines, top to bottom. */
  rows: number[];
  /** Lead-in before the first row and after the last (to the reels). */
  lead: number;
}

export interface TapePoint {
  x: number;
  y: number;
  kind: "row" | "turn";
  /** Which side a turn is on (labels go inside the turn). */
  side?: "left" | "right";
  /** Row index for straight parts. */
  row?: number;
}

/** The mockup's desktop frame. */
export const DESKTOP_FRAME: TapeFrame = { width: 860, height: 792, x0: 130, x1: 740, r: 85, rows: [150, 320, 490, 660], lead: 70 };

/** Stops per row on a phone: two, so every label has room. */
export const PHONE_PER_ROW = 2;

/**
 * A phone frame (390 wide) with a row for every two stops, and an even number of rows so the
 * take-up reel ends bottom left as on desktop.
 */
export function phoneFrame(stops: number): TapeFrame {
  let n = Math.max(2, Math.ceil(stops / PHONE_PER_ROW));
  if (n % 2) n++;
  const r = 56;
  const rows = Array.from({ length: n }, (_, i) => 120 + i * 2 * r);
  return { width: 390, height: rows[n - 1] + 120, x0: 72, x1: 318, r, rows, lead: 30 };
}

/** Fraction along the tape of slot i when stops sit `perRow` to a row, evenly, never on a turn. */
export function slotAt(f: TapeFrame, i: number, perRow: number): number {
  const w = f.x1 - f.x0;
  const row = Math.min(Math.floor(i / perRow), f.rows.length - 1);
  const d = row * (w + Math.PI * f.r) + ((i - row * perRow + 0.5) / perRow) * w;
  return Math.min(1, d / frameLength(f));
}

/**
 * Maps a position on the course (0..1, as the data has it) to a fraction along a drawn tape whose
 * stops sit at `slots`: piecewise linear between the stops, so the tape head and the exam flags
 * keep their place between the same two stops.
 */
export function positionMap(positions: number[], slots: number[]): (p: number) => number {
  const knots: [number, number][] = [[0, 0]];
  positions.forEach((p, i) => {
    if (p >= knots[knots.length - 1][0]) knots.push([p, slots[i]]);
  });
  if (knots[knots.length - 1][0] < 1) knots.push([1, 1]);
  return (p) => {
    const v = Math.min(1, Math.max(0, p));
    for (let k = 1; k < knots.length; k++) {
      const [p0, t0] = knots[k - 1];
      const [p1, t1] = knots[k];
      if (v <= p1) return p1 === p0 ? t1 : t0 + ((v - p0) / (p1 - p0)) * (t1 - t0);
    }
    return 1;
  };
}

export function frameLength(f: TapeFrame): number {
  const w = f.x1 - f.x0;
  return f.rows.length * w + (f.rows.length - 1) * Math.PI * f.r;
}

/** Point at fraction t (0..1) of the way along the rows and turns (not the lead-ins). */
export function pointAt(f: TapeFrame, t: number): TapePoint {
  const w = f.x1 - f.x0;
  const turn = Math.PI * f.r;
  let rest = Math.min(1, Math.max(0, t)) * frameLength(f);
  for (let i = 0; i < f.rows.length; i++) {
    const ltr = i % 2 === 0;
    if (rest <= w || i === f.rows.length - 1) {
      const d = Math.min(rest, w);
      return { x: ltr ? f.x0 + d : f.x1 - d, y: f.rows[i], kind: "row", row: i };
    }
    rest -= w;
    if (rest <= turn) {
      const a = rest / f.r;
      const right = ltr;
      const cy = (f.rows[i] + f.rows[i + 1]) / 2;
      return { x: right ? f.x1 + Math.sin(a) * f.r : f.x0 - Math.sin(a) * f.r, y: cy - Math.cos(a) * f.r, kind: "turn", side: right ? "right" : "left" };
    }
    rest -= turn;
  }
  const last = f.rows.length - 1;
  return { x: last % 2 === 0 ? f.x1 : f.x0, y: f.rows[last], kind: "row", row: last };
}

/** The road as an SVG path, lead-ins included. */
export function roadPath(f: TapeFrame): string {
  const parts = [`M${f.x0 - f.lead} ${f.rows[0]}`];
  const last = f.rows.length - 1;
  f.rows.forEach((y, i) => {
    const ltr = i % 2 === 0;
    if (i === last) {
      // The last row runs straight on to the take-up reel.
      parts.push(`H${ltr ? f.x1 + f.lead : f.x0 - f.lead}`);
      return;
    }
    parts.push(`H${ltr ? f.x1 : f.x0}`);
    parts.push(`A${f.r} ${f.r} 0 0 ${ltr ? 1 : 0} ${ltr ? f.x1 : f.x0} ${f.rows[i + 1]}`);
  });
  return parts.join(" ");
}

/** Length of the road (lead-ins included) up to fraction t, for the "ahead" dash. */
export function roadLengthAt(f: TapeFrame, t: number): number {
  return f.lead + Math.min(1, Math.max(0, t)) * frameLength(f);
}

/** Guide rollers: one inside each half-turn. */
export function rollers(f: TapeFrame): { x: number; y: number }[] {
  return f.rows.slice(0, -1).map((y, i) => ({ x: i % 2 === 0 ? f.x1 : f.x0, y: (y + f.rows[i + 1]) / 2 }));
}

/** Where the two reels sit: the road's two ends. */
export function reels(f: TapeFrame): { supply: { x: number; y: number }; takeUp: { x: number; y: number } } {
  const last = f.rows.length - 1;
  return {
    supply: { x: f.x0 - f.lead, y: f.rows[0] },
    takeUp: { x: last % 2 === 0 ? f.x1 + f.lead : f.x0 - f.lead, y: f.rows[last] },
  };
}

// ---------------------------------------------------------------------------------------------------
// Desktop: a tape sized to the course. Rows grow with the number of stops (2 rows for one or two stops,
// one more per stop up to four), so a three-stop course is a short tape with two bends, not the full
// serpentine. Stops sit evenly along the road (never on a turn); the tape head and exam flags keep their
// place between the same two stops (positionMap). Labels go on the free side of their stop (placeLabels).

/** Width of the desktop frame: one frame unit is one CSS pixel at this width. */
export const DESK_W = 740;

/** Rows on the desktop tape for `stops` stops: 2..4. */
export function deskRows(stops: number): number {
  return Math.min(4, Math.max(2, stops));
}

/** The desktop frame for `stops` stops: 740 wide, as tall as its rows need. */
export function deskFrame(stops: number): TapeFrame {
  const n = deskRows(stops);
  const r = 75;
  const rows = Array.from({ length: n }, (_, i) => 132 + i * 2 * r);
  return { width: DESK_W, height: rows[n - 1] + 112, x0: 160, x1: DESK_W - 160, r, rows, lead: 75 };
}

/**
 * Fractions along the tape (as pointAt takes them) for `n` stops spread evenly over the road. One that would
 * land on a turn moves to the nearer row end, held `inset` back from it, so no stop sits on a bend.
 */
export function deskSlots(f: TapeFrame, n: number, inset = 44): number[] {
  const len = frameLength(f);
  const w = f.x1 - f.x0;
  const turn = Math.PI * f.r;
  return Array.from({ length: n }, (_, i) => {
    let d = ((i + 0.5) / n) * len;
    const seg = w + turn;
    const row = Math.min(Math.floor(d / seg), f.rows.length - 1);
    const into = d - row * seg;
    if (into > w && row < f.rows.length - 1) {
      // On the turn after `row`: to the end of this row or the start of the next, whichever is nearer.
      d = into - w < turn / 2 ? row * seg + w - inset : (row + 1) * seg + inset;
    }
    return Math.min(1, Math.max(0, d / len));
  });
}

/** Length of the whole drawn road: lead-in, rows and turns, lead-out. */
export function roadTotal(f: TapeFrame): number {
  return frameLength(f) + 2 * f.lead;
}

/** The point `d` along the drawn road from the supply reel (lead-in included), for the travelling tape head. */
export function roadPoint(f: TapeFrame, d: number): { x: number; y: number } {
  const len = frameLength(f);
  if (d <= f.lead) return { x: f.x0 - f.lead + Math.max(0, d), y: f.rows[0] };
  if (d <= f.lead + len) return pointAt(f, (d - f.lead) / len);
  const end = pointAt(f, 1);
  const out = Math.min(f.lead, d - f.lead - len);
  return { x: (f.rows.length - 1) % 2 === 0 ? end.x + out : end.x - out, y: end.y };
}

/**
 * Where the tape head rests (a fraction along the tape): at `t`, but never on top of a stop's dot. When it
 * would cover one (the current stop), it sits just past it, between it and the next.
 */
export function headSlot(f: TapeFrame, t: number, stops: number[], clear = 40): number {
  const len = frameLength(f);
  const hit = stops.find((s) => Math.abs(s - t) * len < clear);
  if (hit === undefined) return t;
  const next = stops.filter((s) => s > hit).sort((a, b) => a - b)[0];
  const room = next === undefined ? 1 - hit : next - hit;
  return Math.min(1, hit + Math.min(clear / len, room / 2));
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Overlap area of two boxes. */
export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The ribbon as small boxes along the road (every `step` units), so labels stay off the tape. */
export function roadBoxes(f: TapeFrame, half = 9, step = 12): Box[] {
  const out: Box[] = [];
  for (let d = 0; d <= roadTotal(f); d += step) {
    const p = roadPoint(f, d);
    out.push({ x: p.x - half, y: p.y - half, w: 2 * half, h: 2 * half });
  }
  return out;
}

/** Stop labels: 13 px bold, at most two lines of at most this width; longer names end in an ellipsis. */
export const LABEL = { maxW: 168, line: 16, char: 7.3 } as const;

/**
 * The box a stop name takes (estimated from its length: 13 px bold averages ~7.3 px a character), wrapped
 * greedily onto at most two lines. `truncated` when it doesn't fit in two (the screen clamps it with an ellipsis
 * and keeps the full name in the tooltip and the button's name).
 */
export function labelBox(text: string): { w: number; h: number; lines: 1 | 2; truncated: boolean } {
  const words = text.trim().split(/\s+/);
  const width = (s: string) => Math.ceil(s.length * LABEL.char);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (width(next) <= LABEL.maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  const truncated = lines.length > 2 || lines.some((l) => width(l) > LABEL.maxW);
  const shown = lines.slice(0, 2);
  const w = Math.min(LABEL.maxW, Math.max(...shown.map(width)));
  return { w, h: shown.length * LABEL.line, lines: shown.length as 1 | 2, truncated };
}

export type Side = "above" | "below" | "left" | "right";

export interface LabelItem {
  /** Dot centre. */
  x: number;
  y: number;
  label: { w: number; h: number };
  /** The "◀◀ n" route badge's size, or null when the stop isn't on the route. */
  badge: { w: number; h: number } | null;
  /** The "✕n" miss marker's size (missBox), or null when nothing was missed. */
  miss?: { w: number; h: number } | null;
}

export interface LabelPlace {
  label: Box & { side: Side; align: "left" | "right" | "center" };
  badge: Box | null;
  /** Where the "✕n" miss marker sits, or null. */
  miss: Box | null;
}

const GAP = 14;

/** The "✕n" miss marker (components/course/MissMark.tsx): a cream tab, 17 px hand-lettered, one digit or more. */
export const missBox = (n: number): { w: number; h: number } => ({ w: 20 + 9 * String(n).length, h: 18 });

/** The miss marker's place: above-right of its dot (centre x, y), touching its corner. Off the ribbon, so never between
 * the dot and the tape head; labels, route badges, the head and its pill are placed clear of it. */
export const missRect = (x: number, y: number, size: { w: number; h: number }): Box => ({ x: x + 7, y: y - 10 - size.h, w: size.w, h: size.h });

function sideBox(x: number, y: number, size: { w: number; h: number }, side: Side): Box {
  if (side === "above") return { x: x - size.w / 2, y: y - GAP - size.h, w: size.w, h: size.h };
  if (side === "below") return { x: x - size.w / 2, y: y + GAP, w: size.w, h: size.h };
  if (side === "left") return { x: x - GAP - 6 - size.w, y: y - size.h / 2, w: size.w, h: size.h };
  return { x: x + GAP + 6, y: y - size.h / 2, w: size.w, h: size.h };
}

const SIDES: Side[] = ["above", "below", "left", "right"];
const OPPOSITE: Record<Side, Side> = { above: "below", below: "above", left: "right", right: "left" };

/**
 * Places each stop's label and route badge on a free side of its dot: never over `obstacles` (the ribbon, the
 * tape head and its "You are here" pill, flags, reels, other dots), never over a label or badge placed before
 * it, and inside the frame (`margin` in). Preference: label above and badge below, then the other way round,
 * then beside. When nothing is free it takes the placement with the least overlap.
 *
 * Each miss marker has its fixed place above-right of its dot (missRect), and every label and badge keeps clear of it.
 */
export function placeLabels(f: TapeFrame, items: LabelItem[], obstacles: Box[], margin = 14): LabelPlace[] {
  const misses = items.map((it) => (it.miss ? missRect(it.x, it.y, it.miss) : null));
  const placed: Box[] = misses.filter((m): m is Box => m !== null);
  const dots = items.map((it) => ({ x: it.x - 12, y: it.y - 12, w: 24, h: 24 }));
  const outside = (b: Box) =>
    Math.max(0, margin - b.x) * b.h + Math.max(0, b.x + b.w - (f.width - margin)) * b.h + Math.max(0, margin - b.y) * b.w + Math.max(0, b.y + b.h - (f.height - margin)) * b.w;
  return items.map((it, i) => {
    const others = [...obstacles, ...placed, ...dots.filter((_, j) => j !== i)];
    const cost = (b: Box) => others.reduce((a, o) => a + overlap(b, o), 0) + outside(b) * 4;
    let best: { place: LabelPlace; cost: number } | null = null;
    // Above, a label or badge may also end just left of the miss marker (right-aligned), so the marker keeps its place.
    const variants = (size: { w: number; h: number }, side: Side): { box: Box; shifted: boolean }[] => {
      const box = sideBox(it.x, it.y, size, side);
      const m = misses[i];
      return side === "above" && m ? [{ box, shifted: false }, { box: { ...box, x: m.x - 4 - size.w }, shifted: true }] : [{ box, shifted: false }];
    };
    for (const ls of SIDES) {
      for (const { box: label, shifted } of variants(it.label, ls)) {
        const lc = cost(label);
        const badgeSides = it.badge ? [OPPOSITE[ls], ...SIDES.filter((s) => s !== ls && s !== OPPOSITE[ls])] : [null];
        for (const bs of badgeSides) {
          for (const badge of bs && it.badge ? variants(it.badge, bs).map((v) => v.box) : [null]) {
            const c = lc + (badge ? cost(badge) + overlap(badge, label) * 4 : 0);
            if (!best || c < best.cost) {
              const align = ls === "left" || shifted ? "right" : ls === "right" ? "left" : "center";
              best = { place: { label: { ...label, side: ls, align }, badge, miss: misses[i] }, cost: c };
            }
            if (c === 0) break;
          }
          if (best?.cost === 0) break;
        }
        if (best?.cost === 0) break;
      }
      if (best?.cost === 0) break;
    }
    placed.push(best!.place.label);
    if (best!.place.badge) placed.push(best!.place.badge);
    return best!.place;
  });
}

export interface DeskInput {
  /** In tape order: course position (0..1), name, whether it's on tonight's route back, and its missed answers ("✕n"). */
  stops: { position: number; topic: string; onRoute: boolean; misses?: number }[];
  /** The tape head's course position, or null when unknown. */
  here: number | null;
  /** The course week the head is in, for the "Wk n" marks and the pill, or null. */
  week: number | null;
  /** Exam flags at their course positions, with the text they show. */
  flags: { position: number; text: string }[];
}

/** The route badge ("◀◀ n"), the reels' radii and the width of a 13 px bold character, in frame units. */
export const BADGE = { w: 54, h: 26 } as const;
export const SUPPLY_R = 34;
export const TAKEUP_R = 50;
const CHAR = LABEL.char;

/**
 * Everything the desktop deck draws, in frame units: the stops' dots, where the tape head rests (never on a dot)
 * and its "You are here" pill (slid aside when a stop beside the head needs the room), the flags, each stop's
 * label and route badge on a free side (placeLabels), and the week marks that fit.
 */
export function deskLayout(f: TapeFrame, tape: DeskInput) {
  const len = frameLength(f);
  const slots = deskSlots(f, tape.stops.length);
  const map = positionMap(
    tape.stops.map((s) => s.position),
    slots,
  );
  const dots = slots.map((t) => pointAt(f, t));
  const here = tape.here;
  // Each miss marker's fixed place (missRect): the head rests clear of them, and its pill keeps off them.
  const misses = tape.stops.map((s, i) => (s.misses ? missRect(dots[i].x, dots[i].y, missBox(s.misses)) : null)).filter((m): m is Box => m !== null);
  const headBox = (p: TapePoint): Box => ({ x: p.x - 18, y: p.y - 17, w: 36, h: 34 });
  const headT =
    here !== null
      ? ([56, 72, 88].map((clear) => headSlot(f, map(here), slots, clear)).find((t) => !misses.some((m) => overlap(headBox(pointAt(f, t)), m))) ?? headSlot(f, map(here), slots, 56))
      : null;
  const head = headT !== null ? pointAt(f, headT) : null;
  const headD = headT !== null ? f.lead + headT * len : null;

  const obstacles: Box[] = [...roadBoxes(f), { x: 0, y: 0, w: f.width, h: 44 }];
  const { supply, takeUp } = reels(f);
  obstacles.push(
    { x: supply.x - SUPPLY_R, y: supply.y - SUPPLY_R, w: 2 * SUPPLY_R, h: 2 * SUPPLY_R + 26 },
    { x: takeUp.x - TAKEUP_R, y: takeUp.y - TAKEUP_R, w: 2 * TAKEUP_R, h: 2 * TAKEUP_R + 26 },
  );

  let bubble: (Box & { text: string }) | null = null;
  if (head) {
    const text = `You are here${tape.week ? ` · Week ${tape.week}` : ""}`;
    const w = Math.ceil(text.length * CHAR) + 22;
    // Centred over the head, or slid to one side (its pointer stays over the head) when a stop beside the head
    // needs the room above its dot for its name or route badge; always inside the panel.
    const above = dots.map((d) => ({ x: d.x - 34, y: d.y - 48, w: 68, h: 36 }));
    const clamp = (cx: number) => Math.min(Math.max(cx, w / 2 + 14), f.width - w / 2 - 14);
    const cxs = [head.x, head.x + w / 2 - 18, head.x - w / 2 + 18].map(clamp);
    const cost = (cx: number) => {
      const pill = { x: cx - w / 2, y: head.y - 60, w, h: 26 };
      return above.reduce((a, b) => a + overlap(b, pill), 0) + misses.reduce((a, m) => a + overlap(m, pill) * 100, 0);
    };
    const cx = cxs.reduce((best, c) => (cost(c) < cost(best) ? c : best), cxs[0]);
    bubble = { text, x: cx - w / 2, y: head.y - 60, w, h: 26 };
    obstacles.push(headBox(head), bubble, { x: head.x - 8, y: head.y - 36, w: 16, h: 12 });
  }

  const flags = tape.flags.map(({ position, text }) => {
    const p = pointAt(f, map(position));
    const w = Math.ceil(text.length * CHAR) + 18;
    // Near the right edge the flag hangs to the left of its pole, so it stays inside the panel.
    const left = p.x + w > f.width - 20;
    const box: Box = { x: left ? p.x - w + 10 : p.x - 10, y: p.y - 58, w, h: 48 };
    obstacles.push(box);
    return { p, left, box };
  });

  const labels = tape.stops.map((s) => labelBox(s.topic));
  const places = placeLabels(
    f,
    tape.stops.map((s, i) => ({ x: dots[i].x, y: dots[i].y, label: labels[i], badge: s.onRoute ? BADGE : null, miss: s.misses ? missBox(s.misses) : null })),
    obstacles,
  );

  // The tape's marks count course weeks (Wk 3); each one only where it's clear of everything else.
  const weeks = tape.week && here ? Math.min(17, Math.max(tape.week + 1, Math.round(tape.week / here))) : null;
  const taken: Box[] = [
    ...places.flatMap((p) => [p.label, ...(p.badge ? [p.badge] : []), ...(p.miss ? [p.miss] : [])]),
    ...dots.map((d) => ({ x: d.x - 24, y: d.y - 24, w: 48, h: 48 })),
    ...flags.map((fl) => fl.box),
    ...(bubble && head ? [bubble, { x: head.x - 40, y: head.y - 20, w: 80, h: 40 }] : []),
  ];
  const counters: { w: number; x: number; y: number }[] = [];
  if (weeks) {
    const step = Math.max(2, Math.ceil(weeks / 6));
    for (let w = step; w < weeks; w += step) {
      const p = pointAt(f, map(w / weeks));
      const box = { x: p.x - 24, y: p.y - 10, w: 48, h: 20 };
      if (taken.some((b) => overlap(b, box) > 0) || counters.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 90)) continue;
      counters.push({ w, x: p.x, y: p.y });
    }
  }
  return { f, len, slots, dots, head, headD, bubble, flags, labels, places, weeks, counters, supply, takeUp };
}

