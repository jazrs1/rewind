import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { deckName, itemsToText, pdfFile, readPdfPages, type PdfLike } from "./pdf.ts";
import { makePdf } from "./test-pdf.ts";

const read = async (bytes: Uint8Array) => readPdfPages((await getDocumentProxy(bytes)) as unknown as PdfLike);

describe("PDF text, page by page (a synthetic PDF made here)", () => {
  it("keeps each page's number and text, and skips image-only pages", async () => {
    const pages = await read(
      makePdf([
        { lines: ["Hash tables", "A hash table maps keys to buckets."] },
        { image: true },
        { lines: ["Linear probing (open addressing)", "A collision moves to the next free slot."] },
      ]),
    );
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pages[0].text).toContain("A hash table maps keys to buckets.");
    expect(pages[2].text).toContain("Linear probing (open addressing)");
    expect(pages[1].text).toBe("");
    const f = pdfFile("Week 3 Hashing.pdf", pages);
    expect(f).toMatchObject({ deck: "Week 3 Hashing", kind: "document", skipped: 1 });
    expect(f.pages.map((p) => p.page)).toEqual([1, 3]);
  });

  it("calls a mostly-landscape file slides", async () => {
    const pages = await read(makePdf([{ lines: ["Slide one text here"] }, { lines: ["Slide two text here"] }], { landscape: true }));
    expect(pages.every((p) => p.landscape)).toBe(true);
    expect(pdfFile("Lecture 5.pdf", pages).kind).toBe("slide");
  });

  it("joins text items into lines, keeps code from looking like HTML, and names the deck from the file", () => {
    expect(itemsToText([{ str: "vector<int> v;", hasEOL: true }, { str: "  next\u0007 line " }, { notText: 1 }])).toBe("vector< int> v;\nnext line");
    expect(deckName("folder/Week 3 <b>Slides.pdf")).toBe("Week 3 b Slides");
    expect(deckName(".pdf")).toBe("Untitled file");
  });
});
