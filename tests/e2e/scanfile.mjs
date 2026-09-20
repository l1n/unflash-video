// Scan one local video file through the web app in headless Chromium and
// print what the detector found: violations, the summary line and, with
// --trace, the per-frame hazard / red-hazard / luminance trace.
//   node tests/e2e/scanfile.mjs file.mp4 [--cpu] [--trace] [--profile wcag|wcag_ext]
import { loadPlaywright } from './playwright.mjs';
import path from 'node:path';
import { serve } from './server.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const file = path.resolve(process.argv[2]);
const cpu = process.argv.includes('--cpu');
const trace = process.argv.includes('--trace');
const pi = process.argv.indexOf('--profile');
const profile = pi > 0 ? process.argv[pi + 1] : null;
const { chromium } = await loadPlaywright();
const { srv, port } = await serve(path.join(ROOT, 'web'));
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || process.env.E2E_VERBOSE) console.log('[browser]', m.type(), m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/?auto=0${cpu ? '&cpu=1' : ''}`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
  await page.setInputFiles('#fileInput', file);
  await page.waitForFunction((n) => document.querySelector('#videoInfo').textContent.includes(n), path.basename(file), { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#status').textContent.includes('ready ·'), null, { timeout: 60000 });
  if (profile) {
    await page.selectOption('#profileSel', profile);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Profile changed'), null, { timeout: 30000 });
  }
  console.log('info:', await page.textContent('#videoInfo'));
  console.log('status:', await page.textContent('#status'));
  const banner = await page.evaluate(() => (document.querySelector('#banner').classList.contains('hidden') ? '' : document.querySelector('#bannerText').textContent));
  if (banner) console.log('banner:', banner);
  await page.click('#btnScan');
  await page.waitForFunction(() => !document.querySelector('#jobbar').classList.contains('hidden'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#jobbar').classList.contains('hidden'), null, { timeout: 600000 });
  console.log('toast:', await page.textContent('#toast'));
  const scan = await page.evaluate(() => {
    const s = window.__unflash.state;
    return { violations: window.__unflash.lastScan && window.__unflash.lastScan.result.violations, trace: s.scanTrace, route: s.env.feeder.route, area: s.env.feeder.det.area_thresh() };
  });
  console.log('route:', scan.route, '| area threshold (px):', scan.area);
  console.log('violations:', JSON.stringify(scan.violations, null, 1));
  if (trace && scan.trace) {
    const t = scan.trace;
    console.log('t, hazard, hazardRed, ext, lum, pattern');
    for (let i = 0; i < t.t.length; i++) console.log(t.t[i].toFixed(3), t.hazard[i], t.hazardRed[i], t.ext[i], t.lum[i] === undefined ? '' : t.lum[i].toFixed ? t.lum[i].toFixed(4) : t.lum[i], t.pattern[i]);
  }
  console.log(await page.evaluate(() => window.__unflash.profile.summary(1)));
} finally {
  await browser.close();
  srv.close();
}
