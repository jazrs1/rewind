// POST /api/ask: one model step of an Ask turn, in dev (local course data; the page runs the tools). The request
// carries only the student's words, the conversation so far and this turn's tool results; the prompt is here
// (lib/prompts/ask.ts), the call is Claude Sonnet through lib/llm.ts with its disk cache off, and the checks are
// lib/ask/service.ts. Nothing is stored: no cache, no text logged (lib/llm.ts logs token counts only).
// Streamed as newline-delimited JSON:  {"t":"tools","calls":[...]}  or  {"t":"text","d":"..."}… {"t":"done","claims":[...]}.

import { askStep, cleanAskInput, type AskGenerate } from "@/lib/ask/service";
import { fakeAsk } from "@/lib/ask/fake";
import { isDemoMode } from "@/lib/demo/guard";
import { generateJSON, LLM_MODELS } from "@/lib/llm";
import { ASK_MAX_TOKENS, type AskReplyJSON } from "@/lib/prompts/ask";
import { fakeLlmOn } from "@/lib/tutor/fake";
import { allowCall } from "@/lib/tutor/limit";

const MAX_BODY = 40_000;
const line = (o: object) => JSON.stringify(o) + "\n";

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return new Response("Not found", { status: 404 });
  // JSON only: a cross-origin page can't send this without a CORS preflight, which this route never answers, so a
  // site open in another tab can't make the dev server spend on the model.
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return new Response("Unsupported media type", { status: 415 });
  if (!allowCall()) return new Response("Too many requests", { status: 429, headers: { "Retry-After": "60" } });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return new Response("Too large", { status: 413 });
  let input;
  try {
    input = cleanAskInput(JSON.parse(raw));
  } catch {
    input = null;
  }
  if (!input) return new Response("Bad request", { status: 400 });
  const generate: AskGenerate = fakeLlmOn()
    ? fakeAsk()
    : (prompt, schema) => generateJSON<AskReplyJSON>(LLM_MODELS.tutor, prompt, schema, { maxTokens: ASK_MAX_TOKENS, effort: "low", cache: false });
  const step = input;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        const r = await askStep(step, generate);
        if (r.kind === "tools") controller.enqueue(enc.encode(line({ t: "tools", calls: r.calls })));
        else {
          for (const d of r.text.match(/\S+\s*/g) ?? []) {
            controller.enqueue(enc.encode(line({ t: "text", d })));
            await new Promise((res) => setTimeout(res, fakeLlmOn() ? 12 : 8));
          }
          controller.enqueue(enc.encode(line({ t: "done", claims: r.claims })));
        }
      } catch (e) {
        // Nothing from the course or the key is put in the message.
        controller.enqueue(enc.encode(line({ t: "error", m: e instanceof Error && e.name === "SpendCapError" ? "The assistant is paused: the model budget is used up." : "The assistant couldn't answer just now. Try again." })));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
