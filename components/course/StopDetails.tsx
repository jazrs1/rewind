"use client";

// One stop, opened by tapping it on the tape (John, Oct 24: no text dumps). It leads with the two facts that
// answer "why this stop": how much the professor stressed it and how often you miss it, as two tiles in plain
// words (never raw scores). Then the evidence, compact: the professor's moment as a tape chip with one verbatim
// sentence from it, every other piece of evidence as a one-line row with its source in small print, and your
// misses as one row per question (at most 3, then "+N more"). Then the actions: play the moment, practice it.
// Nothing is made up: what there's no evidence for says so plainly.

import Link from "next/link";
import { useState } from "react";
import { ExampleBadge } from "@/components/attempts/PracticeData";
import { SourceLabel } from "@/components/source/SourceLabel";
import { formatTime } from "@/lib/format";
import type { ClipContext, Evidence, Stop } from "@/lib/course/types";
import { missedFact, stressedFact } from "@/lib/course/stopFacts";
import { ClipPlayer } from "./ClipPlayer";
import { clipWhen, evidenceSource } from "./shared";

/** At most this many rows before "+N more". */
const ROWS = 3;

/** The first sentence of a verbatim line, with an ellipsis when the line goes on (never reworded). */
export function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  const first = (m ? m[0] : text).trim();
  return first.length < text.trim().length ? `${first} …` : first;
}

/** The rules behind the glow, behind a small disclosure (John, Oct 25: never a paragraph in the sheet). */
function HowRanked() {
  return (
    <details className="text-[13px] text-label-muted">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-bold text-label hover:text-peach">How this is ranked</summary>
      <p className="m-0 max-w-[60ch] pb-1 leading-snug">
        No glow under 1.5 points unless it was flagged or a past review names it. A full glow needs an exam or importance flag, or a past review;
        lecture time alone stays at a medium glow.
      </p>
    </details>
  );
}

function EvidenceRow({ e }: { e: Evidence }) {
  const src = evidenceSource(e);
  return (
    <li data-kind={e.kind} className="flex min-w-0 flex-col border-t border-tape-blank py-1.5 first:border-t-0">
      <span className="text-[15px] font-bold">{e.detail}</span>
      <SourceLabel tone="deck" link={src.link}>
        {src.text}
      </SourceLabel>
    </li>
  );
}

