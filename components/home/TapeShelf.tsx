"use client";

// Lecture tapes on the course home, one per module in course order (Home mockups: PhoneHome
// lines 53-82, DesktopHome lines 78-88). A recorded tape is a shell in its module's color with a
// paper label (its name in the sans, its dates in the hand) and the lecture dates; it opens practice for that lecture (or the course
// tape). A module with no recording is a blank grey tape that says so: missing things look missing.
// The phone shows five tapes around the latest recording, with "See all"; desktop shows them all.
// Tapes are cassettes (the landing's .cassette: two screws, a paper label set in, a window with reels; styles in
// app/tape-screen.css). Only motion: the 2 px hover lift on tapes that open something (none with reduced motion).

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import type React from "react";
import { phoneWindow, shortDate } from "@/lib/home/build";
import type { HomeTape } from "@/lib/home/types";

/** Hand-lettered labels never truncate: a long one steps the font down and wraps to a second line. */
/** Module names wrap rather than truncate: a long one steps down a size. (The UI sans: Caveat is for dates only.) */
const hand = (label: string) => (label.length > 24 ? "text-[15px] leading-[1.2]" : "text-[16px] leading-[1.2]");

const SHELL = { 1: "bg-tape-1", 2: "bg-tape-2", 3: "bg-tape-3", 4: "bg-tape-4" } as const;

/** The cassette's window: two reels seen through it (the take-up side fuller). */
function Window() {
  return (
    <span aria-hidden="true" className="shelf-window">
      <span className="shelf-reel" />
      <span className="shelf-reel shelf-reel-big" />
    </span>
  );
}

/**
 * A tape as a cassette, in the landing's .cassette style: the module's shell colour with two screws, a paper
 * label set into it (the hand-lettered title and the lecture dates), and a window with its reels.
 */
function RecordedTape({ tape, examTitle }: { tape: HomeTape; examTitle: string | null }) {
  const dates = tape.lectureDates.map(shortDate).join(" · ");
  const body = (
    <>
      <span className={`shelf-label flex min-h-[38px] min-w-0 flex-1 items-center gap-3 bg-label px-3 py-[3px] font-sans font-bold text-deck lg:min-h-11 ${hand(tape.label)}`}>
        {/* Phone: the dates go under the title, so the title keeps the width; desktop: on the right. */}
        <span className="flex min-w-0 flex-1 flex-col py-1 lg:flex-row lg:items-center lg:justify-between lg:gap-3 lg:py-0">
          <span className="min-w-0 break-words">{tape.label}</span>
          {dates ? <span className="flex-none font-hand text-[19px] text-tape-label-ink">{dates}</span> : null}
        </span>
        <Window />
      </span>
      {tape.onNextExam && examTitle ? (
        <span className="flex min-h-[38px] flex-none items-center self-stretch rounded-[5px] bg-deck px-[10px] font-sans text-[13px] font-bold text-label lg:min-h-11">On {examTitle}</span>
      ) : null}
    </>
  );
  const shell = `shelf-cassette flex items-center gap-2 ${tape.shell ? SHELL[tape.shell] : "bg-tape-blank"}`;
  if (!tape.link) return <div className={shell}>{body}</div>;
  // What the tape opens is said on it, under the shell: "Practice the Oct 22 lecture · Oct 20: no questions yet".
  return (
    <Link
      href={tape.link.href}
      data-tape-link=""
      className="tape-lift flex flex-col gap-[6px] rounded-[10px] no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-label"
    >
      <span className={shell}>{body}</span>
      <span className="px-1 text-[13px] leading-snug text-label-muted">
        <span data-tape-opens="" className="font-bold text-label">{tape.link.label}</span>
        {tape.link.note ? ` · ${tape.link.note}` : ""}
      </span>
    </Link>
  );
}

function BlankTape({ tape }: { tape: HomeTape }) {
  return (
    <div className="shelf-cassette shelf-blank flex items-center bg-tape-blank">
      <span className="shelf-label flex min-h-[38px] min-w-0 flex-1 items-center gap-3 bg-tape-blank-label px-3 py-[3px] text-label lg:min-h-11">
        <span className="flex min-w-0 flex-1 flex-col py-1 lg:flex-row lg:items-center lg:justify-between lg:gap-3 lg:py-0">
          <span className={`min-w-0 break-words font-sans font-bold ${hand(tape.label)}`}>{tape.label}</span>
          <span className="flex-none text-[14px] lg:text-[13px]">Blank tape</span>
        </span>
        <Window />
      </span>
    </div>
  );
}

/**
 * `dropKey` (the import's time): the tapes drop onto the shelf one at a time (--stagger apart, --ease-settle),
 * once per import on this device. An inline script marks the page before it paints when this import's drop has
 * already been seen, so a revisit shows the shelf still.
 */
