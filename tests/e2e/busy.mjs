// The page while a job runs. A second Scan click while a scan runs is
// turned away with a word, and the running scan finishes as if nothing had
// happened (it used to kill it: "can't access property "length",
// state.provisional is null"); so is a video opened meanwhile. And a scan
// never keeps the page's thread for long, however far its decoders get
// ahead of the detector: a chunked scan fed every picture it held in one
// go, for seconds on a slow machine, and Firefox offered to stop the page.
// The detector is made slow here (a few milliseconds more a picture), as a
// slow machine's is, so that the decoders get ahead on a short clip.
//   node tests/e2e/busy.mjs
import { loadPlaywright } from './playwright.mjs';
import path from 'node:path';
import { serve } from './server.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WEB = path.join(ROOT, 'web');
const MEDIA = path.join(ROOT, 'tests/media/e2e');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

const { chromium } = await loadPlaywright();
const { srv, port } = await serve(WEB);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const idle = () => page.waitForFunction(() => !window.__unflash.state.job && document.querySelector('#jobbar').classList.contains('hidden'), null, { timeout: 180000 });

try {
  // chunks of 2 s, so that the scan is a chunked one, and three decode lanes
  // (as Firefox's WebGPU route has up to six), which decode chunks ahead of
  // the one the detector is on
  await page.goto(`http://127.0.0.1:${port}/?cpu=1&auto=0&chunk=2&segments=3`);
  await page.waitForFunction(() => window.__unflash && window.__unflash.changes, null, { timeout: 30000 });
  await page.setInputFiles('#fileInput', path.join(MEDIA, 'flash.webm'));
  await page.waitForFunction(() => document.querySelector('#videoInfo').textContent.includes('flash.webm'), null, { timeout: 60000 });
  await idle();
  await page.evaluate(() => {
    // tasks that keep the page's thread 50 ms or more
    window.__long = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__long.push(Math.round(e.duration));
    }).observe({ type: 'longtask' });
    // a slow machine's detector: 6 ms more a picture
    const f = window.__unflash.state.env.feeder;
    const feed = f.videoFrame.bind(f);
    f.videoFrame = async (...a) => {
      const t = performance.now();
      while (performance.now() - t < 6);
      return feed(...a);
    };
    window.__unslow = () => delete f.videoFrame;
    // every word the page says, as it says it
    window.__toasts = [];
    const t = document.querySelector('#toast');
    new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true });
  });

  await page.click('#btnScan');
  await page.waitForFunction(() => window.__unflash.state.job && window.__unflash.state.job.name === 'Scanning for flashes', null, { timeout: 10000 });
  // Scan again, and another video, while it runs
  await page.click('#btnScan');
  await page.setInputFiles('#fileInput', path.join(MEDIA, 'steady.mp4'));
  const during = await page.evaluate(() => !!(window.__unflash.state.job && window.__unflash.state.scanning));
  await idle();
  const r = await page.evaluate(() => {
    window.__unslow();
    const u = window.__unflash;
    return {
      banner: document.querySelector('#banner').classList.contains('hidden') ? '' : document.querySelector('#bannerText').textContent,
      video: document.querySelector('#videoInfo').textContent,
      frames: u.lastScan ? u.lastScan.frames : 0,
      violations: u.lastScan ? u.lastScan.result.violations.map((v) => v.kind) : [],
      chunks: u.lastScan && u.lastScan.chunked ? u.lastScan.chunked.chunks : 0,
      peak: u.lastScan && u.lastScan.chunked ? u.lastScan.chunked.peak : 0,
      scanning: u.state.scanning,
      long: window.__long.slice().sort((a, b) => b - a),
      toasts: window.__toasts.slice(),
    };
  });
  console.log(`scan: ${r.frames} frames in ${r.chunks} chunks, ${Math.round(r.peak / 1024)} KB of pictures held at most; violations ${r.violations.join(', ')}`);
  console.log(`tasks of 50 ms or more during it: ${r.long.length ? r.long.join(', ') + ' ms' : 'none'}`);
  assert(!r.banner, 'the scan was not killed: ' + r.banner);
  assert(r.frames === 300 && r.violations.join() === 'flash,red' && r.chunks > 1, 'the first scan finished, whole: ' + JSON.stringify(r));
  assert(/flash\.webm/.test(r.video) && r.scanning === null, 'the video opened meanwhile was not, and the scan left nothing behind: ' + r.video);
  // (the decoders were ahead: dozens of pictures waited for the detector)
  assert(r.peak > 40 * 256 * 144 * 4, 'the decoders got ahead of the slowed detector: ' + r.peak);
  assert(!r.long.length || r.long[0] < 250, 'the scan never kept the page for long: ' + r.long.join(', '));
  assert(during, 'the first scan was still running when both were turned away');
  const said = (re) => r.toasts.some((x) => re.test(x));
  assert(said(/^Scanning for flashes is under way: scan once it has finished/) && said(/^Scanning for flashes is under way: open the video once it has finished/), 'and the page said why: ' + JSON.stringify(r.toasts));

  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  console.log('BUSY OK');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.close();
}
