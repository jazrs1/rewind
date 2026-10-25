import { describe, expect, it } from "vitest";
import { aheadDash, atPosition, counterAt, glowLevel, placeStop, pointAt, ROAD, scoreText, termLabel } from "./geometry.ts";

describe("course tape geometry", () => {
  it("runs from the first row's start to the last row's end, through three turns", () => {
    expect(atPosition(0)).toMatchObject({ x: 130, y: 150, kind: "row", row: 0 });
    expect(atPosition(1)).toMatchObject({ x: 130, y: 660, kind: "row", row: 3 });
    // Just past the first row: the right-hand turn.
    expect(pointAt(610 + 1)).toMatchObject({ kind: "turn", side: "right" });
    // Second row runs right to left.
    const mid = pointAt(610 + Math.PI * 85 + 100);
    expect(mid).toMatchObject({ kind: "row", row: 1, x: 640, y: 320 });
    expect(pointAt(-5)).toMatchObject({ x: 130, y: 150 });
    expect(pointAt(ROAD + 99)).toMatchObject({ x: 130, y: 660 });
  });

  it("places labels above and below on rows, inside the turns", () => {
    expect(placeStop(0.1, 0).label).toMatchObject({ align: "center" });
    expect(placeStop(0.1, 0).label.y).toBeLessThan(placeStop(0.1, 0).y);
    expect(placeStop(0.1, 1).label.y).toBeGreaterThan(placeStop(0.1, 1).y);
    // Under a flag (or the tape head), a label that would go above goes below.
    const dot = placeStop(0.1, 0);
    expect(placeStop(0.1, 0, [{ x: dot.x + 50, y: dot.y }]).label.y).toBeGreaterThan(dot.y);
    expect(placeStop(0.1, 0, [{ x: dot.x + 400, y: dot.y }]).label.y).toBeLessThan(dot.y);
    const turn = placeStop((610 + 40) / ROAD, 0);
    expect(turn.label.align).toBe("right");
  });

  it("dims the road past the tape head, and all of it when the head is unknown", () => {
    expect(aheadDash(0.5)).toBe(`0 ${0.5 * ROAD + 70} ${ROAD + 300}`);
    expect(aheadDash(null).startsWith("0 ")).toBe(true);
  });

  it("counts lecture minutes up to a point, and glows only stops with stressed evidence", () => {
    const stops = [
      { position: 0.2, lectureMinutes: 0 },
      { position: 0.5, lectureMinutes: 40.4 },
      { position: 0.8, lectureMinutes: 25 },
    ];
    expect(counterAt(0.1, stops)).toBe("0000");
    expect(counterAt(0.6, stops)).toBe("0040");
    expect(counterAt(1, stops)).toBe("0065");
    expect(glowLevel(0, 0)).toBe(0);
    expect(glowLevel(0.02, 0.1)).toBe(1);
    expect(glowLevel(1, 17)).toBe(5);
  });
});

describe("display helpers", () => {
  it("says a score from the same value the glow uses: never 0 when it glows", () => {
    expect(scoreText(0)).toBe("0");
    expect(scoreText(0.1)).toBe("0.1");
    expect(scoreText(0.04)).toBe("0.04");
    expect(scoreText(0.004)).toBe("under 0.01");
    expect(scoreText(2.94)).toBe("2.9");
    expect(scoreText(17.4)).toBe("17");
    for (const n of [0.004, 0.01, 0.1, 0.5, 3, 12]) expect(glowLevel(0.01, n) > 0 && scoreText(n) !== "0").toBe(true);
  });

  it("reads the term from the course's Canvas name, or says nothing", () => {
    expect(termLabel("ABC1000 - Fa26")).toBe("Fall 2026");
    expect(termLabel("Spring 2027 ABC")).toBe("Spring 2027");
    expect(termLabel("ABC1000")).toBeNull();
    expect(termLabel(null)).toBeNull();
  });
});
