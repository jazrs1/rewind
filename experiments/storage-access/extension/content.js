// T14 experiment: stands in for the Zoom content script inside the embedded frame. Our own
// "Play here" button over the frame; its click (a real user gesture inside the frame) asks for
// storage access, then reloads the frame so the page loads again with its cookies.
(function () {
  if (window.top === window) return;
  // mode=page: the probe tests the page's own button instead of ours.
  if (location.search.indexOf('mode=page') >= 0) return;
  var b = document.createElement('button');
  b.id = 'rewind-play-here';
  b.textContent = 'Play here';
  b.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;font:700 20px system-ui;background:#FA4616;color:#16241C;border:0;z-index:2147483647';
  b.addEventListener('click', function () {
    var report = function (r) { window.parent.postMessage(Object.assign({ phase: 'request' }, r), '*'); };
    if (!document.requestStorageAccess) {
      report({ requestStorageAccess: 'missing' });
      return;
    }
    document.requestStorageAccess().then(function () {
      report({ requestStorageAccess: 'granted' });
      // Give the parent a moment to log, then reload the frame with access.
      setTimeout(function () { location.reload(); }, 200);
    }, function (e) {
      report({ requestStorageAccess: 'rejected: ' + (e && e.name) });
    });
  });
  document.body.appendChild(b);
})();
