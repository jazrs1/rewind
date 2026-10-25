// The Upstash client's commands (the merge and delete-all Lua scripts, remove's transaction) run on a real Redis:
// a throwaway redis-server on a Unix socket in a temp folder, with no network port. The fetch passed to
// upstashKV turns each REST call into Redis commands over that socket. Skipped where redis-server isn't
// installed.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userKeys } from "./handler.ts";
import { upstashKV, type AccountKV } from "./kv.ts";
import { attempt } from "./test-helpers.ts";

const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;

/** A minimal RESP client: one command at a time. */
function respClient(socket: Socket) {
  let buf = Buffer.alloc(0);
  let waiting: ((v: unknown) => void) | null = null;
  const parse = (pos: number): [unknown, number] | null => {
    const end = buf.indexOf("\r\n", pos);
    if (end < 0) return null;
    const type = String.fromCharCode(buf[pos]);
    const line = buf.toString("utf8", pos + 1, end);
    if (type === "+") return [line, end + 2];
    if (type === "-") return [new Error(line), end + 2];
    if (type === ":") return [Number(line), end + 2];
    if (type === "$") {
      const n = Number(line);
      if (n < 0) return [null, end + 2];
      if (buf.length < end + 2 + n + 2) return null;
      return [buf.toString("utf8", end + 2, end + 2 + n), end + 2 + n + 2];
    }
    const n = Number(line);
    if (n < 0) return [null, end + 2];
    const out: unknown[] = [];
    let p = end + 2;
    for (let i = 0; i < n; i++) {
      const r = parse(p);
      if (!r) return null;
      out.push(r[0]);
      p = r[1];
    }
    return [out, p];
  };
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    const r = parse(0);
    if (r && waiting) {
      buf = buf.subarray(r[1]);
      const w = waiting;
      waiting = null;
      w(r[0]);
    }
  });
  return (args: (string | number)[]) =>
    new Promise<unknown>((resolve) => {
      waiting = resolve;
      socket.write(`*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join("")}`);
    });
}

describe.skipIf(!hasRedis)("Upstash commands on a real Redis", () => {
  let dir: string;
  let server: ChildProcess;
  let socket: Socket;
  let kv: AccountKV;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "rewind-redis-"));
    const sock = join(dir, "redis.sock");
    server = spawn("redis-server", ["--port", "0", "--unixsocket", sock, "--save", "", "--appendonly", "no", "--dir", dir], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        socket = await new Promise<Socket>((resolve, reject) => {
          const s = createConnection(sock, () => resolve(s));
          s.once("error", reject);
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const call = respClient(socket);
    // What Upstash's REST API does with a pipeline (commands in order) or multi-exec (one transaction).
    const fetchFn = (async (url: string, init: RequestInit) => {
      const commands = JSON.parse(init.body as string) as (string | number)[][];
      const out: { result?: unknown; error?: string }[] = [];
      if (url.endsWith("/multi-exec")) {
        await call(["MULTI"]);
        for (const c of commands) await call(c);
        const results = (await call(["EXEC"])) as unknown[];
        for (const r of results) out.push(r instanceof Error ? { error: r.message } : { result: r });
      } else {
        for (const c of commands) {
          const r = await call(c);
          out.push(r instanceof Error ? { error: r.message } : { result: r });
        }
      }
      return new Response(JSON.stringify(out));
    }) as unknown as typeof fetch;
    // https: upstashKV refuses any other scheme (the token travels in a header). The fake fetch above never
    // uses the host; it speaks to the socket. (An http URL here made all three tests fail on main.)
    kv = upstashKV("https://redis.local", "tok", fetchFn);
  });

  afterAll(() => {
    socket?.destroy();
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const keys = userKeys("user_r");

  it("merges by id, newer wins, idempotent; a full account refuses new ids (over the limit) and keeps what it has", async () => {
    const old = attempt({ id: "att-0000000a", answeredAt: "2026-10-20T15:00:00.000Z" });
    const newer = attempt({ id: "att-0000000a", correct: true, answeredAt: "2026-10-21T15:00:00.000Z" });
    const other = attempt({ id: "att-0000000b", answeredAt: "2026-10-19T15:00:00.000Z" });
    expect(await kv.merge(keys, [old], 3)).toEqual({ attempts: [old], overLimit: [] });
    const once = await kv.merge(keys, [newer, other], 3);
    expect(once).toEqual({ attempts: [other, newer], overLimit: [] });
    expect(await kv.merge(keys, [old, other], 3)).toEqual(once);
    // Room for one more: the first goes in, the rest come back over the limit; nothing stored is dropped.
    const more = [1, 2, 3].map((i) => attempt({ id: `att-0000000${i}`, answeredAt: `2026-10-2${i}T16:00:00.000Z` }));
    const full = await kv.merge(keys, more, 3);
    expect(full).toEqual({ attempts: [other, newer, more[0]], overLimit: ["att-00000002", "att-00000003"] });
    expect(await kv.list(keys)).toEqual(full.attempts);
    // Full, an answer it already has can still be updated.
    const update = attempt({ id: "att-0000000b", correct: true, answeredAt: "2026-10-19T16:00:00.000Z" });
    expect(await kv.merge(keys, [update], 3)).toEqual({ attempts: [update, newer, more[0]], overLimit: [] });
  });

  it("removes ids, and delete-all leaves a mark that refuses re-uploads of what it deleted", async () => {
    await kv.remove(keys, ["att-00000001"]);
    expect((await kv.list(keys)).map((a) => a.id)).toEqual(["att-0000000b", "att-0000000a"]);
    // Deleted at Oct 21, 15:00 by the server's clock: older re-uploads are refused, later answers go in.
    await kv.removeAll(keys, 60, Date.parse("2026-10-21T15:00:00Z"));
    expect(await kv.list(keys)).toEqual([]);
    const stale = attempt({ id: "att-00000002", answeredAt: "2026-10-21T14:00:00.000Z" });
    const fresh = attempt({ id: "att-00000009", answeredAt: "2026-10-21T15:00:01.000Z" });
    expect(await kv.merge(keys, [stale, fresh], 3)).toEqual({ attempts: [fresh], overLimit: [] });
  });

  it("delete-all sets the mark to the server's time it is given, even over a future-dated answer", async () => {
    const k = userKeys("user_cap");
    const future = attempt({ id: "att-0000000f", answeredAt: "2031-01-01T00:00:00.000Z" });
    await kv.merge(k, [future], 3);
    await kv.removeAll(k, 60, Date.parse("2026-10-24T22:00:00Z"));
    // An answer just after the delete goes in; one at it is refused.
    const after = attempt({ id: "att-00000010", answeredAt: "2026-10-24T22:00:00.001Z" });
    const at = attempt({ id: "att-00000011", answeredAt: "2026-10-24T22:00:00.000Z" });
    expect(await kv.merge(k, [after, at], 3)).toEqual({ attempts: [after], overLimit: [] });
  });

  it("counts writes with a TTL", async () => {
    expect(await kv.incr("rewind:test:writes", 60)).toBe(1);
    expect(await kv.incr("rewind:test:writes", 60)).toBe(2);
  });
});
