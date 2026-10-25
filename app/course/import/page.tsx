// Import check (docs/design/DesktopImport.dc.html): what the course pipeline found, read from its report
// data (lib/import-check). The exams on a Scantron card (a filled oval: the date came from the course
// itself; an empty one: not found), the course materials by role with what needs a download, then the
// practice questions and the gaps (modules and exam topics with no material). The mockup's fix and
// build buttons have no feature behind them yet, so they're left out. Dev only, like /course.

import { isHandValue } from "@/components/type/HandValues";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { ShowAll } from "@/components/import/ShowAll";
import { SourceLabel } from "@/components/source/SourceLabel";
import { shortDate, timeAgo } from "@/lib/home/build";
import { pct, rowDetail, type ExamRow, type ImportCheck } from "@/lib/import-check/build";
import { loadLocalImportCheck } from "@/lib/import-check/local";
import { pageMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = pageMetadata("What the import found");

const LINK = "btn btn-tertiary";

/** Swatches per role, as in the mockup's material rows (DesktopImport lines 58-86). */
const SWATCH: Record<string, string> = { lecture: "bg-tape-1", review: "bg-paper", practice: "bg-tape-3", transcript: "bg-tape-blank", syllabus: "bg-tape-4" };
const ROLE_TITLE: Record<string, string> = { lecture: "Lecture slides", review: "Past exam reviews", practice: "Practice handouts", transcript: "Transcripts", syllabus: "Syllabus" };

export default function ImportCheckPage() {
  return (
    <Suspense fallback={<ImportSkeleton />}>
      <Check />
    </Suspense>
  );
}

function Header({ check, code }: { check: ImportCheck | null; code: string | null }) {
  // Only with data (after connection()): the skeleton has no clock.
  const imported = check ? timeAgo(check.course.importedAt, new Date().toISOString()) : null;
  return (
    <header className="flex flex-col gap-2">
      <Link href="/course" className={`${LINK} -ml-1 self-start px-1`}>
        ← Course home
      </Link>
      <div className="font-display text-[22px] font-extrabold tracking-[-0.5px]">Rewind</div>
      <h1 className="m-0 font-display text-[36px] leading-none font-extrabold tracking-[-1.2px] lg:text-[46px] lg:tracking-[-1.5px]">Here&apos;s what we found{code ? ` in ${code}` : ""}</h1>
      <p className="m-0 text-[15px] text-label-muted lg:text-[17px]">
        What the course pipeline read, and what it couldn&apos;t find. Nothing here is guessed.
        {check ? (
          // Phone: two set lines, so "10 hours ago" vs "9 hours ago" never changes the wrap (and the skeleton
          // can hold the same two lines). Desktop: one line.
          <span className="block text-[14px] lg:text-[15px]">
            <span className="block lg:inline">{imported ? `Imported from Canvas ${imported}` : "Import time not found"}</span>
            <span className="hidden lg:inline"> · </span>
            <span className="block lg:inline">
              <span className="lg:hidden">{check.ranAt ? "Pipeline run" : "Pipeline run date not found"}</span>
              <span className="hidden lg:inline">{check.ranAt ? "pipeline run" : "pipeline run date not found"}</span>
              {check.ranAt ? ` ${shortDate(check.ranAt.slice(0, 10))}` : ""}
            </span>
          </span>
        ) : (
          // The skeleton keeps the import line's place (two lines on the phone), so nothing below it moves.
          <span aria-hidden="true" className="block text-[14px] lg:text-[15px]">
            <span className="block">
              <span className="skeleton inline-block h-[0.9em] w-56 max-w-full rounded-[3px] bg-deck-raised align-middle" />
            </span>
            <span className="block lg:hidden">
              <span className="skeleton inline-block h-[0.9em] w-32 max-w-full rounded-[3px] bg-deck-raised align-middle" />
            </span>
          </span>
        )}
      </p>
    </header>
  );
}

function Panel({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} data-section={id} className="flex flex-col gap-3 rounded-xl bg-deck-raised px-[18px] py-4">
      <h2 id={id} className="m-0 font-display text-[20px] font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Num({ n, label }: { n: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="font-display text-[30px] leading-none font-extrabold tabular-nums">{n}</span>
      <span className="text-[13px] text-label-muted">{label}</span>
    </div>
  );
}

