// The live demo tutor, as a function of its dependencies (so tests run it with a fake model, store and clock).
// app/api/demo/tutor/route.ts wires the real ones.
//
//   - Runs in the deployed demo. The model key is REWIND_DEMO_ANTHROPIC_API_KEY, read only by lib/demo/tutor-llm.ts;
//     without it every call answers {"t":"fallback"} at once and the page plays a saved reply.
//   - The client sends { questionId, message, request, marked, history }: no prompt, no course text. The question,
//     its quote, the clip's lines and the slide come from the demo bundle by id (demo course only; unknown id = 404).
//   - Demo = practice only (no graded work). The answer is shown only once the student has marked one, like the UI.
//   - Limits (lib/demo/tutor-limits.ts) are checked before any model call; any refusal sends the page to a saved reply.
//     The real ones are per IP (minute, day; Vercel's own header, IPv6 as a /64), per day (calls, dollars) and the Console
//     limit; the 20 per visitor (a cookie) is advisory, since a request without the cookie gets a fresh id.
//   - Hint credit and "this is the tutor's turn" are the server's: tutor turns in the history count only with a valid
//     signature, and hints are counted per visitor and question in the counter store.
//   - "similar" (a new question on the same idea, lib/tutor/similar.ts) goes through the same limits and the same
//     model; a question that fails its checks (new values, a word-for-word source) or any error plays a saved one.
//   - Nothing the student wrote, no prompt and no reply is logged: only fixed status tags.

import { createHash, randomBytes } from "node:crypto";
import { tutorPrompt, type SimilarJSON, type TutorRequest } from "../prompts/tutor.ts";
import type { ChoiceLabel } from "../schema.ts";
import { cleanHistory } from "../tutor/history.ts";
import { inputOf, refusal, tutorReply, type Generate, type TutorResult } from "../tutor/service.ts";
import { makeSigner, type Signer } from "../tutor/sign.ts";
import { liveSimilarPrompt, similarQuestion, similarTurnText, type SimilarCall, type SimilarResult } from "../tutor/similar.ts";
import type { DemoBundle } from "./bundle.ts";
import { actualMicro, DEMO_SIMILAR_MAX_TOKENS, estimateMicro, type DemoModel } from "./tutor-llm.ts";
import { checkLimits, hintKey, pinKey, settle, type ExtraOp, type Refusal } from "./tutor-limits.ts";
import { StoreDown, type CounterStore } from "./tutor-store.ts";

export const COOKIE = "rw_demo_v";
export const MAX_BODY_CHARS = 8000;
export const MAX_MESSAGE = 500;
/**
 * One deadline for everything before the model call (reading the counters, checking and reserving the limits). The page
 * gives the live reply 8 s before it plays the saved one, so the server must be done deciding well inside that.
 */
export const PRE_MODEL_MS = 5000;

export interface DemoTutorDeps {
  /** The environment variable's value, or null when the key isn't set. */
  key: string | null;
  /** Makes the model call (real: lib/demo/tutor-llm.ts createDemoModel). Called only with a key. */
  model: (key: string) => DemoModel;
  store: CounterStore;
  bundle: () => Promise<DemoBundle | null>;
  now?: () => number;
  /** The pre-model deadline (default PRE_MODEL_MS); tests shorten it. */
  preModelMs?: number;
  /** True when served over https (the cookie gets Secure). */
  secure?: boolean;
  /** Fixed status tags only; never text. */
  log?: (tag: string) => void;
}

const line = (o: object) => new TextEncoder().encode(JSON.stringify(o) + "\n");
const ndjson = (events: object[], init: { status?: number; cookie?: string } = {}) =>
  new Response(events.map((e) => new TextDecoder().decode(line(e))).join(""), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...(init.cookie ? { "Set-Cookie": init.cookie } : {}) },
  });

