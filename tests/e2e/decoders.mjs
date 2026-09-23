// The built-in HEVC, VP9, VP8 and AV1 decoders (the decoders module,
// web/pkg-dec) end to end: each flash clip scans with its built-in decoder
// (HEVC because the test browser has no decoder for it, the others because
// `?builtin=1` asks for one) and must find the flashing the browser's own
// decoder finds; and a hybrid scan of the VP9 clip, the browser's decoder
// and the built-in one side by side in chunks, must give exactly what one
// lane of the browser's decoder gives, the built-in decoder having decoded
// part of it.
//   node tests/e2e/decoders.mjs        (after ./build.sh)
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
const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-vulkan=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  // (the player turning down a file it cannot play is expected)
  if (m.type() === 'error' && !/Failed to load resource|MEDIA_ERR|DEMUXER_ERROR|PIPELINE_ERROR/i.test(m.text())) errors.push('console: ' + m.text());
  if (process.env.E2E_VERBOSE) console.log('[browser]', m.type(), m.text());
});
const bannerError = () => page.evaluate(() => {
  const b = document.querySelector('#banner');
  return b.classList.contains('hidden') || b.classList.contains('info') ? '' : document.querySelector('#bannerText').textContent;
});

/** Open `name` at `?query` and scan it: what decoded it and what the scan found. */
async function scan(name, query) {
  await page.goto(`http://127.0.0.1:${port}/?auto=0${query ? '&' + query : ''}`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
  await page.setInputFiles('#fileInput', path.join(MEDIA, name));
  await page.waitForFunction((n) => document.querySelector('#videoInfo').textContent.includes(n), name, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#status').textContent.includes('ready ·'), null, { timeout: 60000 });
  const opened = await bannerError();
  assert(!opened, `${name} ?${query}: opening it raised: ${opened}`);
  await page.click('#btnScan');
  await page.waitForFunction(() => !document.querySelector('#jobbar').classList.contains('hidden'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#jobbar').classList.contains('hidden'), null, { timeout: 300000 });
  const failed = await bannerError();
  assert(!failed, `${name} ?${query}: the scan raised: ${failed}`);
  return page.evaluate(() => {
    const u = window.__unflash;
    const s = u.lastScan;
    const m = u.state.movie;
    return { software: !!(u.state.decode && u.state.decode.software), builtIn: m.builtIn ? m.builtIn.name : null, frames: s.frames, held: s.result.held, violations: s.result.violations, chunked: s.chunked || null };
  });
}

const results = {};
try {
  for (const [name, query, codec] of [
    ['flash_hevc.mp4', '', 'HEVC'],
    ['flash.webm', 'builtin=1', 'VP9'],
    ['flash_vp8.webm', 'builtin=1', 'VP8'],
    ['flash_av1.mp4', 'builtin=1', 'AV1'],
  ]) {
    const r = await scan(name, query);
    results[name] = r;
    console.log(`${name} ?${query}:`, JSON.stringify({ software: r.software, builtIn: r.builtIn, frames: r.frames, violations: r.violations.map((v) => [v.kind, v.start, v.end]) }));
    assert(r.software && r.builtIn === codec, `${name}: decoded by the built-in ${codec} decoder: ${JSON.stringify(r)}`);
    assert(r.frames === 300, `${name}: every frame: ${r.frames}`);
    const gen = r.violations.find((v) => v.kind === 'flash');
    const red = r.violations.find((v) => v.kind === 'red');
    assert(gen && gen.start > 3.5 && gen.start < 4.6 && gen.end > 5.2 && gen.end < 5.8, `${name}: general flash at 3.9-5.5 s: ${JSON.stringify(r.violations)}`);
    assert(red && red.start > 7.5 && red.start < 8.6 && red.end > 8.2 && red.end < 8.8, `${name}: red flash at 7.9-8.5 s: ${JSON.stringify(r.violations)}`);
    if (!query) continue;
    // the browser's own decoder finds the same (its pictures reach the
    // detector by another route: a frame's difference at the edges at most)
    const b = await scan(name, '');
    console.log(`${name} with the browser's decoder:`, JSON.stringify(b.violations.map((v) => [v.kind, v.start, v.end])));
    assert(!b.software && b.violations.length === r.violations.length, `${name}: the browser's decoder finds as many violations: ${JSON.stringify(b.violations)}`);
    b.violations.forEach((v, i) => {
      const w = r.violations[i];
      assert(v.kind === w.kind && Math.abs(v.start - w.start) < 0.05 && Math.abs(v.end - w.end) < 0.05, `${name}: violation ${i}: ${JSON.stringify(v)} (browser) vs ${JSON.stringify(w)} (built-in)`);
    });
  }

  // a hybrid scan in chunks of a second: one lane of the browser's decoder
  // and the built-in VP9 decoder's two workers, against the browser's
  // decoder on its own, in chunks as well (both hand the detector pictures
  // made small in workers): exactly the same
  const one = await scan('flash.webm', 'hybrid=0&chunk=1&order=file');
  const two = await scan('flash.webm', 'hybrid=1,2&chunk=1&order=file');
  console.log('VP9 in chunks, one lane:', JSON.stringify({ violations: one.violations.map((v) => [v.kind, v.start, v.end]), lanes: one.chunked && one.chunked.lanes.map((l) => [l.kind, l.frames]) }));
  console.log('VP9 in chunks, hybrid:', JSON.stringify({ violations: two.violations.map((v) => [v.kind, v.start, v.end]), lanes: two.chunked && two.chunked.lanes.map((l) => [l.kind, l.frames, l.failed]) }));
  assert(one.chunked && two.chunked && !one.chunked.fallback && !two.chunked.fallback, 'both scans ran in chunks: ' + JSON.stringify([one.chunked, two.chunked]));
  const builtInLane = two.chunked.lanes.find((l) => l.kind === 'built-in');
  assert(builtInLane && builtInLane.frames > 0 && !builtInLane.failed, 'the built-in VP9 decoder decoded part of the file: ' + JSON.stringify(two.chunked.lanes));
  assert(one.frames === two.frames && one.held === two.held && one.violations.length === two.violations.length && one.violations.length > 0, 'the same frames and violations: ' + JSON.stringify([one.violations, two.violations]));
  one.violations.forEach((v, i) => {
    const w = two.violations[i];
    const same = v.kind === w.kind && ['start', 'end', 'onset', 'peak', 'count'].every((k) => Math.abs(v[k] - w[k]) < 1e-6);
    assert(same, `violation ${i}: ${JSON.stringify(v)} (one lane) vs ${JSON.stringify(w)} (hybrid)`);
  });

  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  console.log('DECODERS OK');
} catch (e) {
  console.error(e);
  await page.screenshot({ path: path.join(ROOT, 'tests/e2e/out/decoders-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.close();
}
