"use client";

// The rewind path: a practice question on the Scantron sheet → Check answer → the grading beat (the
// right oval, the red pen, a margin note with his time) → Rewind → the sheet slides up into a strip →
// the rewind plays the moment the professor explains it.

import { startTransition, useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { DUR, EASE, easeOut, prefersReducedMotion } from "@/lib/motion";
import { CodeBlock } from "@/components/paper/CodeBlock";
import { Oval } from "@/components/paper/Oval";
import { BackButton, ScantronSheet, ShellStrip, TimingMarks, type SheetGrade } from "@/components/paper/ScantronSheet";
import { EmbedSetupCard } from "@/components/rewind/EmbedSetupCard";
import { RewindPlayer } from "@/components/rewind/RewindPlayer";
import { PLAYER_PLAY_IS_PRIMARY, TutorPanel } from "@/components/tutor/TutorPanel";
import type { TutorConfig } from "@/components/tutor/types";
import { recordAttempt } from "@/lib/attempts/client";
import type { PracticeSeed, SeedQuestion } from "@/lib/demo/types";
import { courseTitle, deckDisplayName, formatTime, inSentence } from "@/lib/format";
import type { ChoiceLabel, Confidence } from "@/lib/schema";
import { Rich } from "@/components/paper/RichText";

type Phase = "asking" | "graded" | "missed";

/** The answer sheet as it looked when Check answer was pressed, for the fold into the strip. */
interface SheetSnapshot {
  rect: DOMRect;
  radius: number;
  node: HTMLElement;
}

/** The graded sheet morphs into the strip (--dur-3 on --ease-out) while the deck rises and the reels rewind (--dur-rewind). */
const FOLD_MS = DUR[3];
/** The grading beat up to its note (globals.css: the pen from --dur-1 for --dur-3, then the note for --dur-2). */
const BEAT_MS = DUR[1] + DUR[3] + DUR[2];

const FOLD_STEPS = 24;
/** Fractions of the way (after easing) at which the sheet's print hands over to the strip's: they never overlap. */
const OLD_PRINT_FROM = 0.78;
const OLD_PRINT_GONE = 0.86;
const NEW_PRINT_FROM = 0.9;
const NEW_PRINT_DONE = 0.97;
const lerp = (a: number, b: number, e: number) => a + (b - a) * e;
/** Piecewise-linear ramp: 0 before t0, 1 after t1. */
const ramp = (t: number, t0: number, t1: number) => Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));

/**
 * Shared-element morph: the graded sheet slides left and scales into the strip in the left column as one piece of
 * paper (one uniform scale, so its print never distorts), its edges closing in on the strip's. The sheet's print rides
 * along until the paper is all but the strip's size, then hands over to the strip's print, never both at once and never
 * an empty sheet in mid-flight. The deck (`rise`) rises in from below as the print hands over, while the reels spin back.
 * Only transform, opacity and clip-path animate. Returns a cleanup that ends it at once.
 */
