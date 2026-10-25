"use client";

// The conversation's turns, as the tutor panel and the study session draw them: the tutor's bubbles lighter than the
// panel (tutor-bubble), the student's outlined in cream (tutor-student), a request as a pill. A tutor turn can carry
// its "From your course" chips, a similar question to answer in place (SimilarCard), "Saved reply", or the skeleton
// while it is written.

import type React from "react";
import { Fragment, type ReactNode } from "react";
import type { SeedQuestion } from "@/lib/demo/types";
import type { Grounded } from "@/lib/tutor/claims";
import { safeChips } from "@/lib/tutor/poll";
import { Chips, type ChipMoment } from "./Chips";
import { SimilarCard } from "./SimilarCard";
import type { TutorTurn } from "./types";

/** The reply still being written: two grey lines, shimmering (reduced motion: still). */
export function WritingSkeleton() {
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-label="Writing a reply" data-tutor-skeleton="">
      <div className="skeleton h-[9px] w-[88%] rounded-[4px] bg-roller-groove" />
      <div className="skeleton h-[9px] w-[64%] rounded-[4px] bg-roller-groove" />
    </div>
  );
}

/**
 * The chip rule on the page too (the server applies it first; a saved reply in the demo never went through it): no chip
 * that gives the answer away or shows a poll or answer slide before the student answers, or on graded work.
 */
const visible = (g: Grounded[], question: SeedQuestion | undefined, o: { answered: boolean; graded: boolean; hint: boolean }) => (question ? safeChips(g, question, o) : o.answered && !o.graded ? g : []);

export const TUTOR_BUBBLE = "rounded-[12px_12px_12px_4px] bg-tutor-bubble px-3.5 py-3 text-[15px] leading-[1.45] text-tutor-bubble-ink shadow-[0_2px_0_rgb(0_0_0/0.3)]";
/** The student's message: a deck fill, a cream border (its edge on the panel), cream text. */
export const STUDENT_BUBBLE = "max-w-[82%] self-end rounded-[12px_12px_4px_12px] border-[1.5px] border-tutor-student bg-tutor-student-fill px-3.5 py-2.5 text-[15px] leading-[1.45] text-label lg:max-w-[80%]";
/** The composer's field: a dark well with a line. */
export const COMPOSER = "h-12 min-w-0 flex-1 rounded-[10px] border-[1.5px] border-tutor-composer-line bg-tutor-composer px-3.5 text-[15px] text-label placeholder:text-ahead";

type LectureChip = Extract<Grounded, { kind: "lecture" }>;
type SlideChip = Extract<Grounded, { kind: "slide" }>;

/** What a turn's chips are checked against and link to. The panel has one question; the study session one per turn. */
export interface TurnContext {
  question?: SeedQuestion;
  /** The student has checked their answer to that question: chips that show the answer may show. */
  answered: boolean;
  graded: boolean;
  moment: ChipMoment | null | undefined;
  slideHref: string;
}

