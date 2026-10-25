"use client";

// A list that shows its first few items on the phone with a "Show N more" button (desktop shows them all), so
// the import check's long sections don't make the phone page thousands of pixels tall. `tail` sits between
// the list and the button (a row that belongs to the section but isn't one of its items).

import { Children, isValidElement, cloneElement, useState, type ReactElement, type ReactNode } from "react";

type Props = {
  label: string;
  keep: number;
  className: string;
  children: ReactNode;
  /** "Show 5 more {noun}". */
  noun: string;
  /** Paper sections (the exam card) use the paper link colour; deck sections use peach. */
  tone?: "deck" | "paper";
  tail?: ReactNode;
};

export function ShowAll({ label, keep, className, children, noun, tone = "deck", tail = null }: Props) {
  const [open, setOpen] = useState(false);
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<{ className?: string }>[];
  const hidden = Math.max(0, items.length - keep);
  return (
    <>
      <ul aria-label={label} className={className}>
        {items.map((el, i) => (i < keep || open ? el : cloneElement(el, { className: `${el.props.className ?? ""} max-lg:hidden` })))}
      </ul>
      {tail}
      {hidden ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`btn btn-tertiary -ml-2 self-start text-[15px] lg:hidden ${
            tone === "paper" ? "text-paper-link" : ""
          }`}
        >
          {open ? "Show fewer" : `Show ${hidden} more ${noun}`}
        </button>
      ) : null}
    </>
  );
}
