"use client";

// The full-screen study session ("instead of ChatGPT"), as John approved the mock (docs/design/study-mock-*.png):
//   - the rail: the exam's coverage topics in priority order (your professor stressed it × you miss it, lib/study/topics.ts), each
//     in its Course tape module colour with the tape's glow and its ✕n miss marker; the top one says "Start here"; tapping one focuses
//     the session on it. On a phone the rail is a sheet behind "Topics".
//   - the chat: practice questions as small Scantron cards graded in place ("Quiz me", no model call), lecture moments
//     as 16:9 clip tiles that play in place, slides as previews, the tutor's replies with their checked chips.
//   - quick actions: "Quiz me", "Explain this topic", "Similar one". A graded topic (the server decides: the topic's
//     questions are in config.tutor.gradedIds) is integrity mode: the banner, no quiz and no similar question, and
//     "Explain … again" / "Where do I start?" instead.
// The tutor is the dev study route (the exam's topic rule) or the public demo route (always the question's rule); each
// topic talks about its anchor question. Practice answers here are saved like /practice's, so the rail's heat moves.

import { useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type React from "react";
import { ExampleBadge, useExampleHistory } from "@/components/attempts/PracticeData";
import { ArrowLeft } from "@/components/icons";
import { Chips } from "@/components/tutor/Chips";
import { SimilarCard } from "@/components/tutor/SimilarCard";
import { COMPOSER, TutorTurns, TUTOR_BUBBLE, type TurnContext } from "@/components/tutor/TutorTurns";
import type { TutorTurn } from "@/components/tutor/types";
import { CARRY_KEY, useTutorChat, type ChatRequest } from "@/components/tutor/useTutorChat";
import { recordAttempt, useAttempts } from "@/lib/attempts/client";
import { hasExampleEvidence, mergeAttempts } from "@/lib/course/attempts";
import type { SeedQuestion } from "@/lib/demo/types";
import type { ChoiceLabel } from "@/lib/schema";
import type { StudyConfig } from "@/lib/study/config";
import { studyTopics, type StudyTopic } from "@/lib/study/topics";
import { groundClaims } from "@/lib/tutor/claims";
import { slideImageOf, slideLinkOf } from "@/lib/tutor/poll";
import { explanationMoment, materialOf } from "@/lib/tutor/service";
import type { SimilarCard as Card } from "@/lib/tutor/similar";
import { MissMark } from "@/components/course/MissMark";
import { ClipTile, SlidePreview } from "./ClipTile";
import { hostedClipAt } from "@/lib/player/clip-lookup";

const noop = () => () => {};

/** The session fills the screen under whatever sits above it (the demo's header), and keeps doing so as that wraps. */
function fitBelow(el: HTMLElement | null) {
  if (!el) return;
  const fit = () => el.style.setProperty("--study-top", `${el.getBoundingClientRect().top + window.scrollY}px`);
  fit();
  window.addEventListener("resize", fit);
  return () => window.removeEventListener("resize", fit);
}
const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

/** The topic's module-coloured dot with its glow (your professor flagged it), as on the Course tape; the miss count sits after the name. */
function HeatDot({ t, small = false }: { t: StudyTopic; small?: boolean }) {
  const g = t.glow;
  return (
    <span aria-hidden="true" className={`relative flex flex-none items-center justify-center ${small ? "size-8" : "size-11"}`}>
      {g ? (
        <span
          data-glow={g}
          className="pointer-events-none absolute rounded-full"
          style={{
            width: 34 + g * 2,
            height: 34 + g * 2,
            background: `radial-gradient(closest-side, rgba(255,96,40,${(0.3 + g * 0.1).toFixed(2)}) 0%, rgba(250,70,22,${(0.2 + g * 0.07).toFixed(2)}) 60%, rgba(250,70,22,0) 100%)`,
            boxShadow: `0 0 ${3 + g}px ${1 + g / 2}px rgba(250,70,22,${(0.2 + g * 0.06).toFixed(2)})`,
          }}
        />
      ) : null}
      <span
        className="relative box-content block size-3 rounded-full border-[3px] border-deck"
        style={{ background: t.ahead ? "var(--color-tape-blank-label)" : t.shell }}
      />
    </span>
  );
}

function TopicList({ topics, focus, onFocus }: { topics: StudyTopic[]; focus: string; onFocus(id: string): void }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {topics.map((t, i) => {
        const on = t.id === focus;
        const line = t.ahead ? "Not taught yet" : [t.taught ? `Taught ${dayOf(t.taught)}` : "Taught: not found", t.tried ? `missed ${t.wrong} of ${t.tried}` : null].filter(Boolean).join(" · ");
        return (
          <li key={t.id} className="study-rise" style={{ "--i": i + 1 } as React.CSSProperties}>
            <button
              type="button"
              data-topic={t.id}
              data-graded={t.graded ? "" : undefined}
              data-question-ids={t.questionIds.join(" ")}
              data-topic-name={t.name}
              aria-current={on || undefined}
              aria-label={`${t.name}, ${line}${t.glow ? ", flagged by your professor" : ""}${t.graded ? ", graded" : ""}${i === 0 && !t.ahead ? ", start here" : ""}`}
              onClick={() => onFocus(t.id)}
              className={`flex min-h-14 w-full items-center gap-2 rounded-[10px] py-1.5 pr-2 pl-1 text-left transition-transform duration-150 hover:-translate-y-0.5 ${on ? "bg-deck-raised shadow-[inset_3px_0_0_var(--color-label)]" : ""}`}
            >
              <span className="relative flex w-14 flex-none">
                <HeatDot t={t} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                {i === 0 && !t.ahead ? <span data-start-here="" className="text-[13px] leading-tight font-bold text-peach">Start here</span> : null}
                {/* The miss count to the right of the name, never over the dot. */}
                <span className={`text-[15px] leading-tight font-bold ${t.ahead ? "text-ahead" : "text-label"}`}>
                  {t.name}
                  <MissMark n={t.wrong} className="ml-1.5 align-[-2px]" />
                </span>
                <span className="text-[13px] leading-snug text-label-muted">{line}</span>
              </span>
              {t.graded ? <span className="flex-none rounded-full border-[1.5px] border-tape-3 px-2 py-0.5 text-[13px] font-bold text-tape-3">Graded</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayOf = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** The glow line only when a topic glows; the miss mark generic, with no number. */
function Legend({ glows }: { glows: boolean }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1 text-[13px] leading-snug text-label-muted">
      {glows ? (
        <>
          <b className="text-label">Glow:</b> your professor flagged it ·{" "}
        </>
      ) : null}
      <MissMark /> <span>= times you missed it</span>
    </p>
  );
}

/** A practice question as a chat card: its own words, choices and key, and the moment that explains it as its source. */
/** Does a turn's question belong to the topic it was made under (that stop's practice questions)? Turns from before the
 * study session (carried over by ⤢) have no topic and keep what they had. */
export function turnBelongs(t: Pick<TutorTurn, "topic" | "qid" | "quiz" | "moment">, topics: Pick<StudyTopic, "id" | "questionIds">[]): boolean {
  if (!t.topic) return true;
  const own = topics.find((x) => x.id === t.topic);
  if (!own) return false;
  return [t.qid, t.quiz, t.moment?.questionId].every((id) => !id || own.questionIds.includes(id));
}

export function quizCard(q: SeedQuestion): Card {
  const m = materialOf(q);
  const source = explanationMoment(q) ?? (m.slide ? groundClaims([{ quote: m.slide.quote }], { lecture: [], slide: m.slide })[0] : undefined);
  return {
    stem: q.stem,
    code: q.code ?? null,
    choices: q.choices,
    answer: q.answer,
    explanation: q.explanation ?? "",
    source: source ?? { kind: "slide", quote: q.source?.quote ?? q.stem, deck: q.match.slide.deck, page: q.match.slide.page, pageKind: q.match.slide.kind ?? "slide" },
  };
}

const QUICK =
  "relative inline-flex h-[34px] items-center rounded-full border-[1.5px] border-deck-line px-3 text-[13px] font-bold text-label transition-transform duration-150 before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-[''] enabled:hover:-translate-y-0.5 disabled:opacity-60 lg:h-9 lg:px-3.5 lg:text-[15px] lg:before:-inset-y-1";

export function StudySession({ config }: { config: StudyConfig }) {
  // The session reads this tab's carried conversation (⤢) and the practice kept on this device, so it is drawn on the
  // client; the server sends the frame. The entrance plays once, as it appears.
  const mounted = useMounted();
  if (!mounted) {
    return (
      <main data-study="" aria-busy="true" className="flex h-dvh overflow-hidden bg-deck text-label">
        <aside aria-label="Topics" className="hidden w-[320px] flex-none border-r border-tutor-line bg-deck-sunk lg:block" />
        <section aria-label="Study with the tutor" className="min-w-0 flex-1 bg-tutor" />
      </main>
    );
  }
  // ?q=<question>: open on that question's topic (⤢ from the tutor panel).
  const initialQuestion = new URLSearchParams(window.location.search).get("q");
  return <Session config={config} initialQuestion={initialQuestion} />;
}

function RailHead({ config, glows }: { config: StudyConfig; glows: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="m-0 font-display text-[22px] font-extrabold">{config.title}</h2>
      <p data-exam-line="" className="m-0 text-[15px] text-label">
        {config.examLine}
      </p>
      <Legend glows={glows} />
    </div>
  );
}

function Session({ config, initialQuestion }: { config: StudyConfig; initialQuestion: string | null }) {
  const course = config.course.code;
  useExampleHistory(course, config.examples);
  const attempts = useAttempts(course);
  const tape = useMemo(() => mergeAttempts(config.tape, attempts), [config.tape, attempts]);
  const ids = useMemo(() => config.seed.questions.map((q) => q.id), [config.seed]);
  const topics = useMemo(() => studyTopics(tape, ids, config.tutor.gradedIds), [tape, ids, config.tutor.gradedIds]);
  if (!topics.length) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-deck px-5 text-label">
        <p className="m-0 max-w-md text-center text-[18px]">No topics with practice questions for {config.examName} yet.</p>
      </main>
    );
  }
  return <Chat config={config} topics={topics} initialQuestion={initialQuestion} attempts={attempts} hasExamples={hasExampleEvidence(tape)} />;
}

function Chat({
  config,
  topics,
  initialQuestion,
  attempts,
  hasExamples,
}: {
  config: StudyConfig;
  topics: StudyTopic[];
  initialQuestion: string | null;
  attempts: ReturnType<typeof useAttempts>;
  hasExamples: boolean;
}) {
  const [sheetOpen, setSheet] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const onSheet = (open: boolean) => {
    setSheet(open);
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  };
  const byId = useMemo(() => new Map(config.seed.questions.map((q) => [q.id, q])), [config.seed]);
  // ⤢ from the tutor panel leaves its conversation here (this tab only); it is read once, on the first client render.
  const [carried] = useState<{ questionId: string; turns: TutorTurn[] } | null>(() => {
    try {
      const raw = sessionStorage.getItem(CARRY_KEY);
      sessionStorage.removeItem(CARRY_KEY);
      const c = raw ? (JSON.parse(raw) as { questionId: string; turns: TutorTurn[] }) : null;
      return c && Array.isArray(c.turns) ? { questionId: c.questionId, turns: c.turns.map((t) => ({ ...t, qid: t.qid ?? c.questionId })) } : null;
    } catch {
      return null;
    }
  });
  const start = carried?.questionId ?? initialQuestion;
  const [focusId, setFocusId] = useState<string>(() => topics.find((t) => start && t.questionIds.includes(start))?.id ?? topics[0].id);
  const topic = topics.find((t) => t.id === focusId) ?? topics[0];
  // The first message is about the topic in focus until the conversation starts; after that a switch greets once.
  const [introOn, setIntroOn] = useState(focusId);
  const first = topics.find((t) => t.id === introOn) ?? topic;
  // The question each topic talks about: the one carried over when it is this topic's, else the topic's anchor.
  const questionId = carried && topic.questionIds.includes(carried.questionId) ? carried.questionId : topic.anchorId;
  const [answers, setAnswers] = useState<Record<string, ChoiceLabel>>({});
  const markedOf = (qid: string): ChoiceLabel | null => answers[qid] ?? [...attempts].reverse().find((a) => a.questionId === qid && !a.example)?.choice ?? null;
  const { turns: allTurns, busy, send, note, greet } = useTutorChat({ config: config.tutor, questionId, marked: markedOf(questionId), initial: carried?.turns, topic: topic.id });
  // Every clip, chip and slide in a topic's turn comes from that topic's stop: a turn whose question isn't the topic's
  // shows its words only (lib/study/topics.ts: the stop's practice questions).
  const turns = allTurns.map((t) => (turnBelongs(t, topics) ? t : { ...t, grounded: [], moment: undefined, similar: undefined }));
  const [draft, setDraft] = useState("");
  const [quizzed, setQuizzed] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const graded = topic.graded;
  const assignment = config.tutor.graded;

  const scrollDown = () => requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));

  const focus = (id: string) => {
    onSheet(false);
    if (id === topic.id) return;
    const t = topics.find((x) => x.id === id)!;
    setFocusId(id);
    // Nothing said yet: the first message simply becomes this topic's. Else one greeting (replacing an unanswered one).
    if (!allTurns.length) setIntroOn(id);
    else greet(t.graded ? `It's graded work, so I'll guide you with questions and won't give answers. What are you working on?` : `A question first, or the idea explained?`, { qid: t.anchorId, topic: t.id }, t.name);
    scrollDown();
  };

  const ask = (request: ChatRequest, message: string, pill?: string) => {
    setDraft("");
    void send(request, message, pill).then(scrollDown);
    scrollDown();
  };

  const quizMe = () => {
    const next = topic.questionIds.find((id) => !quizzed.includes(id) && !markedOf(id)) ?? topic.questionIds.find((id) => !quizzed.includes(id)) ?? topic.questionIds[0];
    setQuizzed((q) => [...q, next]);
    note("", { quiz: next, qid: next, topic: topic.id }, "Quiz me");
    scrollDown();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const m = draft.trim();
    if (m) ask("reply", m);
  };

  const ctx = (t: TutorTurn): TurnContext => {
    const qid = t.qid ?? questionId;
    const q = byId.get(qid);
    return {
      question: q,
      answered: !!markedOf(qid),
      graded: config.tutor.gradedIds.includes(qid),
      moment: config.tutor.moments[qid],
      slideHref: q ? (slideLinkOf(q) ?? "") : "",
    };
  };
  const openMoment = (startSec: number, t: TutorTurn) => {
    const qid = t.qid ?? questionId;
    const q = byId.get(qid);
    const line = q?.segments.find((s) => s.start === startSec)?.text ?? q?.source?.quote ?? "";
    note("", { qid, topic: t.topic, moment: { questionId: qid, start: startSec, quote: line } });
    scrollDown();
  };
  const tile = (qid: string, startSec: number, quote: string) => {
    const q = byId.get(qid);
    return <ClipTile questionId={qid} start={startSec} quote={quote} moment={config.tutor.moments[qid]} media={hostedClipAt(config.media, { questionId: qid, date: config.tutor.moments[qid]?.date, second: startSec })} poster={q ? slideImageOf(q) : undefined} notHosted={config.demo ? undefined : "This clip plays from your Zoom recording on the practice page."} />;
  };
  const extra = (t: TutorTurn) => {
    if (t.quiz) {
      const q = byId.get(t.quiz);
      if (!q) return null;
      const c = ctx(t);
      const card = quizCard(q);
      return (
        <SimilarCard
          card={card}
          label={`Quiz · ${topics.find((x) => x.questionIds.includes(q.id))?.name ?? topic.name}`}
          onGraded={(_, marked) => {
            setAnswers((a) => ({ ...a, [q.id]: marked }));
            recordAttempt(config.seed, q, marked, null);
          }}
          chips={<Chips grounded={[card.source]} moment={c.moment} slideHref={c.slideHref} onOpenMoment={(s) => openMoment(s, t)} onPaper />}
        />
      );
    }
    if (t.moment) return tile(t.moment.questionId, t.moment.start, t.moment.quote);
    return null;
  };

  const why = first.wrong ? ` You missed ${first.wrong} of ${first.tried} here.` : "";
  const intro = first.graded
    ? `We're on ${first.name}. It's graded work, so I'll guide you with questions and won't give answers. What are you working on?`
    : `We're on ${first.name} for ${config.examName}.${why}${first.glow ? " Your professor flagged it in lecture." : ""} A question first, or the idea explained?`;
  // Graded (integrity mode): no quiz and no similar question, only questions back.
  type Quick = "quiz" | "explain" | "similar" | "again" | "start";
  const quicks: { key: Quick; label: string }[] = graded
    ? [
        { key: "again", label: `Explain ${topic.name} again` },
        { key: "start", label: "Where do I start?" },
      ]
    : [
        { key: "quiz", label: "Quiz me" },
        { key: "explain", label: "Explain this topic" },
        { key: "similar", label: "Similar one" },
      ];
  function runQuick(key: Quick) {
    if (key === "quiz") quizMe();
    else if (key === "explain") ask("reply", `Explain ${topic.name}`, "Explain this topic");
    else if (key === "similar") ask("similar", "", "Similar one");
    else if (key === "again") ask("reply", `Explain ${topic.name} again`);
    else ask("reply", "Where do I start?");
  }

  return (
    <main data-study="" ref={fitBelow} className="flex h-[calc(100dvh-var(--study-top,0px))] overflow-hidden bg-deck text-label">
      <aside aria-label="Topics" className="study-rail-in hidden w-[320px] flex-none flex-col gap-4 overflow-y-auto border-r border-tutor-line bg-deck-sunk px-6 py-6 lg:flex">
        <RailHead config={config} glows={topics.some((t) => t.glow > 0)} />
        <TopicList topics={topics} focus={topic.id} onFocus={focus} />
      </aside>
      <section aria-label="Study with the tutor" className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-tutor-line px-4 py-3 lg:px-8 lg:py-4">
          <a href={config.backHref} aria-label="Back to practice" className="flex size-11 flex-none items-center justify-center rounded-[10px] border-2 border-deck-line text-label transition-transform duration-150 hover:-translate-y-0.5 lg:size-12">
            <ArrowLeft />
          </a>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="m-0 truncate font-display text-[18px] leading-tight font-extrabold lg:text-[30px]">Study with the tutor</h1>
            <span data-study-topic="" className="truncate text-[13px] text-label-muted lg:hidden">
              {topic.name}
            </span>
            <span className="hidden truncate text-[15px] text-label-muted lg:block">
              {config.course.code} · {topic.name} · {graded ? "graded" : "practice"}
            </span>
          </div>
          <button type="button" aria-haspopup="dialog" onClick={() => onSheet(true)} className="btn btn-secondary min-h-11 flex-none gap-0 py-0 pr-3 pl-0 text-[15px] lg:hidden">
            <span className="scale-75">
              <HeatDot t={topic} />
            </span>
            Topics
          </button>
        </header>

        {graded ? (
          <div className="bg-tutor px-4 pt-3 lg:px-8">
          <div data-integrity="" className="mx-auto flex max-w-[696px] flex-col gap-1 rounded-[10px] border-[1.5px] border-tape-3 bg-tape-3/[0.08] px-3 py-2.5 text-[13px] leading-[1.45]">
            <span className="font-bold text-tape-3">{assignment?.due ? `Graded, due ${assignment.due}` : "Graded"}</span>
            <span className="text-slide">I won&apos;t give you the answer on graded work, but I&apos;ll guide you through the ideas. Tell me where you&apos;re stuck.</span>
          </div>
          </div>
        ) : null}

        <div ref={scroller} role="log" aria-live="polite" aria-label="Conversation" className="tutor-scroll min-h-0 flex-1 overflow-y-auto bg-tutor">
          <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-4 py-4 lg:gap-4 lg:px-8 lg:py-6">
            <div data-study-intro="" className={`study-rise ${TUTOR_BUBBLE}`} style={{ "--i": topics.length + 1 } as React.CSSProperties}>
              {intro}
              {hasExamples ? (
                <span className="mt-2 block text-[13px] text-slide-ink">
                  The misses come from <ExampleBadge /> until you answer.
                </span>
              ) : null}
            </div>
            <TutorTurns
              turns={turns}
              empty=""
              context={ctx}
              onOpenMoment={openMoment}
              extra={extra}
              renderMoment={(t, g) => tile(t.qid ?? questionId, g.start, g.quote)}
              renderSlide={(t, g) => {
                const q = byId.get(t.qid ?? questionId);
                // The question's own slide when the chip is it; another slide (an earlier one) has no render here.
                const own = q && q.match.slide.deck === g.deck && q.match.slide.page === g.page;
                const src = own ? slideImageOf(q) : undefined;
                return src ? <SlidePreview src={src} alt={`${g.pageKind === "page" ? "Page" : "Slide"} ${g.page}`} /> : null;
              }}
            />
          </div>
        </div>

        <div className="border-t border-tutor-line bg-tutor">
          <div className="mx-auto flex max-w-[760px] flex-col gap-2.5 px-4 pt-2.5 pb-[var(--phone-bottom-room)] lg:px-8 lg:pt-3 lg:pb-6">
            <div className="flex flex-wrap gap-1.5 lg:gap-2">
              {quicks.map((q) => (
                <button key={q.label} type="button" data-hit-44="" data-quick={q.key} disabled={busy} onClick={() => runQuick(q.key)} className={QUICK}>
                  {q.label}
                </button>
              ))}
            </div>
            <form onSubmit={submit} className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy}
                maxLength={500}
                aria-label="Ask the tutor"
                placeholder={`Ask about ${topic.name}…`}
                autoComplete="off"
                className={COMPOSER}
              />
              <button type="submit" aria-label="Send" data-primary="" disabled={busy} className="h-12 w-[52px] flex-none rounded-[10px] border-0 bg-action text-lg font-bold text-deck disabled:opacity-60 lg:w-14">
                ↑
              </button>
            </form>
          </div>
        </div>
      </section>

      {/* Phone: the topics in a sheet. */}
      <dialog
        ref={dialog}
        aria-label="Topics"
        onClose={() => sheetOpen && onSheet(false)}
        className="sheet-up fixed inset-x-0 top-auto bottom-0 m-0 max-h-[80dvh] w-full max-w-none flex-col gap-3 overflow-y-auto rounded-t-[18px] border-0 bg-deck-sunk px-6 pt-2 pb-[var(--phone-bottom-room)] text-label shadow-[0_-12px_30px_rgb(0_0_0/0.45)] backdrop:bg-deck/60 open:flex lg:hidden"
      >
        <div aria-hidden="true" className="flex justify-center pb-1">
          <div className="h-[5px] w-11 rounded-[3px] bg-tape-blank-label" />
        </div>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <RailHead config={config} glows={topics.some((t) => t.glow > 0)} />
          </div>
          <button type="button" aria-label="Close topics" onClick={() => onSheet(false)} className="size-11 flex-none rounded-[10px] border-2 border-deck-line text-lg text-label">
            ×
          </button>
        </div>
        <TopicList topics={topics} focus={topic.id} onFocus={focus} />
      </dialog>
    </main>
  );
}
