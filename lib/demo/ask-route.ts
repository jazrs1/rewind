// The Ask tab on the public demo (POST /api/demo/ask), as a function of its dependencies, like lib/demo/tutor-route.ts
// (and with its rules: the demo key only, the same counters and caps, KV fail-closed, the 5 s pre-model deadline, no
// logging of text). One model step per request; a turn is at most MAX_TOOL_ROUNDS tool rounds, so at most four calls,
// each counted against every limit.
//   - The demo course only (COP3530), with its deadlines file. Guide mode (graded work: a quiz or exam named in the
//     message) is decided here from that file, never taken from the request.
//   - The demo course only. The page runs the tools over the demo bundle, and so does this route: the results that go
//     in the prompt are the server's own, from the same bundle and the same code (lib/ask/tools.ts), so a visitor
//     can't put their own text in as a "tool result". get_questions keeps the page's picks (they're ranked by the
//     visitor's practice, which only the page has) but only as bundle ids, rebuilt from the bundle.
//   - Output cap 800 tokens. Any refusal, error or slow store sends the page to its saved reply.

import type { DemoBundle } from "./bundle.ts";
import { demoAskCourses } from "../ask/demo.ts";
import { questionsForModel } from "../ask/questions.ts";
import { gradedMention } from "../ask/guide.ts";
import { blockLeaks, unansweredOf } from "../ask/leak.ts";
import { ASK_SIG_ID, ASK_SIG_KIND, askStep, cleanAskInput, type AskStep } from "../ask/service.ts";
import { runTool } from "../ask/tools.ts";
import type { AskCourse, ToolRound } from "../ask/types.ts";
import { askPrompt, ASK_MAX_TOKENS, type AskInput, type AskReplyJSON } from "../prompts/ask.ts";
import { actualMicro, estimateMicro, type DemoModel } from "./tutor-llm.ts";
import { checkLimits, settle, type Refusal } from "./tutor-limits.ts";
import { demoSigner, ipOf, PRE_MODEL_MS, visitorOf } from "./tutor-route.ts";
import { StoreDown, type CounterStore } from "./tutor-store.ts";

export const ASK_MAX_BODY_CHARS = 16_000;
/** The longest prompt the demo sends (its instructions, the history and this turn's server-computed tool results). */
export const ASK_MAX_PROMPT_CHARS = 24_000;

export interface DemoAskDeps {
  key: string | null;
  model: (key: string) => DemoModel;
  store: CounterStore;
  bundle: () => Promise<DemoBundle | null>;
  /** public/demo/course/deadlines.json, parsed (null while it isn't in the bundle). */
  deadlines?: () => Promise<unknown>;
  now?: () => number;
  preModelMs?: number;
  /** The prompt cap (default ASK_MAX_PROMPT_CHARS); tests lower it. */
  maxPromptChars?: number;
  secure?: boolean;
  log?: (tag: string) => void;
}

const ndjson = (events: object[], init: { status?: number; cookie?: string } = {}) =>
  new Response(events.map((e) => JSON.stringify(e) + "\n").join(""), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...(init.cookie ? { "Set-Cookie": init.cookie } : {}) },
  });

/** The tool results this route puts in the prompt: its own, over the demo bundle. */
export function serverRounds(rounds: ToolRound[], courses: AskCourse[], now: number, studentText: string, openIds: string[] = []): ToolRound[] {
  const byId = new Map(courses.flatMap((c) => (c.bank?.seed.questions ?? []).map((q) => [q.id, { c, q }] as const)));
  return rounds.map((r, i) => ({
    calls: r.calls,
    results: r.calls.map((call, j) => {
      if (call.tool === "get_questions") {
        let ids: string[] = [];
        try {
          ids = ((JSON.parse(r.results[j]) as { questions?: { id?: unknown }[] }).questions ?? []).map((q) => q.id).filter((x): x is string => typeof x === "string");
        } catch {
          ids = [];
        }
        const picked = ids.flatMap((id) => {
          const hit = byId.get(id);
          return hit && !hit.c.bank!.gradedIds.includes(id) ? [{ courseId: hit.c.id, code: hit.c.code, shell: hit.c.shell, topic: hit.q.match.slide.deck, question: hit.q, priority: 0 }] : [];
        });
        // Nothing the page sent checks out: the server's own pick.
        if (!picked.length) return runTool(call, { courses, now, studentText, openIds }).result;
        return JSON.stringify(questionsForModel({ picked: picked.slice(0, 10), noBank: [], unknown: [], gradedLeftOut: 0 }));
      }
      // Open cards: the page's ids, re-resolved here against the bundle (an unknown id guards nothing).
      return runTool(call, { courses, now, studentText, idPrefix: `r${i + 1}c${j + 1}`, openIds }).result;
    }),
  }));
}

