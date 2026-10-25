# The "Rewind" wordmark as one SVG path (Bricolage Grotesque ExtraBold, shaped with HarfBuzz so the
# kerning matches the browser), so the logo SVGs need no font. Writes scripts/brand/wordmark.json.
# One-off: pip install fonttools uharfbuzz; python3 scripts/brand/wordmark-path.py <BricolageGrotesque-ExtraBold.ttf>
import json, sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

FONT, TEXT, SIZE, TRACK = sys.argv[1], "Rewind", 100.0, -0.023  # TRACK in em: the header's -0.5 px at 22 px

face = hb.Face(hb.Blob.from_file_path(FONT))
buf = hb.Buffer()
buf.add_str(TEXT)
buf.guess_segment_properties()
hb.shape(hb.Font(face), buf)
tt = TTFont(FONT)
glyphs, order, upm = tt.getGlyphSet(), tt.getGlyphOrder(), tt["head"].unitsPerEm
scale = SIZE / upm
pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
x = 0.0
for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
    glyphs[order[info.codepoint]].draw(TransformPen(pen, (scale, 0, 0, -scale, (x + pos.x_offset) * scale, 0)))
    x += pos.x_advance + TRACK * upm
out = {
    "text": TEXT,
    "size": SIZE,
    "d": pen.getCommands(),
    "width": round((x - TRACK * upm) * scale, 2),
    "capHeight": round(tt["OS/2"].sCapHeight * scale, 2),
}
json.dump(out, open("scripts/brand/wordmark.json", "w"), indent=2)
print(f"wordmark: {out['width']} x cap {out['capHeight']} at {SIZE}")
