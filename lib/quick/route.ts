// POST /api/quick/generate, as a function of its dependencies (tests run it with a fake model, store and clock;
// app/api/quick/generate/route.ts wires the real ones). Quick build (beta), behind NEXT_PUBLIC_REWIND_QUICK_BUILD=1.
//
//   - The browser sends a batch of its own Canvas page text and Zoom lecture lines (lib/quick/schema.ts checks it
//     strictly); the route answers with up to 5 checked questions. NOTHING is stored here: no course text, no
//     question. The counters hold numbers under hashed ids. Logs carry fixed status tags only.
//   - The limits (lib/quick/limits.ts) are counted before the model is asked. If the counter store is unset on Vercel,
//     or set and down or slow, the route refuses and no model is called (the same fail-closed rule as the demo tutor).
//   - The model key is REWIND_DEMO_ANTHROPIC_API_KEY, read only by lib/demo/tutor-llm.ts (Claude Sonnet, no cache,
//     no log, no retries).

import { createHash, randomBytes } from "node:crypto";
import { clientIp, PRE_MODEL_MS } from "../demo/tutor-route.ts";
import { StoreDown, type CounterStore } from "../demo/tutor-store.ts";
import { makeSigner, type Signer } from "../tutor/sign.ts";
import { giveBack, reserveBatch } from "./limits.ts";
import { parseRequest } from "./schema.ts";
import { quickLLM, wantFor, writeQuestions, type QuickModel } from "./service.ts";
import { LIMITS, type QuickResponse } from "./types.ts";

export const COOKIE = "rw_quick_v";
/** The whole batch (up to 5 questions in parallel, each up to 3 attempts and checks) has this long. */
export const BATCH_MS = 55_000;

export interface QuickDeps {
  /** NEXT_PUBLIC_REWIND_QUICK_BUILD === "1". Off: the route is 404. */
  enabled: boolean;
  /** The model key, or null when none is set (the fake model needs none). */
  key: string | null;
  /** Makes the model call. Called only after every limit has passed. */
  model: (key: string) => QuickModel;
  store: CounterStore;
  now?: () => number;
  preModelMs?: number;
  batchMs?: number;
  secure?: boolean;
  /** Fixed status tags only; never text. */
  log?: (tag: string) => void;
}

const json = (body: object, init: { status?: number; cookie?: string } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(init.cookie ? { "Set-Cookie": init.cookie } : {}) },
  });

const signerOf = (key: string): Signer => {
  const secret = createHash("sha256").update(`rewind-quick-v1|${key}`).digest();
  return makeSigner(() => secret);
};

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function visitorOf(req: Request, signer: Signer, secure: boolean): { id: string; setCookie?: string } {
  const raw = cookieOf(req, COOKIE);
  const dot = raw?.lastIndexOf(".") ?? -1;
  if (raw && dot > 0 && signer.verify(`quick|${raw.slice(0, dot)}`, raw.slice(dot + 1))) return { id: raw.slice(0, dot) };
  const id = randomBytes(12).toString("base64url");
  return { id, setCookie: `${COOKIE}=${id}.${signer.sign(`quick|${id}`)}; Path=/api/quick; HttpOnly; SameSite=Lax; Max-Age=${86_400}${secure ? "; Secure" : ""}` };
}

const empty = (reason: string): QuickResponse => ({ questions: [], refused: [{ reason }] });

export async function handleQuickGenerate(req: Request, deps: QuickDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  if (!deps.enabled) return json({ error: "not found" }, { status: 404 });

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > LIMITS.bodyBytes) return json({ error: "too-large" }, { status: 413 });
  const raw = await req.text();
  const parsed = parseRequest(raw);
  if (!parsed.ok) {
    log("bad-request");
    return json({ error: parsed.why }, { status: parsed.why === "too-large" ? 413 : 400 });
  }
  const request = parsed.request;

  // No key (and no fake): nothing is counted and nothing is called.
  if (!deps.key) {
    log("no-key");
    return json({ error: "not-configured", ...empty("not-configured") }, { status: 503 });
  }
  const signer = signerOf(deps.key);
  const visitor = visitorOf(req, signer, deps.secure ?? true);
  const cookie = visitor.setCookie;
  const ip = signer.sign(`ip|${clientIp(req)}`).slice(0, 16);

  const want = wantFor(request, LIMITS.perBatch);
  if (want === 0) return json(empty("too-short"), { cookie });

  // Everything before the model is one phase with one deadline. A store that is slow, down or answering nonsense, or the
  // deadline itself, means no call.
  const pre = AbortSignal.any([req.signal, AbortSignal.timeout(deps.preModelMs ?? PRE_MODEL_MS)]);
  const within = <T,>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (pre.aborted) return reject(new StoreDown("deadline"));
      const onAbort = () => reject(new StoreDown("deadline"));
      pre.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => (pre.removeEventListener("abort", onAbort), resolve(v)),
        (e) => (pre.removeEventListener("abort", onAbort), reject(e)),
      );
    });
  const unavailable = () => {
    log("store-down");
    return json({ error: "unavailable", ...empty("unavailable") }, { status: 503, cookie });
  };

  let granted: number;
  try {
    const r = await within(reserveBatch(deps.store, { visitor: visitor.id, ip, want, now: now() }));
    if ("refused" in r) {
      log(`limit-${r.refused}`);
      return json({ error: r.refused, ...empty(r.refused) }, { status: 429, cookie });
    }
    granted = r.granted;
  } catch {
    return unavailable();
  }
  // The deadline decides at the last moment too: a phase that finished late is no reason to start the model.
  if (pre.aborted) {
    await giveBack(deps.store, { visitor: visitor.id, ip, n: granted, now: now() });
    return unavailable();
  }

  const batch = AbortSignal.any([req.signal, AbortSignal.timeout(deps.batchMs ?? BATCH_MS)]);
  const llm = quickLLM({ model: deps.model(deps.key), store: deps.store, now, deadline: batch });
  let out: Awaited<ReturnType<typeof writeQuestions>>;
  try {
    out = await writeQuestions(request, { llm, count: granted });
  } catch {
    log("error");
    await giveBack(deps.store, { visitor: visitor.id, ip, n: granted, now: now() });
    return json({ error: "error", ...empty("error") }, { status: 502, cookie });
  }
  await giveBack(deps.store, { visitor: visitor.id, ip, n: granted - out.questions.length, now: now() });
  log(out.stopped ? `stopped-${out.stopped}` : "ok");
  return json({ questions: out.questions, refused: out.refused }, { cookie });
}