function ExamRowItem({ e, shared, className = "" }: { e: ExamRow; shared: string | null; className?: string }) {
  const found = e.date.state === "found";
  return (
    <li data-exam={e.id} data-when={e.past ? "past" : e.day ? "upcoming" : "undated"} className={`flex min-h-[76px] items-start gap-[14px] border-b border-paper-rule py-3 lg:items-center ${className}`}>
      <span aria-hidden="true" className={`mt-1 h-[22px] w-10 flex-none rounded-full lg:mt-0 ${found ? "bg-graphite" : "box-border border-[1.5px] border-print"}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="font-serif text-[21px] leading-tight font-semibold">{e.name}</span>
        {e.date.state === "found" ? (
          <>
            <p className={`m-0 leading-tight font-bold text-graphite ${isHandValue(e.date.text) ? "font-hand text-[20px]" : "font-sans text-[15px]"}`}>
              <span className="sr-only">Date: </span>
              {e.date.text}
            </p>
            {/* On the phone the source stacks under the date, so it isn't squeezed into a narrow column. */}
            <SourceLabel tone="paper" link={e.date.link} className="max-lg:flex-col max-lg:items-start max-lg:gap-0 max-lg:[&>a]:-ml-2">
              {e.date.source}
            </SourceLabel>
          </>
        ) : (
          <p className="m-0 text-[14px] font-bold text-red-pen">
            <span className="sr-only">Date: </span>Date not found in the syllabus or announcements
          </p>
        )}
        <p data-missing="" className="m-0 text-[13px] text-print">
          {e.missing ? `Not found: ${e.missing}.${shared ? "" : ` ${e.searched}.`}` : "Every field found."}
        </p>
      </div>
    </li>
  );
}

function ExamsCard({ check }: { check: ImportCheck }) {
  const { upcoming, undated, past } = check.exams;
  const all = [...upcoming, ...undated, ...past];
  // Where it looked, once for the card when every exam was searched the same way (else on each row).
  const looked = new Set(all.map((e) => e.searched));
  const shared = looked.size === 1 ? [...looked][0] : null;
  return (
    <section aria-labelledby="exams" data-section="exams" className="relative flex flex-col gap-1 overflow-hidden rounded-md bg-paper pt-5 pr-[48px] pb-5 pl-[22px] text-ink">
      <div aria-hidden="true" className="absolute top-5 right-[14px] bottom-5 flex flex-col justify-between">
        {Array.from({ length: 14 }, (_, i) => (
          <div key={i} className="h-[6px] w-4 bg-ink" />
        ))}
      </div>
      <div className="mb-[6px] flex justify-between gap-3 border-b-[1.5px] border-print pb-2 text-[13px] text-print">
        <h2 id="exams" className="m-0 text-[13px] font-bold">
          Exams and quizzes
        </h2>
        <span className="text-right">Read from the syllabus and Canvas</span>
      </div>
      {all.length ? (
        <>
          {/* Coming up, the next one first; then the ones whose date wasn't found. */}
          <ShowAll label="Exams" keep={3} className="m-0 flex list-none flex-col p-0" noun="exams" tone="paper">
            {[...upcoming, ...undated].map((e) => (
              <ExamRowItem key={e.id} e={e} shared={shared} />
            ))}
          </ShowAll>
          {past.length ? (
            <details data-past="" className="border-b border-paper-rule">
              <summary className="flex min-h-[60px] cursor-pointer items-center gap-[14px] py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-print">
                <span aria-hidden="true" className="h-[22px] w-10 flex-none rounded-full bg-graphite" />
                <span className="flex flex-col">
                  <span className="text-[15px] font-bold">{past.length} already taken, kept for review</span>
                  <span className="text-[13px] text-print">Show them</span>
                </span>
              </summary>
              <ul aria-label="Already taken" className="m-0 flex list-none flex-col p-0 pb-2">
                {past.map((e) => (
                  <li key={e.id} data-exam={e.id} data-when="past" className="flex min-h-11 items-center justify-between gap-3 border-t border-paper-rule py-1 text-[14px]">
                    <span className="min-w-0 font-serif text-[16px] font-semibold">{e.name}</span>
                    <span className="flex-none text-print">{e.date.state === "found" ? e.date.text : "date not found"} · Already taken</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : (
        <p className="m-0 text-[15px] text-print">No exams found in the syllabus, announcements or Canvas pages.</p>
      )}
      <p className="m-0 mt-2 text-[14px] leading-normal text-print">
        A filled oval means the date came from the course itself: a quote, or a quiz&apos;s Canvas due date (labelled). Nothing here is guessed.{shared ? ` ${shared}.` : ""}
      </p>
    </section>
  );
}

async function Check() {
  await connection();
  const check = await loadLocalImportCheck(new Date().toISOString());
  if (!check) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-3 px-5">
        <h1 className="font-display text-3xl font-extrabold">No import found yet</h1>
        <p className="text-label-muted">Run the course pipeline (npm run pipeline) so its report is in private/pipeline/, then reload.</p>
      </main>
    );
  }
  const q = check.questions;
  return (
    <main className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-6 px-5 pt-[22px] pb-10 lg:max-w-[1280px] lg:px-16 lg:pt-9">
      <Header check={check} code={check.course.code} />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
        <div className="min-w-0 lg:flex-[0_0_470px]">
          <ExamsCard check={check} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-[10px]">
          <section aria-labelledby="materials" data-section="files" className="flex flex-col gap-[10px]">
            <h2 id="materials" className="m-0 mb-[2px] font-display text-[20px] font-bold">
              Course materials
            </h2>
            <ShowAll
              label="Files by role"
              keep={3}
              className="m-0 flex list-none flex-col gap-[10px] p-0"
              noun="file types"
              tail={
                <div data-role="recordings" className="flex min-h-[60px] items-center gap-4 rounded-[10px] bg-deck-raised px-4 py-2">
                  <span aria-hidden="true" className="h-[22px] w-[34px] flex-none rounded bg-tape-2" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[16px] font-bold">Lecture recordings</span>
                    <span className="text-[14px] text-label-muted">
                      {check.recordings === null ? "not found" : `${check.recordings} with transcripts`} · modules without one are blank tapes on the course home
                    </span>
                  </div>
                </div>
              }
            >
              {check.files.rows.map((r) => (
                <li key={r.role} data-role={r.role} className="flex min-h-[60px] items-center gap-4 rounded-[10px] bg-deck-raised px-4 py-2">
                  <span aria-hidden="true" className={`h-[22px] w-[34px] flex-none rounded ${SWATCH[r.role] ?? "bg-tape-blank"}`} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[16px] font-bold">{ROLE_TITLE[r.role] ?? r.label}</span>
                    <span className="text-[14px] text-label-muted">{rowDetail(r)}</span>
                  </div>
                </li>
              ))}
            </ShowAll>
            <ul aria-label="What that means" className="m-0 flex list-none flex-col gap-[10px] p-0">
              {check.files.lines.map((l) => (
                <li key={l} className="flex min-h-[52px] items-center gap-4 rounded-[10px] border-[1.5px] border-tape-blank px-4 py-2 text-[15px] text-label-muted">
                  {l}
                </li>
              ))}
            </ul>
            <p className="m-0 text-[14px] text-label-muted">
              From Canvas:{" "}
              {check.files.canvas.map((c, i) => (
                <span key={c.label}>
                  {i ? " · " : ""}
                  {c.label} {c.count === null ? "not found" : <b className="text-label">{c.count}</b>}
                </span>
              ))}
            </p>
            <SourceLabel tone="deck">From the pipeline&apos;s download report and the Canvas export</SourceLabel>
          </section>

          <div className="mt-[14px] flex flex-col gap-4">
            <Panel title="Practice questions" id="questions">
              {q ? (
                <>
                  {/* Two rows of numbers, so no stat wraps on its own at 1280: the tally, then what each question shows. */}
                  <div className="flex flex-wrap gap-x-6 gap-y-3">
                    <Num n={q.kept === null ? String(q.total) : String(q.kept)} label={q.kept === null ? "questions" : "kept"} />
                    <Num n={q.dropped === null ? "not found" : String(q.dropped)} label="dropped by the checks" />
                  </div>
                  <div className="grid grid-cols-3 gap-x-4 gap-y-3">
                    <Num n={pct(q.withSlide, q.total)} label={`with a slide (${q.withSlide})`} />
                    <Num n={pct(q.withDocument, q.total)} label={`with a document page (${q.withDocument})`} />
                    <Num n={pct(q.withClip, q.total)} label={`with a lecture clip (${q.withClip})`} />
                  </div>
                  {q.fallbacks.length ? (
                    <p className="m-0 text-[14px] text-label-muted">
                      Without a clip:{" "}
                      {q.fallbacks.map((f, i) => (
                        <span key={f.label}>
                          {i ? "; " : ""}
                          {f.count} {f.label}
                        </span>
                      ))}
                      .
                    </p>
                  ) : null}
                  <SourceLabel tone="deck">From the pipeline output and the generator&apos;s tally</SourceLabel>
                </>
              ) : (
                <p className="m-0 text-[15px] text-label-muted">Practice questions: not found.</p>
              )}
            </Panel>

            <Panel title="Gaps" id="gaps">
              {check.gaps.length ? (
                <ShowAll label="Gaps" keep={3} className="m-0 flex list-none flex-col p-0" noun="gaps">
                  {check.gaps.map((g) => (
                    <li key={`${g.kind}-${g.label}`} data-gap={g.kind} className="border-t border-tape-blank py-2 text-[15px] leading-snug first:border-t-0">
                      {g.text}
                    </li>
                  ))}
                </ShowAll>
              ) : (
                <p className="m-0 text-[15px]">No gaps: every module and exam topic has material and practice questions.</p>
              )}
              <p data-searched="" className="m-0 text-[13px] text-label-muted">
                {check.covered} modules and exam topics have both. {check.searched}: a file counts for a topic when its title names it or uses its
                acronym (DP, BST), it belongs to the module that lists the topic, or its text says the topic 3 or more times.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </main>
  );
}

const Bar = ({ className }: { className: string }) => <span aria-hidden="true" className={`skeleton block rounded-[3px] bg-deck-raised ${className}`} />;

function ImportSkeleton() {
  return (
    <main aria-busy="true" aria-label="Loading what the import found" className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-6 px-5 pt-[22px] pb-10 lg:max-w-[1280px] lg:px-16 lg:pt-9">
      <Header check={null} code={null} />
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <div className="skeleton-paper skeleton h-[760px] rounded-md bg-paper lg:flex-[0_0_470px]" />
        <div className="flex flex-1 flex-col gap-[10px]">
          <Bar className="h-7 w-48" />
          {Array.from({ length: 6 }, (_, i) => (
            <Bar key={i} className="h-[60px] rounded-[10px]" />
          ))}
        </div>
      </div>
    </main>
  );
}
