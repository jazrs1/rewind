// Runs on ufl.zoom.us/rec/*. Adds an "Export transcript" button and lets the bridge use
// this tab as the Rewind player's audio source. Messages (from the extension's bridge):
//   { type: 'rewind:status' }          -> { ok, needsGesture, hasMedia, state, media }
//   { type: 'rewind:embedMode', on }   -> { ok, on }  (hide Zoom's UI, media fills the frame)
//   { type: 'rewind:play', seconds? }  -> { ok, state } or { ok: false, error: 'needs-gesture' | 'seek-failed' | ... }
//                                         (with seconds: seeks and confirms first, then plays)
//   { type: 'rewind:pause' }           -> { ok, state }
//   { type: 'rewind:rate', value }     -> { ok, state }
//   { type: 'rewind:seek', seconds }   -> { ok, method: 'media' | 'transcript-click', state } or { ok: false, error }
//                                         Held until the media has metadata, re-applied if Zoom replaces
//                                         the element, and confirmed by reading currentTime back (within
//                                         1 s); { ok: false, error: 'seek-failed', state } after ~3 s.
//   { type: 'rewind:zoomTranscript' }  -> { ok, transcript, filename } or { ok: false, error }
// It also sends { type: 'rewind:state', currentTime, paused, rate, duration } to the extension
// on every change and about 4x/s while playing. Inside an iframe (T9) it also sends
// { type: 'rewind:frame-ready', recordingUrl } once its media exists and
// { type: 'rewind:frame-gone' } on pagehide.

(function () {
  var Z = RewindZoom;
  // Embedded in another page (the Rewind app, T9) rather than its own tab.
  var inFrame = window.top !== window;
  var embed = RewindZoomEmbed.createEmbedMode({ doc: document, mediaSelector: Z.SELECTORS.media });

  function tell(msg) {
    chrome.runtime.sendMessage(msg).catch(function () {
      // Extension reloaded or not listening; the next change tries again.
    });
  }

  var player = RewindZoomPlayer.createPlayer({
    doc: document,
    mediaSelector: Z.SELECTORS.media,
    userActivation: navigator.userActivation,
    chunkElementFor: Z.chunkElementFor,
    send: function (state) {
      tell(Object.assign({ type: 'rewind:state' }, state));
    },
    // A frame registers once its media exists (again if Zoom replaces it), so the bridge
    // learns (tabId, frameId) from the message sender.
    onAttach: function () {
      embed.refresh();
      if (inFrame) tell({ type: 'rewind:frame-ready', recordingUrl: recordingUrl() });
    }
  });
  if (inFrame) {
    window.addEventListener('pagehide', function () {
      tell({ type: 'rewind:frame-gone' });
    });
    // The extension's service worker keeps the frame list in memory and may restart.
    setInterval(function () {
      if (player.mediaInfo()) tell({ type: 'rewind:frame-ready', recordingUrl: recordingUrl() });
    }, 5000);
  }
  // The Zoom player builds its media element after load and may replace it.
  player.attach();
  setInterval(player.attach, 1000);

  function recordingUrl() {
    // Path only: query strings can carry start times or tracking, not the recording identity.
    return location.origin + location.pathname;
  }

  function transcriptOrError() {
    var t = Z.buildTranscript(document, recordingUrl());
    if (!t.segments.length) {
      return { ok: false, error: 'No transcript found. Open the Audio Transcript tab and wait for it to load.' };
    }
    return { ok: true, transcript: t, filename: Z.transcriptFilename(t) };
  }

  function download(res) {
    var blob = new Blob([JSON.stringify(res.transcript, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = res.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return false;
    if (msg.type === 'rewind:status') {
      sendResponse(player.status());
      return false;
    }
    if (msg.type === 'rewind:play') {
      player.play(typeof msg.seconds === 'number' ? msg.seconds : undefined).then(sendResponse);
      return true;
    }
    if (msg.type === 'rewind:pause') {
      sendResponse(player.pause());
      return false;
    }
    if (msg.type === 'rewind:rate') {
      sendResponse(player.rate(msg.value));
      return false;
    }
    if (msg.type === 'rewind:seek') {
      // Held until the media has metadata, then confirmed by reading currentTime back (up to ~3 s).
      player.seek(msg.seconds).then(sendResponse);
      return true;
    }
    if (msg.type === 'rewind:embedMode') {
      sendResponse(embed.set(msg.on === true));
      return false;
    }
    if (msg.type === 'rewind:zoomTranscript') {
      sendResponse(transcriptOrError());
      return false;
    }
    // The popup's "Export lecture transcript": the top frame only (the recording page itself), so one answer comes back.
    if (msg.type === 'rewind:exportTranscript') {
      if (window !== window.top) return false;
      sendResponse(exportTranscript());
      return false;
    }
    return false;
  });

  // "Export transcript", from the page's button or the popup: the download, and a copy kept by the extension on this
  // device so Rewind's "Add lecture recordings" step counts it.
  function exportTranscript() {
    var res = transcriptOrError();
    if (!res.ok) return res;
    download(res);
    try {
      var sent = chrome.runtime.sendMessage({ type: 'rewind:transcript-exported', transcript: res.transcript });
      if (sent && typeof sent.catch === 'function') sent.catch(function () {});
    } catch (e) {
      // Extension reloaded: the download still happened.
    }
    return { ok: true, filename: res.filename, segments: res.transcript.segments.length };
  }

  function addButton() {
    if (document.getElementById('rewind-export-transcript')) return;
    var b = document.createElement('button');
    b.id = 'rewind-export-transcript';
    b.type = 'button';
    b.textContent = 'Rewind: export transcript';
    b.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'min-height:44px', 'padding:0 16px', 'border:0', 'border-radius:6px',
      'background:#FA4616', 'color:#16241C', 'font:700 14px system-ui,sans-serif',
      'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,.3)'
    ].join(';');
    b.addEventListener('click', function () {
      var res = exportTranscript();
      b.textContent = res.ok ? 'Saved ' + res.segments + ' segments' : res.error;
    });
    document.body.appendChild(b);
  }

  addButton();
})();
