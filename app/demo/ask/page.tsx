// The Ask tab on the demo course only: the bundle's lectures, slides and questions, the public demo route
// (/api/demo/ask: its key, the tutor's limits, saved replies for the example prompts) and the bundle's deadlines.json.
// COP3530 only. Static, like the other demo pages.

import type { Metadata } from "next";
import { AskChat } from "@/components/ask/AskChat";
import { DemoMissing } from "@/components/demo/DemoPlaceholder";
import { demoAskCourses } from "@/lib/ask/demo";
import { parseSaved } from "@/lib/ask/saved";
import { loadDemoAskSaved, loadDemoBundle, loadDemoDeadlines } from "@/lib/demo/load";

export const metadata: Metadata = { title: "Ask · Demo course · Rewind" };

export default async function DemoAskPage() {
  const [bundle, deadlines, savedFile] = await Promise.all([loadDemoBundle(), loadDemoDeadlines(), loadDemoAskSaved()]);
  if (!bundle) return <DemoMissing />;
  const saved = parseSaved(savedFile);
  return <AskChat courses={demoAskCourses(bundle, deadlines)} endpoint="/api/demo/ask" demo examples={saved.map((e) => e.prompt)} saved={saved} title="Ask" />;
}
