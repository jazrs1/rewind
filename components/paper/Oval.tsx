// A Scantron oval. Empty shows its letter; filled is the student's pencil mark; correct is
// print green; wrong is the pencil mark circled in red pen. Color never carries meaning
// alone: callers always pair "wrong" and "correct" with text ("You marked", "Correct").

export type OvalState = "empty" | "filled" | "correct" | "wrong";

const PENCIL = "M2.6 11.6C2.3 5.4 9.2 1.1 21.4 1.3C33.6 1 42 4.4 42.3 11.9C42.7 19.2 34.2 23 21.8 22.7C9.3 23.1 2.9 18.7 2.6 11.6Z";

/** `still`: the mark is already on the sheet (once graded), so it doesn't wipe in. */
function Pencil({ id, still = false }: { id: string; still?: boolean }) {
  return (
    <svg width="40" height="22" viewBox="0 0 44 24" aria-hidden="true" className={`${still ? "" : "pencil "}flex-none overflow-visible`}>
      <defs>
        <clipPath id={id}>
          <path d={PENCIL} />
        </clipPath>
      </defs>
      <rect x="0.75" y="0.75" width="42.5" height="22.5" rx="11.25" fill="none" stroke="var(--color-print)" strokeWidth="1.5" />
      <path d={PENCIL} fill="var(--color-pencil)" />
      <g clipPath={`url(#${id})`} fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* The scribble: drawn back and forth as the pencil fills the oval (globals.css .pencil .scribble). */}
        <path className="scribble" pathLength={1} d="M4 6.5L39 4.8L4.5 9.6L40.5 8.4L4 13L41 12.2L4.5 16.6L40 15.6L6.5 20.2L37 19.4" stroke="var(--color-pencil-dark)" strokeWidth="3" opacity="0.5" />
        <path d="M7 8.2L36 7.1M6 14.8L38 14.1M9 18.4L34 17.8" stroke="var(--color-pencil-light)" strokeWidth="0.9" opacity="0.3" />
      </g>
    </svg>
  );
}

/**
 * Hand-drawn loops, the pen running on past where it started (RewindMissed's 52x32 red circle). One is
 * picked at random for each miss, so no two grades look stamped; each wobbles a little and overshoots.
 */
export const PEN_LOOPS = [
  "M9 5.5C18 .8 40 .6 48 7C53 11.5 51.5 25 38 29.8C25 32.6 5 30.5 2 20.5C.4 13.5 5 6 15 3.2C21 1.8 29 1.6 35 2.4",
  "M12 3.6C22 .4 42 1.4 49 8.6C53.5 13.6 50 25.4 36 29.4C22 32.4 4.6 29.2 2.4 19C1.2 12.6 6.4 5.6 16.4 2.8C23 1.2 31 1.8 38.5 3.6",
  "M7.5 7.2C16 1.6 39 .2 47.5 6.2C53.4 10.6 52.6 24.2 39.4 29.4C26 33 6.2 31.6 2.6 21.6C.6 14.4 4.2 7.2 13.6 3.8C19.6 1.6 27.6 1.2 33.6 1.8L37 2.6",
];

/**
 * The red-pen circle round the student's oval after a miss, over whatever oval it circles. With `draw`
 * it is drawn in, once (globals.css .pen-circle: --dur-1 to --dur-1 + --dur-3); otherwise it is just there.
 */
export function RedPenCircle({ draw = false, size = "fixed", variant = 0 }: { draw?: boolean; size?: "fixed" | "responsive"; variant?: number }) {
  const big = size === "responsive" ? "lg:-top-[5px] lg:-left-1.5 lg:h-[34px] lg:w-14" : "";
  return (
    <svg
      data-pen-circle=""
      data-pen-variant={variant % PEN_LOOPS.length}
      viewBox="0 0 52 32"
      aria-hidden="true"
      className={`pointer-events-none absolute -top-1.5 -left-[7px] h-8 w-[52px] overflow-visible ${draw ? "pen-wobble" : ""} ${big}`}
    >
      <path
        d={PEN_LOOPS[variant % PEN_LOOPS.length]}
        pathLength={1}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`stroke-red-pen ${draw ? "pen-circle" : ""}`}
      />
    </svg>
  );
}

/**
 * "responsive" grows to the desktop sheet's 44x24 ovals at lg. `still`: a filled oval shows its pencil mark
 * at once, without the wipe (the grading beat: the student's mark is already there).
 */
export function Oval({ letter, state, size = "fixed", still = false }: { letter: string; state: OvalState; size?: "fixed" | "responsive"; still?: boolean }) {
  const big = size === "responsive" ? "lg:h-6 lg:w-11 lg:rounded-xl" : "";
  if (state === "filled") return <span className={`flex-none ${size === "responsive" ? "lg:scale-110" : ""}`}><Pencil id={`pencil-${letter}`} still={still} /></span>;
  // The correct oval fills green in 200 ms (the pencil wipe is only for the student's mark).
  if (state === "correct") return <span aria-hidden="true" className={`bubble-pencil fade-in relative h-[22px] w-10 flex-none rounded-[11px] bg-print ${big}`} />;
  if (state === "wrong") {
    return (
      <span aria-hidden="true" className="relative h-[22px] w-10 flex-none rounded-[11px] bg-graphite"
        ><span className="bubble-pencil absolute inset-0 rounded-[11px]" />
        <span className="absolute -top-1.5 -left-[7px] h-8 w-[52px] rounded-[50%] border-[2.5px] border-red-pen" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex h-[22px] w-10 flex-none items-center justify-center rounded-[11px] border-[1.5px] border-print text-xs font-bold text-print ${big}`}
    >
      {letter}
    </span>
  );
}
