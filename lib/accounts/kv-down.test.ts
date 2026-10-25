// The account API when its storage (Upstash) is unset, unreachable, stopped (its budget spent), slow or answering nonsense:
// one clear answer, 503 {"error":"storage-unavailable"}, and no half-made change.
import { describe, expect, it } from "vitest";
import { handleAccountRequest, STORAGE_UNAVAILABLE } from "./handler.ts";
import { memoryKV, StorageUnavailable, upstashKV, type AccountKV } from "./kv.ts";
import { attempt, body, ON, URL_, write } from "./test-helpers.ts";

type Mode = "network error" | "timeout" | "http 500" | "http 503" | "http 403 budget" | "200 command error (stopped)" | "200 html" | "200 not an array" | "200 wrong length" | "200 non-objects" | "200 bad value";
const MODES: Mode[] = ["network error", "timeout", "http 500", "http 503", "http 403 budget", "200 command error (stopped)", "200 html", "200 not an array", "200 wrong length", "200 non-objects", "200 bad value"];

function fetchFake(mode: Mode): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const commands = JSON.parse(String(init.body)) as unknown[][];
    switch (mode) {
      case "network error":
        throw new TypeError("fetch failed");
      case "timeout":
        return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
      case "http 500":
        return new Response("boom", { status: 500 });
      case "http 503":
        return new Response("down", { status: 503 });
      case "http 403 budget":
        return new Response(JSON.stringify({ error: "ERR max budget exceeded, database stopped" }), { status: 403 });
      case "200 command error (stopped)":
        return new Response(JSON.stringify(commands.map(() => ({ error: "ERR max budget exceeded" }))), { status: 200 });
      case "200 html":
        return new Response("<html>Bad gateway</html>", { status: 200 });
      case "200 not an array":
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      case "200 wrong length":
        return new Response("[]", { status: 200 });
      case "200 non-objects":
        return new Response(JSON.stringify(commands.map(() => 7)), { status: 200 });
      case "200 bad value":
        return new Response(JSON.stringify(commands.map(() => ({ result: { nested: true } }))), { status: 200 });
    }
  }) as unknown as typeof fetch;
}

const POST = body([attempt()]);
const requests = [
  { name: "GET", req: { method: "GET", url: URL_ } },
  { name: "POST", req: write("POST", URL_, POST) },
  { name: "DELETE", req: write("DELETE", URL_) },
  { name: "DELETE ?course", req: write("DELETE", `${URL_}?course=COP3530`) },
];
const UNAVAILABLE = { status: 503, json: { error: STORAGE_UNAVAILABLE } };

/** Memory storage that records every write and can be made to fail on one operation. */
function recording(fail?: "list" | "merge" | "remove" | "removeAll" | "incr" | "mark") {
  const inner = memoryKV();
  const writes: string[] = [];
  const maybe = (op: string) => {
    if (fail === op) throw new StorageUnavailable("test");
  };
  const kv: AccountKV = {
    async list(k) {
      maybe("list");
      return inner.list(k);
    },
    async mark(k) {
      maybe("mark");
      return inner.mark(k);
    },
    async merge(k, a, max) {
      maybe("merge");
      writes.push("merge");
      return inner.merge(k, a, max);
    },
    async remove(k, ids) {
      maybe("remove");
      writes.push("remove");
      return inner.remove(k, ids);
    },
    async removeAll(k, ttl, cap) {
      maybe("removeAll");
      writes.push("removeAll");
      return inner.removeAll(k, ttl, cap);
    },
    async incr(key, ttl) {
      maybe("incr");
      return inner.incr(key, ttl);
    },
  };
  return { kv, inner, writes };
}