/** The signer both the cookie and the reply signatures use: a secret derived from the demo key, the same on every serverless instance. */
export function demoSigner(key: string): Signer {
  const secret = createHash("sha256").update(`rewind-demo-tutor-v1|${key}`).digest();
  return makeSigner(() => secret);
}

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const LETTERS: ChoiceLabel[] = ["A", "B", "C", "D"];

/** The visitor id in a valid signed cookie, or a fresh one with the Set-Cookie that keeps it. */
export function visitorOf(req: Request, signer: Signer, secure: boolean): { id: string; setCookie?: string } {
  const raw = cookieOf(req, COOKIE);
  const dot = raw?.lastIndexOf(".") ?? -1;
  if (raw && dot > 0 && signer.verify(`visitor|${raw.slice(0, dot)}`, raw.slice(dot + 1))) return { id: raw.slice(0, dot) };
  const id = randomBytes(12).toString("base64url");
  const value = `${id}.${signer.sign(`visitor|${id}`)}`;
  return { id, setCookie: `${COOKIE}=${value}; Path=/api/demo; HttpOnly; SameSite=Lax; Max-Age=${7 * 86_400}${secure ? "; Secure" : ""}` };
}

/**
 * The client's address key: only what Vercel's edge sets. `x-vercel-forwarded-for` first, then `x-real-ip`; never an
 * `x-forwarded-for` entry, which a client can write. An IPv6 address counts as its /64 (one subscriber holds the
 * whole /64, so rotating inside it must not buy new allowances). Missing headers (local dev) share one bucket.
 */
export function clientIp(req: Request): string {
  const raw = req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
  return ipKey(raw);
}

