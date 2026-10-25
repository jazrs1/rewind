// Run: node extension/test/popup.test.js
// popup/courses.js: the course picker's order and selection, tape colours, and Canvas's errors in plain words.
// Invented courses only.

var finished = false;
process.on('exit', function () {
  if (!finished) {
    console.log('FAIL a test never finished');
    process.exitCode = 1;
  }
});

(async function () {
  var fs = await import('node:fs');
  var path = await import('node:path');
  var vm = await import('node:vm');
  var assert = (await import('node:assert')).strict;
  var here = path.dirname(process.argv[1]);
  var ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'popup', 'courses.js'), 'utf8') + '\nthis.P = RewindPopup;', ctx);
  var P = ctx.P;
  var plain = function (x) { return JSON.parse(JSON.stringify(x)); };

  var FALL = { id: 9, name: 'Fall 2026', start_at: '2026-08-24T04:00:00Z' };
  var SPRING = { id: 8, name: 'Spring 2026', start_at: '2026-01-07T05:00:00Z' };
  var NOW = Date.parse('2026-10-25T12:00:00Z');
  var COURSES = [
    { id: 1, name: 'AlcoholEdu for College', course_code: 'AlcoholEdu', term: { id: 1, name: 'Default Term' } },
    { id: 2, name: 'Data Structures and Algorithms', course_code: 'COP3530', term: FALL },
    { id: 3, name: 'Hazing 101', course_code: 'HAZING', term: FALL },
    { id: 4, name: 'Computational Linear Algebra', course_code: 'MAS3114', term: FALL },
    { id: 5, name: 'Title IX Training', course_code: 'TitleIX', term: { id: 1, name: 'Default Term' } },
    { id: 6, name: 'Calculus 2', course_code: 'MAC2312', term: SPRING },
    { id: 7, name: 'Career Prep', course_code: 'CAREER', term: FALL }
  ];

  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  test('the current tab\'s course id, from any Canvas course page', function () {
    assert.equal(P.courseIdFromUrl('https://ufl.instructure.com/courses/424242'), '424242');
    assert.equal(P.courseIdFromUrl('https://ufl.instructure.com/courses/424242/modules?x=1'), '424242');
    assert.equal(P.courseIdFromUrl('https://ufl.instructure.com/courses'), null);
    assert.equal(P.courseIdFromUrl('https://ufl.instructure.com/'), null);
    assert.equal(P.courseIdFromUrl(undefined), null);
  });

  test('real courses (a code like COP3530) in this term first, by code; orientation and compliance, and past terms, under Other', function () {
    var g = P.groupCourses(COURSES, { now: NOW });
    assert.deepEqual(plain(g.main.map(function (c) { return c.course_code; })), ['COP3530', 'MAS3114']);
    assert.deepEqual(plain(g.other.map(function (c) { return c.name; })), ['AlcoholEdu for College', 'Calculus 2', 'Career Prep', 'Hazing 101', 'Title IX Training']);
    assert.equal(g.selectedId, '2', 'the first real course, never the first alphabetically');
    assert.equal(g.otherOpen, false);
  });

  test('the current tab\'s course is preselected; if it is an "other" one, that group opens', function () {
    assert.equal(P.groupCourses(COURSES, { now: NOW, currentId: '4' }).selectedId, '4');
    var g = P.groupCourses(COURSES, { now: NOW, currentId: 3 });
    assert.equal(g.selectedId, '3');
    assert.equal(g.otherOpen, true);
    assert.equal(P.groupCourses(COURSES, { now: NOW, currentId: '999' }).selectedId, '2');
  });

  test('a code in the name counts too; with no terms at all, every real course is listed first', function () {
    var g = P.groupCourses([
      { id: 1, name: 'COP 3530 Data Structures', course_code: 'Fa26 Sec 1234' },
      { id: 2, name: 'Library Orientation', course_code: 'LIB' }
    ], { now: NOW });
    assert.deepEqual(plain(g.main.map(function (c) { return c.id; })), [1]);
    assert.equal(P.codeOf({ name: 'COP 3530 Data Structures' }), 'COP3530');
    assert.equal(P.codeOf({ course_code: 'EEL3701C' }), 'EEL3701');
  });

  test('a course\'s tape colour is one of four, the same every time', function () {
    var a = P.tapeIndex('COP3530');
    assert.ok(a >= 0 && a <= 3);
    assert.equal(P.tapeIndex('COP3530'), a);
    var seen = new Set(['COP3530', 'MAS3114', 'MAC2312', 'PHY2049', 'CHM2045', 'STA3032'].map(P.tapeIndex));
    assert.ok(seen.size >= 2, 'not all one colour');
  });

  test('errors in plain words: never "error 404 on /api/v1/...", and harmless ones hidden', function () {
    var errors = [
      { endpoint: '/api/v1/courses/1/pages', status: 404 },
      { endpoint: '/api/v1/courses/1/files', status: 403 },
      { endpoint: '/api/v1/courses/1/discussion_topics', status: 403 },
      { endpoint: '/api/v1/courses/1/files/77', status: 404 },
      { endpoint: '/api/v1/courses/1/pages/week-3', status: 404 }
    ];
    var r = P.plainErrors(errors, { pages: 12, files: 4 });
    assert.deepEqual(plain(r.notes), [
      "Your course doesn't let students list its files; the ones linked in modules came through.",
      "2 items couldn't be opened: removed, or hidden from students."
    ]);
    r.notes.forEach(function (n) { assert.ok(!/\/api\/|error \d|\b40\d\b/.test(n), n); });
    // The technical lines stay, for the Details disclosure.
    assert.ok(r.details.indexOf('404 · /api/v1/courses/1/pages') >= 0);
    assert.equal(r.details.length, 5);
    // No pages at all: then the missing Pages section is worth a word.
    assert.deepEqual(plain(P.plainErrors([{ endpoint: '/api/v1/courses/1/pages', status: 404 }], { pages: 0 }).notes), ["This course doesn't share Canvas pages with students."]);
    assert.deepEqual(plain(P.plainErrors([], {})), { notes: [], details: [] });
  });

  test('signed out, slowed down, a dropped connection, and a failed export, in plain words', function () {
    assert.match(P.plainErrors([{ endpoint: '/api/v1/courses/1', status: 401 }], {}).notes[0], /signed out/);
    assert.match(P.plainErrors([{ endpoint: '/api/v1/courses/1/modules', status: 429 }], {}).notes[0], /slow down/);
    assert.match(P.plainErrors([{ endpoint: '/api/v1/courses/1/modules', status: null }], {}).notes[0], /connection dropped/);
    assert.match(P.plainFailure('Error: Could not establish connection. Receiving end does not exist.'), /Reload the Canvas tab/);
    assert.match(P.plainFailure('HTTP 401'), /signed out/);
    assert.equal(P.plainFailure('TypeError: x is undefined'), 'The export stopped before it finished. Try again.');
  });

  test('progress text: "Module files 12 of 59" fills the bar; text without a count leaves it moving', function () {
    assert.equal(P.progressShare('Module files 12 of 59'), 12 / 59);
    assert.equal(P.progressShare('Files page 2'), null);
    assert.equal(P.progressShare('0 of 0'), null);
  });

  var failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try {
      await tests[i].fn();
      console.log('ok   ' + tests[i].name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + tests[i].name + '\n     ' + (e && e.message));
    }
  }
  console.log((tests.length - failed) + '/' + tests.length + ' passed');
  finished = true;
  if (failed) process.exitCode = 1;
})();