export async function handleDemoAsk(req: Request, deps: DemoAskDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const text = await req.text();
  if (text.length > ASK_MAX_BODY_CHARS) return new Response("Too large", { status: 413 });
  // Assistant turns count only with the signature this route put on them (as the tutor's replies): an unsigned or
  // forged one is student text.
  const signer = deps.key ? demoSigner(deps.key) : null;
  let parsed: AskInput | null;
  try {
    parsed = cleanAskInput(JSON.parse(text), signer ? signer.replyOk : () => false);
  } catch {
    parsed = null;
  }
  if (!parsed) return new Response("Bad request", { status: 400 });
  let bundle: DemoBundle | null;
  try {
    bundle = await deps.bundle();
  } catch {
    log("bundle-error");
    return new Response("Unavailable", { status: 503 });
  }
  if (!bundle) return new Response("Not found", { status: 404 });
  if (!deps.key || !signer) {
    log("no-key");
    return ndjson([{ t: "fallback", why: "no-key" }]);
  }
  const courses = demoAskCourses(bundle, deps.deadlines ? await deps.deadlines().catch(() => null) : null);
  // Guide mode is the server's call, from its own copy of the deadlines and the student's turns in this conversation:
  // whatever the request says, naming an open quiz or exam (now or earlier) is graded work, and not naming one isn't.
  const earlier = parsed.history.filter((t) => t.role === "student").map((t) => t.text);
  const named = gradedMention(parsed.message, courses, now(), earlier);
  const guide = named ? { title: named.title, code: named.code } : null;
  const visitor = visitorOf(req, signer, deps.secure ?? true);
  const cookie = visitor.setCookie;
  const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(deps.preModelMs ?? PRE_MODEL_MS)]);
  // The limits come first, reserved at the largest prompt allowed, before any tool work is done for the request.
  const maxPrompt = deps.maxPromptChars ?? ASK_MAX_PROMPT_CHARS;
  const estimate = estimateMicro(maxPrompt, ASK_MAX_TOKENS);
  let refused: Refusal | null;
  try {
    refused = await new Promise<Refusal | null>((resolve, reject) => {
      if (deadline.aborted) return reject(new StoreDown("deadline"));
      const onAbort = () => reject(new StoreDown("deadline"));
      deadline.addEventListener("abort", onAbort, { once: true });
      checkLimits(deps.store, { visitor: visitor.id, ip: ipOf(req, signer), estimateMicro: estimate, now: now() }).then(
        (v) => (deadline.removeEventListener("abort", onAbort), resolve(v)),
        (e) => (deadline.removeEventListener("abort", onAbort), reject(e)),
      );
    });
  } catch {
    log("store-down");
    return ndjson([{ t: "fallback", why: "store" }], { cookie });
  }
  if (refused) {
    log(`limit-${refused}`);
    return ndjson([{ t: "fallback", why: refused }], { status: refused === "rate" ? 429 : 200, cookie });
  }
  if (deadline.aborted) {
    log("store-down");
    return ndjson([{ t: "fallback", why: "store" }], { cookie });
  }
  const rounds = serverRounds(guide ? parsed.rounds.filter((r) => r.calls.every((c) => c.tool !== "get_questions")) : parsed.rounds, courses, now(), parsed.message, parsed.open);
  const input: AskInput = { ...parsed, guide, demo: true, rounds };
  const prompt = askPrompt(input);
  if (prompt.length > maxPrompt) {
    // Too long to send: nothing was spent, so the reservation goes back.
    await settle(deps.store, { estimateMicro: estimate, actualMicro: 0, now: now() }).catch(() => {});
    log("too-long");
    return ndjson([{ t: "fallback", why: "too-long" }], { cookie });
  }
  let usage = { in: 0, out: 0 };
  const model = deps.model(deps.key);
  let step: AskStep;
  try {
    step = await askStep(input, async (p, schema) => {
      const r = await model(p, schema, { maxTokens: ASK_MAX_TOKENS });
      usage = { in: r.inputTokens, out: r.outputTokens };
      return r.reply as unknown as AskReplyJSON;
    });
  } catch {
    log("model-error");
    return ndjson([{ t: "fallback", why: "error" }], { cookie });
  } finally {
    if (usage.in || usage.out) await settle(deps.store, { estimateMicro: estimate, actualMicro: actualMicro(usage.in, usage.out), now: now() }).catch(() => {});
  }
  if (step.kind === "tools") {
    log("ok");
    return ndjson([{ t: "tools", calls: step.calls }], { cookie });
  }
  // Never the answer to a card the student hasn't answered: an open one, one this turn shows, or a graded one.
  const shown = blockLeaks(step, unansweredOf(courses, parsed.open ?? [], rounds));
  log(shown.blocked ? "leak-blocked" : "ok");
  const sig = signer.replySig(ASK_SIG_ID, ASK_SIG_KIND, shown.text);
  return ndjson([...(shown.text.match(/\S+\s*/g) ?? []).map((d) => ({ t: "text", d })), { t: "done", claims: shown.claims, sig }], { cookie });
}
