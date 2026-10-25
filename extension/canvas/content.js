// Runs on ufl.instructure.com. Fetches are same-origin, so the student's own
// logged-in session is used; nothing here reads or stores cookies.

(function () {
  var running = false;

  function progress(text) {
    chrome.runtime.sendMessage({ type: 'rewind:progress', text: text }).catch(function () {
      // Popup closed; the export keeps going and still downloads at the end.
    });
  }

  // The download happens here, not in the popup, so closing the popup mid-export is safe.
  function download(exp) {
    var blob = new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = RewindCanvas.exportFilename(exp);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    var opts = { fetch: window.fetch.bind(window), origin: location.origin };

    if (msg && msg.type === 'rewind:listCourses') {
      RewindCanvas.listCourses(opts).then(sendResponse, function (e) {
        sendResponse({ courses: [], errors: [{ endpoint: '/api/v1/courses', status: null, message: String(e) }] });
      });
      return true;
    }

    if (msg && msg.type === 'rewind:export') {
      if (running) {
        sendResponse({ ok: false, error: 'An export is already running in this tab.' });
        return false;
      }
      running = true;
      opts.onProgress = progress;
      RewindCanvas.exportCourse(msg.courseId, opts).then(function (exp) {
        running = false;
        download(exp);
        sendResponse({
          ok: true,
          filename: RewindCanvas.exportFilename(exp),
          counts: {
            files: exp.files.length,
            modules: exp.modules.length,
            pages: exp.pages.length,
            assignments: exp.assignments.length,
            announcements: exp.announcements.length,
            submissions: exp.submissions.length
          },
          errors: exp.errors
        });
      }, function (e) {
        running = false;
        sendResponse({ ok: false, error: String(e) });
      });
      return true;
    }
    return false;
  });
})();
