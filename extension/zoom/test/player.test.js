// Run: node extension/zoom/test/player.test.js
// Drives zoom/player.js with a fake <audio> element and a fake clock. No browser.

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
  var ctx = vm.createContext({ console: console });
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'player.js'), 'utf8') + '\nthis.P = RewindZoomPlayer;', ctx);
  var P = ctx.P;
  var plain = function (x) { return JSON.parse(JSON.stringify(x)); };

  function fakeMedia(opts) {
    opts = opts || {};
    var listeners = {};
    var m = {
      currentTime: 0,
      paused: true,
      playbackRate: 1,
      duration: opts.duration === undefined ? 6081 : opts.duration,
      addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeEventListener: function (ev, fn) { listeners[ev] = (listeners[ev] || []).filter(function (f) { return f !== fn; }); },
      fire: function (ev) { (listeners[ev] || []).forEach(function (fn) { fn({ type: ev }); }); },
      listenerCount: function () { return Object.keys(listeners).reduce(function (n, k) { return n + listeners[k].length; }, 0); },
      play: function () {
        if (opts.playError) return Promise.reject(opts.playError);
        m.paused = false;
        m.fire('play');
        return Promise.resolve();
      },
      pause: function () { m.paused = true; m.fire('pause'); }
    };
    return m;
  }

  function setup(opts) {
    opts = opts || {};
    var env = { media: 'media' in opts ? opts.media : fakeMedia(), sent: [], clock: 0, clicked: null, timers: [] };
    // Fake timers on the fake clock: advance(ms) runs whatever falls due, in order.
    env.advance = async function (ms) {
      var end = env.clock + ms;
      for (;;) {
        env.timers.sort(function (a, b) { return a.at - b.at; });
        var t = env.timers[0];
        if (!t || t.at > end) break;
        env.timers.shift();
        env.clock = t.at;
        t.fn();
        await Promise.resolve();
      }
      env.clock = end;
      await Promise.resolve();
    };
    env.player = P.createPlayer({
      doc: { querySelector: function (sel) { assert.equal(sel, 'audio, video'); return env.media; } },
      mediaSelector: 'audio, video',
      userActivation: opts.userActivation,
      now: function () { return env.clock; },
      setTimer: function (fn, ms) { var t = { fn: fn, at: env.clock + ms }; env.timers.push(t); return t; },
      clearTimer: function (t) { env.timers = env.timers.filter(function (x) { return x !== t; }); },
      send: function (s) { env.sent.push(plain(s)); },
      chunkElementFor: function (doc, seconds) {
        return opts.chunks ? { click: function () { env.clicked = seconds; } } : null;
      }
    });
    return env;
  }

  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  test('status: needsGesture follows sticky user activation', function () {
    assert.equal(setup({ userActivation: { hasBeenActive: false } }).player.status().needsGesture, true);
    assert.equal(setup({ userActivation: { hasBeenActive: true } }).player.status().needsGesture, false);
    assert.equal(setup({}).player.status().needsGesture, true, 'unknown activation counts as needing a click');
    var s = plain(setup({ userActivation: { hasBeenActive: true } }).player.status());
    assert.deepEqual(s, {
      ok: true, needsGesture: false, hasMedia: true,
      state: { currentTime: 0, paused: true, rate: 1, duration: 6081 },
      media: { kind: 'audio', videoWidth: null, videoHeight: null }
    });
    assert.deepEqual(plain(setup({ media: null }).player.status()), { ok: true, needsGesture: true, hasMedia: false, state: null, media: null });
  });

  test('mediaInfo: video sizes once known, null for audio', function () {
    var v = fakeMedia();
    v.tagName = 'VIDEO';
    v.videoWidth = 0;
    v.videoHeight = 0;
    var env = setup({ media: v });
    assert.deepEqual(plain(env.player.mediaInfo()), { kind: 'video', videoWidth: null, videoHeight: null });
    v.videoWidth = 1920;
    v.videoHeight = 1080;
    assert.deepEqual(plain(env.player.mediaInfo()), { kind: 'video', videoWidth: 1920, videoHeight: 1080 });
    var a = fakeMedia();
    a.tagName = 'AUDIO';
    a.videoWidth = 640;
    assert.deepEqual(plain(setup({ media: a }).player.mediaInfo()), { kind: 'audio', videoWidth: null, videoHeight: null });
  });

  test('onAttach runs for each new media element', function () {
    var seen = [];
    var env = setup();
    env.player = P.createPlayer({
      doc: { querySelector: function () { return env.media; } },
      mediaSelector: 'audio, video',
      send: function () {},
      onAttach: function (m) { seen.push(m); }
    });
    env.player.attach();
    env.player.attach();
    var first = env.media;
    env.media = fakeMedia();
    env.player.attach();
    assert.equal(seen.length, 2);
    assert.equal(seen[0], first);
    assert.equal(seen[1], env.media);
  });

  test('play resolves with state; NotAllowedError becomes needs-gesture', async function () {
    var env = setup();
    env.media.currentTime = 600.123;
    assert.deepEqual(plain(await env.player.play()), { ok: true, state: { currentTime: 600.12, paused: false, rate: 1, duration: 6081 } });
    var blocked = setup({ media: fakeMedia({ playError: { name: 'NotAllowedError', message: 'play() failed because the user did not interact' } }) });
    assert.deepEqual(plain(await blocked.player.play()), { ok: false, error: 'needs-gesture' });
    var other = setup({ media: fakeMedia({ playError: { name: 'NotSupportedError', message: 'no source' } }) });
    assert.deepEqual(plain(await other.player.play()), { ok: false, error: 'no source' });
    assert.equal((await setup({ media: null }).player.play()).ok, false);
  });

  test('pause and rate', function () {
    var env = setup();
    env.media.paused = false;
    assert.equal(env.player.pause().state.paused, true);
    assert.equal(env.player.rate(1.75).state.rate, 1.75);
    assert.equal(env.media.playbackRate, 1.75);
    assert.equal(env.player.rate(0.5).ok, true);
    assert.equal(env.player.rate(2).ok, true);
    for (var bad of [0, 0.25, 0.49, 2.01, 4, '2', NaN, Infinity]) assert.equal(env.player.rate(bad).ok, false, String(bad));
    assert.equal(env.media.playbackRate, 2);
  });

  // Settles a promise while the fake clock runs, up to `ms`.
  async function settle(env, promise, ms) {
    var out = { pending: true };
    promise.then(function (v) { out = { pending: false, value: v }; });
    for (var t = 0; t <= ms && out.pending; t += 50) await env.advance(50);
    return out;
  }

  test('seek sets currentTime and confirms it, or clicks a transcript item without media', async function () {
    var env = setup();
    var r = await settle(env, env.player.seek(600), 500);
    assert.deepEqual(plain(r.value), { ok: true, method: 'media', seconds: 600, state: { currentTime: 600, paused: true, rate: 1, duration: 6081 } });
    assert.equal(env.media.currentTime, 600);
    var noMedia = setup({ media: null, chunks: true });
    assert.deepEqual(plain(await noMedia.player.seek(42)), { ok: true, method: 'transcript-click', seconds: 42 });
    assert.equal(noMedia.clicked, 42);
    assert.equal((await env.player.seek(-1)).ok, false);
  });

  // Regression (John, Oct 23): the embedded recording played from 0:00. The frame's media
  // existed but had no metadata yet, so the seek to 15:18 didn't stick.
  test('a seek before metadata is held and applied once metadata loads', async function () {
    var m = fakeMedia({ duration: NaN });
    m.readyState = 0;
    // Like a real element without metadata: currentTime can't move yet.
    var t = 0;
    Object.defineProperty(m, 'currentTime', { get: function () { return t; }, set: function (v) { if (m.readyState >= 1) t = v; } });
    var env = setup({ media: m });
    var p = env.player.seek(918);
    var r = await settle(env, p, 1500);
    assert.equal(r.pending, true, 'no reply while metadata is still loading');
    assert.equal(m.currentTime, 0);
    m.readyState = 1;
    m.duration = 6081;
    m.fire('loadedmetadata');
    r = await settle(env, p, 500);
    assert.equal(r.pending, false);
    assert.equal(r.value.ok, true);
    assert.equal(r.value.state.currentTime, 918);
  });

  test('a seek follows a replaced media element and confirms on the new one', async function () {
    var first = fakeMedia();
    first.readyState = 0;
    var env = setup({ media: first });
    var p = env.player.seek(918);
    await env.advance(300);
    var second = fakeMedia();
    second.readyState = 1;
    env.media = second;
    var r = await settle(env, p, 500);
    assert.equal(r.value.ok, true);
    assert.equal(second.currentTime, 918);
    assert.equal(first.listenerCount(), 0, 'old element released');
  });

  test('a seek the page undoes is applied again before it is confirmed', async function () {
    var env = setup();
    env.media.readyState = 4;
    var resets = 1;
    var t = 0;
    // The page's own player jumps back to 0 once, right after our first set.
    Object.defineProperty(env.media, 'currentTime', { get: function () { return t; }, set: function (v) { t = v; if (resets-- > 0) t = 0; } });
    var r = await settle(env, env.player.seek(918), 1000);
    assert.equal(r.value.ok, true);
    assert.equal(t, 918);
  });

  test('a seek whose media never loads replies seek-failed after about 3 s', async function () {
    var m = fakeMedia({ duration: NaN });
    m.readyState = 0;
    var env = setup({ media: m });
    env.player.attach();
    var stateListeners = m.listenerCount();
    var p = env.player.seek(918);
    var r = await settle(env, p, 2800);
    assert.equal(r.pending, true);
    r = await settle(env, p, 600);
    assert.deepEqual(plain(r.value), { ok: false, error: 'seek-failed', state: { currentTime: 0, paused: true, rate: 1, duration: null } });
    assert.equal(env.timers.length, 0, 'no timer left behind');
    assert.equal(m.listenerCount(), stateListeners, 'seek listeners removed');
    var none = setup({ media: null });
    r = await settle(none, none.player.seek(1), 3500);
    assert.deepEqual(plain(r.value), { ok: false, error: 'seek-failed', state: null });
  });

  test('play with seconds seeks and confirms first, then plays; a failed seek never plays', async function () {
    var m = fakeMedia();
    m.readyState = 0;
    var env = setup({ media: m });
    var p = env.player.play(918);
    await env.advance(1000);
    assert.equal(m.paused, true, 'not playing before the seek is confirmed');
    m.readyState = 1;
    m.fire('canplay');
    var r = await settle(env, p, 500);
    assert.equal(r.value.ok, true);
    assert.equal(r.value.state.currentTime, 918);
    assert.equal(r.value.state.paused, false);
    var stuck = fakeMedia();
    stuck.readyState = 0;
    var env2 = setup({ media: stuck });
    r = await settle(env2, env2.player.play(918), 3500);
    assert.equal(r.value.error, 'seek-failed');
    assert.equal(stuck.paused, true);
  });

  test('state: sent on attach and on every change, about 4x/s while playing', async function () {
    var env = setup();
    env.player.attach();
    assert.deepEqual(env.sent, [{ currentTime: 0, paused: true, rate: 1, duration: 6081 }]);

    // Paused and unchanged: timeupdate sends nothing.
    env.clock = 1000;
    env.media.fire('timeupdate');
    assert.equal(env.sent.length, 1);

    await env.player.play(); // 'play' event: sent immediately
    assert.equal(env.sent.length, 2);
    assert.equal(env.sent[1].paused, false);

    // timeupdate every 250 ms for 2 s while playing -> 8 sends; extra events within 200 ms are dropped.
    for (var i = 1; i <= 8; i++) {
      env.clock = 1000 + i * 250;
      env.media.currentTime = i * 0.25;
      env.media.fire('timeupdate');
      env.clock += 50;
      env.media.fire('timeupdate');
    }
    assert.equal(env.sent.length, 10);
    assert.equal(env.sent[9].currentTime, 2);

    env.player.pause(); // 'pause' event: sent immediately
    assert.equal(env.sent[10].paused, true);

    // Seek while paused: the seeked event sends the new time once.
    env.media.currentTime = 900;
    env.media.fire('seeked');
    env.media.fire('timeupdate');
    assert.equal(env.sent.length, 12);
    assert.equal(env.sent[11].currentTime, 900);

    env.player.rate(2); // our fake doesn't fire ratechange; the real element does
    env.media.fire('ratechange');
    assert.equal(env.sent[12].rate, 2);
  });

  test('state follows a replaced media element and only reads the four fields', function () {
    var env = setup();
    env.player.attach();
    var first = env.media;
    env.media = fakeMedia({ duration: NaN });
    env.player.attach();
    assert.equal(first.listenerCount(), 0, 'old element released');
    assert.deepEqual(env.sent[env.sent.length - 1], { currentTime: 0, paused: true, rate: 1, duration: null });
    first.fire('pause');
    var n = env.sent.length;
    env.media.paused = false;
    env.media.fire('play');
    assert.equal(env.sent.length, n + 1);
    env.sent.forEach(function (s) { assert.deepEqual(Object.keys(s), ['currentTime', 'paused', 'rate', 'duration']); });
  });

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
  console.log((tests.length - failed) + '/' + tests.length + ' passed');
  finished = true;
  if (failed) process.exitCode = 1;
})();
