import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PracticeSeed } from "../demo/types";

const local = vi.hoisted(() => ({ loadLocalHome: vi.fn(), loadLocalPracticeIndex: vi.fn() }));
vi.mock("../home/local.ts", () => local);

import { gradedScope } from "./graded";

const seed = { course: { code: "FAKE7", name: "Fake" }, questions: [] } as unknown as PracticeSeed;
const exam = (topics: string | null) => ({
  id: "exam:quiz-8",
  title: "Quiz 8",
  date: { state: "found", text: "Oct 30, 8 pm" },
  topics: topics ? { state: "found", text: topics } : { state: "missing", searched: "" },
});

beforeEach(() => {
  local.loadLocalHome.mockReset();
  local.loadLocalPracticeIndex.mockReset();
});

describe("graded is decided on the server, from the open assignment", () => {
  it("is graded when the course data can't say (nothing loaded, or it throws)", async () => {
    local.loadLocalHome.mockResolvedValue(null);
    const none = await gradedScope(seed, undefined);
    expect(none.isGraded("any")).toBe(true);
    local.loadLocalHome.mockRejectedValue(new Error("boom"));
    expect((await gradedScope(seed, undefined)).isGraded("any")).toBe(true);
  });

  it("is practice when there is no open assignment", async () => {
    local.loadLocalHome.mockResolvedValue({ quiz: null });
    const s = await gradedScope(seed, undefined);
    expect(s.assignment).toBeNull();
    expect(s.isGraded("q")).toBe(false);
  });

  it("is graded for questions on the assignment's modules, and for ones whose module can't be told", async () => {
    local.loadLocalHome.mockResolvedValue({ quiz: { exam: exam("Graphs"), practice: { modules: [10], href: "", ready: "" } } });
    local.loadLocalPracticeIndex.mockResolvedValue([
      { id: "on", module: 10 },
      { id: "off", module: 9 },
      { id: "unknown", module: null },
    ]);
    const s = await gradedScope(seed, undefined);
    expect(s.assignment).toEqual({ id: "exam:quiz-8", name: "Quiz 8", topics: "Graphs", due: "Oct 30" });
    expect(s.isGraded("on")).toBe(true);
    expect(s.isGraded("off")).toBe(false);
    expect(s.isGraded("unknown")).toBe(true);
    // A question the index doesn't know is unknown too.
    expect(s.isGraded("never-heard-of-it")).toBe(true);
  });

  it("is all graded when the assignment's modules aren't known", async () => {
    local.loadLocalHome.mockResolvedValue({ quiz: { exam: exam(null), practice: null } });
    const s = await gradedScope(seed, undefined);
    expect(s.isGraded("anything")).toBe(true);
    expect(s.assignment?.name).toBe("Quiz 8");
  });

  it("a query value can't turn graded work into practice: only the invented e2e set names are special", async () => {
    local.loadLocalHome.mockResolvedValue({ quiz: { exam: exam("Graphs"), practice: { modules: [10], href: "", ready: "" } } });
    local.loadLocalPracticeIndex.mockResolvedValue([{ id: "on", module: 10 }]);
    for (const set of ["practice", "seed", "0", "graded", "e2e-quiz", "e2e-fixture-2"]) expect((await gradedScope(seed, set)).isGraded("on"), set).toBe(true);
    expect((await gradedScope(seed, "e2e-graded")).isGraded("x")).toBe(true);
    expect((await gradedScope(seed, "e2e-fixture")).isGraded("x")).toBe(false);
  });
});
