"use client";

// The tutor (Tutor mockups): on desktop a panel beside the clip, on a phone a bottom sheet over the page.
// Hint → Socratic questions → the student confirms their answer. Every claim from the course comes back
// with a quote the server has checked word for word, shown as a mini-tape chip (opens the clip) or a slide
// chip (opens the slide) under "From your course"; a reply it couldn't ground has neither. On a graded
// assignment the banner says so and the tutor only asks questions. The reply streams in; the skeleton
// holds its place until the first words.

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { MAX_HINTS } from "@/lib/prompts/tutor";
import { formatTime } from "@/lib/format";
import { CHIP_HIT, SHELL, dayLabel } from "./Chips";
import { COMPOSER, TutorTurns } from "./TutorTurns";
import type { TutorConfig, TutorQuestionContext, TutorTurn } from "./types";
import { CARRY_KEY, useTutorChat, type ChatRequest } from "./useTutorChat";

/**
 * While the clip plays, the player's Play/Pause key is lit orange (the screen's one primary, `data-primary`) and the
 * tutor's Send steps back to an outline. design-elevation's transport keys (E2) are in, and the playing key is still
 * the primary, so this stays true. Flip it only if that key stops being orange, and Send stays orange as in the
 * TutorDesktop mockup.
 */
export const PLAYER_PLAY_IS_PRIMARY = true;

const PHONE = "(max-width: 1023.98px)";
const subscribePhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const isPhone = () => window.matchMedia(PHONE).matches;

/**
 * The greeting's chips, once the student has answered (before that the explanation moment and its slide would give the
 * answer away: lib/tutor/poll.ts): the moment the rewind landed on (a mini tape that plays it) and its slide.
 */
function StartChips({ ctx, config, onOpenMoment }: { ctx: TutorQuestionContext; config: TutorConfig; onOpenMoment(start: number): void }) {
  const moment = config.moments[ctx.id];
  const day = moment?.date ? dayLabel(moment.date) : null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-start-chips="">
      {ctx.start != null ? (
        <button
          type="button"
          data-hit-44=""
          data-chip="tape"
          aria-label={`Play the lecture from ${day ? `${day}, ` : ""}${formatTime(ctx.start)}, the moment it's explained`}
          onClick={() => onOpenMoment(ctx.start!)}
          className={`${CHIP_HIT} inline-flex h-8 items-center gap-1.5 rounded-md pr-2 pl-1 lg:h-[30px] ${SHELL[moment?.shell ?? 1]}`}
        >
          <span className="inline-flex h-6 items-center rounded-[3px] bg-label px-2 leading-[1.45] font-hand text-[18px] font-bold text-deck lg:h-[24px]">
            {day ? `${day} · ` : ""}
            {formatTime(ctx.start)}
          </span>
          <span aria-hidden="true" className="text-xs font-bold">
            ◀◀
          </span>
        </button>
      ) : null}
      {ctx.slide && ctx.slideHref ? (
        <a
          data-hit-44=""
          data-chip="slide"
          href={ctx.slideHref}
          target="_blank"
          rel="noreferrer"
          className={`${CHIP_HIT} inline-flex h-8 items-center rounded-md bg-paper px-2.5 text-xs font-bold text-print no-underline outline-[1.5px] outline-print lg:h-[30px]`}
        >
          {ctx.slide.kind === "page" ? "Page" : "Slide"} {ctx.slide.page}
        </a>
      ) : null}
    </div>
  );
}

/** Keeps the conversation for the study session (this tab only); a turn still being written isn't carried. */
function carry(questionId: string, turns: TutorTurn[]) {
  try {
    sessionStorage.setItem(CARRY_KEY, JSON.stringify({ questionId, turns: turns.filter((t) => !t.streaming) }));
  } catch {
    // Storage off (a private window): the session starts fresh.
  }
}

