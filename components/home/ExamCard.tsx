// The next exam (or a nearer quiz) on the course home, printed on Scantron paper (Home mockups:
// PhoneHome lines 26-49, DesktopHome lines 46-59): timing marks down the right edge, a header ruled in
// print green, the name with the days left, and two form fields (exam: Date and Room; quiz: Date and
// Covers). A field we found is handwritten; one we didn't is an empty field reading "not found".
// Sources sit under the fields in small print (SourceLabel), one line per source (fields that share
// one are merged, "Name and date"), or where we looked when a field wasn't found. The demo course's card
// (components/demo/DemoExamCard.tsx) shows its one quote instead.

import { isHandValue } from "@/components/type/HandValues";
import Link from "next/link";
import { Chevron } from "@/components/icons";
import { SourceLabel } from "@/components/source/SourceLabel";
import type { HomeExam, HomeField } from "@/lib/home/types";

function TimingMarks() {
  return (
    <div aria-hidden="true" className="absolute top-[14px] right-[10px] bottom-[14px] flex flex-col justify-between lg:top-[18px] lg:right-[14px] lg:bottom-[18px]">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className={`h-[5px] w-[14px] bg-ink lg:h-[6px] lg:w-4 ${i >= 7 ? "hidden lg:block" : ""}`} />
      ))}
    </div>
  );
}

function Field({ label, field }: { label: string; field: HomeField | null }) {
  const found = field?.state === "found";
  return (
    <div data-field={label} data-state={found ? "found" : "missing"} className="flex min-w-0 flex-col rounded-[3px] border-[1.5px] border-print px-2 py-1 lg:px-[10px] lg:py-[6px]">
      <span className="text-[13px] text-print">{label}</span>
      {found ? (
        isHandValue(field.text) ? (
          <span className={`font-hand leading-[1.25] font-bold break-words text-graphite ${field.text.length > 14 ? "text-[18px] lg:text-[18px]" : "text-[20px] lg:text-[22px]"}`}>{field.text}</span>
        ) : (
          <span className="font-sans text-[15px] leading-[1.35] font-bold break-words text-graphite">{field.text}</span>
        )
      ) : (
        <span className="flex min-h-[25px] items-end text-[13px] text-print lg:min-h-[27.5px]">not found</span>
      )}
    </div>
  );
}

function SourceRow({ label, field }: { label: string; field: HomeField }) {
  if (field.state === "found") {
    return (
      <SourceLabel tone="paper" link={field.source.link}>
        <span className="font-bold">{label}:</span> {field.source.label}
      </SourceLabel>
    );
  }
  return (
    <SourceLabel tone="paper">
      <span className="font-bold">{label}:</span> not found. {field.searched}.
    </SourceLabel>
  );
}

export interface ExamCardProps {
  /** exam: the next exam (Date, Room); quiz: a nearer quiz with found topics (Date, Covers). */
  kind: "exam" | "quiz";
  exam: HomeExam | null;
  /** Whole Eastern days left, or null when the date wasn't found. */
  days: number | null;
  /** "Exam 2 in 25 days", read out once for screen readers. */
  text: string;
  /** "Exam 2 topics: not found in the syllabus or announcements." when the exam's coverage wasn't found. */
  coverageNote?: string | null;
  /** Keeps ids unique when the same card is rendered for two layouts (phone and desktop places). */
  idSuffix?: string;
  /** "lead": the nearest deadline, the screen's one big thing (bigger title and countdown); "side": the other card. */
  size?: "lead" | "side";
  /** "Study with the tutor": the full-screen study session for this exam or quiz (a quiet link, never a second primary). */
  studyHref?: string;
  /** The second field: Room (an exam's default) or Covers (a quiz's; the demo's exams, which ship no room). */
  second?: "room" | "covers";
  /** The demo: the one word-for-word quote every field is from, shown in place of the source lines. */
  quote?: string | null;
}

