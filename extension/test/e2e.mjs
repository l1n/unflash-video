// The extension in headless Chromium: loaded unpacked from extension/build/chrome,
// it guards a page's videos as they play: looking ahead (none of the
// flashing is ever on screen, read off screenshots), and reacting as it plays.
//   ./build.sh && node extension/build.mjs && node extension/test/e2e.mjs
//
// The videos: a canvas played through a <video> (calm, then 3 s of a whole
// picture flashing black and white at 7.5 flashes a second, then calm), and
// a file made by ffmpeg like it, from the page's own site and from another
// one (which the page may not read).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { CHROMIUM_ARGS, loadPlaywright } from '../../tests/e2e/playwright.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'build', 'chrome');
const OUT = path.join(HERE, '..', 'build', 'test');
fs.mkdirSync(OUT, { recursive: true });

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error('extension/build/chrome is missing: ./build.sh && node extension/build.mjs');
  process.exit(1);
}

// the flashing file: 2 s calm grey, 3 s black and white swapping every 4 frames (30 fps), 3 s calm
const CLIP = path.join(OUT, 'flash.webm');
if (!fs.existsSync(CLIP)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x606060:s=480x270:r=30:d=8',
    '-vf', "geq=lum='if(between(T,2,5), if(lt(mod(N,8),4),16,235), 96+20*sin(T))':cb=128:cr=128",
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', CLIP]);
}
// the same with a sound track (a tone), for the sound delayed with the pictures
const CLIP_SOUND = path.join(OUT, 'flash-sound.webm');
if (!fs.existsSync(CLIP_SOUND)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', CLIP, '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-c:v', 'copy', '-c:a', 'libopus', '-shortest', CLIP_SOUND]);
}

