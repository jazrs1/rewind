// Controls the Zoom page's own <audio>/<video> so the Rewind app can use a background
// Zoom tab as its audio source. Plain script: loaded as a content script before
// zoom/content.js, and loaded into a vm context by zoom/test/player.test.js.
// Reads only currentTime, paused, playbackRate and duration; never the media stream.

var RewindZoomPlayer = (function () {
  var MIN_RATE = 0.5;
  var MAX_RATE = 2;
  // timeupdate fires about 4x/s while playing; never send faster than this.
  var MIN_STATE_GAP_MS = 200;
  var EVENTS = ['play', 'playing', 'pause', 'ratechange', 'seeked', 'durationchange', 'timeupdate', 'ended'];
  // A seek counts once currentTime reads back within this many seconds of the target.
  var SEEK_TOLERANCE = 1;
  // How long a seek waits for the media (its element, then its metadata) before replying seek-failed.
  var SEEK_TIMEOUT_MS = 3000;
  // How often a pending seek re-checks between media events.
  var SEEK_CHECK_MS = 100;
  // Events after which a pending seek tries again: metadata or data arrived, or the source was reset.
  var SEEK_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked', 'durationchange', 'emptied', 'loadstart'];

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  // A media element whose metadata has loaded: before that, setting currentTime doesn't stick
  // (the element may reset it, or the page's player may load a new source over it).
  function hasMetadata(m) {
    return typeof m.readyState === 'number' ? m.readyState >= 1 : true;
  }

  // opts: { doc, mediaSelector, send(state), now(), chunkElementFor(doc, seconds), onAttach(media),
  //         setTimer(fn, ms), clearTimer(t), seekTimeoutMs }
  function createPlayer(opts) {
    var doc = opts.doc;
    var now = opts.now || function () { return Date.now(); };
    var setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = opts.clearTimer || function (t) { clearTimeout(t); };
    var seekTimeoutMs = opts.seekTimeoutMs || SEEK_TIMEOUT_MS;
    var attached = null;
    var lastSentAt = -Infinity;
    var lastKey = '';

    function media() {
      return doc.querySelector(opts.mediaSelector);
    }

    function stateOf(m) {
      return {
        currentTime: round2(m.currentTime || 0),
        paused: !!m.paused,
        rate: m.playbackRate,
        duration: isFinite(m.duration) && m.duration > 0 ? round2(m.duration) : null
      };
    }

    function state() {
      var m = media();
      return m ? stateOf(m) : null;
    }

    // Sends on any change of paused/rate/duration or a jump while paused; while playing,
    // at most every 200 ms (timeupdate drives it, so throttled background timers don't matter).
    function emit(force) {
      var m = attached;
      if (!m) return;
      var s = stateOf(m);
      var key = s.paused + '|' + s.rate + '|' + s.duration + '|' + (s.paused ? s.currentTime : '');
      var t = now();
      if (!force && key === lastKey && (s.paused || t - lastSentAt < MIN_STATE_GAP_MS)) return;
      lastKey = key;
      lastSentAt = t;
      opts.send(s);
    }

    function onMediaEvent(e) {
      emit(e && e.type !== 'timeupdate');
    }

    // The player may create or replace its media element after load; call this again to follow it.
    function attach() {
      var m = media();
      if (!m || m === attached) return !!m;
      if (attached) EVENTS.forEach(function (ev) { attached.removeEventListener(ev, onMediaEvent); });
      attached = m;
      EVENTS.forEach(function (ev) { m.addEventListener(ev, onMediaEvent); });
      emit(true);
      if (opts.onAttach) opts.onAttach(m);
      return true;
    }

    // { kind, videoWidth, videoHeight }: sizes are null for audio or before metadata loads.
    function mediaInfo() {
      var m = media();
      if (!m) return null;
      var video = String(m.tagName || '').toLowerCase() === 'video';
      var size = function (n) { return video && typeof n === 'number' && n > 0 ? n : null; };
      return { kind: video ? 'video' : 'audio', videoWidth: size(m.videoWidth), videoHeight: size(m.videoHeight) };
    }

    // Sticky user activation: Chrome lets a tab play() on its own once the user has clicked in it.
    function needsGesture() {
      var ua = opts.userActivation;
      return !(ua && ua.hasBeenActive);
    }

    function status() {
      attach();
      return { ok: true, needsGesture: needsGesture(), hasMedia: !!media(), state: state(), media: mediaInfo() };
    }

    // With seconds: seeks first and plays only once the seek is confirmed.
    function play(seconds) {
      if (seconds !== undefined) {
        return seek(seconds).then(function (r) {
          return r.ok ? play() : r;
        });
      }
      var m = media();
      if (!m) return Promise.resolve({ ok: false, error: 'No audio/video element on this page yet.' });
      attach();
      return Promise.resolve()
        .then(function () { return m.play(); })
        .then(function () {
          return { ok: true, state: stateOf(m) };
        }, function (e) {
          return { ok: false, error: e && e.name === 'NotAllowedError' ? 'needs-gesture' : String(e && e.message || e) };
        });
    }

    function pause() {
      var m = media();
      if (!m) return { ok: false, error: 'No audio/video element on this page yet.' };
      attach();
      m.pause();
      return { ok: true, state: stateOf(m) };
    }

    function rate(value) {
      if (typeof value !== 'number' || !isFinite(value) || value < MIN_RATE || value > MAX_RATE) {
        return { ok: false, error: 'rate must be a number from ' + MIN_RATE + ' to ' + MAX_RATE + '.' };
      }
      var m = media();
      if (!m) return { ok: false, error: 'No audio/video element on this page yet.' };
      attach();
      m.playbackRate = value;
      return { ok: true, state: stateOf(m) };
    }

    // Seek and confirm. The page may build its media element late, load its metadata late, or
    // replace the element; until the media has metadata the seek is held, and it is (re)applied to
    // whichever element is current. Resolves once currentTime reads back within 1 s of the target,
    // or with { ok: false, error: 'seek-failed' } after about 3 s.
    function seek(seconds) {
      if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) {
        return Promise.resolve({ ok: false, error: 'seconds must be a non-negative number' });
      }
      if (!media()) {
        // A Zoom tab whose player hasn't built its media yet can still jump by its transcript.
        var el = opts.chunkElementFor ? opts.chunkElementFor(doc, seconds) : null;
        if (el) {
          el.click();
          return Promise.resolve({ ok: true, method: 'transcript-click', seconds: seconds });
        }
      }
      return new Promise(function (resolve) {
        var deadline = now() + seekTimeoutMs;
        var watched = null;
        var timer = null;
        var done = false;

        function watch(m) {
          if (m === watched) return;
          if (watched) SEEK_EVENTS.forEach(function (ev) { watched.removeEventListener(ev, check); });
          watched = m;
          if (m) SEEK_EVENTS.forEach(function (ev) { m.addEventListener(ev, check); });
        }

        function finish(reply) {
          done = true;
          if (timer !== null) clearTimer(timer);
          watch(null);
          resolve(reply);
        }

        function target(m) {
          // A seek past the end lands on the end.
          return isFinite(m.duration) && m.duration > 0 ? Math.min(seconds, m.duration) : seconds;
        }

        function check() {
          if (done) return;
          if (timer !== null) {
            clearTimer(timer);
            timer = null;
          }
          attach();
          var m = media();
          watch(m);
          if (m && hasMetadata(m)) {
            var to = target(m);
            if (Math.abs((m.currentTime || 0) - to) <= SEEK_TOLERANCE) {
              finish({ ok: true, method: 'media', seconds: seconds, state: stateOf(m) });
              return;
            }
            // Not there yet (first try, a new element, or the page moved it away again): apply,
            // then read it back on the next check rather than trusting the setter.
            m.currentTime = to;
          }
          if (now() >= deadline) {
            finish({ ok: false, error: 'seek-failed', state: m ? stateOf(m) : null });
            return;
          }
          timer = setTimer(check, SEEK_CHECK_MS);
        }

        check();
      });
    }

    return {
      attach: attach, status: status, state: state, mediaInfo: mediaInfo,
      play: play, pause: pause, rate: rate, seek: seek
    };
  }

  return { createPlayer: createPlayer, MIN_RATE: MIN_RATE, MAX_RATE: MAX_RATE, SEEK_TIMEOUT_MS: SEEK_TIMEOUT_MS };
})();
