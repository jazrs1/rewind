// Popup logic with no DOM: which courses to show first, which one is selected, a course's tape colour, and Canvas's
// errors in plain words. Plain script: loaded by popup.html before popup.js, and into a vm by test/popup.test.js.

var RewindPopup = (function () {
  // A real course carries a code like COP3530 (UF: three letters, four digits, an optional letter).
  var CODE = /\b([A-Z]{3})\s?(\d{4})[A-Z]?\b/;

  /** "https://ufl.instructure.com/courses/424242/modules" -> "424242"; null off a course page. */
  function courseIdFromUrl(url) {
    var m = /^https:\/\/[^/]+\/courses\/(\d+)(?:[/?#]|$)/.exec(String(url || ''));
    return m ? m[1] : null;
  }

  /** "COP3530" for a real course (from its course_code, else its name); null for AlcoholEdu, Title IX... */
  function codeOf(c) {
    var m = CODE.exec(String((c && c.course_code) || '')) || CODE.exec(String((c && c.name) || ''));
    return m ? m[1] + m[2] : null;
  }

  function termId(c) {
    return c && c.term && c.term.id != null ? String(c.term.id) : null;
  }

  function time(s) {
    var t = typeof s === 'string' ? Date.parse(s) : NaN;
    return isFinite(t) ? t : null;
  }

  /**
   * The current term: among real courses, the term that has started most recently (start_at <= now); if no term has
   * dates, the one most real courses share; null if none has a term.
   */
  function currentTerm(courses, now) {
    var real = courses.filter(codeOf);
    var best = null;
    var bestStart = -Infinity;
    real.forEach(function (c) {
      var start = time(c.term && c.term.start_at);
      if (start !== null && start <= now && start > bestStart) {
        bestStart = start;
        best = termId(c);
      }
    });
    if (best) return best;
    var counts = {};
    real.forEach(function (c) {
      var t = termId(c);
      if (t) counts[t] = (counts[t] || 0) + 1;
    });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    return keys[0] || null;
  }

  /**
   * The list: real courses in the current term first (by code), then everything else under "Other enrollments" (by
   * name). The course of the current Canvas tab is selected; else the first real one. If the selected course is an
   * "other" one, that group starts open.
   */
  function groupCourses(courses, opts) {
    opts = opts || {};
    var list = (courses || []).filter(function (c) { return c && c.id != null && c.name; });
    var term = currentTerm(list, opts.now == null ? Date.now() : opts.now);
    var main = [];
    var other = [];
    list.forEach(function (c) {
      if (codeOf(c) && (!term || !termId(c) || termId(c) === term)) main.push(c);
      else other.push(c);
    });
    main.sort(function (a, b) { return codeOf(a).localeCompare(codeOf(b)) || String(a.name).localeCompare(String(b.name)); });
    other.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    var all = main.concat(other);
    var current = opts.currentId == null ? null : String(opts.currentId);
    var picked = all.filter(function (c) { return String(c.id) === current; })[0] || main[0] || other[0] || null;
    return {
      main: main,
      other: other,
      selectedId: picked ? String(picked.id) : null,
      otherOpen: !!picked && other.indexOf(picked) >= 0
    };
  }

  /** A course's tape colour, 0-3, the same for the same code every time. */
  function tapeIndex(code) {
    var s = String(code || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 4;
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  /**
   * Canvas's errors from an export, in plain words, never raw ("error 404 on /api/v1/courses/1/pages"). Errors that
   * didn't matter are dropped (pages that came through Modules anyway). `details` keeps the technical lines for the
   * "Details" disclosure.
   */
  function plainErrors(errors, counts) {
    errors = errors || [];
    counts = counts || {};
    var notes = [];
    var details = [];
    var add = function (s) { if (notes.indexOf(s) < 0) notes.push(s); };
    var missingItems = 0;
    var otherItems = 0;
    errors.forEach(function (e) {
      var endpoint = String((e && e.endpoint) || '');
      var status = e && typeof e.status === 'number' ? e.status : null;
      var line = (status === null ? 'network' : String(status)) + ' · ' + endpoint;
      if (details.indexOf(line) < 0) details.push(line);
      var list = /\/(pages|files|modules|assignments|announcements|discussion_topics)\/?$/.exec(endpoint.split('?')[0]);
      if (status === 401) add("Canvas says you're signed out. Sign in to Canvas and export again.");
      else if (status === 429) add('Canvas asked us to slow down, so a few items were skipped. Export again in a minute for the rest.');
      else if (status === null) add('The connection dropped for a moment, so a few items may be missing.');
      else if (list && list[1] === 'pages' && (status === 404 || status === 403)) {
        if (!counts.pages) add("This course doesn't share Canvas pages with students.");
      } else if (list && list[1] === 'files' && (status === 404 || status === 403)) {
        add(counts.files
          ? "Your course doesn't let students list its files; the ones linked in modules came through."
          : "Your course doesn't let students download its files.");
      } else if (list && (status === 404 || status === 403)) {
        // A section this course doesn't use or show to students: nothing was missed.
      } else if (status === 404 || status === 403) missingItems++;
      else otherItems++;
    });
    if (missingItems) add(plural(missingItems, 'item') + " couldn't be opened: removed, or hidden from students.");
    if (otherItems) add(plural(otherItems, 'item') + " couldn't be read. Exporting again may get " + (otherItems === 1 ? 'it' : 'them') + '.');
    return { notes: notes, details: details };
  }

  /** A whole export that failed, in plain words. */
  function plainFailure(message) {
    var m = String(message || '');
    if (/401|not logged|signed out|unauthori[sz]ed/i.test(m)) return "Canvas says you're signed out. Sign in to Canvas, then try again.";
    if (/failed to fetch|network|connection|disconnected|receiving end/i.test(m)) return "Couldn't reach Canvas from this tab. Reload the Canvas tab, then try again.";
    if (/already running/i.test(m)) return 'An export is already running in this tab. Wait for it to finish.';
    return 'The export stopped before it finished. Try again.';
  }

  /** "Module files 12 of 59" -> 0.2 for the bar; null when the text has no "N of M". */
  function progressShare(text) {
    var m = /(\d+)\s+of\s+(\d+)/.exec(String(text || ''));
    if (!m || +m[2] <= 0) return null;
    return Math.max(0, Math.min(1, +m[1] / +m[2]));
  }

  return {
    courseIdFromUrl: courseIdFromUrl,
    codeOf: codeOf,
    currentTerm: currentTerm,
    groupCourses: groupCourses,
    tapeIndex: tapeIndex,
    plainErrors: plainErrors,
    plainFailure: plainFailure,
    progressShare: progressShare
  };
})();
