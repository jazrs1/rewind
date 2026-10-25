"use client";

// The practice question on the Scantron sheet (PhonePractice / DesktopPractice mockups).

import { HandValues } from "@/components/type/HandValues";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import type React from "react";
import type { ChoiceLabel, Confidence } from "@/lib/schema";
import { ArrowLeft, RewindIcon } from "@/components/icons";
import { SourceLabel } from "@/components/source/SourceLabel";
import { CodeBlock, type QuestionCode } from "./CodeBlock";
import { Oval, PEN_LOOPS, RedPenCircle, type OvalState } from "./Oval";
import { Rich } from "./RichText";

export interface SheetQuestion {
  n: number;
  stem: string;
  choices: { label: ChoiceLabel; text: string }[];
  answer: ChoiceLabel;
  /** Code the question depends on, printed under the stem. */
  code?: QuestionCode | null;
  /** Where the question comes from: "Slide 84 · Sets, Maps & Hash Tables", and how to open it. */
  source: { label: string; href?: string; hrefLabel?: string };
}

export interface ScantronSheetProps {
  title: string;
  question: SheetQuestion;
  total: number;
  /** Per question: answered right, wrong, or not yet. */
  progress: ("right" | "wrong" | null)[];
  selected: ChoiceLabel | null;
  confidence: Confidence | null;
  /** After Check answer: the grade and the next steps, instead of asking. */
  grade: SheetGrade | null;
  onSelect(label: ChoiceLabel): void;
  onConfidence(c: Confidence | null): void;
  onCheck(): void;
  onNext(): void;
  onSkip(): void;
  /** The question's module (1..4): its tape colour runs along the top of the sheet. */
  shell?: 1 | 2 | 3 | 4 | null;
  /** The tutor's way in (shown only when the page has a tutor); the button that opens it gets focus back on close. */
  tutor?: { onOpen(opener: HTMLElement): void; open: boolean; /** The panel can open; until then the button is aria-disabled. */ ready: boolean };
}

/** The grading beat: what the sheet shows once the answer is checked (it stays full size). */
export interface SheetGrade {
  right: boolean;
  /** Said once by screen readers: "Incorrect. You marked C. The answer is B. He explains it at 15:18." */
  announce: string;
  /** After a miss, the red-pen note in the margin: "He explains this at 15:18 →". */
  note: string | null;
  /** The way to his explanation: the rewind (onClick), or the slide when there's no clip (href). */
  explain: { label: string; onClick?(): void; href?: string } | null;
  /** No lecture clip for this question: its slide, shown on the sheet with an honest line, never a broken player. */
  noClip?: { src: string; alt: string; excerpt?: string; caption?: { title: string; sub: string } } | null;
  /** Quick build, a miss with a recording: the exact words and where they are, on the sheet beside the Rewind button. */
  quote?: { title: string; text: string } | null;
}

/**
 * At most this many progress ovals: a long set shows a window around the current question. A lecture's
 * practice set fits whole, one oval per question (the demo's largest is 14; lib/demo/export.test.ts holds it to this).
 */
export const PROGRESS_DOTS = 14;

/** Which questions' ovals to draw (0-based): all of a short set, else PROGRESS_DOTS around `current`. */
export function progressWindow(total: number, current: number, size = PROGRESS_DOTS): number[] {
  const n = Math.min(total, size);
  const start = Math.max(0, Math.min(current - Math.floor((n - 1) / 2), total - n));
  return Array.from({ length: n }, (_, i) => start + i);
}


/**
 * No recording of it (PhoneReading lines 30-37): a blank grey tape that says so, then the slide he taught it
 * from. Missing things look missing; the slide is what there is. A Canvas page has no image: the words of it
 * the question is drawn from stand in for the slide.
 */
