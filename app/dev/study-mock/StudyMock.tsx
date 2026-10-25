"use client";

// The study session mock ("instead of ChatGPT"): the full-screen tutor, on invented data. The deck world: the topics
// rail on the left with each topic's Course tape heat (glow = he stressed it, ✕n = you missed n), the chat in the
// middle with questions as small Scantron cards graded in place, lecture moments as mini-tape players and slides as
// previews, and the quick actions over the composer. Send is the screen's one primary. On a phone the chat is the
// whole screen and the topics sit behind a button, in a sheet.
//
// Static: nothing here calls the tutor, and no text is from a real course.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Play } from "@/components/icons";
import { MissMark } from "@/components/course/MissMark";
import { Chips } from "@/components/tutor/Chips";
import { TutorTurns } from "@/components/tutor/TutorTurns";
import type { TutorTurn } from "@/components/tutor/types";
import { SimilarCard } from "@/components/tutor/SimilarCard";
import type { SimilarCard as Card } from "@/lib/tutor/similar";

type Topic = { id: string; name: string; taught: string; stressed: 0 | 1 | 2 | 3; missed: number; tried: number; shell: 1 | 2 | 3 | 4; graded?: string; ahead?: boolean };

// Invented: a fake course's Exam 2 coverage, with made-up heat.
const TOPICS: Topic[] = [
  { id: "heaps", name: "Heaps", taught: "Oct 14", stressed: 3, missed: 2, tried: 5, shell: 1 },
  { id: "hashing", name: "Hash tables", taught: "Oct 20", stressed: 2, missed: 1, tried: 4, shell: 2 },
  { id: "trees", name: "Balanced trees", taught: "Oct 2", stressed: 2, missed: 3, tried: 6, shell: 1 },
  { id: "sorting", name: "Sorting", taught: "Oct 9", stressed: 1, missed: 0, tried: 3, shell: 3 },
  { id: "graphs", name: "BFS and DFS", taught: "Oct 27", stressed: 1, missed: 0, tried: 0, shell: 4, graded: "Quiz 8 · graded" },
  { id: "tries", name: "Tries", taught: "Nov 3", stressed: 0, missed: 0, tried: 0, shell: 4, ahead: true },
];

const CARD: Card = {
  stem: "You push 3 onto the min heap [4, 9, 6, 12]. At which index does 3 end up?",
  code: null,
  choices: [
    { label: "A", text: "Index 4" },
    { label: "B", text: "Index 1" },
    { label: "C", text: "Index 0" },
    { label: "D", text: "Index 3" },
  ],
  answer: "C",
  explanation: "3 is smaller than every parent on its way up, so it climbs all the way to the root.",
  source: { kind: "lecture", quote: "it keeps swapping with its parent while it is smaller than the parent", start: 2480 },
};

const TURNS: TutorTurn[] = [
  { id: 1, role: "tutor", kind: "reply", note: true, text: "We're on Heaps for Exam 2. You missed 2 of 5 here, and Kapoor stressed it on Oct 14. A question first, or the idea explained?" },
  { id: 2, role: "student", text: "Quiz me", pill: true },
  { id: 3, role: "tutor", kind: "reply", text: "Here's one on Heaps. Mark your answer:" },
  { id: 4, role: "student", text: "Why did it go all the way up? I thought a push stops after one swap." },
  { id: 5, role: "tutor", kind: "reply", text: "It keeps swapping while it's still smaller than its parent. Here's the moment Kapoor walks through it:" },
  { id: 6, role: "tutor", kind: "reply", text: "And the slide Kapoor had up:", grounded: [{ kind: "slide", quote: "Sift up: swap with the parent until the parent is smaller", deck: "5 - Heaps", page: 12, pageKind: "slide" }] },
];

const MOMENT = { date: "2026-10-14", shell: 1 as const };

/** Glow = flagged by the professor (the course tape's orange halo), the dot in the module's shell colour. */
function HeatDot({ t }: { t: Topic }) {
  const d = 22 + t.stressed * 10;
  const a = Math.min(0.9, 0.2 * t.stressed + (t.missed ? 0.1 : 0));
  return (
    <span aria-hidden="true" className="relative flex size-11 flex-none items-center justify-center">
      {t.stressed ? (
        <span
          data-glow={t.stressed}
          className="pointer-events-none absolute rounded-full mix-blend-screen blur-[5px]"
          style={{ width: d, height: d, background: `radial-gradient(closest-side, rgba(255,96,40,${a.toFixed(2)}) 0%, rgba(250,70,22,${(a * 0.6).toFixed(2)}) 35%, rgba(233,180,60,${(a * 0.35).toFixed(2)}) 65%, rgba(233,180,60,0) 100%)` }}
        />
      ) : null}
      <span
        className="relative box-content block size-3 rounded-full border-[3px] border-deck"
        style={{
          background: t.ahead ? "var(--color-tape-blank-label)" : `var(--color-tape-${t.shell})`,
        }}
      />
    </span>
  );
}