export function TutorPanel({
  open,
  onClose,
  config,
  ctx,
  onOpenMoment,
  desktopSendPrimary,
  desktopTop,
  returnFocus,
  studyHref,
  onReady,
}: {
  open: boolean;
  onClose(): void;
  config: TutorConfig;
  ctx: TutorQuestionContext;
  /** A mini-tape chip: play the lecture from this second. */
  onOpenMoment(start: number): void;
  /**
   * On desktop the panel sits beside the page, so Send is the orange primary only while no other control on the
   * screen is. On a phone the sheet is modal (the page is inert) and Send is always the primary, as in the mockup.
   */
  desktopSendPrimary: boolean;
  /** Desktop: the panel's top edge as a class (lg:top-8, or level with the rewind strip), so it lines up with the sheet. */
  desktopTop: string;
  returnFocus?: () => HTMLElement | null;
  /** Told true once the dialog is mounted on the hydrated page and can open ("Ask the tutor" is disabled until then). */
  onReady?(ready: boolean): void;
  /** ⤢: open the full-screen study session with this conversation (the study page picks it up from CARRY_KEY). */
  studyHref?: string;
}) {
  const graded = config.graded && config.gradedIds.includes(ctx.id) ? config.graded : null;
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);
  const sendPrimary = phone || desktopSendPrimary;
  const { turns, busy, hintsUsed, send: sendTurn } = useTutorChat({ config, questionId: ctx.id, marked: ctx.marked });
  const [draft, setDraft] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dialog.current) return;
    onReady?.(true);
    return () => onReady?.(false);
  }, [onReady]);

  // Open: a modal sheet on a phone (the page behind goes inert), a plain panel beside the clip on desktop.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      if (window.matchMedia("(min-width: 1024px)").matches) {
        d.show();
        input.current?.focus({ preventScroll: true });
      } else d.showModal();
    } else if (!open && d.open) {
      d.close();
      returnFocus?.()?.focus({ preventScroll: true });
    }
  }, [open, returnFocus]);

  // Esc closes it from anywhere on the page while it's open (focus can be on the clip, not in the panel).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = (request: ChatRequest, message: string, pill?: string) => {
    setDraft("");
    return sendTurn(request, message, pill);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const m = draft.trim();
    if (m) void send("reply", m);
  };

  const firstTopic = graded?.topics?.split(/,\s*|\s+and\s+/)[0]?.trim() || null;
  const placeholder = graded ? (firstTopic ? `Ask about ${firstTopic}…` : "Ask about this assignment…") : "Ask about this question…";
  const sub = graded ? [graded.name, graded.topics].filter(Boolean).join(" · ") : `About question ${ctx.n} · ${ctx.topic}`;
  // The quick requests under the conversation: what each one asks for, and the words the student sees for it.
  const again = firstTopic ? `Explain ${firstTopic} again` : "Explain it again";
  const why = ctx.wrongText ? `Why is ${ctx.wrongText.length <= 14 ? ctx.wrongText : `(${ctx.marked})`} wrong?` : null;
  // Graded work gets no hints, no answer and no similar question (integrity mode): only questions back.
  const quicks: { label: string; request: ChatRequest; message: string; pill?: string }[] = graded
    ? [
        { label: again, request: "reply", message: again },
        { label: "Where do I start?", request: "reply", message: "Where do I start?" },
      ]
    : [
        hintsUsed < MAX_HINTS ? { label: "Hint", request: "hint", message: "", pill: "Hint" } : { label: "Show the answer", request: "answer", message: "", pill: "Show the answer" },
        ...(why ? [{ label: why, request: "reply" as const, message: why }] : []),
        { label: "Give me a similar one", request: "similar", message: "", pill: "Give me a similar one" },
      ];

  return (
    <dialog
      ref={dialog}
      aria-label="Tutor"
      data-tutor=""
      data-graded={graded ? "" : undefined}
      onClose={() => open && onClose()}
      className={`sheet-up fixed inset-x-0 top-auto bottom-0 z-40 m-0 hidden h-[min(690px,calc(100dvh-28px))] w-full max-w-none flex-col overflow-hidden rounded-t-[18px] border-0 bg-tutor p-0 text-label shadow-[0_-12px_30px_rgb(0_0_0/0.45)] backdrop:bg-deck/45 open:flex lg:inset-x-auto lg:right-6 lg:bottom-5 lg:h-auto lg:max-h-none lg:w-[400px] lg:rounded-[14px] lg:shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_10px_30px_rgb(0_0_0/0.35)] ${desktopTop}`}
    >
      <div aria-hidden="true" className="flex justify-center pt-2 pb-0.5 lg:hidden">
        <div className="h-[5px] w-11 rounded-[3px] bg-tape-blank-label" />
      </div>
      <div className="flex items-center gap-2.5 border-b border-tutor-line px-4 pt-2 pb-3 lg:py-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="m-0 font-display text-xl leading-[normal] font-extrabold">Tutor</h2>
          <span className="line-clamp-2 text-[13px] leading-snug text-label-muted">{sub}</span>
        </div>
        {studyHref ? (
          <a
            href={studyHref}
            aria-label="Open the full-screen study session"
            title="Study with the tutor, full screen"
            data-tutor-expand=""
            onClick={() => carry(ctx.id, turns)}
            className="flex size-11 flex-none items-center justify-center rounded-[10px] border-2 border-deck-line text-lg text-label no-underline transition-transform duration-150 hover:-translate-y-0.5"
          >
            <span aria-hidden="true">⤢</span>
          </a>
        ) : null}
        <button
          type="button"
          aria-label="Close tutor"
          onClick={onClose}
          className="size-11 flex-none rounded-[10px] border-2 border-deck-line bg-transparent text-lg text-label transition-transform duration-150 hover:-translate-y-0.5"
        >
          ×
        </button>
      </div>

      {graded ? (
        <div data-integrity="" className="mx-4 mt-3 flex flex-col gap-1 rounded-[10px] border-[1.5px] border-tape-3 bg-tape-3/[0.08] px-3 py-2.5 text-[13px] leading-[1.45]">
          <span className="font-bold text-tape-3">{graded.due ? `Graded, due ${graded.due}` : "Graded"}</span>
          <span className="text-slide">I won&apos;t give you the answer on graded work, but I&apos;ll guide you through the ideas. Tell me where you&apos;re stuck.</span>
        </div>
      ) : null}

      <div ref={scroller} role="log" aria-live="polite" aria-label="Conversation" className="tutor-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3 lg:gap-3 lg:py-3.5">
        <TutorTurns
          turns={turns}
          empty={graded ? "What are you working on? I'll ask questions to help you get there." : "Ask for a hint, or tell me where you're stuck. I'll ask questions and point to where the course covers it."}
          moment={config.moments[ctx.id]}
          slideHref={ctx.slideHref}
          onOpenMoment={onOpenMoment}
          answered={ctx.answered}
          graded={!!graded}
          question={ctx.question}
          greeting={ctx.answered && !graded && (ctx.start != null || ctx.slide) ? <StartChips ctx={ctx} config={config} onOpenMoment={onOpenMoment} /> : null}
        />
      </div>

      <div className="flex flex-col gap-2.5 border-t border-tutor-line px-4 pt-2.5 pb-[var(--phone-bottom-room)] lg:pt-3 lg:pb-4">
        <div className="flex flex-wrap gap-1.5">
          {quicks.map((q) => (
            <button
              key={q.label}
              type="button"
              data-hit-44=""
              disabled={busy}
              onClick={() => void send(q.request, q.message, q.pill)}
              className="relative inline-flex h-[34px] items-center rounded-full border-[1.5px] border-deck-line px-3 text-[13px] font-bold text-label before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-[''] disabled:opacity-60 lg:h-8 lg:before:-inset-y-1.5"
            >
              {q.label}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="flex gap-2">
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            maxLength={600}
            aria-label="Ask the tutor"
            placeholder={placeholder}
            autoComplete="off"
            className={COMPOSER}
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={busy}
            {...(sendPrimary ? { "data-primary": "" } : {})}
            className={`h-12 w-[52px] flex-none rounded-[10px] text-lg font-bold lg:w-14 ${sendPrimary ? "border-0 bg-action text-deck" : "border-2 border-label bg-transparent text-label"} disabled:opacity-60`}
          >
            ↑
          </button>
        </form>
      </div>
    </dialog>
  );
}
