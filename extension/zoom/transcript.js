// Zoom recording page -> *.transcript.json. Plain script: loaded as a content script
// before zoom/content.js, and loaded into a vm context by zoom/test/parse.test.js.
// Built against a saved UF Zoom recording page (private/fixtures/zoom-recording.html).

var RewindZoom = (function () {
  // Every DOM selector used on the Zoom page. Checked against the saved fixture.
  var SELECTORS = {
    // One <li> per transcript chunk; the whole transcript is in the DOM (not virtualized).
    item: 'ul.transcript-list li.transcript-list-item',
    // Only the first chunk of a speaker run shows name and time; the rest carry them in aria-label.
    speaker: '.user-name-span',
    time: '.user-info-right .time',
    text: '.timeline .text',
    title: '.recording-topic .topic',
    // "Oct 22, 2026 01:48 PM", page-local time. Used only if the media src has no GMT stamp.
    dateText: '.info-container-time',
    // "01:41:21"; used when the media element has no duration yet (and in the saved page).
    durationText: '.vjs-time-range-duration',
    media: 'audio, video'
  };

  // "5:07", "43:40", "1:02:15", "00:35:18" -> seconds. Returns null if malformed.
  function parseTime(label) {
    var m = String(label).trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    var h = m[1] ? Number(m[1]) : 0;
    var min = Number(m[2]);
    var s = Number(m[3]);
    if (s > 59 || (m[1] !== undefined && min > 59)) return null;
    return h * 3600 + min * 60 + s;
  }

  // "Firstname Kapoor, 0 hours 0 minutes 4 seconds, So, let me..." -> { speaker, start, text }.
  function parseAriaLabel(label) {
    var m = String(label || '').match(
      /^(.*?), (?:(\d+) hours? )?(?:(\d+) minutes? )?(\d+) seconds?, ([\s\S]*)$/
    );
    if (!m) return null;
    return {
      speaker: m[1].trim() || null,
      start: Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4]),
      text: m[5].trim()
    };
  }

  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function textOf(root, selector) {
    var el = root.querySelector(selector);
    return el ? clean(el.textContent) : '';
  }

  // Raw chunks in page order: { start, speaker, text, el }. Visible name/time win;
  // aria-label fills the gaps; a missing speaker carries over from the previous chunk.
  function extractChunks(doc) {
    var items = doc.querySelectorAll(SELECTORS.item);
    var chunks = [];
    var lastSpeaker = null;
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var aria = parseAriaLabel(el.getAttribute('aria-label'));
      var shownTime = parseTime(textOf(el, SELECTORS.time));
      var start = shownTime !== null ? shownTime : aria ? aria.start : null;
      var speaker = textOf(el, SELECTORS.speaker) || (aria && aria.speaker) || lastSpeaker;
      var text = textOf(el, SELECTORS.text) || (aria ? clean(aria.text) : '');
      if (start === null || !text) continue;
      lastSpeaker = speaker;
      chunks.push({ start: start, speaker: speaker || null, text: text, el: el });
    }
    return chunks;
  }

  // Shared splitting rule (AGENT_TASKS.md "Transcript JSON"); must match splitChunk in
  // lib/transcript.ts. Chunks over 20 s are cut after . ? ! + whitespace; pieces under
  // 20 characters join the next (or the previous, if last).
  var SPLIT_OVER_SEC = 20;
  var MIN_PIECE_CHARS = 20;
  var MIN_CHARS_PER_SEC = 5;

  function sentences(text) {
    var pieces = text.split(/(?<=[.?!])\s+/).filter(Boolean);
    var merged = [];
    var carry = '';
    pieces.forEach(function (p) {
      var piece = carry ? carry + ' ' + p : p;
      if (piece.length < MIN_PIECE_CHARS) {
        carry = piece;
      } else {
        merged.push(piece);
        carry = '';
      }
    });
    if (carry) {
      if (merged.length) merged[merged.length - 1] += ' ' + carry;
      else merged.push(carry);
    }
    return merged;
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // One chunk -> sentence segments. Piece k starts at start + span * charsBefore / total,
  // span = min(duration, chars / 5). The first piece keeps the real start; later ones are estimated.
  function splitChunk(chunk) {
    var text = chunk.text.replace(/\s+/g, ' ').trim();
    var whole = [{ speaker: chunk.speaker, start: chunk.start, end: chunk.end, text: text }];
    if (chunk.end - chunk.start <= SPLIT_OVER_SEC) return whole;
    var parts = sentences(text);
    if (parts.length < 2) return whole;

    var span = Math.min(chunk.end - chunk.start, text.length / MIN_CHARS_PER_SEC);
    var starts = [];
    var before = 0;
    parts.forEach(function (p) {
      starts.push(before === 0 ? chunk.start : round1(chunk.start + (span * before) / text.length));
      before += p.length + 1; // the space that followed it
    });
    return parts.map(function (p, i) {
      var seg = { speaker: chunk.speaker, start: starts[i], end: i + 1 < starts.length ? starts[i + 1] : chunk.end, text: p };
      if (i > 0) seg.estimated = true;
      return seg;
    });
  }

  // "...GMT20261022-174809_Recording.m4a" -> "2026-10-22T17:48:09Z".
  function recordedAtFromSrc(src) {
    var m = String(src || '').match(/GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    return m ? m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + 'Z' : null;
  }

  var MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

  // "Oct 22, 2026 01:48 PM" -> "2026-10-22T13:48:00" (no zone: it is the page's local time).
  function recordedAtFromText(text) {
    var m = String(text || '').match(/([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) ?([AP]M)/);
    if (!m || !MONTHS[m[1]]) return null;
    var h = Number(m[4]) % 12 + (m[6] === 'PM' ? 12 : 0);
    function p(n) { return String(n).padStart(2, '0'); }
    return m[3] + '-' + p(MONTHS[m[1]]) + '-' + p(m[2]) + 'T' + p(h) + ':' + m[5] + ':00';
  }

  // Builds the shared transcript JSON. Each page item's start is real (from the page).
  // Items over 20 s are split into sentences; then `chunks` keeps the page's own items.
  function buildTranscript(doc, recordingUrl) {
    var raw = extractChunks(doc);
    var media = doc.querySelector(SELECTORS.media);
    var durationSec = media && isFinite(media.duration) && media.duration > 0
      ? round1(media.duration)
      : parseTime(textOf(doc, SELECTORS.durationText));
    if (durationSec === null) durationSec = raw.length ? raw[raw.length - 1].start : 0;

    var chunks = raw.map(function (c, i) {
      var next = i + 1 < raw.length ? raw[i + 1].start : durationSec;
      return { start: c.start, end: Math.max(c.start, next), speaker: c.speaker, text: c.text };
    });

    var split = chunks.some(function (c) { return c.end - c.start > SPLIT_OVER_SEC; });
    var t = {
      source: 'zoom',
      recordingUrl: recordingUrl,
      title: textOf(doc, SELECTORS.title) || 'Zoom recording',
      recordedAt: recordedAtFromSrc(media && media.getAttribute('src')) ||
        recordedAtFromText(textOf(doc, SELECTORS.dateText)),
      durationSec: durationSec,
      segments: split
        ? chunks.reduce(function (out, c) { return out.concat(splitChunk(c)); }, [])
        : chunks
    };
    if (split) t.chunks = chunks;
    return t;
  }

  function transcriptFilename(t) {
    var name = t.title + (t.recordedAt ? ' ' + t.recordedAt.slice(0, 10) : '');
    return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') + '.transcript.json';
  }

  // Seek fallback: the chunk element to click for `seconds` (last chunk starting at or before it).
  function chunkElementFor(doc, seconds) {
    var chunks = extractChunks(doc);
    var best = null;
    for (var i = 0; i < chunks.length; i++) {
      if (chunks[i].start <= seconds) best = chunks[i];
      else break;
    }
    return best ? best.el : chunks.length ? chunks[0].el : null;
  }

  return {
    SELECTORS: SELECTORS,
    parseTime: parseTime,
    parseAriaLabel: parseAriaLabel,
    extractChunks: extractChunks,
    splitChunk: splitChunk,
    recordedAtFromSrc: recordedAtFromSrc,
    recordedAtFromText: recordedAtFromText,
    buildTranscript: buildTranscript,
    transcriptFilename: transcriptFilename,
    chunkElementFor: chunkElementFor
  };
})();
