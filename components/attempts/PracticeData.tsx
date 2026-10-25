"use client";

// Practice data controls: the "Example practice history" label and the "Clear my practice data"
// button (with a confirm step). Attempts live only in this browser (lib/attempts/store.ts).

import { useEffect, useId, useRef, useState } from "react";
import { useAttempts } from "@/lib/attempts/client";
import { exampleHistory, type ExampleSeed } from "@/lib/attempts/examples";
import { attemptStore } from "@/lib/attempts/store";

export const EXAMPLE_LABEL = "Example practice history";

/** Adds the demo course's example history once, when the store is empty (no-op otherwise, and for other courses). */
export function useExampleHistory(course: string, examples: ExampleSeed | null): void {
  useEffect(() => {
    const list = exampleHistory(examples, new Date().toISOString());
    if (list.length) attemptStore(course).seedExamples(list);
  }, [course, examples]);
}

/** Shown wherever example attempts count, so they are never taken for a real student's answers. */
export function ExampleBadge({ className = "" }: { className?: string }) {
  return (
    <span data-example-label="" className={`inline-block rounded-sm bg-current/15 px-1.5 text-[13px] font-bold tracking-[0.02em] ${className}`}>
      {EXAMPLE_LABEL}
    </span>
  );
}

export function ExampleNotice() {
  return (
    <p role="note" className="rounded border border-label-muted px-3 py-2">
      <ExampleBadge />{" "}
      These answers are examples so the tape has misses to show; they aren&apos;t a real student&apos;s. They disappear as soon as you
      answer a practice question.
    </p>
  );
}

/**
 * `strip`: on desktop it sits on one line in the strip under the practice sheet (PracticeDataFooter), with
 * buttons sized for a pointer; the phone layout is the same as the tape's.
 */
export function ClearPracticeData({ course, strip = false }: { course: string; strip?: boolean }) {
  const attempts = useAttempts(course);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  const yesRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const descId = useId();

  useEffect(() => {
    if (confirming) yesRef.current?.focus();
  }, [confirming]);

  const clear = () => {
    attemptStore(course).clear();
    setConfirming(false);
    setCleared(true);
  };

  // Desktop strip only: one line, 28 px buttons (the phone keeps its 44 px ones).
  const lg = (cls: string) => (strip ? ` ${cls}` : "");
  // The 28 px buttons keep a 44 px hit area: ::before reaches 18 px up (the strip sits at the window's bottom edge).

  return (
    // On the desktop strip the buttons are 28 px tall but each one's ::before extends its hit area to 46 px (data-hit-44).
    <div data-hit-44={strip ? "" : undefined} className={`flex flex-col gap-2${lg("lg:flex-row lg:items-center lg:gap-4")}`}>
      {confirming ? (
        <div role="group" aria-labelledby={descId} className={`flex flex-col gap-2 rounded border border-label-muted p-3${lg("lg:flex-row lg:items-center lg:gap-3 lg:border-0 lg:p-0")}`}>
          <p id={descId}>Delete every practice answer saved on this device for this course? This can&apos;t be undone.</p>
          <div className="flex flex-wrap gap-2">
            <button ref={yesRef} type="button" onClick={clear} className={`btn btn-primary${lg("lg:min-h-8 lg:px-3 lg:text-sm lg:after:absolute lg:after:inset-x-0 lg:after:-top-3.5 lg:after:bottom-0 lg:after:content-['']")}`}>
              Yes, clear it
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => openRef.current?.focus());
              }}
              className={`btn btn-secondary${lg("lg:min-h-8 lg:px-3 lg:text-sm lg:after:absolute lg:after:inset-x-0 lg:after:-top-3.5 lg:after:bottom-0 lg:after:content-['']")}`}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={openRef}
          type="button"
          onClick={() => {
            setCleared(false);
            setConfirming(true);
          }}
          className={`btn btn-secondary self-start${lg("lg:min-h-8 lg:px-3 lg:text-sm lg:after:absolute lg:after:inset-x-0 lg:after:-top-3.5 lg:after:bottom-0 lg:after:content-['']")}`}
        >
          Clear my practice data
        </button>
      )}
      {/* While confirming, the strip has no room for the count too; it's back as soon as the step closes. */}
      <p role="status" className={`text-sm text-label-muted${lg(`lg:text-[13px]${confirming ? " lg:hidden" : ""}`)}`}>
        {cleared && !attempts.length
          ? "Cleared. No practice answers are saved on this device."
          : `${attempts.length} ${attempts.some((a) => a.example) ? "example" : "practice"} ${attempts.length === 1 ? "answer" : "answers"} saved on this device only; never sent anywhere.`}
      </p>
    </div>
  );
}

/**
 * For /practice: below the sheet, the example label (while examples are stored) and the clear button. On desktop
 * it's a one-line strip laid over the deck's bottom margin (in the page's lg:relative wrapper), 32 px tall like
 * the sheet's lg:my-8, so the sheet still fits the window without scrolling; it lines up with the centred sheet
 * (the main's lg:px-8 and the sheet's lg:max-w-[900px]).
 */
export function PracticeDataFooter({ course, examples }: { course: string; examples: ExampleSeed | null }) {
  useExampleHistory(course, examples);
  const attempts = useAttempts(course);
  return (
    <footer
      aria-label="Your practice data"
      className="flex flex-col gap-3 bg-deck px-5 py-6 text-label lg:absolute lg:inset-x-8 lg:bottom-0 lg:mx-auto lg:h-8 lg:max-w-[900px] lg:flex-row lg:items-center lg:gap-4 lg:bg-transparent lg:px-0 lg:py-0 lg:text-[13px] lg:[main[data-phase=missed]~&]:static lg:[main[data-phase=missed]~&]:mx-14 lg:[main[data-phase=missed]~&]:mb-6 lg:[main[data-phase=missed]~&]:max-w-none"
    >
      {attempts.some((a) => a.example) ? (
        <p>
          {/* Desktop: the label alone (the count beside it says "example"); the sentence stays for screen readers. */}
          <ExampleBadge /> <span className="lg:sr-only">The Course tape is showing example answers until you answer a question here.</span>
        </p>
      ) : null}
      <ClearPracticeData course={course} strip />
    </footer>
  );
}
