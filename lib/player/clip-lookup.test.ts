import { describe, expect, it } from "vitest";
import { hostedClipAt } from "./clip-lookup";

const media = {
  "l20261013-q1": { src: "/demo/media/l20261013-q1.mp4", offset: 2274, end: 2334 },
  "l20261013-q6": { src: "/demo/media/l20261013-q6.mp4", offset: 3000, end: 3040 },
  "l20261020-q1": { src: "/demo/media/l20261020-q1.mp4", offset: 2274, end: 2334 },
};

describe("hostedClipAt", () => {
  it("the moment's own question's clip wins", () => {
    expect(hostedClipAt(media, { questionId: "l20261013-q6", date: "2026-10-13", second: 2284 })).toBe(media["l20261013-q6"]);
  });
  it("no question: the same lecture's clip whose window holds the second (Oct 13 · 38:04)", () => {
    expect(hostedClipAt(media, { date: "2026-10-13", second: 2284 })).toBe(media["l20261013-q1"]);
    expect(hostedClipAt(media, { questionId: "l20261013-q99", date: "2026-10-20", second: 2300 })).toBe(media["l20261020-q1"]);
  });
  it("both ends of the window count", () => {
    expect(hostedClipAt(media, { date: "2026-10-13", second: 2274 })).toBe(media["l20261013-q1"]);
    expect(hostedClipAt(media, { date: "2026-10-13", second: 2334 })).toBe(media["l20261013-q1"]);
  });
  it("outside every window, another lecture, or no date: null", () => {
    expect(hostedClipAt(media, { date: "2026-10-13", second: 2273 })).toBeNull();
    expect(hostedClipAt(media, { date: "2026-10-13", second: 2335 })).toBeNull();
    expect(hostedClipAt(media, { date: "2026-10-22", second: 2284 })).toBeNull();
    expect(hostedClipAt(media, { second: 2284 })).toBeNull();
    expect(hostedClipAt(null, { date: "2026-10-13", second: 2284 })).toBeNull();
  });
});
