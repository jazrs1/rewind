// Experiment (T10): one click adds a cookies content-setting exception.
// Default pair is the real one (Zoom embedded in the Rewind app). The probe overrides it with
// #primary=...&secondary=... to test pattern pairs against local test servers.

(function () {
  var DEFAULT = { primary: 'https://ufl.zoom.us/*', secondary: 'http://localhost:3000/*' };
  var out = document.getElementById('out');

  function pair() {
    var p = new URLSearchParams(location.hash.slice(1));
    return {
      primary: p.get('primary') || DEFAULT.primary,
      secondary: p.has('secondary') ? p.get('secondary') : DEFAULT.secondary
    };
  }

  document.getElementById('allow').addEventListener('click', async function () {
    var pp = pair();
    var details = { primaryPattern: pp.primary, setting: 'allow' };
    if (pp.secondary) details.secondaryPattern = pp.secondary;
    try {
      await chrome.contentSettings.cookies.set(details);
      out.textContent = 'ok ' + JSON.stringify(details);
      out.dataset.result = 'ok';
    } catch (e) {
      out.textContent = 'error ' + (e && e.message || e);
      out.dataset.result = 'error';
    }
  });
})();
