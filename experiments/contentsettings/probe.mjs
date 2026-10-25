// T10 probe: can chrome.contentSettings.cookies.set, after one click in the extension popup,
// let a cross-site iframe use its storage while third-party cookies are blocked?
//
// Run: node experiments/contentsettings/probe.mjs
// Uses Chrome for Testing from the Playwright cache, a throwaway profile with third-party
// cookies blocked, and two local servers that are different sites:
//   top page   http://localhost:4100/top.html   (stands in for the Rewind app)
//   frame page http://127.0.0.1:4200/frame.html (stands in for ufl.zoom.us)
// The frame tries localStorage and a SameSite=None cookie and reports back to the top page.
// Writes evidence to experiments/contentsettings/evidence/.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, 'evidence');
const TOP = 'http://localhost:4100/top.html';
const FRAME = 'http://127.0.0.1:4200/frame.html';

function findChrome() {
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const exe = join(base, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(exe)) return exe;
  }
  throw new Error('Chrome for Testing not found under ' + base);
}

const TOP_HTML = `<!doctype html><title>top</title><pre id="result">waiting</pre>
<iframe src="${FRAME}" width="400" height="100"></iframe>
<script>addEventListener('message', (e) => { document.getElementById('result').textContent = JSON.stringify(e.data); });</script>`;

const FRAME_HTML = `<!doctype html><title>frame</title><script>
const r = {};
try { localStorage.setItem('probe', '1'); r.localStorage = localStorage.getItem('probe') === '1' ? 'ok' : 'missing'; }
catch (e) { r.localStorage = 'error: ' + e.name; }
try {
  document.cookie = 'probe=1; SameSite=None; Secure; Path=/';
  r.cookie = /(^|; )probe=1/.test(document.cookie) ? 'ok' : 'not set';
} catch (e) { r.cookie = 'error: ' + e.name; }
(document.hasStorageAccess ? document.hasStorageAccess() : Promise.resolve(null))
  .then((v) => { r.hasStorageAccess = v; }, (e) => { r.hasStorageAccess = 'error: ' + e.name; })
  .then(() => parent.postMessage(r, '*'));
</script>`;

function serve(port, host, html) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

async function frameResult(page) {
  await page.goto(TOP);
  await page.waitForFunction(() => document.getElementById('result').textContent !== 'waiting', null, { timeout: 10000 });
  return JSON.parse(await page.textContent('#result'));
}

// Pattern pairs to try. Content-settings docs: for cookies, primary = the cookie's URL
// (the embedded site), secondary = the top-level frame's URL (the app).
const PAIRS = [
  { name: 'A embedded+port / top+port', primary: 'http://127.0.0.1:4200/*', secondary: 'http://localhost:4100/*' },
  { name: 'B any / top+port (like the settings UI site exception)', primary: '<all_urls>', secondary: 'http://localhost:4100/*' },
  { name: 'C embedded / any', primary: 'http://127.0.0.1:4200/*', secondary: '<all_urls>' },
  { name: 'D embedded, no secondary', primary: 'http://127.0.0.1:4200/*', secondary: '' },
  { name: 'E reversed: top / embedded', primary: 'http://localhost:4100/*', secondary: 'http://127.0.0.1:4200/*' },
  { name: 'F no ports: embedded host / top host', primary: 'http://127.0.0.1/*', secondary: 'http://localhost/*' },
];

async function launch(exe, extDir, extraArgs) {
  const profile = mkdtempSync(join(tmpdir(), 'rewind-t10-'));
  mkdirSync(join(profile, 'Default'), { recursive: true });
  // Block third-party cookies, as on John's Chrome (the reason the Zoom iframe needs the exception).
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
    profile: { cookie_controls_mode: 1, block_third_party_cookies: true },
  }));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: exe,
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...extraArgs],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  return { context, sw, extId, profile };
}