export function ExamCard({ kind, exam, days, text, coverageNote, idSuffix = "", size = "side", studyHref, second = kind === "quiz" ? "covers" : "room", quote = null }: ExamCardProps) {
  const id = `${kind}-card-title${idSuffix ? `-${idSuffix}` : ""}`;
  const lead = exam?.sources.find((s): s is { label: string; field: Extract<HomeField, { state: "found" }> } => s.field.state === "found");
  const big = size === "lead";
  return (
    <section
      aria-labelledby={id}
      data-card={kind}
      className="paper-sheet relative flex flex-col lg:flex-1 gap-[10px] overflow-hidden rounded-md bg-paper pt-[14px] pr-[34px] pb-4 pl-4 text-ink lg:pr-[44px] lg:pb-[14px] lg:pl-[22px]"
    >
      <TimingMarks />
      <div className="flex items-baseline justify-between gap-3 border-b-[1.5px] border-print pb-[6px] text-[13px] text-print lg:pb-2">
        <span className="font-bold">{kind === "quiz" ? "Next quiz" : "Next exam"}</span>
        <span className="text-right">{exam?.dateFrom ?? "Date not found"}</span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <h2 id={id} className={`min-w-0 font-serif leading-none font-semibold text-balance ${(exam?.title.length ?? 0) > 18 ? "text-[26px] lg:text-[30px]" : big ? "text-[34px] lg:text-[52px]" : "text-[34px] lg:text-[38px]"}`}>
          {exam?.title ?? "No exam found"}
        </h2>
        <p data-countdown={days === null ? "no-date" : "days"} className="m-0 flex flex-none items-baseline gap-[6px] text-print">
          <span className="sr-only">{text}</span>
          {days === null ? (
            <span aria-hidden="true" className="text-[14px] lg:text-[15px]">No date found</span>
          ) : days === 0 ? (
            <span aria-hidden="true" className={`font-display text-[40px] leading-[0.9] font-extrabold tracking-[-2px] text-ink ${big ? "lg:text-[88px]" : "lg:text-[52px]"}`}>Today</span>
          ) : (
            <>
              <span aria-hidden="true" className={`font-display text-[40px] leading-[0.9] font-extrabold tracking-[-2px] text-ink ${big ? "lg:text-[88px]" : "lg:text-[52px]"}`}>{days}</span>
              <span aria-hidden="true" className="text-[14px] lg:text-[15px]">{days === 1 ? "day left" : "days left"}</span>
            </>
          )}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:gap-[10px]">
        <Field label={exam?.dateKind === "canvas-due" ? "Due" : "Date"} field={exam?.date ?? null} />
        {second === "covers" ? <Field label="Covers" field={exam?.topics ?? null} /> : <Field label="Room" field={exam?.location ?? null} />}
      </div>
      {coverageNote ? (
        <p data-coverage="unknown" className="m-0 text-[14px] leading-snug text-ink">
          {coverageNote}
        </p>
      ) : null}
      {exam && quote ? (
        <SourceLabel tone="paper">
          <span data-exam-quote="">“{quote}”</span>
        </SourceLabel>
      ) : exam ? (
        <>
          {/* One source line; the rest behind a Sources toggle (fix 3). */}
          {lead ? (
            <SourceLabel tone="paper" link={lead.field.source.link}>
              From {lead.field.source.label}
            </SourceLabel>
          ) : null}
          {studyHref ? (
            <Link href={studyHref} data-study-entry="" className="btn btn-tertiary -ml-2 w-fit">
              Study with the tutor
            </Link>
          ) : null}
          <details data-sources-toggle="" className="group">
            <summary className="btn btn-tertiary -ml-2 w-fit list-none marker:hidden [&::-webkit-details-marker]:hidden">
              Sources
              <Chevron size={16} className="transition-transform duration-150 group-open:rotate-180" />
            </summary>
            <div aria-label="Sources" role="group" className="flex flex-col">
              {exam.sources.map((s) => <SourceRow key={s.label} label={s.label} field={s.field} />)}
            </div>
          </details>
        </>
      ) : (
        <SourceLabel tone="paper">No exams found in the course&apos;s syllabus, announcements or Canvas pages.</SourceLabel>
      )}
    </section>
  );
}
