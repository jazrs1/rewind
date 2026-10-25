"use client";

// The demo's app header (brief B §1): the wordmark and course on the left, the way around in the middle
// (Practice, with each lecture's set, the Course tape, and Ask), the account button on the right (accounts on
// only; the layout passes it in), and the bundle's permission note in a slim strip under the bar.
// Phone (under 1024 px): the wordmark and a Menu button; the tabs and the account live in a sheet.

import Link from "next/link";
import { Wordmark } from "@/components/brand/Wordmark";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

export interface DemoHeaderProps {
  course: string;
  /** The bundle's permission label. */
  label: string;
  /** Each lecture: its date ("Oct 13"), its short topic ("Sorting") and full deck title, when known. */
  sets: { id: string; label: string; topic?: string | null; deck?: string | null }[];
  defaultSet: string | null;
  /** The account button (accounts on), or nothing. */
  account?: ReactNode;
}

const WIDE = "(min-width: 1024px)";
const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeWide = (cb: () => void) => {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

const PRACTICE = "/demo/practice";
const TAPE = "/demo/tape";
const ASK = "/demo/ask";

function useCurrent(sets: DemoHeaderProps["sets"], defaultSet: string | null) {
  const path = usePathname();
  const onPractice = path === PRACTICE || path.startsWith(`${PRACTICE}/`);
  const currentSet = path === PRACTICE ? defaultSet : (sets.find((s) => path === `${PRACTICE}/${s.id}`)?.id ?? null);
  return { path, onPractice, onTape: path === TAPE, onAsk: path === ASK, currentSet };
}

export function DemoHeader({ course, label, sets, defaultSet, account }: DemoHeaderProps) {
  const { path, onPractice, onTape, onAsk, currentSet } = useCurrent(sets, defaultSet);
  const short = label.replace(/,\s*materials used with/i, ", used with");
  const hasNav = sets.length > 0;
  // The account control is mounted in one place only: the bar on desktop, the Menu sheet on a phone.
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => true);
  // The lecture tabs unroll out of Practice when it's opened (not when a page loads on it: they're already out) and
  // roll back up when it's left; reduced motion (or the hidden bar on a phone) swaps them instantly. "closing" keeps
  // them mounted, inert, until the roll-up ends.
  const [reel, setReel] = useState<{ on: boolean; phase: "still" | "opening" | "closing" }>({ on: onPractice, phase: "still" });
  if (reel.on !== onPractice) {
    const instant = !wide || window.matchMedia(REDUCED).matches;
    setReel({ on: onPractice, phase: instant ? "still" : onPractice ? "opening" : "closing" });
  }
  return (
    <header data-demo-header="" className="demo-header">
      <div className="demo-bar">
        <Link href="/" className="demo-brand">
          <Wordmark />
          <span data-brand-course="" className="demo-brand-course text-label-muted">{course}</span>
        </Link>

        {hasNav ? (
          <nav aria-label="Demo course" className="demo-tabs hidden lg:flex">
            <Link href={PRACTICE} aria-current={onPractice ? "page" : undefined} className="demo-tab">
              Practice
            </Link>
            {onPractice || reel.phase === "closing" ? (
              <span
                data-sets-reel={reel.phase}
                inert={reel.phase === "closing"}
                onAnimationEnd={(e) => e.target === e.currentTarget && setReel((r) => ({ ...r, phase: "still" }))}
                className="demo-sets-reel"
              >
                <span className="demo-sets">
                {sets.map((s, i) => (
                  <Link key={s.id} href={`${PRACTICE}/${s.id}`} aria-current={currentSet === s.id ? "page" : undefined} title={s.deck ?? undefined} style={{ "--i": i, "--j": sets.length - 1 - i } as CSSProperties} className="demo-set">
                    {s.topic ? (
                      <>
                        {s.topic}
                        <span className="demo-set-date">{"\u00a0· "}{s.label}</span>
                      </>
                    ) : (
                      s.label
                    )}
                  </Link>
                ))}
                </span>
              </span>
            ) : null}
            <Link href={TAPE} aria-current={onTape ? "page" : undefined} className="demo-tab">
              Course tape
            </Link>
            <Link href={ASK} aria-current={onAsk ? "page" : undefined} className="demo-tab">
              Ask
            </Link>
          </nav>
        ) : (
          <span className="hidden lg:block" />
        )}

        <div className="demo-right">
          {wide || !hasNav ? account : null}
          {hasNav ? <MenuSheet key={path} sets={sets} onPractice={onPractice} onTape={onTape} onAsk={onAsk} currentSet={currentSet} account={wide ? null : account} /> : null}
        </div>
      </div>
      <div className="demo-note-strip">
        <p role="note" data-demo-label="" className="demo-note">
          {/* "Demo course" is said here, not beside the wordmark (where it was cut off behind the tabs: John, Oct 25). A
              phone keeps it to one line by dropping "materials"; the full label is still the note's text. */}
          <span className={short === label ? "" : "sr-only lg:not-sr-only"}>{label}</span>
          {short === label ? null : (
            <span aria-hidden="true" className="lg:hidden">
              {short}
            </span>
          )}
        </p>
      </div>
    </header>
  );
}

