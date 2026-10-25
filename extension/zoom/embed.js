// Embed mode for a Zoom recording shown in an iframe inside the Rewind app (T9).
// On: hides all of Zoom's own UI (title bar, controls, transcript panel, our export button)
// and makes the media element fill the frame, video letterboxed on black. Off: restores it.
// Plain script: loaded as a content script before zoom/content.js, and loaded into a vm
// context by zoom/test/embed.test.js. Adds one class to <html> and to the media element plus
// one <style>; it never reads page content.

var RewindZoomEmbed = (function () {
  var ON_CLASS = 'rewind-embed';
  var MEDIA_CLASS = 'rewind-embed-media';
  var STYLE_ID = 'rewind-embed-style';

  // visibility is inherited but a child can override it, so hiding <body> and showing only
  // the media element works without knowing any of Zoom's own selectors.
  var CSS = [
    'html.' + ON_CLASS + ', html.' + ON_CLASS + ' body {',
    '  background: #000 !important; overflow: hidden !important;',
    '}',
    'html.' + ON_CLASS + ' body { visibility: hidden !important; }',
    'html.' + ON_CLASS + ' .' + MEDIA_CLASS + ' {',
    '  visibility: visible !important;',
    '  position: fixed !important; inset: 0 !important;',
    '  width: 100vw !important; height: 100vh !important;',
    '  max-width: none !important; max-height: none !important; margin: 0 !important;',
    '  object-fit: contain !important; background: #000 !important;',
    '  z-index: 2147483647 !important; transform: none !important;',
    '}'
  ].join('\n');

  function hasClass(el, c) {
    return (' ' + (el.getAttribute('class') || '') + ' ').indexOf(' ' + c + ' ') >= 0;
  }

  function addClass(el, c) {
    if (!hasClass(el, c)) el.setAttribute('class', ((el.getAttribute('class') || '') + ' ' + c).trim());
  }

  function removeClass(el, c) {
    var rest = (el.getAttribute('class') || '').split(/\s+/).filter(function (x) { return x && x !== c; });
    el.setAttribute('class', rest.join(' '));
  }

  // opts: { doc, mediaSelector }
  function createEmbedMode(opts) {
    var doc = opts.doc;
    var on = false;
    var marked = null;

    function markMedia() {
      var m = doc.querySelector(opts.mediaSelector);
      if (m === marked) return;
      if (marked) removeClass(marked, MEDIA_CLASS);
      marked = m;
      if (m) addClass(m, MEDIA_CLASS);
    }

    function set(value) {
      on = !!value;
      var html = doc.documentElement;
      var style = doc.getElementById(STYLE_ID);
      if (on) {
        if (!style) {
          style = doc.createElement('style');
          style.setAttribute('id', STYLE_ID);
          style.textContent = CSS;
          (doc.head || html).appendChild(style);
        }
        addClass(html, ON_CLASS);
        markMedia();
      } else {
        if (style) style.remove();
        removeClass(html, ON_CLASS);
        if (marked) removeClass(marked, MEDIA_CLASS);
        marked = null;
      }
      return { ok: true, on: on };
    }

    // Zoom may replace its media element; call this again to keep the new one filling the frame.
    function refresh() {
      if (on) markMedia();
    }

    return { set: set, refresh: refresh, isOn: function () { return on; } };
  }

  return { createEmbedMode: createEmbedMode, CSS: CSS, ON_CLASS: ON_CLASS, MEDIA_CLASS: MEDIA_CLASS, STYLE_ID: STYLE_ID };
})();
