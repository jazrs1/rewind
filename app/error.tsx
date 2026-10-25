"use client";

// Any screen that throws while rendering (a page, its data, a nested layout) shows this instead, inside the
// root layout, with a retry that re-fetches the segment.

import { ErrorState } from "@/components/states/ErrorState";

export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  return <ErrorState retry={retry} digest={digest} />;
}
