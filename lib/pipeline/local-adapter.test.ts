import { describe, expect, it } from "vitest";
import { chunksFromDocs } from "./local-adapter";

describe("chunksFromDocs", () => {
  it("makes one slide chunk per non-empty deck page and document chunks for the stand-in review, with Canvas links", () => {
    const chunks = chunksFromDocs(
      [
        { itemId: "file:7", fileId: 7, name: "8a - Graphs", role: "lecture", pages: [{ page: 1, text: "Graphs" }, { page: 2, text: " " }, { page: 3, text: "Edges" }] },
        { itemId: "local:review", fileId: null, name: "Practice", role: "review", pages: [{ page: 1, text: "Q1? (A) x (B) y" }] },
      ],
      424244,
    );
    expect(chunks.map((c) => c.id)).toEqual(["file:7#p1", "file:7#p3", "local:review#p1"]);
    expect(chunks[1].source).toEqual({ kind: "slide", itemId: "file:7", fileId: 7, page: 3, deck: "8a - Graphs", href: "https://ufl.instructure.com/courses/424244/files/7#page=3" });
    expect(chunks[2]).toMatchObject({ role: "review", source: { kind: "document", name: "Practice", page: 1, href: undefined } });
  });
});
