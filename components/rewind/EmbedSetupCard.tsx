"use client";

// Shown when the embedded Zoom player didn't load and the clip fell back to a Zoom tab:
// how to let the recording play inside Rewind (Chrome's third-party-cookie exception).
// One line until the student asks how, so it never pushes the player controls down.

import { useEffect, useState } from "react";

/** John's screenshot of the setting (public/setup/cardImage.png, taken in Brave); a labeled frame until it exists. */
const SCREENSHOT = "/setup/cardImage.png";

/** Brave keeps the same setting at brave://; it identifies itself with navigator.brave. */
function useSettingsScheme(): "chrome" | "brave" {
  const [scheme, setScheme] = useState<"chrome" | "brave">("chrome");
  useEffect(() => {
    const brave = (navigator as Navigator & { brave?: { isBrave(): Promise<boolean> } }).brave;
    brave?.isBrave().then((yes) => yes && setScheme("brave"), () => {});
  }, []);
  return scheme;
}

export function EmbedSetupCard({ origin }: { origin: string }) {
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState(true);
  const scheme = useSettingsScheme();
  if (hidden) return null;
  return (
    // Desktop only: phone browsers can't run the extension, so a phone never reaches this fallback.
    <aside aria-label="Play lectures inside Rewind" className="hidden flex-col gap-3 rounded-xl border-2 border-deck-line px-3.5 text-sm lg:flex">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <p className="text-label-muted">
          <span className="font-bold text-label">Playing in a Zoom tab.</span> It can play right here instead.
        </p>
        <span className="flex gap-4">
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="btn btn-tertiary">
            {open ? "Hide steps" : "Show me how"}
          </button>
          <button type="button" onClick={() => setHidden(true)} className="btn btn-tertiary">
            Not now
          </button>
        </span>
      </div>
      {open ? (
        <div className="flex flex-col gap-3 pb-2">
          <ol className="list-decimal space-y-1 pl-5 text-label-muted">
            <li>
              Open <span className="font-bold text-label">{scheme}://settings/cookies</span> in a new tab.
            </li>
            <li>
              Under &quot;Allowed to use third-party cookies&quot;, choose Add and enter <span className="font-bold text-label">{origin}</span>.
            </li>
            <li>Come back here and reload the page.</li>
          </ol>
          {shot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={SCREENSHOT}
              alt="Chrome's cookie settings with this site under Allowed to use third-party cookies"
              onError={() => setShot(false)}
              className="w-full max-w-md rounded-lg"
            />
          ) : (
            <div className="flex aspect-[16/5] max-w-md items-center justify-center rounded-lg border-2 border-deck-line bg-deck-raised text-xs text-label-muted">
              Screenshot of the setting goes here
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
