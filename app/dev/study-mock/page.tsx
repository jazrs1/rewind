// Dev only, never linked: the design mock for the full-screen study session (docs/briefs/tutor-study.md, Part 2).
// Static, invented data only (no course text, no model, no network). A 404 in any other build. Screenshots of it at
// 1440x900 and 390x844 are in docs/design/study-mock-*.png.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StudyMock } from "./StudyMock";
import { pageMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = pageMetadata("Study session mock", { robots: { index: false } });

export default function StudyMockPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <StudyMock />;
}
