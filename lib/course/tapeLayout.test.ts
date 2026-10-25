import { describe, expect, it } from "vitest";
import {
  BADGE,
  deskFrame,
  deskLayout,
  deskRows,
  deskSlots,
  DESKTOP_FRAME,
  frameLength,
  headSlot,
  labelBox,
  LABEL,
  overlap,
  phoneFrame,
  pointAt,
  positionMap,
  reels,
  roadPath,
  roadPoint,
  roadTotal,
  rollers,
  slotAt,
  type Box,
  type DeskInput,
} from "./tapeLayout";

describe("tape layout", () => {
  it("desktop matches the mockup's road", () => {
    expect(roadPath(DESKTOP_FRAME)).toBe("M60 150 H740 A85 85 0 0 1 740 320 H130 A85 85 0 0 0 130 490 H740 A85 85 0 0 1 740 660 H60");
    expect(rollers(DESKTOP_FRAME)).toEqual([{ x: 740, y: 235 }, { x: 130, y: 405 }, { x: 740, y: 575 }]);
    expect(reels(DESKTOP_FRAME)).toEqual({ supply: { x: 60, y: 150 }, takeUp: { x: 60, y: 660 } });
  });

  it("pointAt runs from the first row's start to the last row's end, along rows and turns", () => {
    expect(pointAt(DESKTOP_FRAME, 0)).toMatchObject({ x: 130, y: 150, kind: "row", row: 0 });
    expect(pointAt(DESKTOP_FRAME, 1)).toMatchObject({ x: 130, y: 660, kind: "row", row: 3 });
    const w = 610;
    const turn = Math.PI * 85;
    const t = (w + turn / 2) / frameLength(DESKTOP_FRAME);
    const p = pointAt(DESKTOP_FRAME, t);
    expect(p.kind).toBe("turn");
    expect(p.side).toBe("right");
    expect(p.x).toBeCloseTo(825, 0); // the turn's outermost point
    expect(p.y).toBeCloseTo(235, 0);
    // Out-of-range fractions clamp.
    expect(pointAt(DESKTOP_FRAME, -1)).toEqual(pointAt(DESKTOP_FRAME, 0));
  });

  it("a phone frame grows with the stops (two a row, an even number of rows) and stays 390 wide", () => {
    expect(phoneFrame(4).rows).toHaveLength(2);
    expect(phoneFrame(5).rows).toHaveLength(4);
    const f = phoneFrame(13);
    expect(f.rows).toHaveLength(8);
    expect(reels(f).takeUp.x).toBe(f.x0 - f.lead);
    expect(f.width).toBe(390);
    expect(f.x0 - f.r).toBeGreaterThanOrEqual(16);
    expect(f.x1 + f.r).toBeLessThanOrEqual(390 - 16);
    expect(f.height).toBeGreaterThan(f.rows[7]);
  });

  it("phone slots sit on the rows, two to a row, never on a turn", () => {
    const f = phoneFrame(5);
    const pts = [0, 1, 2, 3, 4].map((i) => pointAt(f, slotAt(f, i, 2)));
    expect(pts.map((p) => [p.kind, p.row])).toEqual([["row", 0], ["row", 0], ["row", 1], ["row", 1], ["row", 2]]);
    expect(pts[0].x).toBeCloseTo(f.x0 + (f.x1 - f.x0) / 4, 5);
    expect(pts[2].x).toBeCloseTo(f.x1 - (f.x1 - f.x0) / 4, 5);
  });

  it("positionMap keeps a point between the same two stops", () => {
    const map = positionMap([0.1, 0.5, 0.5, 0.9], [0.2, 0.4, 0.6, 0.8]);
    expect(map(0)).toBe(0);
    expect(map(0.1)).toBeCloseTo(0.2);
    expect(map(0.3)).toBeCloseTo(0.3);
    expect(map(0.5)).toBeCloseTo(0.4);
    expect(map(0.7)).toBeCloseTo(0.7);
    expect(map(1)).toBe(1);
  });

  it("the desktop tape grows with the stops: three stops are a short tape with two bends, never more than four rows", () => {
    expect([1, 2, 3, 4, 8, 20].map(deskRows)).toEqual([2, 2, 3, 4, 4, 4]);
    const three = deskFrame(3);
    expect(rollers(three)).toHaveLength(2);
    expect(three.height).toBeLessThan(deskFrame(4).height);
    expect(three.width).toBe(740);
    // An odd number of rows ends on the right: the take-up reel follows the last row, inside the frame.
    expect(reels(three).takeUp.x).toBeGreaterThan(three.x1);
    expect(reels(three).takeUp.x + 50).toBeLessThanOrEqual(three.width - 14);
    // The road runs from the supply reel to the take-up reel.
    expect(roadPoint(three, 0)).toEqual(reels(three).supply);
    expect(roadPoint(three, roadTotal(three))).toEqual(reels(three).takeUp);
  });

  it("desktop stops spread along the road in order and never sit on a bend", () => {
    for (let n = 1; n <= 14; n++) {
      const f = deskFrame(n);
      const slots = deskSlots(f, n);
      expect(slots).toEqual([...slots].sort((a, b) => a - b));
      for (const t of slots) expect(pointAt(f, t).kind).toBe("row");
    }
  });

  it("the tape head never covers a stop: on the current stop it rests just past it", () => {
    const f = deskFrame(3);
    const slots = deskSlots(f, 3);
    const len = frameLength(f);
    expect(headSlot(f, 0.35, slots)).toBe(0.35);
    const t = headSlot(f, slots[2], slots, 56);
    expect((t - slots[2]) * len).toBeCloseTo(56, 5);
    // Between two close stops it stops half way.
    expect(headSlot(f, 0.3, [0.3, 0.31])).toBeCloseTo(0.305, 5);
  });

  it("long stop names wrap to two lines, then end in an ellipsis", () => {
    expect(labelBox("Sorting")).toMatchObject({ lines: 1, truncated: false });
    expect(labelBox("Graph Terminology and Implementation")).toMatchObject({ lines: 2, truncated: false });
    const long = labelBox("Amortized Analysis of Self-Balancing Binary Search Trees and Their Rotations");
    expect(long).toMatchObject({ lines: 2, truncated: true });
    expect(long.w).toBeLessThanOrEqual(LABEL.maxW);
  });

  const demo: DeskInput = {
    stops: [
      { position: 0.25, topic: "Sorting", onRoute: true },
      { position: 0.5, topic: "Sets, Maps, HashTables", onRoute: true },
      { position: 0.75, topic: "Graph Terminology and Implementation", onRoute: true },
    ],
    here: 0.75,
    week: null,
    flags: [],
  };

  /** Every label and badge: inside the frame, off the head, its pill, the flags and the dots, and clear of each other. */
  function expectClear(input: DeskInput) {
    const f = deskFrame(input.stops.length);
    const L = deskLayout(f, input);
    const boxes: Box[] = L.places.flatMap((p) => (p.badge ? [p.label, p.badge] : [p.label]));
    const fixed: Box[] = [
      ...(L.head ? [{ x: L.head.x - 15, y: L.head.y - 14, w: 30, h: 28 }] : []),
      ...(L.bubble ? [L.bubble] : []),
      ...L.flags.map((fl) => fl.box),
      ...L.dots.map((d) => ({ x: d.x - 8, y: d.y - 8, w: 16, h: 16 })),
    ];
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(f.width);
      expect(b.y + b.h).toBeLessThanOrEqual(f.height);
      for (const o of fixed) expect(overlap(b, o)).toBe(0);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(0);
    return L;
  }

  it("the demo's three stops: labels and route badges collide with nothing, and the head sits past the current stop", () => {
    const L = expectClear(demo);
    expect(L.places.every((p) => p.badge && p.badge.w === BADGE.w)).toBe(true);
    expect(Math.hypot(L.head!.x - L.dots[2].x, L.head!.y - L.dots[2].y)).toBeGreaterThan(40);
    // The pill's pointer stays over the head.
    expect(L.head!.x).toBeGreaterThan(L.bubble!.x + 12);
    expect(L.head!.x).toBeLessThan(L.bubble!.x + L.bubble!.w - 12);
  });

  it("bigger courses with long names and exam flags stay collision free", () => {
    const names = ["Asymptotic Analysis", "Linked Lists and Iterators", "Stacks", "Queues and Deques", "Binary Search Trees", "AVL Trees and Rotations", "Heaps and Priority Queues", "Sets, Maps, HashTables", "Graph Terminology and Implementation"];
    for (const n of [1, 2, 4, 6, 8]) {
      const stops = names.slice(0, n).map((topic, i) => ({ position: (i + 1) / (n + 1), topic, onRoute: i < 3 }));
      expectClear({ stops, here: stops[Math.floor(n / 2)].position, week: 9, flags: [{ position: 0.9, text: "Exam 2 · in 12 days" }] });
    }
  });
  it("the miss marker (✕n) sits above-right of its dot: never between the dot and the head, under a route badge, the head or \"You are here\"", () => {
    const names = ["Sorting", "Sets, Maps, HashTables", "Graph Terminology and Implementation", "Binary Search Trees", "AVL Trees and Rotations", "Heaps and Priority Queues"];
    const cases: DeskInput[] = [{ ...demo, stops: demo.stops.map((s) => ({ ...s, misses: 3 })) }];
    for (const n of [1, 2, 3, 4, 6]) {
      for (let h = 0; h < n; h++) {
        // The head parked on that stop (0), and just past it.
        for (const after of [0, 0.02, 0.08]) {
          for (const big of [3, 12]) {
            const stops = names.slice(0, n).map((topic, i) => ({ position: (i + 1) / (n + 1), topic, onRoute: true, misses: i === h ? big : 2 }));
            cases.push({ stops, here: Math.min(0.99, stops[h].position + after), week: 9, flags: [] });
          }
        }
      }
    }
    for (const input of cases) {
      const L = deskLayout(deskFrame(input.stops.length), input);
      const head = L.head!;
      const keepOut: Box[] = [{ x: head.x - 15, y: head.y - 14, w: 30, h: 28 }, L.bubble!, { x: head.x - 7, y: head.y - 34, w: 14, h: 9 }];
      const labels = L.places.flatMap((p) => [p.label, ...(p.badge ? [p.badge] : [])]);
      L.places.forEach((p, i) => {
        const miss = p.miss!;
        const dot = L.dots[i];
        // Above-right, touching the dot's corner.
        expect(miss.x).toBeGreaterThan(dot.x);
        expect(miss.y + miss.h).toBeLessThanOrEqual(dot.y - 8);
        expect(Math.hypot(miss.x - dot.x, miss.y + miss.h - dot.y)).toBeLessThan(16);
        for (const o of [...keepOut, ...labels]) expect(overlap(miss, o)).toBe(0);
        // On the head's row (the stop it's parked on, its neighbours), nothing of it on the tape between the dot and the head.
        if (Math.abs(dot.y - head.y) < 1) for (let k = 1; k < 20; k++) {
          const x = dot.x + ((head.x - dot.x) * k) / 20;
          const y = dot.y + ((head.y - dot.y) * k) / 20;
          expect(x > miss.x && x < miss.x + miss.w && y > miss.y && y < miss.y + miss.h).toBe(false);
        }
      });
    }
  });
});