function NoClipSlide({ slide, className }: { slide: { src: string; alt: string; excerpt?: string; caption?: { title: string; sub: string } }; className: string }) {
  return (
    <figure data-no-clip="" className={`fade-in flex-col gap-2 ${className}`}>
      <figcaption className="flex items-center gap-3 rounded-xl bg-tape-blank px-3 py-2.5 text-label">
        <span aria-hidden="true" className="flex h-[34px] w-[52px] flex-none items-center justify-center rounded-md bg-tape-blank-label">
          <span className="h-4 w-[30px] rounded-lg bg-tape-blank" />
        </span>
        <span className="flex flex-col gap-0.5">
          <span data-source-title="" className="text-[15px] font-bold">{slide.caption?.title ?? "No tape for this lecture yet"}</span>
          <span className="text-[13px] text-label-muted">{slide.caption ? slide.caption.sub : slide.src ? <>So here&apos;s the slide it was taught from</> : "So here's the course page it's from"}</span>
        </span>
      </figcaption>
      {slide.src ? (
        <>
          {/* Slides are page renders we host; next/image adds nothing for these. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={slide.src} alt={slide.alt} className="max-h-32 w-auto self-start rounded border border-paper-rule bg-white object-contain lg:max-h-36" />
        </>
      ) : slide.excerpt ? (
        <blockquote data-page-excerpt="" aria-label={slide.alt} className="max-w-prose border-l-[3px] border-print bg-white/50 px-3 py-2 font-serif text-[16px] leading-snug text-ink">
          <Rich text={slide.excerpt} />
        </blockquote>
      ) : null}
    </figure>
  );
}

function QuoteCard({ quote, className }: { quote: { title: string; text: string }; className: string }) {
  return (
    <figure data-quote-card="" className={`fade-in m-0 flex-col gap-2 ${className}`}>
      <figcaption data-source-title="" className="text-[15px] font-bold text-print">
        {quote.title}
      </figcaption>
      <blockquote data-page-excerpt="" className="m-0 max-w-prose border-l-[3px] border-print bg-white/50 px-3 py-2 font-serif text-[16px] leading-snug text-ink">
        <Rich text={quote.text} />
      </blockquote>
    </figure>
  );
}

function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-print bg-paper-pale px-1 font-sans text-[12px] leading-none font-bold text-print shadow-[0_1.5px_0_var(--color-print)]">
      {children}
    </kbd>
  );
}


const CONFIDENCE: { value: Confidence; label: string }[] = [
  { value: "guessing", label: "Guessing" },
  { value: "fairly-sure", label: "Fairly sure" },
  { value: "certain", label: "Certain" },
];

/** The module's tape colour as a 6 px band along the sheet's top edge (E5). */
export function ShellStrip({ shell }: { shell?: 1 | 2 | 3 | 4 | null }) {
  if (!shell) return null;
  return <div aria-hidden="true" data-shell-strip={shell} className="absolute inset-x-0 top-0 h-1.5 rounded-t-md" style={{ background: `var(--color-tape-${shell})` }} />;
}

export function TimingMarks({ count, className = "" }: { count: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`absolute flex flex-col justify-between ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-1.5 w-4 bg-ink lg:h-[7px] lg:w-5" />
      ))}
    </div>
  );
}

export function BackButton({ href = "/", label = "Back", onClick }: { href?: string; label?: string; onClick?: () => void }) {
  const cls =
    "flex size-12 flex-none items-center justify-center rounded-[10px] border-2 border-current transition-transform duration-150 hover:-translate-y-0.5";
  const icon = (
    <ArrowLeft />
  );
  return onClick ? (
    <button type="button" aria-label={label} onClick={onClick} className={cls}>
      {icon}
    </button>
  ) : (
    <a href={href} aria-label={label} className={cls}>
      {icon}
    </a>
  );
}

/** `linkless`: the screen already has the way to open it (the no-clip miss's "Open slide N" button), so one link only. */
function Source({ source, className, linkless = false, printed = false }: { source: SheetQuestion["source"]; className: string; linkless?: boolean; printed?: boolean }) {
  // While asking, the source is printed like a form footer and opening the slide waits for the grade (it gives the answer away).
  return (
    <SourceLabel tone="paper" printed={printed} link={source.href && !linkless && !printed ? { href: source.href, label: source.hrefLabel ?? "Open slide" } : null} className={className}>
      {source.label}
    </SourceLabel>
  );
}

/** Desktop stem sizes, largest first (the mockup's 32 px), for fitting a long question on one screen. */
// Desktop stem sizes, largest first: 18 to 20 px at line-height 1.45, so the stem keeps a readable measure (never under
// ~45 characters a line) at every desktop width instead of the column squeezing it (John, Oct 25).
// Past the stem's floor, the choices step down too (a short stem over long choices is tall in its answers column).
const STEM_PX = [
  { stem: 20, choice: 20 },
  { stem: 19, choice: 19 },
  { stem: 18, choice: 18 },
  { stem: 18, choice: 17 },
  { stem: 18, choice: 16 },
];
/** The sheet's margin below on desktop (lg:my-8), and room kept for the margin note a miss adds. */
const SHEET_MARGIN = 32;
const NOTE_ROOM = 56;

/**
 * Desktop: the sheet fits the window without scrolling. A long stem or a code block can make it taller, so the
 * stem steps down (32, 28, 25, 22 px) until it fits, measured after layout and before paint (a ResizeObserver,
 * rendered at once with flushSync), so no frame shows it too big. While asking it keeps room for the margin note
 * a miss adds, so grading never changes the size. Starts again from 32 px for each question and window size.
 */
function useStemFit(sheet: React.RefObject<HTMLDivElement | null>, key: string, graded: boolean): (typeof STEM_PX)[number] {
  const [fit, setFit] = useState({ key, step: 0 });
  // A new question starts from the largest size (state adjusted while rendering, before anything paints).
  if (fit.key !== key) setFit({ key, step: 0 });
  const step = fit.key === key ? fit.step : 0;
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const measure = () => {
      if (!desktop.matches) return;
      // Measured from where the sheet starts (under the demo's header, or the page's top margin elsewhere).
      const top = el.getBoundingClientRect().top + window.scrollY;
      const room = window.innerHeight - top - SHEET_MARGIN - (graded ? 0 : NOTE_ROOM);
      if (el.offsetHeight > room) flushSync(() => setFit((f) => (f.step < STEM_PX.length - 1 ? { ...f, step: f.step + 1 } : f)));
    };
    // Fires once it starts observing, then whenever the sheet changes size (each step makes it shorter).
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const onResize = () => {
      flushSync(() => setFit((f) => (f.step ? { ...f, step: 0 } : f)));
      measure();
    };
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [sheet, graded]);
  return STEM_PX[step];
}

export function ScantronSheet(p: ScantronSheetProps) {
  const { question: q } = p;
  const grade = p.grade;
  const graded = !!grade;
  const answeredCount = p.progress.filter(Boolean).length;
  // The key hint shows on desktop after the first key press or when focus is in the answers (fix 8).
  const [keysSeen, setKeysSeen] = useState(false);
  useEffect(() => {
    const on = () => setKeysSeen(true);
    window.addEventListener("keydown", on, { once: true });
    return () => window.removeEventListener("keydown", on);
  }, []);
  // A miss with no recording: its one button opens the slide, so the source line doesn't repeat the link.
  const opensSlide = !!grade && !grade.right && !!grade.noClip;
  const sheetRef = useRef<HTMLDivElement>(null);
  const stemRef = useRef<HTMLHeadingElement>(null);
  // A to D (or a click) picks an answer: when focus is in the answers, it follows the choice, so it never stays on
  // the old radio (tabindex -1 since the roving tab stop moved).
  const answersRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const group = answersRef.current;
    if (!group || !p.selected || !group.contains(document.activeElement)) return;
    group.querySelector<HTMLButtonElement>(`[data-choice="${p.selected}"]`)?.focus();
  }, [p.selected]);
  // One of the hand-drawn red-pen loops for each question (so grades don't look stamped): it moves on with the
  // question, and picking an answer with the pointer reshuffles it (randomness only in an event handler, so
  // the prerendered page is the same every time).
  const [penSalt, setPenSalt] = useState(0);
  const penVariant = (penSalt + q.n) % PEN_LOOPS.length;
  // Arrow keys inside the answers: move to the next or previous answer and pick it.
  const onArrow = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step || graded) return;
    e.preventDefault();
    const labels = q.choices.map((c) => c.label);
    const from = labels.indexOf(p.selected ?? labels[0]);
    const to = labels[(from + (p.selected ? step : 0) + labels.length) % labels.length];
    p.onSelect(to);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-choice="${to}"]`)?.focus();
  };
  // No lecture clip: once graded, focus goes to the question (its slide is under it), not to a link that opens a new tab.
  const noClipGraded = graded && !!grade?.noClip;
  useEffect(() => {
    if (noClipGraded) stemRef.current?.focus({ preventScroll: true });
  }, [noClipGraded]);
  const stemPx = useStemFit(sheetRef, `${q.n}|${q.stem}|${q.code?.lines.join("\n") ?? ""}`, graded);
  // Graded: the right oval fills green; a wrong mark stays pencil, and the red pen circles it.
  const ovalState = (label: ChoiceLabel): OvalState => {
    if (graded && label === q.answer) return "correct";
    return p.selected === label ? "filled" : "empty";
  };
  const missedLabel = graded && !grade.right ? p.selected : null;
  const note = grade?.note ? (
    <p data-margin-note="" className="pen-note -rotate-2 self-start font-sans text-[18px] leading-none font-bold text-red-pen">
      <HandValues text={grade.note} handClass="text-[24px] lg:text-[28px]" />
    </p>
  ) : null;
  const explain = grade?.explain ?? null;
  const explainCls = "btn btn-primary btn-lg w-full";
  const explainButton = explain ? (
    explain.href ? (
      <a href={explain.href} target="_blank" rel="noreferrer" autoFocus={!grade?.noClip} className={`${explainCls}`}>
        {explain.label}
      </a>
    ) : (
      <button type="button" onClick={explain.onClick} autoFocus className={`${explainCls}`}>
        <RewindIcon />
        {explain.label}
      </button>
    )
  ) : null;

  return (
    <div
      ref={sheetRef}
      style={{ "--stem-px": `${stemPx.stem}px`, "--choice-px": `${stemPx.choice}px` } as React.CSSProperties}
      className="paper-form relative flex min-h-dvh w-full flex-col gap-3.5 bg-paper pt-5 pr-11 pb-[var(--phone-bottom-room)] pl-5 text-ink lg:mx-auto lg:my-8 lg:min-h-0 lg:max-w-[1600px] lg:gap-[22px] lg:rounded-md lg:pt-8 lg:pr-[72px] lg:pb-8 lg:pl-12"
    >
      <ShellStrip shell={p.shell} />
      <TimingMarks count={22} className="top-6 right-3 bottom-6 lg:top-10 lg:right-[22px] lg:bottom-10" />
      {/* Mounted with the sheet, so the grade is announced once when it appears. */}
      <p className="sr-only" role="status">
        {grade?.announce ?? ""}
      </p>

      <div className="flex flex-col gap-3.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3 text-print lg:gap-3.5">
          <BackButton />
          <div className="flex flex-col gap-0.5">
            <div className="text-[15px] font-bold text-ink lg:text-[17px]">{p.title}</div>
            <div className="text-[13px] lg:text-sm">
              Question {q.n} of {p.total}
            </div>
          </div>
        </div>
        <div
          role="img"
          className="flex gap-[5px] border-b-[1.5px] border-print pb-3 lg:gap-1.5 lg:border-0 lg:pb-0"
          aria-label={`Question ${q.n} of ${p.total}, ${answeredCount ? `${answeredCount} answered` : "none answered yet"}`}
        >
          {progressWindow(p.progress.length, q.n - 1).map((i) => {
            // The current question is outlined dark; answered ones are filled (green right, red-pen outline missed);
            // the rest are empty.
            const here = i === q.n - 1 && !p.progress[i];
            return (
              <div
                key={i}
                data-progress-dot={i + 1}
                data-state={p.progress[i] ?? (here ? "current" : "todo")}
                className={`relative h-3 flex-1 overflow-hidden rounded-md lg:h-3.5 lg:w-[26px] lg:flex-none lg:rounded-[7px] ${
                  p.progress[i] === "wrong" ? "border-2 border-red-pen" : here ? "border-[2.5px] border-ink" : "border-[1.5px] border-print"
                }`}
              >
                {/* The answered segment fills in from the left, once, as the question is graded (the one just answered). */}
                {p.progress[i] ? (
                  <span
                    aria-hidden="true"
                    className={`absolute inset-0 ${p.progress[i] === "right" ? "bg-print" : "bg-red-pen/20"} ${i === q.n - 1 && graded ? "seg-fill" : ""}`}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="hidden border-t-[1.5px] border-print lg:block" />

      <div className="flex flex-col gap-3.5 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-8">
        <div className="flex min-w-0 flex-col gap-3.5 lg:flex-1 lg:gap-[22px]">
          <div className="flex items-baseline gap-2.5 lg:gap-3">
            <span className="font-serif text-[26px] font-semibold text-print lg:text-(length:--stem-px)">{q.n}.</span>
            <h1 ref={stemRef} tabIndex={-1} data-stem="" className="max-w-[68ch] outline-none font-serif text-[25px] leading-tight font-semibold text-pretty lg:text-(length:--stem-px) lg:leading-[1.45]"><Rich text={q.stem} /></h1>
          </div>
          {q.code?.lines.length ? <CodeBlock code={q.code} n={q.n} /> : null}
          {note ? <div className="hidden lg:block lg:pl-10">{note}</div> : null}
          {grade?.noClip ? <NoClipSlide slide={grade.noClip} className="hidden lg:flex lg:pl-10" /> : null}
          {grade?.quote ? <QuoteCard quote={grade.quote} className="hidden lg:flex lg:pl-10" /> : null}
          <div className="hidden items-center justify-between gap-4 lg:mt-auto lg:flex">
            <Source source={q.source} className="flex min-w-0 lg:min-h-0 lg:justify-start" linkless={opensSlide} printed={!graded} />
            {/* The keys, as small keycaps: desktop only, once a key has been pressed (or after a miss, with the buttons
                they name). The space is held so nothing moves when it appears. */}
            <p aria-hidden="true" data-keys-hint="" className={`flex min-h-6 flex-none items-center gap-1.5 text-[13px] text-print ${keysSeen ? "fade-in" : "invisible"}`}>
              {!graded ? (
                <>
                  <Keycap>A</Keycap>–<Keycap>D</Keycap> pick <Keycap>↵</Keycap> check
                </>
              ) : explain?.onClick ? (
                <>
                  <Keycap>R</Keycap> rewind <Keycap>N</Keycap> next
                </>
              ) : (
                <>
                  <Keycap>N</Keycap> next
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3.5 lg:w-[clamp(360px,40%,600px)] lg:flex-none lg:gap-[18px]">
          {/* One tab stop (the selected answer, else the first); arrow keys move the choice, as radios do. */}
          <div ref={answersRef} role="radiogroup" aria-label="Answers" className="flex flex-col" onKeyDown={onArrow}>
            {q.choices.map((c, i) => {
              const state = ovalState(c.label);
              return (
                <button
                  key={c.label}
                  type="button"
                  role="radio"
                  aria-checked={p.selected === c.label}
                  tabIndex={(p.selected ? p.selected === c.label : i === 0) ? 0 : -1}
                  data-choice={c.label}
                  aria-label={`Option ${c.label}, ${c.text}${state === "correct" ? ", correct" : ""}`}
                  disabled={graded}
                  onClick={() => {
                    setPenSalt(Math.floor(Math.random() * PEN_LOOPS.length));
                    p.onSelect(c.label);
                  }}
                  className="flex min-h-[58px] items-center gap-3.5 border-b border-paper-rule px-1 text-left transition-transform duration-150 enabled:hover:-translate-y-0.5 lg:min-h-16 lg:gap-4 lg:px-1.5"
                >
                  <span className="relative flex flex-none">
                    {/* Once graded the pencil mark just stays: if Check answer came mid-wipe, it doesn't restart or vanish. */}
                    <Oval letter={c.label} state={state} size="responsive" still={graded} />
                    {missedLabel === c.label ? <RedPenCircle draw size="responsive" variant={penVariant} /> : null}
                  </span>
                  <span className={`flex-1 py-1 font-serif text-[19px] text-pretty lg:text-(length:--choice-px) ${state === "correct" ? "font-semibold" : ""}`}><Rich text={c.text} /></span>
                  {missedLabel === c.label ? <span className="grade-marked text-[13px] font-bold text-red-pen">You marked</span> : null}
                  {state === "correct" ? <span className="fade-in text-[13px] font-bold text-print">Correct</span> : null}
                </button>
              );
            })}
          </div>

          {note ? <div className="lg:hidden">{note}</div> : null}
          {grade?.noClip ? <NoClipSlide slide={grade.noClip} className="flex lg:hidden" /> : null}
          {grade?.quote ? <QuoteCard quote={grade.quote} className="flex lg:hidden" /> : null}

          <Source source={q.source} className="lg:hidden" linkless={opensSlide} printed={!graded} />

          {!graded ? (
            <fieldset className="hidden flex-col gap-2 lg:flex">
              <legend className="mb-2 text-sm font-bold text-ink">How sure are you?</legend>
              <div className="flex gap-2">
                {CONFIDENCE.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    aria-pressed={p.confidence === c.value}
                    onClick={() => p.onConfidence(p.confidence === c.value ? null : c.value)}
                    className={`min-h-11 flex-1 rounded-lg border-[1.5px] border-print text-[15px] ${
                      p.confidence === c.value ? "bg-print font-bold text-white" : "text-ink"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          <div className="mt-auto flex flex-col gap-2.5">
            {grade && !grade.right ? (
              // A miss: the way to his explanation is the one primary; Next question steps back.
              <div data-grade-next="" className="flex flex-col gap-2.5">
                <div data-grade-step="0" className="grade-rise flex flex-col" style={{ "--i": 0 } as React.CSSProperties}>
                  {explainButton}
                </div>
                <button
                  data-grade-step="1"
                  style={{ "--i": 1 } as React.CSSProperties}
                  type="button"
                  onClick={p.onNext}
                  autoFocus={!explain && !grade?.noClip}
                  className={`grade-rise btn btn-lg ${explain ? "btn-secondary" : "btn-primary"}`}
                >
                  Next question
                </button>
              </div>
            ) : grade ? (
              <div data-grade-next="" className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={p.onNext}
                  autoFocus={!grade?.noClip}
                  className="btn btn-primary btn-lg"
                >
                  Next question
                </button>
                {explain ? (
                  explain.href ? (
                    <a href={explain.href} target="_blank" rel="noreferrer" className="btn btn-tertiary">
                      {explain.label}
                    </a>
                  ) : (
                    <button type="button" onClick={explain.onClick} className="btn btn-tertiary">
                      {explain.label}
                    </button>
                  )
                ) : null}
              </div>
            ) : (
              <div className="flex gap-2.5">
                <button type="button" onClick={p.onCheck} disabled={!p.selected} className="btn btn-primary btn-lg min-w-0 flex-1">
                  Check answer
                </button>
                <button type="button" onClick={p.onSkip} className="btn btn-secondary btn-lg flex-none">
                  Skip for now
                </button>
              </div>
            )}
            {/* The tutor's way in, under the sheet's own buttons: quiet, never a second primary. */}
            {p.tutor ? (
              <button type="button" data-ask-tutor="" aria-disabled={!p.tutor.ready || undefined} onClick={(e) => p.tutor!.ready && p.tutor!.onOpen(e.currentTarget)} className={`btn btn-tertiary ${p.tutor.open ? "invisible" : ""}`}>
                Ask the tutor
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
