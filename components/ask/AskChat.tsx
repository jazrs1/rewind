"use client";

// The Ask tab: a full-height chat over every course on this device, in the study session's style (a centred column,
// the same bubbles, cards and chips, the composer pinned at the bottom), with example prompts while it's empty.
// What it shows comes from tool results run here (lib/ask/tools.ts): deadline rows (DeadlineCard), practice questions
// as Scantron cards graded in place with their rewind chip (saved like /practice's answers), study-session buttons,
// and the answer's checked chips (lecture moments play in place as clip tiles). Graded work (a quiz or exam row tapped,
// or named) shows the integrity banner and is guided, never solved.

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type React from "react";
import { ClipTile } from "@/components/study/ClipTile";
import { hostedClipAt } from "@/lib/player/clip-lookup";
import { quizCard } from "@/components/study/StudySession";
import { Chips, SHELL } from "@/components/tutor/Chips";
import { SimilarCard } from "@/components/tutor/SimilarCard";
import { COMPOSER, STUDENT_BUBBLE, TUTOR_BUBBLE, WritingSkeleton } from "@/components/tutor/TutorTurns";
import type { AskChip } from "@/lib/ask/ground";
import type { PickedQuestion } from "@/lib/ask/questions";
import type { SavedAsk } from "@/lib/ask/saved";
import type { AskCourse } from "@/lib/ask/types";
import { recordAttempt } from "@/lib/attempts/client";
import { explanationMoment } from "@/lib/tutor/service";
import { slideImageOf, slideLinkOf } from "@/lib/tutor/poll";
import { DeadlineCard } from "./DeadlineCard";
import { useAskChat, type AskTurn } from "./useAskChat";

const noop = () => () => {};
const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

/** The chat fills the screen under whatever sits above it (the demo's header), as the study session does. */
function fitBelow(el: HTMLElement | null) {
  if (!el) return;
  const fit = () => el.style.setProperty("--ask-top", `${el.getBoundingClientRect().top + window.scrollY}px`);
  fit();
  window.addEventListener("resize", fit);
  return () => window.removeEventListener("resize", fit);
}

const EXAMPLE =
  "relative inline-flex min-h-[38px] items-center rounded-full border-[1.5px] border-deck-line px-3.5 py-1.5 text-left text-[14px] leading-snug font-bold text-label transition-transform duration-150 before:absolute before:inset-x-0 before:-inset-y-[3px] before:content-[''] enabled:hover:-translate-y-0.5 disabled:opacity-60 lg:text-[15px]";

function PracticeCards({ picked, courses, onAnswered, onOpen }: { picked: PickedQuestion[]; courses: AskCourse[]; onAnswered(id: string): void; onOpen(c: AskChip): void }) {
  return (
    <div data-practice-set="" className="flex flex-col gap-3">
      {picked.map((p, i) => {
        const bank = courses.find((c) => c.id === p.courseId)?.bank;
        if (!bank) return null;
        const q = p.question;
        const card = quizCard(q);
        const rewind = explanationMoment(q);
        return (
          <div key={q.id} data-practice-card={q.id} data-course={p.code} className="study-rise" style={{ "--i": i } as React.CSSProperties}>
            <SimilarCard
              card={card}
              label={`${p.code} · ${p.topic}`}
              onGraded={(_, marked) => {
                onAnswered(q.id);
                recordAttempt(bank.seed, q, marked, null);
              }}
              chips={
                rewind ? (
                  <Chips
                    grounded={[rewind]}
                    moment={bank.moments[q.id]}
                    slideHref={slideLinkOf(q) ?? ""}
                    onOpenMoment={() => onOpen({ grounded: rewind, courseId: p.courseId, moment: bank.moments[q.id] ? { date: bank.moments[q.id].date, shell: bank.moments[q.id].shell ?? p.shell } : null, questionId: q.id })}
                    onPaper
                  />
                ) : null
              }
            />
          </div>
        );
      })}
    </div>
  );
}