function morphIntoStrip(sheet: SheetSnapshot, strip: HTMLElement, rise: HTMLElement[], done: () => void): () => void {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const a = sheet.rect;
  const b = strip.getBoundingClientRect();
  const rb = parseFloat(getComputedStyle(strip).borderTopLeftRadius) || 0;

  const ghost = document.createElement("div");
  ghost.dataset.stripGhost = "";
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.style.cssText = "position:fixed;inset:0;z-index:50;pointer-events:none;overflow:hidden";
  const box = document.createElement("div");
  box.className = "bg-paper";
  box.style.cssText = "position:absolute;inset:0";
  const layer = (node: HTMLElement, r: DOMRect) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;transform-origin:0 0;will-change:transform,opacity`;
    node.removeAttribute("tabindex");
    Object.assign(node.style, { margin: "0", width: "100%", height: "100%", minHeight: "0", maxWidth: "none", maxHeight: "none", opacity: "" });
    wrap.append(node);
    return wrap;
  };
  const oldLayer = layer(sheet.node, a);
  const newLayer = layer(strip.cloneNode(true) as HTMLElement, b);
  ghost.append(box, oldLayer, newLayer);
  document.body.append(ghost);
  strip.style.opacity = "0";

  const boxFrames: Keyframe[] = [];
  const oldFrames: Keyframe[] = [];
  const newFrames: Keyframe[] = [];
  for (let i = 0; i <= FOLD_STEPS; i++) {
    const t = i / FOLD_STEPS;
    const e = easeOut(t);
    const x = lerp(a.left, b.left, e);
    const y = lerp(a.top, b.top, e);
    const w = lerp(a.width, b.width, e);
    const h = lerp(a.height, b.height, e);
    const r = lerp(sheet.radius, rb, e);
    boxFrames.push({
      offset: t,
      clipPath: `inset(${Math.max(0, y)}px ${Math.max(0, vw - x - w)}px ${Math.max(0, vh - y - h)}px ${Math.max(0, x)}px round ${r}px)`,
    });
    // Each print keeps its proportions (uniform scale to the paper's current width), clipped to the paper.
    const print = (from: DOMRect, opacity: number): Keyframe => {
      const s = w / from.width;
      return {
        offset: t,
        transform: `translate(${x - from.left}px, ${y - from.top}px) scale(${s})`,
        clipPath: `inset(0px 0px ${Math.max(0, from.height - h / s)}px 0px round ${r / s}px)`,
        opacity,
      };
    };
    oldFrames.push(print(a, 1 - ramp(e, OLD_PRINT_FROM, OLD_PRINT_GONE)));
    newFrames.push(print(b, ramp(e, NEW_PRINT_FROM, NEW_PRINT_DONE)));
  }
  const timing: KeyframeAnimationOptions = { duration: FOLD_MS, easing: "linear", fill: "forwards" };
  const anims = [box.animate(boxFrames, timing), oldLayer.animate(oldFrames, timing), newLayer.animate(newFrames, timing)];
  // The deck rises in from below once the sheet's print has gone (so the two are never on screen together). A "solid"
  // riser (the phone's pinned Next bar) covers what scrolls under it, so it only slides.
  const handover = FOLD_MS * 0.6;
  for (const el of rise) {
    const solid = el.dataset.rise === "solid";
    anims.push(
      el.animate(solid ? [{ transform: "translateY(40px)" }, { transform: "none" }] : [{ transform: "translateY(40px)", opacity: 0 }, { transform: "none", opacity: 1 }], {
        duration: DUR[3],
        delay: solid ? 0 : handover,
        easing: EASE.settle,
        fill: "backwards",
      }),
    );
  }

  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    for (const an of anims) an.cancel();
    ghost.remove();
    strip.style.opacity = "";
  };
  anims[0].finished.then(
    () => {
      ghost.remove();
      strip.style.opacity = "";
      done();
    },
    () => {},
  );
  return end;
}

/** Where the sheet column and the player column were just before the tutor opened or closed (desktop, rewind screen). */
interface CollapseSnapshot {
  open: boolean;
  col: DOMRect;
  strip: DOMRect;
  stripNode: HTMLElement | null;
  summary: DOMRect | null;
}

/** Sets where an element scales from (outside the component, so the compiler's ref rules stay quiet). */
const setOrigin = (el: HTMLElement, origin: string) => {
  el.style.transformOrigin = origin;
};

const DESKTOP = "(min-width: 1024px)";
const subscribeDesktop = (cb: () => void) => {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const isDesktop = () => window.matchMedia(DESKTOP).matches;

/**
 * The phone's compact graded summary ("You marked A, … / Correct: …"), as a strip over the slide while the tutor is open
 * on desktop. "Show question" opens the whole question over the slide (nothing below moves).
 */
function MissedSummary({ q, marked, heading, ref }: { q: SeedQuestion; marked: ChoiceLabel | null; heading: string; ref: Ref<HTMLDivElement> }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const right = marked === q.answer;
  const text = (l: ChoiceLabel | null) => inSentence(q.choices.find((c) => c.label === l)?.text ?? "");
  const rows =
    marked === null
      ? [{ label: q.answer, state: "empty" as const, line: q.stem }]
      : right
        ? [{ label: q.answer, state: "correct" as const, line: `You marked ${q.answer}, correct: ${text(q.answer)}` }]
        : [
            { label: marked, state: "wrong" as const, line: `You marked ${marked}, ${text(marked)}` },
            { label: q.answer, state: "correct" as const, line: `Correct: ${text(q.answer)}` },
          ];
  return (
    <div ref={ref} data-missed-summary="" className="relative">
      <div className="paper-sheet flex items-center gap-2 rounded-md bg-paper px-3 py-2 text-ink">
        <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <li key={r.line} className="flex min-w-0 items-center gap-2.5">
              {marked === null ? null : <Oval letter={r.label} state={r.state} />}
              <span title={r.line} className={`min-w-0 flex-1 truncate font-serif text-[15px] leading-snug ${r.state === "correct" ? "font-semibold" : ""}`}>
                {r.line}
              </span>
            </li>
          ))}
        </ul>
        {/* Inside the strip, at its right end (John, Oct 25: never floating above it). */}
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="btn btn-tertiary -my-1 -mr-1.5 min-h-11 flex-none self-center text-sm">
          {open ? "Hide question" : "Show question"}
        </button>
      </div>
      {open ? (
        <div
          id={id}
          role="region"
          aria-label={heading}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          className="paper-sheet thin-scroll absolute inset-x-0 top-full z-20 mt-1.5 flex max-h-[min(420px,60dvh)] flex-col gap-2.5 overflow-y-auto rounded-md bg-paper px-4 pt-3 pb-8 text-ink shadow-[0_12px_28px_-8px_rgb(0_0_0/0.6)]"
        >
          <div className="border-b-[1.5px] border-print pb-1.5 text-sm text-print">{heading}</div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-[18px] font-semibold text-print">{q.n}.</span>
            <p className="m-0 font-serif text-[18px] leading-snug font-semibold"><Rich text={q.stem} /></p>
          </div>
          {q.code?.lines.length ? <CodeBlock code={q.code} n={q.n} compact /> : null}
          <ul className="m-0 flex list-none flex-col p-0">
            {q.choices.map((c) => {
              const state = marked !== null && c.label === marked && !right ? "wrong" : marked !== null && c.label === q.answer ? "correct" : "empty";
              return (
                <li key={c.label} className="flex items-center gap-3 border-b border-paper-rule py-1.5 last:border-0">
                  <Oval letter={c.label} state={state} />
                  <span className={`flex-1 font-serif text-[15px] ${state === "correct" ? "font-semibold" : ""}`}><Rich text={c.text} /></span>
                  {state === "wrong" ? <span className="text-[13px] font-bold text-red-pen">You marked</span> : null}
                  {state === "correct" ? <span className="text-[13px] font-bold text-print">Correct</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A slide image: the demo bundle gives URLs (/demo/slides/q1.svg); the local seed gives file names for the dev route. */
const slideHref = (q: SeedQuestion) => {
  const image = q.match.slide.image;
  if (!image) return ""; // a Canvas page: its words, no image
  return /^(\/|https?:\/\/)/.test(image) ? image : `/api/dev-slides/${image}`;
};
/** A Canvas page of text (a course with no slides or files): no image, no page number. */
const isCanvasPage = (q: SeedQuestion) => !q.match.slide.image;
/** "page 3" / "slide 84", or "the course page" for a Canvas page. */
const placeWords = (q: SeedQuestion) => (q.quick ? q.quick.where : isCanvasPage(q) ? "the course page" : `${pageWord(q)} ${q.match.slide.page}`);

/** The lecture moment that explains it, or null when there's no recording of it (the slide is the fallback). */
function clipOf(q: SeedQuestion): { start: number; end: number } | null {
  const { start, end } = q.match as { start: number | null; end: number | null };
  return typeof start === "number" && typeof end === "number" ? { start, end } : null;
}

/** "Slide 84 · Sets, Maps & Hash Tables": how a slide is named wherever it is the source. */
const slideLabel = (q: SeedQuestion) => (q.quick ? q.quick.label : isCanvasPage(q) ? `Page · ${deckDisplayName(q.match.slide.deck)}` : `${pageWord(q, true)} ${q.match.slide.page} · ${deckDisplayName(q.match.slide.deck)}`);
/** "slide" for a lecture deck, "page" for a course document (syllabus, review sheet). */
const pageWord = (q: SeedQuestion, cap = false) => (q.match.slide.kind === "page" ? (cap ? "Page" : "page") : cap ? "Slide" : "slide");
/** The deck in Canvas when the export has it, else the slide image. */
const slideLinkLabel = (q: SeedQuestion) => (q.match.slide.canvasUrl ? "Open in Canvas" : "Open slide");

function sourceOf(q: SeedQuestion) {
  return { label: slideLabel(q), href: q.match.slide.canvasUrl ?? slideHref(q), hrefLabel: slideLinkLabel(q) };
}

/**
 * Dev only: e2e tests can patch seed questions (a question with code, one without a clip) by setting
 * window.__rewindSeedPatch = { [questionIndex]: { ...fields, match: { ...fields } } } before the page loads.
 */
type SeedPatch = Record<number, Partial<Omit<SeedQuestion, "match">> & { match?: Partial<Record<keyof SeedQuestion["match"], unknown>> }>;
const noSubscribe = () => () => {};
/** True once hydrated (false in the server render and the hydration pass): main[data-hydrated] tells tests the answers take clicks. */
const useHydrated = () => useSyncExternalStore(noSubscribe, () => true, () => false);
function useDevSeedPatch(): SeedPatch | null {
  return useSyncExternalStore(
    noSubscribe,
    () => (process.env.NODE_ENV === "development" ? ((window as unknown as { __rewindSeedPatch?: SeedPatch }).__rewindSeedPatch ?? null) : null),
    () => null,
  );
}

/** A question that gets the wider sheet column: a stem over ~300 characters, or code (John, Oct 25). */
export const longQuestion = (q: SeedQuestion) => q.stem.length > 300 || !!q.code?.lines.length;

/**
 * The strip's type sizes, largest first, stepped down until a long question fits. The stem stays between 18 and 20 px
 * (a readable measure, never under ~45 characters a line: John, Oct 25); the choices, code and rows give way first, and
 * past the last step the strip scrolls inside rather than shrink the stem further.
 */
const STRIP_FIT = [
  { stem: 20, choice: 18, code: 13, row: 50 },
  { stem: 19, choice: 17, code: 12.5, row: 44 },
  { stem: 18, choice: 16, code: 12, row: 40 },
  { stem: 18, choice: 15, code: 11.5, row: 36 },
  { stem: 18, choice: 14, code: 11, row: 32 },
  { stem: 18, choice: 13, code: 10.5, row: 30 },
];


/** `marked` null: the tutor sent the student to a moment before they answered, so nothing is marked and the key stays hidden. */
function MissedSheet({ q, marked, heading, shell, ref }: { q: SeedQuestion; marked: ChoiceLabel | null; heading: string; shell?: 1 | 2 | 3 | 4 | null; ref: Ref<HTMLDivElement> }) {
  const right = marked === q.answer;
  // Inside a sentence ("You marked A, the new key…"), as the phone strip reads (PhoneRewind line 31).
  const markedText = inSentence(q.choices.find((c) => c.label === marked)?.text ?? "");
  const correctText = inSentence(q.choices.find((c) => c.label === q.answer)?.text ?? "");
  // Desktop: the strip shows the whole question (stem, every code line, every choice) without scrolling:
  // it steps its type down until it fits its column, measured before paint.
  const own = useRef<HTMLDivElement | null>(null);
  const [step, setStep] = useState(0);
  const fit = STRIP_FIT[step];
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || !window.matchMedia("(min-width: 1024px)").matches) return;
    if (el.scrollHeight > el.clientHeight + 1 && step < STRIP_FIT.length - 1) setStep(step + 1);
  }, [step]);
  return (
    // Focus lands here after a miss, so a screen reader reads what you marked and the right answer.
    <div
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as { current: HTMLDivElement | null }).current = el;
      }}
      tabIndex={-1}
      data-strip-fit={step}
      style={{ "--strip-stem": `${fit.stem}px`, "--strip-choice": `${fit.choice}px`, "--strip-code": `${fit.code}px`, "--strip-row": `${fit.row}px` } as React.CSSProperties}
      className="paper-form relative flex flex-col gap-2 overflow-hidden rounded-md bg-paper px-3.5 py-3 text-ink outline-none lg:gap-3 lg:overflow-y-auto lg:pt-[22px] lg:pb-[36px] lg:pr-8 lg:pl-[18px]"
    >
      <ShellStrip shell={shell} />
      <TimingMarks count={12} className="top-9 right-2 bottom-10 hidden lg:flex" />
      <div className="hidden border-b-[1.5px] border-print pb-2 text-sm text-print lg:block">{heading}</div>
      {/* The number runs in the stem's first line, so the stem has the strip's whole width; its size is the largest from
          18 to 20 px that keeps ~45 characters a line in this column (strip-stem in app/globals.css). */}
      <p data-stem="" className="strip-stem hidden font-serif leading-[1.45] font-semibold lg:block">
        <span className="text-print">{q.n}.</span> <Rich text={q.stem} />
      </p>
      {q.code?.lines.length ? <CodeBlock code={q.code} n={q.n} compact className="hidden lg:block lg:text-(length:--strip-code)" /> : null}
      {/* Phone: only the marked and correct rows. Desktop: every row. */}
      <ul className="flex flex-col">
        {q.choices.map((c) => {
          const isMarked = marked !== null && c.label === marked && !right;
          const isCorrect = marked !== null && c.label === q.answer;
          return (
            <li
              key={c.label}
              className={`${isMarked || isCorrect || marked === null ? "flex" : "hidden lg:flex"} items-center gap-2.5 lg:min-h-(--strip-row) lg:gap-3.5 lg:border-b lg:border-paper-rule lg:last:border-0`}
            >
              <Oval letter={c.label} state={isMarked ? "wrong" : isCorrect ? "correct" : "empty"} />
              <span className={`min-w-0 flex-1 font-serif text-[17px] text-pretty lg:text-(length:--strip-choice) ${isCorrect ? "font-semibold" : ""}`}>
                <span className="lg:hidden">
                  {isMarked ? (
                    <>
                      You marked {c.label}, <Rich text={markedText} />
                    </>
                  ) : isCorrect ? (
                    <>
                      {right ? `You marked ${c.label}, correct: ` : "Correct: "}
                      <Rich text={correctText} />
                    </>
                  ) : (
                    <Rich text={c.text} />
                  )}
                </span>
                <span className="hidden lg:inline">
                  <Rich text={c.text} />
                </span>
                {/* The grade sits under the option's text, not in a column beside it, so the text has the row's whole width. */}
                {isMarked ? <span className="hidden font-sans text-[13px] leading-snug font-bold text-red-pen lg:block">You marked</span> : null}
                {isCorrect ? <span className="fade-in hidden font-sans text-[13px] leading-snug font-bold text-print lg:block">{right ? "You marked · Correct" : "Correct"}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Asking → Check answer → graded (the grading beat on the full-size sheet: right oval green, a miss
 * circled in red pen, the margin note, then the next steps) → on "Rewind to his explanation", missed (the
 * sheet folds into a strip and the rewind plays). The player is mounted, out of sight, from the moment the
 * answer is checked, so the recording is already cued at the clip start when Rewind is pressed.
 */
export function PracticeFlow({
  seed,
  extensionId,
  media,
  tutor,
  shells,
  remote,
}: {
  seed: PracticeSeed;
  extensionId: string;
  /** Quick build: the student's own recording, driven in a Zoom tab by the extension (zoom-remote), or, without the extension, the stored lines. */
  remote?: boolean;
  /** Demo mode: the hosted clips by question id (file URL, lecture second it starts at); any other question shows its transcript. */
  media?: { clips: Record<string, { src: string; offset: number }> };
  tutor?: TutorConfig;
  /** Each question's module as a tape colour (1..4): it runs along the sheet and the player. */
  shells?: Record<string, 1 | 2 | 3 | 4 | null>;
}) {
  const patch = useDevSeedPatch();
  const hydrated = useHydrated();
  const questions = useMemo(
    () =>
      patch
        ? seed.questions.map((q, i) => (patch[i] ? ({ ...q, ...patch[i], match: { ...q.match, ...patch[i].match } } as SeedQuestion) : q))
        : seed.questions,
    [seed.questions, patch],
  );
  const total = questions.length;
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<ChoiceLabel | null>(null);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [phase, setPhase] = useState<Phase>("asking");
  // The hidden player (it cues the recording before Rewind) mounts once the grading beat has drawn (its pen and
  // note), in a transition, so the beat's frames only paint the sheet. Rewind before then mounts it at once.
  const [cue, setCue] = useState(false);
  useEffect(() => {
    if (phase !== "graded") return;
    const t = window.setTimeout(() => startTransition(() => setCue(true)), BEAT_MS);
    return () => window.clearTimeout(t);
  }, [phase]);
  const [progress, setProgress] = useState<("right" | "wrong" | null)[]>(() => seed.questions.map(() => null));
  const q = questions[index];
  const clip = clipOf(q);
  const right = selected === q.answer;
  const mainRef = useRef<HTMLElement>(null);
  // N / Next question: focus moves to the new question's stem (its h1), so a screen reader starts there
  // and Tab continues from it. Not on the first question of a visit.
  const firstQuestion = useRef(true);
  useEffect(() => {
    if (firstQuestion.current) {
      firstQuestion.current = false;
      return;
    }
    mainRef.current?.querySelector<HTMLElement>("h1[tabindex]")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [index]);
  // The tutor: open or not, and a lecture moment it sent the student to (plays instead of the question's own clip).
  const [tutorOpen, setTutorOpen] = useState(false);
  // "Ask the tutor" stays disabled until the panel can open (TutorPanel has mounted its dialog on the hydrated page),
  // so a tap before then is visibly not available instead of silently doing nothing.
  const [tutorReady, setTutorReady] = useState(false);
  const [momentClip, setMomentClip] = useState<{ start: number; end: number } | null>(null);
  const tutorOpener = useRef<HTMLElement | null>(null);
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop, () => false);
  /** Desktop, rewind screen: opening the tutor collapses the sheet column into the summary strip (and closing it brings the column back). */
  const collapseFrom = useRef<CollapseSnapshot | null>(null);
  const toggleTutor = (open: boolean) => {
    collapseFrom.current = null;
    if (phase === "missed" && isDesktop() && !prefersReducedMotion()) {
      const strip = stripRef.current;
      const col = playerColRef.current;
      const summary = summaryRef.current;
      if (strip && col) {
        collapseFrom.current = {
          open,
          col: col.getBoundingClientRect(),
          strip: strip.getBoundingClientRect(),
          stripNode: open ? (strip.cloneNode(true) as HTMLElement) : null,
          summary: summary?.getBoundingClientRect() ?? null,
        };
      }
    }
    setTutorOpen(open);
  };
  const openTutor = (opener: HTMLElement | null) => {
    if (!tutorReady) return;
    tutorOpener.current = opener;
    toggleTutor(true);
  };
  const playerColRef = useRef<HTMLElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  /** Replays the rewound moment (the tutor's chip for it) without changing the clip. */
  const [replay, setReplay] = useState(0);
  const returnFocus = useCallback(() => tutorOpener.current, []);
  const stripRef = useRef<HTMLDivElement>(null);
  const sheetSnapshot = useRef<SheetSnapshot | null>(null);
  /** How long the rewind waits for the sheet to fold into the strip (0 with reduced motion). */
  const [rollDelay, setRollDelay] = useState(0);
  /** While the clip has the stage (rewinding, loading, playing), Play/Pause is the one primary button and Next steps back. */
  const [clipActive, setClipActive] = useState(true);
  /** The embed setup card goes in the strip's column on desktop, where there's room, so the player stays on screen. */
  const [setupCard, setSetupCard] = useState(false);

  const check = useCallback(() => {
    if (!selected) return;
    // Every checked answer, right or wrong, is saved on this device only (lib/attempts/store.ts).
    recordAttempt(seed, q, selected, confidence);
    setProgress((p) => p.map((v, i) => (i === index ? (selected === q.answer ? "right" : "wrong") : v)));
    setPhase("graded");
  }, [selected, q, index, seed, confidence]);

  // Only on Rewind: the sheet folds into the strip, the reels and counter rewind, then the clip plays.
  const rewind = (override?: { start: number; end: number }) => {
    if (!(override ?? clip)) return;
    const sheet = mainRef.current?.firstElementChild as HTMLElement | null | undefined;
    sheetSnapshot.current =
      sheet && !prefersReducedMotion()
        ? { rect: sheet.getBoundingClientRect(), radius: parseFloat(getComputedStyle(sheet).borderTopLeftRadius) || 0, node: sheet.cloneNode(true) as HTMLElement }
        : null;
    setRollDelay(0);
    setPhase("missed");
  };

  /** A mini-tape chip in the tutor: play the lecture from that moment (the phone sheet closes to show it). */
  const openMoment = (start: number) => {
    if (window.matchMedia("(max-width: 1023.98px)").matches) setTutorOpen(false);
    // The rewound moment itself (the greeting's chip): play it again from its start, same clip.
    if (phase === "missed" && !momentClip && clip && start === clip.start) {
      setReplay((n) => n + 1);
      return;
    }
    const c = { start, end: start + 60 };
    setMomentClip(c);
    if (phase === "missed") setRollDelay(0);
    else rewind(c);
  };

  const next = useCallback(() => {
    sheetSnapshot.current = null;
    setIndex((i) => (i + 1) % total);
    setCue(false);
    setMomentClip(null);
    setReplay(0);
    setSelected(null);
    setConfidence(null);
    setPhase("asking");
  }, [total]);

  // Preload (and decode) this question's slide while it's being answered, so after a miss the slide is in
  // the first frame instead of a skeleton.
  const slideSrc = slideHref(q);
  useEffect(() => {
    if (!slideSrc) return;
    const img = new Image();
    img.src = slideSrc;
    img.decode().catch(() => {});
  }, [slideSrc]);

  const slideLink = q.match.slide.canvasUrl ?? slideHref(q);
  const at = clip ? formatTime(clip.start) : null;
  // No lecture clip: the sheet shows the slide (or page) itself, never a player with nothing to play;
  // a Canvas page shows the words the question quotes from it.
  const noClip = clip
    ? null
    : {
        src: slideHref(q),
        alt: isCanvasPage(q) ? slideLabel(q) : `${pageWord(q, true)} ${q.match.slide.page} of ${deckDisplayName(q.match.slide.deck)}`,
        excerpt: q.match.slide.excerpt,
        caption: q.quick ? { title: q.quick.label, sub: "Where the question comes from, word for word" } : undefined,
      };
  // The professor by name when the course knows it ("Kapoor explains this at 57:43"), else "your professor"; never he/him/his.
  const named = seed.lecturer.short && !/^the lecturer$/i.test(seed.lecturer.short) ? seed.lecturer.short : null;
  const who = named ?? "your professor";
  const Who = named ?? "Your professor";
  const whose = named ? `${named}'s` : "your professor's";
  const grade: SheetGrade | null =
    phase === "asking"
      ? null
      : right
        ? {
            right: true,
            announce: `Correct. The answer is ${q.answer}.`,
            note: null,
            explain: clip ? { label: `Hear how ${who} explains it`, onClick: () => rewind() } : null,
            noClip,
          }
        : {
            right: false,
            announce: `Incorrect. You marked ${selected}. The answer is ${q.answer}. ${at ? `${Who} explains it at ${at}.` : `It's on ${placeWords(q)}.`}`,
            note: at ? `${Who} explains this at ${at} →` : `It's on ${placeWords(q)} →`,
            explain: clip ? { label: `Rewind to ${whose} explanation`, onClick: () => rewind() } : slideLink ? { label: isCanvasPage(q) ? "Open the page" : `Open ${placeWords(q)}`, href: slideLink } : null,
            noClip,
            quote: q.quick && clip ? { title: q.quick.label, text: q.quick.quote } : null,
          };

  // Keyboard: A to D picks, Enter checks; once graded R rewinds and N goes to the next question.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Typing to the tutor never picks an answer or moves on.
    if ((e.target as HTMLElement | null)?.closest?.("[data-tutor]")) return;
    const key = e.key.toUpperCase();
    if (phase === "asking" && /^[A-D]$/.test(key) && q.choices.some((c) => c.label === key)) setSelected(key as ChoiceLabel);
    else if (phase === "asking" && e.key === "Enter") {
      // Enter on a focused answer checks it; on other buttons it keeps its normal meaning.
      const el = e.target as HTMLElement | null;
      if (el?.tagName !== "BUTTON" || el.getAttribute("role") === "radio") {
        e.preventDefault();
        check();
      }
    } else if (phase === "graded" && key === "R") {
      if (clip) rewind();
      else if (!right) window.open(slideLink, "_blank", "noreferrer");
    } else if (phase !== "asking" && key === "N") next();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // After Rewind: the sheet folds into the strip while the deck rises (instant with reduced motion),
  // then focus moves to the strip. Before paint, so the first frame is already the fold's first frame.
  useLayoutEffect(() => {
    if (phase !== "missed") return;
    const strip = stripRef.current;
    if (!strip) return;
    // Phone: the page lands scrolled so the transport sits just above the pinned Next bar from the first frame (the
    // strip's place is measured after, so the morph lands on it); desktop fits the window, so it starts at the top.
    // The same placement RewindPlayer asks for once the clip has the stage (block "end" against the page's
    // scroll-padding), made at once, so the page doesn't glide there afterwards.
    const card = mainRef.current?.querySelector<HTMLElement>("[data-transport]");
    if (card && !isDesktop()) card.scrollIntoView({ block: "end", behavior: "instant" });
    else if (window.scrollY > 1) window.scrollTo(0, 0);
    const snap = sheetSnapshot.current;
    const land = () => {
      sheetSnapshot.current = null;
      strip.focus({ preventScroll: true });
    };
    if (!snap) {
      land();
      return;
    }
    const rise = [...(mainRef.current?.querySelectorAll<HTMLElement>("[data-rise]") ?? [])];
    // The snapshot is cloned again so a re-run (React's dev double effects) starts from a fresh copy.
    return morphIntoStrip({ ...snap, node: snap.node.cloneNode(true) as HTMLElement }, strip, rise, land);
  }, [phase]);

  // The collapse (~--dur-2, transform and opacity only): the player column glides to its new place; opening, a copy of
  // the sheet shrinks into the summary strip as it fades; closing, the sheet grows back out of the strip.
  useLayoutEffect(() => {
    const from = collapseFrom.current;
    collapseFrom.current = null;
    const col = playerColRef.current;
    if (!from || !col) return;
    const anims: Animation[] = [];
    const timing: KeyframeAnimationOptions = { duration: DUR[2], easing: EASE.out };
    const to = col.getBoundingClientRect();
    anims.push(col.animate([{ transform: `translate(${from.col.left - to.left}px, ${from.col.top - to.top}px)` }, { transform: "none" }], timing));
    const summary = summaryRef.current?.getBoundingClientRect() ?? null;
    let ghost: HTMLElement | null = null;
    if (from.open && from.stripNode && summary) {
      ghost = from.stripNode;
      ghost.removeAttribute("tabindex");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      Object.assign(ghost.style, { position: "fixed", left: `${from.strip.left}px`, top: `${from.strip.top}px`, width: `${from.strip.width}px`, height: `${from.strip.height}px`, margin: "0", zIndex: "30", pointerEvents: "none", transformOrigin: "0 0" });
      document.body.append(ghost);
      // It collapses to the strip's height at the strip's top-left corner (one uniform scale, so the print never stretches).
      const s = Math.min(1, summary.height / from.strip.height);
      anims.push(
        ghost.animate(
          [
            { transform: "none", opacity: 1 },
            { opacity: 0.6, offset: 0.5 },
            { transform: `translate(${summary.left - from.strip.left}px, ${summary.top - from.strip.top}px) scale(${s})`, opacity: 0 },
          ],
          { ...timing, fill: "forwards" },
        ),
      );
      if (summaryRef.current) anims.push(summaryRef.current.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], timing));
    } else if (!from.open && from.summary && stripRef.current) {
      const strip = stripRef.current;
      const r = strip.getBoundingClientRect();
      const s = Math.min(1, from.summary.height / r.height);
      setOrigin(strip, "0 0");
      anims.push(strip.animate([{ transform: `translate(${from.summary.left - r.left}px, ${from.summary.top - r.top}px) scale(${s})`, opacity: 0 }, { transform: "none", opacity: 1 }], timing));
    }
    const end = () => {
      for (const a of anims) a.cancel();
      ghost?.remove();
      if (stripRef.current) setOrigin(stripRef.current, "");
    };
    anims[0].finished.then(end, () => {});
    return end;
  }, [tutorOpen]);

  const missed = phase === "missed";
  /** Desktop rewind screen with the tutor open: two columns (the player with the graded summary over it, and the tutor). */
  const tutorMode = missed && tutorOpen && desktop && !!tutor;
  // While the tutor is open beside the rewind, Next question is the one primary; otherwise the clip has it while it plays.
  const nextPrimary = tutorMode || !(clipActive || tutorOpen);
  const nextButton = (
    <button
      type="button"
      onClick={next}
      data-primary={nextPrimary ? "" : undefined}
      className={`btn btn-lg w-full ${nextPrimary ? "btn-primary" : "btn-secondary"}`}
    >
      Next question
    </button>
  );

  // The tutor's way in: a quiet outline button where the screen has room for it.
  const askButton = (className: string) =>
    tutor ? (
      <button
        type="button"
        data-ask-tutor=""
        aria-disabled={!tutorReady || undefined}
        onClick={(e) => openTutor(e.currentTarget)}
        className={`lift min-h-11 rounded-[10px] border-2 border-deck-line px-4 text-[15px] font-bold text-label aria-disabled:cursor-default aria-disabled:opacity-45 ${tutorOpen ? "invisible" : ""} ${className}`}
      >
        Ask the tutor
      </button>
    ) : null;
  /** The clip the player plays: a moment the tutor sent the student to, else the question's own. */
  const playClip = momentClip ?? clip;
  // Desktop, tutor open: the page gives the panel its column (Tutor mockup: 24 px margins, 20 px gaps, a 340 px strip).
  const tight = !!tutor && tutorOpen;

  return (
    <main
      ref={mainRef}
      data-hydrated={hydrated ? "" : undefined}
      data-phase={phase}
      data-tutor-open={tight ? "" : undefined}
      // Desktop: the sheet is pinned to the top (its own 32 px margin), not centred, so asking, graded and the
      // no-clip fallback never move it as its height changes.
      className={`${missed ? "flex flex-1 flex-col text-label" : "flex flex-1 flex-col lg:items-center lg:justify-start lg:px-8"} ${tight && !missed ? "lg:pr-[424px]" : ""}`}
    >
      {missed ? null : (
        <ScantronSheet
          shell={shells?.[q.id] ?? null}
          title={tutor?.graded && tutor.gradedIds.includes(q.id) ? `${tutor.graded.name} practice` : `${seed.course.code}, ${seed.set}`}
          question={{ n: q.n, stem: q.stem, code: q.code, choices: q.choices, answer: q.answer, source: sourceOf(q) }}
          total={total}
          progress={progress}
          selected={selected}
          confidence={confidence}
          grade={grade}
          onSelect={setSelected}
          onConfidence={setConfidence}
          onCheck={check}
          onNext={next}
          onSkip={next}
          tutor={tutor ? { onOpen: (el) => openTutor(el), open: tutorOpen, ready: tutorReady } : undefined}
        />
      )}
      {/* The rewind screen. From Check answer it is already mounted, out of sight and inert, so the player
          cues the recording during the grading beat; Rewind just shows it and starts the rewind. */}
      {playClip && (phase === "missed" || (phase === "graded" && cue)) ? (
        <div
          key={`${q.id}:${momentClip?.start ?? ""}:${replay}`}
          inert={!missed}
          aria-hidden={missed ? undefined : true}
          data-rewind-screen=""
          className={missed ? "contents" : "pointer-events-none invisible fixed inset-0 -z-10 flex flex-col overflow-hidden bg-deck text-label"}
        >
          {/* The screen's heading for screen readers (the sheet's h1 is gone once it morphs into the strip). */}
          {missed ? <h1 className="sr-only">Rewind: question {q.n} of {total}</h1> : null}
          {/* Outside the demo (which has its own app header) the screen keeps a slim header of its own: one header either way. */}
          <header data-rise="" data-rewind-own-header="" className="hidden h-16 items-center justify-between px-8 lg:flex">
            <div className="font-display text-[30px] font-extrabold tracking-[-1px]">Rewind</div>
            <div className="text-base text-label-muted">{courseTitle(seed.course)}</div>
          </header>
          {/* Desktop: one frame, centred, growing with the window up to 1600 px (32 px margins at least): the sheet column
              (40% of the frame, 460 to 680 px, so the player keeps its width at 1280; a long question or one with code
              gets 50%, 520 to 760 px; so even a stem with long words keeps ~45 characters a line at 18 px, 1280 included) and the player
              column, which takes the rest as far as the height left allows, so the slide, the transport and the
              transcript all fit above the fold. The tutor opens over the right edge as a drawer. */}
          <div
            data-rewind-frame=""
            className={`flex flex-1 flex-col gap-2.5 px-5 pt-4 pb-6 lg:flex-row lg:items-start lg:justify-center lg:pt-3 lg:pb-3 ${tutorMode ? "lg:mr-[424px] lg:px-6" : "lg:mx-auto lg:w-full lg:max-w-[1600px] lg:gap-8 lg:px-8"}`}
          >
            <section data-sheet-column={longQuestion(q) ? "long" : ""} className={`sheet-column flex flex-col gap-2.5 lg:flex-none ${longQuestion(q) ? "lg:w-[clamp(520px,50%,760px)]" : "lg:w-[clamp(460px,40%,680px)]"} ${tutorMode ? "lg:hidden" : ""}`}>
              <div data-rise="" className="flex items-center gap-3 lg:hidden">
                <BackButton label="Back to the question" onClick={() => setPhase(selected ? "graded" : "asking")} />
                <div className="flex-1 text-[15px] text-label-muted">
                  Question {q.n} of {total}
                </div>
                {askButton("")}
              </div>
              <MissedSheet ref={stripRef} shell={shells?.[q.id] ?? null} q={q} marked={selected} heading={`${seed.set}, question ${q.n} of ${total}`} />
              {setupCard && missed ? (
                <div className="hidden shrink-0 lg:block">
                  <EmbedSetupCard origin={window.location.origin} />
                </div>
              ) : null}
              <div data-rise="" className="hidden flex-col gap-2.5 lg:flex">
                {askButton("w-full")}
                {nextButton}
              </div>
            </section>
            {/* The player column. design-elevation's transport keys (E2) are inside RewindPlayer; the tutor only reads whether the clip
                has the stage (PLAYER_PLAY_IS_PRIMARY in components/tutor/TutorPanel.tsx decides who is orange). */}
            <section ref={playerColRef} data-rise="" data-seam="e2-transport-keys" data-tutor-mode={tutorMode ? "" : undefined} className="player-column flex min-w-0 flex-col gap-2.5 lg:gap-2">
              <RewindPlayer
                source={
                  media
                    ? media.clips[q.id]
                      ? { kind: "hosted-media", src: media.clips[q.id].src, offset: media.clips[q.id].offset }
                      : { kind: "none" }
                    : remote
                      ? extensionId && q.match.recordingUrl
                        ? { kind: "zoom-remote", extensionId, recordingUrl: q.match.recordingUrl }
                        : { kind: "none" }
                      : { kind: "zoom-embed", extensionId, recordingUrl: q.match.recordingUrl ?? seed.recordingUrl }
                }
                clip={playClip}
                segments={q.segments}
                lecturer={seed.lecturer.short || who}
                slide={{
                  label: slideLabel(q),
                  imageSrc: slideHref(q),
                  href: slideLink,
                  hrefLabel: slideLinkLabel(q),
                  alt: `${pageWord(q, true)} ${q.match.slide.page} of ${deckDisplayName(q.match.slide.deck)}`,
                }}
                setup={momentClip ? null : q.match.setup}
                exampleStart={momentClip ? null : q.match.exampleStart}
                rollDelay={rollDelay}
                started={missed}
                accent={shells?.[q.id] ? `var(--color-tape-${shells[q.id]})` : undefined}
                onActiveChange={setClipActive}
                onSetupCardChange={setSetupCard}
                tutorMode={tutorMode}
                aboveSlide={tutorMode ? <MissedSummary ref={summaryRef} q={q} marked={selected} heading={`${seed.set}, question ${q.n} of ${total}`} /> : null}
              />
              {/* Tutor open: the sheet column is gone, so Next question (the one primary) closes the player column. */}
              {tutorMode ? <div className="hidden lg:block">{nextButton}</div> : null}
            </section>
            {/* Phone: Next question stays at the bottom of the screen however long the page gets. Kept short
                (48 px button) and the column above tightened, so Play/Pause and the scrub bar sit above it in the
                first frame on an 844 px phone. */}
            <div data-rise="solid" data-next-bar="" className="sticky bottom-0 -mx-5 mt-auto bg-deck px-5 pt-2 pb-3 lg:hidden">
              {nextButton}
            </div>
          </div>
        </div>
      ) : null}
      {tutor ? (
        <TutorPanel
          key={q.id}
          open={tutorOpen}
          onClose={() => toggleTutor(false)}
          config={tutor}
          ctx={{
            id: q.id,
            n: q.n,
            topic: deckDisplayName(q.match.slide.deck),
            marked: selected,
            wrongText: selected && selected !== q.answer ? (q.choices.find((c) => c.label === selected)?.text ?? null) : null,
            slideHref: slideLink,
            answered: phase !== "asking",
            question: q,
            start: clip?.start ?? null,
            slide: isCanvasPage(q) ? null : { page: q.match.slide.page, kind: q.match.slide.kind === "page" ? "page" : "slide" },
          }}
          onOpenMoment={openMoment}
          desktopTop="lg:top-[calc(var(--chrome-h)+16px)]"
          desktopSendPrimary={phase === "missed" && !tutorMode && !(PLAYER_PLAY_IS_PRIMARY && clipActive)}
          returnFocus={returnFocus}
          onReady={setTutorReady}
          studyHref={tutor.demo ? `/demo/study?q=${encodeURIComponent(q.id)}` : `/study?${tutor.set ? `set=${encodeURIComponent(tutor.set)}&` : ""}q=${encodeURIComponent(q.id)}`}
        />
      ) : null}
    </main>
  );
}
