// Unflash in Firefox: stock Firefox, headless, WebGPU on a software Vulkan
// (lavapipe), driven over WebDriver BiDi. Firefox is where the page runs
// most unlike the Chromium the other tests use: its WebGPU takes no
// VideoFrame, so the pictures reach the detector through the decode
// workers, copied out of its decoder; it has no long-task API; and it
// offers to stop a page that keeps its thread for long. Here, in Firefox:
// a scan on the GPU finds exactly what the CPU detector does; the page
// answers all through a scan, and a second Scan click is turned away while
// the first goes on; a section prepares, checks and is fixed by a Suggest
// button; and in a scan in chunks, the built-in decoder takes over the
// chunks Firefox's slow lanes hold up, with the same result.
//   FIREFOX=/path/to/firefox node tests/e2e/firefox.mjs
// (puppeteer-core found locally or globally: npm install -g puppeteer-core)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from './server.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WEB = path.join(ROOT, 'web');
const MEDIA = path.join(ROOT, 'tests/media/e2e');
const CLIP = 'flash.webm';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function loadPuppeteer() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  try {
    candidates.push(require.resolve('puppeteer-core'));
  } catch (e) {
    /* not local */
  }
  try {
    candidates.push(`${execSync('npm root -g', { encoding: 'utf8' }).trim()}/puppeteer-core/lib/puppeteer/puppeteer-core.js`);
  } catch (e) {
    /* no npm */
  }
  for (const c of candidates) if (fs.existsSync(c)) return (await import(c)).default;
  throw new Error('puppeteer-core not found; npm install -g puppeteer-core');
}

function firefoxPath() {
  if (process.env.FIREFOX) return process.env.FIREFOX;
  try {
    return execSync('command -v firefox', { encoding: 'utf8', shell: '/bin/sh' }).trim();
  } catch (e) {
    throw new Error('no Firefox: set FIREFOX to its binary');
  }
}

const puppeteer = await loadPuppeteer();
const { srv, port } = await serve(WEB);
// WebGPU on the software adapter lavapipe gives it, where it is not on by default
const prefs = { 'dom.webgpu.enabled': true, 'gfx.webgpu.ignore-blocklist': true, 'gfx.webgpu.force-enabled': true, 'dom.webgpu.allow-software-adapter': true };
const browser = await puppeteer.launch({ browser: 'firefox', executablePath: firefoxPath(), headless: true, extraPrefsFirefox: prefs, protocolTimeout: 600000 });
const errors = [];
const results = {};

async function newPage(query) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror (${query}): ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__unflash && window.__unflash.changes, { timeout: 60000 });
  return page;
}
const idle = (page, timeout = 300000) => page.waitForFunction(() => !window.__unflash.state.job && document.querySelector('#jobbar').classList.contains('hidden'), { timeout, polling: 100 });
async function openClip(page, name = CLIP) {
  await (await page.$('#fileInput')).uploadFile(path.join(MEDIA, name));
  await page.waitForFunction((n) => document.querySelector('#videoInfo').textContent.includes(n), { timeout: 120000 }, name);
  await idle(page);
}
const scanned = (page) =>
  page.evaluate(() => {
    const s = window.__unflash.lastScan;
    return { ms: Math.round(s.elapsedMs), frames: s.frames, held: s.result.held, violations: s.result.violations, chunked: s.chunked || null, report: window.__unflash.debugReport() };
  });
