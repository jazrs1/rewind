// A stored value that is there but isn't what we wrote must never read as "empty" or be skipped: the account would look
// emptier than it is, and the next sync would build on that. And a storage URL that isn't https never gets the token.
import { describe, expect, it } from "vitest";
import { handleAccountRequest } from "./handler.ts";
import { StorageUnavailable, upstashKV } from "./kv.ts";
import { readStoredAttempts } from "./schema.ts";
import { attempt, body, ON, URL_, write } from "./test-helpers.ts";

const good = attempt();
// What HVALS (and the merge script's reply) can hold, and shouldn't.
const BAD_VALUES: unknown[] = [
  ["not json"],
  [""],
  ["{"],
  ["null"],
  ["42"],
  ['"text"'],
  ["{}"],
  [JSON.stringify({ ...good, id: "bad id with spaces" })],
  [JSON.stringify({ ...good, stem: "extra key" })],
  [JSON.stringify(good), "not json"],
  [1],
  [{ id: "x" }],
  "a string",
  { nope: true },
];

/** Upstash answering every command with `result`, and recording the command names it was sent. */
function upstashReturning(result: unknown) {
  const names: string[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    const commands = JSON.parse(String(init.body)) as string[][];
    names.push(...commands.map((c) => String(c[0])));
    // The merge script answers { ids over the limit, the hash's values }: the bad value goes where the values go.
    return new Response(JSON.stringify(commands.map((c) => ({ result: c[0] === "INCR" ? 1 : c[0] === "EXPIRE" ? 1 : c[0] === "EVAL" ? [[], result] : c[0] === "GET" ? null : result }))), { status: 200 });
  }) as unknown as typeof fetch;
  return { kv: upstashKV("https://kv.example.test", "tok", fetcher, 1000), names };
}

describe("readStoredAttempts", () => {
  it("a good list reads back; anything that isn't a list of good records throws, never []", () => {
    expect(readStoredAttempts([good])).toEqual([good]);
    expect(readStoredAttempts([])).toEqual([]);
    for (const bad of [null, undefined, "x", {}, [1], [{}], [good, { ...good, id: "bad id" }], [{ ...good, stem: "x" }]]) {
      expect(() => readStoredAttempts(bad), JSON.stringify(bad)).toThrow(StorageUnavailable);
    }
  });
});

describe("the API with a corrupt stored value", () => {
  it("answers 503 storage-unavailable to a read, a write and a course delete, and never deletes or trims what it couldn't read", async () => {
    for (const value of BAD_VALUES) {
      for (const req of [{ method: "GET", url: URL_ }, write("POST", URL_, body([good])), write("DELETE", `${URL_}?course=COP3530`)]) {
        const { kv, names } = upstashReturning(value);
        const res = await handleAccountRequest(req, "user_1", () => kv, ON);
        expect(res, `${req.method} ${JSON.stringify(value)}`).toEqual({ status: 503, json: { error: "storage-unavailable" } });
        // Nothing was removed on the strength of a list that couldn't be read.
        expect(names.filter((n) => ["HDEL", "ZREM", "DEL"].includes(n))).toEqual([]);
      }
    }
  });

  it("nothing stored is an empty account, and a good value still reads", async () => {
    for (const value of [null, [], [JSON.stringify(good)]]) {
      const { kv } = upstashReturning(value);
      const res = await handleAccountRequest({ method: "GET", url: URL_ }, "user_1", () => kv, ON);
      expect(res.status).toBe(200);
    }
  });
});

describe("a storage URL that isn't https", () => {
  it("never sends the token and answers 503 storage-unavailable", async () => {
    let sent = 0;
    const fetcher = (async () => (sent++, new Response("[]"))) as unknown as typeof fetch;
    for (const url of ["http://kv.example.test", "ftp://x", "kv.example.test", ""]) {
      const kv = upstashKV(url, "tok", fetcher, 100);
      await expect(kv.list({ hash: "h", byTime: "t", deletedMark: "d" }), url).rejects.toBeInstanceOf(StorageUnavailable);
      expect(await handleAccountRequest({ method: "GET", url: URL_ }, "user_1", () => kv, ON)).toEqual({ status: 503, json: { error: "storage-unavailable" } });
    }
    expect(sent).toBe(0);
  });
});
