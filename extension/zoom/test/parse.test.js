// Run: node extension/zoom/test/parse.test.js
// Unit tests on a small invented page, then the real saved page if it exists
// (private/fixtures/zoom-recording.html, gitignored). The real-page checks compare the
// parser against an independent regex read of the raw HTML, so no real names or lecture
// text are written into this file.

// Exits non-zero if a test never settles (the event loop drains with a promise pending).
var finished = false;
process.on('exit', function () {
  if (!finished) {
    console.log('FAIL a test never finished');
    process.exitCode = 1;
  }
});

(async function () {
  var fs = await import('node:fs');
  var path = await import('node:path');
  var vm = await import('node:vm');
  var assert = (await import('node:assert')).strict;

  var here = path.dirname(process.argv[1]);
  var root = path.join(here, '..', '..', '..');
  var ctx = vm.createContext({ console: console });
  vm.runInContext(fs.readFileSync(path.join(here, 'mini-dom.js'), 'utf8') + '\nthis.miniDom = createMiniDom();', ctx);
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'transcript.js'), 'utf8') + '\nthis.RewindZoom = RewindZoom;', ctx);
  var Z = ctx.RewindZoom;
  var parseHtml = ctx.miniDom.parse;
  var plain = function (x) { return JSON.parse(JSON.stringify(x)); };

  // Mirrors the fixture's structure with invented content.
  function li(name, h, m, s, text, shown) {
    var label = name + ', ' + h + ' hours ' + m + ' minutes ' + s + ' seconds, ' + text;
    var head = shown
      ? '<div class="user-info"><div class="user-profile-info"><div class="user-name"><span title="' + name +
        '" class="user-name-span">' + name + '</span></div></div><div class="user-info-right"><span class="time">' +
        shown + '</span></div></div>'
      : '<!---->';
    return '<li aria-label="' + label.replace(/"/g, '&quot;') + '" class="transcript-list-item">' + head +
      '<div class="timeline"><div class="text">' + text.replace(/&/g, '&amp;') + '</div><!----></div></li>';
  }
  var FAKE = '<html><head><title>Fake - Zoom</title></head><body>' +
    '<h1 class="r-title recording-topic"><span class="topic">Fake Course - Lecture</span></h1>' +
    '<span class="info-container-time">Oct 22, 2026 01:48 PM</span>' +
    '<audio class="vjs-tech" src="https://example.invalid/GMT20261022-174809_Recording.m4a?a=1&amp;b=2"></audio>' +
    '<span class="vjs-time-range-duration">00:02:00</span>' +
    '<div class="tab-panel"><ul class="transcript-list">' +
    li('Prof X', 0, 0, 4, 'Hello everyone, welcome back. Today: stacks & queues!', '00:00:04') +
    li('Prof X', 0, 0, 30, 'A stack is last in, first out. A queue is first in, first out.') +
    li('Student Y', 0, 1, 0, 'Is 3.5 the answer?', '00:01:00') +
    li('Prof X', 0, 1, 20, 'No, it is four. Good question.', '00:01:20') +
    '</ul></div><img src="x.png"><br></body></html>';

  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  test('parseTime: h:mm:ss with and without leading zeros, mm:ss, m:ss', function () {
    assert.equal(Z.parseTime('00:35:18'), 2118);
    assert.equal(Z.parseTime('0:35:18'), 2118);
    assert.equal(Z.parseTime('1:02:15'), 3735);
    assert.equal(Z.parseTime('01:02:15'), 3735);
    assert.equal(Z.parseTime('02:00:10'), 7210);
    assert.equal(Z.parseTime('43:40'), 2620);
    assert.equal(Z.parseTime('05:07'), 307);
    assert.equal(Z.parseTime('5:07'), 307);
    assert.equal(Z.parseTime(' 00:00:04 '), 4);
    for (var bad of ['', 'abc', '1:2', '1:60', '1:60:00', '1:2:3:4', '12']) assert.equal(Z.parseTime(bad), null, bad);
  });

  test('parseAriaLabel reads speaker, time and text (text may contain commas)', function () {
    assert.deepEqual(plain(Z.parseAriaLabel('Prof X, 1 hours 2 minutes 3 seconds, So, yes, this.')),
      { speaker: 'Prof X', start: 3723, text: 'So, yes, this.' });
    assert.equal(Z.parseAriaLabel('nothing here'), null);
  });

  // Same numbers as lib/transcript.test.ts (the lead's reference for the shared rule).
  var s1 = 'The first idea is that a tree has a single root.';
  var s2 = 'The second idea is that every child has a parent.';
  var s3 = 'The third idea is that leaves have no children.';
  var s4 = 'The fourth idea is that height counts edges. Ok.';
  var REF = { start: 100, end: 130, speaker: 'Dr. Lee', text: s1 + '  ' + s2 + '\n' + s3 + ' ' + s4 };

  test('splitChunk: places sentences by character position (reference case)', function () {
    assert.deepEqual(plain(Z.splitChunk(REF)), [
      { speaker: 'Dr. Lee', start: 100, end: 107.5, text: s1 },
      { speaker: 'Dr. Lee', start: 107.5, end: 115.2, text: s2, estimated: true },
      { speaker: 'Dr. Lee', start: 115.2, end: 122.6, text: s3, estimated: true },
      { speaker: 'Dr. Lee', start: 122.6, end: 130, text: s4, estimated: true }
    ]);
  });

  test('splitChunk: caps the span at 5 chars/s when the chunk is mostly silence', function () {
    var out = plain(Z.splitChunk(Object.assign({}, REF, { end: 400 })));
    assert.deepEqual(out.map(function (x) { return x.start; }), [100, 109.8, 119.8, 129.4]);
    assert.equal(out[3].end, 400);
  });

  test('splitChunk: leaves chunks of 20 s or less alone', function () {
    assert.deepEqual(plain(Z.splitChunk(Object.assign({}, REF, { end: 120 }))), [
      { speaker: 'Dr. Lee', start: 100, end: 120, text: s1 + ' ' + s2 + ' ' + s3 + ' ' + s4 }
    ]);
  });

  test('splitChunk: merges short pieces into the next one', function () {
    var out = plain(Z.splitChunk({ start: 0, end: 60, speaker: null, text: 'Okay. So. A heap is a complete tree. Right.' }));
    assert.deepEqual(out.map(function (x) { return x.text; }), ['Okay. So. A heap is a complete tree. Right.']);
  });

  test('invented page: chunks, carried-over speakers, metadata', function () {
    var t = plain(Z.buildTranscript(parseHtml(FAKE), 'https://ufl.zoom.us/rec/play/fake'));
    assert.equal(t.source, 'zoom');
    assert.equal(t.title, 'Fake Course - Lecture');
    assert.equal(t.recordedAt, '2026-10-22T17:48:09Z');
    assert.equal(t.durationSec, 120);
    assert.deepEqual(t.chunks, [
      { start: 4, end: 30, speaker: 'Prof X', text: 'Hello everyone, welcome back. Today: stacks & queues!' },
      { start: 30, end: 60, speaker: 'Prof X', text: 'A stack is last in, first out. A queue is first in, first out.' },
      { start: 60, end: 80, speaker: 'Student Y', text: 'Is 3.5 the answer?' },
      { start: 80, end: 120, speaker: 'Prof X', text: 'No, it is four. Good question.' }
    ]);
    assert.equal(Z.transcriptFilename(t), 'Fake_Course_-_Lecture_2026-10-22.transcript.json');
  });

  test('invented page: chunks over 20 s are split, short ones kept as they are', function () {
    var t = plain(Z.buildTranscript(parseHtml(FAKE), 'u'));
    // 4-30 s and 30-60 s split; 60-80 s stays whole; 80-120 s stays one piece because the
    // 15-character "No, it is four." merges with the next. Span is capped at chars / 5:
    // 53 chars -> 10.6 s, so 4 + 10.6 * 30/53 = 10.0; 62 chars -> 12.4 s, so 30 + 12.4 * 31/62 = 36.2.
    assert.deepEqual(t.segments.map(function (x) { return [x.start, x.end, x.text, !!x.estimated]; }), [
      [4, 10, 'Hello everyone, welcome back.', false],
      [10, 30, 'Today: stacks & queues!', true],
      [30, 36.2, 'A stack is last in, first out.', false],
      [36.2, 60, 'A queue is first in, first out.', true],
      [60, 80, 'Is 3.5 the answer?', false],
      [80, 120, 'No, it is four. Good question.', false]
    ]);
    assert.equal(t.chunks.length, 4);
  });

  test('chunks is left out when nothing needed splitting', function () {
    var short = FAKE.replace('00:02:00', '00:01:30').replace(/0 hours 0 minutes 4 seconds/, '0 hours 0 minutes 20 seconds')
      .replace('>00:00:04<', '>00:00:20<').replace(/0 hours 0 minutes 30 seconds/, '0 hours 0 minutes 40 seconds');
    var t = plain(Z.buildTranscript(parseHtml(short), 'u'));
    assert.deepEqual(t.segments.map(function (x) { return x.end - x.start; }), [20, 20, 20, 10]);
    assert.equal('chunks' in t, false);
    assert.ok(t.segments.every(function (x) { return !('estimated' in x); }));
  });

  test('recordedAtFromText falls back to page-local time', function () {
    assert.equal(Z.recordedAtFromText('Oct 22, 2026 01:48 PM'), '2026-10-22T13:48:00');
    assert.equal(Z.recordedAtFromText('Jan 3, 2027 12:05 AM'), '2027-01-03T00:05:00');
    assert.equal(Z.recordedAtFromText('soon'), null);
  });

  test('seek fallback picks the last chunk starting at or before N', function () {
    var doc = parseHtml(FAKE);
    var label = function (el) { return Z.parseAriaLabel(el.getAttribute('aria-label')).start; };
    assert.equal(label(Z.chunkElementFor(doc, 59)), 30);
    assert.equal(label(Z.chunkElementFor(doc, 60)), 60);
    assert.equal(label(Z.chunkElementFor(doc, 0)), 4);
    assert.equal(label(Z.chunkElementFor(doc, 9999)), 80);
  });

  var FIXTURE = path.join(root, 'private', 'fixtures', 'zoom-recording.html');
  var haveFixture = fs.existsSync(FIXTURE);

  if (haveFixture) {
    var html = fs.readFileSync(FIXTURE, 'utf8');
    var t = plain(Z.buildTranscript(parseHtml(html), 'https://ufl.zoom.us/rec/play/fixture'));
    var items = t.chunks || t.segments;

    // Independent read of the raw HTML: every transcript <li>, its aria-label and visible time.
    var decode = function (s) {
      return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    };
    var raw = [];
    var liRe = /<li [^>]*class="transcript-list-item"[^>]*>[\s\S]*?<\/li>/g;
    var m;
    while ((m = liRe.exec(html))) {
      var aria = decode(m[0].match(/aria-label="([^"]*)"/)[1]);
      var am = aria.match(/^(.*?), (\d+) hours (\d+) minutes (\d+) seconds, ([\s\S]*)$/);
      var shown = m[0].match(/class="time">([^<]*)</);
      raw.push({
        speaker: am[1],
        start: +am[2] * 3600 + +am[3] * 60 + +am[4],
        shown: shown ? shown[1].trim() : null,
        text: am[5].replace(/\s+/g, ' ').trim()
      });
    }
    var durationText = html.match(/class="vjs-time-range-duration">([^<]*)</)[1];

    test('fixture: every transcript chunk on the page is parsed (at least 35)', function () {
      assert.ok(raw.length >= 35, 'page has ' + raw.length + ' chunks');
      assert.equal(items.length, raw.length);
      console.log('     page chunks: ' + raw.length + ', segments: ' + t.segments.length +
        ', speakers: ' + new Set(items.map(function (c) { return c.speaker; })).size +
        ', span ' + items[0].start + 's to ' + items[items.length - 1].start + 's, duration ' + t.durationSec + 's');
    });

    test('fixture: speakers, times and text match the page', function () {
      raw.forEach(function (r, i) {
        var c = items[i];
        assert.equal(c.speaker, r.speaker, 'speaker #' + i);
        assert.equal(c.start, r.start, 'start #' + i);
        if (r.shown) assert.equal(c.start, Z.parseTime(r.shown), 'shown time #' + i);
        assert.equal(c.text, r.text, 'text #' + i);
        assert.equal(c.end, i + 1 < raw.length ? raw[i + 1].start : Z.parseTime(durationText), 'end #' + i);
      });
    });

    test('fixture: metadata', function () {
      assert.equal(t.durationSec, Z.parseTime(durationText));
      assert.ok(t.title && t.title !== 'Zoom recording');
      assert.match(t.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    test('fixture: segments follow the shared splitting rule, starts non-decreasing', function () {
      var expected = [];
      items.forEach(function (c) { expected = expected.concat(plain(Z.splitChunk(c))); });
      assert.deepEqual(t.segments, expected);
      assert.ok(t.segments.length >= 100, t.segments.length + ' segments');
      var prev = -1;
      t.segments.forEach(function (x, i) {
        assert.ok(x.text.length > 0);
        assert.ok(x.start >= prev, 'start #' + i + ' non-decreasing');
        assert.ok(x.end >= x.start, 'end #' + i);
        prev = x.start;
      });
      // Every page item's real (aria-label) start is kept as an unestimated segment start.
      var real = t.segments.filter(function (x) { return !x.estimated; }).map(function (x) { return x.start; });
      assert.deepEqual(real, raw.map(function (r) { return r.start; }));
      var split = items.filter(function (c) { return c.end - c.start > 20; }).length;
      console.log('     items over 20 s: ' + split + ', segments: ' + t.segments.length +
        ', estimated: ' + t.segments.filter(function (x) { return x.estimated; }).length);
    });
  }

  var failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try {
      await tests[i].fn();
      console.log('ok   ' + tests[i].name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + tests[i].name + '\n     ' + e.message);
    }
  }
  if (!haveFixture) console.log('SKIP fixture tests: private/fixtures/zoom-recording.html not found');
  console.log((tests.length - failed) + '/' + tests.length + ' passed');
  finished = true;
  if (failed) process.exitCode = 1;
})();