/** The colour of a 1×1 PNG (a screenshot of one pixel): [r, g, b]. */
function pngPixel(buf) {
  let pos = 8;
  let type = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    if (name === 'IHDR') type = buf[pos + 8 + 9];
    if (name === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  // (one pixel: whatever its row's filter, it has no neighbours, so the bytes are the pixel's)
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert(type === 2 || type === 6, `a PNG of colour type ${type}`);
  return [raw[1], raw[2], raw[3]];
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>flash test</title>
<style>body{margin:0;background:#222} .box{position:relative;width:640px;height:360px;margin:20px} video{width:100%;height:100%;display:block;background:#000}</style>
<div class="box"><video id="v" muted playsinline></video></div>
<script>
// a canvas played as a video: calm, flashing from 2.5 s to 5.5 s, calm
window.startCanvas = () => {
  const c = document.createElement('canvas'); c.width = 480; c.height = 270;
  const ctx = c.getContext('2d');
  const v = document.getElementById('v');
  v.srcObject = c.captureStream(30);
  const t0 = performance.now(); let n = 0;
  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    if (t > 2.5 && t < 5.5) ctx.fillStyle = (n++ >> 2) % 2 ? '#fff' : '#000';
    else ctx.fillStyle = 'hsl(' + (200 + 10 * Math.sin(t)) + ',20%,40%)';
    ctx.fillRect(0, 0, 480, 270);
    window.__t = t;
    if (t < 9) setTimeout(draw, 1000 / 30);
  };
  draw();
  return v.play();
};
window.startFile = (src, sound = false) => { const v = document.getElementById('v'); v.muted = !sound; v.src = src; return v.play(); };
window.overlay = () => !!document.querySelector('unflash-overlay');
window.filter = () => document.getElementById('v').style.filter;
</script>`;

function server(host) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/flash')) {
      res.setHeader('content-type', 'video/webm');
      fs.createReadStream(req.url.startsWith('/flash-sound') ? CLIP_SOUND : CLIP).pipe(res);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  return new Promise((r) => srv.listen(0, host, () => r({ srv, url: `http://${host}:${srv.address().port}` })));
}

const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default.chromium;
const site = await server('127.0.0.1');
// (another origin for the same file: localhost is not 127.0.0.1)
const other = `http://localhost:${new URL(site.url).port}`;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unflash-ext-'));
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  // (the new headless mode, which runs extensions; WebGPU on SwiftShader as in the app's tests)
  channel: 'chromium',
  args: [...CHROMIUM_ARGS, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
});
let failed = false;
try {
  // (the settings and the toolbar's reports through an extension page: the
  // service worker's handle has no extension APIs in Playwright)
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const control = await ctx.newPage();
  await control.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  const setSettings = (s) => control.evaluate((s) => chrome.storage.sync.set(s), s);
  const tabStatus = () => control.evaluate(async () => Object.values(await chrome.storage.session.get(null))[0] || {});
  const page = await ctx.newPage();
  page.on('console', (m) => /unflash/.test(m.text()) && console.log('  [page]', m.text()));

  /** Play `start` and sample the overlay and the filter every 50 ms for `seconds`. */
  let shot = null;
  async function run(start, seconds, shotAt = 0) {
    await page.goto(site.url + '/');
    await page.evaluate(start);
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      if (shotAt && Date.now() - t0 >= shotAt * 1000) {
        // (what the page shows while it is held: the calm picture, over the video)
        await page.screenshot({ path: path.join(OUT, 'held.png') });
        // (the middle of the video, as shown: read through an image on the control page)
        const png = await page.screenshot({ clip: { x: 340, y: 200, width: 1, height: 1 } });
        shot = await control.evaluate(async (b64) => {
          const img = new Image();
          img.src = 'data:image/png;base64,' + b64;
          await img.decode();
          const c = new OffscreenCanvas(1, 1);
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        }, png.toString('base64'));
        shotAt = 0;
      }
      samples.push({ t: (Date.now() - t0) / 1000, overlay: await page.evaluate(() => window.overlay()), filter: await page.evaluate(() => window.filter()) });
      await page.waitForTimeout(50);
    }
    return samples;
  }
  const span = (samples, key) => {
    const on = samples.filter((s) => (key === 'filter' ? /brightness/.test(s.filter) : s.overlay));
    return on.length ? [on[0].t, on[on.length - 1].t] : null;
  };

  /**
   * Play `start` and read the middle of the video, as the page shows it,
   * as often as screenshots can be taken, for `seconds`: [{ t, rgb }].
   */
  async function look(start, seconds) {
    await page.goto(site.url + '/');
    await page.evaluate(start);
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      const png = await page.screenshot({ clip: { x: 340, y: 200, width: 1, height: 1 } });
      samples.push({ t: (Date.now() - t0) / 1000, rgb: pngPixel(png) });
    }
    return samples;
  }
  // the flashing's two colours as they are (dimmed, they are about 22 and 67)
  const flashLike = ([r, g, b]) => (r < 12 && g < 12 && b < 12) || (r > 225 && g > 225 && b > 225);
  const calmLike = ([r, g, b]) => b > r + 10 && b > 70 && b < 160;
  const seen = (samples, from, to, test) => samples.filter((x) => x.t >= from && x.t <= to && test(x.rgb));

  // A. looking ahead, holding: the canvas flashing from 2.5 s to 5.5 s, shown
  // a second late; none of its flashing is ever on screen
  await setSettings({ mode: 'hold', sensitivity: 'balanced', detector: 'cpu', lookahead: 1, badge: true, enabled: true, disabledSites: [] });
  let px = await look(() => window.startCanvas(), 9.5);
  let bad = seen(px, 0.5, 9.5, flashLike);
  console.log(`look ahead, hold: ${px.length} looks, ${bad.length} with flashing on screen${bad.length ? ': ' + bad.slice(0, 5).map((x) => `${x.t.toFixed(2)} s rgb(${x.rgb})`).join(', ') : ''}`);
  assert(px.length > 40, `only ${px.length} looks at the screen`);
  assert(!bad.length, 'flashing was on screen while looking ahead');
  assert(seen(px, 4, 6, calmLike).length > 5, 'the calm picture was not held over the flashing');
  assert(seen(px, 7.6, 9.5, calmLike).length > 3, 'the video did not come back after the flashing');
  let st = await tabStatus();
  console.log('  status:', JSON.stringify(st));
  assert(Object.values(st).some((f) => f.ahead >= 1 && f.events >= 1), 'not reported as looking ahead, or no flashing reported');

  // B. looking ahead, dimming: the file; its flashing only ever dimmed
  await setSettings({ mode: 'dim' });
  px = await look(() => window.startFile('/flash.webm'), 8.5);
  bad = seen(px, 0.5, 8.5, flashLike);
  const dimmedAhead = seen(px, 3, 6, ([r, g, b]) => Math.abs(r - b) < 12 && r < 90);
  console.log(`look ahead, dim: ${px.length} looks, ${bad.length} with flashing on screen, ${dimmedAhead.length} dimmed`);
  assert(!bad.length, `flashing was on screen while looking ahead: ${bad.map((x) => `${x.t.toFixed(2)} s rgb(${x.rgb})`).join(', ')}`);
  assert(dimmedAhead.length > 5, 'the flashing was not dimmed');

  // C. with sound: the sound is delayed as much, so the pictures are shown late too
  await setSettings({ mode: 'hold' });
  await page.goto(site.url + '/');
  await page.evaluate(() => window.startFile('/flash-sound.webm', true));
  await page.waitForTimeout(2500);
  st = await tabStatus();
  console.log('  with sound, status:', JSON.stringify(st));
  assert(Object.values(st).some((f) => f.ahead >= 1 && !f.onTime), 'a video with sound was not shown late');

  // D. looking ahead, pausing: paused before any of the flashing is shown
  await setSettings({ mode: 'pause', badge: true });
  px = await look(() => window.startCanvas(), 6);
  bad = seen(px, 0.5, 6, flashLike);
  const pausedAhead = await page.evaluate(() => document.getElementById('v').paused);
  console.log(`look ahead, pause: ${px.length} looks, ${bad.length} with flashing on screen, paused ${pausedAhead}`);
  assert(!bad.length && pausedAhead, 'paused looking ahead, flashing was seen, or it was not paused');

  // E. the same canvas without looking ahead: the looks do catch flashing on screen
  await setSettings({ mode: 'hold', lookahead: 0 });
  px = await look(() => window.startCanvas(), 6);
  bad = seen(px, 0.5, 6, flashLike);
  console.log(`as it plays, hold: ${px.length} looks, ${bad.length} with flashing on screen (its first moment)`);
  assert(bad.length > 0, 'the looks see no flashing even without looking ahead: they prove nothing');

  // the rest react as the video plays
  // 1. hold: a canvas flashing from 2.5 s to 5.5 s (on the CPU, which
  // answers at once: SwiftShader's WebGPU answers most of a second late)
  await setSettings({ mode: 'hold', sensitivity: 'balanced', detector: 'cpu', lookahead: 0, badge: true, enabled: true, disabledSites: [] });
  let s = await run(() => window.startCanvas(), 8.5, 3.5);
  let held = span(s, 'overlay');
  console.log(`hold, canvas: held ${held ? held.map((x) => x.toFixed(2)).join('–') + ' s' : 'never'}`);
  assert(held, 'the flashing canvas was never held');
  assert(held[0] > 2.3 && held[0] < 3.6, `held from ${held[0]} s: the flashing starts at 2.5 s`);
  assert(held[1] > 5.3 && held[1] < 7, `held until ${held[1]} s: the flashing ends at 5.5 s, plus a second`);
  assert(!s[s.length - 1].overlay, 'still held at the end');
  // the calm picture (a grey blue, hsl(200±10, 20%, 40%)), not black or white
  console.log(`  the middle of the video while held: rgb(${shot})`);
  assert(shot && shot[2] > shot[0] + 10 && shot[2] > 70 && shot[2] < 160, `the held picture is not the calm one: rgb(${shot})`);
  st = await tabStatus();
  console.log('  status:', JSON.stringify(st));
  assert(Object.values(st).some((f) => f.events >= 1 && f.videos >= 1), 'the toolbar was not told');

  // 2. dim: the file, flashing from 2 s to 5 s
  // (without the badge, which goes over the video in every mode)
  await setSettings({ mode: 'dim', badge: false });
  s = await run(() => window.startFile('/flash.webm'), 8);
  const dimmed = span(s, 'filter');
  console.log(`dim, file: dimmed ${dimmed ? dimmed.map((x) => x.toFixed(2)).join('–') + ' s' : 'never'}`);
  assert(dimmed, 'the flashing file was never dimmed');
  assert(dimmed[0] > 1.8 && dimmed[0] < 3.2, `dimmed from ${dimmed[0]} s: the flashing starts at 2 s`);
  assert(!s[s.length - 1].filter, `the filter was left on: ${s[s.length - 1].filter}`);
  assert(!span(s, 'overlay'), 'dim put a picture over the video');

  // 3. pause: paused at the flashing, and saying so until played again
  await setSettings({ mode: 'pause', badge: true });
  await page.goto(site.url + '/');
  await page.evaluate(() => window.startCanvas());
  await page.waitForFunction(() => window.__t > 4.5);
  const paused = await page.evaluate(() => [document.getElementById('v').paused, window.overlay()]);
  await page.waitForFunction(() => window.__t > 6.5);
  const still = await page.evaluate(() => window.overlay());
  await page.evaluate(() => document.getElementById('v').play());
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => [document.getElementById('v').paused, window.overlay()]);
  console.log(`pause: paused ${paused[0]}, said so ${paused[1]}, still at 6.5 s ${still}; played again: paused ${after[0]}, said so ${after[1]}`);
  assert(paused[0] && paused[1] && still, 'the flashing video was not paused, or did not say why');
  assert(!after[0] && !after[1], 'played again, it was still paused or still said so');

  // 4. off on this site: nothing is done
  await setSettings({ mode: 'hold', badge: true, disabledSites: ['127.0.0.1'] });
  s = await run(() => window.startCanvas(), 6.5);
  assert(!span(s, 'overlay') && !span(s, 'filter'), 'a site turned off was guarded');
  console.log('off on the site: left alone');

  // 5. a video from another site, without CORS: it says it cannot read it
  await setSettings({ disabledSites: [] });
  await page.goto(site.url + '/');
  await page.evaluate((src) => window.startFile(src), `${other}/flash.webm`);
  await page.waitForTimeout(2000);
  st = await tabStatus();
  console.log('  status:', JSON.stringify(st));
  assert(Object.values(st).some((f) => f.unreadable >= 1), 'a video from another site was not reported unreadable');
  console.log('another site: reported unreadable');

  // 6. the GPU detector, however late SwiftShader's verdicts come
  await setSettings({ mode: 'hold', detector: 'gpu' });
  s = await run(() => window.startCanvas(), 9);
  held = span(s, 'overlay');
  st = await tabStatus();
  console.log(`hold on the GPU: held ${held ? held.map((x) => x.toFixed(2)).join('–') + ' s' : 'never'}; status ${JSON.stringify(st)}`);
  assert(Object.values(st).some((f) => f.backend === 'webgpu'), 'not on the GPU');
  assert(held && held[0] > 2.3, 'the GPU detector never held the flashing');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await ctx.close();
  site.srv.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
}
console.log(failed ? 'FAILED' : 'extension: all passed');
process.exit(failed ? 1 : 0);
