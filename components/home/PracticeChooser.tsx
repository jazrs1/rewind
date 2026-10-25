"use client";

// How practice starts from the course home (John, Oct 24). When the exam's topics were found, one
// primary link: "Start Exam 2 practice". When they weren't, practice never starts silently: two
// one-tap choices, (a) our guess "Everything since Exam 1 (Modules 8 to 10)", labelled as a guess,
// and (b) "Pick topics" (a module checklist). Both lead to a confirm step that says which picked
// modules have questions ("Ready: Modules 9–10 · not yet: 8"); practice starts only from there, and
// only when at least one picked module has questions. One orange button on screen at a time.

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { lectureWords, modulesText, practicedLectures, readyText } from "@/lib/home/build";
import type { Coverage, PracticeIndexQuestion } from "@/lib/home/types";

type Step = { kind: "choose" } | { kind: "confirm"; positions: number[] } | { kind: "pick"; positions: number[] };

const OUTLINED = "btn btn-secondary";
const TEXT_BUTTON = "btn btn-tertiary -ml-2";

export interface PracticeChooserProps {
  /** "Exam 2": the primary reads "Practice for Exam 2"; the coverage choice comes after, as the confirm step. */
  examTitle: string;
  /** The nearer quiz carries the page's primary, so this one is an outlined button. */
  demoted?: boolean;
  coverage: Coverage;
  modules: { position: number; label: string }[];
  /** The questions practice can serve, with their lecture and module: "ready" comes only from these. */
  practice: PracticeIndexQuestion[];
}

export function PracticeChooser({ examTitle, coverage, modules, practice, demoted = false }: PracticeChooserProps) {
  // A nearer quiz leads the page and carries its one orange primary; this one steps down to an outline.
  const PRIMARY = demoted ? "btn btn-secondary btn-lg w-full" : "btn btn-primary btn-lg w-full";
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const heading = useRef<HTMLHeadingElement>(null);
  const guessNote = useId();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step.kind]);

  if (coverage.kind === "known") {
    return (
      <Link href="/practice" className={PRIMARY}>
        Practice for {coverage.title}
      </Link>
    );
  }

  const ready = { positions: [...new Set(practice.map((q) => q.module).filter((m): m is number => m !== null))] };

  if (step.kind === "choose") {
    return (
      <div data-step="choose" className="flex flex-col gap-3">
        {/* One primary; what it should cover is asked after, as the confirm step (our guess, or picking topics). */}
        <button type="button" aria-describedby={coverage.guess ? guessNote : undefined} className={PRIMARY} onClick={() => setStep(coverage.guess ? { kind: "confirm", positions: coverage.guess.positions } : { kind: "pick", positions: [] })}>
          Practice for {examTitle}
        </button>
        {coverage.guess ? (
          <p id={guessNote} className="m-0 text-[13px] text-label-muted lg:min-h-11">
            Next: confirm what it covers. Our guess is {coverage.guess.label.replace(/^Everything/, "everything")}.
          </p>
        ) : coverage.noGuess ? (
          <p className="m-0 text-[14px] text-label-muted">{coverage.noGuess}</p>
        ) : null}
      </div>
    );
  }

  const r = readyText(step.positions, ready.positions);
  const start = r.ready.length ? (
    <Link href={`/practice?modules=${step.positions.slice().sort((a, b) => a - b).join(",")}`} className={PRIMARY}>
      Start practice
    </Link>
  ) : (
    <button type="button" disabled className={PRIMARY}>
      Start practice
    </button>
  );
  const status = (
    <div className="flex flex-col gap-1">
      <p data-ready="" aria-live="polite" className="m-0 text-[15px] font-bold">
        {r.text}
      </p>
      {r.ready.length ? <p className="m-0 text-[13px] text-label-muted">{fromLine(practice, r.ready)}</p> : null}
    </div>
  );

  if (step.kind === "confirm") {
    const g = coverage.guess!;
    return (
      <div data-step="confirm" role="group" aria-labelledby="confirm-title" className="flex flex-col gap-3 rounded-xl bg-deck-raised px-[18px] py-4">
        <h3 id="confirm-title" ref={heading} tabIndex={-1} className="m-0 font-display text-[18px] font-bold outline-none">
          Practice {modulesText(g.positions)}?
        </h3>
        <p className="m-0 text-[14px] leading-normal text-label-muted">
          Our guess at what&apos;s on it: {g.why}
          {g.leftOut ? ` ${g.leftOut}` : ""}
        </p>
        {status}
        {start}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className={OUTLINED} onClick={() => setStep({ kind: "pick", positions: g.positions })}>
            Pick topics instead
          </button>
          <button type="button" className={TEXT_BUTTON} onClick={() => setStep({ kind: "choose" })}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const toggle = (p: number) => setStep({ kind: "pick", positions: step.positions.includes(p) ? step.positions.filter((x) => x !== p) : [...step.positions, p] });
  return (
    <div data-step="pick" className="flex flex-col gap-3 rounded-xl bg-deck-raised px-[18px] py-4">
      <fieldset className="m-0 flex flex-col border-0 p-0">
        <legend className="mb-1 p-0">
          <h3 ref={heading} tabIndex={-1} className="m-0 font-display text-[18px] font-bold outline-none">
            Pick topics
          </h3>
        </legend>
        {modules.map((m) => {
          const has = ready.positions.includes(m.position);
          return (
            <label key={m.position} className="flex min-h-11 cursor-pointer items-center gap-3 py-1 text-[15px]">
              <input type="checkbox" checked={step.positions.includes(m.position)} onChange={() => toggle(m.position)} className="size-5 flex-none accent-action" />
              <span className="min-w-0 flex-1">{m.label}</span>
              <span className={`flex-none text-[13px] ${has ? "text-label" : "text-label-faint"}`}>{has ? "Questions ready" : "No questions yet"}</span>
            </label>
          );
        })}
      </fieldset>
      {status}
      {start}
      <button type="button" className={`${TEXT_BUTTON} self-start`} onClick={() => setStep({ kind: "choose" })}>
        Back
      </button>
    </div>
  );
}

/** "5 questions from the Oct 22 lecture." for the ready modules, counted from the questions that exist. */
function fromLine(practice: PracticeIndexQuestion[], modules: number[]): string {
  const qs = practice.filter((q) => q.module !== null && modules.includes(q.module));
  const dates = practicedLectures(qs);
  return `${qs.length} question${qs.length === 1 ? "" : "s"}${dates.length ? ` from ${lectureWords(dates)}` : ""}.`;
}