export function ipKey(raw: string): string {
  const v = raw.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!v.includes(":")) return v;
  const mapped = v.match(/^(?:0:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = v.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
}

/** A hashed address key (the raw address is never stored). */
export function ipOf(req: Request, signer: Signer): string {
  return signer.sign(`ip|${clientIp(req)}`).slice(0, 16);
}

interface Body {
  questionId?: unknown;
  message?: unknown;
  request?: unknown;
  marked?: unknown;
  history?: unknown;
}

export async function handleDemoTutor(req: Request, deps: DemoTutorDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return new Response("Too large", { status: 413 });
  let body: Body;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Response("Bad request", { status: 400 });
    body = parsed as Body;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (typeof body.questionId !== "string") return new Response("Bad request", { status: 400 });
  const similar = body.request === "similar";
  const request: TutorRequest = body.request === "hint" || body.request === "answer" ? body.request : "reply";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
  if (request === "reply" && !message && !similar) return new Response("Bad request", { status: 400 });

  // The demo course only, by id.
  let bundle: DemoBundle | null;
  try {
    bundle = await deps.bundle();
  } catch {
    log("bundle-error");
    return new Response("Unavailable", { status: 503 });
  }
  const found = bundle?.sets.flatMap((s) => s.seed.questions.map((q) => ({ set: s, q }))).find((x) => x.q.id === body.questionId);
  if (!bundle || !found) return new Response("Not found", { status: 404 });

  // No key (until it is added in Vercel): the saved reply, at once.
  if (!deps.key) {
    log("no-key");
    return ndjson([{ t: "fallback", why: "no-key" }]);
  }
  const signer = demoSigner(deps.key);
  const visitor = visitorOf(req, signer, deps.secure ?? true);
  const cookie = visitor.setCookie;
  const history = cleanHistory(body.history, found.q.id, signer.replyOk);

  // Everything before the model is one phase with one deadline (and it stops if the client goes away). A store that is
  // slow, down or answering nonsense anywhere in it, or the deadline itself, means no live call: the saved reply.
  const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(deps.preModelMs ?? PRE_MODEL_MS)]);
  const within = <T,>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (deadline.aborted) return reject(new StoreDown("deadline"));
      const onAbort = () => reject(new StoreDown("deadline"));
      deadline.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => (deadline.removeEventListener("abort", onAbort), resolve(v)),
        (e) => (deadline.removeEventListener("abort", onAbort), reject(e)),
      );
    });
  const down = () => {
    log("store-down");
    return ndjson([{ t: "fallback", why: "store" }], { cookie });
  };

  const claimed: ChoiceLabel | null = typeof body.marked === "string" && /^[A-D]$/.test(body.marked) ? (body.marked as ChoiceLabel) : null;
  let pinned: number;
  let hintFloor: number;
  try {
    // In one read: the answer first reported for this visitor and question, and the hints already given. The check
    // happens in the browser, so the server can't witness it; it keeps the first answer it was told and takes no other.
    [pinned, hintFloor] = await within(deps.store.getMany([pinKey(visitor.id, found.q.id), hintKey(visitor.id, found.q.id)]));
  } catch {
    return down();
  }
  const marked: ChoiceLabel | null = pinned >= 1 && pinned <= 4 ? LETTERS[pinned - 1] : claimed;

  const call = { seed: found.set.seed, question: found.q, graded: false, request, message, history, marked };
  if (similar) return similarTurn(req, deps, { call: { ...call, graded: false, marked }, visitor: visitor.id, signer, cookie, claimed, pinned, within, down, deadline });
  const { mode, prompt } = tutorPrompt(inputOf({ ...call, hintFloor }));
  const pre = refusal({ ...call, hintFloor }, mode);
  if (pre) {
    log("refused");
    const r: TutorResult = { mode: "socratic", text: pre, grounded: [], rewritten: true, confirmed: false, hintsUsed: hintFloor };
    return streamEvents(doneEvents(r, found.q.id, signer), cookie);
  }
  const estimate = estimateMicro(prompt.length);

  // Counted before the model is asked: the limits, this hint and the first reported answer, in one request.
  const extra: ExtraOp[] = [];
  if (mode === "hint") extra.push({ key: hintKey(visitor.id, found.q.id), n: 1, ttlSec: 86_400, undo: true });
  if (claimed && !(pinned >= 1 && pinned <= 4)) extra.push({ key: pinKey(visitor.id, found.q.id), n: LETTERS.indexOf(claimed) + 1, ttlSec: 3600, undo: false });
  let refused: Refusal | null;
  try {
    refused = await within(checkLimits(deps.store, { visitor: visitor.id, ip: ipOf(req, signer), estimateMicro: estimate, now: now(), extra }));
  } catch {
    return down();
  }
  if (refused) {
    log(`limit-${refused}`);
    return ndjson([{ t: "fallback", why: refused }], { status: refused === "rate" ? 429 : 200, cookie });
  }
  // The deadline decides at the last moment too: a phase that finished late is no reason to start the model.
  if (deadline.aborted) return down();

  let usage = { in: 0, out: 0 };
  const model = deps.model(deps.key);
  const generate: Generate = async (p, schema) => {
    const r = await model(p, schema);
    usage = { in: r.inputTokens, out: r.outputTokens };
    return r.reply;
  };
  try {
    const r = await tutorReply({ ...call, hintFloor }, generate);
    if (usage.in || usage.out) await settle(deps.store, { estimateMicro: estimate, actualMicro: actualMicro(usage.in, usage.out), now: now() }).catch(() => {});
    log("ok");
    return streamEvents(doneEvents(r, found.q.id, signer), cookie);
  } catch (e) {
    // A refusal, a timeout, a 429 from Anthropic, a malformed reply: the saved reply. Only the error's class is logged.
    log(`model-error:${errorTag(e)}`);
    return ndjson([{ t: "fallback", why: "error" }], { cookie });
  }
}