/** Phone: the Menu button and its sheet (native modal dialog: the page behind is inert; Tab wraps; Esc closes). */
function MenuSheet({ sets, onPractice, onTape, onAsk, currentSet, account }: { sets: DemoHeaderProps["sets"]; onPractice: boolean; onTape: boolean; onAsk: boolean; currentSet: string | null; account?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      (d.querySelector<HTMLElement>("[aria-current=page]") ?? d.querySelector<HTMLElement>("a, button"))?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // A wider window has the tabs in the bar: the sheet goes away.
  useEffect(() => {
    if (!open) return;
    const wide = window.matchMedia("(min-width: 1024px)");
    const onChange = () => wide.matches && setOpen(false);
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => button.current?.focus());
  };

  // Keep Tab inside the sheet (showModal already makes the page inert; this also skips the browser's own UI).
  const trap = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Tab") return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)")];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <button ref={button} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="demo-icon-button lg:hidden">
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span className="sr-only">Menu</span>
      </button>
      <dialog
        ref={dialog}
        aria-label="Menu"
        onKeyDown={trap}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onClick={(e) => e.target === dialog.current && close()}
        className="demo-sheet"
      >
        <div className="demo-sheet-head">
          <Wordmark />
          <button type="button" onClick={close} className="demo-icon-button">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
            <span className="sr-only">Close menu</span>
          </button>
        </div>
        <nav aria-label="Demo course" className="demo-sheet-nav">
          <Link href={PRACTICE} aria-current={onPractice ? "page" : undefined} onClick={() => setOpen(false)} className="demo-row">
            Practice
          </Link>
          <ul className="demo-sheet-sets">
            {sets.map((s) => (
              <li key={s.id}>
                <Link href={`${PRACTICE}/${s.id}`} aria-current={currentSet === s.id ? "page" : undefined} onClick={() => setOpen(false)} className="demo-row demo-row-sub">
                  <span className="flex flex-col">
                    <span>
                      {s.topic ?? s.label}
                      {s.topic ? <span className="demo-set-date">{"\u00a0· "}{s.label}</span> : null}
                    </span>
                    {s.deck && s.deck !== s.topic ? <span className="demo-set-deck">{s.deck}</span> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Link href={TAPE} aria-current={onTape ? "page" : undefined} onClick={() => setOpen(false)} className="demo-row">
            Course tape
          </Link>
          <Link href={ASK} aria-current={onAsk ? "page" : undefined} onClick={() => setOpen(false)} className="demo-row">
            Ask
          </Link>
        </nav>
        {account ? <div className="demo-sheet-account">{account}</div> : null}
      </dialog>
    </>
  );
}
