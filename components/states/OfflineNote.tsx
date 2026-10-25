"use client";

// A small "You're offline" note on every screen while the browser has no network. It sits in the page's
// flow above everything else, so it never covers a heading, a link or the demo label (a floating pill did).
// Online (and on the server) it is an empty hidden element.

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function OfflineNote() {
  const offline = useSyncExternalStore(
    subscribe,
    () => !navigator.onLine,
    () => false,
  );
  return (
    <p
      role="status"
      data-offline-note=""
      className={`mx-auto my-2 w-max max-w-[calc(100%-2rem)] flex-none rounded-full bg-deck-raised px-4 py-1.5 text-center text-[13px] text-label ${offline ? "" : "hidden"}`}
    >
      {offline ? "You're offline. What's already loaded still works." : null}
    </p>
  );
}
