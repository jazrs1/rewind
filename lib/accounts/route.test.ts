// The account route reads a request's body only for a signed-in user, and only if its declared size fits:
// an anonymous or oversized POST costs no read and no storage call. Sign-in is mocked; no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/accounts/auth", () => ({ getUserId: async () => session.userId }));
vi.mock("@/lib/accounts/server", () => ({ accountKV: () => null }));

/** A POST whose body stream records whether anything pulled from it. */
function post(length: number, extra: Record<string, string> = {}) {
  const seen = { read: false };
  // highWaterMark 0: the stream pulls only when something reads it, not to fill a buffer up front.
  const stream = new ReadableStream(
    {
      pull(c) {
        seen.read = true;
        c.enqueue(new TextEncoder().encode('{"attempts":[]}'));
        c.close();
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request("http://rewind.test/api/account/attempts", {
    method: "POST",
    body: stream,
    headers: { "content-length": String(length), origin: "http://rewind.test", host: "rewind.test", ...extra },
    duplex: "half",
  } as RequestInit);
  return { req, seen };
}

describe("app/api/account/attempts/route.ts", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_REWIND_ACCOUNTS", "1"));
  afterEach(() => {
    vi.unstubAllEnvs();
    session.userId = null;
  });

  it("signed out: 401 without reading the body", async () => {
    const { POST } = await import("../../app/api/account/attempts/route.ts");
    const { req, seen } = post(15);
    expect((await POST(req)).status).toBe(401);
    expect(seen.read).toBe(false);
  });

  it("signed in with a body declared over the limit: 413 without reading it", async () => {
    session.userId = "user_a";
    const { POST } = await import("../../app/api/account/attempts/route.ts");
    const { req, seen } = post(10 * 1024 * 1024);
    expect((await POST(req)).status).toBe(413);
    expect(seen.read).toBe(false);
  });

  it("signed in with a body that fits: it is read (and storage, unset here, answers 503)", async () => {
    session.userId = "user_a";
    const { POST } = await import("../../app/api/account/attempts/route.ts");
    const { req, seen } = post(15);
    expect((await POST(req)).status).toBe(503);
    expect(seen.read).toBe(true);
  });

  it("signed in as someone other than the page expects (x-rewind-user): 409 without reading the body", async () => {
    session.userId = "user_b";
    const { POST } = await import("../../app/api/account/attempts/route.ts");
    const { req, seen } = post(15, { "x-rewind-user": "user_a" });
    expect((await POST(req)).status).toBe(409);
    expect(seen.read).toBe(false);
  });
});
