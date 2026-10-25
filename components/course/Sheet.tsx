"use client";

// A modal sheet: a bottom sheet on the phone, a centred panel on desktop (at most 640 px; `wide` for a player).
// Native <dialog> (focus trap, Escape, inert page); `open` drives showModal()/close(). Its content stays in the
// page while closed (hidden), so a stop's evidence is always there to find. The title and a 44 px × close sit on
// one row, with one meta line under it. It enters with a slight scale and fade (--dur-2); reduced motion: none.

import { useEffect, useRef, type ReactNode } from "react";

export function Sheet({
  open,
  onClose,
  label,
  wide = false,
  heading,
  meta,
  children,
}: {
  open: boolean;
  onClose(): void;
  label: string;
  wide?: boolean;
  /** The title, on the row with the × button. */
  heading?: ReactNode;
  /** One line under the title: "Oct 22 lecture · Stop 1 of 3 tonight". */
  meta?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        // A tap on the backdrop closes it.
        if (e.target === ref.current) onClose();
      }}
      className={`sheet-in m-0 mt-auto w-full max-w-none overflow-hidden rounded-t-2xl bg-deck-raised p-0 text-label backdrop:bg-black/55 lg:m-auto lg:rounded-2xl ${wide ? "lg:max-w-[1000px]" : "lg:max-w-[640px]"} max-h-[92dvh]`}
    >
      <div className="tape-scroll max-h-[92dvh] overflow-y-auto px-5 pt-2 pb-[var(--phone-bottom-room)] lg:px-6 lg:pt-4 lg:pb-6">
        <span aria-hidden="true" className="mx-auto mb-1 block h-1 w-10 rounded-full bg-tape-blank-label lg:hidden" />
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1.5">
            {heading ? <h2 className="m-0 font-display text-[22px] leading-tight font-extrabold lg:text-[26px]">{heading}</h2> : null}
            {meta ? <p className="m-0 text-[14px] text-label-muted tabular-nums">{meta}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="lift -mr-2 inline-flex size-11 flex-none items-center justify-center rounded-[10px] text-label-muted hover:text-label focus-visible:outline-2 focus-visible:outline-label"
          >
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
            <span className="sr-only">Close</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
