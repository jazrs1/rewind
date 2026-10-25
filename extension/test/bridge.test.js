// Run: node extension/test/bridge.test.js
// Drives bridge.js's router with fake chrome.tabs APIs. No browser, no network.

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

  var extDir = path.join(path.dirname(process.argv[1]), '..');
  var src = fs.readFileSync(path.join(extDir, 'bridge.js'), 'utf8');
  var originsSrc = fs.readFileSync(path.join(extDir, 'allowed-origins.js'), 'utf8');
  var ctx = vm.createContext({ URL: URL, console: console, setTimeout: setTimeout });
  // Loaded as the service worker loads them: allowed-origins.js, then bridge.js.
  vm.runInContext(originsSrc + '\n' + src + '\nthis.RewindBridge = RewindBridge; this.ALLOWED = ALLOWED_APP_ORIGINS;', ctx);
  var B = ctx.RewindBridge;
  var ALLOWED = Array.from(ctx.ALLOWED);
  // A message from the app page on an allowed origin (what Chrome passes as `sender`).
  var APP_SENDER = { origin: 'http://localhost:3000', url: 'http://localhost:3000/practice', tab: { id: 50, url: 'http://localhost:3000/practice' } };
  var router = function (chrome, opts) {
    var route = B.createRouter(chrome, opts).route;
    return function (msg, sender) { return route(msg, sender || APP_SENDER); };
  };
  var plain = function (x) { return JSON.parse(JSON.stringify(x)); };

  var REC = 'https://ufl.zoom.us/rec/play/abc123';

  // tabs: [{ id, url, active, status, onMessage(msg) -> reply | throws }]
  function fakeChrome(tabs, hooks) {
    hooks = hooks || {};
    var listeners = [];
    var log = { sent: [], created: [], updated: [] };
    var nextId = 100;
    function glob(pattern, url) {
      var re = new RegExp('^' + pattern.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return re.test(url);
    }
    var chrome = {
      tabs: {
        query: async function (q) {
          return tabs.filter(function (t) { return !q.url || glob(q.url, t.url); });
        },
        get: async function (id) {
          var t = tabs.filter(function (x) { return x.id === id; })[0];
          if (!t) throw new Error('No tab with id ' + id);
          return t;
        },
        sendMessage: async function (id, msg, options) {
          var t = tabs.filter(function (x) { return x.id === id; })[0];
          if (options && options.frameId !== undefined) {
            // Embedded frames: tab.frames[frameId] is that frame's content-script handler.
            log.sent.push({ id: id, frameId: options.frameId, msg: msg });
            var handler = t && t.frames && t.frames[options.frameId];
            if (!handler) throw new Error('Could not establish connection. Receiving end does not exist.');
            return handler(msg);
          }
          log.sent.push({ id: id, msg: msg });
          if (!t || !t.onMessage) throw new Error('Could not establish connection. Receiving end does not exist.');
          return t.onMessage(msg);
        },
        update: async function (id, props) {
          log.updated.push({ id: id, props: props });
          return tabs.filter(function (x) { return x.id === id; })[0];
        },
        create: async function (props) {
          var t = { id: nextId++, url: props.url, active: true, status: 'loading', onMessage: null };
          tabs.push(t);
          log.created.push(props);
          if (hooks.onCreate) hooks.onCreate(t, function fire(info) {
            listeners.slice().forEach(function (l) { l(t.id, info, t); });
          });
          return t;
        },
        onUpdated: {
          addListener: function (l) { listeners.push(l); },
          removeListener: function (l) { listeners = listeners.filter(function (x) { return x !== l; }); }
        }
      }
    };
    chrome.windows = {
      update: async function (id, props) { log.windows = (log.windows || []).concat([{ id: id, props: props }]); }
    };
    chrome.log = log;
    chrome.listenerCount = function () { return listeners.length; };
    return chrome;
  }

  var fastOpts = { sleep: function () { return Promise.resolve(); }, seekRetries: 5, seekRetryMs: 2, loadTimeoutMs: 1, version: '0.1.0' };
  // Never resolves: lets a test check that load completion, not the timeout, finished the wait.
  var noTimeout = Object.assign({}, fastOpts, {
    sleep: function (ms) { return ms === fastOpts.loadTimeoutMs ? new Promise(function () {}) : Promise.resolve(); }
  });

  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  test('ping replies with the version', async function () {
    var route = router(fakeChrome([]), fastOpts);
    assert.deepEqual(plain(await route({ type: 'ping' })), { ok: true, version: '0.1.0' });
  });

  // Sweep finding M3: the bridge used to hand the full Canvas export to any allowed page without a
  // confirm. The route is gone: an export message is an unknown type, and no Canvas tab is messaged.
  test('export is not a route: it is refused as an unknown type and no tab is messaged', async function () {
    var chrome = fakeChrome([
      { id: 1, url: 'https://ufl.instructure.com/courses/1', active: true,
        onMessage: function () { return { ok: true, export: { course: {} }, errors: [] }; } }
    ]);
    var route = router(chrome, fastOpts);
    for (var msg of [{ type: 'export', courseId: 1 }, { type: 'export', courseId: '424244' }, { type: 'export' }]) {
      assert.deepEqual(plain(await route(msg)), { ok: false, error: 'Unknown type: "export"' });
    }
    assert.equal(chrome.log.sent.length, 0);
    assert.equal(B.validate({ type: 'export', courseId: 1 }), 'Unknown type: "export"');
  });

  test('seek to an open tab for the same recording (query string ignored), without stealing focus', async function () {
    var chrome = fakeChrome([
      { id: 7, url: 'https://ufl.zoom.us/rec/play/other', onMessage: function () { throw new Error('wrong recording'); } },
      { id: 8, url: REC + '?startTime=123', status: 'complete',
        onMessage: function (msg) { return { ok: true, method: 'media', seconds: msg.seconds }; } }
    ]);
    var r = plain(await router(chrome, fastOpts)({ type: 'seek', recordingUrl: REC, seconds: 600 }));
    assert.deepEqual(r, { ok: true, tabId: 8, opened: false, method: 'media', seconds: 600, state: null });
    assert.deepEqual(plain(chrome.log.updated), []);
    assert.deepEqual(plain(chrome.log.sent), [{ id: 8, msg: { type: 'rewind:seek', seconds: 600 } }]);
    assert.equal(chrome.log.created.length, 0);
  });

  test('seek with no open tab opens one in the background, waits for load, and retries until the player is ready', async function () {
    var calls = 0;
    var chrome = fakeChrome([], {
      onCreate: function (tab, fire) {
        setTimeout(function () {
          tab.status = 'complete';
          // Content script answers, but the player is not ready on the first two tries.
          tab.onMessage = function (msg) {
            calls++;
            return calls < 3 ? { ok: false, error: 'No audio/video element or transcript on this page.' } : { ok: true, method: 'media' };
          };
          fire({ status: 'complete' });
        }, 5);
      }
    });
    var r = plain(await router(chrome, noTimeout)({ type: 'seek', recordingUrl: REC, seconds: 42.5 }));
    assert.deepEqual(r, { ok: true, tabId: 100, opened: true, method: 'media', seconds: 42.5, state: null });
    assert.deepEqual(plain(chrome.log.created), [{ url: REC, active: false }]);
    assert.equal(calls, 3);
    assert.equal(chrome.listenerCount(), 0, 'onUpdated listener removed');
  });

  test('seek in a new tab that never loads fails cleanly', async function () {
    var chrome = fakeChrome([], { onCreate: function () {} });
    var r = plain(await router(chrome, fastOpts)({ type: 'seek', recordingUrl: REC, seconds: 1 }));
    assert.deepEqual(r, { ok: false, error: 'The Zoom recording tab did not finish loading.' });
  });

  test('seek fails cleanly when the tab never answers (e.g. before T2 was loaded)', async function () {
    var chrome = fakeChrome([{ id: 9, url: REC, status: 'complete' }]);
    var r = plain(await router(chrome, fastOpts)({ type: 'seek', recordingUrl: REC, seconds: 1 }));
    assert.equal(r.ok, false);
    assert.match(r.error, /^Seek failed in the Zoom tab: Could not establish connection/);
  });

  test('unknown type is rejected', async function () {
    var route = router(fakeChrome([]), fastOpts);
    assert.deepEqual(plain(await route({ type: 'delete' })), { ok: false, error: 'Unknown type: "delete"' });
    assert.deepEqual(plain(await route({})), { ok: false, error: 'Unknown type: undefined' });
  });

  test('bad fields are rejected before touching any tab', async function () {
    var chrome = fakeChrome([{ id: 1, url: 'https://ufl.instructure.com/', onMessage: function () { throw new Error('should not be called'); } }]);
    var route = router(chrome, fastOpts);
    var bad = [
      null, 'ping', [1],
      { type: 'seek', seconds: 1 }, { type: 'seek', recordingUrl: 'https://evil.example/rec/play/x', seconds: 1 },
      { type: 'seek', recordingUrl: REC }, { type: 'seek', recordingUrl: REC, seconds: -1 },
      { type: 'seek', recordingUrl: REC, seconds: '60' }, { type: 'seek', recordingUrl: REC, seconds: Infinity }
    ];
    for (var i = 0; i < bad.length; i++) {
      var r = plain(await route(bad[i]));
      assert.equal(r.ok, false, JSON.stringify(bad[i]));
      assert.equal(typeof r.error, 'string');
    }
    assert.equal(chrome.log.sent.length, 0);
  });

  // ---------- Background-tab player: open, play, pause, rate, state events ----------

  var REC2 = 'https://ufl.zoom.us/rec/play/other456';
  function zoomTab(id, url, reply) {
    return { id: id, url: url, status: 'complete', onMessage: reply };
  }
  function statusReply(needsGesture) {
    return function (msg) {
      if (msg.type === 'rewind:status') return { ok: true, needsGesture: needsGesture, hasMedia: true, state: { currentTime: 0, paused: true, rate: 1, duration: 6081 } };
      throw new Error('unexpected ' + msg.type);
    };
  }
  // A port from chrome.runtime.connect: fireDisconnect() simulates the app closing it;
  // disconnect() is the extension closing it (as when the origin is refused).
  function fakePort(sender) {
    var port = {
      sender: sender || APP_SENDER,
      posted: [],
      disconnected: false,
      postMessage: function (m) { port.posted.push(m); },
      disconnect: function () { port.disconnected = true; },
      onDisconnect: { addListener: function (fn) { port.fireDisconnect = fn; } }
    };
    return port;
  }

  test('open an already-open recording: no focus change, needsGesture from the tab', async function () {
    var chrome = fakeChrome([zoomTab(8, REC + '?x=1', statusReply(false))]);
    var r = plain(await router(chrome, fastOpts)({ type: 'open', recordingUrl: REC }));
    assert.deepEqual(r, { ok: true, tabId: 8, opened: false, needsGesture: false,
      state: { currentTime: 0, paused: true, rate: 1, duration: 6081 } });
    assert.deepEqual(plain(chrome.log.updated), []);
    assert.deepEqual(plain(chrome.log.sent), [{ id: 8, msg: { type: 'rewind:status' } }]);
  });

  test('open with focus: true brings the tab to the front', async function () {
    var chrome = fakeChrome([zoomTab(8, REC, statusReply(true))]);
    var r = plain(await router(chrome, fastOpts)({ type: 'open', recordingUrl: REC, focus: true }));
    assert.equal(r.needsGesture, true);
    assert.deepEqual(plain(chrome.log.updated), [{ id: 8, props: { active: true } }]);
  });

  test('open a new recording: background tab, waits for the content script, needsGesture true', async function () {
    var chrome = fakeChrome([], {
      onCreate: function (tab, fire) {
        setTimeout(function () {
          tab.status = 'complete';
          fire({ status: 'complete' });
          // Content script shows up a little after load.
          setTimeout(function () { tab.onMessage = statusReply(false); }, 5);
        }, 5);
      }
    });
    var slowRetry = Object.assign({}, noTimeout, {
      sleep: function (ms) { return ms === fastOpts.loadTimeoutMs ? new Promise(function () {}) : new Promise(function (r) { setTimeout(r, 3); }); }
    });
    var r = plain(await router(chrome, slowRetry)({ type: 'open', recordingUrl: REC }));
    assert.equal(r.ok, true);
    assert.equal(r.opened, true);
    assert.equal(r.needsGesture, true, 'a fresh tab has had no click');
    assert.deepEqual(plain(chrome.log.created), [{ url: REC, active: false }]);
  });

  test('open fails cleanly when the tab has no content script', async function () {
    var r = plain(await router(fakeChrome([zoomTab(8, REC)]), fastOpts)({ type: 'open', recordingUrl: REC }));
    assert.equal(r.ok, false);
    assert.match(r.error, /^Could not reach the Zoom tab\. Reload it/);
  });

  test('play, pause and rate go to the tab from open', async function () {
    var got = [];
    var reply = function (msg) {
      got.push(msg);
      if (msg.type === 'rewind:status') return { ok: true, needsGesture: false, state: null };
      return { ok: true, state: { currentTime: 12, paused: msg.type === 'rewind:pause', rate: msg.value || 1, duration: 100 } };
    };
    var chrome = fakeChrome([zoomTab(8, REC, reply), zoomTab(9, REC2, function () { throw new Error('wrong tab'); })]);
    var route = router(chrome, fastOpts);
    await route({ type: 'open', recordingUrl: REC });
    assert.deepEqual(plain(await route({ type: 'play' })), { ok: true, tabId: 8, opened: false, state: { currentTime: 12, paused: false, rate: 1, duration: 100 } });
    assert.equal((await route({ type: 'pause' })).state.paused, true);
    assert.equal((await route({ type: 'rate', value: 1.5 })).state.rate, 1.5);
    assert.deepEqual(plain(got.slice(1)), [{ type: 'rewind:play' }, { type: 'rewind:pause' }, { type: 'rewind:rate', value: 1.5 }]);
  });

  test('play rejected by the browser replies needs-gesture', async function () {
    var chrome = fakeChrome([zoomTab(8, REC, function () { return { ok: false, error: 'needs-gesture' }; })]);
    assert.deepEqual(plain(await router(chrome, fastOpts)({ type: 'play' })), { ok: false, error: 'needs-gesture' });
  });

  test('play/pause/rate pick the tab: recordingUrl, else current, else the only one', async function () {
    var ok = function () { return { ok: true, state: null }; };
    var none = router(fakeChrome([]), fastOpts);
    assert.match((await none({ type: 'pause' })).error, /No Zoom recording tab is open/);
    var two = fakeChrome([zoomTab(8, REC, ok), zoomTab(9, REC2, ok)]);
    var route = router(two, fastOpts);
    assert.match((await route({ type: 'pause' })).error, /Several Zoom recordings are open/);
    assert.equal((await route({ type: 'pause', recordingUrl: REC2 })).tabId, 9);
    assert.match((await route({ type: 'pause', recordingUrl: 'https://ufl.zoom.us/rec/play/missing' })).error, /^no-tab$/);
    var one = router(fakeChrome([zoomTab(8, REC, ok)]), fastOpts);
    assert.equal((await one({ type: 'play' })).tabId, 8);
  });

  test('bad player fields are rejected', async function () {
    var route = router(fakeChrome([]), fastOpts);
    var bad = [
      { type: 'open' }, { type: 'open', recordingUrl: 'https://evil.example/rec/x' }, { type: 'open', recordingUrl: REC, focus: 'yes' },
      { type: 'rate' }, { type: 'rate', value: 0 }, { type: 'rate', value: 0.25 }, { type: 'rate', value: 3 }, { type: 'rate', value: '1.5' }, { type: 'rate', value: NaN },
      { type: 'play', recordingUrl: 42 }, { type: 'pause', recordingUrl: 'http://ufl.zoom.us/rec/x' }
    ];
    for (var i = 0; i < bad.length; i++) {
      var r = plain(await route(bad[i]));
      assert.equal(r.ok, false, JSON.stringify(bad[i]));
    }
  });

  test('state events reach every connected port, only from the current tab, sanitized', async function () {
    var chrome = fakeChrome([zoomTab(8, REC + '?t=5', statusReply(false)), zoomTab(9, REC2, statusReply(false))]);
    var bridge = B.createRouter(chrome, fastOpts);
    var a = fakePort();
    var b = fakePort();
    bridge.connect(a);
    bridge.connect(b);
    var tab8 = { tab: { id: 8, url: REC + '?t=5' } };
    // Before any open, every Zoom tab's state is forwarded.
    bridge.onTabMessage({ type: 'rewind:state', currentTime: 1, paused: true, rate: 1, duration: 100 }, { tab: { id: 9, url: REC2 } });
    assert.equal(a.posted.length, 1);
    await bridge.route({ type: 'open', recordingUrl: REC }, APP_SENDER);
    bridge.onTabMessage({ type: 'rewind:state', currentTime: 2, paused: true, rate: 1, duration: 100 }, { tab: { id: 9, url: REC2 } });
    assert.equal(a.posted.length, 1, 'other tab ignored once a tab is current');
    bridge.onTabMessage({ type: 'rewind:state', currentTime: 42.25, paused: false, rate: 1.5, duration: Infinity, cookie: 'x' }, tab8);
    var want = { type: 'state', currentTime: 42.25, paused: false, rate: 1.5, duration: null, tabId: 8, recordingUrl: REC };
    assert.deepEqual(plain(a.posted[1]), want);
    assert.deepEqual(plain(b.posted[1]), want);
    // Not state, or not from a Zoom tab: ignored.
    bridge.onTabMessage({ type: 'rewind:progress', text: 'x' }, tab8);
    bridge.onTabMessage({ type: 'rewind:state', currentTime: 3 }, { tab: { id: 8, url: 'https://ufl.instructure.com/' } });
    bridge.onTabMessage({ type: 'rewind:state', currentTime: 3 }, {});
    assert.equal(a.posted.length, 2);
    // A disconnected port gets nothing more.
    a.fireDisconnect();
    bridge.onTabMessage({ type: 'rewind:state', currentTime: 43, paused: false, rate: 1, duration: 100 }, tab8);
    assert.equal(a.posted.length, 2);
    assert.equal(b.posted.length, 3);
  });

  // ---------- T7: the app's zoom-remote contract ----------

  function playerTab(id, url, opts) {
    opts = opts || {};
    var st = { currentTime: 0, paused: true, rate: 1, duration: 6081 };
    var tab = zoomTab(id, url, function (msg) {
      tab.got.push(msg);
      if (msg.type === 'rewind:status') return { ok: true, needsGesture: !!opts.needsGesture, hasMedia: true, state: Object.assign({}, st) };
      if (msg.type === 'rewind:seek') { st.currentTime = msg.seconds; return { ok: true, method: 'media', seconds: msg.seconds, state: Object.assign({}, st) }; }
      if (msg.type === 'rewind:play') {
        if (opts.needsGesture) return { ok: false, error: 'needs-gesture' };
        st.paused = false;
        return { ok: true, state: Object.assign({}, st) };
      }
      if (msg.type === 'rewind:pause') { st.paused = true; return { ok: true, state: Object.assign({}, st) }; }
      if (msg.type === 'rewind:rate') { st.rate = msg.value; return { ok: true, state: Object.assign({}, st) }; }
      throw new Error('unexpected ' + msg.type);
    });
    tab.got = [];
    tab.windowId = 7;
    return tab;
  }

  test('T7 status: state for an open recording, no-tab otherwise, never opens a tab', async function () {
    var chrome = fakeChrome([playerTab(8, REC + '?a=b')]);
    var route = router(chrome, fastOpts);
    assert.deepEqual(plain(await route({ type: 'status', recordingUrl: REC })),
      { ok: true, tabId: 8, needsGesture: false, state: { currentTime: 0, paused: true, rate: 1, duration: 6081 } });
    assert.deepEqual(plain(await route({ type: 'status', recordingUrl: REC2 })), { ok: false, error: 'no-tab' });
    assert.equal(chrome.log.created.length, 0);
  });

  test('T7 play with recordingUrl, seconds and background: opens an inactive tab, seeks, then plays', async function () {
    var created;
    var chrome = fakeChrome([], {
      onCreate: function (tab, fire) {
        created = tab;
        setTimeout(function () {
          var p = playerTab(tab.id, tab.url);
          tab.onMessage = p.onMessage;
          tab.got = p.got;
          tab.status = 'complete';
          fire({ status: 'complete' });
        }, 5);
      }
    });
    var r = plain(await router(chrome, noTimeout)({ type: 'play', recordingUrl: REC, seconds: 612.5, background: true }));
    assert.deepEqual(r, { ok: true, tabId: 100, opened: true, state: { currentTime: 612.5, paused: false, rate: 1, duration: 6081 } });
    assert.deepEqual(plain(chrome.log.created), [{ url: REC, active: false }]);
    assert.deepEqual(plain(created.got), [{ type: 'rewind:seek', seconds: 612.5 }, { type: 'rewind:play' }]);
  });

  test('T7 play on an open tab: needs-gesture is returned at once, not retried', async function () {
    var tab = playerTab(8, REC, { needsGesture: true });
    var r = plain(await router(fakeChrome([tab]), fastOpts)({ type: 'play', recordingUrl: REC, background: true }));
    assert.deepEqual(r, { ok: false, error: 'needs-gesture' });
    assert.deepEqual(plain(tab.got), [{ type: 'rewind:play' }]);
  });

  test('T7 pause, seek (background) and rate with recordingUrl reply with state', async function () {
    var tab = playerTab(8, REC);
    var chrome = fakeChrome([tab]);
    var route = router(chrome, fastOpts);
    assert.equal((await route({ type: 'play', recordingUrl: REC, background: true })).state.paused, false);
    var sk = plain(await route({ type: 'seek', recordingUrl: REC, seconds: 30, background: true }));
    assert.equal(sk.state.currentTime, 30);
    assert.equal((await route({ type: 'rate', recordingUrl: REC, value: 2 })).state.rate, 2);
    assert.equal((await route({ type: 'rate', recordingUrl: REC, value: 0.5 })).state.rate, 0.5);
    assert.equal((await route({ type: 'pause', recordingUrl: REC })).state.paused, true);
    assert.deepEqual(plain(chrome.log.updated), [], 'nothing focused');
    assert.deepEqual(plain(await route({ type: 'pause', recordingUrl: REC2 })), { ok: false, error: 'no-tab' });
  });

  test('T7 seek with background: false brings the tab forward', async function () {
    var chrome = fakeChrome([playerTab(8, REC)]);
    await router(chrome, fastOpts)({ type: 'seek', recordingUrl: REC, seconds: 1, background: false });
    assert.deepEqual(plain(chrome.log.updated), [{ id: 8, props: { active: true } }]);
  });

  test('T7 focus: activates the tab and its window; no-tab otherwise', async function () {
    var chrome = fakeChrome([playerTab(8, REC)]);
    var route = router(chrome, fastOpts);
    assert.deepEqual(plain(await route({ type: 'focus', recordingUrl: REC })), { ok: true, tabId: 8 });
    assert.deepEqual(plain(chrome.log.updated), [{ id: 8, props: { active: true } }]);
    assert.deepEqual(plain(chrome.log.windows), [{ id: 7, props: { focused: true } }]);
    assert.deepEqual(plain(await route({ type: 'focus', recordingUrl: REC2 })), { ok: false, error: 'no-tab' });
  });

  test('T7 bad fields: missing recordingUrl, rate out of 0.5-2, bad seconds or background', async function () {
    var chrome = fakeChrome([playerTab(8, REC)]);
    var route = router(chrome, fastOpts);
    var bad = [
      { type: 'status' }, { type: 'focus' }, { type: 'seek', seconds: 1, background: true },
      { type: 'rate', recordingUrl: REC, value: 0.4 }, { type: 'rate', recordingUrl: REC, value: 2.5 },
      { type: 'play', recordingUrl: REC, seconds: -5 }, { type: 'play', recordingUrl: REC, seconds: '10' },
      { type: 'play', recordingUrl: REC, background: 'yes' }, { type: 'seek', recordingUrl: REC, seconds: 1, background: 1 }
    ];
    for (var i = 0; i < bad.length; i++) {
      var r = plain(await route(bad[i]));
      assert.equal(r.ok, false, JSON.stringify(bad[i]));
    }
    assert.equal(chrome.log.sent.length, 0);
  });

  // ---------- T9: Zoom player embedded in the app (zoom-embed) ----------

  var APP = 'http://localhost:3000/practice';
  var appSender = function (tabId) { return { origin: 'http://localhost:3000', url: APP, tab: { id: tabId, url: APP } }; };
  var frameSender = function (tabId, frameId, url) { return { tab: { id: tabId, url: APP }, frameId: frameId, url: url }; };

  // A Zoom frame's content script: records messages, keeps a small media state.
  function zoomFrame(opts) {
    opts = opts || {};
    var st = { currentTime: 0, paused: true, rate: 1, duration: 3000 };
    var f = function (msg) {
      f.got.push(msg);
      var copy = function () { return Object.assign({}, st, opts.extraState || {}); };
      if (msg.type === 'rewind:status') {
        return { ok: true, needsGesture: !!opts.needsGesture, hasMedia: true, state: copy(),
          media: opts.media || { kind: 'video', videoWidth: 1280, videoHeight: 720 }, title: 'leak' };
      }
      if (msg.type === 'rewind:seek') {
        if (opts.seekFails) return { ok: false, error: 'seek-failed', state: copy() };
        st.currentTime = msg.seconds;
        return { ok: true, method: 'media', seconds: msg.seconds, state: copy() };
      }
      if (msg.type === 'rewind:play') {
        if (opts.needsGesture) return { ok: false, error: 'needs-gesture' };
        st.paused = false;
        return { ok: true, state: copy() };
      }
      if (msg.type === 'rewind:pause') { st.paused = true; return { ok: true, state: copy() }; }
      if (msg.type === 'rewind:rate') { st.rate = msg.value; return { ok: true, state: copy() }; }
      if (msg.type === 'rewind:embedMode') return { ok: true, on: msg.on };
      throw new Error('unexpected ' + msg.type);
    };
    f.got = [];
    return f;
  }

  // App tab 50 (and 60) each embedding Zoom frames; a bridge with frames registered.
  function embedSetup() {
    var a = zoomFrame();
    var b = zoomFrame();
    var other = zoomFrame();
    var chrome = fakeChrome([
      { id: 50, url: APP, frames: { 3: a, 5: b } },
      { id: 60, url: APP, frames: { 4: other } }
    ]);
    var bridge = B.createRouter(chrome, fastOpts);
    bridge.onTabMessage({ type: 'rewind:frame-ready', recordingUrl: REC }, frameSender(50, 3, REC + '?pwd=x'));
    bridge.onTabMessage({ type: 'rewind:frame-ready', recordingUrl: REC2 }, frameSender(50, 5, REC2));
    bridge.onTabMessage({ type: 'rewind:frame-ready', recordingUrl: REC }, frameSender(60, 4, REC));
    return { chrome: chrome, bridge: bridge, a: a, b: b, other: other };
  }

  test('T9 status: state and media from the registered frame in the sender tab', async function () {
    var s = embedSetup();
    var r = plain(await s.bridge.route({ type: 'status', recordingUrl: REC, embed: true }, appSender(50)));
    assert.deepEqual(r, {
      ok: true,
      state: { currentTime: 0, paused: true, rate: 1, duration: 3000 },
      media: { kind: 'video', videoWidth: 1280, videoHeight: 720 },
      needsGesture: false
    });
    assert.deepEqual(plain(s.chrome.log.sent), [{ id: 50, frameId: 3, msg: { type: 'rewind:status' } }]);
    assert.equal(s.other.got.length, 0);
  });

  test('T9 no-frame before registration, and a frame in another tab is never reached', async function () {
    var lone = zoomFrame();
    var chrome = fakeChrome([{ id: 50, url: APP, frames: {} }, { id: 60, url: APP, frames: { 4: lone } }]);
    var bridge = B.createRouter(chrome, fastOpts);
    assert.deepEqual(plain(await bridge.route({ type: 'status', recordingUrl: REC, embed: true }, appSender(50))), { ok: false, error: 'no-frame' });
    bridge.onTabMessage({ type: 'rewind:frame-ready', recordingUrl: REC }, frameSender(60, 4, REC));
    assert.deepEqual(plain(await bridge.route({ type: 'play', recordingUrl: REC, embed: true }, appSender(50))), { ok: false, error: 'no-frame' });
    // Allowed origin but no tab (not a page): still nothing reachable.
    assert.deepEqual(plain(await bridge.route({ type: 'status', recordingUrl: REC, embed: true }, { origin: 'http://localhost:3000' })), { ok: false, error: 'no-frame' });
    assert.equal(lone.got.length, 0);
    assert.equal(chrome.log.sent.length, 0);
  });

  test('T9 two frames in one tab are picked by recordingUrl (path only)', async function () {
    var s = embedSetup();
    await s.bridge.route({ type: 'pause', recordingUrl: REC2 + '?startTime=5', embed: true }, appSender(50));
    await s.bridge.route({ type: 'pause', recordingUrl: REC, embed: true }, appSender(50));
    assert.deepEqual(plain(s.b.got), [{ type: 'rewind:pause' }]);
    assert.deepEqual(plain(s.a.got), [{ type: 'rewind:pause' }]);
  });

  test('T9 two frames of the same recording: the newest loaded wins, heartbeats keep the order', async function () {
    var first = zoomFrame();
    var second = zoomFrame();
    var chrome = fakeChrome([{ id: 50, url: APP, frames: { 3: first, 7: second } }]);
    var bridge = B.createRouter(chrome, fastOpts);
    bridge.onTabMessage({ type: 'rewind:frame-ready' }, frameSender(50, 3, REC));
    bridge.onTabMessage({ type: 'rewind:frame-ready' }, frameSender(50, 7, REC));
    bridge.onTabMessage({ type: 'rewind:frame-ready' }, frameSender(50, 3, REC)); // heartbeat
    await bridge.route({ type: 'status', recordingUrl: REC, embed: true }, appSender(50));
    assert.equal(second.got.length, 1);
    assert.equal(first.got.length, 0);
  });

  test('T9 registration trusts the sender: subframes on a Zoom recording URL only', async function () {
    var f = zoomFrame();
    var chrome = fakeChrome([{ id: 50, url: APP, frames: { 0: f, 3: f } }]);
    var bridge = B.createRouter(chrome, fastOpts);
    bridge.onTabMessage({ type: 'rewind:frame-ready', recordingUrl: REC }, frameSender(50, 0, REC)); // top frame
    bridge.onTabMessage({ type: 'rewind:frame-ready', recordingUrl: REC }, frameSender(50, 3, 'https://evil.example/rec/play/abc123'));
    bridge.onTabMessage({ type: 'rewind:frame-ready', recordingUrl: REC }, { frameId: 3, url: REC }); // no tab
    assert.deepEqual(plain(await bridge.route({ type: 'status', recordingUrl: REC, embed: true }, appSender(50))), { ok: false, error: 'no-frame' });
    // The message's own recordingUrl is ignored; the frame's real URL decides.
    bridge.onTabMessage({ type: 'rewind:frame-ready', recordingUrl: REC }, frameSender(50, 3, REC2));
    assert.deepEqual(plain(await bridge.route({ type: 'status', recordingUrl: REC, embed: true }, appSender(50))), { ok: false, error: 'no-frame' });
    assert.equal((await bridge.route({ type: 'status', recordingUrl: REC2, embed: true }, appSender(50))).ok, true);
  });

  test('T9 unload: frame-gone, a closed tab, or an unreachable frame are forgotten', async function () {
    var s = embedSetup();
    s.bridge.onTabMessage({ type: 'rewind:frame-gone' }, frameSender(50, 3, REC));
    assert.equal((await s.bridge.route({ type: 'status', recordingUrl: REC, embed: true }, appSender(50))).error, 'no-frame');
    assert.equal((await s.bridge.route({ type: 'status', recordingUrl: REC2, embed: true }, appSender(50))).ok, true);
    s.bridge.onTabRemoved(50);
    assert.equal((await s.bridge.route({ type: 'status', recordingUrl: REC2, embed: true }, appSender(50))).error, 'no-frame');
    // Frame vanished without frame-gone: the send fails, it is forgotten, and later calls skip it.
    var t = embedSetup();
    var tabs = await t.chrome.tabs.query({});
    delete tabs.filter(function (x) { return x.id === 60; })[0].frames[4];
    assert.deepEqual(plain(await t.bridge.route({ type: 'play', recordingUrl: REC, embed: true }, appSender(60))), { ok: false, error: 'no-frame' });
    tabs.filter(function (x) { return x.id === 60; })[0].frames[4] = t.other;
    assert.deepEqual(plain(await t.bridge.route({ type: 'play', recordingUrl: REC, embed: true }, appSender(60))), { ok: false, error: 'no-frame' });
    assert.equal(t.other.got.length, 0, 'forgotten until it registers again');
  });

  test('T9 play with seconds seeks then plays; pause, seek and rate reply with state', async function () {
    var s = embedSetup();
    var route = function (m) { return s.bridge.route(Object.assign({ recordingUrl: REC, embed: true }, m), appSender(50)); };
    assert.deepEqual(plain(await route({ type: 'play', seconds: 612.5 })),
      { ok: true, state: { currentTime: 612.5, paused: false, rate: 1, duration: 3000 } });
    assert.equal((await route({ type: 'rate', value: 1.5 })).state.rate, 1.5);
    assert.equal((await route({ type: 'seek', seconds: 30 })).state.currentTime, 30);
    assert.equal((await route({ type: 'pause' })).state.paused, true);
    assert.deepEqual(plain(s.a.got), [
      { type: 'rewind:seek', seconds: 612.5 }, { type: 'rewind:play' },
      { type: 'rewind:rate', value: 1.5 }, { type: 'rewind:seek', seconds: 30 }, { type: 'rewind:pause' }
    ]);
    assert.equal(s.chrome.log.created.length, 0, 'embed never opens tabs');
    assert.deepEqual(plain(s.chrome.log.updated), [], 'embed never focuses tabs');
  });

  // Regression (John, Oct 23): a frame whose media never loads must not play from 0:00.
  test('T9 play with seconds: a seek-failed frame is never told to play', async function () {
    var f = zoomFrame({ seekFails: true });
    var chrome = fakeChrome([{ id: 50, url: APP, frames: { 3: f } }]);
    var bridge = B.createRouter(chrome, fastOpts);
    bridge.onTabMessage({ type: 'rewind:frame-ready' }, frameSender(50, 3, REC));
    assert.deepEqual(plain(await bridge.route({ type: 'play', recordingUrl: REC, embed: true, seconds: 918 }, appSender(50))), { ok: false, error: 'seek-failed' });
    assert.deepEqual(plain(await bridge.route({ type: 'seek', recordingUrl: REC, embed: true, seconds: 918 }, appSender(50))), { ok: false, error: 'seek-failed' });
    assert.deepEqual(plain(f.got), [{ type: 'rewind:seek', seconds: 918 }, { type: 'rewind:seek', seconds: 918 }]);
  });

  test('T9 play in a frame without a click replies needs-gesture', async function () {
    var f = zoomFrame({ needsGesture: true });
    var chrome = fakeChrome([{ id: 50, url: APP, frames: { 3: f } }]);
    var bridge = B.createRouter(chrome, fastOpts);
    bridge.onTabMessage({ type: 'rewind:frame-ready' }, frameSender(50, 3, REC));
    assert.deepEqual(plain(await bridge.route({ type: 'play', recordingUrl: REC, embed: true }, appSender(50))), { ok: false, error: 'needs-gesture' });
  });

  test('T9 embedMode on and off', async function () {
    var s = embedSetup();
    assert.deepEqual(plain(await s.bridge.route({ type: 'embedMode', recordingUrl: REC, embed: true, on: true }, appSender(50))), { ok: true });
    assert.deepEqual(plain(await s.bridge.route({ type: 'embedMode', recordingUrl: REC, embed: true, on: false }, appSender(50))), { ok: true });
    assert.deepEqual(plain(s.a.got), [{ type: 'rewind:embedMode', on: true }, { type: 'rewind:embedMode', on: false }]);
  });

  test('T9 only numbers and booleans leave the frame', async function () {
    var f = zoomFrame({ extraState: { src: 'https://ssrweb.zoom.us/secret.m4a' }, media: { kind: 'canvas', videoWidth: 'big' } });
    var chrome = fakeChrome([{ id: 50, url: APP, frames: { 3: f } }]);
    var bridge = B.createRouter(chrome, fastOpts);
    bridge.onTabMessage({ type: 'rewind:frame-ready' }, frameSender(50, 3, REC));
    var r = plain(await bridge.route({ type: 'status', recordingUrl: REC, embed: true }, appSender(50)));
    assert.deepEqual(Object.keys(r).sort(), ['media', 'needsGesture', 'ok', 'state']);
    assert.deepEqual(Object.keys(r.state), ['currentTime', 'paused', 'rate', 'duration']);
    assert.equal(r.media, null);
    var audio = zoomFrame({ media: { kind: 'audio', videoWidth: 640, videoHeight: 480 } });
    var c2 = fakeChrome([{ id: 50, url: APP, frames: { 3: audio } }]);
    var b2 = B.createRouter(c2, fastOpts);
    b2.onTabMessage({ type: 'rewind:frame-ready' }, frameSender(50, 3, REC));
    assert.deepEqual(plain((await b2.route({ type: 'status', recordingUrl: REC, embed: true }, appSender(50))).media),
      { kind: 'audio', videoWidth: null, videoHeight: null });
  });

  test('T9 bad embed fields are rejected before any frame is touched', async function () {
    var s = embedSetup();
    var bad = [
      { type: 'status', recordingUrl: REC, embed: 'yes' },
      { type: 'embedMode', recordingUrl: REC, on: true },
      { type: 'embedMode', recordingUrl: REC, embed: true },
      { type: 'embedMode', recordingUrl: REC, embed: true, on: 'true' },
      { type: 'open', recordingUrl: REC, embed: true },
      { type: 'focus', recordingUrl: REC, embed: true },
      { type: 'pause', embed: true },
      { type: 'play', recordingUrl: 'https://evil.example/rec/play/x', embed: true },
      { type: 'rate', recordingUrl: REC, embed: true, value: 3 },
      { type: 'seek', recordingUrl: REC, embed: true },
      { type: 'play', recordingUrl: REC, embed: true, seconds: -1 }
    ];
    for (var i = 0; i < bad.length; i++) {
      var r = plain(await s.bridge.route(bad[i], appSender(50)));
      assert.equal(r.ok, false, JSON.stringify(bad[i]));
    }
    assert.equal(s.chrome.log.sent.length, 0);
  });

  // ---------- T13: in-code origin check and the manifest guard ----------

  var BAD_SENDERS = [
    ['lookalike port', { origin: 'http://localhost:3001', url: 'http://localhost:3001/practice', tab: { id: 50 } }],
    ['lookalike host', { origin: 'http://localhost.evil.com:3000', url: 'http://localhost.evil.com:3000/', tab: { id: 50 } }],
    ['https instead of http', { origin: 'https://localhost:3000', url: 'https://localhost:3000/', tab: { id: 50 } }],
    ['subdomain', { origin: 'http://app.localhost:3000', tab: { id: 50 } }],
    ['opaque origin', { origin: 'null', tab: { id: 50 } }],
    ['missing origin and url', { tab: { id: 50, url: 'http://localhost:3000/' } }],
    ['the site over http', { origin: 'http://rewindit.org', url: 'http://rewindit.org/', tab: { id: 50 } }],
    ['a lookalike of the site', { origin: 'https://rewindit.org.evil.com', tab: { id: 50 } }],
    ['another subdomain of the site', { origin: 'https://app.rewindit.org', tab: { id: 50 } }],
    ['the site on another port', { origin: 'https://rewindit.org:8443', tab: { id: 50 } }],
    ['a vercel.app preview', { origin: 'https://rewind-app.vercel.app', tab: { id: 50 } }],
    ['no sender', undefined]
  ];

  test('T13 route: only allowed origins get through; everything else is { ok: false, error: "origin" }', async function () {
    var reply = function () { return { ok: true, method: 'media' }; };
    var chrome = fakeChrome([{ id: 1, url: REC, status: 'complete', onMessage: reply }]);
    var route = B.createRouter(chrome, fastOpts).route;
    assert.deepEqual(plain(await route({ type: 'ping' }, APP_SENDER)), { ok: true, version: '0.1.0' });
    // The site, with and without www.
    for (var site of ['https://rewindit.org', 'https://www.rewindit.org']) {
      assert.deepEqual(plain(await route({ type: 'ping' }, { origin: site, url: site + '/practice', tab: { id: 50 } })), { ok: true, version: '0.1.0' }, site);
    }
    // sender.url alone is enough when Chrome gives no sender.origin.
    assert.equal((await route({ type: 'ping' }, { url: 'http://localhost:3000/practice' })).ok, true);
    for (var i = 0; i < BAD_SENDERS.length; i++) {
      for (var msg of [{ type: 'ping' }, { type: 'seek', recordingUrl: REC, seconds: 1 }, { type: 'status', recordingUrl: REC, embed: true }]) {
        assert.deepEqual(plain(await route(msg, BAD_SENDERS[i][1])), { ok: false, error: 'origin' }, BAD_SENDERS[i][0] + ' ' + msg.type);
      }
    }
    assert.equal(chrome.log.sent.length, 0, 'no tab was messaged for a refused origin');
  });

  test('T13 route: sender.origin wins over a misleading sender.url', async function () {
    var route = B.createRouter(fakeChrome([]), fastOpts).route;
    var r = plain(await route({ type: 'ping' }, { origin: 'http://localhost:3001', url: 'http://localhost:3000/practice' }));
    assert.deepEqual(r, { ok: false, error: 'origin' });
  });

  test('T13 follow-up: an opaque origin "null" is refused even with an allowed sender.url', async function () {
    var reply = function () { return { ok: true, method: 'media' }; };
    var chrome = fakeChrome([{ id: 1, url: REC, status: 'complete', onMessage: reply }]);
    var bridge = B.createRouter(chrome, fastOpts);
    var sender = { origin: 'null', url: 'http://localhost:3000/practice', tab: { id: 50 } };
    for (var msg of [{ type: 'ping' }, { type: 'seek', recordingUrl: REC, seconds: 1 }]) {
      assert.deepEqual(plain(await bridge.route(msg, sender)), { ok: false, error: 'origin' }, msg.type);
    }
    // Any other string in sender.origin is used as-is too; '' is not an origin.
    assert.deepEqual(plain(await bridge.route({ type: 'ping' }, { origin: '', url: 'http://localhost:3000/' })), { ok: false, error: 'origin' });
    assert.equal(chrome.log.sent.length, 0);
    var port = fakePort(sender);
    bridge.connect(port);
    assert.equal(port.disconnected, true);
    assert.deepEqual(plain(port.posted), [{ type: 'error', error: 'origin' }]);
    // The field missing entirely still falls back to sender.url.
    assert.equal((await bridge.route({ type: 'ping' }, { url: 'http://localhost:3000/practice' })).ok, true);
  });

  test('T13 connect: ports from other origins are closed and never get state events', function () {
    var chrome = fakeChrome([]);
    var bridge = B.createRouter(chrome, fastOpts);
    var good = fakePort(APP_SENDER);
    bridge.connect(good);
    var bad = BAD_SENDERS.map(function (s) { var p = fakePort(s[1]); if (!s[1]) p.sender = undefined; bridge.connect(p); return p; });
    bridge.onTabMessage({ type: 'rewind:state', currentTime: 5, paused: false, rate: 1, duration: 10 }, { tab: { id: 9, url: REC } });
    assert.equal(good.posted.length, 1);
    assert.equal(good.disconnected, false);
    bad.forEach(function (p, i) {
      assert.equal(p.disconnected, true, BAD_SENDERS[i][0] + ' closed');
      assert.deepEqual(plain(p.posted), [{ type: 'error', error: 'origin' }], BAD_SENDERS[i][0] + ' got no state');
    });
  });

  test('T13 createRouter with no origin list lets nobody in', async function () {
    var route = B.createRouter(fakeChrome([]), Object.assign({}, fastOpts, { allowedOrigins: [] })).route;
    assert.deepEqual(plain(await route({ type: 'ping' }, APP_SENDER)), { ok: false, error: 'origin' });
  });

  test('T13 manifest: externally_connectable lists exactly ALLOWED_APP_ORIGINS, never wildcards', function () {
    var manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
    var matches = (manifest.externally_connectable && manifest.externally_connectable.matches) || [];
    var permitted = ALLOWED.map(function (o) { return o + '/*'; });
    assert.deepEqual(matches.slice().sort(), permitted.slice().sort(), 'the manifest and ALLOWED_APP_ORIGINS list the same origins');
    assert.ok(matches.length > 0, 'externally_connectable.matches is present');
    matches.forEach(function (m) {
      assert.ok(permitted.indexOf(m) >= 0, m + ' is not in ALLOWED_APP_ORIGINS');
      var host = m.replace(/^[a-z]+:\/\//, '').split('/')[0];
      assert.ok(host.indexOf('*') < 0, m + ' has a wildcard host');
      assert.ok(!/vercel\.app/i.test(m), m + ' is a vercel.app pattern');
    });
    assert.ok(!(manifest.externally_connectable && manifest.externally_connectable.ids), 'no other extensions');
    // And the list itself never holds a wildcard or a vercel.app origin.
    ALLOWED.forEach(function (o) {
      assert.equal(new URL(o).origin, o, o + ' is a bare origin');
      assert.ok(o.indexOf('*') < 0 && !/vercel\.app$/i.test(new URL(o).hostname), o);
    });
    // Background loads the list before the bridge.
    var bg = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
    assert.match(bg, /importScripts\('allowed-origins\.js', 'bridge\.js'\)/);
    assert.match(bg, /allowedOrigins: ALLOWED_APP_ORIGINS/);
  });

  // Exported transcripts (Quick build's "Add lecture recordings"): kept by the extension, read back by the app.
  var ZOOM_FRAME = { tab: { id: 7, url: REC }, frameId: 0, url: REC + '?startTime=1' };
  function transcriptFor(url, extra) {
    return Object.assign({
      source: 'zoom', recordingUrl: url, title: 'Lecture, Oct 22', recordedAt: '2026-10-22T17:48:09', durationSec: 3600,
      segments: [{ start: 3463, end: 3470, speaker: 'Lecturer', text: 'A graph is connected if there is a path between every pair of vertices.' }]
    }, extra || {});
  }

  test('transcripts: a Zoom frame adds its own recording\'s transcript; the app reads it back, cleaned', async function () {
    var r = B.createRouter(fakeChrome([]).chrome, fastOpts);
    assert.deepEqual(plain(await r.route({ type: 'transcripts' }, APP_SENDER)), { ok: true, transcripts: [] });
    await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor(REC + '?x=1', { chunks: [1], secret: 'x', segments: [{ start: 1, end: 2, speaker: 'Lecturer', text: 'Hi.', extra: 'drop' }] }) }, ZOOM_FRAME);
    var got = plain(await r.route({ type: 'transcripts' }, APP_SENDER));
    assert.equal(got.ok, true);
    assert.equal(got.transcripts.length, 1);
    assert.deepEqual(got.transcripts[0], { source: 'zoom', recordingUrl: REC, title: 'Lecture, Oct 22', recordedAt: '2026-10-22T17:48:09', durationSec: 3600, segments: [{ start: 1, end: 2, speaker: 'Lecturer', text: 'Hi.' }] });
  });

  test('transcripts: the same recording again replaces it; the count only rises with new recordings', async function () {
    var r = B.createRouter(fakeChrome([]).chrome, fastOpts);
    await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor(REC) }, ZOOM_FRAME);
    await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor(REC, { title: 'Again' }) }, ZOOM_FRAME);
    var other = 'https://ufl.zoom.us/rec/play/def456';
    await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor(other) }, { tab: { id: 8, url: other }, frameId: 0, url: other });
    var got = plain(await r.route({ type: 'transcripts' }, APP_SENDER)).transcripts;
    assert.deepEqual(got.map(function (t) { return t.recordingUrl; }), [other, REC]);
    assert.equal(got[1].title, 'Again');
  });

  test('transcripts: refused from a non-Zoom sender, for another recording, without segments, and to other origins', async function () {
    var r = B.createRouter(fakeChrome([]).chrome, fastOpts);
    var evil = 'https://evil.example/rec/play/abc123';
    await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor(REC) }, { tab: { id: 9, url: evil }, frameId: 0, url: evil });
    await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor('https://ufl.zoom.us/rec/play/someone-else') }, ZOOM_FRAME);
    await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor(REC, { segments: [] }) }, ZOOM_FRAME);
    await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor('https://evil.example/rec/x') }, ZOOM_FRAME);
    assert.deepEqual(plain(await r.route({ type: 'transcripts' }, APP_SENDER)).transcripts, []);
    await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor(REC) }, ZOOM_FRAME);
    assert.deepEqual(plain(await r.route({ type: 'transcripts' }, { origin: 'https://evil.example', url: 'https://evil.example/' })), { ok: false, error: 'origin' });
  });

  test('transcripts: at most ' + B.MAX_TRANSCRIPTS + ' kept, the newest', async function () {
    var r = B.createRouter(fakeChrome([]).chrome, fastOpts);
    for (var i = 0; i < B.MAX_TRANSCRIPTS + 3; i++) {
      var url = 'https://ufl.zoom.us/rec/play/n' + i;
      await r.onTabMessage({ type: 'rewind:transcript-exported', transcript: transcriptFor(url) }, { tab: { id: 10, url: url }, frameId: 0, url: url });
    }
    var got = plain(await r.route({ type: 'transcripts' }, APP_SENDER)).transcripts;
    assert.equal(got.length, B.MAX_TRANSCRIPTS);
    assert.equal(got[0].recordingUrl, 'https://ufl.zoom.us/rec/play/n' + (B.MAX_TRANSCRIPTS + 2));
    assert.ok(!got.some(function (t) { return t.recordingUrl === 'https://ufl.zoom.us/rec/play/n0'; }));
  });

  test('manifest: no new permissions for the recordings step (exactly these hosts, no permissions key)', function () {
    var manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.host_permissions, ['https://ufl.instructure.com/*', 'https://ufl.zoom.us/*']);
    assert.equal(manifest.permissions, undefined);
    assert.equal(manifest.optional_permissions, undefined);
    assert.equal(manifest.optional_host_permissions, undefined);
    // The Zoom content script hands its export to the service worker, which keeps it in IndexedDB (no permission).
    assert.match(fs.readFileSync(path.join(extDir, 'zoom', 'content.js'), 'utf8'), /type: 'rewind:transcript-exported'/);
    assert.match(fs.readFileSync(path.join(extDir, 'background.js'), 'utf8'), /indexedDB\.open\('rewind', 1\)/);
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
