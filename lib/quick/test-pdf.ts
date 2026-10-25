// Tests only: a small, valid, SYNTHETIC PDF built in memory (never a real course file). Each page is lines of text,
// or an image-only page (a filled box and no text). Landscape pages are 792 x 612, portrait 612 x 792.

export type TestPage = { lines: string[] } | { image: true };

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export function makePdf(pages: TestPage[], o: { landscape?: boolean } = {}): Uint8Array {
  const [w, h] = o.landscape ? [792, 612] : [612, 792];
  const objs: string[] = [];
  const add = (body: string) => objs.push(body) && objs.length;
  const catalog = add("");
  const tree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const p of pages) {
    const stream = "image" in p ? "0.5 g 72 72 300 200 re f" : `BT /F1 14 Tf 72 ${h - 72} Td 18 TL ${p.lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objs[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
