import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { DownloadResult } from "./download";
import type { ItemRole } from "../schema";
import { canvasPageRole, captionText, docxText, extractCourse, htmlToText, pptxSlides, readZip } from "./extract";

// A minimal zip writer for invented PPTX/DOCX fixtures (deflated entries).
function zip(entries: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = enc.encode(name);
    const data = new Uint8Array(deflateRawSync(enc.encode(text)));
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...locals, ...centrals, eocd];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

const slide = (lines: string[]) => `<p:sld><p:cSld><p:spTree>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:spTree></p:cSld></p:sld>`;

const dl = (fileId: number, ext: DownloadResult["ext"], name: string, role = "lecture"): DownloadResult =>
  ({ fileId, itemId: `file:${fileId}`, name, role, ext, file: `${fileId}.${ext}`, status: "downloaded" });

describe("htmlToText", () => {
  it("keeps paragraphs, list items and links, drops tags and decodes entities", () => {
    const html = '<h2>Exams</h2><p>Exam 2 is on <strong>Nov&nbsp;5</strong> &amp; covers trees.</p><ul><li>Bring a pencil</li></ul>' +
      '<p>Details: <a href="https://ufl.instructure.com/courses/1/pages/exam-2">exam page</a></p><script>x()</script>';
    expect(htmlToText(html)).toBe("Exams\nExam 2 is on Nov 5 & covers trees.\n\n- Bring a pencil\n\nDetails: exam page (https://ufl.instructure.com/courses/1/pages/exam-2)");
    expect(htmlToText(null)).toBe("");
  });

  it("drops query strings from links (Canvas verifier= tokens), in hrefs and in plain text", () => {
    const html =
      '<p>Slides: <a href="https://ufl.instructure.com/courses/1/files/22?verifier=SECRET123&amp;wrap=1">Week 3</a></p>' +
      '<p><a href="https://ufl.instructure.com/courses/1/files/23/download?verifier=SECRET456">https://ufl.instructure.com/courses/1/files/23/download?verifier=SECRET456</a></p>' +
      "<p>Or paste https://ufl.instructure.com/courses/1/files/24?verifier=SECRET789 into the browser.</p>";
    const text = htmlToText(html);
    expect(text).toBe("Slides: Week 3 (https://ufl.instructure.com/courses/1/files/22)\nhttps://ufl.instructure.com/courses/1/files/23/download\nOr paste https://ufl.instructure.com/courses/1/files/24 into the browser.");
    expect(text).not.toMatch(/verifier|SECRET/);
  });
});

describe("zip formats", () => {
  it("reads PPTX slides in slide order and DOCX paragraphs", () => {
    const pptx = zip({
      "ppt/slides/slide10.xml": slide(["Ten"]),
      "ppt/slides/slide2.xml": slide(["Heaps", "sift &amp; swap"]),
      "ppt/slides/slide1.xml": slide(["Intro"]),
      "ppt/slides/_rels/slide1.xml.rels": "<x/>",
    });
    expect(readZip(pptx).size).toBe(4);
    expect(pptxSlides(pptx)).toEqual(["Intro", "Heaps\nsift & swap", "Ten"]);
    const docx = zip({ "word/document.xml": '<w:body><w:p><w:r><w:t>Review</w:t></w:r><w:r><w:t xml:space="preserve"> sheet</w:t></w:r></w:p><w:p><w:r><w:t>Q1</w:t></w:r></w:p></w:body>' });
    expect(docxText(docx)).toBe("Review sheet\nQ1");
  });

  it("strips caption timings", () => {
    expect(captionText("WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n<v Prof>Hello class.\n\n2\n00:00:05.000 --> 00:00:06.000\nToday: heaps.")).toBe("Hello class.\nToday: heaps.");
  });
});

