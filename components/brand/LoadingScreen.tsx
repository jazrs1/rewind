// A loading screen with nothing to mirror yet: the wordmark in the middle of the deck. Screens whose
// skeleton keeps the real layout (the course home, the tape, the practice sheet) use their skeletons.

import type { HTMLAttributes } from "react";
import { Wordmark } from "./Wordmark";

export function LoadingScreen({ className = "", ...rest }: HTMLAttributes<HTMLElement> & { [data: `data-${string}`]: string }) {
  return (
    <main aria-busy="true" {...rest} className={`flex min-h-dvh flex-col items-center justify-center gap-3 bg-deck ${className}`}>
      <Wordmark className="opacity-80" />
      <p className="m-0 text-sm text-label-muted">Loading…</p>
    </main>
  );
}
