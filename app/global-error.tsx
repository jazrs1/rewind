"use client";

// The root layout itself threw: this replaces it, so it brings its own <html>, <body> and styles.

import { ErrorState } from "@/components/states/ErrorState";
import "./globals.css";

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-deck font-sans text-label">
        <title>Rewind</title>
        <ErrorState retry={retry} digest={digest} />
      </body>
    </html>
  );
}