function TopicList({ focus, onFocus }: { focus: string; onFocus(id: string): void }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {TOPICS.map((t) => {
        const on = t.id === focus;
        return (
          <li key={t.id}>
            <button
              type="button"
              aria-current={on || undefined}
              aria-label={`${t.name}, taught ${t.taught}, stressed ${t.stressed}, missed ${t.missed}${t.graded ? `, ${t.graded}` : ""}`}
              onClick={() => onFocus(t.id)}
              className={`flex min-h-14 w-full items-center gap-2 rounded-[10px] py-1.5 pr-3 pl-1 text-left transition-transform duration-150 hover:-translate-y-0.5 ${on ? "bg-deck-raised shadow-[inset_3px_0_0_var(--color-label)]" : ""}`}
            >
              <HeatDot t={t} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={`text-[15px] leading-tight font-bold ${t.ahead ? "text-ahead" : "text-label"}`}>{t.name}</span>
                <span className="text-[13px] leading-snug text-label-muted">
                  {t.ahead ? `Not taught yet · ${t.taught}` : `Taught ${t.taught}${t.tried ? ` · missed ${t.missed} of ${t.tried}` : ""}`}
                </span>
              </span>
              {t.graded ? <span className="flex-none rounded-full border-[1.5px] border-tape-3 px-2 py-0.5 text-[13px] font-bold text-tape-3">Graded</span> : null}
              {on ? <span className="sr-only">In focus</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Legend() {
  return (
    <p className="m-0 text-[13px] leading-snug text-label-muted">
      <b className="text-label">Glow:</b> your professor flagged it · <MissMark /> = times you missed it
    </p>
  );
}

/** A lecture moment in the chat: a mini tape of the clip, its counter and the line he says there, word for word. */
function MiniTape() {
  return (
    <figure data-mini-tape="" className="m-0 flex flex-col gap-2 rounded-[10px] bg-deck p-2.5">
      <div className="flex items-center gap-2.5">
        <button type="button" aria-label="Play the lecture from Oct 14, 41:20" className="flex size-11 flex-none items-center justify-center rounded-[10px] border-2 border-label text-label transition-transform duration-150 hover:-translate-y-0.5">
          <Play />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-tape-1 pr-2 pl-1">
              <span className="inline-flex h-5 items-center rounded-[3px] bg-label px-2 font-hand text-[18px] leading-none font-bold text-deck">Oct 14 · 41:20</span>
              <span aria-hidden="true" className="text-xs font-bold text-white">
                ◀◀
              </span>
            </span>
            <span className="font-mono text-[13px] text-label-muted">0:00 / 0:45</span>
          </div>
          <div aria-hidden="true" className="relative h-1.5 overflow-hidden rounded-full bg-roller-groove">
            <span className="absolute inset-y-0 left-0 w-[8%] rounded-full bg-tape-ribbon" />
          </div>
        </div>
      </div>
      <figcaption className="text-[15px] leading-snug text-label-muted">
        &ldquo;It keeps swapping with its parent while it is smaller than the parent.&rdquo;
      </figcaption>
    </figure>
  );
}

/** A slide in the chat: a small preview of the page, its name, and a way to open it. */
function SlidePreview() {
  return (
    <figure data-slide-preview="" className="m-0 flex flex-col gap-2">
      <div className="flex aspect-[16/9] w-full max-w-[340px] flex-col gap-2 rounded-md bg-slide px-4 py-3 text-slide-ink shadow-[0_2px_6px_rgb(0_0_0/0.35)]">
        <span className="font-display text-[15px] font-extrabold">Push (sift up)</span>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-[13px] leading-snug">
          <li>Put the new value in the next free slot</li>
          <li>Sift up: swap with the parent until the parent is smaller</li>
          <li>At most the height of the tree: O(log n)</li>
        </ul>
      </div>
    </figure>
  );
}

const QUICKS = ["Quiz me", "Explain this topic", "Similar one"];
const QUICK = "relative inline-flex h-[34px] items-center rounded-full border-[1.5px] border-deck-line px-3 text-[13px] font-bold text-label before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-[''] lg:h-9 lg:px-3.5 lg:text-[15px] lg:before:-inset-y-1";

export function StudyMock() {
  const [focus, setFocus] = useState("heaps");
  const [sheet, setSheet] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (sheet && !d.open) d.showModal();
    if (!sheet && d.open) d.close();
  }, [sheet]);
  const topic = TOPICS.find((t) => t.id === focus)!;

  // The quiz card shows already marked wrong and checked, so the mock shows the red-pen beat.
  const extra = (t: TutorTurn) =>
    t.id === 3 ? (
      <SimilarCard card={CARD} label="Quiz · Heaps" initial={{ selected: "B", checked: true }} chips={<Chips grounded={[CARD.source]} moment={MOMENT} slideHref="#" onOpenMoment={() => {}} onPaper />} />
    ) : t.id === 5 ? (
      <MiniTape />
    ) : t.id === 6 ? (
      <SlidePreview />
    ) : null;

  return (
    <main data-study="" className="flex h-dvh overflow-hidden bg-deck text-label">
      {/* The rail (desktop): the coverage topics with their heat. */}
      <aside aria-label="Topics" className="hidden w-[320px] flex-none flex-col gap-4 overflow-y-auto border-r border-tutor-line bg-deck-sunk px-4 py-6 lg:flex">
        <div className="flex flex-col gap-1 px-1">
          <h2 className="m-0 font-display text-[22px] font-extrabold">Exam 2 topics</h2>
          <Legend />
        </div>
        <TopicList focus={focus} onFocus={setFocus} />
        <p className="m-0 mt-auto px-1 text-[13px] leading-snug text-label-muted">Tap a topic to focus the session on it. Graded work: I guide, I don&apos;t solve.</p>
      </aside>

      <section aria-label="Study with the tutor" className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-tutor-line px-4 py-3 lg:px-8 lg:py-4">
          <button type="button" aria-label="Back to practice" className="flex size-11 flex-none items-center justify-center rounded-[10px] border-2 border-deck-line transition-transform duration-150 hover:-translate-y-0.5 lg:size-12">
            <ArrowLeft />
          </button>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="m-0 truncate font-display text-[18px] leading-tight font-extrabold lg:text-[30px]">Study with the tutor</h1>
            <span className="truncate text-[13px] text-label-muted lg:text-[15px]">FAKE 2301 · {topic.name} in focus · practice</span>
          </div>
          <button type="button" aria-haspopup="dialog" onClick={() => setSheet(true)} className="btn btn-secondary min-h-11 flex-none gap-0 py-0 pr-3 pl-0 text-[15px] lg:hidden">
            <span aria-hidden="true" className="scale-75">
              <HeatDot t={topic} />
            </span>
            Topics
          </button>
        </header>

        <div role="log" aria-label="Conversation" className="tutor-scroll min-h-0 flex-1 overflow-y-auto bg-tutor">
          <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-4 py-4 lg:gap-4 lg:px-8 lg:py-6">
            <TutorTurns turns={TURNS} empty="" moment={MOMENT} slideHref="#" onOpenMoment={() => {}} answered extra={extra} />
          </div>
        </div>

        <div className="border-t border-tutor-line bg-tutor">
          <div className="mx-auto flex max-w-[760px] flex-col gap-2.5 px-4 pt-2.5 pb-[18px] lg:px-8 lg:pt-3 lg:pb-6">
            <div className="flex flex-wrap gap-1.5 lg:gap-2">
              {QUICKS.map((q) => (
                <button key={q} type="button" data-hit-44="" className={QUICK}>
                  {q}
                </button>
              ))}
            </div>
            <form onSubmit={(e) => e.preventDefault()} className="flex gap-2">
              <input
                aria-label="Ask the tutor"
                placeholder={`Ask about ${topic.name}…`}
                autoComplete="off"
                className="h-12 min-w-0 flex-1 rounded-[10px] border-0 bg-deck px-3.5 text-[15px] text-label shadow-[inset_0_2px_4px_rgb(0_0_0/0.35)] placeholder:text-ahead"
              />
              <button type="submit" aria-label="Send" data-primary="" className="h-12 w-[52px] flex-none rounded-[10px] border-0 bg-action text-lg font-bold text-deck lg:w-14">
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
        onClose={() => setSheet(false)}
        className="sheet-up fixed inset-x-0 top-auto bottom-0 m-0 max-h-[80dvh] w-full max-w-none flex-col gap-3 overflow-y-auto rounded-t-[18px] border-0 bg-deck-sunk px-4 pt-2 pb-6 text-label backdrop:bg-deck/60 open:flex lg:hidden"
        style={{ "--tw-shadow": "0 -12px 30px rgb(0 0 0 / 0.45)" } as CSSProperties}
      >
        <div aria-hidden="true" className="flex justify-center pb-1">
          <div className="h-[5px] w-11 rounded-[3px] bg-tape-blank-label" />
        </div>
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="m-0 font-display text-[22px] font-extrabold">Exam 2 topics</h2>
            <Legend />
          </div>
          <button type="button" aria-label="Close topics" onClick={() => setSheet(false)} className="size-11 flex-none rounded-[10px] border-2 border-deck-line text-lg text-label">
            ×
          </button>
        </div>
        <TopicList
          focus={focus}
          onFocus={(id) => {
            setFocus(id);
            setSheet(false);
          }}
        />
      </dialog>
    </main>
  );
}