/** Runs of two or more blank tapes in a row, as [from, to) indexes. */
export function blankRuns(tapes: { state: string }[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i < tapes.length; ) {
    if (tapes[i].state !== "blank") {
      i++;
      continue;
    }
    let j = i;
    while (j < tapes.length && tapes[j].state === "blank") j++;
    if (j - i >= 2) out.push({ from: i, to: j });
    i = j;
  }
  return out;
}

export function TapeShelf({ tapes, latestRecorded, examTitle, dropKey = null }: { tapes: HomeTape[]; latestRecorded: number; examTitle: string | null; dropKey?: string | null }) {
  const [all, setAll] = useState(false);
  // Desktop: runs of 2+ blank tapes in a row fold into one row each ("Mod 1–7: 7 modules without recordings").
  const runs = blankRuns(tapes);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const seenKey = dropKey ? `rewind.tapes-dropped.v1.${dropKey}` : null;
  useEffect(() => {
    if (!seenKey) return;
    try {
      localStorage.setItem(seenKey, "1");
    } catch {
      // Storage blocked: the drop just plays again next time.
    }
  }, [seenKey]);
  const [from, to] = phoneWindow(tapes.length, latestRecorded);
  const hidden = tapes.length - (to - from);
  return (
    <>
      <div className="mt-1 flex items-baseline justify-between lg:mt-0">
        <h2 id="tapes-title" className="m-0 font-display text-[22px] font-bold lg:text-[24px]">
          Lecture tapes
        </h2>
        {hidden > 0 ? (
          <button
            type="button"
            aria-expanded={all}
            aria-controls="tape-list"
            onClick={() => setAll((v) => !v)}
            className="-my-3 -mr-2 inline-flex min-h-11 items-center px-2 text-[14px] text-peach hover:text-label focus-visible:outline-2 focus-visible:outline-label lg:hidden"
          >
            {all ? "Show fewer" : "See all"}
          </button>
        ) : null}
      </div>
      {tapes.length ? null : (
        <p data-tapes-empty="" className="m-0 rounded-xl bg-deck-raised px-[18px] py-4 text-[15px] leading-normal text-label-muted">
          No modules found in the Canvas export, so there are no lecture tapes yet. Put the course&apos;s Canvas export in private/ and run the course pipeline (npm run pipeline), then reload.
        </p>
      )}
      {seenKey ? (
        <script
          dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem(${JSON.stringify(seenKey)}))document.documentElement.dataset.tapesSeen=""}catch(e){}` }}
        />
      ) : null}
      <ul id="tape-list" aria-labelledby="tapes-title" className="m-0 flex list-none flex-col gap-3 p-0">
        {tapes.map((t, i) => {
          const run = runs.find((r) => i >= r.from && i < r.to);
          const folded = !!run && !open.has(run.from);
          return (
            <Fragment key={t.moduleId}>
              {/* Desktop: a run of blank tapes is one row until opened, so the recorded tapes come up first. */}
              {run && i === run.from ? (
                <li data-blank-run="" className={`hidden lg:block ${dropKey ? "tape-drop" : ""}`} style={{ "--i": i } as React.CSSProperties}>
                  <button
                    type="button"
                    aria-expanded={!folded}
                    onClick={() => setOpen((o) => {
                      const n = new Set(o);
                      if (n.has(run.from)) n.delete(run.from);
                      else n.add(run.from);
                      return n;
                    })}
                    className="shelf-cassette shelf-blank tape-lift flex w-full items-center bg-tape-blank text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-label"
                  >
                    <span className="shelf-label flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 bg-tape-blank-label px-3 py-[3px] text-label">
                      <span className="font-sans text-[16px] leading-[1.2] font-bold">
                        Mod {tapes[run.from].position}–{tapes[run.to - 1].position}: {run.to - run.from} modules without recordings
                      </span>
                      <span className="flex-none text-[13px]">{folded ? "Show" : "Hide"}</span>
                      <Window />
                    </span>
                  </button>
                </li>
              ) : null}
              <li
                data-tape={t.state}
                style={{ "--i": i, "--i-phone": Math.max(0, i - from) } as React.CSSProperties}
                className={`${dropKey ? "tape-drop" : ""} ${!all && (i < from || i >= to) ? "max-lg:hidden" : ""} ${folded ? "lg:hidden" : ""}`}
              >
                {t.state === "recorded" ? <RecordedTape tape={t} examTitle={examTitle} /> : <BlankTape tape={t} />}
              </li>
            </Fragment>
          );
        })}
      </ul>
    </>
  );
}