export function TutorTurns({
  turns,
  empty,
  greeting,
  moment,
  slideHref,
  onOpenMoment,
  extra,
  answered = false,
  graded = false,
  question,
  context,
  renderMoment,
  renderSlide,
}: {
  turns: TutorTurn[];
  /** The tutor's first line, before anything is asked. */
  empty: string;
  /** Under that first line: where the course explains it (the panel's start chips). */
  greeting?: ReactNode;
  /** The panel's one question: whether it is answered, graded, and the question itself (chips are checked against it). */
  answered?: boolean;
  graded?: boolean;
  question?: SeedQuestion;
  moment?: ChipMoment | null;
  slideHref?: string;
  /** The study session: each turn's own context (its question), instead of the props above. */
  context?: (t: TutorTurn) => TurnContext;
  onOpenMoment(start: number, t: TutorTurn): void;
  /** Something a turn shows under its words (a quiz card, a lecture moment). */
  extra?: (t: TutorTurn) => ReactNode;
  /** The study session: the turn's first lecture chip as a playable clip tile instead of a chip. */
  renderMoment?: (t: TutorTurn, g: LectureChip) => ReactNode;
  /** The study session: the turn's first slide chip as a preview over its chip. */
  renderSlide?: (t: TutorTurn, g: SlideChip) => ReactNode;
}) {
  const ctxOf = (t: TutorTurn): TurnContext => context?.(t) ?? { question, answered, graded, moment, slideHref: slideHref ?? "" };
  return (
    <>
      {!turns.length && empty ? (
        <div data-tutor-greeting="" className={`${TUTOR_BUBBLE} flex flex-col gap-2.5`}>
          {empty}
          {greeting}
        </div>
      ) : null}
      {turns.map((turn, i) => {
        if (turn.divider) {
          // A topic switch after a conversation: a thin rule with the topic's name, not a message.
          return (
            <div key={turn.id} role="separator" aria-label={`Now on ${turn.divider}`} data-divider={turn.divider} className="flex items-center gap-3 py-1 text-[13px] font-bold text-label-muted">
              <span aria-hidden="true" className="h-px flex-1 bg-tutor-line" />
              {turn.divider}
              <span aria-hidden="true" className="h-px flex-1 bg-tutor-line" />
            </div>
          );
        }
        if (turn.role === "student") {
          // A request ("Hint", "Quiz me") is sent words like any other: a student bubble, never a pill that looks clickable.
          return (
            <div
              key={turn.id}
              data-student-turn=""
              data-request={turn.pill ? "" : undefined}
              style={{ "--i": i } as React.CSSProperties}
              className={STUDENT_BUBBLE}
            >
              {turn.text}
            </div>
          );
        }
        const c = ctxOf(turn);
        const o = { answered: c.answered, graded: c.graded, hint: turn.kind === "hint" };
        const shown = turn.grounded ? visible(turn.grounded, c.question, o) : [];
        const source = turn.similar ? visible([turn.similar.source], c.question, { ...o, hint: false }) : [];
        const lecture = renderMoment ? (shown.find((g) => g.kind === "lecture") as LectureChip | undefined) : undefined;
        const slide = renderSlide ? (shown.find((g) => g.kind === "slide") as SlideChip | undefined) : undefined;
        const chips = shown.filter((g) => g !== lecture);
        const open = (start: number) => onOpenMoment(start, turn);
        const kind = turn.similar ? "similar" : turn.quiz ? "quiz" : turn.moment ? "moment" : turn.greeting ? "greeting" : turn.note ? "note" : (turn.kind ?? (turn.streaming ? "streaming" : "error"));
        // A question card (or a clip tile) sits bare on the panel, never inside the cream reply: the reply's words, chips
        // and labels are the bubble, and the card follows it. A turn that is only a card has no bubble at all.
        const added = extra?.(turn) ?? null;
        const card = (
          <>
            {turn.similar ? (
              <SimilarCard card={turn.similar} chips={source.length ? <Chips grounded={source} moment={c.moment} slideHref={c.slideHref} onOpenMoment={open} onPaper /> : null} />
            ) : null}
            {added}
          </>
        );
        const hasCard = !!turn.similar || !!added;
        const hasBubble = !!turn.text || !!lecture || !!slide || chips.length > 0 || !!turn.saved || !!turn.streaming || !!turn.error || !hasCard;
        return (
          <Fragment key={turn.id}>
            {hasBubble ? (
              <div data-tutor-turn={kind} data-turn-topic={turn.topic} data-qid={turn.qid} aria-busy={turn.streaming || undefined} className={`flex flex-col gap-2 ${TUTOR_BUBBLE} ${turn.error ? "text-slide-ink" : ""}`}>
                {turn.text ? <span>{turn.text}</span> : null}
                {lecture ? renderMoment!(turn, lecture) : null}
                {slide ? renderSlide!(turn, slide) : null}
                {chips.length ? <Chips grounded={chips} moment={c.moment} slideHref={c.slideHref} onOpenMoment={open} onPaper /> : null}
                {shown.length ? (
                  <span data-from-course="" className="text-xs leading-[1.45] font-bold text-print">
                    ✓ From your course
                  </span>
                ) : null}
                {turn.saved ? (
                  <span data-saved="" title="The live tutor was busy or slow, so this reply was saved ahead of time" className="text-xs leading-[1.45] text-slide-ink">
                    Saved reply
                  </span>
                ) : null}
                {turn.streaming ? <WritingSkeleton /> : null}
              </div>
            ) : null}
            {hasCard ? (
              // The bare card is the message when there are no words: it carries the turn then.
              <div data-tutor-card="" data-turn-topic={turn.topic} data-qid={turn.qid} {...(hasBubble ? {} : { "data-tutor-turn": kind })} className="flex flex-col gap-2">
                {card}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
}
