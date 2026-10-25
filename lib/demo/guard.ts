// Demo mode: what a deployed build (and `REWIND_DEMO=1 next dev`) runs as. It shows only the
// precomputed demo bundle (lib/demo/bundle.ts) and never reads private/. next.config.ts applies the
// same rule to its redirects.
//
// What a deployed build may call a model for: the live tutor in the public demo, and, only behind
// NEXT_PUBLIC_REWIND_QUICK_BUILD=1 (off by default), Quick build's POST /api/quick/generate
// (lib/quick/route.ts), which writes questions from the student's own course text with the same key, model
// and fail-closed counters, stores nothing, and is capped at 15 questions per visitor a day and its own $4 and 1,500 calls a day (rw:quick: counters, never
// the tutor's; together with the tutor's $3 under the key's $10).
// The tutor: POST /api/demo/tutor (app/api/demo/tutor/route.ts, lib/demo/tutor-route.ts), on Claude Sonnet, with
// the server variable REWIND_DEMO_ANTHROPIC_API_KEY (a separate "rewind-demo" key with its own $10
// Console limit) and no other key. Its code (lib/demo/tutor-llm.ts) never reads ANTHROPIC_API_KEY, so
// the main key need not (and must not) be in the deployed environment. It takes only a question id from
// the demo bundle, the student's message and signed tokens, and is limited per visitor, per IP and per
// day. Every other model call (lib/llm.ts, lib/gemini.ts, the dev tutor) still refuses in demo mode
// through assertNotDemo, and a build without the variable calls nothing: the demo plays saved replies.

type Env = Record<string, string | undefined>;

export function isDemoMode(env: Env = process.env): boolean {
  return env.REWIND_DEMO === "1" || env.NODE_ENV === "production" || !!env.VERCEL;
}

/** Throws in demo mode. Called before anything that would read private/ or reach a model API. */
export function assertNotDemo(what: string, env: Env = process.env): void {
  if (isDemoMode(env)) throw new Error(`${what} is off in demo mode (production builds use the precomputed demo bundle only).`);
}
