// POST /api/demo/ask: the Ask tab on the public demo. Like /api/demo/tutor it reads only REWIND_DEMO_ANTHROPIC_API_KEY
// (lib/demo/tutor-llm.ts), shares its counters and caps, and answers with the saved-reply fallback at once without the
// key. Everything else is in lib/demo/ask-route.ts.

import { handleDemoAsk } from "@/lib/demo/ask-route";
import { readDemoBundle, readDemoDeadlines } from "@/lib/demo/bundle";
import { onceUnlessFailed } from "@/lib/demo/tutor-bundle";
import { createDemoModel, demoKey } from "@/lib/demo/tutor-llm";
import { defaultStore } from "@/lib/demo/tutor-store";

const loadBundle = onceUnlessFailed(() => readDemoBundle());

export async function POST(req: Request) {
  return handleDemoAsk(req, {
    key: demoKey(),
    model: createDemoModel,
    store: defaultStore(),
    bundle: loadBundle,
    deadlines: () => readDemoDeadlines(),
    secure: new URL(req.url).protocol === "https:",
    // Fixed status tags only. Never a message, a prompt or a reply.
    log: (tag) => console.info(`demo-ask ${tag}`),
  });
}
