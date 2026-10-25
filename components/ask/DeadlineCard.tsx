"use client";

// The deadline card under an Ask answer, from list_deadlines' result (never from the model's words): exams first under
// the code-written summary ("1 exam: Exam 2, Mon Nov 2, in 9 days"), then "Also due". Each row shows the course's
// colour, the title, the Eastern date, days left and a Graded tag, and every row opens something, with the same
// chevron: a Graded row (every quiz and exam: decided on the server) opens the tutor in guide mode right here; an
// ungraded row opens its course's practice, or asks for it in the chat when the course has no practice page. Items
// with no date are named in a small muted footer ("No date for … in your Canvas data"), wrapped, never cut off.

import type React from "react";
import { Chevron } from "@/components/icons";
import { examSummary, noDateLine, type DeadlineResult, type DeadlineRow } from "@/lib/ask/deadlines";

const KIND: Record<string, string> = { exam: "Exam", quiz: "Quiz", "programming-quiz": "Programming quiz", assignment: "Assignment", event: "Event" };

/** What a Graded row sends: it names the item, so the turn is in guide mode (lib/ask/guide.ts). */
export const guideMessage = (title: string) => `Guide me on ${title}`;
/** What an ungraded row sends when its course has no practice page. */
export const practiceMessage = (code: string) => `Help me practice for ${code}`;

const ROW =
  "study-rise flex min-h-14 w-full items-center gap-2.5 rounded-[8px] border-0 bg-deck-raised px-2.5 py-2 text-left no-underline transition-transform duration-150 enabled:hover:-translate-y-0.5 [&:is(a)]:hover:-translate-y-0.5";

function Row({ r, i, onSend, busy }: { r: DeadlineRow; i: number; onSend(message: string): void; busy: boolean }) {
  const body = (
    <>
      <span aria-hidden="true" className="h-9 w-1.5 flex-none rounded-full" style={{ background: `var(--color-tape-${r.shell})` }} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] leading-tight font-bold text-label">{r.title}</span>
        <span className="text-[13px] leading-snug text-label-muted">
          {r.code} · {KIND[r.kind]} · {r.date}
        </span>
      </span>
      <span className="flex flex-none flex-col items-end gap-1">
        <span data-days-left="" className={`text-[13px] font-bold ${r.daysLeft <= 2 ? "text-peach" : "text-label"}`}>
          {r.left}
        </span>
        {r.graded ? <span data-graded="" className="rounded-full border-[1.5px] border-tape-3 px-2 py-0.5 text-[12px] leading-none font-bold text-tape-3">Graded</span> : null}
      </span>
      <Chevron data-row-chevron="" className="flex-none -rotate-90 text-label-muted" aria-hidden="true" />
    </>
  );
  const style = { "--i": i } as React.CSSProperties;
  const what = `${r.title}, ${r.code}, ${r.date}, ${r.left}`;
  if (r.graded)
    return (
      <button type="button" data-row-action="guide" disabled={busy} onClick={() => onSend(guideMessage(r.title))} style={style} aria-label={`${what}, graded: open the tutor in guide mode`} className={ROW}>
        {body}
      </button>
    );
  if (r.href)
    return (
      <a href={r.href} data-row-action="practice" style={style} aria-label={`${what}: open its practice`} className={ROW}>
        {body}
      </a>
    );
  return (
    <button type="button" data-row-action="ask-practice" disabled={busy} onClick={() => onSend(practiceMessage(r.code))} style={style} aria-label={`${what}: practice for ${r.code}`} className={ROW}>
      {body}
    </button>
  );
}

export function DeadlineCard({ result, onSend, busy }: { result: DeadlineResult; onSend(message: string): void; busy: boolean }) {
  const where = (code: string) => result.searched.find((s) => s.code === code)?.where ?? [];
  const exams = result.rows.filter((r) => r.kind === "exam");
  const others = result.rows.filter((r) => r.kind !== "exam");
  const list = (rows: DeadlineRow[], from: number) => (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((r, i) => (
        <li key={`${r.courseId}-${r.title}`} data-deadline-row="" data-course={r.code} data-kind={r.kind}>
          <Row r={r} i={from + i} onSend={onSend} busy={busy} />
        </li>
      ))}
    </ul>
  );
  return (
    <div data-deadline-card="" className="flex flex-col gap-1.5 rounded-[10px] border-[1.5px] border-deck-line bg-deck p-1.5">
      <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 px-2 pt-1">
        <span data-exam-summary="" className="text-[15px] font-bold text-label">
          {result.rows.length ? examSummary(result).split(" Also due:")[0] : `Nothing dated ${result.range.label}.`}
        </span>
        <span className="text-[13px] text-label-muted">{result.range.label} · Eastern time</span>
      </p>
      {exams.length ? list(exams, 0) : null}
      {others.length ? (
        <>
          <p data-also-due="" className="m-0 px-2 pt-1.5 text-[13px] font-bold tracking-wide text-label-muted uppercase">
            Also due
          </p>
          {list(others, exams.length)}
        </>
      ) : null}
      {!result.rows.length ? (
        <p data-nothing-dated="" className="m-0 px-2 pb-1 text-[15px] leading-snug text-label">
          {result.searched.map((s) => `Nothing dated ${result.range.label} in your ${s.code} Canvas data (looked in: ${s.where.join(", ") || "nothing: no Canvas export on this device"}).`).join(" ")}
        </p>
      ) : null}
      {result.undated.length ? (
        <footer data-no-date="" className="mx-1 mt-0.5 flex flex-col gap-0.5 border-t border-tutor-line px-1 pt-2 pb-1">
          {result.undated.map((u) => (
            <p key={`${u.code}-${u.title}`} className="m-0 text-[13px] leading-snug break-words whitespace-normal text-label-muted">
              {noDateLine(u.title, u.code, where(u.code))}
            </p>
          ))}
        </footer>
      ) : null}
    </div>
  );
}
