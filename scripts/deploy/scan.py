#!/usr/bin/env python3
# The deploy scan (scripts/deploy/preview.sh, production.sh): fails when a build output holds a
# secret value, a recording or Canvas link, a real course id, a student's name from the redaction
# list, or real course text that is NOT in the approved demo bundle (public/demo/course/, which may
# quote the lectures inside its clips). Prints counts only, never the text.
#   python3 scripts/deploy/scan.py --root <repo with private/> --env <env file> --out <build output> [--bundle <course.json>]
# Tests: python3 -m unittest scripts/deploy/scan_test.py
import argparse, glob, html, json, os, re, sys

ap = argparse.ArgumentParser()
ap.add_argument("--root", required=True)
ap.add_argument("--env", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--bundle", default="public/demo/course/course.json")
a = ap.parse_args()

def refuse(why):
    print("refusing: " + why)
    sys.exit(1)

vals = []
for line in open(a.env):
    m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
    if m and not m.group(1).startswith("NEXT_PUBLIC") and len(m.group(2).strip().strip('"')) >= 16:
        vals.append(m.group(2).strip().strip('"').encode())
# Recording and Canvas course links, the lecturer's first name (the bundle says "Professor Kapoor"), old slide names.
# Links only, not bare host names: the privacy and extension pages name ufl.instructure.com and ufl.zoom.us.
markers = [b"/rec/play/", b"/rec/share/", b"zoom.us/rec", b"instructure.com/courses/", b"Amanpree" b"t", b"quaternar" b"y", b"hashtables-p8" b"4"]
# Real Canvas course ids, from private/<CODE>.course.json (as lib/real-text.ts reads them).
for f in glob.glob(os.path.join(a.root, "private", "*.course.json")):
    cid = str((json.load(open(f)).get("course") or {}).get("id") or "")
    if re.fullmatch(r"\d{4,}", cid):
        markers.append(cid.encode())

# Students' names: the "## Names to redact" list in private/demo-clips.md, read as
# parseRedactList (lib/demo/export.ts) reads it. No list, no deploy.
notes = next((p for p in (os.path.join(a.root, "private", "demo-clips.md"), os.path.join(a.root, ".cache", "demo-clips.md")) if os.path.exists(p)), None)
if not notes:
    refuse("no private/demo-clips.md with its Names to redact list")
parts = re.split(r"^## Names to redact[ \t]*$", open(notes, encoding="utf-8").read(), flags=re.M)
if len(parts) < 2:
    refuse('demo-clips.md has no "## Names to redact" section')
names = set()
for entry in re.findall(r"^[-*][ \t]+(.+)$", re.split(r"^## ", parts[1], flags=re.M)[0], flags=re.M):
    name = re.sub(r"\(.*?\)", " ", entry).strip()
    if not re.fullmatch(r"[^\W\d_][\w'’ .-]*", name) or re.search(r"[\d_]", name):
        refuse("demo-clips.md: an entry in Names to redact isn't a name")
    names.add(" ".join(name.split()).lower())
    names.update(w.lower() for w in re.split(r"[\s.]+", name) if len(w) >= 2)
if not names:
    refuse('demo-clips.md lists no "## Names to redact"')

JSON_ESC = re.compile(r"\\u([0-9a-fA-F]{4})|\\([nrtbf])|\\([\"\\/'])")
def decode(text):
    """Undo JSON string escapes and HTML entities (twice over, for &amp;#x27;), as a page shows the text."""
    for _ in range(3):
        before = text
        text = JSON_ESC.sub(lambda m: chr(int(m.group(1), 16)) if m.group(1) else " " if m.group(2) else m.group(3), text)
        text = html.unescape(text)
        if text == before:
            break
    return text

def words(text):
    """Lower-case letter runs; apostrophes inside a word are dropped (it's, it’s → its); any other non-letter splits."""
    text = re.sub(r"(?<=[^\W\d_])['’‘ʼ](?=[^\W\d_])", "", decode(text).lower())
    return re.findall(r"[^\W\d_]+", text)

def name_hits(text):
    w = words(text)
    joined = " " + " ".join(w) + " "
    return sum(1 for n in names if (" " + " ".join(words(n)) + " ") in joined)

# Real text NOT in the bundle: lecturer lines outside every exported clip, and questions left out.
bundle_raw = open(a.bundle, encoding="utf-8").read()
bundle = json.loads(bundle_raw)
spans = {s["id"]: [(q["clip"]["start"], q["clip"]["end"]) for q in s["questions"]] for s in bundle["sets"]}
shipped = json.dumps(bundle, ensure_ascii=False)
if name_hits(bundle_raw):
    refuse("a name from Names to redact is in the demo bundle")
def in_bundle(text):
    return text in shipped or json.dumps(text, ensure_ascii=False)[1:-1] in shipped
pipe = os.path.join(a.root, "private", "pipeline", "COP3530")
if not os.path.exists(os.path.join(pipe, "transcripts.json")):
    refuse("no private/pipeline/COP3530 to sample unexported text from")
RUN = 8  # words, as lib/real-text.ts
def runs_of(texts):
    out = set()
    for text in texts:
        w = words(text)
        out.update(" ".join(w[i:i + RUN]) for i in range(len(w) - RUN + 1))
    return out
unexported = []
for t in json.load(open(os.path.join(pipe, "transcripts.json"), encoding="utf-8")):
    day = (t.get("recordedAt") or "")[:10]
    unexported += [s["text"] for s in t["segments"] if not in_bundle(s["text"]) and not any(x - 1 <= s["start"] < y for x, y in spans.get(day, []))]
unexported += [q["stem"] for q in json.load(open(os.path.join(pipe, "output.json"), encoding="utf-8"))["questions"] if not in_bundle(q["stem"])]
# Every 8-word run of real text that isn't in the bundle (runs the bundle itself has don't count).
runs = runs_of(unexported) - runs_of([shipped])

hits = {"secret": 0, "marker": 0, "name": 0, "unexported text": 0}
for dp, _, fs in os.walk(a.out):
    for fn in fs:
        try:
            b = open(os.path.join(dp, fn), "rb").read()
        except OSError:
            continue
        hits["secret"] += sum(v in b for v in vals)
        hits["marker"] += sum(m in b for m in markers)
        if b"\0" not in b[:4096]:  # text files only (images and fonts can't hold a sentence)
            text = b.decode("utf-8", "replace")
            hits["name"] += name_hits(text)
            w = words(text)
            hits["unexported text"] += sum(" ".join(w[i:i + RUN]) in runs for i in range(len(w) - RUN + 1))
print("scan: %d runs of unexported text, %d markers, %d names; hits: %s" % (len(runs), len(markers), len(names), ", ".join("%s %d" % kv for kv in hits.items())))
sys.exit(1 if sum(hits.values()) else 0)
