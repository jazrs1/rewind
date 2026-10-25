// Course home (docs/design/PhoneHome.dc.html at 390, DesktopHome.dc.html at 1280): the countdown to
// the next exam whose date is known (a nearer quiz with found topics first), that exam's fields each with
// its source or "not found", how practice starts (PracticeChooser: never silently when the exam's topics
// weren't found), and the lecture tapes, one per module, blank where there's no recording.
// Dev only, like /practice: it reads the local private/ data (lib/home/local.ts), never in a build.

import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ExamCard } from "@/components/home/ExamCard";
import { HomeFrame, HomeSkeleton } from "@/components/home/HomeSkeleton";
import { PracticeChooser } from "@/components/home/PracticeChooser";
import { TapeShelf } from "@/components/home/TapeShelf";
import { EmptyState } from "@/components/states/EmptyState";
import { timeAgo } from "@/lib/home/build";
import { loadLocalHome } from "@/lib/home/local";
import { pageMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = pageMetadata("Course");

const IMPORT_LINK = "btn btn-tertiary";

export default function CourseHomePage() {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  await connection();
  const now = new Date().toISOString();
  const home = await loadLocalHome(now);
  if (!home) {
    return (
      <EmptyState art="shelf" title="No course data yet" action={{ href: "/demo/practice", label: "Try the demo course" }}>
        Put the course&apos;s Canvas export, exams or lecture transcripts in private/, then reload.
      </EmptyState>
    );
  }
  const { course, countdown, quiz, coverage, tapes, latestRecorded } = home;
  // The nearest deadline leads (a nearer quiz, else the exam): the big card, left on desktop; the other beside it.
  const quizBlock = (className: string, idSuffix: string) =>
    quiz ? (
      <div data-quiz-block="" className={`flex-col gap-3 ${className}`}>
        <ExamCard kind="quiz" exam={quiz.exam} days={quiz.days} text={quiz.text} idSuffix={idSuffix} size="lead" studyHref={`/study?exam=${encodeURIComponent(quiz.exam.id)}`} />
        {quiz.practice?.ready.startsWith("Ready") ? (
          <div data-quiz-practice="" className="flex flex-col gap-[6px]">
            <Link href={quiz.practice.href} className="btn btn-primary btn-lg w-full">
              Practice for {quiz.exam.title}
            </Link>
            <span className="text-[13px] text-label-muted lg:min-h-11">{quiz.practice!.ready}</span>
          </div>
        ) : (
          <p className="m-0 text-[13px] text-label-muted">
            {quiz.practice ? quiz.practice.ready : `No module matches ${quiz.exam.title}'s topics, so there's no practice for it yet.`}
          </p>
        )}
      </div>
    ) : null;
  // The nearest deadline carries the page's one orange button: the quiz's, when its practice is ready.
  const quizPrimary = !!quiz?.practice?.ready.startsWith("Ready");
  const examTitle = countdown.exam && countdown.exam.title !== "Next exam" ? countdown.exam.title : null;
  const imported = timeAgo(course.importedAt, now);
  return (
    <HomeFrame
      nav={
        <Link
          href="/course"
          aria-current="page"
          className="flex flex-col gap-[2px] rounded-[10px] bg-deck-raised px-[14px] py-3 text-label no-underline focus-visible:outline-2 focus-visible:outline-label"
        >
          <span className="text-[16px] font-bold">{course.code}</span>
          <span data-countdown-text="" className="text-[13px] text-label-muted">
            {countdown.text}
          </span>
        </Link>
      }
    >
      <main className="mx-auto flex w-full max-w-xl min-w-0 flex-1 flex-col gap-4 px-5 pt-[22px] pb-6 lg:max-w-none lg:gap-6 lg:px-12 lg:py-9">
        {/* Desktop: the quiet import-check link sits at the header's right (the mockup's link spot, DesktopHome line 41). */}
        <header className="flex flex-col gap-1 lg:flex-row lg:items-end lg:justify-between lg:gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 font-display text-[50px] leading-[0.95] font-extrabold tracking-[-2px] lg:text-[60px] lg:tracking-[-2.5px]">{course.code}</h1>
            {course.name || imported ? (
              <p className="m-0 text-[15px] text-label-muted lg:text-[16px]">
                {course.name}
                {imported ? (
                  <span className="hidden lg:inline">
                    {course.name ? ", imported" : "Imported"} from Canvas {imported}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
          <Link href="/course/import" className={`hidden ${IMPORT_LINK} lg:inline-flex`}>
            What the import found
          </Link>
        </header>

        {/* The nearest deadline leads: the big card at the left (7 of 12 columns), the other beside it (5). */}
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-12 lg:items-stretch lg:gap-x-8 lg:gap-y-6">
          {quizBlock("flex lg:col-span-7", "lead")}
          <div className={`flex flex-col gap-4 ${quiz ? "lg:col-span-5" : "lg:col-span-7"}`}>
            <ExamCard
              kind="exam"
              exam={countdown.exam}
              days={countdown.kind === "days" ? countdown.days : null}
              text={countdown.text}
              coverageNote={countdown.exam && coverage.kind === "unknown" ? coverage.text : null}
              size={quiz ? "side" : "lead"}
              studyHref={countdown.exam ? `/study?exam=${encodeURIComponent(countdown.exam.id)}` : undefined}
            />
            <PracticeChooser demoted={quizPrimary} examTitle={examTitle ?? "the next exam"} coverage={coverage} modules={tapes.map((t) => ({ position: t.position, label: t.label }))} practice={home.practice} />
          </div>
        </div>

        <section aria-labelledby="tapes-title" className="flex min-w-0 flex-1 flex-col gap-4 lg:gap-[14px]">
          <TapeShelf tapes={tapes} latestRecorded={latestRecorded} examTitle={examTitle} dropKey={course.importedAt ? `${course.code}.${course.importedAt}` : null} />
          {tapes.some((t) => t.state === "blank") ? (
            <div className="mt-[6px] flex flex-col gap-2 rounded-xl bg-deck-raised px-[18px] py-4">
              <h3 className="m-0 font-display text-[18px] font-bold">Blank tapes fill in on their own</h3>
              <p className="m-0 max-w-[560px] text-[15px] leading-normal text-label-muted">
                Open a Zoom recording for this course with the extension on, and Rewind adds its transcript to the matching tape. Until then, questions on that topic point to the slides.
              </p>
            </div>
          ) : null}
        </section>
        {/* Phone: the same link, after everything else, so nothing above it moves. */}
        <Link href="/course/import" className={`inline-flex ${IMPORT_LINK} self-start lg:hidden`}>
          What the import found
        </Link>
      </main>
    </HomeFrame>
  );
}
