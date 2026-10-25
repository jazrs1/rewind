// Dev-only, timeboxed test: can a UF Zoom recording play inside our page when Chrome allows
// third-party cookies for localhost? The recording URL is read from private/ on the server,
// so it never lands in the repo or a production build.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LoadingScreen } from "@/components/brand/LoadingScreen";

async function recordingUrl(): Promise<string | null> {
  try {
    const first = (await readFile(join(process.cwd(), "private/spike/transcript.txt"), "utf8")).split("\n")[0].trim();
    return /^https:\/\/ufl\.zoom\.us\/rec\//.test(first) ? first : null;
  } catch {
    return null;
  }
}

export default function EmbedTestPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <Suspense fallback={<LoadingScreen />}>
      <EmbedTest />
    </Suspense>
  );
}

async function EmbedTest() {
  const url = await recordingUrl();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8">
      <h1 className="font-display text-3xl font-extrabold">Zoom embed test</h1>
      <ol className="list-decimal space-y-1 pl-5 text-label-muted">
        <li>Open chrome://settings/cookies, and under &quot;Allowed to use third-party cookies&quot; add http://localhost:3000.</li>
        <li>Make sure you&apos;re logged in to ufl.zoom.us in this Chrome profile, then reload this page.</li>
        <li>Does the recording load inside the frame below, and does it play with sound when you press play?</li>
      </ol>
      {url ? (
        <iframe
          src={url}
          title="Zoom recording embed test"
          allow="autoplay; fullscreen; encrypted-media"
          className="aspect-video w-full rounded-lg border-2 border-deck-line bg-black"
        />
      ) : (
        <p role="alert">No Zoom recording URL found on the first line of private/spike/transcript.txt.</p>
      )}
    </main>
  );
}
