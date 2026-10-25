import type { Metadata } from "next";
import { DemoPlaceholder } from "@/components/demo/DemoPlaceholder";
import { demoMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = demoMetadata();

export default function DemoRadarPage() {
  return (
    <DemoPlaceholder title="Exam radar is coming in the demo">
      The moments the lecturer flags for the exam will be listed here, each one ready to play.
    </DemoPlaceholder>
  );
}