async function scan(page) {
  await page.click('#btnScan');
  await page.waitForFunction(() => window.__unflash.state.job, { timeout: 30000, polling: 20 }).catch(() => {});
  await idle(page);
  return scanned(page);
}
function same(name, r, w) {
  assert(r.frames === w.frames && r.held === w.held, `${name}: frames ${r.frames} (held ${r.held}) vs ${w.frames} (held ${w.held})`);
  assert(r.violations.length > 0 && r.violations.length === w.violations.length, `${name}: the same violations: ${JSON.stringify(r.violations)} vs ${JSON.stringify(w.violations)}`);
  for (let i = 0; i < r.violations.length; i++) {
    const a = r.violations[i];
    const b = w.violations[i];
    const ok = a.kind === b.kind && ['start', 'end', 'onset', 'peak', 'count'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);
    assert(ok, `${name}: violation ${i} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}

try {
  // --- the CPU detector's reading of the clip, for the GPU's to match --------
  const cpu = await newPage('cpu=1&auto=0&hybrid=0');
  await openClip(cpu);
  results.cpu = await scan(cpu);
  await cpu.close();
  const kinds = results.cpu.violations.map((v) => v.kind);
  assert(kinds.includes('flash') && kinds.includes('red'), 'the clip flashes, and red: ' + JSON.stringify(results.cpu.violations));

  // --- WebGPU, the pictures through the decode workers -----------------------
  const page = await newPage('auto=0&hybrid=0');
  await openClip(page);
  results.env = await page.evaluate(() => {
    const u = window.__unflash.state;
    const f = u.env.feeder;
    return { ua: navigator.userAgent, support: document.querySelector('#support').textContent, backend: f.backend, route: f.routeDetail || f.route || '', workers: !!u.movie.decodeInWorkers };
  });
  console.log('firefox:', JSON.stringify(results.env));
  assert(/Firefox\//.test(results.env.ua) && results.env.backend === 'webgpu' && /WebGPU/.test(results.env.support), 'Firefox runs the detector on WebGPU: ' + JSON.stringify(results.env));
  assert(results.env.workers, "Firefox's WebGPU takes no VideoFrame: the clip is decoded in workers");
  // the page's thread through a scan: the longest gap between 10 ms ticks
  // (no long-task API here); and a second Scan click while it runs
  await page.evaluate(() => {
    window.__gaps = [];
    let last = performance.now();
    window.__tick = setInterval(() => {
      const now = performance.now();
      window.__gaps.push(now - last);
      last = now;
    }, 10);
    window.__toasts = [];
    const t = document.querySelector('#toast');
    new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true });
  });
  await page.click('#btnScan');
  await page.waitForFunction(() => window.__unflash.state.job, { timeout: 30000, polling: 20 });
  await page.click('#btnScan');
  await idle(page);
  results.gpu = await scanned(page);
  const held = await page.evaluate(() => {
    clearInterval(window.__tick);
    return { gaps: window.__gaps.slice().sort((a, b) => b - a).slice(0, 5).map(Math.round), toasts: window.__toasts };
  });
  console.log('scan on WebGPU:', results.gpu.ms, 'ms |', results.gpu.frames, 'frames | longest gaps between ticks:', held.gaps.join(', '), 'ms');
  same('WebGPU in Firefox against the CPU detector', results.gpu, results.cpu);
  assert(held.toasts.some((t) => /^Scanning for flashes is under way: scan once it has finished/.test(t)), 'the second Scan click is turned away with a word: ' + JSON.stringify(held.toasts));
  // (the page used to be held for seconds at a time, and Firefox offered to stop it)
  assert(held.gaps[0] < 1000, 'the page answers all through the scan: the longest gap between ticks was ' + held.gaps[0] + ' ms');

  // --- a section: prepared through the workers, checked, fixed ---------------
  await page.click('#sectionList .sec-item');
  await page.waitForFunction(() => /passes|fails/.test(document.querySelector('#wsVerdict').textContent), { timeout: 180000, polling: 200 });
  results.sectionBefore = await page.$eval('#wsVerdict', (e) => e.textContent);
  assert(/^fails/.test(results.sectionBefore), 'the first section fails as it is: ' + results.sectionBefore);
  await page.click('#btnSuggestFewest');
  await page.waitForFunction(() => window.__unflash.state.job, { timeout: 30000, polling: 20 }).catch(() => {});
  await idle(page);
  await page.waitForFunction(() => /passes|fails/.test(document.querySelector('#wsVerdict').textContent), { timeout: 60000, polling: 200 });
  results.sectionAfter = await page.$eval('#wsVerdict', (e) => e.textContent);
  console.log('section:', results.sectionBefore, '→ after fewest removals:', results.sectionAfter);
  assert(/^passes/.test(results.sectionAfter), 'fewest removals fixes it: ' + results.sectionAfter);
  await page.close();

  // --- a scan in chunks: Firefox's lanes made slow, the built-in decoder's idle
  // lane takes over the chunks the detector waits for, from the last picture in
  const lanes = await newPage('auto=0&hybrid=2,2&chunk=1&order=file&hold=13&slowlanes=150');
  await openClip(lanes);
  results.takenOver = await scan(lanes);
  const h = results.takenOver.chunked;
  console.log('scan in chunks, slow Firefox lanes:', results.takenOver.ms, 'ms |', JSON.stringify(h && { chunks: h.chunks, steals: h.steals, lanes: h.lanes.map((l) => [l.kind, l.workers, l.frames, l.chunks, l.steals, l.stolen]) }));
  assert(h && h.chunks >= 8 && !h.fallback, 'a scan in chunks: ' + JSON.stringify(h));
  same('taken over', results.takenOver, results.cpu);
  assert(h.lanes.reduce((a, l) => a + l.frames, 0) === results.takenOver.frames, 'each picture decoded once: ' + JSON.stringify(h.lanes));
  const builtIn = h.lanes.find((l) => l.kind === 'built-in');
  assert(builtIn && h.steals >= 1 && builtIn.steals === h.steals && h.lanes.some((l) => l.kind !== 'built-in' && l.stolen > 0), "the built-in lane took chunks over from Firefox's: " + JSON.stringify(h));
  await lanes.close();

  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  console.log('FIREFOX OK');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.close();
}