describe("the account API when Upstash can't be used", () => {
  for (const mode of MODES) {
    it(`${mode}: every request answers 503 storage-unavailable`, async () => {
      const kv = upstashKV("https://kv.example.test", "tok", fetchFake(mode), 25);
      for (const { name, req } of requests) {
        expect(await handleAccountRequest(req, "user_1", () => kv, ON), `${mode} ${name}`).toEqual(UNAVAILABLE);
      }
    });
  }

  it("storage that is unset, or whose factory throws, is the same clear answer", async () => {
    for (const { req } of requests) {
      expect(await handleAccountRequest(req, "user_1", () => null, ON)).toEqual(UNAVAILABLE);
      expect(
        await handleAccountRequest(req, "user_1", () => {
          throw new Error("misconfigured");
        }, ON),
      ).toEqual(UNAVAILABLE);
    }
  });

  it("a failing read changes nothing: no write of any kind reaches the store", async () => {
    for (const fail of ["incr", "list"] as const) {
      for (const { name, req } of requests.filter((r) => r.name !== "GET" && !(fail === "list" && r.name === "POST") && !(fail === "list" && r.name === "DELETE"))) {
        const { kv, writes } = recording(fail);
        expect((await handleAccountRequest(req, "user_1", () => kv, ON)).status, `${fail} ${name}`).toBe(503);
        expect(writes).toEqual([]);
      }
    }
  });

  it("a failing write leaves the stored attempts exactly as they were", async () => {
    const seed = recording();
    expect((await handleAccountRequest(write("POST", URL_, body([attempt({ id: "att-00000001" })])), "user_1", () => seed.kv, ON)).status).toBe(200);
    const keys = { hash: "rewind:v1:user:user_1:attempts", byTime: "rewind:v1:user:user_1:attempts-by-time", deletedMark: "rewind:v1:user:user_1:deleted-at" };
    const before = await seed.inner.list(keys);
    for (const [fail, req] of [
      ["merge", write("POST", URL_, body([attempt({ id: "att-00000002", answeredAt: "2026-10-21T15:00:00.000Z" })]))],
      ["removeAll", write("DELETE", URL_)],
      ["remove", write("DELETE", `${URL_}?course=COP3530`)],
    ] as const) {
      const failing: AccountKV = {
        list: (k) => seed.inner.list(k),
        mark: (k) => seed.inner.mark(k),
        incr: (k, t) => seed.inner.incr(k, t),
        merge: async () => {
          if (fail === "merge") throw new StorageUnavailable("test");
          return { attempts: [], overLimit: [] };
        },
        remove: async () => {
          if (fail === "remove") throw new StorageUnavailable("test");
        },
        removeAll: async () => {
          if (fail === "removeAll") throw new StorageUnavailable("test");
        },
      };
      expect(await handleAccountRequest(req, "user_1", () => failing, ON), fail).toEqual(UNAVAILABLE);
      expect(await seed.inner.list(keys)).toEqual(before);
    }
  });

  it("a bad request is refused before storage is touched (so a down store doesn't hide a 400)", async () => {
    let touched = 0;
    const spy: AccountKV = {
      list: async () => (touched++, []),
      mark: async () => (touched++, 0),
      merge: async () => (touched++, { attempts: [], overLimit: [] }),
      remove: async () => void touched++,
      removeAll: async () => void touched++,
      incr: async () => (touched++, 1),
    };
    expect((await handleAccountRequest(write("POST", URL_, "not json"), "user_1", () => spy, ON)).status).toBe(400);
    expect((await handleAccountRequest(write("PATCH", URL_), "user_1", () => spy, ON)).status).toBe(405);
    expect((await handleAccountRequest({ method: "POST", url: URL_, body: POST }, "user_1", () => spy, ON)).status).toBe(403);
    expect((await handleAccountRequest({ method: "GET", url: URL_ }, null, () => spy, ON)).status).toBe(401);
    expect((await handleAccountRequest({ method: "GET", url: URL_ }, "user_1", () => spy, {})).status).toBe(404);
    expect(touched).toBe(0);
  });

  it("a working store still works, and the error body carries nothing from the request", async () => {
    const { kv } = recording();
    expect((await handleAccountRequest(write("POST", URL_, POST), "user_1", () => kv, ON)).status).toBe(200);
    const down = await handleAccountRequest(write("POST", URL_, POST), "user_1", () => upstashKV("https://kv.example.test", "tok", fetchFake("http 500"), 25), ON);
    expect(JSON.stringify(down)).not.toContain("COP3530");
    expect(JSON.stringify(down)).not.toContain("tok");
  });
});
