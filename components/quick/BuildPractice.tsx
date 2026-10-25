"use client";

// Quick build (beta), on /extension: three steps, then the result.
//   1. Import: the files the extension downloaded (the course .json and lecture .transcript.json files) and the
//      course's PDFs (files or a whole folder; each pick adds to the last). PDFs are read in a Web Worker on this device.
//   2. Add lecture recordings (optional): transcripts exported with the extension, counted live.
//   3. Build: the chunks go in batches to /api/quick/generate; the questions are kept on this device only.
// What was found shows as chips ("14 pages · 13 PDFs · 0 recordings"); what was skipped is behind "Details".
// Recordings added after a build offer "Rebuild with recordings", so the questions get rewind moments.

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { buildPractice, outcomeOf, type Outcome, type Progress } from "@/lib/quick/client";
import { gradedPdfs, readFile, type ExportFiles } from "@/lib/quick/export";
import { peopleOf } from "@/lib/quick/graded";
import { courseMismatch, mismatchText } from "@/lib/quick/course-match";
import { readPdfs } from "@/lib/quick/pdf-client";
import { mergeTranscripts } from "@/lib/quick/recordings";
import { sourceLine } from "@/lib/quick/seed";
import { browserBanks, type QuickBank } from "@/lib/quick/store";
import { LIMITS, type QuickQuestion } from "@/lib/quick/types";
import type { Transcript } from "@/lib/schema";
import { browserUpcoming, canvasHostOf, UPCOMING_ON, upcomingOf } from "@/lib/quick/upcoming";
import { AddRecordings } from "./AddRecordings";
import { Upcoming } from "./Upcoming";

type Phase = "idle" | "reading" | "building" | "done";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
/** Office files the build can't read yet: named, so the student knows they weren't used. */
const NOT_READ = new Set(["docx", "pptx", "doc", "ppt"]);
/** The course when only PDFs were picked (no course export to name it). */
const NO_EXPORT = { code: "My course", name: "My course" };

/** The files picked so far: each pick adds to these, a file picked twice counts once. */
interface Picked extends ExportFiles {
  pdfs: NonNullable<ExportFiles["pdfs"]>;
  seen: string[];
  notRead: string[];
  failed: string[];
}

/** "your slides", "your course pages and lectures": where a bank's questions come from, in plain words. */
export function fromWhat(questions: QuickQuestion[]): string {
  const NAMES: Record<QuickQuestion["source"]["kind"], string> = { slide: "slides", document: "PDFs", page: "course pages", lecture: "lectures" };
  const kinds = [...new Set(questions.map((q) => NAMES[q.source.kind]))];
  const list = kinds.length <= 1 ? (kinds[0] ?? "course") : `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}`;
  return `your ${list}`;
}

type StepState = "done" | "current" | "upcoming" | "optional" | "skipped";
const TAG: Record<StepState, string> = { done: "Done", current: "Now", upcoming: "Next", optional: "Optional", skipped: "Skipped" };