/** A similar question: the same limits and model as a tutor turn; anything short of a checked question plays a saved one. */
async function similarTurn(
  req: Request,
  deps: DemoTutorDeps,
  o: {
    /** Demo = practice: graded is always false here. */
    call: SimilarCall;
    visitor: string;
    signer: Signer;
    cookie?: string;
    claimed: ChoiceLabel | null;
    pinned: number;
    within: <T>(p: Promise<T>) => Promise<T>;
    down: () => Response;
    deadline: AbortSignal;
  },
): Promise<Response> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const { call, signer, cookie } = o;
  // Two calls at most (one retry), so the reservation covers both; settle trues it up.
  const estimate = 2 * estimateMicro(liveSimilarPrompt(call).length + 200, DEMO_SIMILAR_MAX_TOKENS);
  const extra: ExtraOp[] = [];
  if (o.claimed && !(o.pinned >= 1 && o.pinned <= 4)) extra.push({ key: pinKey(o.visitor, call.question.id), n: LETTERS.indexOf(o.claimed) + 1, ttlSec: 3600, undo: false });
  let refused: Refusal | null;
  try {
    refused = await o.within(checkLimits(deps.store, { visitor: o.visitor, ip: ipOf(req, signer), estimateMicro: estimate, now: now(), extra }));
  } catch {
    return o.down();
  }
  if (refused) {
    log(`limit-${refused}`);
    return ndjson([{ t: "fallback", why: refused }], { status: refused === "rate" ? 429 : 200, cookie });
  }
  if (o.deadline.aborted) return o.down();
  let usage = { in: 0, out: 0 };
  const model = deps.model(deps.key!);
  let r: SimilarResult;
  try {
    // A retry only if the first answer came back within 3 s, so both fit before the page's 8 s first-token wait.
    r = await similarQuestion(
      call,
      async (p, schema) => {
        const res = await model(p, schema, { maxTokens: DEMO_SIMILAR_MAX_TOKENS });
        usage = { in: usage.in + res.inputTokens, out: usage.out + res.outputTokens };
        return res.reply as unknown as SimilarJSON;
      },
      { retryUntil: now() + 3000, now },
    );
  } catch (e) {
    log(`model-error:${errorTag(e)}`);
    return ndjson([{ t: "fallback", why: "error" }], { cookie });
  } finally {
    if (usage.in || usage.out) await settle(deps.store, { estimateMicro: estimate, actualMicro: actualMicro(usage.in, usage.out), now: now() }).catch(() => {});
  }
  if (!r.card) {
    log("similar-dropped");
    return ndjson([{ t: "fallback", why: "similar" }], { cookie });
  }
  log("ok");
  const said = similarTurnText(r.card);
  const events: object[] = (r.text.match(/\S+\s*/g) ?? []).map((d) => ({ t: "text", d }));
  events.push({ t: "done", mode: "socratic", grounded: [], rewritten: false, confirmed: false, similar: r.card, history: said, sig: signer.replySig(call.question.id, "reply", said) });
  return streamEvents(events, cookie);
}

/** The reply as events: its words, then the done event with its grounded claims and its signature. */
function doneEvents(r: TutorResult, questionId: string, signer: Signer): object[] {
  const kind = r.mode === "hint" ? "hint" : r.mode === "answer" ? "answer" : "reply";
  const events: object[] = (r.text.match(/\S+\s*/g) ?? []).map((d) => ({ t: "text", d }));
  events.push({ t: "done", mode: r.mode, grounded: r.grounded, rewritten: r.rewritten, confirmed: r.confirmed, hintsUsed: r.hintsUsed, sig: signer.replySig(questionId, kind, r.text) });
  return events;
}

/** The checked reply goes out word by word. */
function streamEvents(events: object[], cookie?: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        controller.enqueue(line(e));
        if ((e as { t?: string }).t === "text") await new Promise((r) => setTimeout(r, 18));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...(cookie ? { "Set-Cookie": cookie } : {}) } });
}

/** An error's class for the log: an HTTP status, or the error's name. Never its message (it can quote the request). */
export function errorTag(e: unknown): string {
  const status = (e as { status?: unknown })?.status;
  if (typeof status === "number") return String(status);
  const name = (e as { name?: unknown })?.name;
  return typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? name : "unknown";
}
