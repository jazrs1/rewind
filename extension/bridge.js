// App-to-extension message router. Plain script: loaded by background.js via importScripts,
// and loaded into a vm context by test/bridge.test.js with fake chrome APIs.
// Every reply is { ok: true, ... } or { ok: false, error }.
//
// Two ways to play a Zoom recording for the Rewind player:
// - zoom-embed (T9, primary): the recording is an iframe inside the app's own tab; requests
//   with embed: true go to that frame, found by the frame's own frame-ready registration.
// - zoom-remote (T7, fallback): a background Zoom tab is the audio source; the router
//   opens/finds it and forwards play/pause/rate/seek, and the hub pushes its state to ports.
//
// Exported transcripts (Quick build's "Add lecture recordings"): when the student clicks "Rewind: export transcript"
// on a recording, the Zoom content script also hands the transcript to the service worker, which keeps it on this
// device (the extension's own IndexedDB: no new permission). The app reads them back with { type: 'transcripts' }.
// The app can't start an export, and only a Zoom recording frame can add its own recording's transcript.

var RewindBridge = (function () {
  var ZOOM_TABS = 'https://ufl.zoom.us/rec/*';
  var ZOOM_PREFIX = 'https://ufl.zoom.us/rec/';
  var MIN_RATE = 0.5;
  var MAX_RATE = 2;

  function fail(error) {
    return { ok: false, error: error };
  }

  // Same recording if origin and path match; query strings (start times, tracking) are ignored.
  function sameRecording(a, b) {
    try {
      var x = new URL(a);
      var y = new URL(b);
      return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
    } catch (e) {
      return false;
    }
  }

  function recordingOf(url) {
    try {
      var u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) {
      return null;
    }
  }

  function badRecordingUrl(url, required) {
    if (url === undefined && !required) return false;
    return typeof url !== 'string' || url.indexOf(ZOOM_PREFIX) !== 0;
  }

  function validate(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'Message must be an object.';
    var t = msg.type;
    if (t === 'ping') return null;
    if (t === 'status' || t === 'focus' || t === 'open' || t === 'seek') {
      if (badRecordingUrl(msg.recordingUrl, true)) return t + ' needs recordingUrl starting with ' + ZOOM_PREFIX;
    }
    if (t === 'play' || t === 'pause' || t === 'rate') {
      if (badRecordingUrl(msg.recordingUrl, false)) return t + ' recordingUrl, if given, must start with ' + ZOOM_PREFIX;
    }
    if (t === 'seek' || (t === 'play' && msg.seconds !== undefined)) {
      if (typeof msg.seconds !== 'number' || !isFinite(msg.seconds) || msg.seconds < 0) {
        return t + ' seconds must be a non-negative number.';
      }
    }
    if (t === 'open' && msg.focus !== undefined && typeof msg.focus !== 'boolean') return 'open focus must be true or false.';
    if ((t === 'play' || t === 'seek') && msg.background !== undefined && typeof msg.background !== 'boolean') {
      return t + ' background must be true or false.';
    }
    if (t === 'rate' && (typeof msg.value !== 'number' || !isFinite(msg.value) || msg.value < MIN_RATE || msg.value > MAX_RATE)) {
      return 'rate needs value, a number from ' + MIN_RATE + ' to ' + MAX_RATE + '.';
    }
    if (msg.embed !== undefined && typeof msg.embed !== 'boolean') return 'embed must be true or false.';
    if (t === 'embedMode') {
      if (msg.embed !== true) return 'embedMode needs embed: true.';
      if (typeof msg.on !== 'boolean') return 'embedMode needs on, true or false.';
    }
    if (msg.embed === true) {
      if (EMBED_TYPES.indexOf(t) < 0) return 'embed: true works with ' + EMBED_TYPES.join(', ') + ', not ' + JSON.stringify(t) + '.';
      if (badRecordingUrl(msg.recordingUrl, true)) return t + ' with embed needs recordingUrl starting with ' + ZOOM_PREFIX;
      return null;
    }
    if (['status', 'focus', 'open', 'seek', 'play', 'pause', 'rate', 'transcripts'].indexOf(t) >= 0) return null;
    return 'Unknown type: ' + JSON.stringify(t);
  }

  // Transcripts kept, newest first; one per recording.
  var MAX_TRANSCRIPTS = 40;
  var MAX_SEGMENTS = 8000;

  function str(s, max) {
    return typeof s === 'string' ? s.slice(0, max) : null;
  }

  // Only the transcript's own fields, with caps: what the Zoom page showed, nothing else.
  function cleanTranscript(t) {
    if (!t || typeof t !== 'object' || badRecordingUrl(t.recordingUrl, true) || !Array.isArray(t.segments)) return null;
    var segments = [];
    for (var i = 0; i < t.segments.length && segments.length < MAX_SEGMENTS; i++) {
      var s = t.segments[i];
      if (!s || typeof s !== 'object' || num(s.start) === null || num(s.end) === null || typeof s.text !== 'string') continue;
      segments.push({ start: s.start, end: s.end, speaker: str(s.speaker, 120), text: s.text.slice(0, 4000) });
    }
    if (!segments.length) return null;
    return {
      source: 'zoom',
      recordingUrl: recordingOf(t.recordingUrl),
      title: str(t.title, 200) || 'Zoom recording',
      recordedAt: str(t.recordedAt, 40),
      durationSec: num(t.durationSec) || 0,
      segments: segments
    };
  }

  // Kept for the service worker's life only: the default, and what the tests use. background.js passes IndexedDB.
  function memoryTranscripts() {
    var byUrl = {};
    return {
      all: async function () { return Object.keys(byUrl).map(function (k) { return byUrl[k]; }); },
      put: async function (t) { byUrl[t.recordingUrl] = t; },
      remove: async function (url) { delete byUrl[url]; }
    };
  }

  var EMBED_TYPES = ['status', 'play', 'pause', 'seek', 'rate', 'embedMode'];

  function num(n) {
    return typeof n === 'number' && isFinite(n) ? n : null;
  }

  // Only these numbers and booleans ever leave a Zoom frame.
  function cleanState(s) {
    if (!s || typeof s !== 'object') return null;
    return { currentTime: num(s.currentTime), paused: s.paused === true, rate: num(s.rate), duration: num(s.duration) };
  }

  function cleanMedia(m) {
    if (!m || typeof m !== 'object') return null;
    var kind = m.kind === 'video' || m.kind === 'audio' ? m.kind : null;
    if (!kind) return null;
    var size = function (n) { return kind === 'video' && num(n) !== null && n > 0 ? n : null; };
    return { kind: kind, videoWidth: size(m.videoWidth), videoHeight: size(m.videoHeight) };
  }

  // The web page's origin. When sender.origin (Chrome 80+) is any string it is used as-is, so an
  // opaque 'null' origin (sandboxed iframe, data: URL) is refused rather than trusting
  // sender.url. sender.url is the fallback only when the origin field is missing. null if neither.
  function senderOrigin(sender) {
    if (!sender) return null;
    var raw = typeof sender.origin === 'string' ? sender.origin : sender.url;
    if (typeof raw !== 'string') return null;
    try {
      var o = new URL(raw).origin;
      return o && o !== 'null' ? o : null;
    } catch (e) {
      return null;
    }
  }

  // Exact origin match only: no prefixes, no subdomains, no other ports or schemes.
  function originAllowed(sender, allowed) {
    var o = senderOrigin(sender);
    return !!o && allowed.indexOf(o) >= 0;
  }

  // opts: { version, allowedOrigins, sleep(ms), loadTimeoutMs, seekRetries, seekRetryMs }
  function createRouter(chrome, opts) {
    opts = opts || {};
    // Explicit list, else the global from allowed-origins.js, else nobody.
    var allowedOrigins = (opts.allowedOrigins ||
      (typeof ALLOWED_APP_ORIGINS !== 'undefined' ? ALLOWED_APP_ORIGINS : [])).slice();
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var loadTimeoutMs = opts.loadTimeoutMs || 30000;
    var seekRetries = opts.seekRetries || 20;
    var seekRetryMs = opts.seekRetryMs || 500;
    // The Zoom tab last opened or sought. Lost if the service worker restarts; play/pause/rate
    // then fall back to the only open recording tab.
    var current = null;
    var ports = [];
    // Zoom players embedded as iframes (T9): { tabId, frameId, recordingUrl, seq }, learned from
    // the frames' own rewind:frame-ready messages (sender.tab.id / sender.frameId).
    var frames = [];
    var frameSeq = 0;
    var exported = opts.transcripts || memoryTranscripts();
    var savedSeq = 0;

    async function listTranscripts() {
      var all = (await exported.all()).slice();
      all.sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
      return all;
    }

    async function transcripts() {
      var all = await listTranscripts();
      return { ok: true, transcripts: all.slice(0, MAX_TRANSCRIPTS).map(cleanTranscript).filter(Boolean) };
    }

    async function keepTranscript(t) {
      t.savedAt = Date.now() * 1000 + (++savedSeq % 1000);
      await exported.put(t);
      var all = await listTranscripts();
      for (var i = MAX_TRANSCRIPTS; i < all.length; i++) await exported.remove(all[i].recordingUrl);
    }

    async function send(tabId, msg) {
      try {
        return { reply: await chrome.tabs.sendMessage(tabId, msg) };
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
    }

    // Retries a fresh tab until the content script answers with ok (or `accept` says so).
    async function sendWithRetry(tabId, msg, tries, accept) {
      var last = 'no reply';
      for (var i = 0; i < tries; i++) {
        if (i) await sleep(seekRetryMs);
        var r = await send(tabId, msg);
        if (r.reply && (accept ? accept(r.reply) : r.reply.ok)) return { reply: r.reply };
        last = r.error || (r.reply && r.reply.error) || 'no reply';
      }
      return { error: last };
    }

    function waitForLoad(tabId) {
      return new Promise(function (resolve) {
        var done = false;
        function finish(ok) {
          if (done) return;
          done = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(ok);
        }
        function listener(id, info) {
          if (id === tabId && info.status === 'complete') finish(true);
        }
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.get(tabId).then(function (tab) {
          if (tab && tab.status === 'complete') finish(true);
        }, function () { finish(false); });
        sleep(loadTimeoutMs).then(function () { finish(false); });
      });
    }

    // Finds the recording's tab or opens it in the background. Never steals focus unless asked.
    async function ensureTab(recordingUrl, focus) {
      var tabs = await chrome.tabs.query({ url: ZOOM_TABS });
      var tab = tabs.filter(function (t) { return sameRecording(t.url, recordingUrl); })[0];
      var opened = false;
      if (tab) {
        if (focus) await chrome.tabs.update(tab.id, { active: true });
      } else {
        tab = await chrome.tabs.create({ url: recordingUrl, active: !!focus });
        opened = true;
        if (!(await waitForLoad(tab.id))) return { error: 'The Zoom recording tab did not finish loading.' };
      }
      remember(tab);
      return { tab: tab, opened: opened };
    }

    // The open tab for a recording, or null. Never opens one.
    async function findTab(recordingUrl) {
      var tabs = await chrome.tabs.query({ url: ZOOM_TABS });
      return tabs.filter(function (t) { return sameRecording(t.url, recordingUrl); })[0] || null;
    }

    function remember(tab) {
      current = { tabId: tab.id, recordingUrl: recordingOf(tab.url) };
    }

    // Tab for play/pause/rate: the given recording, else the current one, else the only open one.
    async function controlledTab(msg) {
      var tabs = await chrome.tabs.query({ url: ZOOM_TABS });
      if (msg.recordingUrl) {
        var match = tabs.filter(function (t) { return sameRecording(t.url, msg.recordingUrl); })[0];
        return match ? { tab: match } : { error: 'no-tab' };
      }
      if (current) {
        var cur = tabs.filter(function (t) { return t.id === current.tabId; })[0];
        if (cur) return { tab: cur };
      }
      if (tabs.length === 1) return { tab: tabs[0] };
      if (!tabs.length) return { error: 'No Zoom recording tab is open. Send open first.' };
      return { error: 'Several Zoom recordings are open. Pass recordingUrl or send open first.' };
    }

    async function open(msg) {
      var t = await ensureTab(msg.recordingUrl, msg.focus);
      if (t.error) return fail(t.error);
      // Any reply from the content script will do; the media element may come later.
      var r = await sendWithRetry(t.tab.id, { type: 'rewind:status' }, t.opened ? seekRetries : 1, function (rep) { return rep.ok; });
      if (r.error) return fail('Could not reach the Zoom tab. Reload it and try again. (' + r.error + ')');
      return {
        ok: true,
        tabId: t.tab.id,
        opened: t.opened,
        // A fresh tab has had no click yet, so it can't start playing on its own.
        needsGesture: t.opened ? true : r.reply.needsGesture !== false,
        state: r.reply.state || null
      };
    }

    // Polled by the app (about 4x/s while playing). Never opens a tab.
    async function status(msg) {
      var tab = await findTab(msg.recordingUrl);
      if (!tab) return fail('no-tab');
      remember(tab);
      var r = await send(tab.id, { type: 'rewind:status' });
      if (r.error) return fail('Could not reach the Zoom tab. Reload it and try again. (' + r.error + ')');
      return { ok: true, tabId: tab.id, needsGesture: r.reply.needsGesture !== false, state: r.reply.state || null };
    }

    // Brings the Zoom tab (and its window) forward so the student can click play once.
    async function focus(msg) {
      var tab = await findTab(msg.recordingUrl);
      if (!tab) return fail('no-tab');
      remember(tab);
      await chrome.tabs.update(tab.id, { active: true });
      if (chrome.windows && tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, tabId: tab.id };
    }

    async function seek(msg) {
      // Background unless the app explicitly passes background: false.
      var t = await ensureTab(msg.recordingUrl, msg.background === false);
      if (t.error) return fail(t.error);
      // A fresh page needs a moment before the player and content script are ready.
      var r = await sendWithRetry(t.tab.id, { type: 'rewind:seek', seconds: msg.seconds }, t.opened ? seekRetries : 1);
      if (r.error) return fail('Seek failed in the Zoom tab: ' + r.error);
      return {
        ok: true, tabId: t.tab.id, opened: t.opened, method: r.reply.method, seconds: msg.seconds,
        state: r.reply.state || null
      };
    }

    // With recordingUrl: opens the tab if needed (background unless background: false),
    // seeks if seconds is given, then plays. Without: plays the current tab.
    async function play(msg) {
      var tab;
      var opened = false;
      if (msg.recordingUrl) {
        var t = await ensureTab(msg.recordingUrl, msg.background === false);
        if (t.error) return fail(t.error);
        tab = t.tab;
        opened = t.opened;
      } else {
        var c = await controlledTab(msg);
        if (c.error) return fail(c.error);
        tab = c.tab;
      }
      var tries = opened ? seekRetries : 1;
      if (msg.seconds !== undefined) {
        var sk = await sendWithRetry(tab.id, { type: 'rewind:seek', seconds: msg.seconds }, tries);
        if (sk.error) return fail('Seek failed in the Zoom tab: ' + sk.error);
        tries = 1;
      }
      // Retry only while the page is still starting up; a needs-gesture answer is final.
      var r = await sendWithRetry(tab.id, { type: 'rewind:play' }, tries, function (rep) {
        return rep.ok || rep.error === 'needs-gesture';
      });
      if (r.error) return fail(/needs-gesture/.test(r.error) ? 'needs-gesture' : 'Play failed in the Zoom tab: ' + r.error);
      if (!r.reply.ok) return fail(r.reply.error);
      return { ok: true, tabId: tab.id, opened: opened, state: r.reply.state || null };
    }

    async function control(msg) {
      var t = await controlledTab(msg);
      if (t.error) return fail(t.error);
      var out = { type: 'rewind:' + msg.type };
      if (msg.type === 'rate') out.value = msg.value;
      var r = await send(t.tab.id, out);
      if (r.error) return fail('Could not reach the Zoom tab. Reload it and try again. (' + r.error + ')');
      if (!r.reply || !r.reply.ok) return fail((r.reply && r.reply.error) || msg.type + ' failed.');
      return { ok: true, tabId: t.tab.id, state: r.reply.state || null };
    }

    // ---- Embedded player (T9): a Zoom frame inside the sender's own tab ----

    function forgetFrame(tabId, frameId) {
      frames = frames.filter(function (f) { return !(f.tabId === tabId && f.frameId === frameId); });
    }

    // Only the sender's own tab is searched, so a frame in another tab is never reachable.
    function findFrame(sender, recordingUrl) {
      var tabId = sender && sender.tab && sender.tab.id;
      if (typeof tabId !== 'number') return null;
      var matches = frames.filter(function (f) { return f.tabId === tabId && sameRecording(f.recordingUrl, recordingUrl); });
      matches.sort(function (a, b) { return b.seq - a.seq; });
      return matches[0] || null;
    }

    async function sendFrame(frame, msg) {
      try {
        return { reply: await chrome.tabs.sendMessage(frame.tabId, msg, { frameId: frame.frameId }) };
      } catch (e) {
        // The frame went away without a frame-gone message (crash, fast navigation).
        forgetFrame(frame.tabId, frame.frameId);
        return { error: 'no-frame' };
      }
    }

    async function embedRoute(msg, sender) {
      var frame = findFrame(sender, msg.recordingUrl);
      if (!frame) return fail('no-frame');
      var r;
      if (msg.type === 'status') {
        r = await sendFrame(frame, { type: 'rewind:status' });
        if (r.error) return fail(r.error);
        return { ok: true, state: cleanState(r.reply.state), media: cleanMedia(r.reply.media), needsGesture: r.reply.needsGesture !== false };
      }
      if (msg.type === 'embedMode') {
        r = await sendFrame(frame, { type: 'rewind:embedMode', on: msg.on });
        if (r.error) return fail(r.error);
        return r.reply && r.reply.ok ? { ok: true } : fail((r.reply && r.reply.error) || 'embedMode failed.');
      }
      if (msg.type === 'play' && msg.seconds !== undefined) {
        r = await sendFrame(frame, { type: 'rewind:seek', seconds: msg.seconds });
        if (r.error) return fail(r.error);
        if (!r.reply || !r.reply.ok) return fail((r.reply && r.reply.error) || 'seek failed.');
      }
      var out = { type: 'rewind:' + msg.type };
      if (msg.type === 'seek') out.seconds = msg.seconds;
      if (msg.type === 'rate') out.value = msg.value;
      r = await sendFrame(frame, out);
      if (r.error) return fail(r.error);
      if (!r.reply || !r.reply.ok) return fail((r.reply && r.reply.error) || msg.type + ' failed.');
      return { ok: true, state: cleanState(r.reply.state) };
    }

    async function route(msg, sender) {
      if (!originAllowed(sender, allowedOrigins)) return fail('origin');
      var problem = validate(msg);
      if (problem) return fail(problem);
      try {
        if (msg.embed === true) return await embedRoute(msg, sender);
        if (msg.type === 'ping') return { ok: true, version: opts.version || null };
        if (msg.type === 'transcripts') return await transcripts();
        if (msg.type === 'open') return await open(msg);
        if (msg.type === 'seek') return await seek(msg);
        if (msg.type === 'status') return await status(msg);
        if (msg.type === 'focus') return await focus(msg);
        if (msg.type === 'play') return await play(msg);
        return await control(msg);
      } catch (e) {
        return fail(String(e && e.message || e));
      }
    }

    // A long-lived port from the app (chrome.runtime.connect). It receives state events.
    function connect(port) {
      if (!port || !originAllowed(port.sender, allowedOrigins)) {
        try {
          if (port) port.postMessage({ type: 'error', error: 'origin' });
          if (port) port.disconnect();
        } catch (e) {
          // Already gone.
        }
        return;
      }
      ports.push(port);
      port.onDisconnect.addListener(function () {
        ports = ports.filter(function (p) { return p !== port; });
      });
    }

    // Messages from our own content scripts. Forwards Zoom playback state to every app port,
    // only from the current tab when there is one. Only these four numbers/flags are forwarded.
    function onTabMessage(msg, sender) {
      if (!msg || !sender || !sender.tab) return;
      if (msg.type === 'rewind:transcript-exported') {
        // Trust the sender: a Zoom recording frame, adding the transcript of its own recording only.
        if (typeof sender.url !== 'string' || sender.url.indexOf(ZOOM_PREFIX) !== 0) return;
        var t = cleanTranscript(msg.transcript);
        if (!t || t.recordingUrl !== recordingOf(sender.url)) return;
        return keepTranscript(t).catch(function () {});
      }
      if (msg.type === 'rewind:frame-ready' || msg.type === 'rewind:frame-gone') {
        // Trust the sender, not the message: a real subframe whose own URL is a Zoom recording.
        if (typeof sender.frameId !== 'number' || sender.frameId <= 0) return;
        if (typeof sender.url !== 'string' || sender.url.indexOf(ZOOM_PREFIX) !== 0) return;
        var url = recordingOf(sender.url);
        var known = frames.filter(function (f) {
          return f.tabId === sender.tab.id && f.frameId === sender.frameId && f.recordingUrl === url;
        })[0];
        forgetFrame(sender.tab.id, sender.frameId);
        if (msg.type === 'rewind:frame-ready') {
          // Frames re-announce every few seconds (the service worker may have restarted);
          // a repeat keeps its place so "newest frame" means newest loaded, not last heartbeat.
          frames.push({ tabId: sender.tab.id, frameId: sender.frameId, recordingUrl: url, seq: known ? known.seq : ++frameSeq });
        }
        return;
      }
      if (msg.type !== 'rewind:state') return;
      if (typeof sender.tab.url !== 'string' || sender.tab.url.indexOf(ZOOM_PREFIX) !== 0) return;
      if (current && sender.tab.id !== current.tabId) return;
      var num = function (n) { return typeof n === 'number' && isFinite(n) ? n : null; };
      var event = {
        type: 'state',
        currentTime: num(msg.currentTime),
        paused: msg.paused === true,
        rate: num(msg.rate),
        duration: num(msg.duration),
        tabId: sender.tab.id,
        recordingUrl: recordingOf(sender.tab.url)
      };
      ports.forEach(function (p) {
        try {
          p.postMessage(event);
        } catch (e) {
          // Port closed between disconnect and this send.
        }
      });
    }

    // A closed tab takes its embedded frames with it.
    function onTabRemoved(tabId) {
      frames = frames.filter(function (f) { return f.tabId !== tabId; });
    }

    return { route: route, connect: connect, onTabMessage: onTabMessage, onTabRemoved: onTabRemoved };
  }

  return { createRouter: createRouter, validate: validate, sameRecording: sameRecording, senderOrigin: senderOrigin, cleanTranscript: cleanTranscript, memoryTranscripts: memoryTranscripts, MAX_TRANSCRIPTS: MAX_TRANSCRIPTS };
})();
