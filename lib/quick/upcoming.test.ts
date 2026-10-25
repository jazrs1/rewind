// Quick build's "Coming up": exams, quizzes and assignments from Canvas's own due dates, read on this device only.
import { describe, expect, it } from "vitest";
import { canvasHostOf, canvasUrl, createUpcomingStore, dueText, kindOf, MAX_ITEMS, parseUpcoming, stillAhead, upcomingKey, upcomingOf, whenText } from "./upcoming.ts";

const NOW = new Date("2026-10-25T15:00:00Z"); // Sun Oct 25, 11:00 am Eastern
const TZ = "America/New_York";

const exportWith = (assignments: unknown[]) => ({
  course: { id: 1, name: "Data Structures", course_code: "COP3530" },
  pages: [],
  assignments,
  submissions: [{ grade: "SECRET-GRADE", user: { name: "SECRET-STUDENT" } }],
});

describe("upcomingOf", () => {
  it("keeps what's due from today on, soonest first, with only name, kind, due date and link", () => {
    const items = upcomingOf(
      exportWith([
        { name: "Project 2", due_at: "2026-11-10T03:59:00Z", html_url: "https://ufl.instructure.com/courses/1/assignments/9?x=1", points_possible: 100, description: "<p>SECRET-DESCRIPTION</p>" },
        { name: "Exam 2", due_at: "2026-10-30T23:00:00Z", submission_types: ["on_paper"] },
        { name: "Quiz 7: Graphs", due_at: "2026-10-27T03:59:00Z", is_quiz_assignment: true },
        { name: "Homework 3", due_at: "2026-10-01T03:59:00Z" },
        { name: "Participation", due_at: null },
        { name: "Draft", due_at: "2026-10-29T03:59:00Z", published: false },
      ]),
      NOW,
    );
    expect(items.map((i) => [i.title, i.kind])).toEqual([
      ["Quiz 7: Graphs", "quiz"],
      ["Exam 2", "exam"],
      ["Project 2", "assignment"],
    ]);
    expect(items[2].url).toBe("https://ufl.instructure.com/courses/1/assignments/9");
    expect(JSON.stringify(items)).not.toMatch(/SECRET|points|description/);
    expect(Object.keys(items[0]).sort()).toEqual(["dueAt", "kind", "title"]);
  });

  it("still shows something due earlier today", () => {
    const items = upcomingOf(exportWith([{ name: "Lab 5", due_at: "2026-10-25T13:00:00Z" }]), NOW);
    expect(items).toHaveLength(1);
    expect(whenText(new Date(items[0].dueAt), NOW, TZ)).toBe("Today");
  });

  it("reads nothing from a file without assignments or with junk in them", () => {
    expect(upcomingOf(null, NOW)).toEqual([]);
    expect(upcomingOf({ pages: [] }, NOW)).toEqual([]);
    expect(upcomingOf(exportWith([null, 3, "x", { name: 5, due_at: "2026-11-01T00:00:00Z" }, { name: "Bad date", due_at: "soon" }]), NOW)).toEqual([]);
  });

  it("drops duplicates, non-https links, and keeps at most MAX_ITEMS", () => {
    const many = Array.from({ length: MAX_ITEMS + 10 }, (_, i) => ({ name: `HW ${i}`, due_at: new Date(NOW.getTime() + (i + 1) * 86_400_000).toISOString(), html_url: "javascript:alert(1)" }));
    const items = upcomingOf(exportWith([...many, many[0]]), NOW);
    expect(items).toHaveLength(MAX_ITEMS);
    expect(items.every((i) => i.url === undefined)).toBe(true);
  });

  const due = (i: number) => new Date(NOW.getTime() + (i + 1) * 86_400_000).toISOString();

  it("drops a link to another host than the export's own Canvas host", () => {
    const items = upcomingOf(
      exportWith([
        { name: "HW 1", due_at: due(1), html_url: "https://ufl.instructure.com/courses/1/assignments/1" },
        { name: "HW 2", due_at: due(2), html_url: "https://ufl.instructure.com/courses/1/assignments/2" },
        { name: "HW 3", due_at: due(3), html_url: "https://evil.example/courses/1/assignments/3" },
        { name: "HW 4", due_at: due(4), html_url: "https://ufl.instructure.com.evil.example/a" },
        { name: "HW 5", due_at: due(5), html_url: "https://ufl.instructure.com/courses/1/assignments/5" },
      ]),
      NOW,
    );
    expect(items.map((i) => i.url)).toEqual(["https://ufl.instructure.com/courses/1/assignments/1", "https://ufl.instructure.com/courses/1/assignments/2", undefined, undefined, "https://ufl.instructure.com/courses/1/assignments/5"]);
    expect(canvasHostOf(exportWith([{ html_url: "https://evil.example/a" }, { html_url: "https://ufl.instructure.com/b" }]))).toBeUndefined();
  });

  it("drops an http link, even on the Canvas host", () => {
    const items = upcomingOf(
      exportWith([
        { name: "HW 1", due_at: due(1), html_url: "https://ufl.instructure.com/courses/1/assignments/1" },
        { name: "HW 2", due_at: due(2), html_url: "https://ufl.instructure.com/courses/1/assignments/2" },
        { name: "HW 3", due_at: due(3), html_url: "http://ufl.instructure.com/courses/1/assignments/3" },
      ]),
      NOW,
    );
    expect(items[2].url).toBeUndefined();
    expect(canvasUrl("http://ufl.instructure.com/a", "ufl.instructure.com")).toBeUndefined();
  });
});

