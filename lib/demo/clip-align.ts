// Aligning a raw capture of a Zoom recording to the lecture, from its burned-in captions (scripts/demo/align-clips.ts
// reads the frames). Pure: caption-change times from frame differences, and the offset that puts them on the
// transcript's segment boundaries.

/** Seconds in the capture where the caption strip changes: peaks of the mean frame-to-frame difference. */
export function captionChanges(frames: Uint8Array[], fps: number, threshold = 6): number[] {
  const diff = [0];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    let s = 0;
    for (let j = 0; j < a.length; j++) s += Math.abs(a[j] - b[j]);
    diff.push(s / a.length);
  }
  const out: number[] = [];
  for (let i = 1; i < diff.length; i++) {
    // A change can straddle two frames; keep the first frame of each run above the threshold.
    if (diff[i] >= threshold && diff[i - 1] < threshold) out.push(i / fps);
  }
  return out;
}

/**
 * One lecture's clock: the captures' burned-in wall clocks are the same clock, so every caption change from every
 * capture of a lecture, put on that clock (clock at the capture's 0:00 + its second), must sit on a boundary at
 * `clock - lectureZero`. Searches lectureZero within ±`window` of `guess`; returns it refined to the median residual.
 */
export function alignClock(clockChanges: number[], segments: { start: number; end: number }[], guess: number, window = 60, tol = 0.6): { zero: number; matched: number; changes: number; spread: number } | null {
  const a = alignOffset(clockChanges.map((c) => c - guess), segments, window, 2 * window, tol);
  if (!a) return null;
  // alignOffset's offset is the lecture second at clock `guess`, so lectureZero = guess - offset.
  return { zero: Math.round((guess - a.offset) * 100) / 100, matched: a.matched, changes: a.changes, spread: a.spread };
}

/**
 * Seconds where speech resumes after a pause, from a loudness envelope (dB per frame, `rate` frames a second): the
 * first loud frame after at least `minGap` seconds below the speech floor. Zoom's transcript starts a new segment at
 * such pauses, so these stand in for caption changes in a capture without captions.
 */
export function speechOnsets(db: number[], rate: number, minGap = 0.5): number[] {
  const sorted = [...db].filter(Number.isFinite).sort((a, b) => a - b);
  // Floor: halfway between the quiet (10th percentile) and the speech (70th) levels.
  const floor = (sorted[Math.floor(sorted.length * 0.1)] + sorted[Math.floor(sorted.length * 0.7)]) / 2;
  const out: number[] = [];
  let quiet = 0;
  for (let i = 0; i < db.length; i++) {
    if (db[i] < floor) quiet++;
    else {
      if (quiet >= minGap * rate) out.push(i / rate);
      quiet = 0;
    }
  }
  return out;
}

export interface Alignment {
  /** Lecture second at the capture's 0:00. */
  offset: number;
  /** Seconds into the capture where the clip starts. */
  lead: number;
  matched: number;
  changes: number;
  /** Median distance of the matched changes from their boundary. */
  spread: number;
}

/**
 * The shift that puts the most caption changes on a segment boundary (a start or an end), searched around the
 * clip start (the capture starts up to `maxLead` seconds before it), refined to the median of the matched residuals.
 * Null when fewer than 3 changes match: too little to trust.
 */
export function alignOffset(changes: number[], segments: { start: number; end: number }[], clipStart: number, maxLead = 60, tol = 0.6): Alignment | null {
  const bounds = [...new Set(segments.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const nearest = (x: number) => {
    let best = Infinity;
    for (const b of bounds) if (Math.abs(b - x) < Math.abs(best - x)) best = b;
    return best;
  };
  let best: { offset: number; matched: number; err: number } | null = null;
  for (let o = clipStart - maxLead; o <= clipStart + 1; o += 0.05) {
    let matched = 0;
    let err = 0;
    for (const c of changes) {
      const d = Math.abs(nearest(c + o) - (c + o));
      if (d <= tol) {
        matched++;
        err += d;
      }
    }
    if (!best || matched > best.matched || (matched === best.matched && err < best.err)) best = { offset: o, matched, err };
  }
  if (!best || best.matched < 3) return null;
  const residuals = changes
    .map((c) => nearest(c + best.offset) - (c + best.offset))
    .filter((d) => Math.abs(d) <= tol)
    .sort((a, b) => a - b);
  const median = residuals[Math.floor(residuals.length / 2)];
  const offset = Math.round((best.offset + median) * 100) / 100;
  const spread = [...residuals.map((d) => Math.abs(d - median))].sort((a, b) => a - b)[Math.floor(residuals.length / 2)];
  return { offset, lead: Math.round((clipStart - offset) * 100) / 100, matched: best.matched, changes: changes.length, spread };
}
