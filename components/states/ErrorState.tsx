"use client";

// What a route's error boundary shows (app/error.tsx, app/global-error.tsx): what happened in plain words
// and a way to try again. Never the error's message or stack: those stay in the server log (digest).

import { HomeLink } from "./HomeLink";

export function ErrorState({ retry, digest }: { retry: () => void; digest?: string }) {
  return (
    <main role="alert" data-error-state="" className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-3 px-5">
      <h1 className="m-0 font-display text-3xl font-extrabold">This page didn&apos;t load</h1>
      <p className="m-0 text-label-muted">
        Something went wrong on our side. Your practice answers are saved in this browser, so nothing is lost. Try again, or start over from the home page.
      </p>
      <div className="flex flex-wrap items-center gap-4 pt-2">
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex min-h-11 items-center rounded-md bg-action px-6 font-bold text-ink transition-transform duration-150 hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-peach"
        >
          Try again
        </button>
        <HomeLink />
      </div>
      {/* The reference is for whoever reads the server log: behind a small disclosure, not in the reader's way. */}
      {digest ? (
        <details className="text-[13px] text-label-faint">
          <summary className="inline-flex min-h-11 cursor-pointer items-center">Details</summary>
          <p className="m-0">Error reference: {digest}</p>
        </details>
      ) : null}
    </main>
  );
}
