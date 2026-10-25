// Canvas API helpers. Plain script: loaded as a content script before content.js,
// and loaded into a vm context by test/pagination.test.js. No cookies or tokens are
// read here; requests ride on the browser's own session via credentials: 'include'.

var RewindCanvas = (function () {
  var MAX_PAGES = 500;
  // Item-by-item fetches (module pages and files) run at most this many at a time.
  var MAX_IN_FLIGHT = 4;
  var ANNOUNCEMENTS_FALLBACK_START = '2026-08-01';
  // Announcements are fetched from this many days before the course/term start.
  var ANNOUNCEMENTS_LEAD_DAYS = 30;
  var CAMPUS_TIME_ZONE = 'America/New_York';
  // One-by-one item fetches (module pages/files and linked files) per export, at most.
  var MAX_ITEM_FETCHES = 1000;
  // Stop item fetching once Canvas reports fewer than this many rate-limit units left.
  var RATE_LIMIT_FLOOR = 50;

  // Canvas may prefix JSON with `while(1);` to block JSON hijacking.
  function stripWhilePrefix(text) {
    return text.replace(/^\s*while\s*\(\s*1\s*\)\s*;/, '');
  }

  // Returns the rel="next" URL from a Link header, or null.
  function parseNextLink(header) {
    if (!header) return null;
    var parts = header.split(/,\s*(?=<)/);
    for (var i = 0; i < parts.length; i++) {
      var m = parts[i].match(/^\s*<([^>]+)>\s*;(.*)$/);
      if (m && /\brel\s*=\s*"?next"?/i.test(m[2])) return m[1];
    }
    return null;
  }

  function endpointOf(url) {
    try {
      return new URL(url, 'https://ufl.instructure.com').pathname;
    } catch (e) {
      return String(url);
    }
  }

  function makeClient(opts) {
    var fetchFn = opts.fetch;
    var origin = opts.origin || '';
    var errors = [];

    // Only two shapes are accepted: a path that starts with a single "/" (sent to the course's
    // own origin) or an absolute http(s) URL. Both are resolved with new URL(url, origin) and
    // kept only if the result is on that same origin; anything else returns null and is not
    // fetched. So a rel="next" of ".evil.example/x" or ":8443/x" (which gluing text onto the
    // origin would turn into another host or port) is refused, as is "//evil.example/x".
    // Without an origin only a bare path is allowed (it resolves against the page itself).
    function absolute(url) {
      if (typeof url !== 'string') return null;
      var isPath = url.charAt(0) === '/' && url.charAt(1) !== '/' && url.charAt(1) !== '\\';
      if (!isPath && !/^https?:\/\//i.test(url)) return null;
      if (!origin) return isPath ? url : null;
      try {
        var base = new URL(origin).origin;
        var u = new URL(url, base);
        return u.origin === base ? u.href : null;
      } catch (e) {
        return null;
      }
    }

    function recordError(url, status) {
      errors.push({ endpoint: endpointOf(url), status: status });
    }

    // Canvas throttles per user: X-Rate-Limit-Remaining falls as requests cost quota, and a
    // 403 "Rate Limit Exceeded" means it ran out. Item fetching stops when either is seen.
    var rateLimited = false;
    function noteRateLimit(res) {
      var left = res.headers && res.headers.get ? res.headers.get('X-Rate-Limit-Remaining') : null;
      if (left !== null && left !== undefined && left !== '' && Number(left) < RATE_LIMIT_FLOOR) rateLimited = true;
    }

    // Fetches one URL. Returns { ok, data, next } and records failures in errors.
    async function request(url) {
      var target = absolute(url);
      if (!target) {
        recordError(url, null);
        return { ok: false };
      }
      var res;
      try {
        res = await fetchFn(target, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
      } catch (e) {
        recordError(url, null);
        return { ok: false };
      }
      noteRateLimit(res);
      if (!res.ok) {
        recordError(url, res.status);
        if (res.status === 403) {
          var bodyText = '';
          try { bodyText = await res.text(); } catch (e) { /* no body */ }
          if (/rate limit/i.test(bodyText)) rateLimited = true;
        }
        return { ok: false };
      }
      var data;
      try {
        data = JSON.parse(stripWhilePrefix(await res.text()));
      } catch (e) {
        recordError(url, res.status);
        return { ok: false };
      }
      var link = res.headers && res.headers.get ? res.headers.get('Link') : null;
      return { ok: true, data: data, next: parseNextLink(link) };
    }

    // Follows rel="next" until done. Returns the concatenated array, or [] on failure
    // of the first page (a later page failing keeps what was already collected).
    async function getAll(url, onPage) {
      var items = [];
      var seen = {};
      var page = 0;
      url = absolute(url);
      while (url && !seen[url] && page < MAX_PAGES) {
        seen[url] = true;
        page++;
        var r = await request(url);
        if (!r.ok) break;
        if (Array.isArray(r.data)) items = items.concat(r.data);
        else items.push(r.data);
        if (onPage) onPage(page, items.length);
        if (!r.next) break;
        var next = absolute(r.next);
        if (!next) {
          // Never send the session's requests to another origin; keep what was collected.
          errors.push({ endpoint: endpointOf(url), status: null, reason: 'next link to another origin' });
          break;
        }
        url = next;
      }
      return items;
    }

    async function getOne(url) {
      var r = await request(url);
      return r.ok ? r.data : null;
    }

    return {
      getAll: getAll, getOne: getOne, errors: errors,
      isRateLimited: function () { return rateLimited; }
    };
  }

  async function listCourses(opts) {
    var client = makeClient(opts);
    // With each course's term, so the popup can list this term's real courses first.
    var courses = await client.getAll('/api/v1/courses?enrollment_state=active&include[]=term&per_page=100');
    return {
      courses: courses.filter(function (c) { return c && c.name; }),
      errors: client.errors
    };
  }

  // At most `limit` calls of fn in flight at once; results keep the input order.
  async function mapLimit(items, limit, fn) {
    var out = new Array(items.length);
    var next = 0;
    async function worker() {
      while (next < items.length) {
        var k = next++;
        out[k] = await fn(items[k], k);
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  function localDate(d) {
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // The calendar date of an ISO time in Gainesville (America/New_York), e.g. a course that
  // starts at 2026-08-24T04:00:00Z starts on 2026-08-24 there, not on a UTC date.
  function easternDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d)
      .forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }

  function addDays(ymd, days) {
    var p = ymd.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return d.toISOString().slice(0, 10);
  }

  // /api/v1/announcements returns only the last 14 days unless start_date is given.
  // Base: the course's start_at, else its term's, else the fallback, as an Eastern calendar
  // date. Start: 30 days before the base (posts often go out before the term starts).
  // End: tomorrow (local date).
  function announcementsRange(course, now) {
    var tomorrow = new Date(now.getTime());
    tomorrow.setDate(tomorrow.getDate() + 1);
    var courseStart = course && typeof course.start_at === 'string' ? easternDate(course.start_at) : null;
    var termStart = course && course.term && typeof course.term.start_at === 'string' ? easternDate(course.term.start_at) : null;
    var base = courseStart || termStart || ANNOUNCEMENTS_FALLBACK_START;
    return {
      start: addDays(base, -ANNOUNCEMENTS_LEAD_DAYS),
      end: localDate(tomorrow),
      startFrom: courseStart ? 'course' : termStart ? 'term' : 'fallback',
      baseStart: base
    };
  }

  // /courses/:id/files/:fileId links (href or data-api-endpoint) in a page body, this course only.
  function fileLinkIds(html, courseId) {
    var ids = [];
    var re = /\/courses\/(\d+)\/files\/(\d+)/g;
    var m;
    while ((m = re.exec(String(html || '')))) {
      if (m[1] === String(courseId) && ids.indexOf(Number(m[2])) < 0) ids.push(Number(m[2]));
    }
    return ids;
  }

  // Exports one course into the shared *.course.json shape.
  // opts: { fetch, origin, onProgress, now() } (now is injectable for tests).
  async function exportCourse(courseId, opts) {
    var client = makeClient(opts);
    var say = opts.onProgress || function () {};
    var now = opts.now ? opts.now() : new Date();
    var base = '/api/v1/courses/' + courseId;

    function pager(label) {
      return function (page, count) {
        say(label + ': page ' + page + ' (' + count + ' so far)');
      };
    }

    // Every one-by-one fetch (page bodies from the /pages list, module pages and files, linked
    // files) goes through here: at most MAX_ITEM_FETCHES per export, and none once Canvas
    // signals a rate limit. Skipped items are counted, then reported once each.
    var itemFetches = 0;
    var skippedCap = 0;
    var skippedRate = 0;
    async function fetchItem(url) {
      if (client.isRateLimited()) {
        skippedRate++;
        return null;
      }
      if (itemFetches >= MAX_ITEM_FETCHES) {
        skippedCap++;
        return null;
      }
      itemFetches++;
      return client.getOne(url);
    }

    say('Course details');
    var course = await client.getOne(base + '?include[]=syllabus_body&include[]=term');

    var files = await client.getAll(base + '/files?per_page=100', pager('Files'));
    var modules = await client.getAll(base + '/modules?include[]=items&per_page=100', pager('Modules'));

    var pageList = await client.getAll(base + '/pages?per_page=100', pager('Page list'));
    var pages = [];
    for (var i = 0; i < pageList.length; i++) {
      say('Pages ' + (i + 1) + ' of ' + pageList.length);
      // One by one too, so the same cap and rate-limit stop apply; a skipped or failed body
      // keeps the list entry.
      var full = pageList[i] && pageList[i].url
        ? await fetchItem(base + '/pages/' + encodeURIComponent(pageList[i].url))
        : null;
      pages.push(full || pageList[i]);
    }

    // Module items one by one: the lessons stay reachable item by item even when the list
    // endpoints are blocked (MAS3114: /files 403, /pages 404). Skip what the lists returned.
    var haveFile = {};
    files.forEach(function (f) { if (f && f.id != null) haveFile[f.id] = true; });
    var havePage = {};
    pages.forEach(function (p) { if (p && p.url) havePage[p.url] = true; });
    var pageSlugs = [];
    var fileIds = [];
    function wantFile(id) {
      if (typeof id === 'number' && !haveFile[id] && fileIds.indexOf(id) < 0) fileIds.push(id);
    }
    modules.forEach(function (mod) {
      (mod.items || []).forEach(function (item) {
        if (item.type === 'Page' && item.page_url && !havePage[item.page_url] && pageSlugs.indexOf(item.page_url) < 0) {
          pageSlugs.push(item.page_url);
        } else if (item.type === 'File') {
          wantFile(item.content_id);
        }
      });
    });
    var donePages = 0;
    var fetchedPages = await mapLimit(pageSlugs, MAX_IN_FLIGHT, async function (slug) {
      var page = await fetchItem(base + '/pages/' + encodeURIComponent(slug));
      say('Module pages ' + (++donePages) + ' of ' + pageSlugs.length);
      return page;
    });
    fetchedPages.forEach(function (p) {
      if (p && p.url && !havePage[p.url]) {
        havePage[p.url] = true;
        pages.push(p);
      }
    });
    // Files linked from any page body, whether the page came from the list or a module item.
    pages.forEach(function (p) { fileLinkIds(p && p.body, courseId).forEach(wantFile); });
    var doneFiles = 0;
    var fetchedFiles = await mapLimit(fileIds, MAX_IN_FLIGHT, async function (id) {
      var file = await fetchItem(base + '/files/' + id);
      say('Module files ' + (++doneFiles) + ' of ' + fileIds.length);
      return file;
    });
    fetchedFiles.forEach(function (f) {
      if (f && f.id != null && !haveFile[f.id]) {
        haveFile[f.id] = true;
        files.push(f);
      }
    });
    if (skippedCap) client.errors.push({ endpoint: 'module-items', status: null, skipped: skippedCap });
    if (skippedRate) client.errors.push({ endpoint: 'module-items', status: null, skipped: skippedRate, rateLimited: true });

    var assignments = await client.getAll(base + '/assignments?per_page=100', pager('Assignments'));
    var range = announcementsRange(course, now);
    var announcements = await client.getAll(
      '/api/v1/announcements?context_codes[]=course_' + courseId +
        '&start_date=' + range.start + '&end_date=' + range.end + '&per_page=100',
      pager('Announcements')
    );
    var submissions = await client.getAll(
      base + '/students/submissions?student_ids[]=self&include[]=submission_comments&include[]=rubric_assessment&per_page=100',
      pager('Submissions')
    );

    say('Done');
    return {
      exportedAt: new Date().toISOString(),
      course: course
        ? { id: course.id, name: course.name, course_code: course.course_code }
        : { id: Number(courseId), name: null, course_code: null },
      files: files,
      modules: modules,
      pages: pages,
      assignments: assignments,
      announcements: announcements,
      announcementsRange: range,
      submissions: submissions,
      syllabus_body: course && course.syllabus_body ? course.syllabus_body : null,
      errors: client.errors
    };
  }

  function exportFilename(exp) {
    var code = (exp.course && (exp.course.course_code || exp.course.id)) || 'course';
    return String(code).replace(/[^A-Za-z0-9._-]+/g, '_') + '.course.json';
  }

  return {
    stripWhilePrefix: stripWhilePrefix,
    parseNextLink: parseNextLink,
    makeClient: makeClient,
    listCourses: listCourses,
    exportCourse: exportCourse,
    exportFilename: exportFilename,
    announcementsRange: announcementsRange,
    fileLinkIds: fileLinkIds,
    mapLimit: mapLimit
  };
})();