export function StopDetails({
  stop,
  context,
  extensionId,
  accent,
  practiceHref,
  tapeGlows = true,
}: {
  stop: Stop;
  /** Does any stop on the tape glow? Without one, no glow wording at all (the tile says "Stressed", no glow rule). */
  tapeGlows?: boolean;
  context: ClipContext | undefined;
  extensionId: string;
  accent?: string;
  /** Where practice for this stop's lecture opens, or null when there's no practice page for it. */
  practiceHref: string | null;
}) {
  const [playing, setPlaying] = useState(false);
  const [allEvidence, setAllEvidence] = useState(false);
  const [allMisses, setAllMisses] = useState(false);
  const clip = stop.clips[0] ?? null;
  const prof = context?.lecturer && context.lecturer !== "the lecturer" ? context.lecturer : "Your professor";
  const fact = stressedFact(stop, prof);
  const answers = stop.missed.evidence.filter((e) => e.kind === "practice");
  const misses = answers.filter((e) => e.points > 0);
  const miss = missedFact(misses.length, answers.length);
  const evidence = stop.stressed.evidence;
  const shownEvidence = allEvidence ? evidence : evidence.slice(0, ROWS);
  const shownMisses = allMisses ? misses : misses.slice(0, ROWS);
  const practiceCount = misses.length || stop.practiceIds.length;

  return (
    <div className="flex max-w-[70ch] flex-col gap-4 pt-3">
      {/* Why this stop: two facts, big. */}
      <div className="grid grid-cols-2 gap-2.5">
        <section aria-label={`Stressed: ${stop.topic}`} className="tile-rise flex flex-col gap-1 rounded-xl bg-deck px-3.5 py-3" style={{ "--i": 0 } as React.CSSProperties}>
          <h3 className="m-0 text-[15px] leading-snug font-bold text-label">{fact.title}</h3>
          {fact.value ? <p className="m-0 font-display text-[18px] leading-tight font-extrabold tabular-nums">{fact.value}</p> : null}
        </section>
        <section aria-label={`Missed: ${stop.topic}`} className="tile-rise flex flex-col gap-1 rounded-xl bg-deck px-3.5 py-3" style={{ "--i": 1 } as React.CSSProperties}>
          <h3 className="m-0 text-[15px] leading-snug font-bold text-label">{miss.title}</h3>
          {miss.value ? <p className="m-0 font-display text-[22px] leading-tight font-extrabold tabular-nums">{miss.value}</p> : null}
          {miss.value && answers.some((e) => e.example) ? <ExampleBadge className="text-[13px] font-normal text-peach" /> : null}
        </section>
      </div>
      <HowRanked />

      {/* The professor's moment: a tape chip and one sentence from it, word for word. */}
      {clip && !playing ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setPlaying(true)}
            aria-label={`Play the lecture from ${clipWhen(clip)}`}
            data-hit-44=""
            className="lift relative inline-flex h-9 items-center before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] gap-1.5 self-start rounded-md pr-2.5 pl-1 text-ink"
            style={{ background: accent ?? "var(--color-tape-1)" }}
          >
            <span className="inline-flex h-7 items-center rounded-[3px] bg-label px-2 font-hand text-[19px] font-bold text-deck">{clipWhen(clip)}</span>
            <span aria-hidden="true" className="text-xs font-bold">
              ◀◀
            </span>
          </button>
          {clip.quote ? (
            <q title={clip.quote} className="line-clamp-2 text-[15px] leading-snug text-label">
              {firstSentence(clip.quote)}
            </q>
          ) : null}
        </div>
      ) : null}
      {clip && playing ? <ClipPlayer clip={clip} context={context} extensionId={extensionId} accent={accent} /> : null}

      {/* The evidence for the glow, one line each with its source. */}
      {evidence.length ? (
        <section aria-label="Why it glows" className="flex flex-col">
          <ul aria-label={`Evidence for ${stop.topic}`} className="m-0 list-none p-0">
            {shownEvidence.map((e, i) => (
              <EvidenceRow key={i} e={e} />
            ))}
          </ul>
          {evidence.length > ROWS && !allEvidence ? (
            <button type="button" onClick={() => setAllEvidence(true)} className="btn btn-tertiary self-start text-sm">
              +{evidence.length - ROWS} more
            </button>
          ) : null}
        </section>
      ) : null}

      {/* Your misses: a row per question, the stem on one line; tap to practise it again. */}
      {misses.length ? (
        <section aria-label={`Misses for ${stop.topic}`} className="flex flex-col">
          <h3 className="m-0 pb-1 text-[13px] font-bold text-label-muted">Your misses</h3>
          <ul className="m-0 list-none p-0">
            {shownMisses.map((e, i) => {
              const row = (
                <>
                  <span aria-hidden="true" className="flex-none font-bold text-red-pen">
                    ✕
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[15px]">{e.quote ?? "A practice question"}</span>
                  <span className="sr-only">
                    {e.detail}. {e.source}
                    {e.at ? `, ${e.at}` : ""}.
                  </span>
                </>
              );
              return (
                <li key={i} data-kind="practice" className="border-t border-tape-blank first:border-t-0">
                  {practiceHref ? (
                    <Link href={practiceHref} className="flex min-h-11 items-center gap-2.5 text-label no-underline hover:text-peach">
                      {row}
                    </Link>
                  ) : (
                    <span className="flex min-h-11 items-center gap-2.5">{row}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {misses.length > ROWS && !allMisses ? (
            <button type="button" onClick={() => setAllMisses(true)} className="btn btn-tertiary self-start text-sm">
              +{misses.length - ROWS} more
            </button>
          ) : null}
        </section>
      ) : null}

      {/* Actions: play the moment (the one primary), practise it. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        {clip && !playing ? (
          <button type="button" onClick={() => setPlaying(true)} className="btn btn-primary btn-lg flex-1 tabular-nums">
            Play this moment · {formatTime(clip.start)}
          </button>
        ) : null}
        {practiceHref && practiceCount ? (
          <Link href={practiceHref} className="btn btn-secondary btn-lg flex-1">
            {practiceCount === 1 ? "Practice this one" : `Practice these ${practiceCount}`}
          </Link>
        ) : null}
      </div>
      {!clip ? (
        stop.slides[0] ? (
          <SourceLabel tone="deck" link={stop.slides[0].href ? { href: stop.slides[0].href, label: "Open in Canvas" } : null}>
            No recording of it: the slides are {stop.slides[0].label}
          </SourceLabel>
        ) : (
          <p className="m-0 text-[15px] text-label-muted">No recording or slides of it yet.</p>
        )
      ) : null}
    </div>
  );
}
