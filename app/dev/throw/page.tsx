// Dev only, for the e2e test of the error boundary (e2e/resilience.spec.ts): a page whose data throws,
// so app/error.tsx shows. A 404 in any build.

import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { LoadingScreen } from "@/components/brand/LoadingScreen";

export default function ThrowPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Throws />
    </Suspense>
  );
}

async function Throws(): Promise<never> {
  await connection();
  throw new Error("Test-only error from /dev/throw (secret detail that must never be shown)");
}
