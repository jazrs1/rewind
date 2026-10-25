// T14 probe: can the embedded (cross-site) frame get its cookies through the Storage Access
// API, from a click on our own "Play here" button inside the frame, and keep them after the
// frame reloads? Third-party cookies blocked, as on John's Chrome.
//
// Run: node experiments/storage-access/probe.mjs
// Local stand-in (no real Zoom):
//   top page   http://localhost:4300/top.html            (the Rewind app)
//   frame site http://127.0.0.1:4400                      (ufl.zoom.us)
//     /login       first-party visit that sets a session cookie (like logging in to Zoom)
//     /frame.html  the embedded player page; the server records whether the cookie came along
// Writes experiments/storage-access/evidence/results.json.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, 'extension');
const EVIDENCE = join(HERE, 'evidence');

// Two stand-ins. "ip-http" is the T10 setup; "https-hosts" uses real-looking hostnames over
// HTTPS (self-signed, mapped to 127.0.0.1), closer to ufl.zoom.us inside a deployed app.
const STANDINS = [
  { name: 'ip-http', top: 'http://localhost:4300', frame: 'http://127.0.0.1:4400', https: false, args: [] },
  {
    name: 'https-hosts', top: 'https://app.test:4301', frame: 'https://zoom.test:4401', https: true,
    args: ['--host-resolver-rules=MAP app.test 127.0.0.1, MAP zoom.test 127.0.0.1', '--ignore-certificate-errors'],
  },
];
let TOP = '';
let TOP_ORIGIN = '';
let FRAME_ORIGIN = '';

// Throwaway self-signed certificate for app.test and zoom.test (never committed).
function makeCert(dir) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=app.test', '-addext', 'subjectAltName=DNS:app.test,DNS:zoom.test'], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function findChrome() {
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const exe = join(base, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(exe)) return exe;
  }
  throw new Error('Chrome for Testing not found under ' + base);
}

const topHtml = (query) => `<!doctype html><title>top</title>
<iframe src="${FRAME_ORIGIN}/frame.html${query}" width="480" height="270" allow="storage-access"></iframe>
<pre id="log"></pre>
<script>
window.__log = [];
addEventListener('message', (e) => {
  window.__log.push(e.data);
  document.getElementById('log').textContent = JSON.stringify(window.__log, null, 1);
});
</script>`;

// The frame page reports what it can see on every load. After a reload without access it also
// tries requestStorageAccess() with no gesture (allowed once the permission is granted).
function frameHtml(serverSawCookie) {
  return `<!doctype html><title>frame</title><body><p>player</p><script>
const sawCookie = ${serverSawCookie};
function snapshot(phase, extra) {
  const r = { phase, serverSawCookie: sawCookie, documentCookie: /rw_session=/.test(document.cookie) };
  try { localStorage.setItem('p', '1'); r.localStorage = 'ok'; } catch (e) { r.localStorage = 'error: ' + e.name; }
  return (document.hasStorageAccess ? document.hasStorageAccess() : Promise.resolve(null))
    .then((v) => parent.postMessage(Object.assign(r, { hasStorageAccess: v }, extra || {}), '*'));
}
// mode=page: the page's own button asks (main world), instead of the extension's button.
if (location.search.includes('mode=page')) {
  const b = document.createElement('button');
  b.id = 'page-play-here';
  b.textContent = 'Play here (page)';
  b.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
  b.onclick = () => document.requestStorageAccess().then(
    () => { parent.postMessage({ phase: 'request', requestStorageAccess: 'granted', by: 'page' }, '*'); setTimeout(() => location.reload(), 200); },
    (e) => parent.postMessage({ phase: 'request', requestStorageAccess: 'rejected: ' + e.name, by: 'page' }, '*'));
  document.body.appendChild(b);
}
snapshot('load').then(() => {
  if (!document.requestStorageAccess) return;
  // Without a gesture: succeeds only if access was already granted for this pair of sites.
  return document.requestStorageAccess().then(
    () => snapshot('load+noGestureRequest', { noGestureRequest: 'granted' }),
    (e) => parent.postMessage({ phase: 'load+noGestureRequest', noGestureRequest: 'rejected: ' + e.name }, '*'));
});
</script></body>`;
}

const LOGIN_HTML = `<!doctype html><title>login</title><button id="b">I'm logged in</button>`;

function startServers(requestLog, standin, tls) {
  const make = (handler) => (standin.https ? createHttpsServer(tls, handler) : createServer(handler));
  const port = (url) => Number(new URL(url).port);
  const top = make((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(topHtml(req.url.includes('mode=page') ? '?mode=page' : ''));
  });
  const frame = make((req, res) => {
    const hasCookie = /(^|;\s*)rw_session=/.test(req.headers.cookie || '');
    requestLog.push({ path: req.url, cookie: hasCookie, secFetchStorageAccess: req.headers['sec-fetch-storage-access'] || null });
    if (req.url.startsWith('/login')) {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'rw_session=abc; SameSite=None; Secure; Path=/' });
      res.end(LOGIN_HTML);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url.startsWith('/frame.html') ? frameHtml(hasCookie) : 'ok');
  });
  return Promise.all([
    new Promise((r) => top.listen(port(standin.top), standin.https ? '127.0.0.1' : 'localhost', () => r(top))),
    new Promise((r) => frame.listen(port(standin.frame), '127.0.0.1', () => r(frame))),
  ]);
}