describe("kindOf", () => {
  it("exams, but not exam reviews or practice", () => {
    expect(kindOf({ name: "Midterm Exam" })).toBe("exam");
    expect(kindOf({ name: "Final" })).toBe("exam");
    expect(kindOf({ name: "Exam 2 Review" })).toBe("assignment");
    expect(kindOf({ name: "Practice Midterm", is_quiz_assignment: true })).toBe("quiz");
    expect(kindOf({ name: "Exam conflict request form" })).toBe("assignment");
  });
  it("quizzes from Canvas's own markers or the name", () => {
    expect(kindOf({ name: "Check-in", submission_types: ["online_quiz"] })).toBe("quiz");
    expect(kindOf({ name: "Week 3", quiz_id: 12 })).toBe("quiz");
    expect(kindOf({ name: "Quiz 4" })).toBe("quiz");
    expect(kindOf({ name: "Lab 2", submission_types: ["online_upload"] })).toBe("assignment");
  });
});

describe("dates in words", () => {
  it("counts calendar days in the student's time zone", () => {
    expect(whenText(new Date("2026-10-26T03:59:00Z"), NOW, TZ)).toBe("Today"); // 11:59 pm Oct 25 Eastern
    expect(whenText(new Date("2026-10-26T15:00:00Z"), NOW, TZ)).toBe("Tomorrow");
    expect(whenText(new Date("2026-10-30T23:00:00Z"), NOW, TZ)).toBe("In 5 days");
    expect(whenText(new Date("2026-11-22T15:00:00Z"), NOW, TZ)).toBe("In 4 weeks");
  });
  it("shows the day and time", () => {
    expect(dueText(new Date("2026-10-27T03:59:00Z"), TZ)).toBe("Mon, Oct 26 · 11:59 PM");
  });
  it("a stored list drops what has passed", () => {
    const items = upcomingOf(exportWith([{ name: "A", due_at: "2026-10-26T03:59:00Z" }, { name: "B", due_at: "2026-11-02T03:59:00Z" }]), NOW);
    expect(stillAhead(items, new Date("2026-10-27T15:00:00Z")).map((i) => i.title)).toEqual(["B"]);
  });
});

describe("the store, on this device only", () => {
  const fakeStorage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it("writes, reads back and clears one key per course", () => {
    const s = fakeStorage();
    const store = createUpcomingStore(() => s);
    const items = upcomingOf(exportWith([{ name: "Exam 2", due_at: "2026-10-30T23:00:00Z" }]), NOW);
    store.write({ course: { code: "COP3530", name: "Data Structures" }, readAt: NOW.toISOString(), items });
    expect([...s.m.keys()]).toEqual([upcomingKey("COP3530")]);
    expect(store.read("COP3530")?.items[0].title).toBe("Exam 2");
    store.clear("COP3530");
    expect(store.read("COP3530")).toBeNull();
  });

  it("keeps a memory copy when storage throws", () => {
    const store = createUpcomingStore(() => {
      throw new Error("blocked");
    });
    store.write({ course: { code: "COP3530", name: "DS" }, readAt: "", items: [] });
    expect(store.read("COP3530")?.course.name).toBe("DS");
  });

  it("refuses a malformed or old-version record", () => {
    expect(parseUpcoming("{")).toBeNull();
    expect(parseUpcoming(JSON.stringify({ v: 0, course: { code: "A", name: "B" }, items: [] }))).toBeNull();
    expect(parseUpcoming(JSON.stringify({ v: 1, course: { code: "A", name: "B" }, items: [{ title: "x", kind: "other", dueAt: "" }] }))).toBeNull();
    const ok = parseUpcoming(JSON.stringify({ v: 1, course: { code: "A", name: "B" }, readAt: "", items: [], exams: [{ title: "Exam 2", date: "2026-10-30", quote: "Exam 2 is on Oct 30", source: "Syllabus" }, { bad: 1 }] }));
    expect(ok?.exams).toHaveLength(1);
  });

  it("drops a tampered stored entry on read: another host, http, javascript:, or a link with no stored host", () => {
    const s = fakeStorage();
    const store = createUpcomingStore(() => s);
    const good = { title: "HW 1", kind: "assignment", dueAt: "2026-11-01T00:00:00.000Z", url: "https://ufl.instructure.com/courses/1/assignments/1" };
    const bad = ["https://evil.example/x", "http://ufl.instructure.com/courses/1/assignments/2", "javascript:alert(1)", "https://ufl.instructure.com/a?x=1"];
    const card = { v: 1, course: { code: "COP3530", name: "DS" }, readAt: "", host: "ufl.instructure.com", items: [good, ...bad.map((url, i) => ({ ...good, title: `Bad ${i}`, url }))] };
    s.setItem(upcomingKey("COP3530"), JSON.stringify(card));
    expect(store.read("COP3530")?.items).toEqual([good]);
    expect(parseUpcoming(JSON.stringify({ ...card, host: undefined }))?.items).toEqual([]);
  });

  it("keeps the host through a write and read back", () => {
    const s = fakeStorage();
    const store = createUpcomingStore(() => s);
    const json = exportWith([{ name: "HW 1", due_at: "2026-11-01T00:00:00Z", html_url: "https://ufl.instructure.com/courses/1/assignments/1" }]);
    store.write({ course: { code: "COP3530", name: "DS" }, readAt: "", host: canvasHostOf(json), items: upcomingOf(json, NOW) });
    expect(createUpcomingStore(() => s).read("COP3530")?.items[0].url).toBe("https://ufl.instructure.com/courses/1/assignments/1");
  });
});