/** One numbered step: its number (a check once done), its title, its state, and what to do in it. */
function Step({ n, title, state, children, data }: { n: number; title: string; state: StepState; children?: ReactNode; data: string }) {
  const id = useId();
  const active = state === "current" || state === "optional";
  return (
    <li
      {...{ [`data-quick-step-${data}`]: "" }}
      data-step-state={state}
      aria-labelledby={id}
      className={`flex flex-col gap-4 rounded-xl border px-4 py-4 sm:px-5 ${active ? "border-label/40 bg-deck-raised" : "border-deck-line/60 bg-transparent"}`}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`flex size-8 flex-none items-center justify-center rounded-full text-[15px] font-bold ${state === "done" ? "bg-label text-deck" : active ? "border-2 border-label text-label" : "border border-deck-line text-label-muted"}`}
        >
          {state === "done" ? "✓" : n}
        </span>
        <h3 id={id} className={`m-0 flex-1 font-display text-[18px] font-bold leading-tight ${state === "upcoming" ? "text-label-muted" : "text-label"}`}>
          {title}
        </h3>
        <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-bold ${state === "current" ? "bg-action text-ink" : "bg-deck-sunk text-label-muted"}`}>{TAG[state]}</span>
      </div>
      {children ? <div className="flex flex-col gap-3 sm:pl-11">{children}</div> : null}
    </li>
  );
}

/** A bar with what's happening under it, said plainly. */
function Bar({ label, pct, text, data }: { label: string; pct: number; text: string; data: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-quick-progress="" className="h-3 w-full overflow-hidden rounded-full bg-deck-sunk">
        <div className="h-full rounded-full bg-action transition-[width] duration-200 ease-out" style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>
      <p role="status" {...{ [data]: "" }} className="m-0 text-[15px] text-label-muted">
        {text}
      </p>
    </div>
  );
}

export function BuildPractice() {
  const [files, setFiles] = useState<Picked | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [bank, setBank] = useState<QuickBank | null>(null);
  // Transcripts the student exported with the extension ("Add lecture recordings"), unless they skipped the step.
  const [exported, setExported] = useState<Transcript[]>([]);
  const [recordingsSkipped, setRecordingsSkipped] = useState(false);
  // How many recordings the last build used: more since then offers "Rebuild with recordings".
  const [builtWith, setBuiltWith] = useState<number | null>(null);
  // "These files look like they're from COP3530, not MAP2302. Build anyway?": which mismatch the student said yes to.
  const [mismatchOk, setMismatchOk] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);

  // React has no prop for a folder picker; the attribute is set on the element.
  useEffect(() => {
    folder.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => {
    const banks = browserBanks();
    const sync = () => setBank(banks.list()[0] ?? null);
    sync();
    return banks.subscribe(sync);
  }, []);

  async function onPick(list: FileList | null, fromFolder = false) {
    if (!list?.length || phase === "reading" || phase === "building") return;
    const before = files;
    let course: ExportFiles["course"] | null = before?.course === NO_EXPORT ? null : (before?.course ?? null);
    const pages = [...(before?.pages ?? [])];
    const transcripts = [...(before?.transcripts ?? [])];
    const seen = new Set(before?.seen ?? []);
    const notRead = [...(before?.notRead ?? [])];
    // Names the export carries (the student's own): kept on this device to leave out their graded work, never sent.
    const people = new Set(before?.people ?? []);
    const pdfFiles: File[] = [];
    let bad = 0;
    for (const f of Array.from(list)) {
      const id = `${f.name}:${f.size}`;
      if (seen.has(id)) continue;
      const kind = ext(f.name);
      if (kind === "pdf") pdfFiles.push(f);
      else if (NOT_READ.has(kind)) notRead.push(f.name);
      else if (kind === "json") {
        try {
          const json = JSON.parse(await f.text());
          const got = readFile(json);
          if (got?.kind === "course") {
            course ??= got.course;
            pages.push(...got.pages);
            peopleOf(json).forEach((p) => people.add(p));
            // "Coming up": only each assignment's name, due date and link, kept on this device (lib/quick/upcoming.ts).
            if (UPCOMING_ON) {
              const store = browserUpcoming();
              store.write({ course: got.course, readAt: new Date().toISOString(), host: canvasHostOf(json), items: upcomingOf(json), exams: store.read(got.course.code)?.exams });
            }
          } else if (got?.kind === "transcript") transcripts.push(got.transcript);
          else bad++;
        } catch {
          bad++;
        }
      } else if (!fromFolder) bad++;
      seen.add(id);
    }
    setOutcome(null);
    let pdfs = before?.pdfs ?? [];
    let failed = before?.failed ?? [];
    if (pdfFiles.length) {
      setPhase("reading");
      setReading({ done: 0, total: pdfFiles.length });
      const got = await readPdfs(pdfFiles, (done) => setReading({ done, total: pdfFiles.length }));
      pdfs = [...pdfs, ...got.pdfs];
      failed = [...failed, ...got.failed];
      setReading(null);
    }
    setSkipped((n) => n + bad);
    setPhase("idle");
    const any = course || transcripts.length || pdfs.length || notRead.length || failed.length;
    setFiles(any ? { course: course ?? NO_EXPORT, pages, transcripts, pdfs, people: [...people], seen: [...seen], notRead, failed } : null);
  }

  const recordings = files ? (recordingsSkipped ? files.transcripts : mergeTranscripts(files.transcripts, exported)) : [];

  async function build() {
    if (!files) return;
    setPhase("building");
    setOutcome(null);
    setConfirmDelete(false);
    setProgress({ done: 0, total: 1, questions: 0 });
    const used = recordings;
    const result = await buildPractice({ files: { ...files, transcripts: used }, onProgress: setProgress });
    if (result.questions.length) {
      browserBanks().write({ course: files.course, builtAt: new Date().toISOString(), questions: result.questions });
      setBuiltWith(used.length);
    }
    setOutcome(outcomeOf(result));
    setPhase("done");
  }

  const mismatch = files && files.course !== NO_EXPORT ? courseMismatch(files.course.code, files.pdfs) : null;
  const mismatchKey = mismatch ? `${mismatch.found}/${mismatch.expected}` : null;
  const waitingOnMismatch = !!mismatch && mismatchOk !== mismatchKey;
  const busy = phase === "reading" || phase === "building";
  const canRebuild = !!bank && builtWith !== null && recordings.length > builtWith && !busy;

  // PDFs that look like graded work or submissions: never sent (lib/quick/graded.ts, applied again where chunks are made).
  const graded = files ? gradedPdfs(files.pdfs, files.people) : [];
  const imageOnly = files?.pdfs.reduce((n, f) => n + f.skipped, 0) ?? 0;
  const pdfPages = files?.pdfs.reduce((n, f) => n + f.pages.length, 0) ?? 0;
  const hasDetails = !!files && (pdfPages > 0 || imageOnly > 0 || files.failed.length > 0 || files.notRead.length > 0 || skipped > 0 || graded.length > 0);

  const importState: StepState = files ? "done" : "current";
  const recordingsState: StepState = !files ? "upcoming" : recordingsSkipped ? "skipped" : recordings.length ? "done" : "optional";
  const buildState: StepState = !files ? "upcoming" : bank && phase === "done" && !outcome?.failed ? "done" : "current";
  const buildPct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  return (
    <section data-quick-build="" aria-labelledby="quick-build-title" className="flex flex-col gap-5 rounded-xl border border-deck-line px-4 py-5 sm:px-6">
      <div className="flex flex-col gap-1">
        <h2 id="quick-build-title" className="m-0 font-display text-[22px] font-bold tracking-[-0.4px]">
          Build my practice <span className="text-[15px] font-bold text-label-muted">(beta)</span>
        </h2>
        <p className="m-0 text-[18px] leading-snug text-label-muted">
          Turn your own course into up to {LIMITS.questionsPerBuild} practice questions, each with the exact words it comes from.
        </p>
      </div>

      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        <Step n={1} title="Import your course" state={importState} data="import">
          <p className="m-0 text-[15px] leading-snug text-label-muted">The course file the extension downloaded, plus your slides and study guides as PDFs. Add more any time.</p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="btn btn-secondary btn-lg cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-label">
              Choose files
              <input
                ref={input}
                data-quick-files=""
                type="file"
                multiple
                accept=".json,.pdf,.docx,.pptx,application/json,application/pdf"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  void onPick(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <label className="btn btn-tertiary btn-lg cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-label">
              Choose a folder
              <input
                ref={folder}
                data-quick-folder=""
                type="file"
                multiple
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  void onPick(e.target.files, true);
                  e.target.value = "";
                }}
              />
            </label>
          </div>

          {reading ? <Bar label="Reading your PDFs" pct={Math.round((reading.done / Math.max(1, reading.total)) * 100)} text={`Reading PDFs ${reading.done} of ${reading.total}, on this device`} data="data-quick-reading" /> : null}

          {files ? (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-[15px] font-bold" data-quick-course="">
                {files.course.name}
              </p>
              <ul data-quick-found="" aria-label="What was found" className="m-0 flex list-none flex-wrap gap-2 p-0">
                {[plural(files.pages.length, "page"), plural(files.pdfs.length - graded.length, "PDF"), plural(recordings.length, "recording")].map((chip) => (
                  <li key={chip} className="rounded-full bg-deck-sunk px-3 py-1 text-[15px] font-bold text-label">
                    {chip}
                  </li>
                ))}
              </ul>
              {files.course !== NO_EXPORT && files.pdfs.length === 0 ? (
                <p role="status" data-quick-add-slides="" className="m-0 rounded-md border border-peach px-3 py-2 text-[15px] leading-snug text-label">
                  Your course file has your Canvas pages, not your slides. For questions on the material itself, add your lecture slides or notes as PDFs with Choose files.
                </p>
              ) : null}
              {graded.length ? (
                <p role="status" data-quick-graded="" className="m-0 text-[15px] text-peach">
                  Skipped {plural(graded.length, "file")} that look{graded.length === 1 ? "s" : ""} like graded work or submissions.
                </p>
              ) : null}
              {hasDetails ? (
                <details data-quick-details="" className="text-[15px] text-label-muted">
                  <summary className="flex min-h-11 cursor-pointer items-center font-bold text-label">Details</summary>
                  <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                    {pdfPages ? <li>{plural(pdfPages, "page")} of text in your PDFs.</li> : null}
                    {imageOnly ? (
                      <li data-quick-image-pages="">
                        {plural(imageOnly, "page")} with only pictures and no text {imageOnly === 1 ? "was" : "were"} skipped.
                      </li>
                    ) : null}
                    {files.notRead.length ? (
                      <li data-quick-not-read="">
                        Not read yet: {files.notRead.join(", ")}. Save {files.notRead.length === 1 ? "it" : "them"} as PDF to use {files.notRead.length === 1 ? "it" : "them"}.
                      </li>
                    ) : null}
                    {files.failed.length ? <li data-quick-failed="">Couldn&apos;t read: {files.failed.join(", ")}.</li> : null}
                    {skipped ? <li>{plural(skipped, "file")} skipped: not a Rewind export or a PDF.</li> : null}
                    {graded.length ? <li data-quick-graded-names="">Not used, as graded work or a submission: {graded.map((f) => f.deck).join(", ")}.</li> : null}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : skipped ? (
            <p role="alert" className="m-0 text-[15px] text-peach">
              Those files aren&apos;t Rewind exports or PDFs. Choose the course .json, the .transcript.json files, or your course&apos;s PDFs.
            </p>
          ) : null}
        </Step>

        <Step n={2} title="Add lecture recordings (optional)" state={recordingsState} data="recordings">
          {files && !recordingsSkipped && phase !== "building" ? (
            <AddRecordings
              onChange={setExported}
              onSkip={() => {
                setRecordingsSkipped(true);
                setExported([]);
              }}
            />
          ) : recordingsSkipped ? (
            <p className="m-0 text-[15px] text-label-muted">Skipped. Your slides and pages still make practice.</p>
          ) : null}
        </Step>

        <Step n={3} title="Build practice" state={buildState} data="build">
          {files ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                {canRebuild ? null : (
                  <button type="button" data-quick-build-button="" className="btn btn-secondary btn-lg" disabled={busy || waitingOnMismatch} onClick={() => void build()}>
                    {bank && phase === "done" ? "Build again" : "Build my practice"}
                  </button>
                )}
                {canRebuild ? (
                  <button type="button" data-quick-rebuild="" className="btn btn-secondary btn-lg" onClick={() => void build()}>
                    Rebuild with recordings
                  </button>
                ) : null}
              </div>
              {canRebuild ? (
                <p className="m-0 text-[15px] text-label-muted" data-quick-rebuild-note="">
                  {plural(recordings.length - (builtWith ?? 0), "new recording")}: rebuild so your questions get rewind moments. It counts toward today&apos;s {LIMITS.questionsPerBuild}.
                </p>
              ) : null}
              <p className="m-0 text-[13px] text-label-muted" data-quick-privacy="">
                Pick lecture notes and slides, not your graded work. Only what you pick is used. Files that look like graded work are skipped. Only the lecturer&apos;s lines are used, and names we recognise in them become &ldquo;a student&rdquo;..
              </p>
            </>
          ) : (
            <p className="m-0 text-[15px] text-label-muted">Import your course first.</p>
          )}

          {mismatch && waitingOnMismatch && phase !== "building" ? (
            <div role="alert" data-quick-mismatch="" className="flex flex-col gap-3 rounded-md border border-peach px-4 py-3">
              <p className="m-0 text-[15px] leading-snug">{mismatchText(mismatch)}</p>
              <div>
                <button
                  type="button"
                  data-quick-build-anyway=""
                  className="btn btn-secondary btn-lg"
                  onClick={() => {
                    setMismatchOk(mismatchKey);
                    void build();
                  }}
                >
                  Build anyway
                </button>
              </div>
            </div>
          ) : null}

          {(phase === "building" || phase === "done") && progress && !outcome?.failed ? (
            phase === "building" ? (
              <Bar label="Building your practice" pct={buildPct} text={`Writing questions… ${plural(progress.questions, "question")} so far`} data="data-quick-status" />
            ) : outcome?.status ? (
              <p role="status" data-quick-status="" className="m-0 text-[15px] text-label-muted">
                {outcome.status}
              </p>
            ) : null
          ) : null}

          {outcome?.alert ? (
            <p role="alert" data-quick-message="" data-quick-failed-build={outcome.failed ? "" : undefined} className="m-0 text-[15px] text-peach">
              {outcome.alert}
            </p>
          ) : null}
        </Step>
      </ol>

      {UPCOMING_ON && (files && files.course !== NO_EXPORT ? files.course.code : bank?.course.code) ? (
        <Upcoming course={files && files.course !== NO_EXPORT ? files.course.code : bank!.course.code} />
      ) : null}

      {bank && phase !== "building" ? (
        <div data-quick-bank="" className="flex flex-col gap-3 rounded-xl border border-label/40 bg-deck-raised px-4 py-4 sm:px-5">
          <p className="m-0 font-display text-[22px] font-bold leading-tight" data-quick-result="">
            {plural(bank.questions.length, "question")} from {fromWhat(bank.questions)}
          </p>
          {bank.questions[0] ? (
            <p className="m-0 text-[15px] text-label-muted" data-quick-first="">
              First up: {sourceLine(bank.questions[0].source)}
            </p>
          ) : null}
          <p className="m-0 text-[15px] text-label-muted">{bank.course.name}. Saving is local to this browser.</p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link href={`/quick/practice?course=${encodeURIComponent(bank.course.code)}`} className="btn btn-primary btn-lg px-8" data-quick-practice-link="">
              Start practicing
            </Link>
            {confirmDelete ? null : (
              <button type="button" data-quick-delete="" className="min-h-11 px-1 text-[15px] font-bold text-peach hover:underline focus-visible:underline" onClick={() => setConfirmDelete(true)}>
                Delete these questions
              </button>
            )}
          </div>
          {confirmDelete ? (
            <div role="alertdialog" aria-label="Delete these questions?" data-quick-delete-confirm="" className="flex flex-col gap-3 rounded-md border border-deck-line px-4 py-3">
              <p className="m-0 text-[15px]">Delete {plural(bank.questions.length, "question")} from this browser? This can&apos;t be undone.</p>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  data-quick-delete-yes=""
                  className="btn btn-secondary btn-lg"
                  onClick={() => {
                    browserBanks().clear(bank.course.code);
                    setConfirmDelete(false);
                    setBuiltWith(null);
                  }}
                >
                  Delete
                </button>
                <button type="button" className="btn btn-tertiary btn-lg" onClick={() => setConfirmDelete(false)}>
                  Keep them
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
