"use client";

// A question in the chat ("Give me a similar one", the study session's "Quiz me"): a small Scantron card the student
// answers in place. Check grades it with the sheet's beat: the right oval fills print green and "Correct" fades in,
// the red pen circles a wrong mark and "You marked" appears, then the why and where the course says it (its chip).
// It never decides anything about the student's real work; it is practice.

import { useState, type ReactNode } from "react";
import type { ChoiceLabel } from "@/lib/schema";
import type { SimilarCard as Card } from "@/lib/tutor/similar";
import { CodeBlock } from "@/components/paper/CodeBlock";
import { Oval, PEN_LOOPS, RedPenCircle, type OvalState } from "@/components/paper/Oval";
import { HandValues } from "@/components/type/HandValues";

export function SimilarCard({
  card,
  label = "Similar question",
  chips,
  onGraded,
  initial,
}: {
  card: Card;
  label?: string;
  chips?: ReactNode;
  onGraded?(right: boolean, marked: ChoiceLabel): void;
  /** Start already marked (and checked): a conversation carried over, or the design mock. */
  initial?: { selected: ChoiceLabel; checked: boolean };
}) {
  const [selected, setSelected] = useState<ChoiceLabel | null>(initial?.selected ?? null);
  const [checked, setChecked] = useState(initial?.checked ?? false);
  // Which hand-drawn loop circles a miss: picked from the card itself, so the server and the page agree (no Math.random).
  const pen = [...card.stem].reduce((n, ch) => n + ch.charCodeAt(0), 0) % PEN_LOOPS.length;
  const right = checked && selected === card.answer;
  const state = (l: ChoiceLabel): OvalState => (checked && l === card.answer ? "correct" : selected === l ? "filled" : "empty");
  return (
    <div data-similar-card="" data-checked={checked ? (right ? "right" : "wrong") : undefined} className="paper-sheet relative flex flex-col gap-2.5 rounded-md bg-paper px-3.5 pt-3 pb-3.5 text-ink">
      <p className="sr-only" role="status">
        {checked ? (right ? "Correct." : `Incorrect. You marked ${selected}. The answer is ${card.answer}.`) : ""}
      </p>
      <span className="text-[13px] font-bold text-print">{label}</span>
      <p className="m-0 font-serif text-[17px] leading-snug font-semibold text-pretty">{card.stem}</p>
      {card.code?.lines.length ? <CodeBlock code={card.code} n={0} compact /> : null}
      <div role="radiogroup" aria-label={`Answers: ${label}`} className="flex flex-col">
        {card.choices.map((c) => {
          const s = state(c.label);
          const missed = checked && !right && selected === c.label;
          return (
            <button
              key={c.label}
              type="button"
              role="radio"
              aria-checked={selected === c.label}
              aria-label={`Option ${c.label}, ${c.text}${s === "correct" ? ", correct" : ""}`}
              disabled={checked}
              onClick={() => setSelected(c.label)}
              className="flex min-h-11 items-center gap-2.5 border-b border-paper-rule px-0.5 text-left last:border-b-0"
            >
              <span className="relative flex flex-none">
                <Oval letter={c.label} state={s} still={checked} />
                {missed ? <RedPenCircle draw variant={pen} /> : null}
              </span>
              <span className={`flex-1 py-1 font-serif text-[15px] leading-snug text-pretty ${s === "correct" ? "font-semibold" : ""}`}>{c.text}</span>
              {missed ? <span className="grade-marked text-[13px] font-bold text-red-pen">You marked</span> : null}
              {s === "correct" ? <span className={`text-[13px] font-bold text-print ${checked && !initial?.checked ? "stamp" : "fade-in"}`}>Correct</span> : null}
            </button>
          );
        })}
      </div>
      {!checked ? (
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            setChecked(true);
            onGraded?.(selected === card.answer, selected!);
          }}
          className="btn btn-secondary self-start"
        >
          Check
        </button>
      ) : (
        <div data-similar-why="" className="grade-next flex flex-col gap-2">
          {!right ? (
            <p className="m-0 -rotate-1 self-start font-sans text-[18px] leading-none font-bold text-red-pen">
              <span className={initial?.checked ? "" : "stamp"}>
                <HandValues text={`It's (${card.answer})`} handClass="text-[22px]" />
              </span>
            </p>
          ) : null}
          {card.explanation ? <p className="m-0 text-[15px] leading-snug">{card.explanation}</p> : null}
          {chips}
        </div>
      )}
    </div>
  );
}