async function waitForPhase(page, phase, count, timeout = 8000) {
  try {
    await page.waitForFunction(
      ([p, c]) => (window.__log || []).filter((m) => m.phase === p).length >= c,
      [phase, count],
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

async function runVariant(exe, variant, requestLog, standin) {
  const profile = mkdtempSync(join(tmpdir(), 'rewind-t14-'));
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
    profile: { cookie_controls_mode: 1, block_third_party_cookies: true },
  }));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: exe,
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...standin.args],
  });
  const out = { standin: standin.name, variant: variant.name, steps: [] };
  try {
    if (variant.grant) {
      try {
        await context.grantPermissions(['storage-access'], variant.grant);
        out.grant = 'ok ' + JSON.stringify(variant.grant);
      } catch (e) {
        out.grant = 'failed: ' + e.message.split('\n')[0];
      }
    }
    const page = await context.newPage();
    // 1. First-party visit with a click, like logging in to Zoom in its own tab.
    requestLog.length = 0;
    await page.goto(FRAME_ORIGIN + '/login');
    await page.click('#b');
    out.steps.push({ step: 'first-party login', requests: requestLog.splice(0) });
    // 2. The app page with the frame.
    const topUrl = TOP + (variant.mode === 'page' ? '?mode=page' : '');
    await page.goto(topUrl);
    await waitForPhase(page, 'load', 1);
    await waitForPhase(page, 'load+noGestureRequest', 1, 3000);
    out.steps.push({ step: 'frame load (before click)', messages: await page.evaluate(() => window.__log.splice(0)), requests: requestLog.splice(0) });
    // 3. A real click on our "Play here" button inside the frame.
    const button = page.frameLocator('iframe').locator(variant.mode === 'page' ? '#page-play-here' : '#rewind-play-here');
    out.buttonInjected = (await button.count()) === 1;
    if (out.buttonInjected) {
      await button.click();
      await waitForPhase(page, 'request', 1, 5000);
      await waitForPhase(page, 'load', 1, 5000); // the reload
      await waitForPhase(page, 'load+noGestureRequest', 1, 3000);
      out.steps.push({ step: 'click Play here (+ reload)', messages: await page.evaluate(() => window.__log.splice(0)), requests: requestLog.splice(0) });
      // 4. Load the app page again from scratch: does access persist across page loads?
      await page.goto(topUrl);
      await waitForPhase(page, 'load', 1);
      await waitForPhase(page, 'load+noGestureRequest', 1, 3000);
      out.steps.push({ step: 'app page loaded again', messages: await page.evaluate(() => window.__log.splice(0)), requests: requestLog.splice(0) });
    }
  } catch (e) {
    out.error = String(e && e.message || e).split('\n')[0];
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
  return out;
}

async function main() {
  mkdirSync(EVIDENCE, { recursive: true });
  const exe = findChrome();
  const certDir = mkdtempSync(join(tmpdir(), 'rewind-t14-cert-'));
  const tls = makeCert(certDir);
  const log = { chrome: exe.replace(homedir(), '~'), startedAt: new Date().toISOString(), results: [] };
  for (const standin of STANDINS) {
    TOP_ORIGIN = standin.top;
    TOP = standin.top + '/top.html';
    FRAME_ORIGIN = standin.frame;
    const requestLog = [];
    const servers = await startServers(requestLog, standin, tls);
    const variants = [
      { name: 'A: extension button, no permission pre-granted (a real user would see Chrome\'s prompt)' },
      { name: 'B: extension button, storage-access granted for the top origin', grant: { origin: TOP_ORIGIN } },
      { name: 'C: extension button, storage-access granted for the frame origin', grant: { origin: FRAME_ORIGIN } },
      { name: 'D: page button (main world), no permission pre-granted', mode: 'page' },
      { name: 'E: page button (main world), granted for the top origin', mode: 'page', grant: { origin: TOP_ORIGIN } },
      { name: 'F: page button (main world), granted for the frame origin', mode: 'page', grant: { origin: FRAME_ORIGIN } },
    ];
    for (const v of variants) {
      const r = await runVariant(exe, v, requestLog, standin);
      log.results.push(r);
      console.log('\n== [' + standin.name + '] ' + r.variant + (r.grant ? ' | grant: ' + r.grant : '') + (r.error ? ' | ERROR ' + r.error : ''));
      for (const s of r.steps) {
        console.log('  ' + s.step + ':');
        for (const q of s.requests || []) console.log('    request ' + q.path + ' cookie=' + q.cookie + (q.secFetchStorageAccess ? ' sec-fetch-storage-access=' + q.secFetchStorageAccess : ''));
        for (const m of s.messages || []) console.log('    frame ' + JSON.stringify(m));
      }
    }
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  }
  rmSync(certDir, { recursive: true, force: true });
  log.finishedAt = new Date().toISOString();
  writeFileSync(join(EVIDENCE, 'results.json'), JSON.stringify(log, null, 2) + '\n');
  console.log('\nevidence: experiments/storage-access/evidence/results.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
