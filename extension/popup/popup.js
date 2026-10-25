// Popup: asks the content script in the active Canvas tab for courses, lets the student pick one (the current tab's
// course is preselected; real courses for this term first, the rest under "Other enrollments"), and starts the export
// there. The content script does all fetching and the download. States: loading, not on Canvas (or a Zoom recording,
// with "Export lecture transcript"), picking, exporting, done, error. Canvas's errors are shown in plain words
// (courses.js); the technical lines sit behind "Details".

(function () {
  var P = RewindPopup;
  var $ = function (id) { return document.getElementById(id); };
  var STATES = ['loading', 'empty', 'pick', 'progress', 'done', 'error'];
  var button = $('export');
  var tabId = null;
  var courses = [];
  var selectedId = null;
  var lastAction = null;

  function show(state) {
    STATES.forEach(function (s) { $('state-' + s).hidden = s !== state; });
    button.hidden = !(state === 'pick' || state === 'error');
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function courseById(id) {
    return courses.filter(function (c) { return String(c.id) === String(id); })[0] || null;
  }

  // --- The course list (role=listbox, one selection across the two lists; arrows, Home and End move it) ---
  function row(c) {
    var code = P.codeOf(c);
    var li = el('li', 'row');
    li.id = 'course-' + c.id;
    li.setAttribute('role', 'option');
    li.dataset.id = String(c.id);
    li.appendChild(el('span', 'code ' + (code ? 't' + P.tapeIndex(code) : 'none'), code || '·'));
    li.appendChild(el('span', 'name', c.name));
    li.appendChild(el('span', 'term', (c.term && c.term.name) || (code ? 'Course' : 'Enrollment')));
    li.title = c.name;
    li.addEventListener('click', function () { select(c.id, true); });
    return li;
  }

  function options() {
    var lists = [$('courses')];
    if (!$('other-courses').hidden) lists.push($('other-courses'));
    var out = [];
    lists.forEach(function (l) { out = out.concat(Array.prototype.slice.call(l.querySelectorAll('[role=option]'))); });
    return out;
  }

  function select(id, focus) {
    selectedId = String(id);
    Array.prototype.slice.call(document.querySelectorAll('[role=option]')).forEach(function (o) {
      o.setAttribute('aria-selected', o.dataset.id === selectedId ? 'true' : 'false');
    });
    var opt = $('course-' + selectedId);
    if (!opt) return;
    var list = opt.parentElement;
    ['courses', 'other-courses'].forEach(function (l) { $(l).removeAttribute('aria-activedescendant'); });
    list.setAttribute('aria-activedescendant', opt.id);
    opt.scrollIntoView({ block: 'nearest' });
    if (focus) list.focus();
    button.disabled = false;
  }

  function onKey(e) {
    var opts = options();
    var i = opts.findIndex(function (o) { return o.dataset.id === selectedId; });
    var next = null;
    if (e.key === 'ArrowDown') next = opts[Math.min(opts.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = opts[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = opts[0];
    else if (e.key === 'End') next = opts[opts.length - 1];
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (!button.disabled) startExport();
      return;
    }
    if (next) {
      e.preventDefault();
      select(next.dataset.id, true);
    }
  }
  $('courses').addEventListener('keydown', onKey);
  $('other-courses').addEventListener('keydown', onKey);

  $('other-toggle').addEventListener('click', function () {
    var open = $('other-toggle').getAttribute('aria-expanded') !== 'true';
    $('other-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('other-courses').hidden = !open;
  });

  function renderCourses(list, currentId) {
    courses = list;
    var g = P.groupCourses(list, { currentId: currentId });
    $('courses').textContent = '';
    $('other-courses').textContent = '';
    g.main.forEach(function (c) { $('courses').appendChild(row(c)); });
    g.other.forEach(function (c) { $('other-courses').appendChild(row(c)); });
    $('courses').hidden = !g.main.length;
    $('other-toggle').hidden = !g.other.length;
    $('other-label').textContent = 'Other enrollments (' + g.other.length + ')';
    $('other-toggle').setAttribute('aria-expanded', g.otherOpen || !g.main.length ? 'true' : 'false');
    $('other-courses').hidden = !(g.otherOpen || !g.main.length);
    show('pick');
    if (g.selectedId) select(g.selectedId, false);
  }

  // --- States ---
  function empty(title, text, zoom) {
    $('empty-title').textContent = title;
    $('empty-text').textContent = text;
    $('open-canvas').hidden = !!zoom;
    $('transcript').hidden = !zoom;
    show('empty');
  }

  function failed(message, detail, retry) {
    $('error-text').textContent = message;
    $('error-details').hidden = !detail;
    $('error-details-text').textContent = detail || '';
    lastAction = retry;
    button.textContent = 'Try again';
    button.disabled = false;
    show('error');
  }

  function progress(text) {
    $('progress-text').textContent = text;
    var share = P.progressShare(text);
    var bar = $('progress-fill').parentElement;
    bar.classList.toggle('indeterminate', share === null);
    if (share === null) bar.removeAttribute('aria-valuenow');
    else {
      $('progress-fill').style.width = Math.max(6, Math.round(share * 100)) + '%';
      bar.setAttribute('aria-valuenow', String(Math.round(share * 100)));
    }
  }

  function chip(n, label) {
    var li = el('li');
    li.appendChild(el('span', 'num', String(n)));
    li.appendChild(document.createTextNode(label));
    return li;
  }

  function done(res, course) {
    $('done-files').textContent = '';
    var f = el('li');
    f.appendChild(el('span', 'fname', res.filename));
    f.appendChild(el('span', 'muted small', 'Course pages and announcements, for Quick build.'));
    $('done-files').appendChild(f);
    $('done-counts').textContent = '';
    var counts = res.counts || {};
    [['pages', 'pages'], ['modules', 'modules'], ['files', 'files'], ['announcements', 'announcements']].forEach(function (k) {
      if (typeof counts[k[0]] === 'number') $('done-counts').appendChild(chip(counts[k[0]], k[1]));
    });
    var plain = P.plainErrors(res.errors, counts);
    $('done-notes').textContent = '';
    plain.notes.forEach(function (n) { $('done-notes').appendChild(el('li', null, n)); });
    $('done-details').hidden = !plain.details.length;
    $('done-details-list').textContent = '';
    plain.details.forEach(function (d) { $('done-details-list').appendChild(el('li', null, d)); });
    $('build-link').textContent = 'Build practice on rewindit.org';
    void course;
    show('done');
  }

  chrome.runtime.onMessage.addListener(function (msg, sender) {
    if (msg && msg.type === 'rewind:progress' && sender.tab && sender.tab.id === tabId) progress(msg.text);
  });

  async function startExport() {
    var course = courseById(selectedId);
    if (!course) return;
    lastAction = startExport;
    button.disabled = true;
    $('progress-course').textContent = 'Exporting ' + (P.codeOf(course) || course.name);
    progress('Starting…');
    show('progress');
    var res;
    try {
      res = await chrome.tabs.sendMessage(tabId, { type: 'rewind:export', courseId: course.id });
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    button.textContent = 'Export course';
    button.disabled = false;
    if (!res || !res.ok) return failed(P.plainFailure(res && res.error), (res && res.error) || 'No answer from the Canvas tab.', startExport);
    done(res, course);
  }

  async function exportTranscript() {
    lastAction = exportTranscript;
    $('progress-course').textContent = 'Exporting the transcript';
    progress('Reading the transcript…');
    show('progress');
    var res;
    try {
      res = await chrome.tabs.sendMessage(tabId, { type: 'rewind:exportTranscript' });
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    if (!res || !res.ok) {
      return failed(
        /no transcript/i.test((res && res.error) || '') ? 'No transcript yet. Open the Audio Transcript tab on the recording, wait for it to load, then try again.' : P.plainFailure(res && res.error),
        (res && res.error) || null,
        exportTranscript
      );
    }
    $('done-files').textContent = '';
    var f = el('li');
    f.appendChild(el('span', 'fname', res.filename));
    f.appendChild(el('span', 'muted small', 'The lecture’s transcript, for rewind moments in Quick build.'));
    $('done-files').appendChild(f);
    $('done-counts').textContent = '';
    $('done-counts').appendChild(chip(res.segments || 0, 'lines'));
    $('done-notes').textContent = '';
    $('done-details').hidden = true;
    show('done');
  }

  button.addEventListener('click', function () {
    if (lastAction && !$('state-error').hidden) lastAction();
    else startExport();
  });
  $('transcript').addEventListener('click', function () { exportTranscript(); });

  async function init() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    var url = (tab && tab.url) || '';
    tabId = tab ? tab.id : null;
    if (url.indexOf('https://ufl.zoom.us/rec/') === 0) {
      return empty('This is a lecture recording', 'Export its transcript to add rewind moments to your questions. To export a course, open it in Canvas.', true);
    }
    if (url.indexOf('https://ufl.instructure.com/') !== 0) {
      return empty('Open a Canvas course to export it', 'Go to your course in Canvas, then click Rewind again.', false);
    }
    var res;
    try {
      res = await chrome.tabs.sendMessage(tabId, { type: 'rewind:listCourses' });
    } catch (e) {
      return failed('Reload the Canvas tab, then click Rewind again. (The extension was installed after the tab opened.)', String(e), init);
    }
    if (!res || !res.courses || !res.courses.length) {
      var err = res && res.errors && res.errors[0];
      if (err && err.status === 401) return failed("Canvas says you're signed out. Sign in to Canvas, then try again.", '401 · ' + err.endpoint, init);
      return empty('No courses yet', 'Canvas shows no active courses for you. Check that you are signed in to the right account.', false);
    }
    renderCourses(res.courses, P.courseIdFromUrl(url));
  }

  init().catch(function (e) { failed('Something went wrong opening Rewind. Try again.', String(e), init); });
})();