async function main() {
  mkdirSync(EVIDENCE, { recursive: true });
  const exe = findChrome();
  const servers = [await serve(4100, 'localhost', TOP_HTML), await serve(4200, '127.0.0.1', FRAME_HTML)];
  const log = { chrome: exe.replace(homedir(), '~'), startedAt: new Date().toISOString(), runs: [] };

  // Try the profile pref first; if the baseline isn't blocked, add the phase-out test flag.
  const modes = [
    { name: 'pref cookie_controls_mode=1', args: [] },
    { name: 'pref + --test-third-party-cookie-phaseout', args: ['--test-third-party-cookie-phaseout'] },
  ];
  for (const mode of modes) {
    const { context, sw, extId, profile } = await launch(exe, HERE, mode.args);
    const run = { mode: mode.name, version: context.browser()?.version() ?? null, extId, results: [] };
    log.runs.push(run);
    try {
      const page = await context.newPage();
      run.baseline = await frameResult(page);
      console.log(`[${mode.name}] baseline (no exception):`, JSON.stringify(run.baseline));
      if (run.baseline.localStorage === 'ok' && run.baseline.cookie === 'ok') {
        console.log(`[${mode.name}] third-party storage is NOT blocked here; this mode cannot answer the question.`);
        continue;
      }
      for (const pair of PAIRS) {
        await sw.evaluate(() => chrome.contentSettings.cookies.clear({}));
        // One real click in the extension popup (opened as a page so Playwright can click it).
        const popup = await context.newPage();
        const hash = new URLSearchParams({ primary: pair.primary, secondary: pair.secondary }).toString();
        await popup.goto(`chrome-extension://${extId}/popup.html#${hash}`);
        await popup.click('#allow');
        await popup.waitForFunction(() => document.getElementById('out').dataset.result, null, { timeout: 5000 });
        const setResult = await popup.textContent('#out');
        await popup.close();
        const got = await sw.evaluate(({ frame, top }) => chrome.contentSettings.cookies.get({ primaryUrl: frame, secondaryUrl: top }), { frame: FRAME, top: TOP });
        const after = await frameResult(page);
        const row = { pair: pair.name, primary: pair.primary, secondary: pair.secondary || null, set: setResult, get: got, frame: after };
        run.results.push(row);
        console.log(`[${mode.name}] ${pair.name}: set=${setResult} | get=${JSON.stringify(got)} | frame=${JSON.stringify(after)}`);
      }
      // The real pair, via the popup's defaults, then the settings page for a screenshot.
      await sw.evaluate(() => chrome.contentSettings.cookies.clear({}));
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await popup.click('#allow');
      await popup.waitForFunction(() => document.getElementById('out').dataset.result, null, { timeout: 5000 });
      run.realPair = await popup.textContent('#out');
      run.realPairGet = await sw.evaluate(() => chrome.contentSettings.cookies.get({ primaryUrl: 'https://ufl.zoom.us/rec/play/x', secondaryUrl: 'http://localhost:3000/practice' }));
      const settings = await context.newPage();
      const shot = join(EVIDENCE, `settings-cookies-${run.results.length ? mode.args.length : 0}.png`);
      try {
        await settings.goto('chrome://settings/cookies');
        await settings.waitForTimeout(1500);
        await settings.screenshot({ path: shot, fullPage: true });
        run.settingsScreenshot = 'evidence/' + shot.split('/').pop();
        run.settingsMentionsLocalhost = await settings.getByText('localhost', { exact: false }).count();
      } catch (e) {
        run.settingsScreenshot = 'failed: ' + e.message.split('\n')[0];
      }
      console.log(`[${mode.name}] real pair: ${run.realPair} | get=${JSON.stringify(run.realPairGet)} | settings: ${run.settingsScreenshot} (localhost mentions: ${run.settingsMentionsLocalhost})`);
    } catch (e) {
      run.error = String(e && e.stack || e);
      console.log(`[${mode.name}] error:`, e.message);
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  }
  log.finishedAt = new Date().toISOString();
  writeFileSync(join(EVIDENCE, 'results.json'), JSON.stringify(log, null, 2) + '\n');
  console.log('evidence:', join(EVIDENCE, 'results.json'));
  servers.forEach((s) => s.close());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