/** The courses on this device, each its code on its tape shell, inked as the mini-tape chips are (Chips.tsx SHELL). */
export function CourseChips({ courses }: { courses: AskCourse[] }) {
  return (
    <ul aria-label="Courses" data-course-chips="" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {courses.map((c) => (
        <li key={c.id} title={c.title} data-course-chip={c.code} className={`rounded-full px-2.5 py-1 text-[13px] leading-none font-bold ${SHELL[c.shell]}`}>
          {c.code}
        </li>
      ))}
    </ul>
  );
}

function AskChips({ chips, onOpen }: { chips: AskChip[]; onOpen(c: AskChip): void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <Chips key={`${c.grounded.kind}${c.grounded.quote}`} grounded={[c.grounded]} moment={c.moment} slideHref={c.grounded.kind === "slide" ? (c.grounded.href ?? "") : ""} onOpenMoment={() => onOpen(c)} onPaper />
      ))}
    </div>
  );
}

function Assistant({ t, courses, demo, busy, onOpen, onAnswered, onSend }: { t: AskTurn; courses: AskCourse[]; demo: boolean; busy: boolean; onOpen(c: AskChip): void; onAnswered(id: string): void; onSend(message: string): void }) {
  if (t.clip) {
    const g = t.clip.grounded;
    if (g.kind !== "lecture") return null;
    const bank = courses.find((c) => c.id === t.clip!.courseId)?.bank;
    const clipQ = t.clip.questionId ? bank?.seed.questions.find((q) => q.id === t.clip!.questionId) : undefined;
    return (
      <div data-ask-turn="clip" className="study-rise">
        <ClipTile
          start={g.start}
          quote={g.quote}
          moment={t.clip.moment}
          media={hostedClipAt(bank?.media, { questionId: clipQ?.id, date: t.clip.moment?.date, second: g.start })}
          poster={clipQ ? slideImageOf(clipQ) : undefined}
          notHosted={demo ? undefined : "This clip plays from your Zoom recording on the practice page."}
        />
      </div>
    );
  }
  const state = t.streaming ? "streaming" : t.error ? "error" : "answer";
  // The words, chips and labels are the cream reply; the cards (deadlines, practice, study links) and the graded
  // banner sit bare on the panel around it, as in the study session and the tutor panel.
  return (
    <div data-ask-turn={state} aria-busy={t.streaming || undefined} className="study-rise flex flex-col gap-2.5">
      {t.guide ? (
        <div data-integrity="" className="flex flex-col gap-1 rounded-[10px] border-[1.5px] border-tape-3 bg-tape-3/[0.08] px-3 py-2.5 text-[13px] leading-[1.45]">
          <span className="font-bold text-tape-3">
            {t.guide.code} · {t.guide.title} · Graded{t.guide.due ? `, due ${t.guide.due.slice(5).replace("-", "/")}` : ""}
          </span>
          <span className="text-slide">I won&apos;t give you the answer on graded work, but I&apos;ll guide you through the ideas. Tell me where you&apos;re stuck.</span>
        </div>
      ) : null}
      <div data-tutor-turn={state} className={`flex flex-col gap-2.5 ${TUTOR_BUBBLE} ${t.error ? "text-slide-ink" : ""}`}>
        {t.text ? <span className="whitespace-pre-line">{t.text}</span> : null}
        {t.chips?.length ? (
          <>
            <AskChips chips={t.chips} onOpen={onOpen} />
            <span data-from-course="" className="text-xs leading-[1.45] font-bold text-print">
              ✓ From your course
            </span>
          </>
        ) : null}
        {t.saved ? (
          <span data-saved="" title="The live assistant was busy or slow, so this reply was saved ahead of time" className="text-xs leading-[1.45] text-slide-ink">
            Saved reply
          </span>
        ) : null}
        {t.streaming ? (
          <>
            {t.status ? (
              <span data-ask-status="" className="text-[13px] text-slide-ink">
                {t.status}
              </span>
            ) : null}
            <WritingSkeleton />
          </>
        ) : null}
      </div>
      {t.deadlines ? <DeadlineCard result={t.deadlines} onSend={onSend} busy={busy} /> : null}
      {t.questions?.length ? <PracticeCards picked={t.questions} courses={courses} onAnswered={onAnswered} onOpen={onOpen} /> : null}
      {t.study?.length ? (
        <div className="flex flex-wrap gap-2">
          {t.study.map((s) => (
            <a key={s.href} href={s.href} data-study-link="" className="btn btn-secondary min-h-11 text-[15px] no-underline">
              <span aria-hidden="true" className="size-2.5 rounded-full" style={{ background: `var(--color-tape-${s.shell})` }} />
              {s.title}
              {s.graded ? " · guide mode" : ""}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AskChat(props: { courses: AskCourse[]; endpoint: string; demo: boolean; examples: string[]; saved: SavedAsk[]; title: string }) {
  // Reads the practice kept on this device (ranking, saving answers), so the chat is drawn on the client.
  const mounted = useMounted();
  if (!mounted) return <main data-ask="" aria-busy="true" className="h-dvh bg-tutor" />;
  return <Chat {...props} />;
}

function Chat({ courses, endpoint, demo, examples, saved, title }: { courses: AskCourse[]; endpoint: string; demo: boolean; examples: string[]; saved: SavedAsk[]; title: string }) {
  const { turns, busy, send, openClip, markAnswered } = useAskChat({ courses, endpoint, demo, saved });
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const count = turns.length;
  useEffect(() => {
    if (count) requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
  }, [count]);
  const ask = (m: string) => {
    setDraft("");
    void send(m);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) ask(draft);
  };
  return (
    <main data-ask="" ref={fitBelow} className="flex h-[calc(100dvh-var(--ask-top,0px))] flex-col overflow-hidden bg-tutor text-label">
      {/* The app header (the demo's DemoHeader) names the page and its Ask tab; under it, a thin row of the courses. */}
      <div data-course-row="" className="border-b border-tutor-line">
        <div className="mx-auto flex max-w-[760px] items-center gap-2 px-4 py-1.5 lg:px-8">
          <h1 className="sr-only">{title}</h1>
          <CourseChips courses={courses} />
        </div>
      </div>

      <div ref={scroller} role="log" aria-live="polite" aria-label="Conversation" className="tutor-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!turns.length ? (
          <div data-ask-empty="" className="m-auto flex w-full max-w-[640px] flex-col items-center gap-3 px-4 py-8 text-center">
            <h2 className="study-rise m-0 font-display text-[28px] leading-tight font-extrabold lg:text-[36px]">Ask your courses</h2>
            <p data-ask-intro="" className="study-rise m-0 text-[15px] leading-snug text-label-muted lg:text-[17px]" style={{ "--i": 1 } as React.CSSProperties}>
              What&apos;s due, practice from your question banks, or what your lecturer said, answered from {demo ? "the demo course" : "your course material"}.
            </p>
            <div data-examples="" className="mt-2 flex flex-wrap justify-center gap-2">
              {examples.map((e, i) => (
                <button key={e} type="button" data-example="" data-hit-44="" disabled={busy} onClick={() => ask(e)} className={`study-rise ${EXAMPLE}`} style={{ "--i": i + 2 } as React.CSSProperties}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className={`mx-auto w-full max-w-[760px] flex-col gap-3 px-4 py-4 lg:gap-4 lg:px-8 lg:py-6 ${turns.length ? "flex" : "hidden"}`}>
          {turns.map((t) =>
            t.role === "student" ? (
              <div
                key={t.id}
                data-student-turn=""
                className={`study-rise ${STUDENT_BUBBLE}`}
              >
                {t.text}
              </div>
            ) : (
              <Assistant key={t.id} t={t} courses={courses} demo={demo} busy={busy} onOpen={openClip} onAnswered={markAnswered} onSend={ask} />
            ),
          )}
        </div>
      </div>

      <div className="border-t border-tutor-line">
        <div className="mx-auto flex max-w-[760px] flex-col gap-2.5 px-4 pt-2.5 pb-[18px] lg:px-8 lg:pt-3 lg:pb-6">
          <form onSubmit={submit} className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
              maxLength={500}
              aria-label="Ask about your courses"
              placeholder="Ask about your courses…"
              autoComplete="off"
              className={COMPOSER}
            />
            <button type="submit" aria-label="Send" data-primary="" disabled={busy} className="h-12 w-[52px] flex-none rounded-[10px] border-0 bg-action text-lg font-bold text-deck disabled:opacity-60 lg:w-14">
              ↑
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

