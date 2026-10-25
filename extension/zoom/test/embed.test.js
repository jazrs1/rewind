// Run: node extension/zoom/test/embed.test.js
// Embed mode (T9) on the fake DOM: an invented page, then the saved real page if present.
// "Hidden" is modelled from the injected CSS: with the class on <html>, visibility is hidden
// on <body> and inherited by everything except the marked media element (and its children).

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
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'embed.js'), 'utf8') + '\nthis.E = RewindZoomEmbed;', ctx);
  var E = ctx.E;
  var parseHtml = ctx.miniDom.parse;
  var MEDIA = 'audio, video';

  var PAGE = '<html class="zoom-root"><head><title>Fake recording</title></head><body>' +
    '<header class="rec-header-container"><h1><span class="topic">Fake Course - Lecture</span></h1></header>' +
    '<div class="player"><div class="video-js"><video class="vjs-tech" src="x.mp4"></video>' +
    '<div class="vjs-control-bar"><button>Play</button></div></div></div>' +
    '<div class="tab-panel"><ul class="transcript-list"><li class="transcript-list-item">Hello.</li></ul></div>' +
    '<button id="rewind-export-transcript">Rewind: export transcript</button>' +
    '</body></html>';

  function classes(el) {
    return (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }

  function hidden(doc, el) {
    if (classes(doc.documentElement).indexOf(E.ON_CLASS) < 0) return false;
    var inBody = false;
    for (var p = el; p; p = p.parent) {
      if (p.tagName && classes(p).indexOf(E.MEDIA_CLASS) >= 0) return false;
      if (p.tagName === 'body') inBody = true;
    }
    return inBody;
  }

  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  test('on: adds the html class, one style element, and marks the media element', function () {
    var doc = parseHtml(PAGE);
    var mode = E.createEmbedMode({ doc: doc, mediaSelector: MEDIA });
    assert.deepEqual(JSON.parse(JSON.stringify(mode.set(true))), { ok: true, on: true });
    assert.deepEqual(classes(doc.documentElement), ['zoom-root', E.ON_CLASS]);
    var style = doc.getElementById(E.STYLE_ID);
    assert.ok(style, 'style injected');
    assert.equal(style.parent.tagName, 'head');
    assert.ok(classes(doc.querySelector('video')).indexOf(E.MEDIA_CLASS) >= 0);
    mode.set(true);
    assert.equal(doc.querySelectorAll('style').length, 1, 'turning on twice adds one style');
    assert.equal(mode.isOn(), true);
  });

  test("on: Zoom's UI is hidden and the media fills the frame on black", function () {
    var doc = parseHtml(PAGE);
    E.createEmbedMode({ doc: doc, mediaSelector: MEDIA }).set(true);
    ['.rec-header-container', '.vjs-control-bar', '.tab-panel', '.transcript-list-item', '#rewind-export-transcript']
      .forEach(function (sel) { assert.equal(hidden(doc, doc.querySelector(sel)), true, sel + ' hidden'); });
    assert.equal(hidden(doc, doc.querySelector('video')), false, 'video visible');
    var css = doc.getElementById(E.STYLE_ID).textContent;
    assert.match(css, /html\.rewind-embed body \{ visibility: hidden !important; \}/);
    var rule = css.slice(css.indexOf('.' + E.MEDIA_CLASS + ' {'));
    ['visibility: visible', 'position: fixed', 'inset: 0', 'width: 100vw', 'height: 100vh',
      'object-fit: contain', 'background: #000'].forEach(function (d) {
      assert.ok(rule.indexOf(d + ' !important') >= 0, 'media rule has ' + d);
    });
  });

  test('off: restores the page exactly', function () {
    var doc = parseHtml(PAGE);
    var before = doc.documentElement.getAttribute('class');
    var mode = E.createEmbedMode({ doc: doc, mediaSelector: MEDIA });
    mode.set(true);
    assert.deepEqual(JSON.parse(JSON.stringify(mode.set(false))), { ok: true, on: false });
    assert.equal(doc.documentElement.getAttribute('class'), before);
    assert.equal(doc.getElementById(E.STYLE_ID), null);
    assert.deepEqual(classes(doc.querySelector('video')), ['vjs-tech']);
    assert.equal(hidden(doc, doc.querySelector('.tab-panel')), false);
    mode.set(false); // off when already off is harmless
    assert.equal(mode.isOn(), false);
  });

  test('refresh follows a replaced media element only while on', function () {
    var doc = parseHtml(PAGE);
    var mode = E.createEmbedMode({ doc: doc, mediaSelector: MEDIA });
    mode.set(true);
    var old = doc.querySelector('video');
    var holder = old.parent;
    old.remove();
    var fresh = doc.createElement('video');
    holder.appendChild(fresh);
    mode.refresh();
    assert.ok(classes(fresh).indexOf(E.MEDIA_CLASS) >= 0);
    assert.equal(classes(old).indexOf(E.MEDIA_CLASS), -1, 'old element released');
    mode.set(false);
    var third = doc.createElement('video');
    holder.appendChild(third);
    mode.refresh();
    assert.equal(classes(third).indexOf(E.MEDIA_CLASS), -1);
  });

  var FIXTURE = path.join(root, 'private', 'fixtures', 'zoom-recording.html');
  var haveFixture = fs.existsSync(FIXTURE);
  if (haveFixture) {
    test('fixture: the saved Zoom page hides its header and transcript and keeps the audio', function () {
      var doc = parseHtml(fs.readFileSync(FIXTURE, 'utf8'));
      var mode = E.createEmbedMode({ doc: doc, mediaSelector: MEDIA });
      mode.set(true);
      assert.equal(doc.querySelector('audio, video').tagName, 'audio');
      assert.equal(hidden(doc, doc.querySelector('audio, video')), false);
      ['.rec-header-container', '.tab-panel', '.transcript-list'].forEach(function (sel) {
        assert.ok(doc.querySelector(sel), sel + ' exists on the saved page');
        assert.equal(hidden(doc, doc.querySelector(sel)), true, sel + ' hidden');
      });
      mode.set(false);
      assert.equal(hidden(doc, doc.querySelector('.tab-panel')), false);
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
  if (!haveFixture) console.log('SKIP fixture test: private/fixtures/zoom-recording.html not found');
  console.log((tests.length - failed) + '/' + tests.length + ' passed');
  finished = true;
  if (failed) process.exitCode = 1;
})();