describe("extractCourse", () => {
  const files: Record<string, Uint8Array> = {
    "1.pdf": new Uint8Array([1]),
    "2.pdf": new Uint8Array([2]),
    "3.pptx": zip({ "ppt/slides/slide1.xml": slide(["Graphs", "BFS and DFS"]) }),
    "4.vtt": new TextEncoder().encode("WEBVTT\n\n00:00.000 --> 00:02.000\nToday graphs."),
  };
  const deps = {
    read: async (f: string) => files[f],
    pdfText: async (b: Uint8Array) => (b[0] === 1 ? ["Binary heaps   complete tree", "Insert sifts up"] : ["", " 3 ", ""]),
  };
  const exp = {
    course: { id: 7, name: "Fake DS", course_code: "FAKE7" },
    syllabus_body: "<p>Exam 1: Oct 1</p>",
    pages: [{ url: "week-1", title: "Week 1", body: "<p>Read chapter 1</p>" }, { url: "empty", title: "Empty", body: "" }],
    announcements: [{ id: 9, title: "Action Items Week 3", message: "<p>Quiz 3 due Friday</p>", posted_at: "2026-09-10T12:00:00Z" }],
    assignments: [{ id: 5, name: "Exam 2", due_at: "2026-11-05T23:00:00Z", description: "<p>In class</p>" }],
  };

  it("extracts files page by page and the export's own text", async () => {
    const docs = await extractCourse(exp, [dl(1, "pdf", "Lecture 1.pdf"), dl(2, "pdf", "Scanned.pdf"), dl(3, "pptx", "Graphs.pptx"), dl(4, "vtt", "Talk.vtt", "transcript")], deps);
    expect(docs.map((d) => [d.itemId, d.name, d.role, d.pages.length, d.problem ?? null])).toEqual([
      ["file:1", "Lecture 1", "lecture", 2, null],
      ["file:2", "Scanned", "lecture", 3, "no text layer"],
      ["file:3", "Graphs", "lecture", 1, null],
      ["file:4", "Talk", "transcript", 1, null],
      ["syllabus:7", "Syllabus", "syllabus", 1, null],
      ["page:week-1", "Week 1", "unknown", 1, null],
      ["announcement:9", "Action Items Week 3", "admin", 1, null],
      ["assignment:5", "Exam 2", "homework", 1, null],
    ]);
    expect(docs[0].pages[0].text).toBe("Binary heaps complete tree");
    expect(docs[2].pages[0].text).toBe("Graphs\nBFS and DFS");
    expect(docs[3].pages[0].text).toBe("Today graphs.");
    expect(docs[6].pages[0].text).toBe("Action Items Week 3\nQuiz 3 due Friday");
    // Only Canvas's own text: due_at is metadata, never written into the text as a quotable "Due: …Z".
    expect(docs[7].pages[0].text).toBe("Exam 2\nIn class");
    expect(docs.some((d) => d.pages.some((p) => p.text.includes("2026-11-05T23")))).toBe(false);
  });

  it("gives Canvas pages role \"page\" unless the title says admin, syllabus or review", async () => {
    expect(["unknown", "lecture", "practice", "admin", "syllabus", "review"].map((r) => canvasPageRole(r as ItemRole))).toEqual(["page", "page", "page", "admin", "syllabus", "review"]);
    const docs = await extractCourse(exp, [], deps, { pageRole: (title) => canvasPageRole(title.startsWith("Week") ? "unknown" : "admin") });
    expect(docs.find((d) => d.itemId === "page:week-1")).toMatchObject({ role: "page", pages: [{ page: 1, text: "Read chapter 1" }] });
  });

  it("records a failed download and an unreadable file as problems", async () => {
    const failed: DownloadResult = { ...dl(8, "pdf", "Gone.pdf"), file: null, status: "failed", reason: "needs a signed URL" };
    const broken = dl(3, "docx", "Broken.docx");
    const docs = await extractCourse({ course: exp.course }, [failed, { ...broken, file: "1.pdf" }], deps);
    expect(docs[0]).toMatchObject({ itemId: "file:8", pages: [], problem: "needs a signed URL" });
    expect(docs[1].problem).toMatch(/couldn't read the file/);
  });
});
