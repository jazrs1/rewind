import Link from "next/link";
import { Wordmark } from "@/components/brand/Wordmark";
import { Oval, RedPenCircle } from "@/components/paper/Oval";
import { IMPORT_DOCS, IMPORT_FULL } from "@/lib/accounts/flag";

// Landing: one focal point (the printed form, with the answer you get wrong and the pen that circles it),
// the title and one button beside it, the course's tapes along the bottom as cassettes.
// The demo course's three lectures (public/demo/course/course.json), each opening its practice set.
const tapes = [
  { topic: "Sorting", date: "Oct 13", lecture: "2026-10-13", shell: "bg-tape-1" },
  { topic: "Hash tables", date: "Oct 20", lecture: "2026-10-20", shell: "bg-tape-2" },
  { topic: "Graphs", date: "Oct 22", lecture: "2026-10-22", shell: "bg-tape-3" },
];

const choices = [
  { label: "A", text: "The old root", state: "wrong" as const },
  { label: "B", text: "The root's left child", state: "correct" as const },
  { label: "C", text: "The root's right child", state: "empty" as const },
  { label: "D", text: "A new leaf", state: "empty" as const },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-12 px-5 py-10 sm:px-8 lg:gap-16 lg:px-12 lg:py-16">
      {/* The wordmark, as in the app header; the hero's big "Rewind" stays the page's heading. */}
      <Wordmark className="-mb-6 lg:-mb-10" />
      <div className="flex flex-col gap-10 lg:grid lg:grid-cols-12 lg:items-center lg:gap-12">
        <header className="flex min-w-0 flex-col gap-5 lg:col-span-6">
          <h1 className="font-display text-[64px] leading-[0.9] font-extrabold tracking-[-2.5px] sm:text-[88px] lg:text-[112px] lg:tracking-[-4px]">Rewind</h1>
          <p className="max-w-md text-[20px] leading-snug text-label-muted">
            Practice quizzes made in your professor&apos;s style. Confused? Rewind to their explanation.
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
            <Link href="/demo/practice" className="btn btn-primary btn-lg px-8">
              Try the demo
            </Link>
            <span className="text-[15px] text-label-muted">A real UF course, used with permission. No login.</span>
          </div>
          {/* Quiet, under the demo: the extension that brings your own course in. */}
          <Link href={IMPORT_DOCS} title={IMPORT_FULL} aria-label={IMPORT_FULL} className="btn btn-tertiary -mx-2 self-start text-[15px]">
            Import your own course (beta)
          </Link>
        </header>

        <section aria-label="Sample question" className="paper-form relative flex min-w-0 max-w-full flex-col gap-4 rounded-md bg-paper px-6 pt-7 pb-10 text-ink lg:col-span-6 lg:px-9 lg:pr-14">
          <div className="border-b-[1.5px] border-print pb-2 text-[14px] text-print">Sample question</div>
          <p className="m-0 font-serif text-[24px] leading-snug font-semibold text-pretty lg:text-[28px]">1. After a single right rotation at the root, which node becomes the new root?</p>
          <ul className="m-0 flex list-none flex-col p-0">
            {choices.map((c) => (
              <li key={c.label} className="flex items-center gap-4 border-b border-paper-rule py-3 last:border-0">
                <span className="relative flex flex-none">
                  <Oval letter={c.label} state={c.state} size="responsive" />
                  {c.state === "wrong" ? <RedPenCircle size="responsive" variant={1} /> : null}
                </span>
                <span className={`font-serif text-[19px] lg:text-xl ${c.state === "correct" ? "font-semibold" : ""}`}>{c.text}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <nav aria-label="Demo lectures" className="flex flex-wrap gap-4">
        {tapes.map((t) => (
          <Link key={t.lecture} href={`/demo/practice/${t.lecture}`} className={`cassette ${t.shell} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-label`}>
            {/* Two set lines on the label; the link reads "Sorting · Oct 13". */}
            <span className="cassette-label font-sans text-[15px] leading-tight font-bold text-ink">
              <span className="block">{t.topic}</span>
              <span className="sr-only"> · </span>
              <span className="block">{t.date}</span>
            </span>
          </Link>
        ))}
      </nav>
    </main>
  );
}
