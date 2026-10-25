import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { revealsAnswer } from "../tutor/integrity";
import { readDemoBundle, type DemoBundle } from "./bundle";
import { onceUnlessFailed } from "./tutor-bundle";
import { coverageGaps, coverageWarning, demoQuestionIds } from "./tutor-coverage";
import { LIMITS } from "./tutor-limits";
import type { DemoModel } from "./tutor-llm";
import { clientIp, handleDemoTutor, ipKey, type DemoTutorDeps } from "./tutor-route";
import { memoryStore } from "./tutor-store";

let bundle: DemoBundle;
beforeAll(async () => {
  bundle = (await readDemoBundle())!;
});

const KEY = "demo-key-for-tests-only";
const model: DemoModel = async () => ({ reply: { text: "What is the question really asking?", claims: [], confirms: false }, inputTokens: 100, outputTokens: 20 });
function deps(over: Partial<DemoTutorDeps> = {}): DemoTutorDeps & { calls: string[] } {
  const calls: string[] = [];
  return { key: KEY, model: () => async (p, s) => (calls.push(p), model(p, s)), store: memoryStore(), bundle: async () => bundle, secure: false, ...over, calls };
}
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/demo/tutor", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const q0 = () => bundle.sets[0].seed.questions[0];

describe("the client address", () => {
  it("trusts Vercel's header first, then x-real-ip, and never an x-forwarded-for entry", () => {
    const r = (h: Record<string, string>) => clientIp(new Request("http://x", { headers: h }));
    expect(r({ "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": "192.0.2.44, 192.0.2.88", "x-real-ip": "9.9.9.9" })).toBe("198.51.100.9");
    expect(r({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "192.0.2.44" })).toBe("9.9.9.9");
    // A client-written x-forwarded-for alone is no address at all.
    expect(r({ "x-forwarded-for": "192.0.2.44" })).toBe("unknown");
    expect(r({})).toBe("unknown");
  });

  it("can't buy a new allowance by writing x-forwarded-for: the limit follows Vercel's header", async () => {
    // The per-minute window follows the clock: pin it mid-minute so the run can't cross a minute boundary. Only Date is
    // faked; the route's own timers (the deadline, the stream) run as usual.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T15:30:20Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const d = deps();
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.perIpMinute + 2; i++) {
      const res = await handleDemoTutor(req({ questionId: q0().id, request: "reply", message: "hello there" }, { "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": `10.0.0.${i}` }), d);
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses.slice(0, LIMITS.perIpMinute).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(LIMITS.perIpMinute)).toEqual([429, 429]);
  });

  it("counts an IPv6 address as its /64, and an IPv4-mapped one as the IPv4", () => {
    expect(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002::/64");
    expect(ipKey("2001:db8:1:2:1111:2222:3333:4444")).toBe("2001:0db8:0001:0002::/64");
    expect(ipKey("2001:DB8:1:3::1")).toBe("2001:0db8:0001:0003::/64");
    expect(ipKey("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(ipKey("[2001:db8:1:2::9]")).toBe("2001:0db8:0001:0002::/64");
    expect(ipKey("::1")).toBe("0000:0000:0000:0000::/64");
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
  });

  it("rotating inside one /64 is one visitor to the per-minute limit", async () => {
    const d = deps();
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.perIpMinute + 1; i++) {
      const res = await handleDemoTutor(req({ questionId: q0().id, request: "reply", message: "hello" }, { "x-vercel-forwarded-for": `2001:db8:1:2:${i.toString(16)}::${i + 1}` }), d);
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("bodies and the bundle", () => {
  it("answers 400, not a crash, to a body that isn't an object", async () => {
    for (const body of ["null", "42", '"text"', "[]", "[1,2]", "true"]) {
      const res = await handleDemoTutor(req(body), deps());
      expect(res.status, body).toBe(400);
    }
  });

  it("answers 503 when the bundle can't be read", async () => {
    const res = await handleDemoTutor(req({ questionId: "x", request: "hint" }), deps({ bundle: async () => Promise.reject(new Error("disk")) }));
    expect(res.status).toBe(503);
  });

  it("doesn't remember a failed read, and remembers a good one", async () => {
    let n = 0;
    const load = onceUnlessFailed(async () => {
      n++;
      if (n === 1) throw new Error("first read fails");
      return { ok: n };
    });
    await expect(load()).rejects.toThrow("first read fails");
    expect(await load()).toEqual({ ok: 2 });
    expect(await load()).toEqual({ ok: 2 });
    expect(n).toBe(2);
  });
});

describe("the checked answer is kept per visitor and question", () => {
  it("keeps the first answer reported: a later 'marked: null' or another letter changes nothing, and the answer then needs no re-claim", async () => {
    const d = deps();
    const wrong = q0().choices.find((c) => c.label !== q0().answer)!.label;
    const first = await handleDemoTutor(req({ questionId: q0().id, request: "hint", marked: wrong }), d);
    await first.text();
    const cookie = first.headers.get("set-cookie")!.split(";")[0];
    // Later requests that say nothing about it still have an answer on file, so the answer can be asked for...
    const asked = await handleDemoTutor(req({ questionId: q0().id, request: "answer", marked: null }, { cookie }), d);
    await asked.text();
    expect(d.calls.at(-1)).toContain("Give the answer");
    expect(d.calls.at(-1)).toContain(`The student marked (${wrong})`);
    // ...and a different letter doesn't replace it.
    const other = q0().choices.find((c) => c.label !== wrong)!.label;
    const again = await handleDemoTutor(req({ questionId: q0().id, request: "answer", marked: other }, { cookie }), d);
    await again.text();
    expect(d.calls.at(-1)).toContain(`The student marked (${wrong})`);
  });

  it("a visitor who never reported one still can't get the answer", async () => {
    const d = deps();
    const res = await handleDemoTutor(req({ questionId: q0().id, request: "answer", marked: null }), d);
    expect((await res.text()).replace(/\{"t":"text","d":"([^"]*)"\}\n?/g, "$1")).toContain("Mark your answer and check it first");
    expect(d.calls).toHaveLength(0);
  });
});

describe("saved-reply coverage", () => {
  const raw = { sets: [{ questions: [{ id: "a" }, { id: "b" }] }, { questions: [{ id: "c" }] }] };
  const reply = { text: "t", grounded: [] };
  const full = { hint1: reply, hint2: reply, socratic: reply, confirm: reply, answer: reply };

  it("finds the questions with no entry, an incomplete entry or an empty reply, and entries for questions that are gone", () => {
    expect(demoQuestionIds(raw)).toEqual(["a", "b", "c"]);
    expect(coverageGaps(raw, { questions: { a: full, b: full, c: full } })).toEqual({ missing: [], extra: [] });
    const gaps = coverageGaps(raw, { questions: { a: full, b: { ...full, answer: undefined }, c: { ...full, hint1: { text: " " } }, z: full } });
    expect(gaps.missing).toEqual(["b", "c"]);
    expect(gaps.extra).toEqual(["z"]);
  });

  it("says so at startup: a missing file, a partial one, and nothing when it's sound", () => {
    expect(coverageWarning(raw, null)).toContain("tutor.json is missing");
    expect(coverageWarning(raw, { questions: { a: full } })).toContain("doesn't cover 2 of 3 demo questions");
    expect(coverageWarning(raw, { questions: { a: full, b: full, c: full } })).toBeNull();
  });

  // The real file, once it has been made with the real key (scripts/demo/precompute-tutor.ts): every question covered.
  const file = "public/demo/course/tutor.json";
  it.skipIf(!existsSync(file))("public/demo/course/tutor.json covers every demo question", () => {
    const bundleRaw = JSON.parse(readFileSync("public/demo/course/course.json", "utf8"));
    expect(coverageGaps(bundleRaw, JSON.parse(readFileSync(file, "utf8")))).toEqual({ missing: [], extra: [] });
  });
});

describe("a lettered list isn't an answer", () => {
  const q = { answer: "B" as const, choices: [{ label: "A" as const, text: "Constant time" }, { label: "B" as const, text: "Logarithmic time" }, { label: "C" as const, text: "Linear time" }] };
  it("doesn't flag 'a) …, and b) …' enumerations", () => {
    expect(revealsAnswer("Two ways to see it: a) sort them first, and b) hash them into buckets.", q)).toBe(false);
    expect(revealsAnswer("Think about (a) the order and (b) the size of the table.", q)).toBe(false);
    expect(revealsAnswer("a) the stack\nb) the queue\nc) the heap", q)).toBe(false);
  });
  it("still flags a stated answer in the same forms", () => {
    expect(revealsAnswer("I'd say b)", q)).toBe(true);
    expect(revealsAnswer("go with (b), not (c)", q)).toBe(true);
    expect(revealsAnswer("The answer is (B).", q)).toBe(true);
    expect(revealsAnswer("b) obviously", q)).toBe(true); // one bare marker with no list around it is an answer
  });
});
