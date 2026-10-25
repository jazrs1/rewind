// Any address with no page: the wordmark (back to the start), a blank cassette and the way out.

import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/brand/Wordmark";
import { EmptyState } from "@/components/states/EmptyState";
import { pageMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = pageMetadata("Page not found");

export default function NotFound() {
  return (
    <>
      <header className="absolute top-0 left-0 px-5 pt-3">
        <Link href="/" aria-label="Rewind, home" className="inline-flex min-h-11 items-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-label">
          <Wordmark />
        </Link>
      </header>
      <EmptyState art="cassette" title="This tape is blank" action={{ href: "/", label: "Back to the start" }}>
        There&apos;s no page at this address. The demo course is one tap away from the start.
      </EmptyState>
    </>
  );
}
