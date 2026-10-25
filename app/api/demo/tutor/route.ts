// POST /api/demo/tutor: the live tutor in the public demo. The only route in the deployed app that calls a model, and
// it reads only REWIND_DEMO_ANTHROPIC_API_KEY (lib/demo/tutor-llm.ts). Without that variable it answers with the
// saved-reply fallback at once. Everything else (limits, ids, signatures, what is logged) is in lib/demo/tutor-route.ts.

import { readDemoBundle } from "@/lib/demo/bundle";
import { onceUnlessFailed } from "@/lib/demo/tutor-bundle";
import { createDemoModel, demoKey } from "@/lib/demo/tutor-llm";
import { handleDemoTutor } from "@/lib/demo/tutor-route";
import { defaultStore } from "@/lib/demo/tutor-store";

/** The bundle, read once; a read that fails isn't remembered, so the next call tries again. */
const loadBundle = onceUnlessFailed(() => readDemoBundle());

export async function POST(req: Request) {
  return handleDemoTutor(req, {
    key: demoKey(),
    model: createDemoModel,
    store: defaultStore(),
    bundle: loadBundle,
    secure: new URL(req.url).protocol === "https:",
    // Fixed status tags only. Never a message, a prompt or a reply.
    log: (tag) => console.info(`demo-tutor ${tag}`),
  });
}
