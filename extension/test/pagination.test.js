// Run: node extension/test/pagination.test.js
// Loads canvas/canvas-api.js the way Chrome does (as a plain script) into a vm context
// and drives it with a fake fetch. No network. Works whether Node treats .js as CJS or ESM.

// Exits non-zero if a test never settles (the event loop drains with a promise pending).
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

  var src = fs.readFileSync(
    path.join(path.dirname(process.argv[1]), '..', 'canvas', 'canvas-api.js'),
    'utf8'
  );
  var ctx = vm.createContext({ URL: URL, console: console });
  vm.runInContext(src + '\nthis.RewindCanvas = RewindCanvas;', ctx);
  var C = ctx.RewindCanvas;

  var ORIGIN = 'https://ufl.instructure.com';

  // routes: { '/path?query': { status, body, next } }. Records every requested URL.
  // opts.delay: ms before each response, so overlapping requests can be counted (fetch.maxInFlight).
  function fakeFetch(routes, opts) {
    opts = opts || {};
    var calls = [];
    var inFlight = 0;
    function fetch(url, init) {
      calls.push({ url: url, init: init });
      var key = url.replace(ORIGIN, '');
      var r = routes[key];
      if (!r) r = { status: 404, body: { errors: [{ message: 'not found' }] } };
      var headers = {};
      if (r.next) headers.link = '<' + (r.nextAbsolute ? r.next : ORIGIN + r.next) + '>; rel="next", <' + ORIGIN + key + '>; rel="current"';
      Object.keys(r.headers || {}).forEach(function (h) { headers[h.toLowerCase()] = r.headers[h]; });
      var res = {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: function (h) { return headers[h.toLowerCase()] || null; } },
        text: function () {
          if (typeof r.text === 'string') return Promise.resolve(r.text);
          return Promise.resolve((r.prefix ? 'while(1);' : '') + JSON.stringify(r.body));
        }
      };
      inFlight++;
      fetch.maxInFlight = Math.max(fetch.maxInFlight, inFlight);
      return new Promise(function (resolve) {
        setTimeout(function () { inFlight--; resolve(res); }, opts.delay || 0);
      });
    }
    fetch.calls = calls;
    fetch.maxInFlight = 0;
    return fetch;
  }

  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  // Oct 23, 2026, local time: tomorrow is 2026-10-24.
  var NOW = function () { return new Date(2026, 9, 23, 22, 30); };
  var plain = function (x) { return JSON.parse(JSON.stringify(x)); };

  test('parseNextLink finds rel="next" among several links', function () {
    var h = '<https://x/a?page=1>; rel="current",<https://x/a?page=2&per_page=100>; rel="next", <https://x/a?page=9>; rel="last"';
    assert.equal(C.parseNextLink(h), 'https://x/a?page=2&per_page=100');
    assert.equal(C.parseNextLink('<https://x/a?page=1>; rel="first"'), null);
    assert.equal(C.parseNextLink(null), null);
  });

  test('a rel=next link to another origin is not followed; paging stops and is recorded', async function () {
    var lookalikes = [
      'https://evil.example/api/v1/courses/1/files?page=2',
      'https://ufl.instructure.com.evil.example/api/v1/courses/1/files?page=2',
      'http://ufl.instructure.com/api/v1/courses/1/files?page=2', // http, not https
      'https://ufl.instructure.com:8443/api/v1/courses/1/files?page=2'
    ];
    for (var i = 0; i < lookalikes.length; i++) {
      var fetch = fakeFetch({
        '/api/v1/courses/1/files?per_page=100': { status: 200, body: [{ id: 1 }], next: lookalikes[i], nextAbsolute: true }
      });
      var client = C.makeClient({ fetch: fetch, origin: ORIGIN });
      var got = plain(await client.getAll('/api/v1/courses/1/files?per_page=100'));
      assert.deepEqual(got, [{ id: 1 }], lookalikes[i]);
      assert.equal(fetch.calls.length, 1, 'never requested ' + lookalikes[i]);
      assert.deepEqual(plain(client.errors), [
        { endpoint: '/api/v1/courses/1/files', status: null, reason: 'next link to another origin' }
      ]);
    }
    // Same origin, absolute: followed as before.
    var same = fakeFetch({
      '/api/v1/courses/1/files?per_page=100': { status: 200, body: [{ id: 1 }], next: ORIGIN + '/api/v1/courses/1/files?page=2', nextAbsolute: true },
      '/api/v1/courses/1/files?page=2': { status: 200, body: [{ id: 2 }] }
    });
    var c2 = C.makeClient({ fetch: same, origin: ORIGIN });
    assert.deepEqual(plain(await c2.getAll('/api/v1/courses/1/files?per_page=100')), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(plain(c2.errors), []);
    // A direct request to another origin is refused too.
    var c3 = C.makeClient({ fetch: same, origin: ORIGIN });
    assert.equal(await c3.getOne('https://evil.example/api/v1/users/self'), null);
    assert.equal(same.calls.length, 2);
  });

  test('relative next links that would change host or port are refused, not glued onto the origin', async function () {
    // Gluing text would give ufl.instructure.com.evil.example, ufl.instructure.com:8443, or a
    // protocol-relative host. Each must stop paging with an errors row and never be fetched.
    var crafted = ['.evil.example/x', ':8443/x', '//evil.example/x', '@evil.example/x', 'javascript:alert(1)'];
    for (var i = 0; i < crafted.length; i++) {
      var routes = {
        '/api/v1/courses/1/files?per_page=100': { status: 200, body: [{ id: 1 }] }
      };
      var fetch = fakeFetch(routes);
      // Hand-built Link header with the raw crafted value.
      var inner = fetch;
      fetch = function (url, init) {
        return inner(url, init).then(function (res) {
          var get = res.headers.get;
          res.headers = { get: function (h) { return /^link$/i.test(h) ? '<' + crafted[i] + '>; rel="next"' : get(h); } };
          return res;
        });
      };
      fetch.calls = inner.calls;
      var client = C.makeClient({ fetch: fetch, origin: ORIGIN });
      var got = plain(await client.getAll('/api/v1/courses/1/files?per_page=100'));
      assert.deepEqual(got, [{ id: 1 }], crafted[i]);
      assert.deepEqual(inner.calls.map(function (c) { return c.url; }),
        [ORIGIN + '/api/v1/courses/1/files?per_page=100'], 'only the first page was requested for ' + crafted[i]);
      assert.deepEqual(plain(client.errors), [
        { endpoint: '/api/v1/courses/1/files', status: null, reason: 'next link to another origin' }
      ], crafted[i]);
    }
    // A plain path on the same origin is still followed.
    var ok = fakeFetch({
      '/api/v1/courses/1/files?per_page=100': { status: 200, body: [{ id: 1 }], next: '/api/v1/courses/1/files?page=2' },
      '/api/v1/courses/1/files?page=2': { status: 200, body: [{ id: 2 }] }
    });
    var c2 = C.makeClient({ fetch: ok, origin: ORIGIN });
    assert.deepEqual(plain(await c2.getAll('/api/v1/courses/1/files?per_page=100')), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(plain(c2.errors), []);
  });

  test('stripWhilePrefix removes the Canvas prefix only', function () {
    assert.equal(C.stripWhilePrefix('while(1);[1,2]'), '[1,2]');
    assert.equal(C.stripWhilePrefix('[1,2]'), '[1,2]');
  });

  test('getAll follows next links across pages and concatenates', async function () {
    var files = [];
    for (var i = 0; i < 230; i++) files.push({ id: i, display_name: 'f' + i + '.pdf' });
    var fetch = fakeFetch({
      '/api/v1/courses/1/files?per_page=100': { status: 200, body: files.slice(0, 100), next: '/api/v1/courses/1/files?page=2&per_page=100' },
      '/api/v1/courses/1/files?page=2&per_page=100': { status: 200, body: files.slice(100, 200), next: '/api/v1/courses/1/files?page=3&per_page=100', prefix: true },
      '/api/v1/courses/1/files?page=3&per_page=100': { status: 200, body: files.slice(200) }
    });
    var pages = [];
    var client = C.makeClient({ fetch: fetch, origin: ORIGIN });
    var got = await client.getAll('/api/v1/courses/1/files?per_page=100', function (p) { pages.push(p); });
    assert.equal(got.length, 230);
    assert.equal(got[229].id, 229);
    assert.deepEqual(pages, [1, 2, 3]);
    assert.equal(fetch.calls.length, 3);
    assert.equal(fetch.calls[0].init.credentials, 'include');
    assert.equal(client.errors.length, 0);
  });

  test('getAll stops on a next link that loops back', async function () {
    var fetch = fakeFetch({
      '/a?page=1': { status: 200, body: [1], next: '/a?page=2' },
      '/a?page=2': { status: 200, body: [2], next: '/a?page=1' }
    });
    var got = await C.makeClient({ fetch: fetch, origin: ORIGIN }).getAll('/a?page=1');
    assert.deepEqual(Array.from(got), [1, 2]);
    assert.equal(fetch.calls.length, 2);
  });

  test('exportCourse records 401 on /files and keeps going (MAS3114 case)', async function () {
    var base = '/api/v1/courses/7';
    var fetch = fakeFetch({
      [base + '?include[]=syllabus_body&include[]=term']: { status: 200, body: { id: 7, name: 'Linear Algebra', course_code: 'MAS 3114', syllabus_body: '<p>s</p>', extra: 1 } },
      [base + '/files?per_page=100']: { status: 401, body: { status: 'unauthorized' } },
      [base + '/modules?include[]=items&per_page=100']: { status: 200, body: [{ id: 1, items: [] }], next: base + '/modules?include[]=items&page=2&per_page=100' },
      [base + '/modules?include[]=items&page=2&per_page=100']: { status: 200, body: [{ id: 2, items: [] }] },
      [base + '/pages?per_page=100']: { status: 200, body: [{ url: 'week-1' }, { url: 'week-2' }] },
      [base + '/pages/week-1']: { status: 200, body: { url: 'week-1', body: '<p>one</p>' } },
      [base + '/pages/week-2']: { status: 403, body: {} },
      [base + '/assignments?per_page=100']: { status: 200, body: [{ id: 3 }] },
      ['/api/v1/announcements?context_codes[]=course_7&start_date=2026-07-02&end_date=2026-10-24&per_page=100']: { status: 200, body: [{ id: 4 }] },
      [base + '/students/submissions?student_ids[]=self&include[]=submission_comments&include[]=rubric_assessment&per_page=100']: { status: 200, body: [{ id: 5 }] }
    });
    var progress = [];
    var exp = await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW, onProgress: function (t) { progress.push(t); } });

    assert.deepEqual(JSON.parse(JSON.stringify(exp.course)), { id: 7, name: 'Linear Algebra', course_code: 'MAS 3114' });
    assert.equal(exp.syllabus_body, '<p>s</p>');
    assert.equal(exp.files.length, 0);
    assert.equal(exp.modules.length, 2);
    assert.equal(exp.pages.length, 2);
    assert.equal(exp.pages[0].body, '<p>one</p>');
    assert.equal(exp.pages[1].url, 'week-2'); // falls back to the list entry
    assert.equal(exp.assignments.length, 1);
    assert.equal(exp.announcements.length, 1);
    assert.equal(exp.submissions.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(exp.errors)), [
      { endpoint: '/api/v1/courses/7/files', status: 401 },
      { endpoint: '/api/v1/courses/7/pages/week-2', status: 403 }
    ]);
    assert.ok(progress.indexOf('Pages 2 of 2') !== -1);
    assert.ok(!isNaN(Date.parse(exp.exportedAt)));
    assert.equal(C.exportFilename(exp), 'MAS_3114.course.json');
  });

  // ---------- T12: announcements since course start; module items one by one ----------

  var B7 = '/api/v1/courses/7';
  var SUBS = B7 + '/students/submissions?student_ids[]=self&include[]=submission_comments&include[]=rubric_assessment&per_page=100';
  function ann(start) {
    return '/api/v1/announcements?context_codes[]=course_7&start_date=' + start + '&end_date=2026-10-24&per_page=100';
  }
  function annUrls(fetch) {
    return fetch.calls.map(function (c) { return c.url.replace(ORIGIN, ''); }).filter(function (u) { return u.indexOf('/api/v1/announcements') === 0; });
  }

  test('announcements: 30 days before the course, term or fallback start (Eastern date); end tomorrow', async function () {
    // [course, base start (Eastern calendar date), shifted start, startFrom]
    var cases = [
      [{ id: 7, start_at: '2026-08-24T04:00:00Z', term: { start_at: '2026-08-20T04:00:00Z' } }, '2026-08-24', '2026-07-25', 'course'],
      // 02:00 UTC on Aug 24 is still Aug 23 in Gainesville; slice(0, 10) would say Aug 24.
      [{ id: 7, start_at: '2026-08-24T02:00:00Z' }, '2026-08-23', '2026-07-24', 'course'],
      [{ id: 7, start_at: null, term: { start_at: '2026-08-20T04:00:00Z' } }, '2026-08-20', '2026-07-21', 'term'],
      [{ id: 7, start_at: null, term: { start_at: null } }, '2026-08-01', '2026-07-02', 'fallback'],
      [{ id: 7, start_at: 'not a date', term: null }, '2026-08-01', '2026-07-02', 'fallback'],
      [null, '2026-08-01', '2026-07-02', 'fallback']
    ];
    for (var i = 0; i < cases.length; i++) {
      var routes = {};
      routes[B7 + '?include[]=syllabus_body&include[]=term'] = cases[i][0] ? { status: 200, body: cases[i][0] } : { status: 500, body: {} };
      routes[ann(cases[i][2])] = { status: 200, body: [{ id: 1 }] };
      var fetch = fakeFetch(routes);
      var exp = plain(await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW }));
      assert.deepEqual(annUrls(fetch), [ann(cases[i][2])], 'case ' + i);
      assert.deepEqual(plain(exp.announcementsRange),
        { start: cases[i][2], end: '2026-10-24', startFrom: cases[i][3], baseStart: cases[i][1] }, 'case ' + i);
      assert.equal(exp.announcements.length, 1);
    }
  });

  test('announcements: pagination is followed across the whole range', async function () {
    var routes = {};
    routes[B7 + '?include[]=syllabus_body&include[]=term'] = { status: 200, body: { id: 7, start_at: '2026-08-24T04:00:00Z' } };
    routes[ann('2026-07-25')] = { status: 200, body: [{ id: 1 }, { id: 2 }], next: '/api/v1/announcements?context_codes[]=course_7&page=2' };
    routes['/api/v1/announcements?context_codes[]=course_7&page=2'] = { status: 200, body: [{ id: 3 }] };
    var exp = plain(await C.exportCourse(7, { fetch: fakeFetch(routes), origin: ORIGIN, now: NOW }));
    assert.deepEqual(exp.announcements.map(function (a) { return a.id; }), [1, 2, 3]);
  });

  // MAS3114-style course: /files 403 and /pages 404, lessons only through modules.
  function blockedCourse() {
    var routes = {};
    routes[B7 + '?include[]=syllabus_body&include[]=term'] = { status: 200, body: { id: 7, name: 'Fake Algebra', course_code: 'FAKE7' } };
    routes[B7 + '/files?per_page=100'] = { status: 403, body: {} };
    routes[B7 + '/pages?per_page=100'] = { status: 404, body: {} };
    routes[B7 + '/modules?include[]=items&per_page=100'] = { status: 200, body: [
      { id: 1, name: 'Week 1', items: [
        { id: 11, type: 'Page', page_url: 'week-1-notes' },
        { id: 12, type: 'File', content_id: 31 },
        { id: 13, type: 'SubHeader' }
      ] },
      { id: 2, name: 'Week 2', items: [
        { id: 21, type: 'Page', page_url: 'week-2-notes' },
        { id: 22, type: 'Page', page_url: 'week-1-notes' } // same page linked twice
      ] }
    ] };
    routes[B7 + '/pages/week-1-notes'] = { status: 200, body: { url: 'week-1-notes', title: 'Week 1 notes',
      body: '<a href="/courses/7/files/32?wrap=1">Slides</a> <a href="/courses/7/files/31">again</a> <a href="/courses/8/files/99">other course</a>' } };
    routes[B7 + '/pages/week-2-notes'] = { status: 200, body: { url: 'week-2-notes', title: 'Week 2 notes',
      body: '<a data-api-endpoint="https://ufl.instructure.com/api/v1/courses/7/files/33" href="#">Handout</a>' } };
    routes[B7 + '/assignments?per_page=100'] = { status: 200, body: [] };
    routes[ann('2026-07-02')] = { status: 200, body: [] };
    routes[SUBS] = { status: 200, body: [] };
    [31, 32, 33].forEach(function (id) {
      routes[B7 + '/files/' + id] = { status: 200, body: { id: id, display_name: 'file-' + id + '.pdf', url: 'https://x/files/' + id + '/download' } };
    });
    return routes;
  }

  test('blocked lists: pages and files still come from module items and links in page bodies', async function () {
    var fetch = fakeFetch(blockedCourse());
    var exp = plain(await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW }));
    assert.deepEqual(exp.pages.map(function (p) { return p.url; }), ['week-1-notes', 'week-2-notes']);
    assert.equal(exp.pages[0].body.indexOf('/courses/7/files/32') >= 0, true);
    assert.deepEqual(exp.files.map(function (f) { return f.id; }).sort(), [31, 32, 33]);
    assert.equal(exp.files[0].display_name, 'file-31.pdf');
    var urls = fetch.calls.map(function (c) { return c.url.replace(ORIGIN, ''); });
    assert.equal(urls.filter(function (u) { return u === B7 + '/pages/week-1-notes'; }).length, 1, 'page linked twice is fetched once');
    assert.equal(urls.filter(function (u) { return u === B7 + '/files/31'; }).length, 1, 'file in a module and a link is fetched once');
    assert.equal(urls.some(function (u) { return u.indexOf('/files/99') >= 0; }), false, 'another course is not fetched');
    assert.deepEqual(plain(exp.errors.slice(0, 2)), [
      { endpoint: '/api/v1/courses/7/files', status: 403 },
      { endpoint: '/api/v1/courses/7/pages', status: 404 }
    ]);
  });

  test('lists that work: items they already returned are not fetched again', async function () {
    var routes = blockedCourse();
    routes[B7 + '/files?per_page=100'] = { status: 200, body: [{ id: 31, display_name: 'from-list.pdf' }] };
    routes[B7 + '/pages?per_page=100'] = { status: 200, body: [{ url: 'week-1-notes' }] };
    var fetch = fakeFetch(routes);
    var exp = plain(await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW }));
    var urls = fetch.calls.map(function (c) { return c.url.replace(ORIGIN, ''); });
    var count = function (u) { return urls.filter(function (x) { return x === u; }).length; };
    assert.equal(count(B7 + '/files/31'), 0, 'file 31 came from the list');
    assert.equal(count(B7 + '/pages/week-1-notes'), 1, 'fetched once by the page list, not again for the module');
    assert.equal(count(B7 + '/pages/week-2-notes'), 1);
    assert.equal(count(B7 + '/files/32'), 1);
    assert.equal(count(B7 + '/files/33'), 1);
    assert.deepEqual(exp.files.map(function (f) { return f.id; }), [31, 32, 33]);
    assert.equal(exp.files[0].display_name, 'from-list.pdf', 'list object kept unchanged');
    assert.deepEqual(exp.pages.map(function (p) { return p.url; }), ['week-1-notes', 'week-2-notes']);
    assert.deepEqual(plain(exp.errors), []);
  });

  test('a failing item lands in errors and the rest still export', async function () {
    var routes = blockedCourse();
    routes[B7 + '/files/32'] = { status: 500, body: {} };
    routes[B7 + '/pages/week-2-notes'] = { status: 401, body: {} };
    var exp = plain(await C.exportCourse(7, { fetch: fakeFetch(routes), origin: ORIGIN, now: NOW }));
    assert.deepEqual(exp.files.map(function (f) { return f.id; }), [31]);
    assert.deepEqual(exp.pages.map(function (p) { return p.url; }), ['week-1-notes']);
    var errs = plain(exp.errors);
    assert.ok(errs.some(function (e) { return e.endpoint === '/api/v1/courses/7/files/32' && e.status === 500; }));
    assert.ok(errs.some(function (e) { return e.endpoint === '/api/v1/courses/7/pages/week-2-notes' && e.status === 401; }));
    assert.equal(errs.length, 4, '403 files list, 404 pages list, and the two failed items');
  });

  function itemUrls(fetch) {
    return fetch.calls.map(function (c) { return c.url.replace(ORIGIN, ''); })
      .filter(function (u) { return /\/courses\/7\/(pages|files)\/[^?]+$/.test(u); });
  }

  test('at most 1000 item fetches per export; the rest is one module-items row in errors', async function () {
    var routes = blockedCourse();
    var items = [];
    for (var id = 100; id < 1103; id++) {
      items.push({ id: id, type: 'File', content_id: id });
      routes[B7 + '/files/' + id] = { status: 200, body: { id: id } };
    }
    routes[B7 + '/modules?include[]=items&per_page=100'].body.push({ id: 3, name: 'Huge', items: items });
    var fetch = fakeFetch(routes);
    var exp = plain(await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW }));
    // 2 module pages + 1006 files (31, 100..1102, then the linked 32 and 33) = 1008 wanted.
    assert.equal(itemUrls(fetch).length, 1000);
    assert.equal(exp.files.length, 998);
    assert.deepEqual(exp.errors.filter(function (e) { return e.endpoint === 'module-items'; }),
      [{ endpoint: 'module-items', status: null, skipped: 8 }]);
  });

  // T12c: the /pages list's one-by-one body fetches go through the same cap and rate-limit stop.
  function pageListCourse(n) {
    var routes = {};
    routes[B7 + '?include[]=syllabus_body&include[]=term'] = { status: 200, body: { id: 7, name: 'Fake', course_code: 'FAKE7' } };
    routes[B7 + '/files?per_page=100'] = { status: 200, body: [] };
    routes[B7 + '/modules?include[]=items&per_page=100'] = { status: 200, body: [] };
    var list = [];
    for (var k = 0; k < n; k++) {
      list.push({ url: 'p-' + k, title: 'P ' + k });
      routes[B7 + '/pages/p-' + k] = { status: 200, body: { url: 'p-' + k, title: 'P ' + k, body: '<p>' + k + '</p>' } };
    }
    routes[B7 + '/pages?per_page=100'] = { status: 200, body: list };
    routes[B7 + '/assignments?per_page=100'] = { status: 200, body: [] };
    routes[ann('2026-07-02')] = { status: 200, body: [] };
    routes[SUBS] = { status: 200, body: [] };
    return routes;
  }

  test('a /pages list of 1200 pages: 1000 bodies fetched, the rest keep their list entry and are counted', async function () {
    var fetch = fakeFetch(pageListCourse(1200));
    var exp = plain(await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW }));
    assert.equal(itemUrls(fetch).length, 1000);
    assert.equal(exp.pages.length, 1200);
    assert.equal(exp.pages[999].body, '<p>999</p>');
    assert.equal(exp.pages[1000].body, undefined, 'list entry kept for a skipped body');
    assert.deepEqual(exp.errors, [{ endpoint: 'module-items', status: null, skipped: 200 }]);
    // Later lists still run.
    assert.equal(fetch.calls.some(function (c) { return c.url.indexOf('/students/submissions') >= 0; }), true);
  });

  test('a rate-limit signal while fetching /pages list bodies stops the rest', async function () {
    var routes = pageListCourse(10);
    routes[B7 + '/pages/p-2'].headers = { 'X-Rate-Limit-Remaining': '10' };
    var fetch = fakeFetch(routes);
    var exp = plain(await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW }));
    assert.deepEqual(itemUrls(fetch), [B7 + '/pages/p-0', B7 + '/pages/p-1', B7 + '/pages/p-2']);
    assert.equal(exp.pages.length, 10);
    assert.deepEqual(exp.errors, [{ endpoint: 'module-items', status: null, skipped: 7, rateLimited: true }]);
  });

  test('X-Rate-Limit-Remaining below 50 stops item fetching; 50 or more does not', async function () {
    var routes = blockedCourse();
    routes[B7 + '/pages/week-1-notes'].headers = { 'X-Rate-Limit-Remaining': '49.5' };
    var fetch = fakeFetch(routes);
    var exp = plain(await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW }));
    // Both pages were already in flight together; every file after that is skipped.
    assert.deepEqual(itemUrls(fetch), [B7 + '/pages/week-1-notes', B7 + '/pages/week-2-notes']);
    assert.deepEqual(exp.files, []);
    assert.deepEqual(exp.errors.filter(function (e) { return e.endpoint === 'module-items'; }),
      [{ endpoint: 'module-items', status: null, skipped: 3, rateLimited: true }]);
    // The lists after the item phase (assignments, announcements, submissions) still run.
    assert.equal(fetch.calls.some(function (c) { return c.url.indexOf('/students/submissions') >= 0; }), true);

    var ok = blockedCourse();
    ok[B7 + '/pages/week-1-notes'].headers = { 'X-Rate-Limit-Remaining': '50' };
    var exp2 = plain(await C.exportCourse(7, { fetch: fakeFetch(ok), origin: ORIGIN, now: NOW }));
    assert.equal(exp2.files.length, 3);
    assert.equal(exp2.errors.some(function (e) { return e.endpoint === 'module-items'; }), false);
  });

  test('a 403 rate-limit answer stops item fetching; a plain 403 does not', async function () {
    var routes = blockedCourse();
    var items = [];
    for (var id = 100; id < 110; id++) {
      items.push({ id: id, type: 'File', content_id: id });
      routes[B7 + '/files/' + id] = { status: 200, body: { id: id } };
    }
    routes[B7 + '/modules?include[]=items&per_page=100'].body.push({ id: 3, name: 'More', items: items });
    routes[B7 + '/files/31'] = { status: 403, text: '403 Forbidden (Rate Limit Exceeded)' };
    var fetch = fakeFetch(routes, { delay: 2 });
    var exp = plain(await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW }));
    // Files queue: 31, 100..109, then linked 32, 33. The first 4 were in flight together.
    var fileCalls = itemUrls(fetch).filter(function (u) { return u.indexOf('/files/') >= 0; });
    assert.deepEqual(fileCalls, [B7 + '/files/31', B7 + '/files/100', B7 + '/files/101', B7 + '/files/102']);
    assert.ok(exp.errors.some(function (e) { return e.endpoint === '/api/v1/courses/7/files/31' && e.status === 403; }));
    assert.deepEqual(exp.errors.filter(function (e) { return e.endpoint === 'module-items'; }),
      [{ endpoint: 'module-items', status: null, skipped: 9, rateLimited: true }]);

    var plain403 = blockedCourse();
    plain403[B7 + '/files/31'] = { status: 403, text: '{"status":"unauthorized"}' };
    var exp2 = plain(await C.exportCourse(7, { fetch: fakeFetch(plain403), origin: ORIGIN, now: NOW }));
    assert.deepEqual(exp2.files.map(function (f) { return f.id; }).sort(), [32, 33]);
    assert.equal(exp2.errors.some(function (e) { return e.endpoint === 'module-items'; }), false);
  });

  test('never more than 4 item requests in flight', async function () {
    var routes = blockedCourse();
    var items = [];
    for (var id = 100; id < 112; id++) {
      items.push({ id: id, type: 'File', content_id: id });
      routes[B7 + '/files/' + id] = { status: 200, body: { id: id } };
    }
    for (var p = 0; p < 6; p++) {
      items.push({ id: 200 + p, type: 'Page', page_url: 'extra-' + p });
      routes[B7 + '/pages/extra-' + p] = { status: 200, body: { url: 'extra-' + p, body: '' } };
    }
    routes[B7 + '/modules?include[]=items&per_page=100'].body.push({ id: 3, name: 'Many', items: items });
    var fetch = fakeFetch(routes, { delay: 3 });
    var exp = plain(await C.exportCourse(7, { fetch: fetch, origin: ORIGIN, now: NOW }));
    assert.equal(fetch.maxInFlight, 4, 'reached 4 and never more');
    assert.equal(exp.files.length, 15);
    assert.equal(exp.pages.length, 8);
  });

  var failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try {
      await tests[i].fn();
      console.log('ok   ' + tests[i].name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + tests[i].name + '\n     ' + e.message);
    }
  }
  console.log((tests.length - failed) + '/' + tests.length + ' passed');
  finished = true;
  if (failed) process.exitCode = 1;
})();
