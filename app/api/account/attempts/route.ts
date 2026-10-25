// The signed-in student's own practice answers (lib/accounts/handler.ts). Off (404) unless
// NEXT_PUBLIC_REWIND_ACCOUNTS=1; the session is read only after that check.

import { getUserId } from "@/lib/accounts/auth";
import { accountsEnabled } from "@/lib/accounts/flag";
import { EXPECTED_USER_HEADER } from "@/lib/accounts/api";
import { handleAccountRequest } from "@/lib/accounts/handler";
import { MAX_BYTES } from "@/lib/accounts/schema";
import { accountKV } from "@/lib/accounts/server";

async function respond(req: Request): Promise<Response> {
  if (!accountsEnabled()) return Response.json({ error: "not found" }, { status: 404 });
  try {
    // The session first, then the size: a body is read only for the signed-in user the page expects, and only if it can fit.
    const userId = await getUserId();
    const expectedUser = req.headers.get(EXPECTED_USER_HEADER);
    let body: string | undefined;
    if (req.method === "POST" && userId && (!expectedUser || expectedUser === userId)) {
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return Response.json({ error: "body too large" }, { status: 413, headers: { "Cache-Control": "no-store" } });
      body = await req.text();
    }
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const res = await handleAccountRequest({ method: req.method, url: req.url, body, origin: req.headers.get("origin"), host, expectedUser }, userId, accountKV);
    return Response.json(res.json, { status: res.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    // handleAccountRequest answers storage failures itself; this is the session lookup or a bug. Status only.
    console.error(`account ${req.method} failed`);
    return Response.json({ error: "storage-unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export const GET = respond;
export const POST = respond;
export const DELETE = respond;
