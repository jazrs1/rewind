// POST /api/quick/generate: Quick build (beta), behind NEXT_PUBLIC_REWIND_QUICK_BUILD=1 (404 when off). Writes up to 5
// checked questions from a batch of the student's own course text and stores NOTHING. Everything (limits, ids, what is
// logged) is in lib/quick/route.ts. Its model key is REWIND_DEMO_ANTHROPIC_API_KEY, read only by lib/demo/tutor-llm.ts.

import { createDemoModel, demoKey } from "@/lib/demo/tutor-llm";
import { defaultStore } from "@/lib/demo/tutor-store";
import { fakeLlmOn } from "@/lib/tutor/fake";
import { fakeQuickModel } from "@/lib/quick/fake";
import { quickBuildOn } from "@/lib/quick/flag";
import { handleQuickGenerate } from "@/lib/quick/route";

export const maxDuration = 60;

export async function POST(req: Request) {
  const fake = fakeLlmOn();
  return handleQuickGenerate(req, {
    enabled: quickBuildOn(),
    key: fake ? "fake-quick-key" : demoKey(),
    model: fake ? () => fakeQuickModel() : createDemoModel,
    store: defaultStore(),
    secure: new URL(req.url).protocol === "https:",
    // Fixed status tags only. Never course text, a prompt or a question.
    log: (tag) => console.info(`quick-build ${tag}`),
  });
}
