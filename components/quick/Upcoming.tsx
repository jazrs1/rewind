"use client";

// Quick build (beta): "Coming up", the course's exams, quizzes and assignments from Canvas's own due dates
// (lib/quick/upcoming.ts). Read from this device only; nothing here touches the network. Exams read from the syllabus
// and announcements, when there are any, come first with the exact words they came from.

import { useEffect, useState } from "react";
import { browserUpcoming, dueText, stillAhead, whenText, type DueItem, type DueKind, type Upcoming as UpcomingData } from "@/lib/quick/upcoming";

const KIND: Record<DueKind, string> = { exam: "Exam", quiz: "Quiz", assignment: "Assignment" };
/** Rows shown before "Show all". */
const FIRST = 6;

function Row({ item, now }: { item: DueItem; now: Date }) {
  const at = new Date(item.dueAt);
  const exam = item.kind === "exam";
  const tag = (
    <span className={`flex-none rounded-full px-2.5 py-0.5 text-[13px] font-bold ${exam ? "border border-peach text-peach" : "bg-deck-sunk text-label-muted"}`}>{KIND[item.kind]}</span>
  );
  // Phone: when and the tag on one line, then the title and its date at full width. Wider: one row.
  const body = (
    <>
      <span className="flex items-center justify-between gap-3 sm:w-24 sm:flex-none">
        <span className={`text-[15px] font-bold ${exam ? "text-peach" : "text-label"}`}>{whenText(at, now)}</span>
        <span className="sm:hidden">{tag}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] font-bold leading-snug text-label">{item.title}</span>
        <span className="text-[13px] text-label-muted">{dueText(at)}</span>
      </span>
      <span className="hidden sm:block">{tag}</span>
    </>
  );
  const row = "flex min-h-11 flex-col gap-1 px-2 py-2 sm:flex-row sm:items-center sm:gap-3";
  return (
    <li data-upcoming-item={item.kind}>
      {item.url ? (
        <a href={item.url} target="_blank" rel="noopener noreferrer" className={`${row} rounded-md hover:bg-deck-sunk focus-visible:outline-2 focus-visible:outline-label`}>
          {body}
        </a>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

export function Upcoming({ course }: { course: string }) {
  const [data, setData] = useState<UpcomingData | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const store = browserUpcoming();
    const sync = () => {
      setData(store.read(course));
      setNow(new Date());
    };
    sync();
    return store.subscribe(sync);
  }, [course]);

  if (!data || !now) return null;
  const items = stillAhead(data.items, now);
  const exams = (data.exams ?? []).filter((e) => Date.parse(e.date) >= now.getTime() - 86_400_000);
  const rest = items.slice(FIRST);

  return (
    <section data-upcoming="" aria-labelledby="upcoming-title" className="flex flex-col gap-3 rounded-xl border border-deck-line/60 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-1">
        <h3 id="upcoming-title" className="m-0 font-display text-[18px] font-bold leading-tight text-label">
          Coming up in {data.course.name}
        </h3>
        <p className="m-0 text-[13px] text-label-muted">From the due dates in your Canvas course file. Stays on this device.</p>
      </div>

      {exams.length ? (
        <ul data-upcoming-exams="" aria-label="Exams from your syllabus and announcements" className="m-0 flex list-none flex-col gap-2 p-0">
          {exams.map((e) => (
            <li key={`${e.title}|${e.date}`} className="flex flex-col gap-1 rounded-md border border-peach/60 px-3 py-2">
              <span className="text-[15px] font-bold text-label">
                <span className="text-peach">{whenText(new Date(e.date), now)}</span> · {e.title}
              </span>
              <span className="text-[13px] text-label-muted">
                &ldquo;{e.quote}&rdquo; ({e.source})
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {items.length ? (
        <>
          <ul data-upcoming-list="" aria-label="Due dates" className="m-0 flex list-none flex-col p-0">
            {items.slice(0, FIRST).map((i) => (
              <Row key={`${i.title}|${i.dueAt}`} item={i} now={now} />
            ))}
          </ul>
          {rest.length ? (
            <details data-upcoming-more="">
              <summary className="flex min-h-11 cursor-pointer items-center px-2 text-[15px] font-bold text-label">Show all {items.length}</summary>
              <ul className="m-0 flex list-none flex-col p-0">
                {rest.map((i) => (
                  <Row key={`${i.title}|${i.dueAt}`} item={i} now={now} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : exams.length ? null : (
        <p data-upcoming-empty="" className="m-0 text-[15px] text-label-muted">
          No upcoming due dates in this course file. Export the course again later to refresh it.
        </p>
      )}
    </section>
  );
}
