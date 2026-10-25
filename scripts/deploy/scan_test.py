#!/usr/bin/env python3
# Unit tests for scripts/deploy/scan.py on invented data:  python3 -m unittest scripts/deploy/scan_test.py
import json, os, subprocess, sys, tempfile, unittest

SCAN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scan.py")

# Two 9-word lecturer lines outside every exported clip, one with ' and one with ’, and one inside.
OUTSIDE_1 = "Well it's the pivot that decides where each element"
OUTSIDE_2 = "And that’s why the partition step really matters most"
INSIDE = "Merge sort splits the array in half every single time"
CLIPS = "# Clips\n\n## Names to redact\n\nStudents' names.\n\n- Jordan Smith\n- Zoë\n- Riley (TA)\n\n## After\n- Nobody Here\n"


class ScanTest(unittest.TestCase):
    def run_scan(self, files, clips=CLIPS, bundle_line=INSIDE):
        with tempfile.TemporaryDirectory() as d:
            pipe = os.path.join(d, "root", "private", "pipeline", "COP3530")
            os.makedirs(pipe)
            segs = [{"start": 10, "end": 14, "text": OUTSIDE_1}, {"start": 20, "end": 24, "text": OUTSIDE_2}, {"start": 100, "end": 104, "text": INSIDE}]
            json.dump([{"recordedAt": "2026-10-13T16:00:00Z", "segments": segs}], open(os.path.join(pipe, "transcripts.json"), "w"))
            json.dump({"questions": []}, open(os.path.join(pipe, "output.json"), "w"))
            if clips is not None:
                open(os.path.join(d, "root", "private", "demo-clips.md"), "w", encoding="utf-8").write(clips)
            bundle = {"sets": [{"id": "2026-10-13", "questions": [{"clip": {"start": 95, "end": 110}, "lines": [{"start": 100, "end": 104, "text": bundle_line}]}]}]}
            json.dump(bundle, open(os.path.join(d, "course.json"), "w", encoding="utf-8"), ensure_ascii=False)
            open(os.path.join(d, "env"), "w").write("SECRET_KEY=abcdefghijklmnopqrstuvwxyz\n")
            out = os.path.join(d, "out")
            os.makedirs(out)
            for name, text in files.items():
                open(os.path.join(out, name), "w", encoding="utf-8").write(text)
            p = subprocess.run([sys.executable, "-I", SCAN, "--root", os.path.join(d, "root"), "--env", os.path.join(d, "env"), "--out", out, "--bundle", os.path.join(d, "course.json")], capture_output=True, text=True)
            return p.returncode, p.stdout

    def test_clean_output_passes_and_bundle_text_is_allowed(self):
        code, out = self.run_scan({"index.html": "<p>Merge sort splits the array in half every single time</p>", "a.js": 'x="Course tape"'})
        self.assertEqual(code, 0, out)
        self.assertIn("unexported text 0", out)

    def test_bare_host_names_pass_but_recording_and_course_links_fail(self):
        code, out = self.run_scan({"privacy.html": "<p>Your own Canvas course on ufl.instructure.com and recordings on ufl.zoom.us</p>"})
        self.assertEqual(code, 0, out)
        for link in ["https://ufl.zoom" + ".us/rec/" + "play/abc", "https://ufl.instructure" + ".com/courses/" + "12345"]:
            code, out = self.run_scan({"a.js": 'u="' + link + '"'})
            self.assertEqual(code, 1, out)
            self.assertNotIn("marker 0", out)

    def test_html_entity_apostrophe_is_decoded(self):
        code, out = self.run_scan({"index.html": "<p>Well it&#x27;s the pivot that decides where each element</p>"})
        self.assertEqual(code, 1, out)
        self.assertIn("unexported text 2", out)  # 9 words: two 8-word runs
        code, out = self.run_scan({"index.html": "<p>Well&nbsp;it&#39;s the pivot that decides where each element</p>"})
        self.assertEqual(code, 1, out)
        code, out = self.run_scan({"index.html": "<p>Well it&amp;#x27;s the pivot that decides where each element</p>"})
        self.assertEqual(code, 1, out)

    def test_curly_apostrophe_raw_and_json_escaped(self):
        code, out = self.run_scan({"index.html": "<p>And that’s why the partition step really matters most</p>"})
        self.assertEqual(code, 1, out)
        code, out = self.run_scan({"page.rsc": '["$","p",null,{"children":"And that\\u2019s why the partition\\nstep really matters most"}]'})
        self.assertEqual(code, 1, out)
        self.assertIn("unexported text 2", out)

    def test_split_on_any_non_letter_run(self):
        code, out = self.run_scan({"a.js": 'f("Well it\\u0027s the pivot that—decides\\twhere each element")'})
        self.assertEqual(code, 1, out)

    def test_listed_names_fail_in_build_output(self):
        for text in ("<p>thanks Riley</p>", '{"t":"Zo\\u00eb asked"}', "<p>Jordan&nbsp;Smith</p>", "<p>SMITH</p>"):
            code, out = self.run_scan({"index.html": text})
            self.assertEqual(code, 1, text + " " + out)
            self.assertNotIn("name 0", out)
        code, out = self.run_scan({"index.html": "<p>Zoëlle and Rileya</p>"})  # whole words only
        self.assertEqual(code, 0, out)

    def test_listed_name_in_bundle_fails(self):
        code, out = self.run_scan({}, bundle_line="Good question Riley, merge sort splits it")
        self.assertEqual(code, 1, out)
        self.assertIn("in the demo bundle", out)

    def test_missing_or_empty_name_list_fails(self):
        for clips in (None, "# Clips\n\n## The three clips\n- Jordan\n", "## Names to redact\n\nNone yet.\n\n## After\n- Someone\n"):
            code, out = self.run_scan({"index.html": "<p>ok</p>"}, clips=clips)
            self.assertEqual(code, 1, out)
            self.assertIn("refusing", out)


if __name__ == "__main__":
    unittest.main()
