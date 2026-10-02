// End-to-end test of the web app in headless Chromium with WebGPU (SwiftShader).
//   node tests/e2e/run.mjs [--headed] [--keep] [--part=editing,files,gpu,routes,auto]
// The parts run in that order by default; CI runs each on its own, side by
// side (a part that compares with the CPU scans makes them itself when it
// runs alone).
// The long editing flow runs on the CPU detector (SwiftShader's WebGPU is a
// software emulation and slow); a GPU scan of the same files must then find
// the same violations. The synthetic clips come from tests/media/gen_e2e.py;
// they are also copied to web/clips so the welcome page's "open" buttons
// (the published test clips) can be exercised.
import { loadPlaywright } from './playwright.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { serve } from './server.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WEB = path.join(ROOT, 'web');
const MEDIA = path.join(ROOT, 'tests/media/e2e');
const OUT = path.join(ROOT, 'tests/e2e/out');
const CLIPS = path.join(WEB, 'clips');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CLIPS, { recursive: true });
for (const f of fs.readdirSync(MEDIA)) if (f.endsWith('.mp4') && !fs.existsSync(path.join(CLIPS, f))) fs.copyFileSync(path.join(MEDIA, f), path.join(CLIPS, f));

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}
const jobDone = (page, timeout = 300000) => page.waitForFunction(() => document.querySelector('#jobbar').classList.contains('hidden'), null, { timeout });
// jobs can finish before a poll sees the job bar: wait for the toast to change instead
const toastBefore = (page) => page.evaluate(() => (window.__toastSeq = (window.__toastSeq || 0), document.querySelector('#toast').textContent));
// an error banner (info banners, such as the built-in decoder notice, are fine)
const errorBanner = (page) => page.evaluate(() => {
  const b = document.querySelector('#banner');
  return b.classList.contains('hidden') || b.classList.contains('info') ? '' : document.querySelector('#bannerText').textContent;
});
const jobStarted = async (page) => {
  await page.waitForFunction(() => !document.querySelector('#jobbar').classList.contains('hidden') || (!document.querySelector('#banner').classList.contains('hidden') && !document.querySelector('#banner').classList.contains('info')), null, { timeout: 30000 }).catch(() => {});
  const banner = await errorBanner(page);
  if (banner) throw new Error('banner: ' + banner);
};
const noBanner = async (page) => {
  const banner = await errorBanner(page);
  if (banner) throw new Error('banner: ' + banner);
};
const verdictReady = (page, timeout = 120000) => page.waitForFunction(() => /passes|fails/.test(document.querySelector('#wsVerdict').textContent), null, { timeout });
// click `selector`, and cancel the job it starts with the job bar's button
// as soon as that job's progress reaches `pct` percent (as its bar moves);
// resolves to the job's name once it has ended
const cancelledJob = async (page, selector, pct = 1) => {
  const name = await page.evaluate(
    ([sel, at]) => {
      const u = window.__unflash;
      document.querySelector(sel).click();
      const job = u.state.job;
      if (!job) return null;
      const watch = new MutationObserver(() => {
        if (u.state.job !== job) watch.disconnect();
        else if (job.pct >= at) {
          watch.disconnect();
          document.querySelector('#btnCancelJob').click();
        }
      });
      watch.observe(document.querySelector('#jobBar'), { attributes: true, attributeFilter: ['style'] });
      return job.name;
    },
    [selector, pct]
  );
  if (!name) throw new Error(`${selector} started no job`);
  await jobDone(page);
  return name;
};

const { chromium } = await loadPlaywright();
const { srv, port } = await serve(WEB);
const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
  channel: 'chromium',
  // (ForceEagerMeasureMemory: performance.measureUserAgentSpecificMemory() answers at once)
  args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--autoplay-policy=no-user-gesture-required', '--enable-blink-features=ForceEagerMeasureMemory'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
  if (process.env.E2E_VERBOSE) console.log('[browser]', m.type(), m.text());
});

const results = {};
const partArg = (process.argv.find((a) => a.startsWith('--part=')) || '').slice('--part='.length);
const PARTS = ['editing', 'files', 'gpu', 'routes', 'auto'];
const parts = partArg ? partArg.split(',') : PARTS;
for (const p of parts) if (!PARTS.includes(p)) throw new Error(`unknown part ${p}; the parts are ${PARTS.join(', ')}`);
const runs = (p) => parts.includes(p);
let scan;
let t0;
async function openFile(name) {
  await page.setInputFiles('#fileInput', path.join(MEDIA, name));
  await page.waitForFunction((n) => document.querySelector('#videoInfo').textContent.includes(n), name, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#status').textContent.includes('ready ·'), null, { timeout: 60000 });
}
// a section prepares itself when it is opened
async function openSectionPrepared(selector = '#sectionList .sec-item', timeout = 120000) {
  await page.click(selector);
  await page.waitForFunction(() => !document.querySelector('#wsBody').classList.contains('hidden'), null, { timeout });
}
const toastChange = async (before, timeout = 300000) => {
  await page.waitForFunction((t) => document.querySelector('#toast').textContent !== t || !document.querySelector('#banner').classList.contains('hidden'), before, { timeout });
  await noBanner(page);
  await jobDone(page);
};
async function scanCurrent() {
  const t0 = Date.now();
  await page.click('#btnScan');
  await jobStarted(page);
  await jobDone(page);
  const ms = Date.now() - t0;
  const project = await page.evaluate(() => JSON.parse(localStorage.getItem('unflash:lastScan') || 'null'));
  return { ms, project, status: await page.textContent('#status'), toast: await page.textContent('#toast') };
}

/** The app at `?query`, unless the page is there already (a part carrying on from the one before). */
async function ensurePage(query) {
  if (page.url().endsWith('/?' + query)) return;
  await page.goto(`http://127.0.0.1:${port}/?${query}`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
}

/**
 * The CPU scans later parts compare with (`cpuViolations`: flash.mp4,
 * `stripesViolations`: stripes.mp4), made here when the parts that make
 * them did not run.
 */
async function cpuReferences(keys) {
  if (keys.every((k) => results[k])) return;
  await ensurePage('cpu=1&auto=0');
  for (const [name, key] of [
    ['flash.mp4', 'cpuViolations'],
    ['stripes.mp4', 'stripesViolations'],
  ]) {
    if (results[key] || !keys.includes(key)) continue;
    await openFile(name);
    await scanCurrent();
    results[key] = await page.evaluate(() => window.__unflash.lastScan.result.violations);
    console.log(`CPU reference scan of ${name}:`, JSON.stringify(results[key]));
  }
}

try {
  // ======== the editing flow, CPU detector ==================================
  if (runs('editing')) {
  // ?auto=0: these flows press every button themselves
  await page.goto(`http://127.0.0.1:${port}/?cpu=1&auto=0`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
  results.support = await page.textContent('#support');
  console.log(results.support);

  await openFile('flash.mp4');
  results.videoInfo = await page.textContent('#videoInfo');
  results.status = await page.textContent('#status');
  console.log(results.videoInfo, '|', results.status);
  assert(results.status.includes('CPU'), 'with ?cpu=1 the detector must run on the CPU');

  // finish alerts: with no minimum wait, the scan's end beeps (headless
  // Chromium plays to no device, but the tone is made) and the tab title
  // follows the job while it runs
  await page.evaluate(() => {
    window.__unflash.setAlerts({ beep: true, after: 0, notify: false });
    window.__titles = [];
    new MutationObserver(() => window.__titles.push(document.title)).observe(document.querySelector('title'), { childList: true, subtree: true, characterData: true });
  });
  scan = await scanCurrent();
  results.cpuScan = scan;
  console.log('cpu scan:', scan.ms, 'ms |', scan.status, '|', scan.toast);
  await page.waitForFunction(() => window.__unflash.lastAlert, null, { timeout: 10000 });
  results.alert = await page.evaluate(() => ({ alert: window.__unflash.lastAlert, titles: window.__titles, title: document.title }));
  console.log('finish alert:', JSON.stringify(results.alert.alert), '| titles seen:', results.alert.titles.slice(0, 4).join(' / '), '… now:', results.alert.title);
  assert(results.alert.alert.ok && /scanning for flashes done/i.test(results.alert.alert.title), 'the scan ends with an alert: ' + JSON.stringify(results.alert.alert));
  assert(results.alert.alert.beeped, 'the alert beeps');
  assert(results.alert.titles.some((t) => /^\d+% · Scanning for flashes · Unflash$/.test(t)), 'the tab title shows the progress: ' + results.alert.titles.join(' / '));
  assert(results.alert.title === 'Unflash', 'the title is back to normal after the job (the tab is in front): ' + results.alert.title);
  await page.evaluate(() => window.__unflash.setAlerts({ after: 60 }));
  await page.screenshot({ path: path.join(OUT, '1-scanned.png') });
  const sections = await page.$$eval('#sectionList .sec-item', (els) => els.map((e) => e.textContent));
  console.log('sections:', sections);
  assert(sections.length === 1, 'the general flash (3-5.5 s) and the red flash (7-8.5 s) merge into one section (3 s merge gap)');
  assert(sections[0].includes('flash') && sections[0].includes('red flash'), 'the section must carry both kinds');
  results.cpuViolations = await page.evaluate(() => window.__unflash && window.__unflash.lastScan ? window.__unflash.lastScan.result.violations : null);
  assert(results.cpuViolations && results.cpuViolations.length >= 2, 'expected a general and a red violation: ' + JSON.stringify(results.cpuViolations));
  const gen = results.cpuViolations.find((v) => v.kind === 'flash');
  const red = results.cpuViolations.find((v) => v.kind === 'red');
  assert(gen && gen.start > 3.5 && gen.start < 4.6 && gen.end > 5.2 && gen.end < 5.8, 'general flash reported at 3.9-5.5 s: ' + JSON.stringify(gen));
  assert(red && red.start > 7.5 && red.start < 8.6 && red.end > 8.2 && red.end < 8.8, 'red flash reported at 7.9-8.5 s: ' + JSON.stringify(red));

  // --- open the section: it prepares itself and is checked --------------------
  t0 = Date.now();
  await openSectionPrepared();
  await verdictReady(page);
  results.prepareMs = Date.now() - t0;
  results.verdictBefore = await page.textContent('#wsVerdict');
  results.frameCount = await page.textContent('#frameCount');
  console.log('prepared in', results.prepareMs, 'ms; verdict:', results.verdictBefore, results.frameCount);
  // the frame on the section's very end gives it its length but is not one of
  // its own (the export shows it after the section): the grid stops before
  // it, and so do the count over the grid, Ctrl+A and the arrow keys
  {
    await page.click('#frameGrid .frame:nth-child(1)');
    await page.keyboard.press('Control+a');
    const grid = await page.evaluate(() => ({ tiles: document.querySelectorAll('#frameGrid .frame').length, nFrames: window.__unflash.currentSection().nFrames, count: document.querySelector('#frameCount').textContent, all: window.__unflash.state.selection.size }));
    await page.click('#frameGrid .frame:last-child');
    await page.keyboard.press('ArrowRight');
    grid.afterLast = await page.evaluate(() => [...window.__unflash.state.selection]);
    await page.keyboard.press('Escape');
    console.log('the grid:', JSON.stringify(grid));
    assert(grid.nFrames === grid.tiles + 1 && grid.count === `(${grid.tiles})` && grid.all === grid.tiles && JSON.stringify(grid.afterLast) === `[${grid.tiles - 1}]`, 'the count, Ctrl+A and the arrows keep to the frames in the grid: ' + JSON.stringify(grid));
  }
  // each frame says when it is in the whole video (as a verify of the export
  // gives it) and how far into the section; so do the findings and the verdict
  {
    const t = await page.evaluate(() => {
      const u = window.__unflash;
      const fmt = (x) => u.state.env.wasm.format_time(x);
      const sec = u.currentSection();
      const tile = document.querySelectorAll('#frameGrid .frame')[10];
      const v = sec.check.inside.find((x) => x.kind === 'flash');
      return {
        fv: tile.querySelector('.fv').textContent,
        ft: tile.querySelector('.ft').textContent,
        want: fmt(sec.start + sec.pts[10]),
        rel: (sec.pts[10] - sec.pts[0]).toFixed(3),
        title: tile.title,
        verdict: document.querySelector('#wsVerdict').textContent,
        flashAt: `flash at ${fmt(sec.start + sec.pts[0] + v.start)}, ${fmt(v.start)} into the section`,
        findings: document.querySelector('#wsFindings').textContent,
      };
    });
    console.log('frame 10:', t.fv, '/', t.ft, '| verdict:', t.verdict, '| findings:', t.findings.slice(0, 120));
    assert(t.fv === t.want && t.ft === t.rel && t.title.includes(`at ${t.want} in the video, ${t.rel} s into the section`), 'a frame shows its time in the video and in the section: ' + JSON.stringify(t));
    assert(t.verdict.includes(t.flashAt), `the verdict says when the flash is, in the video and in the section (${t.flashAt}): ${t.verdict}`);
    assert(/Flash, frames \d+–\d+ \(\d+:\d\d\.\d{3} – \d+:\d\d\.\d{3} in the video, \d+:\d\d\.\d{3} – \d+:\d\d\.\d{3} into the section, [\d.]+ s\)/.test(t.findings), 'the findings say when, in the video and in the section: ' + t.findings);
  }
  // a prepare cut into spans decoded side by side must give exactly what
  // one pass gives: the same pictures, times and pattern figures
  {
    const one = await page.evaluate(() => window.__unflash.prepareDigest(window.__unflash.currentSection().id, 1));
    const three = await page.evaluate(() => window.__unflash.prepareDigest(window.__unflash.currentSection().id, 3));
    console.log('prepare in 1 span:', one.frames, 'frames', Math.round(one.ms), 'ms | in', three.spans, 'spans:', three.frames, 'frames', Math.round(three.ms), 'ms');
    assert(one.spans === 1 && three.spans === 3, 'the prepares ran in 1 and 3 spans: ' + [one.spans, three.spans]);
    assert(one.frames > 100 && one.frames === three.frames && one.lead === three.lead && one.tail === three.tail, 'span prepare frame counts: ' + JSON.stringify([one.frames, one.lead, one.tail, three.frames, three.lead, three.tail]));
    assert(JSON.stringify(one.pts) === JSON.stringify(three.pts) && JSON.stringify(one.leadPts) === JSON.stringify(three.leadPts) && JSON.stringify(one.tailPts) === JSON.stringify(three.tailPts), 'span prepare times differ');
    assert(JSON.stringify(one.pattern) === JSON.stringify(three.pattern), 'span prepare pattern figures differ');
    assert(JSON.stringify(one.hash) === JSON.stringify(three.hash), 'span prepare pictures differ: ' + JSON.stringify([one.hash, three.hash]));
    results.spanPrepare = { one: one.ms, three: three.ms };
    // the section ends on a frame (the red flash's last, and the 1.5 s pad,
    // at 30 fps): that frame gives the section its length but is not one of
    // its own, and the export shows it straight after the section, so the
    // check's run-out must start with it, not with the frame after
    const length = await page.evaluate(() => {
      const s = window.__unflash.currentSection();
      return s.end - s.start;
    });
    console.log('section length', length.toFixed(6), '| last frame cached at', one.pts[one.pts.length - 1], '| run-out from', one.tailPts[0], one.tailPts[1]);
    assert(Math.abs(one.pts[one.pts.length - 1] - length) < 1e-6, "a frame sits on the section's end: " + JSON.stringify([length, one.pts.slice(-2)]));
    assert(Math.abs(one.tailPts[0] - length) < 1e-6 && one.tailPts[1] > length + 0.03, "the check's run-out starts with the frame on the section's end: " + JSON.stringify([length, one.tailPts.slice(0, 2)]));
    // a span that fails stops the others before its detectors and caches are
    // used again (the prepare goes on in one pass, on the first span's
    // detector): what comes out is exactly what one pass gives
    const failed = await page.evaluate(async () => {
      const u = window.__unflash;
      const spare = u.state.env.spares[0];
      spare.videoFrame = async (frame) => {
        frame.close();
        delete spare.videoFrame;
        throw new Error('span 1 failed (a test)');
      };
      try {
        return await u.prepareDigest(u.currentSection().id, 3);
      } finally {
        delete spare.videoFrame;
      }
    });
    console.log('a prepare whose second span fails:', failed.spans, 'span(s) in the end,', failed.frames, 'frames');
    const digest = (d) => JSON.stringify([d.frames, d.lead, d.tail, d.pts, d.leadPts, d.tailPts, d.pattern, d.hash]);
    assert(failed.spans === 1 && digest(failed) === digest(one), 'a prepare whose second span fails gives, in one pass, what one pass gives: ' + JSON.stringify([failed.frames, failed.lead, failed.tail, failed.hash, one.hash]));
    // the same for a scan in segments: the scan fails with the segment's
    // error once the others have stopped, and the next scan on the same
    // detector sees the file alone (a segment left running fed it its
    // pictures as well)
    const segments = await page.evaluate(async () => {
      const u = window.__unflash;
      const { scanMovie } = await import('./analysis.js');
      const env = u.state.env;
      const spare = env.spares[0];
      spare.videoFrame = async (frame) => {
        frame.close();
        delete spare.videoFrame;
        throw new Error('segment 1 failed (a test)');
      };
      let error = null;
      try {
        await scanMovie(env, u.state.movie, { segments: 3, forceSegments: true, moreFeeders: async (n) => env.spares.slice(0, n) });
      } catch (e) {
        error = e.message;
      } finally {
        delete spare.videoFrame;
      }
      const again = await scanMovie(env, u.state.movie, {});
      return { error, frames: again.frames, anomalies: again.result.anomalies, violations: again.result.violations };
    });
    console.log('a scan whose second segment fails:', segments.error, '| the scan after it:', segments.frames, 'frames,', segments.anomalies, 'timestamp anomalies');
    assert(segments.error === 'segment 1 failed (a test)', 'a scan whose segment fails says why: ' + segments.error);
    assert(segments.frames === 300 && segments.anomalies === 0 && JSON.stringify(segments.violations) === JSON.stringify(results.cpuViolations), 'and the scan after it is the scan of the file: ' + JSON.stringify(segments));
  }
  // bigger thumbnails, and one frame at full size
  {
    await page.click('.thumb-size [data-thumb="xl"]');
    const xl = await page.evaluate(() => ({ min: getComputedStyle(document.querySelector('#frameGrid')).getPropertyValue('--thumb-min').trim(), w: document.querySelector('#frameGrid .frame').offsetWidth, canvas: document.querySelector('#frameGrid .frame canvas').width }));
    await page.click('.thumb-size [data-thumb="m"]');
    const m = await page.evaluate(() => document.querySelector('#frameGrid .frame').offsetWidth);
    console.log('thumbnails: XL', JSON.stringify(xl), '| M', m);
    assert(xl.min === '320px' && xl.w >= 320 && xl.w > m && xl.canvas >= 400, 'XL thumbnails are bigger, and drawn bigger: ' + JSON.stringify(xl) + ' vs ' + m);
    await page.click('#frameGrid .frame:nth-child(11)');
    await page.keyboard.press('z');
    await page.waitForFunction(() => (window.__unflash.state.viewerDraws || []).some((d) => d.i === 10), null, { timeout: 30000 });
    const first = await page.evaluate(() => {
      const c = document.querySelector('#viewerCanvas');
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let k = 0; k < px.length; k += 4 * 97) sum += px[k];
      return { w: c.width, h: c.height, sum, info: document.querySelector('#viewerInfo').textContent, visible: !document.querySelector('#frameViewer').classList.contains('hidden') };
    });
    console.log('viewer:', JSON.stringify(first));
    assert(first.visible && first.w === 640 && first.h === 360 && first.sum > 0 && first.info.includes('frame 10 of'), 'the viewer shows frame 10 at the file\'s own size: ' + JSON.stringify(first));
    // five steps at key-repeat speed: the picture lands on frame 15, never faster than every 0.4 s
    await page.evaluate(() => (window.__unflash.state.viewerDraws = []));
    for (let k = 0; k < 5; k++) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => (window.__unflash.state.viewerDraws || []).some((d) => d.i === 15), null, { timeout: 30000 });
    const draws = await page.evaluate(() => window.__unflash.state.viewerDraws);
    const gaps = draws.slice(1).map((d, k) => d.t - draws[k].t);
    console.log('viewer steps drawn:', draws.map((d) => d.i).join(','), '| gaps', gaps.map((g) => Math.round(g)).join(','));
    assert(draws.length <= 3 && gaps.every((g) => g >= 380), 'stepping shows no more than a picture every 0.4 s: ' + JSON.stringify(draws));
    // marks go on the frame in view
    await page.keyboard.press('k');
    assert(await page.evaluate(() => (window.__unflash.currentSection().keep || []).includes(15)), 'K in the viewer keeps the frame in view');
    assert((await page.textContent('#viewerInfo')).includes('keep'), 'the viewer says so');
    await page.keyboard.press('k');
    assert(!(await page.evaluate(() => (window.__unflash.currentSection().keep || []).includes(15))), 'K again takes it off');
    await page.keyboard.press('Escape');
    const after = await page.evaluate(() => ({ hidden: document.querySelector('#frameViewer').classList.contains('hidden'), sel: [...window.__unflash.state.selection] }));
    assert(after.hidden && after.sel.length === 1 && after.sel[0] === 15, 'Esc closes the viewer and leaves frame 15 selected: ' + JSON.stringify(after));
    await page.keyboard.press('Escape');
    // closed while it decodes, a viewer stops, keeps none of the pictures
    // and says nothing (it used to throw, its pictures landing in the
    // emptied cache)
    const closed = await page.evaluate(async () => {
      const u = window.__unflash;
      const { FrameViewer } = await import('./viewer.js');
      const v = new FrameViewer(document.createElement('canvas'));
      v.show(u.state.movie, u.currentSection(), 10);
      // (as its timer would)
      const drawing = v.render();
      v.clear();
      let error = null;
      await drawing.catch((e) => (error = e.message));
      return { error, cached: v.cache.size };
    });
    console.log('the viewer closed while it decodes:', JSON.stringify(closed));
    assert(!closed.error && closed.cached === 0, 'a viewer closed while it decodes stops, keeps nothing and throws nothing: ' + JSON.stringify(closed));
  }
  assert(results.verdictBefore.startsWith('fails'), 'the flashing section must fail before editing');
  assert(results.verdictBefore.includes('red flash'), 'the red flash must be named: ' + results.verdictBefore);
  await page.screenshot({ path: path.join(OUT, '2-section.png'), fullPage: true });

  // --- mark frames by hand: the verdict updates on its own --------------------
  const nFrames = parseInt(results.frameCount.replace(/\D/g, ''), 10);
  const secStart = await page.evaluate(() => window.__unflash.currentSection().start);
  const f0 = Math.round((3.05 - secStart) * 30); // first frames of the flashing
  await page.click(`#frameGrid .frame:nth-child(${f0 + 1})`);
  await page.keyboard.down('Shift');
  await page.click(`#frameGrid .frame:nth-child(${f0 + 5})`);
  await page.keyboard.up('Shift');
  await page.keyboard.press('r');
  await page.waitForFunction((k) => document.querySelector(`#frameGrid .frame:nth-child(${k})`).classList.contains('removed'), f0 + 3);
  await page.waitForFunction(() => document.querySelector('#wsVerdict').textContent.includes('checking'), null, { timeout: 5000 }).catch(() => {});
  await verdictReady(page);
  results.verdictAfterMarks = await page.textContent('#wsVerdict');
  results.checkMs = await page.evaluate(() => window.__unflash.currentSection().checkMs);
  console.log('after 5 removals:', results.verdictAfterMarks, `(auto-check took ${results.checkMs.toFixed(0)} ms for ${nFrames} frames + context)`);
  assert(results.checkMs < 5000, 'the instant check must be quick');

  // --- a frame marked while a check or a suggestion runs is not lost ----------
  // (R pressed, or Check clicked, half way through the frames they feed the
  // detector, after they have read the marks; auto-check off, so that
  // nothing checks again by itself)
  {
    const during = (what) =>
      page.evaluate((what) => {
        const f = window.__unflash.state.env.feeder;
        const cached = f.cached;
        let n = 0;
        window.__pressed = false;
        f.cached = (...a) => {
          if (++n === 200) {
            delete f.cached;
            window.__pressed = true;
            if (what === 'check') document.querySelector('#btnCheck').click();
            else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
          }
          return cached.apply(f, a);
        };
      }, what);
    const marked = f0 + 9;
    const markOf = () => page.evaluate((i) => window.__unflash.currentSection().edits[i] || null, marked);
    await page.uncheck('#autoCheck');
    await page.click(`#frameGrid .frame:nth-child(${marked + 1})`);
    // the check judged the marks before: its verdict says they need checking again
    await during('r');
    await page.click('#btnCheck');
    await page.waitForFunction(() => window.__pressed && !window.__unflash.state.checkRunning, null, { timeout: 60000 });
    const checked = { verdict: await page.textContent('#wsVerdict'), stale: await page.evaluate(() => !!window.__unflash.currentSection().check.stale), mark: await markOf() };
    await page.keyboard.press('Control+z');
    // the suggestion was made from the marks before: it is not applied over the frame marked
    const edits = await page.evaluate(() => JSON.stringify(window.__unflash.currentSection().edits));
    await during('r');
    const toastNow = await page.textContent('#toast');
    await page.click('#btnSuggestFewest');
    await toastChange(toastNow);
    const suggested = { toast: await page.textContent('#toast'), mark: await markOf() };
    await page.keyboard.press('Control+z');
    suggested.undone = (await page.evaluate(() => JSON.stringify(window.__unflash.currentSection().edits))) === edits;
    // a check asked for as a suggestion runs checks the marks the suggestion
    // hands back, once they are in (taken before, they made its verdict stale)
    await during('check');
    await page.click('#btnSuggestFewest');
    await page.waitForFunction(() => window.__pressed && !window.__unflash.state.job && !window.__unflash.state.checkRunning, null, { timeout: 120000 });
    const asked = { verdict: await page.textContent('#wsVerdict'), stale: await page.evaluate(() => !!window.__unflash.currentSection().check.stale) };
    await page.keyboard.press('Control+z');
    asked.undone = (await page.evaluate(() => JSON.stringify(window.__unflash.currentSection().edits))) === edits;
    await page.check('#autoCheck');
    await page.click('#btnCheck');
    await verdictReady(page);
    console.log('marked while a check ran:', JSON.stringify(checked), '| while a suggestion ran:', JSON.stringify(suggested), '| a check asked for as a suggestion ran:', JSON.stringify(asked));
    assert(checked.mark && checked.mark.removed && checked.stale && checked.verdict === 'needs re-check', 'a check that ran as a frame was marked does not pass its verdict off as the marks\': ' + JSON.stringify(checked));
    assert(suggested.mark && suggested.mark.removed && suggested.undone && /^Suggesting \(fewest removals\): the section's marks changed while it ran, so its suggestion was not applied/.test(suggested.toast), 'a suggestion that ran as a frame was marked is not applied over the mark: ' + JSON.stringify(suggested));
    assert(!asked.stale && /^(passes|fails)/.test(asked.verdict) && asked.undone, "a check asked for as a suggestion ran judged the suggestion's marks: " + JSON.stringify(asked));
  }

  // --- cancelled part way, a suggestion and a prepare change nothing -----------
  {
    const section = () =>
      page.evaluate(async () => {
        const u = window.__unflash;
        const s = u.currentSection();
        const { sectionRenderPlan } = await import('./export.js');
        return JSON.stringify({ edits: s.edits, pts: s.pts.length, nFrames: s.nFrames, prepared: s.prepared, warnings: s.warnings, runOut: s.ctx && s.ctx.tailPts.length, shown: sectionRenderPlan(u.state.env, u.state.movie, s).nOut });
      });
    const before = await section();
    // a suggestion stops at its next check, and none of it is applied
    const suggesting = await cancelledJob(page, '#btnSuggestFewest');
    const afterSuggest = { section: await section(), toast: await page.textContent('#toast') };
    // "re-prepare", cancelled part way through the section's own frames (at
    // a quarter on the job bar: past the run-up, before the section's end),
    // stops at its next picture: the section keeps the frames its marks
    // were made on (cut short, the export would apply them to part of it and
    // leave the rest as it is)
    const preparing = await cancelledJob(page, '#btnReprepare', 25);
    const afterPrepare = { section: await section(), toast: await page.textContent('#toast') };
    console.log('cancelled:', afterSuggest.toast, '|', afterPrepare.toast);
    assert(afterSuggest.toast === `${suggesting}: cancelled` && afterSuggest.section === before, 'a cancelled suggestion is not applied: ' + JSON.stringify({ before, afterSuggest }));
    assert(afterPrepare.toast === `${preparing}: cancelled` && afterPrepare.section === before, 'a cancelled prepare leaves the section as it was: ' + JSON.stringify({ before, afterPrepare }));
    await noBanner(page);
  }
  // another video's open, cancelled part way (its index read, its project and
  // detectors under way), leaves the page as it was: this video, its section
  // and marks, and nothing of the other
  {
    const opened = () =>
      page.evaluate(() => {
        const u = window.__unflash;
        return JSON.stringify({ video: document.querySelector('#videoInfo').textContent, movie: u.state.movie.name, current: u.state.current, edits: u.currentSection().edits, sections: u.state.project.sections.length, profile: document.querySelector('#profileSel').value });
      });
    const before = await opened();
    await page.evaluate(() => {
      const u = window.__unflash;
      const watch = new MutationObserver(() => {
        const job = u.state.job;
        if (job && job.name === 'Opening video' && job.pct >= 36) {
          watch.disconnect();
          document.querySelector('#btnCancelJob').click();
        }
      });
      watch.observe(document.querySelector('#jobBar'), { attributes: true, attributeFilter: ['style'] });
    });
    await page.setInputFiles('#fileInput', path.join(MEDIA, 'steady.mp4'));
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Opening video: cancelled', null, { timeout: 60000 });
    await jobDone(page);
    const after = await opened();
    console.log('an open cancelled:', after === before ? 'the page as it was' : after);
    assert(after === before && !(await page.evaluate(() => window.__unflash.state.job)), 'an open cancelled part way leaves the video that was open: ' + JSON.stringify({ before, after }));
    await noBanner(page);
  }
  // a re-scan cancelled part way leaves nothing of what it saw: the timeline,
  // the chart and the monitor read the last whole scan's trace again
  {
    const scanning = await cancelledJob(page, '#btnScan', 30);
    const trace = await page.evaluate(() => {
      const u = window.__unflash;
      const n = u.state.traceNorm;
      return { toast: document.querySelector('#toast').textContent, frames: n ? n.t.length : 0, last: !!n && n.src === u.state.project.scan.trace };
    });
    console.log('a re-scan cancelled:', JSON.stringify(trace));
    assert(trace.toast === `${scanning}: cancelled` && trace.frames === 300 && trace.last, "a cancelled re-scan leaves the last scan's trace drawn: " + JSON.stringify(trace));
  }

  // --- let the suggester fix it ---------------------------------------------
  t0 = Date.now();
  const toast0 = await page.textContent('#toast');
  await page.click('#btnSuggestDark');
  await page.waitForFunction((t) => document.querySelector('#toast').textContent !== t || !document.querySelector('#banner').classList.contains('hidden'), toast0, { timeout: 300000 });
  await noBanner(page);
  await jobDone(page);
  await verdictReady(page);
  results.suggestMs = Date.now() - t0;
  results.verdictAfterSuggest = await page.textContent('#wsVerdict');
  results.toast = await page.textContent('#toast');
  console.log('suggest took', results.suggestMs, 'ms; verdict:', results.verdictAfterSuggest, '|', results.toast);
  assert(results.verdictAfterSuggest.startsWith('passes'), 'keep-dark must make the section pass');
  results.marks = await page.evaluate(() => Object.values(window.__unflash.currentSection().edits).filter((e) => e.removed).length);
  await page.screenshot({ path: path.join(OUT, '3-suggested.png'), fullPage: true });

  // --- fewest removals from scratch: passes with fewer frames gone ---------
  await page.click('#btnClearEdits');
  await verdictReady(page);
  const toastF = await page.textContent('#toast');
  await page.click('#btnSuggestFewest');
  await page.waitForFunction((t) => document.querySelector('#toast').textContent !== t || !document.querySelector('#banner').classList.contains('hidden'), toastF, { timeout: 300000 });
  await noBanner(page);
  await jobDone(page);
  await verdictReady(page);
  results.fewest = {
    verdict: await page.textContent('#wsVerdict'),
    toast: await page.textContent('#toast'),
    removed: await page.evaluate(() => Object.values(window.__unflash.currentSection().edits).filter((e) => e.removed).length),
  };
  console.log('fewest removals:', JSON.stringify(results.fewest), '| keep dark removed', results.marks);
  assert(results.fewest.verdict.startsWith('passes'), 'fewest removals makes the section pass: ' + results.fewest.verdict);
  assert(results.fewest.removed > 0 && results.fewest.removed < results.marks, `fewest removals takes out fewer frames than keep dark (${results.fewest.removed} vs ${results.marks})`);
  // where the picture would freeze, frames come back at the safe rate
  assert(/came back into \d+ long stretch(es)? where the picture would have frozen, 3\.8 a second/.test(results.fewest.toast), 'the fewest removals let frames back into the long stretch: ' + results.fewest.toast);
  // a suggestion's verdict is the check of the marks it hands back, not of the last marks it
  // tried: the fewest removals hand back an earlier set when a flash put back fails (a
  // suggester here that last tries no marks at all, which fail, then hands back ones that pass)
  results.suggestVerdict = await page.evaluate(async () => {
    const u = window.__unflash;
    const { suggestEdits } = await import('./analysis.js');
    const sec = u.currentSection();
    const env = u.state.env;
    const real = await suggestEdits(env, u.state.project, sec, 'fewest', null);
    class Tried {
      constructor() {
        this.n = 0;
      }
      thin_long_gaps() {}
      step() {
        return JSON.stringify(this.n++ === 0 ? { simulate: {} } : { done: { ...real, verdict: undefined } });
      }
      free() {}
    }
    const wasm = new Proxy(env.wasm, { get: (t, k) => (k === 'Suggester' ? Tried : t[k]) });
    const res = await suggestEdits({ ...env, wasm }, u.state.project, sec, 'fewest', null);
    return { real: real.verdict.safe, handedBack: res.verdict.safe, note: res.note };
  });
  assert(results.suggestVerdict.real && results.suggestVerdict.handedBack, "a suggestion's verdict is the check of the marks it hands back, not of the last it tried: " + JSON.stringify(results.suggestVerdict));

  // --- reduce FPS from scratch ---------------------------------------------
  await page.click('#btnClearEdits');
  await verdictReady(page);
  assert((await page.textContent('#wsVerdict')).startsWith('fails'), 'clearing the marks brings the flashing back');
  const toast1 = await page.textContent('#toast');
  await page.click('#btnSuggestFps');
  await page.waitForFunction((t) => document.querySelector('#toast').textContent !== t || !document.querySelector('#banner').classList.contains('hidden'), toast1, { timeout: 300000 });
  await noBanner(page);
  await jobDone(page);
  await verdictReady(page);
  results.fpsVerdict = await page.textContent('#wsVerdict');
  results.fpsToast = await page.textContent('#toast');
  console.log('reduce fps:', results.fpsVerdict, '|', results.fpsToast);
  assert(results.fpsVerdict.startsWith('passes'), 'thinning to the safe rate must pass');
  assert(results.fpsToast.includes('3.8/s'), 'the safe rate for the default profile is 3.8/s');
  // it starts at twice the safe rate and steps down: it keeps more pictures than the safe rate would
  results.fpsFound = await page.evaluate(() => window.__unflash.currentSection().fpsFound);
  assert(results.fpsFound > 3.8 && results.fpsFound <= 7.6, 'reduce FPS keeps the highest rate that passes, between the safe rate and twice it: ' + results.fpsFound);
  assert(/Thinned to 7\.6\/s|Tried 7\.6\/s/.test(results.fpsToast), 'reduce FPS tries twice the safe rate first: ' + results.fpsToast);
  const fpsMarks = await page.evaluate(() => JSON.stringify(window.__unflash.currentSection().edits));

  // --- a rate of your own, from the menu ---------------------------------------
  await page.click('#btnFpsMenu');
  await page.fill('#fpsInput', '3.8');
  let toastNow = await page.textContent('#toast');
  await page.click('#btnFpsExact');
  await toastChange(toastNow);
  await verdictReady(page);
  results.fpsExactToast = await page.textContent('#toast');
  assert(/^Thinned to 3\.8\/s/.test(results.fpsExactToast) && (await page.textContent('#wsVerdict')).startsWith('passes'), 'the menu thins to exactly the rate typed: ' + results.fpsExactToast);

  // --- R, F, E toggle their own mark; undo and redo -----------------------------
  const marksNow = () => page.evaluate(() => JSON.stringify(window.__unflash.currentSection().edits));
  const exactMarks = await marksNow();
  await page.click('#btnClearEdits');
  const g0 = f0 + 2;
  await page.click(`#frameGrid .frame:nth-child(${g0 + 1})`);
  await page.keyboard.down('Shift');
  await page.click(`#frameGrid .frame:nth-child(${g0 + 3})`);
  await page.keyboard.up('Shift');
  await page.click('#wsTitle'); // the keys work with the focus anywhere but a field
  const marksOf = () => page.evaluate((g) => [0, 1, 2].map((k) => { const e = window.__unflash.currentSection().edits[g + k]; return e ? (e.removed ? `R${e.fill === 'next' ? 'n' : 'p'}` : e.extended ? 'E' : '?') : '-'; }).join(','), g0);
  const seq = [];
  for (const key of ['r', 'r', 'f', 'r', 'e', 'e']) {
    await page.keyboard.press(key);
    seq.push(await marksOf());
  }
  results.toggles = seq;
  console.log('R R F R E E:', seq.join(' | '));
  assert(seq.join(' | ') === 'Rp,Rp,Rp | -,-,- | Rn,Rn,Rn | Rp,Rp,Rp | E,E,E | -,-,-', 'R/F/E put their mark on and take it off again: ' + seq.join(' | '));
  for (let k = 0; k < 6; k++) await page.keyboard.press('Control+z');
  assert((await marksOf()) === '-,-,-', 'undo steps back through every change');
  await page.keyboard.press('Control+z'); // the clear
  assert((await marksNow()) === exactMarks, 'undoing the clear brings the 3.8/s marks back');
  await page.keyboard.press('Control+z'); // the thinning to 3.8/s
  assert((await marksNow()) === fpsMarks, "and before them the searched rate's marks");
  await page.keyboard.press('Control+Shift+z');
  assert((await marksNow()) === exactMarks, 'redo takes the thinning to 3.8/s again');
  await verdictReady(page);
  assert((await page.textContent('#wsVerdict')).startsWith('passes'), 'the section passes again');

  // --- K keeps a frame out of the suggestions' reach ---------------------------
  await page.click('#btnClearEdits');
  const lum = await page.evaluate(() => window.__unflash.currentSection().check.stats.lum);
  let bright = f0;
  for (let i = f0; i < Math.min(lum.length, f0 + 30); i++) if (lum[i] > lum[bright]) bright = i;
  await page.click(`#frameGrid .frame:nth-child(${bright + 1})`);
  await page.keyboard.press('k');
  toastNow = await page.textContent('#toast');
  await page.click('#btnSuggestDark');
  await toastChange(toastNow);
  await verdictReady(page);
  results.keep = await page.evaluate((b) => ({ keep: window.__unflash.currentSection().keep, mark: window.__unflash.currentSection().edits[b] || null, tile: document.querySelector(`#frameGrid .frame:nth-child(${b + 1})`).classList.contains('kept') }), bright);
  results.keepVerdict = await page.textContent('#wsVerdict');
  console.log('keep frame', bright, JSON.stringify(results.keep), results.keepVerdict, '|', await page.textContent('#toast'));
  assert(results.keep.keep.includes(bright) && !(results.keep.mark && results.keep.mark.removed) && results.keep.tile, 'keep dark leaves the kept (bright) frame alone: ' + JSON.stringify(results.keep));
  assert(results.keepVerdict.startsWith('passes'), 'and still makes the section pass: ' + results.keepVerdict);

  // --- lower contrast: the flashing frames blended, none removed ---------------
  await page.click('#btnClearEdits'); // R, F, E and B marks go; the K mark stays
  await verdictReady(page);
  assert((await page.textContent('#wsVerdict')).startsWith('fails'), 'clearing the marks brings the flashing back');
  toastNow = await page.textContent('#toast');
  // what the section's own blend marks are at each step of the search (the
  // grid draws them, and a B pressed meanwhile saves them for undo): the
  // checks are handed the marks they try, and the section keeps its own
  const ownBlend = await page.evaluate(() => {
    const u = window.__unflash;
    const s = u.currentSection();
    const own = () => JSON.stringify([s.blend, s.blendStrength]);
    window.__blendSeen = new Set();
    window.__blendWatch = new MutationObserver(() => {
      if (u.state.job && u.state.job.name === 'Suggesting (blend frames)') window.__blendSeen.add(own());
    });
    window.__blendWatch.observe(document.querySelector('#jobBar'), { attributes: true, attributeFilter: ['style'] });
    return own();
  });
  await page.click('#btnSuggestBlend');
  await toastChange(toastNow);
  await verdictReady(page);
  {
    const seen = await page.evaluate(() => {
      window.__blendWatch.disconnect();
      return [...window.__blendSeen];
    });
    assert(seen.length > 0 && seen.every((x) => x === ownBlend), "a blend suggestion leaves the section's own marks alone while it searches: " + JSON.stringify({ ownBlend, seen: seen.slice(0, 3) }));
  }
  const blendState = () =>
    page.evaluate(() => {
      const s = window.__unflash.currentSection();
      const tiles = [...document.querySelectorAll('#frameGrid .frame.blended')];
      return {
        marks: (s.blend || []).length,
        strength: s.blendStrength,
        removed: Object.values(s.edits).filter((e) => e.removed).length,
        keep: s.keep,
        blend: s.blend,
        tiles: tiles.length,
        stale: tiles.filter((t) => t.dataset.drawn && t.dataset.drawnKey !== t.dataset.want).length,
        control: !document.querySelector('#blendWrap').classList.contains('hidden') && document.querySelector('#blendStrength').value,
      };
    });
  results.blend = await blendState();
  results.blendVerdict = await page.textContent('#wsVerdict');
  results.blendToast = await page.textContent('#toast');
  console.log('lower contrast:', JSON.stringify({ ...results.blend, blend: undefined }), results.blendVerdict, '|', results.blendToast);
  assert(results.blendVerdict.startsWith('passes'), 'lower contrast makes the section pass: ' + results.blendVerdict);
  assert(results.blend.marks > 0 && results.blend.removed === 0 && results.blend.tiles === results.blend.marks && results.blend.stale === 0, 'it blends frames and removes none: ' + JSON.stringify(results.blend));
  assert(results.blend.strength > 0 && results.blend.strength <= 1 && results.blend.control === String(Math.round(results.blend.strength * 100)), 'its strength shows in the control: ' + JSON.stringify(results.blend));
  assert(!results.blend.blend.includes(bright) && results.blend.keep.includes(bright), 'the kept frame is not blended');
  await page.screenshot({ path: path.join(OUT, '3-blended.png'), fullPage: true });
  // turned down to 5% the flashing is back; undo puts the strength back
  await page.$eval('#blendStrength', (el) => {
    el.value = '5';
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  });
  await verdictReady(page);
  results.blendWeak = await page.textContent('#wsVerdict');
  assert(results.blendWeak.startsWith('fails'), 'blended at 5% it fails: ' + results.blendWeak);
  await page.click('#wsTitle');
  await page.keyboard.press('Control+z');
  await verdictReady(page);
  assert((await page.evaluate(() => window.__unflash.currentSection().blendStrength)) === results.blend.strength && (await page.textContent('#wsVerdict')).startsWith('passes'), 'undo puts the strength back, and it passes');
  // B takes a frame's blend off and puts it back
  const b0 = results.blend.blend[0];
  await page.click(`#frameGrid .frame:nth-child(${b0 + 1})`);
  await page.keyboard.press('b');
  assert(!(await page.evaluate((i) => window.__unflash.currentSection().blend.includes(i), b0)), 'B on a blended frame takes it off');
  await page.keyboard.press('b');
  assert(await page.evaluate((i) => window.__unflash.currentSection().blend.includes(i), b0), 'B again puts it back');
  await page.keyboard.press('Escape');
  await verdictReady(page);

  // --- the section player plays the section with the marks applied -------------
  assert((await page.$eval('#playerSource', (s) => s.value)) === 'edited', 'with a section open the player shows it, edited');
  results.playerWarning = await page.textContent('#playerWarning');
  assert(/Section #\d+ with your marks: passes the check/.test(results.playerWarning), 'the player says what it shows: ' + results.playerWarning);
  await page.evaluate(() => {
    window.__slots = [];
    window.__blendedSlots = 0;
    const orig = window.__unflash.sectionPlayer.onFrame;
    window.__unflash.sectionPlayer.onFrame = (info, t, plan) => {
      window.__slots.push(info.slot);
      if (info.blended) window.__blendedSlots++;
      window.__playingTiles = Math.max(window.__playingTiles || 0, document.querySelectorAll('#frameGrid .frame.playing').length);
      orig(info, t, plan);
    };
    // when the grid's mark of the frame on screen moves
    window.__marks = [];
    new MutationObserver((ms) => {
      for (const m of ms) if (m.target.classList.contains('playing') && !/\bplaying\b/.test(m.oldValue || '')) window.__marks.push(performance.now());
    }).observe(document.querySelector('#frameGrid'), { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
  await page.keyboard.press('Escape'); // no selection: play from the start
  await page.click('#btnPreviewPlay');
  await page.waitForFunction(() => window.__unflash.sectionPlayer.active, null, { timeout: 10000 });
  await page.waitForFunction(() => !window.__unflash.sectionPlayer.active, null, { timeout: 120000 });
  results.play = await page.evaluate(() => ({ n: window.__slots.length, first: window.__slots[0], last: window.__slots[window.__slots.length - 1], inOrder: window.__slots.every((s, i, a) => i === 0 || s === a[i - 1] + 1), tiles: document.querySelectorAll('#frameGrid .frame').length, playing: document.querySelectorAll('#frameGrid .frame.playing').length, blended: window.__blendedSlots }));
  console.log('section player:', JSON.stringify(results.play));
  assert(results.play.first === 0 && results.play.last === results.play.tiles - 1 && results.play.inOrder, 'the section plays every frame of the section in order: ' + JSON.stringify(results.play));
  assert(results.play.blended === results.blend.marks, `the player shows the ${results.blend.marks} blended frames blended: ${results.play.blended}`);
  // the frame on screen is marked in the grid quietly: one tile at a time,
  // moved at most every 0.4 s (a mark running from tile to tile with every
  // picture would flicker across the grid)
  {
    const marks = await page.evaluate(() => window.__marks);
    const gaps = marks.slice(1).map((t, i) => Math.round(t - marks[i]));
    const tiles = await page.evaluate(() => window.__playingTiles);
    console.log('the grid mark moved', marks.length, 'times, gaps (ms):', gaps.join(' '));
    assert(marks.length >= 3 && gaps.every((g) => g >= 380) && tiles <= 1, 'the mark of the frame on screen moves at most every 0.4 s: ' + JSON.stringify({ gaps, tiles }));
  }
  await page.evaluate(() => (window.__unflash.sectionPlayer.onFrame = null));

  // --- the guide opens beside the work and closes again -------------------------
  await page.click('#btnHome');
  const guideOpen = await page.evaluate(() => ({ guide: getComputedStyle(document.querySelector('#welcome')).display, stage: getComputedStyle(document.querySelector('#stage')).display }));
  assert(guideOpen.guide !== 'none' && guideOpen.stage !== 'none', 'the guide opens beside the work, which stays: ' + JSON.stringify(guideOpen));
  await page.click('#sectionList .sec-item');
  assert(!(await page.$eval('#workspace', (w) => w.classList.contains('hidden'))), 'a section opens while the guide is open');
  await page.keyboard.press('Escape');
  assert((await page.evaluate(() => getComputedStyle(document.querySelector('#welcome')).display)) === 'none', 'Esc closes the guide');

  // --- export and verify -----------------------------------------------------
  await page.click('#btnExport');
  await page.waitForSelector('#exportModal', { state: 'visible' });
  results.exportCodecs = await page.$$eval('#exportCodec option', (o) => o.map((x) => x.textContent));
  console.log('encoders:', results.exportCodecs);
  assert(results.exportCodecs.length >= 1, 'an encoder must be available');
  // what it is saved as: the video's name with .unflashed, or a name typed in, made fit for a file
  results.exportName = await page.inputValue('#exportName');
  assert(/\.unflashed\.mp4$/.test(results.exportName) && (await page.textContent('#exportWhere')).length > 20, 'the dialog names the file, and says where it goes: ' + results.exportName);
  await page.fill('#exportName', ' my: export?/final ');
  await page.press('#exportName', 'Tab');
  assert((await page.inputValue('#exportName')) === 'my export final.mp4', 'a name typed in is made fit for a file: ' + (await page.inputValue('#exportName')));
  t0 = Date.now();
  await page.click('#btnDoExport');
  await jobStarted(page);
  await jobDone(page, 600000);
  results.exportMs = Date.now() - t0;
  try {
    await page.waitForFunction(() => !document.querySelector('#btnVerifyExport').disabled, null, { timeout: 30000 });
  } catch (e) {
    const diag = await page.evaluate(() => ({ banner: document.querySelector('#bannerText').textContent, bannerHidden: document.querySelector('#banner').classList.contains('hidden'), result: document.querySelector('#exportResult').textContent, modalHidden: document.querySelector('#exportModal').classList.contains('hidden') }));
    await page.screenshot({ path: path.join(OUT, 'export-failure.png') });
    throw new Error('export did not produce a file: ' + JSON.stringify(diag));
  }
  results.exportResult = await page.textContent('#exportResult');
  console.log('export:', results.exportMs, 'ms;', results.exportResult);
  // VP9 into VP9: the GOPs the sections leave alone are copied, not re-encoded
  assert(/(\d+) copied from the source/.test(results.exportResult) && +results.exportResult.match(/(\d+) copied from the source/)[1] > 0, 'the export copies the untouched GOPs: ' + results.exportResult);
  assert(/(\d+) re-encoded/.test(results.exportResult) && +results.exportResult.match(/(\d+) re-encoded/)[1] > 0, 'and re-encodes the sections: ' + results.exportResult);
  assert(new RegExp(`; ${results.blend.marks} blended`).test(results.exportResult), `the export blends the ${results.blend.marks} frames marked B: ` + results.exportResult);
  const exported = await page.evaluate(async () => {
    const a = document.querySelector('#exportDownload');
    const blob = await (await fetch(a.href)).blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  fs.writeFileSync(path.join(OUT, 'exported.mp4'), Buffer.from(exported, 'base64'));
  // and it downloads under that name
  const [saved] = await Promise.all([page.waitForEvent('download'), page.click('#exportDownload')]);
  assert(saved.suggestedFilename() === 'my export final.mp4', 'the export downloads under the name typed: ' + saved.suggestedFilename());
  // a verify cancelled part way says nothing of the file: it saw part of it
  {
    const before = await page.textContent('#exportResult');
    const verifying = await cancelledJob(page, '#btnVerifyExport');
    await page.waitForFunction(() => !document.querySelector('#exportModal').classList.contains('hidden'));
    const after = { result: await page.textContent('#exportResult'), toast: await page.textContent('#toast') };
    console.log('verify cancelled:', after.toast);
    assert(after.toast === `${verifying}: cancelled` && after.result === before, 'a cancelled verify gives no verdict: ' + JSON.stringify({ before, after }));
    await noBanner(page);
  }
  t0 = Date.now();
  await page.click('#btnVerifyExport');
  await jobStarted(page);
  await jobDone(page, 600000);
  results.verifyMs = Date.now() - t0;
  results.verify = await page.textContent('#exportResult');
  console.log('verify:', results.verifyMs, 'ms;', results.verify);
  assert(results.verify.includes('Passes WCAG'), 'the exported file must pass WCAG');
  // the debug report tells how the check went, as it does for the scan, and how far apart the keyframes are
  {
    const report = await page.evaluate(() => window.__unflash.debugReport());
    assert(/\nVerify\s+[\d,]+ frames in [\d.]+ s = \d+ fps/.test(report) && /keyframes every [\d.]+ s/.test(report), 'the debug report has the check of the export:\n' + report);
  }
  await page.screenshot({ path: path.join(OUT, '4-export.png') });
  await page.click('#btnCloseExport');
  // a file whose check still finds flashing (the video itself here, as if its
  // export had kept it): the verify says which section each problem is in,
  // and the section opens with the frames on screen during it selected
  {
    await page.setInputFiles('#verifyFileInput', path.join(MEDIA, 'flash.mp4'));
    await jobStarted(page);
    await jobDone(page, 600000);
    await page.waitForFunction(() => /flash\.mp4: .*re-scanned/.test(document.querySelector('#exportResult').textContent), null, { timeout: 30000 });
    const found = await page.evaluate(() => ({
      text: document.querySelector('#exportResult').textContent.split('flash.mp4: ').pop(),
      buttons: [...document.querySelectorAll('#exportResult button[data-open-at]')].map((b) => b.textContent),
    }));
    console.log('verify of a file that still flashes:', found.text);
    assert(/Fails WCAG/.test(found.text) && /flash \d+:\d\d\.\d{3}–\d+:\d\d\.\d{3} in section #1/.test(found.text) && found.buttons.includes('section #1'), 'the verify says which section the flash is in: ' + JSON.stringify(found));
    await page.click('#exportResult button[data-open-at]');
    await page.waitForFunction(() => document.querySelector('#exportModal').classList.contains('hidden') && window.__unflash.state.selection.size > 0, null, { timeout: 60000 });
    const sel = await page.evaluate(() => {
      const u = window.__unflash;
      const sec = u.currentSection();
      const s = [...u.state.selection].sort((a, b) => a - b);
      return { n: s.length, first: sec.start + sec.pts[s[0]], last: sec.start + sec.pts[s[s.length - 1]], toast: document.querySelector('#toast').textContent };
    });
    console.log('opened from the verify:', JSON.stringify(sel));
    // (the general flash is found at 3.9-5.5 s)
    assert(sel.n > 20 && sel.first > 3.4 && sel.first < 4.6 && sel.last > 5.1 && sel.last < 5.8 && /where the check of the export found the flash/.test(sel.toast), 'the section opens with the flashing frames selected: ' + JSON.stringify(sel));
    // a held frame puts off everything after it in an export: its times, taken back to the video's
    const back = await page.evaluate(() => {
      const f = window.__unflash.exportToVideo;
      const holds = [{ at: 10, seconds: 1 }];
      return [f(5, 6, holds), f(12, 12.5, holds), f(10.5, 10.6, holds)].map((w) => [+w.lo.toFixed(3), +w.hi.toFixed(3)]);
    });
    assert(JSON.stringify(back) === JSON.stringify([[5, 6], [11, 11.5], [9.999, 9.999]]), 'export times go back to the video by the holds before them: ' + JSON.stringify(back));
    await page.keyboard.press('Escape');
  }

  // --- the live monitor on the original -------------------------------------
  await page.selectOption('#playerSource', 'video');
  await page.check('#liveToggle');
  await page.evaluate(() => {
    const v = document.querySelector('#player');
    v.muted = true;
    v.currentTime = 2.0;
    return v.play();
  });
  const seen = new Set();
  const until = Date.now() + 8000;
  // (watching until it reports the flashing, eight seconds at most: "flashing:
  // general flash", "1 violation so far"; "no flashing so far" is not it)
  const reported = (set) => [...set].some((s) => /^flashing:|violations? so far/.test(s));
  while (Date.now() < until && !reported(seen)) {
    seen.add(await page.textContent('#liveVerdict'));
    await page.waitForTimeout(200);
  }
  results.liveVerdicts = [...seen];
  results.hud = await page.textContent('#hudInfo');
  console.log('live verdicts seen:', results.liveVerdicts, '|', results.hud);
  assert(reported(seen), 'the live monitor must report the flashing while it plays: ' + JSON.stringify([...seen]));
  // a scan of this file exists, so the meter reads it instead of detecting again
  assert(/from the scan/.test(results.hud), 'after a scan the monitor reads the scan trace: ' + results.hud);
  await page.screenshot({ path: path.join(OUT, '5-live.png') });
  // the monitor goes on across new detectors (the old ones freed under its
  // loop): another video opened as this one plays (none of it scanned, so
  // the monitor detects on it), and another profile chosen as that one plays
  {
    const play = () =>
      page.evaluate(() => {
        const v = document.querySelector('#player');
        v.muted = true;
        v.currentTime = 0;
        return v.play();
      });
    // (what the monitor says as it detects, cleared first: a count from its loop now)
    const watching = async () => {
      await page.evaluate(() => (document.querySelector('#hudInfo').textContent = ''));
      await page.waitForFunction(() => {
        const m = /^(\d+) frames watched/.exec(document.querySelector('#hudInfo').textContent);
        return m && +m[1] > 5;
      }, null, { timeout: 30000 });
    };
    const profile = async (name) => {
      await page.evaluate(() => (document.querySelector('#toast').textContent = ''));
      await page.selectOption('#profileSel', name);
      await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Profile changed'), null, { timeout: 30000 });
    };
    await page.setInputFiles('#fileInput', path.join(MEDIA, 'steady.mp4'));
    await page.waitForFunction(() => document.querySelector('#videoInfo').textContent.includes('steady.mp4'), null, { timeout: 60000 });
    await jobDone(page);
    await play();
    await watching();
    await profile('wcag');
    await play();
    await watching();
    results.liveAcross = await page.textContent('#hudInfo');
    console.log('the monitor after a new video and a new profile:', results.liveAcross);
    // (back as it was: the default profile, and the first video open)
    await profile('wcag_ext');
    await openFile('flash.mp4');
    await jobDone(page);
  }
  await page.uncheck('#liveToggle');
  await page.evaluate(() => document.querySelector('#player').pause());

  }

  // ======== more files: steady, extended, red flash, stripes, the built-in decoder
  if (runs('files')) {
  await cpuReferences(['cpuViolations']);
  await ensurePage('cpu=1&auto=0');
  // --- a steady file passes; an extended flash is flagged only by the default profile
  await openFile('steady.mp4');
  scan = await scanCurrent();
  console.log('steady:', scan.toast);
  assert(scan.toast.includes('No flashing'), 'the steady file must be clean');

  // --- bursts that each fail by themselves: the fewest removals try putting
  // some back, which fails, and hand back the removal that took every one
  // out; the verdict is the check of that, and passes (it was the check of
  // the last try, which failed, under a message saying it passed)
  await openFile('bursts.mp4');
  scan = await scanCurrent();
  await openSectionPrepared();
  await verdictReady(page);
  {
    const before = await page.textContent('#toast');
    await page.click('#btnSuggestFewest');
    await toastChange(before);
    await verdictReady(page);
    results.bursts = { toast: await page.textContent('#toast'), verdict: await page.textContent('#wsVerdict') };
    console.log('bursts, the fewest removals:', JSON.stringify(results.bursts));
    assert(/every flash had to go \(putting any back failed the check\)/.test(results.bursts.toast) && /^passes/.test(results.bursts.verdict), 'every burst taken out: the verdict agrees with the message: ' + JSON.stringify(results.bursts));
  }

  await openFile('extended.mp4');
  scan = await scanCurrent();
  results.extendedSections = await page.$$eval('#sectionList .sec-item', (els) => els.map((e) => e.textContent));
  console.log('extended (wcag_ext):', results.extendedSections);
  assert(results.extendedSections.some((s) => s.includes('extended flash')), 'the 3 Hz file must produce an extended-flash section under the default profile');
  // the report ends where the flashing does (9 s), not a second on, where
  // each moment's hold (which joins moments a second apart) runs out
  const extViol = await page.evaluate(() => window.__unflash.lastScan.result.violations.filter((v) => v.kind === 'extended'));
  assert(extViol.length === 1 && extViol[0].end > 8.9 && extViol[0].end < 9.4, 'the extended flash ends with its last flash: ' + JSON.stringify(extViol));
  // cut in two by hand at 5 s: the second half's own flashing goes on from
  // the first half's, and its finding says so; once none of its frames
  // flash, the flashing before it is the first half's to fix, not its own
  page.once('dialog', (d) => d.accept());
  await page.click('#btnDeleteAll');
  const addByHand = async (a, b) => {
    await page.fill('#addStart', String(a));
    await page.fill('#addEnd', String(b));
    await page.click('#btnAddSection');
    await page.waitForFunction((a) => { const s = window.__unflash.currentSection(); return s && Math.abs(s.start - a) < 1e-6 && s.prepared; }, a, { timeout: 120000 });
    await jobDone(page);
    await verdictReady(page);
  };
  await addByHand(0, 5);
  await addByHand(5, 10);
  const firstHalf = await page.evaluate(() => window.__unflash.state.project.sections.find((s) => s.start === 0).id);
  const halfFindings = () => page.$$eval('#wsFindings .finding', (els) => els.map((e) => ({ run: e.classList.contains('run-up'), text: e.textContent })));
  results.extendedSecondHalf = await halfFindings();
  console.log('extended, second half:', JSON.stringify(results.extendedSecondHalf));
  assert(results.extendedSecondHalf.length === 1 && !results.extendedSecondHalf[0].run && results.extendedSecondHalf[0].text.includes(`starts 3.0 s before this section, in section #${firstHalf}`), 'the second half\'s extended flash says where it starts: ' + JSON.stringify(results.extendedSecondHalf));
  const halfFrames = await page.evaluate(() => window.__unflash.currentSection().nFrames);
  await page.evaluate((n) => {
    const u = window.__unflash;
    u.state.selection = new Set(Array.from({ length: n - 1 }, (_, i) => i));
  }, halfFrames);
  await page.keyboard.press('r');
  await page.waitForFunction((n) => Object.values(window.__unflash.currentSection().edits || {}).filter((e) => e.removed).length === n - 1, halfFrames, { timeout: 30000 });
  await page.waitForFunction(() => { const c = window.__unflash.currentSection().check; return c && !c.stale; }, null, { timeout: 60000 });
  await verdictReady(page);
  results.extendedHalfCleared = { verdict: await page.textContent('#wsVerdict'), findings: await halfFindings() };
  console.log('extended, second half with none of its frames flashing:', JSON.stringify(results.extendedHalfCleared));
  assert(results.extendedHalfCleared.verdict === 'passes' && results.extendedHalfCleared.findings.length === 1 && results.extendedHalfCleared.findings[0].run && results.extendedHalfCleared.findings[0].text.includes(`up to its first picture, in section #${firstHalf}`), 'flashing that only reaches its first picture is the section before\'s: ' + JSON.stringify(results.extendedHalfCleared));
  await page.click(`#wsFindings button[data-open-section="${firstHalf}"]`);
  await page.waitForFunction((id) => window.__unflash.currentSection().id === id, firstHalf, { timeout: 5000 });
  const checked = () => page.waitForFunction(() => { const u = window.__unflash; const c = u.currentSection() && u.currentSection().check; return c && !c.stale && !u.state.checkRunning; }, null, { timeout: 120000 });
  await checked();
  const secondHalf = await page.evaluate((id) => window.__unflash.state.project.sections.find((s) => s.id !== id).id, firstHalf);
  // a check that ends after another section was opened leaves that section's
  // verdict and findings on the page (it used to draw its own there)
  {
    const area = () => page.evaluate(() => JSON.stringify({ verdict: document.querySelector('#wsVerdict').textContent, findings: document.querySelector('#wsFindings').textContent }));
    const first = await area();
    await page.evaluate((other) => {
      const v = document.querySelector('#wsVerdict');
      const watch = new MutationObserver(() => {
        if (v.textContent !== 'checking…') return;
        watch.disconnect();
        // (the first half's check under way: the second half opened from the list)
        [...document.querySelectorAll('#sectionList .sec-item')].find((el) => el.textContent.startsWith(`#${other} `)).click();
        window.__opened = JSON.stringify({ verdict: v.textContent, findings: document.querySelector('#wsFindings').textContent });
      });
      watch.observe(v, { childList: true, characterData: true, subtree: true });
      window.__opened = null;
      document.querySelector('#btnCheck').click();
    }, secondHalf);
    await page.waitForFunction(() => window.__opened && !window.__unflash.state.checkRunning, null, { timeout: 60000 });
    const opened = await page.evaluate(() => window.__opened);
    const shown = await area();
    console.log('a check that ended after another section was opened:', JSON.stringify({ first, opened, shown }));
    assert(first !== opened && shown === opened, "the section open keeps its own verdict and findings when another's check ends: " + JSON.stringify({ first, opened, shown }));
  }
  // Check all and Prepare all end at a cancel: the sections after the one
  // cancelled are left as they were
  {
    await page.evaluate(() => window.__unflash.state.project.sections.forEach((s) => (s.check.stale = true)));
    // (a check job says nothing as it goes: the cancel comes with the click)
    const checking = await page.evaluate(() => {
      document.querySelector('#btnCheckAll').click();
      const name = window.__unflash.state.job.name;
      document.querySelector('#btnCancelJob').click();
      return name;
    });
    await page.waitForFunction((name) => document.querySelector('#toast').textContent === `${name}: cancelled`, checking, { timeout: 60000 });
    await jobDone(page);
    const stale = await page.evaluate(() => window.__unflash.state.project.sections.map((s) => s.check.stale));
    await page.evaluate(async () => {
      const { dropCaches } = await import('./project.js');
      window.__unflash.state.project.sections.forEach(dropCaches);
    });
    const preparing = await cancelledJob(page, '#btnPrepareAll', 10);
    const prepared = await page.evaluate(() => window.__unflash.state.project.sections.map((s) => s.prepared));
    console.log('Check all cancelled:', JSON.stringify(stale), '| Prepare all cancelled:', preparing, JSON.stringify(prepared));
    assert(stale.length === 2 && stale.every((x) => x), 'Check all ends at a cancel: ' + JSON.stringify(stale));
    assert(prepared.length === 2 && prepared.every((x) => !x), 'Prepare all ends at a cancel: ' + JSON.stringify(prepared));
    // and goes through both, uncancelled
    await page.click('#btnPrepareAll');
    await page.waitForFunction(() => window.__unflash.state.project.sections.every((s) => s.prepared) && !window.__unflash.state.job, null, { timeout: 120000 });
    await checked();
  }
  // another range is another section: what was made on its frames goes with
  // them (its K marks and its undo history too), and the check of the
  // section next to it, which read its edge, is stale (they all stayed)
  {
    const open = (id) => page.evaluate((id) => [...document.querySelectorAll('#sectionList .sec-item')].find((el) => el.textContent.startsWith(`#${id} `)).click(), id);
    await open(firstHalf);
    await checked();
    await page.click('#frameGrid .frame:nth-child(1)');
    await page.keyboard.press('k');
    await page.click('#frameGrid .frame:nth-child(2)');
    await page.keyboard.press('r');
    await checked();
    // (the second half checked after those marks: its check is not stale yet)
    await open(secondHalf);
    await checked();
    await open(firstHalf);
    await page.fill('#secEnd', '4.5');
    await page.click('#btnApplyRange');
    await page.waitForFunction(() => window.__unflash.currentSection().end === 4.5, null, { timeout: 30000 });
    const ranged = await page.evaluate((other) => {
      const u = window.__unflash;
      const s = u.currentSection();
      return { keep: s.keep, edits: s.edits, history: u.state.history.has(s.id), nextStale: !!u.state.project.sections.find((o) => o.id === other).check.stale };
    }, secondHalf);
    console.log('a section given another range:', JSON.stringify(ranged));
    assert(!ranged.keep.length && !Object.keys(ranged.edits).length && !ranged.history && ranged.nextStale, "another range leaves none of the section's marks or history, and its neighbour's check stale: " + JSON.stringify(ranged));
    // (the second half open and checked again, for what follows)
    await open(secondHalf);
    await checked();
  }
  // every section deleted while a check runs: their frames are freed once it
  // is done (freed under it, they were "null pointer passed to rust")
  {
    await page.evaluate(() => {
      const f = window.__unflash.state.env.feeder;
      const cached = f.cached;
      let n = 0;
      f.cached = (...a) => {
        if (++n === 100) {
          delete f.cached;
          document.querySelector('#btnDeleteAll').click();
        }
        return cached.apply(f, a);
      };
    });
    page.once('dialog', (d) => d.accept());
    await page.click('#btnCheck');
    await page.waitForFunction(() => document.querySelectorAll('#sectionList .sec-item').length === 1 && !window.__unflash.state.checkRunning, null, { timeout: 60000 });
    await noBanner(page);
  }
  await page.selectOption('#profileSel', 'wcag');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Profile changed'), null, { timeout: 30000 });
  scan = await scanCurrent();
  console.log('extended (wcag):', scan.toast);
  assert(scan.toast.includes('No flashing'), 'under exact WCAG the 3 Hz file passes');

  // --- red flash with no luminance change: a red-flash failure (and, kept up
  // for six seconds, an extended flash under the default profile), never a
  // general flash
  await openFile('redflash.mp4');
  scan = await scanCurrent();
  results.redflashViolations = await page.evaluate(() => window.__unflash.lastScan.result.violations);
  console.log('redflash scan:', scan.ms, 'ms |', scan.toast, '|', JSON.stringify(results.redflashViolations));
  const redViol = results.redflashViolations.filter((v) => v.kind === 'red');
  assert(redViol.length === 1 && !results.redflashViolations.some((v) => v.kind === 'flash'), 'the equiluminant red flash is a red-flash failure and not a general one: ' + JSON.stringify(results.redflashViolations));
  // the swaps start at 2 s; the fourth flash inside a second lands under a second later
  assert(redViol[0].start > 2.4 && redViol[0].start < 3.1 && redViol[0].end > 7.4, 'the red flash runs from 2 s to the end: ' + JSON.stringify(redViol));
  page.once('dialog', (d) => d.accept());
  await page.click('#btnDeleteAll');
  await page.waitForFunction(() => document.querySelectorAll('#sectionList .sec-item').length === 1);

  // --- stripes: a stationary pattern with no flashing; softening fixes it ------
  await openFile('stripes.mp4');
  assert((await page.$eval('#profileSel', (s) => s.value)) === 'wcag_ext', 'a new file starts on the default profile');
  scan = await scanCurrent();
  results.stripesScan = scan;
  console.log('stripes scan:', scan.ms, 'ms |', scan.toast);
  results.stripesViolations = await page.evaluate(() => window.__unflash.lastScan.result.violations);
  console.log('stripes violations:', JSON.stringify(results.stripesViolations));
  const pats = results.stripesViolations.filter((v) => v.kind === 'pattern');
  assert(pats.length >= 1 && pats.length === results.stripesViolations.length, 'the stripes file has pattern violations and nothing else');
  assert(pats[0].start > 1.8 && pats[0].start < 2.6 && pats[pats.length - 1].end > 8.5 && pats[pats.length - 1].end < 9.4, 'the pattern runs from 2 s to 9 s: ' + JSON.stringify(pats));
  results.stripesSections = await page.$$eval('#sectionList .sec-item', (els) => els.map((e) => e.textContent));
  assert(results.stripesSections.length === 1 && results.stripesSections[0].includes('stripes'), 'one section, labeled stripes: ' + JSON.stringify(results.stripesSections));
  await openSectionPrepared();
  await verdictReady(page);
  results.stripesVerdict = await page.textContent('#wsVerdict');
  results.softenNote = await page.textContent('#softenNote');
  console.log('stripes verdict:', results.stripesVerdict, '| soften:', results.softenNote);
  assert(results.stripesVerdict === 'passes WCAG, stripes remain', 'a pattern is not a WCAG failure but is reported: ' + results.stripesVerdict);
  assert(!(await page.$eval('#softenWrap', (e) => e.classList.contains('hidden'))), 'the soften switch is offered');
  assert(/\d+ of \d+ frames · blur/.test(results.softenNote), 'the switch says what it would blur: ' + results.softenNote);
  const flaggedPat = await page.$$eval('#frameGrid .frame.flagged-pat', (els) => els.length);
  assert(flaggedPat > 60, 'the patterned frames are marked in the grid: ' + flaggedPat);
  await page.check('#softenToggle');
  await page.waitForFunction(
    () => {
      const s = window.__unflash.currentSection();
      return s.check && !s.check.stale && s.check.soften === true && !document.querySelector('#wsVerdict').textContent.includes('checking');
    },
    null,
    { timeout: 120000 }
  );
  results.softVerdict = await page.textContent('#wsVerdict');
  results.softFrames = await page.evaluate(() => window.__unflash.currentSection().check.soft_frames.length);
  console.log('after soften:', results.softVerdict, '|', results.softFrames, 'frames softened');
  assert(results.softVerdict === 'passes', 'softening the stripes makes the section pass: ' + results.softVerdict);
  assert(results.softFrames > 60, 'the frames with stripes are softened');
  await page.screenshot({ path: path.join(OUT, '7-stripes.png'), fullPage: true });
  await page.click('#btnExport');
  await page.waitForSelector('#exportModal', { state: 'visible' });
  results.stripesPlan = await page.textContent('#exportPlan');
  assert(results.stripesPlan.includes('softened'), 'the export plan mentions the softening: ' + results.stripesPlan);
  t0 = Date.now();
  await page.click('#btnDoExport');
  await jobStarted(page);
  await jobDone(page, 600000);
  await page.waitForFunction(() => !document.querySelector('#btnVerifyExport').disabled, null, { timeout: 30000 });
  results.stripesExport = await page.textContent('#exportResult');
  console.log('stripes export:', Date.now() - t0, 'ms;', results.stripesExport);
  assert(/softened/.test(results.stripesExport), 'the export reports the softened frames: ' + results.stripesExport);
  await page.click('#btnVerifyExport');
  await jobStarted(page);
  await jobDone(page, 600000);
  results.stripesVerify = await page.textContent('#exportResult');
  console.log('stripes verify:', results.stripesVerify);
  assert(results.stripesVerify.includes('Passes WCAG') && results.stripesVerify.includes('No hazardous stripe patterns'), 'the softened export has no stripes left: ' + results.stripesVerify);
  await page.click('#btnCloseExport');

  // --- H.264 in a browser without H.264: the built-in decoder takes over ------
  await openFile('flash_h264.mp4');
  results.h264 = { scanDisabled: await page.$eval('#btnScan', (b) => b.disabled), banner: await page.textContent('#bannerText'), status: await page.textContent('#status') };
  console.log('h264:', results.h264);
  const h264Decodable = await page.evaluate(() => VideoDecoder.isConfigSupported({ codec: 'avc1.42C01E', codedWidth: 64, codedHeight: 64 }).then((r) => r.supported));
  if (!h264Decodable) {
    assert(!results.h264.scanDisabled && results.h264.banner.includes('built-in H.264 decoder') && results.h264.status.includes('built-in H.264'), 'without an H.264 decoder the built-in one is used: ' + JSON.stringify(results.h264));
    assert(await page.$eval('#liveToggle', (b) => b.disabled), 'the live monitor is off when the player cannot play the file');
  }
  scan = await scanCurrent();
  results.h264Scan = scan;
  results.h264Violations = await page.evaluate(() => window.__unflash.lastScan.result.violations);
  results.h264Route = await page.evaluate(() => window.__unflash.state.env.feeder.route);
  if (!h264Decodable) assert(results.h264Route === 'raw', 'the built-in decoder hands its I420 pictures straight to the detector: ' + results.h264Route);
  console.log('h264 scan:', scan.ms, 'ms |', scan.toast, '|', JSON.stringify(results.h264Violations));
  assert(results.h264Violations.length === results.cpuViolations.length, 'the H.264 copy of the flash clip has the same violations as the VP9 one');
  for (let i = 0; i < results.h264Violations.length; i++) {
    const a = results.h264Violations[i];
    const b = results.cpuViolations[i];
    // a different encoder, so the edges of the flashing may land a frame apart
    assert(a.kind === b.kind && Math.abs(a.start - b.start) < 0.15 && Math.abs(a.end - b.end) < 0.15, `H.264 violation ${i} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  // an interlaced (MBAFF) H.264 copy of the same clip through the built-in decoder
  if (!h264Decodable) {
    await openFile('flash_h264i.mp4');
    assert((await page.textContent('#status')).includes('built-in H.264'), 'the interlaced clip is decoded by the built-in decoder');
    scan = await scanCurrent();
    results.h264iViolations = await page.evaluate(() => window.__unflash.lastScan.result.violations);
    console.log('h264 interlaced scan:', scan.ms, 'ms |', scan.toast, '|', JSON.stringify(results.h264iViolations));
    assert(results.h264iViolations.length === results.cpuViolations.length, 'the interlaced H.264 copy has the same violations as the VP9 one');
    for (let i = 0; i < results.h264iViolations.length; i++) {
      const a = results.h264iViolations[i];
      const b = results.cpuViolations[i];
      assert(a.kind === b.kind && Math.abs(a.start - b.start) < 0.15 && Math.abs(a.end - b.end) < 0.15, `interlaced H.264 violation ${i} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    await openFile('flash_h264.mp4');
    page.once('dialog', (d) => d.accept());
    await page.click('#btnDeleteAll');
    await page.waitForFunction(() => document.querySelectorAll('#sectionList .sec-item').length === 1);
    scan = await scanCurrent();
  }
  // sections work through the built-in decoder too: prepare and check the flash
  await openSectionPrepared('#sectionList .sec-item', 180000);
  await verdictReady(page);
  results.h264Verdict = await page.textContent('#wsVerdict');
  console.log('h264 section verdict:', results.h264Verdict);
  assert(results.h264Verdict.startsWith('fails'), 'the H.264 section fails before editing: ' + results.h264Verdict);

  // --- debug info: a report to paste into a message, naming no files -----------
  await page.click('#btnDebug');
  await page.waitForSelector('#debugModal', { state: 'visible' });
  const report = await page.inputValue('#debugText');
  console.log('debug report (the start):\n' + report.split('\n').slice(0, 12).join('\n'));
  for (const [what, re] of [
    ['a heading', /^Unflash debug info · \d{4}-\d\d-\d\d/],
    ['the browser', /\nBrowser +Mozilla\/5\.0/],
    ['the detector', /\nDetector +CPU \(WebAssembly\) at 256×144/],
    ['the video', /\nVideo +MP4 · avc1\.[0-9A-Fa-f]{6} · 640×360 · 30\.000 fps/],
    ['the scan', /\nScan +\d+ frames in [\d.]+ s = \d+ fps/],
    ['the jobs', /Scanning for flashes: [\d.]+ s ok/],
    ["the scan's operations", /Last scan, time per operation:\nscan \(640×360, cpu\)/],
  ]) assert(re.test(report), `the debug report gives ${what}:\n${report}`);
  assert(!report.includes('flash_h264') && !report.includes('.mp4'), 'the debug report names no files:\n' + report);
  assert((await page.getAttribute('#btnDebugSave', 'href')).startsWith('blob:') && (await page.textContent('#debugNote')).length > 20, 'it can be copied or saved as a file');
  await page.click('#debugText');
  await page.keyboard.press('Escape');
  assert(await page.$eval('#debugModal', (m) => m.classList.contains('hidden')), 'Esc closes the debug report, from its text too');
  // a long job's report says where its time went: its big steps, in order
  // (the page's clock run on by hand: a job of 7.5 s in no time)
  const steps = await page.evaluate(async () => {
    const { noteJob } = await import('./debug.js');
    const real = performance.now.bind(performance);
    let ahead = 0;
    performance.now = () => real() + ahead;
    try {
      const end = noteJob('A long job');
      end.step('reading the index');
      ahead += 1200;
      end.step('loading the project kept for this video');
      ahead += 300;
      end.step('reading 10 of 90 pieces · 30 MB/s');
      ahead += 3000;
      end.step('reading 90 of 90 pieces · 28 MB/s · the last one');
      ahead += 3000;
      end('ok');
      // (a scan's running counts are one step: nothing to break down)
      const scan = noteJob('A long scan');
      scan.step('100 frames · 50 fps');
      ahead += 3000;
      scan.step('900 frames · 60 fps · 1 violation found so far');
      ahead += 3000;
      scan.step('1800 frames · 61 fps · 2 violations found so far');
      scan('ok');
      // (nor does a job of under two seconds)
      const short = noteJob('A short job');
      short.step('reading the index');
      ahead += 1000;
      short.step('starting the detector');
      ahead += 800;
      short('ok');
    } finally {
      performance.now = real;
    }
    return window.__unflash.debugReport();
  });
  assert(/A long job: 7\.5 s ok\n\s+reading the index 1\.2 s · reading … of … pieces 6\.0 s\n/.test(steps), "a long job's report lists its big steps (a step's changing numbers are one step): " + steps.split('\n').filter((l) => /long job|reading/.test(l)).join(' / '));
  assert(/A long scan: 6\.0 s ok\n(?!\s+… frames)/.test(steps), "a scan's running counts are no steps: " + steps.split('\n').filter((l) => /long scan|frames/.test(l)).join(' / '));
  assert(/A short job: 1\.8 s ok\n(?!\s+reading the index)/.test(steps), 'a job of under two seconds lists no steps');

  // --- what's new: someone coming back sees what changed since they were here ---
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push("pageerror (what's new): " + e.message));
    const visit = async () => {
      await p.goto(`http://127.0.0.1:${port}/?auto=0`);
      await p.waitForFunction(() => window.__unflash && window.__unflash.changes, null, { timeout: 60000 });
    };
    const shown = () =>
      p.evaluate(() => {
        const c = window.__unflash.changes;
        return {
          card: !document.querySelector('#newsCard').classList.contains('hidden'),
          items: document.querySelectorAll('#newsList li').length,
          more: (document.querySelector('#newsList .news-more') || {}).textContent || '',
          dot: !document.querySelector('#changesDot').classList.contains('hidden'),
          mark: Number(localStorage.getItem('unflash:changesSeen')),
          newest: c.newest,
          days: c.log.days.length,
          times: c.log.days.flatMap((d) => d.items.map((it) => it.at)),
          untimed: c.log.days.flatMap((d) => d.items.filter((it) => !it.timed)).length,
        };
      });
    // a first visit is shown nothing: it starts from the newest change
    await visit();
    let s = await shown();
    assert(!s.card && !s.dot && s.mark === s.newest, 'a first visit is shown no changes: ' + JSON.stringify({ ...s, times: s.times.length }));
    assert(s.times.length >= 20 && s.untimed === 0, `every change in CHANGELOG.md says when it went live (${s.untimed} do not)`);
    const sorted = [...s.times].sort((a, b) => b - a);
    const newer = (t) => sorted.filter((x) => x > t).length;
    // back after a visit: the changes since, until "Got it" (changes that
    // went live together share a time, so the visit is the third-newest time)
    const distinct = [...new Set(sorted)];
    const seenAt = distinct[Math.min(2, distinct.length - 1)];
    await p.evaluate((t) => localStorage.setItem('unflash:changesSeen', String(t)), seenAt);
    await visit();
    s = await shown();
    assert(s.card && s.dot && s.items === Math.min(6, newer(seenAt)) && (newer(seenAt) > 6) === !!s.more, `back after a visit, the ${newer(seenAt)} changes since: ` + JSON.stringify({ card: s.card, dot: s.dot, items: s.items, more: s.more }));
    await p.screenshot({ path: path.join(OUT, '8-whats-new.png') });
    await p.click('#btnNewsSeen');
    s = await shown();
    assert(!s.card && !s.dot && s.mark === s.newest, '"Got it" puts them away');
    await visit();
    assert(!(await shown()).card, 'and they stay away');
    // from before there was a notice: the last project saved says when they were here
    const lastSave = sorted[9] + 1;
    await p.evaluate(async (at) => {
      localStorage.removeItem('unflash:changesSeen');
      await new Promise((resolve, reject) => {
        const r = indexedDB.open('unflash', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('projects');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const tx = r.result.transaction('projects', 'readwrite');
          tx.objectStore('projects').put({ savedAt: at, sections: [] }, 'an earlier video');
          tx.oncomplete = () => {
            r.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    }, lastSave);
    await visit();
    s = await shown();
    const since = newer(lastSave);
    console.log(`what's new: ${s.times.length} changes over ${s.days} days; back after the last save, ${since} new, the card lists ${s.items} ${s.more}`);
    assert(s.card && s.items === Math.min(6, since) && (since > 6) === s.more.includes(`${since - 6} more`), 'back from before the notice, the changes since the last save: ' + JSON.stringify({ card: s.card, items: s.items, more: s.more, since }));
    // everything, the new ones marked
    await p.click('#btnChanges');
    const list = await p.evaluate(() => ({
      open: !document.querySelector('#changesModal').classList.contains('hidden'),
      days: document.querySelectorAll('#changesList h3').length,
      items: document.querySelectorAll('#changesList li').length,
      fresh: document.querySelectorAll('#changesList li.new').length,
    }));
    assert(list.open && list.days === s.days && list.items === s.times.length && list.fresh === since, 'the whole list, the new ones marked: ' + JSON.stringify(list));
    // each change with its film (whatsnew/): the first, in view, plays by itself, muted and looped
    const films = await p.evaluate(() => ({ n: document.querySelectorAll('#changesList li .shot-film video').length, shots: Object.keys(window.__unflash.changes.log.shots || {}).length }));
    assert(films.n === s.times.length && films.shots === s.times.length, "every change in What's new has its film: " + JSON.stringify({ ...films, changes: s.times.length }));
    await p.waitForFunction(() => {
      const v = document.querySelector('#changesList .shot-film video');
      return v && !v.paused && v.muted && v.loop && v.currentTime > 0.3;
    }, null, { timeout: 30000 });
    // the rest wait until they are scrolled to
    assert(await p.evaluate(() => [...document.querySelectorAll('#changesList .shot-film video')].slice(-1)[0].paused), 'a film out of view does not play');
    await p.keyboard.press('Escape');
    assert(await p.evaluate(() => [...document.querySelectorAll('#changesList video')].every((v) => v.paused)), 'closing What\'s new stops its films');
    // with less motion asked for, none plays by itself; a click plays one
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.click('#btnChanges');
    await p.waitForTimeout(1500);
    assert(await p.evaluate(() => [...document.querySelectorAll('#changesList video')].every((v) => v.paused)), 'with less motion asked for, no film plays by itself');
    await p.click('#changesList .shot-film');
    await p.waitForFunction(() => !document.querySelector('#changesList .shot-film video').paused, null, { timeout: 30000 });
    await p.click('#changesList .shot-film');
    assert(await p.evaluate(() => document.querySelector('#changesList .shot-film video').paused), 'and a click pauses it again');
    // a film with sound: its own button plays it with its sound (it has some), and turns it off again
    const k = '#changesList .shot.has-sound .shot-sound';
    assert(await p.$(k), 'a film with sound has a sound button');
    await p.$eval(k, (b) => b.scrollIntoView({ block: 'center' }));
    await p.click(k);
    await p.waitForFunction((sel) => {
      const b = document.querySelector(sel);
      const v = b.parentNode.querySelector('video');
      return !v.paused && !v.muted && b.getAttribute('aria-pressed') === 'true' && b.textContent === 'sound on' && v.webkitAudioDecodedByteCount > 0;
    }, k, { timeout: 30000 });
    await p.click(k);
    assert(await p.$eval(k, (b) => b.parentNode.querySelector('video').muted && b.getAttribute('aria-pressed') === 'false' && b.textContent === 'sound off'), 'and the button turns the sound off again');
    await p.emulateMedia({ reducedMotion: 'no-preference' });
    await p.keyboard.press('Escape');
    s = await shown();
    assert(!(await p.$eval('#changesModal', (m) => !m.classList.contains('hidden'))) && !s.card && s.mark === s.newest, 'Esc closes it, and they count as seen');
    await ctx.close();
  }

  }

  // ======== the same scans on the GPU must agree ==============================
  if (runs('gpu')) {
  await cpuReferences(['cpuViolations', 'stripesViolations']);
  await page.goto(`http://127.0.0.1:${port}/?auto=0`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
  // the welcome page's test clips open straight into the app
  await page.click('[data-clip="stripes.mp4"]');
  await page.waitForFunction(() => document.querySelector('#videoInfo').textContent.includes('stripes.mp4'), null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#status').textContent.includes('ready ·'), null, { timeout: 60000 });
  await noBanner(page);
  page.once('dialog', (d) => d.accept());
  await page.click('#btnDeleteAll');
  await page.waitForFunction(() => document.querySelectorAll('#sectionList .sec-item').length === 1);
  scan = await scanCurrent();
  results.gpuStripes = await page.evaluate(() => window.__unflash.lastScan.result.violations);
  console.log('gpu stripes scan:', scan.ms, 'ms |', scan.toast, '|', JSON.stringify(results.gpuStripes));
  assert(results.gpuStripes.length === results.stripesViolations.length, 'GPU and CPU scans must find the same pattern violations');
  for (let i = 0; i < results.gpuStripes.length; i++) {
    const a = results.gpuStripes[i];
    const b = results.stripesViolations[i];
    assert(a.kind === b.kind && Math.abs(a.start - b.start) < 0.05 && Math.abs(a.end - b.end) < 0.05, `pattern violation ${i} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  await openFile('flash.mp4');
  results.gpuStatus = await page.textContent('#status');
  assert(results.gpuStatus.includes('WebGPU'), 'the default detector must be WebGPU: ' + results.gpuStatus);
  page.once('dialog', (d) => d.accept());
  await page.click('#btnDeleteAll');
  await page.waitForFunction(() => document.querySelectorAll('#sectionList .sec-item').length === 1);
  scan = await scanCurrent();
  results.gpuScan = scan;
  console.log('gpu scan:', scan.ms, 'ms |', scan.status, '|', scan.toast);
  results.gpuViolations = await page.evaluate(() => window.__unflash.lastScan.result.violations);
  results.gpuWhole = await page.evaluate(() => ({ frames: window.__unflash.lastScan.frames, held: window.__unflash.lastScan.result.held }));
  console.log('gpu violations:', JSON.stringify(results.gpuViolations));
  assert(results.gpuViolations.length === results.cpuViolations.length, 'GPU and CPU scans must find the same violations');
  for (let i = 0; i < results.gpuViolations.length; i++) {
    const a = results.gpuViolations[i];
    const b = results.cpuViolations[i];
    // the two ingest paths get their RGB from different browser colour
    // conversions, so allow a frame's difference at the edges
    assert(a.kind === b.kind && Math.abs(a.start - b.start) < 0.05 && Math.abs(a.end - b.end) < 0.05, `violation ${i} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  await page.screenshot({ path: path.join(OUT, '6-gpu-scan.png') });

  // ======== the same scan in two segments run at once must merge into the same result
  await page.goto(`http://127.0.0.1:${port}/?segments=2&auto=0`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
  await openFile('flash.mp4');
  page.once('dialog', (d) => d.accept());
  await page.click('#btnDeleteAll');
  await page.waitForFunction(() => document.querySelectorAll('#sectionList .sec-item').length === 1);
  scan = await scanCurrent();
  results.segScan = await page.evaluate(() => ({ segments: window.__unflash.lastScan.segments, frames: window.__unflash.lastScan.frames, violations: window.__unflash.lastScan.result.violations, held: window.__unflash.lastScan.result.held }));
  console.log('gpu scan in 2 segments:', scan.ms, 'ms |', scan.toast, '|', JSON.stringify(results.segScan));
  assert(results.segScan.segments === 2, 'the scan ran in two segments: ' + JSON.stringify(results.segScan));
  assert(results.segScan.frames === results.gpuWhole.frames, `frames ${results.segScan.frames} vs ${results.gpuWhole.frames}`);
  assert(results.segScan.violations.length === results.gpuViolations.length, 'the segmented scan finds the same violations as the whole scan');
  for (let i = 0; i < results.segScan.violations.length; i++) {
    const a = results.segScan.violations[i];
    const b = results.gpuViolations[i];
    assert(a.kind === b.kind && Math.abs(a.start - b.start) < 1e-6 && Math.abs(a.end - b.end) < 1e-6 && Math.abs(a.onset - b.onset) < 1e-6, `segmented violation ${i} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  assert(results.segScan.held === results.gpuWhole.held, `held frames ${results.segScan.held} vs ${results.gpuWhole.held}`);

  // ======== a scan in chunks must give exactly what the scan in one piece
  // gives: the decoders (the browser's and the built-in one side by side, in
  // a hybrid scan) make the detector's pictures of chunk after chunk, early
  // looks decode the chunks likeliest to flash first, and one detector takes
  // the pictures in file order. The test browser has no H.264 in WebCodecs,
  // so `sim` stands the built-in decoder, on the page, in for the browser's;
  // `hybridfail` fails the built-in decoder at its tenth picture, and the
  // browser's decoder must go on from there; `hold` makes the pictures held
  // for the detector few, so that the decoders wait for it
  const hybridScan = async (query) => {
    await page.goto(`http://127.0.0.1:${port}/?auto=0&${query}`);
    await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
    await openFile('flash_h264.mp4');
    scan = await scanCurrent();
    return page.evaluate(() => {
      const s = window.__unflash.lastScan;
      return { ms: Math.round(s.elapsedMs), frames: s.frames, held: s.result.held, violations: s.result.violations, chunked: s.chunked || null, partials: window.__unflash.partials, report: window.__unflash.debugReport() };
    });
  };
  const sameAsWhole = (name, r, w = results.h264Whole) => {
    assert(r.frames === w.frames && r.held === w.held, `${name}: frames ${r.frames} (held ${r.held}) vs ${w.frames} (held ${w.held})`);
    assert(r.violations.length > 0 && r.violations.length === w.violations.length, `${name}: the violations of the scan in one piece: ${JSON.stringify(r.violations)} vs ${JSON.stringify(w.violations)}`);
    for (let i = 0; i < r.violations.length; i++) {
      const a = r.violations[i];
      const b = w.violations[i];
      const same = a.kind === b.kind && ['start', 'end', 'onset', 'peak', 'count'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);
      assert(same, `${name}: violation ${i} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  };
  results.h264Whole = await hybridScan('hybrid=0');
  assert(!results.h264Whole.chunked, 'a ten-second file is scanned in one piece: ' + JSON.stringify(results.h264Whole.chunked));
  results.hybrid = await hybridScan('hybrid=sim:2,2&chunk=1');
  results.hybridFail = await hybridScan('hybrid=sim:2,2&chunk=1&order=file&hybridfail=1');
  results.hybridTight = await hybridScan('hybrid=sim:2,0&chunk=1&order=file&hold=5');
  results.triaged = await hybridScan('hybrid=0&chunk=1');
  // slow browser lanes (as Firefox's, which copy every picture out of the
  // GPU) and a budget they would fill: the built-in lane, idle, takes over
  // the chunk the detector waits for, from the last picture in. On the CPU
  // detector, which (unlike SwiftShader's WebGPU) is faster than the lanes
  results.h264WholeCpu = await hybridScan('cpu=1&hybrid=0');
  results.overtaken = await hybridScan('cpu=1&hybrid=sim:4,2&chunk=1&order=file&hold=13&slowlanes=150&rebalance=0');
  // the same, rebalanced: once each lane is timed, each chunk goes to the
  // lane that would finish it first; the slow lanes, which would finish
  // none sooner, are set aside, and the built-in decoder gets a worker for
  // each of them
  results.rebalanced = await hybridScan('cpu=1&hybrid=sim:4,2&chunk=1&order=file&hold=13&slowlanes=150');
  for (const [name, r] of [
    ['hybrid', results.hybrid],
    ['hybrid, the built-in decoder failing', results.hybridFail],
    ['hybrid, little held', results.hybridTight],
    ['one lane, early looks', results.triaged],
  ]) {
    const h = r.chunked;
    console.log(`${name} scan:`, r.ms, 'ms |', JSON.stringify({ frames: r.frames, violations: r.violations.map((v) => [v.kind, v.start, v.end]), taken: h && h.taken, looks: h && h.looks, lanes: h && h.lanes.map((l) => [l.kind, l.frames, l.chunks, l.looks, l.failed]), peak: h && h.peak, partials: r.partials.length }));
    assert(h && h.chunks >= 8 && !h.fallback, `${name}: a scan in chunks: ` + JSON.stringify(h));
    sameAsWhole(name, r);
    // every picture decoded once: a chunk a decoder gave up on is gone on with from its last picture
    assert(h.lanes.reduce((a, l) => a + l.frames, 0) === r.frames, `${name}: the lanes decoded each picture once: ${JSON.stringify(h.lanes)} for ${r.frames} frames`);
    assert(/Scan\s+.*\n\s+chunked: \d+ chunks of about 1 s, detected in file order/.test(r.report), `${name}: the debug report shows the chunks:\n${r.report}`);
  }
  assert(results.hybrid.chunked.lanes.length === 3 && results.hybrid.chunked.lanes.every((l) => l.frames > 0 && !l.failed), 'every lane decoded part of the file: ' + JSON.stringify(results.hybrid.chunked.lanes));
  {
    const r = results.overtaken;
    const h = r.chunked;
    console.log('slow browser lanes, taken over:', r.ms, 'ms |', JSON.stringify({ steals: h.steals, lanes: h.lanes.map((l) => [l.kind, l.frames, l.chunks, l.steals, l.stolen]) }));
    sameAsWhole('taken over', r, results.h264WholeCpu);
    assert(h.lanes.reduce((a, l) => a + l.frames, 0) === r.frames, 'taken over: each picture decoded once: ' + JSON.stringify(h.lanes));
    const builtIn = h.lanes.find((l) => l.kind === 'built-in');
    assert(h.steals >= 3 && builtIn.steals === h.steals && builtIn.frames > r.frames / 2 && h.lanes.some((l) => l.stolen > 0), 'the idle built-in lane took the waited-for chunks over from the slow ones: ' + JSON.stringify(h));
    // (without, the four slow lanes set the pace: 16 s here)
    assert(r.ms < 9000, 'and the scan went at its pace: ' + r.ms + ' ms');
    assert(/took over \d+ from slower lanes/.test(r.report) && /\d+ taken over by faster lanes/.test(r.report), 'the debug report tells of it:\n' + r.report);
  }
  {
    const r = results.rebalanced;
    const h = r.chunked;
    console.log('slow browser lanes, rebalanced:', r.ms, 'ms (taken over only:', results.overtaken.ms, 'ms) |', JSON.stringify({ steals: h.steals, grown: h.grown, lanes: h.lanes.map((l) => [l.kind, l.workers, l.frames, l.chunks, l.steals, l.stolen, l.aside]) }));
    sameAsWhole('rebalanced', r, results.h264WholeCpu);
    assert(h.lanes.reduce((a, l) => a + l.frames, 0) === r.frames, 'rebalanced: each picture decoded once: ' + JSON.stringify(h.lanes));
    const builtIn = h.lanes.find((l) => l.kind === 'built-in');
    const slow = h.lanes.filter((l) => l.kind === 'browser');
    assert(h.rebalanced && slow.every((l) => l.aside > 0) && builtIn.aside === 0 && builtIn.frames > (r.frames * 3) / 4, 'the slow lanes were set aside, the built-in decoder did the most: ' + JSON.stringify(h.lanes));
    assert(h.grown >= 1 && builtIn.workers > 2, 'and grew into the cores they left: ' + JSON.stringify({ grown: h.grown, workers: builtIn.workers }));
    assert(r.ms < results.overtaken.ms * 1.25 + 500, `and the scan was no slower than with take-overs alone: ${r.ms} ms against ${results.overtaken.ms}`);
    // (the report gives a lane's time set aside only past half a second, web/debug.js: a quick
    // runner sets the slow lanes aside for less, and the report rightly leaves it out)
    const namedAside = (r.report.match(/set aside [\d.]+ s/g) || []).length;
    assert(/each chunk to the lane that would finish it first, the built-in decoder grown by \d+ workers? for the lanes set aside/.test(r.report) && namedAside === h.lanes.filter((l) => l.aside > 500).length, 'the debug report tells of it:\n' + r.report);
  }
  assert(/built-in decoder ×2/.test(results.hybrid.report), 'the debug report shows the built-in decoder:\n' + results.hybrid.report);
  const gaveUp = results.hybridFail.chunked.lanes.find((l) => l.kind === 'built-in');
  assert(gaveUp.failed && gaveUp.frames === 10, 'the built-in lane gave up at its tenth picture and the browser lanes went on from there: ' + JSON.stringify(results.hybridFail.chunked));
  assert(/gave up: the built-in decoder failed/.test(results.hybridFail.report), 'the debug report says the built-in decoder gave up:\n' + results.hybridFail.report);
  {
    // at most a chunk (the detector's own) more than the budget held
    const h = results.hybridTight.chunked;
    assert(h.budget === 5 * 1024 * 1024 && h.peak > 0 && h.peak <= h.budget + 50 * 144 * 256 * 4, 'the pictures held keep to the budget: ' + JSON.stringify({ budget: h.budget, peak: h.peak }));
  }
  {
    // triage: a lone lane looks at the likeliest chunks first (the run-up
    // before them decoded with them, all held for the detector), and what
    // it finds there is known before the end
    const h = results.triaged.chunked;
    const look = h.looks[0];
    assert(h.order === 'triage' && h.hot.length >= 2 && look && h.hot.includes(look.from) && h.taken[0] === look.first, 'the first chunks decoded are an early look at a hot chunk: ' + JSON.stringify(h));
    assert(look.found > 0 && results.triaged.partials.some((p) => p.early && p.found > 0), 'the early look found the flashing: ' + JSON.stringify({ looks: h.looks, partials: results.triaged.partials }));
    assert(/early looks at \d+ of the \d+ likeliest to flash/.test(results.triaged.report), 'the debug report tells of the early looks:\n' + results.triaged.report);
    const looked = results.hybrid.chunked.looks;
    assert(looked.length >= 1 && results.hybrid.chunked.lanes.some((l) => l.looks > 0), 'a hybrid scan looks early too: ' + JSON.stringify(results.hybrid.chunked));
  }
  // the picker: the detector's chunk, then the next ones while the budget
  // has room; early looks at hot chunks with their run-up; chunks given back
  results.picker = await page.evaluate(async () => {
    const { ChunkPicker } = await import('./analysis.js');
    const n = new Array(10).fill(30);
    const t = Array.from({ length: 11 }, (_, i) => i);
    const p = new ChunkPicker(n, t, { bytes: 1, budget: 90 });
    const ahead = [p.ahead(), p.ahead(), p.ahead(), p.ahead(), p.ahead()];
    p.advance(2);
    const later = [p.ahead(), p.ahead()];
    const q = new ChunkPicker(n, t, { bytes: 1, budget: 300, order: [6, 2, 7, 0, 1, 3, 4, 5, 8, 9], hot: 3, runup: 2, hotShare: 0.5 });
    const look = q.hotRun(1);
    const noRoom = q.hotRun(1);
    const rest = [];
    for (let k = 0; k < 7; k++) rest.push(q.ahead());
    q.release(5);
    const back = q.ahead();
    const r = new ChunkPicker(n, t, { bytes: 1, order: [1, 6, 0, 2, 3, 4, 5, 7, 8, 9], hot: 2 });
    const near = r.hotRun(3);
    return { ahead, later, look, noRoom, rest, back, near };
  });
  console.log('chunk picker:', JSON.stringify(results.picker));
  {
    const k = results.picker;
    assert(JSON.stringify(k.ahead) === '[0,1,2,3,-2]' && JSON.stringify(k.later) === '[4,-2]', 'chunks in file order, as many ahead as the budget holds: ' + JSON.stringify(k));
    assert(JSON.stringify(k.look) === '{"first":4,"from":6,"last":7}' && k.noRoom === null, 'an early look takes its run-up and the hot chunks after it, within the share of the budget for looks: ' + JSON.stringify(k));
    assert(JSON.stringify(k.rest) === '[0,1,2,3,8,9,-1]' && k.back === 5, 'then the rest in order, and a chunk given back goes again: ' + JSON.stringify(k));
    assert(JSON.stringify(k.near) === '{"first":6,"from":6,"last":6}', 'no early look at a chunk the lanes get to soon anyway: ' + JSON.stringify(k));
  }

  // ======== a BGRX picture (what Firefox on a Mac decodes to), copied as it
  // is and put back in order by the GPU, must be analysed exactly like the
  // same picture handed over as RGBA
  results.packed = await page.evaluate(async () => {
    const wasm = await import('./pkg/unflash.js');
    const { createDetector } = await import('./detector.js');
    const cfg = window.__unflash.state.config;
    const w = 320;
    const h = 240;
    const viaFrame = await createDetector(wasm, cfg, w, h, { route: 'rgba' });
    const direct = await createDetector(wasm, cfg, w, h);
    try {
      for (let i = 0; i < 20; i++) {
        const rgba = new Uint8Array(w * h * 4);
        const on = Math.floor(i / 2) % 2 === 1;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const k = (y * w + x) * 4;
            const inBox = x < 200 && y < 180;
            rgba[k] = inBox && on ? 250 : 20 + ((x * 7 + y * 3 + i) % 40);
            rgba[k + 1] = inBox && on ? 40 : 30 + ((x + y * 5) % 50);
            rgba[k + 2] = inBox && on ? 30 : 60 + ((x * 3 + y) % 30);
            rgba[k + 3] = 255;
          }
        const bgrx = rgba.slice();
        for (let k = 0; k < bgrx.length; k += 4) [bgrx[k], bgrx[k + 2]] = [bgrx[k + 2], bgrx[k]];
        const t = i / 30;
        await viaFrame.videoFrame(new VideoFrame(bgrx, { format: 'BGRX', codedWidth: w, codedHeight: h, timestamp: Math.round(t * 1e6) }), t, true);
        await direct.waitSlot();
        direct.det.feed_rgba(rgba, w, h, t, true);
        direct.poll();
      }
      await viaFrame.drain();
      await direct.drain();
      const a = viaFrame.records();
      const b = direct.records();
      const same = a.length === b.length && a.every((r, i) => JSON.stringify(r) === JSON.stringify(b[i]));
      const pics = a.every((r, i) => {
        const x = viaFrame.det.take_capture(r.index);
        const y = direct.det.take_capture(b[i].index);
        return x && y && x.length === y.length && x.every((v, k) => v === y[k]);
      });
      return { n: a.length, same, pics, route: viaFrame.route, detail: viaFrame.rgbaDetail, flashes: a.filter((r) => r.hazard > 0).length };
    } finally {
      viaFrame.det.free();
      direct.det.free();
    }
  });
  console.log('BGRX frames as they come:', JSON.stringify(results.packed));
  assert(results.packed.n === 20 && results.packed.same && results.packed.pics, 'BGRX frames copied as they are must match RGBA: ' + JSON.stringify(results.packed));
  assert(results.packed.route === 'rgba' && /BGRX as decoded/.test(results.packed.detail), 'the BGRX frames took the packed copy: ' + JSON.stringify(results.packed));

  // ======== WebGPU that gives the page no adapter (graphics acceleration off, say)
  // the CPU detector, and a banner that says so in words, with what to look
  // at; the debug report keeps the browser's own error
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(() => {
      if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;
    });
    const noGpu = await ctx.newPage();
    await noGpu.goto(`http://127.0.0.1:${port}/?auto=0`);
    await noGpu.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
    await noGpu.setInputFiles('#fileInput', path.join(MEDIA, 'flash.mp4'));
    await noGpu.waitForFunction(() => /graphics adapter/.test(document.querySelector('#bannerText').textContent), null, { timeout: 60000 });
    results.noAdapter = await noGpu.evaluate(() => ({
      banner: document.querySelector('#bannerText').textContent,
      info: document.querySelector('#banner').classList.contains('info'),
      backend: window.__unflash.state.env.feeder.backend,
      report: window.__unflash.debugReport(),
    }));
    await ctx.close();
    console.log('no WebGPU adapter:', results.noAdapter.banner);
    const b = results.noAdapter.banner;
    assert(results.noAdapter.backend === 'cpu' && results.noAdapter.info, 'no adapter: the CPU detector, and an info banner: ' + JSON.stringify(results.noAdapter.backend));
    assert(/the results are the same/.test(b) && /Use graphics acceleration when available/.test(b) && /chrome:\/\/gpu/.test(b) && !/compiled in/.test(b), 'no adapter: the banner says it in words, with what to look at: ' + b);
    assert(/no WebGPU adapter/.test(results.noAdapter.report) && /WebGPU, but no adapter given to the page/.test(results.noAdapter.report), "no adapter: the debug report keeps the browser's own error: " + results.noAdapter.report);
  }

  }

  // ======== every route a picture can take to the GPU detector =============
  if (runs('routes')) {
  await cpuReferences(['cpuViolations']);
  // ?route forces one: the frame itself (videoframe), its own YUV planes
  // (yuv: what Firefox's WebGPU needs, and what the built-in decoder hands
  // over), WebCodecs' RGBA conversion (rgba), a canvas blit (canvas) or
  // canvas pixels (pixels). ?extsrc=none pretends WebGPU rejects the frame
  // and the canvas, as Firefox's does, so the automatic choice must be to
  // decode in workers, which copy each picture's planes off the page (raw).
  // Each must find the same violations as the CPU scan, and the live
  // monitor's <video> must work by its own routes.
  for (const [query, route, liveRoute] of [
    ['route=yuv', 'yuv', 'video'],
    ['route=rgba', 'rgba', 'video'],
    ['route=canvas', 'canvas', 'canvas'],
    ['route=pixels', 'pixels', 'pixels'],
    ['extsrc=none', 'raw', 'pixels'],
  ]) {
    // ?monitor=detect: the point here is the <video> routes, so the monitor must detect rather than read the scan
    await page.goto(`http://127.0.0.1:${port}/?${query}&auto=0&monitor=detect`);
    await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
    await openFile('flash.mp4');
    assert((await page.textContent('#status')).includes('WebGPU'), `the detector is still WebGPU with ?${query}`);
    page.once('dialog', (d) => d.accept());
    await page.click('#btnDeleteAll');
    await page.waitForFunction(() => document.querySelectorAll('#sectionList .sec-item').length === 1);
    scan = await scanCurrent();
    const violations = await page.evaluate(() => window.__unflash.lastScan.result.violations);
    const taken = await page.evaluate(() => window.__unflash.state.env.feeder.route);
    const inWorkers = await page.evaluate(() => window.__unflash.state.movie.decodeInWorkers);
    console.log(`gpu scan, pictures via ${route}:`, scan.ms, 'ms |', scan.toast, '| route', taken, inWorkers ? '(decoded in workers)' : '', '|', JSON.stringify(violations));
    assert(taken === route, `?${query} must feed pictures as ${route}, not ${taken}`);
    assert(inWorkers === (route === 'raw'), `?${query}: decoding in workers only when WebGPU takes no frame and no route is forced`);
    assert(violations.length === results.cpuViolations.length, `the ${route} route must find the same violations as the CPU scan`);
    for (let i = 0; i < violations.length; i++) {
      const a = violations[i];
      const b = results.cpuViolations[i];
      assert(a.kind === b.kind && Math.abs(a.start - b.start) < 0.05 && Math.abs(a.end - b.end) < 0.05, `violation ${i} differs via ${route}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    results[`gpuScan_${route}`] = { ms: scan.ms, violations };
    // the live monitor feeds the <video> element by its own routes
    await page.check('#liveToggle');
    // what matters here is that pictures reach the detector by this route:
    // the player steps through the flashing (3 to 5.5 s) a frame at a time
    // and the monitor watches every frame (while playing it skips those a
    // busy GPU has no room for, so what it sees would depend on the speed of
    // the machine); any flashing reported will do, "no flashing so far" is not it
    const liveSeen = new Set();
    for (let k = 75; k <= 180; k++) liveSeen.add(await page.evaluate((k) => window.__unflash.liveStep((k + 0.5) / 30), k));
    const liveReported = () => [...liveSeen].some((s) => /^flashing|violations? so far/.test(s));
    const liveTaken = await page.evaluate(() => window.__unflash.state.liveFeeder && window.__unflash.state.liveFeeder.route);
    console.log(`live monitor with ?${query}:`, [...liveSeen], '| route', liveTaken);
    assert(liveReported(), `the live monitor must report the flashing with ?${query}: ` + JSON.stringify([...liveSeen]));
    assert(liveTaken === liveRoute, `the live monitor must feed the <video> as ${liveRoute} with ?${query}, not ${liveTaken}`);
    await page.uncheck('#liveToggle');
    await page.evaluate(() => document.querySelector('#player').pause());
  }
  // the last route (?extsrc=none) decodes in workers, which make the pictures
  // small there: the same pictures as the detector makes them, to a code
  {
    const cmp = await page.evaluate(() => window.__unflash.compareShrink(window.__unflash.state.project.sections[0].id));
    console.log('pictures made small in the decode workers vs by the detector:', JSON.stringify(cmp));
    assert(cmp.frames[0] > 100 && cmp.frames[0] === cmp.frames[1], 'both prepares cache every frame: ' + JSON.stringify(cmp.frames));
    assert(/copied in a decode worker/.test(cmp.routes[0]) && /made \d+×\d+ in a decode worker/.test(cmp.routes[1]), 'one prepare hands over whole pictures, the other small ones: ' + JSON.stringify(cmp.routes));
    assert(cmp.max <= 1 && cmp.differ <= cmp.n / 100, `the workers' small pictures are the detector's, to a code: ${cmp.differ} of ${cmp.n} values differ, by at most ${cmp.max}`);
    // what the decode workers keep after the scan and both prepares: their
    // code and a few buffers to fill again, not the pictures they handed
    // over (147 KB each, made small: a long film's worth would fill the memory)
    const held = await page.evaluate(async () => {
      const m = await performance.measureUserAgentSpecificMemory();
      return m.breakdown.filter((b) => b.attribution.some((a) => a.scope === 'DedicatedWorkerGlobalScope')).map((b) => b.bytes);
    });
    console.log('the decode workers hold (MB):', held.map((b) => (b / 1e6).toFixed(1)).join(', '));
    assert(held.length && Math.max(...held) < 16e6, 'a decode worker keeps none of the pictures it handed over: ' + held);
  }
  // the profiling summary is on the console at debug level
  const profileText = await page.evaluate(() => window.__unflash.profile.summary(1));
  console.log('profile summary:\n' + profileText);
  assert(/feed/.test(profileText) && /gpu.latency/.test(profileText), 'the profile knows the feed and GPU latency timings');

  }

  // ======== auto-fix: open a file and the rest happens by itself =============
  if (runs('auto')) {
  // (the CPU detector again: SwiftShader's WebGPU is too slow for the prepares and the export)
  await page.goto(`http://127.0.0.1:${port}/?cpu=1`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
  // start from nothing: no remembered scans or marks from the flows above
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.deleteDatabase('unflash');
        r.onsuccess = r.onerror = r.onblocked = () => resolve();
      })
  );
  const autoDone = async () => {
    await page.waitForFunction(() => window.__unflash.auto && Object.keys(window.__unflash.auto.steps).length > 0, null, { timeout: 60000 });
    await page.waitForFunction(() => !window.__unflash.auto.running, null, { timeout: 600000 });
    await noBanner(page);
    return page.evaluate(() => {
      const a = window.__unflash.auto;
      const dl = document.querySelector('#autoDownload');
      return { steps: a.steps, summary: a.summary, hasBlob: !!a.blobUrl, download: dl.classList.contains('hidden') ? null : dl.getAttribute('download') };
    });
  };
  assert(!(await page.$eval('#autoToggle', (c) => c.checked)), 'auto-fix is off unless asked for');
  // with it off, opening a file still scans it, and does nothing else
  await openFile('steady.mp4');
  await page.waitForFunction(() => window.__unflash.state.project.scan && !window.__unflash.state.job, null, { timeout: 120000 });
  assert(await page.evaluate(() => !window.__unflash.auto), 'no unattended run without auto-fix');
  await page.check('#autoToggle');
  await page.waitForFunction(() => window.__unflash.auto && !window.__unflash.auto.running, null, { timeout: 120000 });
  results.autoTicked = await page.evaluate(() => window.__unflash.auto.steps.scan.text);
  assert(/scanned when the file was opened/.test(results.autoTicked), 'ticked later, auto-fix takes the scan the file already had: ' + results.autoTicked);
  t0 = Date.now();
  await openFile('flash.mp4');
  results.autoFlash = await autoDone();
  results.autoFlash.ms = Date.now() - t0;
  console.log('auto-fix flash.mp4:', results.autoFlash.ms, 'ms |', JSON.stringify(results.autoFlash));
  const st = results.autoFlash.steps;
  assert(st.scan.status === 'done' && /2 violations/.test(st.scan.text), 'auto-fix scans the file first: ' + JSON.stringify(st.scan));
  assert(st.fix.status === 'done' && /fewest removals|keep dark|keep light|frame rate/.test(st.fix.text), 'auto-fix takes the flashing out: ' + JSON.stringify(st.fix));
  assert(st.export.status === 'done' && st.verify.status === 'done', 'auto-fix exports and checks the export: ' + JSON.stringify(st));
  assert(/Passes WCAG/.test(st.verify.text), 'the exported file passes WCAG: ' + st.verify.text);
  assert(/copied from the source/.test(st.export.text) && / re-encoded /.test(st.export.text), 'the automatic export copies the untouched GOPs and re-encodes the spans: ' + st.export.text);
  assert(results.autoFlash.download === 'flash.unflashed.mp4' && results.autoFlash.hasBlob, 'the fixed video is offered for download: ' + JSON.stringify(results.autoFlash));
  assert(/ready to download/.test(results.autoFlash.summary), 'the summary says so: ' + results.autoFlash.summary);
  const autoSections = await page.$$eval('#sectionList .sec-item', (els) => els.map((e) => e.textContent));
  assert(autoSections.length === 1 && /safe/.test(autoSections[0]) && !/unsafe/.test(autoSections[0]), 'the section is marked safe after the automatic fix: ' + JSON.stringify(autoSections));
  await page.screenshot({ path: path.join(OUT, '7-autofix.png'), fullPage: true });
  // the download link serves the exported file
  const dlBytes = await page.evaluate(async () => (await (await fetch(document.querySelector('#autoDownload').href)).arrayBuffer()).byteLength);
  assert(dlBytes > 10000, 'the download link serves the exported MP4: ' + dlBytes + ' bytes');
  // the export dialog offers the same file
  await page.click('#btnExport');
  await page.waitForFunction(() => !document.querySelector('#exportModal').classList.contains('hidden'));
  assert(!(await page.$eval('#exportDownload', (a) => a.classList.contains('hidden'))) && !(await page.$eval('#btnVerifyExport', (b) => b.disabled)), 'the export dialog offers the automatic export for download and verification');
  await page.click('#btnCloseExport');

  // stripes: softened, exported, checked
  await openFile('stripes.mp4');
  results.autoStripes = await autoDone();
  console.log('auto-fix stripes.mp4:', JSON.stringify(results.autoStripes));
  assert(results.autoStripes.steps.fix.status === 'done' && /softened/.test(results.autoStripes.steps.fix.text), 'auto-fix softens the stripes: ' + JSON.stringify(results.autoStripes.steps.fix));
  assert(results.autoStripes.steps.export.status === 'done' && /softened/.test(results.autoStripes.steps.export.text), 'the export softens the patterned frames: ' + JSON.stringify(results.autoStripes.steps.export));
  assert(results.autoStripes.steps.verify.status === 'done' && /No hazardous stripe patterns/.test(results.autoStripes.steps.verify.text), 'no stripes are left in the exported file: ' + results.autoStripes.steps.verify.text);

  // a clean file: nothing to fix, nothing to export
  await openFile('steady.mp4');
  results.autoSteady = await autoDone();
  console.log('auto-fix steady.mp4:', JSON.stringify(results.autoSteady));
  assert(results.autoSteady.steps.fix.status === 'skipped' && !results.autoSteady.hasBlob && /passes as it is/.test(results.autoSteady.summary), 'a clean file needs no fix: ' + JSON.stringify(results.autoSteady));

  // a second visit reuses the scan and the marks, and exports again
  await openFile('flash.mp4');
  results.autoAgain = await autoDone();
  console.log('auto-fix flash.mp4 again:', JSON.stringify(results.autoAgain));
  assert(/last visit/.test(results.autoAgain.steps.scan.text) && /marks from before/.test(results.autoAgain.steps.fix.text) && results.autoAgain.steps.verify.status === 'done', 'the second visit reuses the scan and the marks: ' + JSON.stringify(results.autoAgain.steps));

  // "stop" pressed as the run moves on to its export, between its jobs (none
  // is under way to cancel), stops it there: no export starts
  {
    await page.evaluate(() => {
      window.__jobs = [];
      const name = document.querySelector('#jobName');
      new MutationObserver(() => window.__jobs.push(name.textContent)).observe(name, { childList: true, characterData: true, subtree: true });
      const steps = document.querySelector('#autoSteps');
      const watch = new MutationObserver(() => {
        const fix = steps.querySelector('[data-step="fix"]');
        if (!fix || !fix.classList.contains('done')) return;
        watch.disconnect();
        document.querySelector('#btnAutoStop').click();
      });
      watch.observe(steps, { childList: true });
    });
    await page.click('#btnAutoRerun');
    const run = await autoDone();
    const jobs = await page.evaluate(() => window.__jobs);
    console.log('auto-fix stopped as it moved on to its export:', JSON.stringify({ steps: run.steps, jobs }));
    assert(run.steps.fix.status === 'done' && run.steps.export.status === 'stopped' && !run.steps.verify && !jobs.includes('Exporting') && /^Stopped/.test(run.summary), 'stopped between its jobs, the run starts no export: ' + JSON.stringify({ steps: run.steps, jobs }));
  }
  // "stop" during the run's scan cancels the scan, and the run ends there
  {
    await page.evaluate(() => {
      const u = window.__unflash;
      const watch = new MutationObserver(() => {
        const job = u.state.job;
        if (!job || job.name !== 'Scanning for flashes' || job.pct < 10) return;
        watch.disconnect();
        document.querySelector('#btnAutoStop').click();
      });
      watch.observe(document.querySelector('#jobBar'), { attributes: true, attributeFilter: ['style'] });
    });
    await page.click('#btnAutoRerun');
    const run = await autoDone();
    const toast = await page.textContent('#toast');
    console.log('auto-fix stopped during its scan:', JSON.stringify(run.steps), '|', toast);
    assert(run.steps.scan.status === 'stopped' && !run.steps.fix && toast === 'Scanning for flashes: cancelled' && /^Stopped/.test(run.summary), 'stopped during its scan, the run ends there: ' + JSON.stringify(run));
  }
  // a run whose export still fails WCAG ends with an alert that says so (it
  // used to say nothing: no job had failed). The marks go here as the fixes
  // finish, so that the export keeps the flashing
  {
    await page.evaluate(() => {
      const u = window.__unflash;
      u.setAlerts({ beep: false, after: 0, notify: false });
      u.state.lastAlert = null;
      const steps = document.querySelector('#autoSteps');
      const watch = new MutationObserver(() => {
        const fix = steps.querySelector('[data-step="fix"]');
        if (!fix || !fix.classList.contains('done')) return;
        watch.disconnect();
        for (const s of u.state.project.sections) Object.assign(s, { edits: {}, blend: [], soften: false });
      });
      watch.observe(steps, { childList: true });
    });
    await page.click('#btnAutoRerun');
    const run = await autoDone();
    await page.waitForFunction(() => window.__unflash.lastAlert, null, { timeout: 30000 });
    const alert = await page.evaluate(() => window.__unflash.lastAlert);
    await page.evaluate(() => window.__unflash.setAlerts({ after: 60 }));
    console.log('the alert of a run whose export still fails:', JSON.stringify(alert));
    assert(run.steps.verify.status === 'failed' && !alert.ok && /failed$/.test(alert.title) && /^The exported file still fails WCAG/.test(alert.body), 'the alert of a run whose export still fails says so: ' + JSON.stringify({ steps: run.steps, alert }));
  }

  // the switch in the header turns it off: the file is scanned and nothing more
  await page.uncheck('#autoToggle');
  await openFile('steady.mp4');
  await page.waitForTimeout(800);
  assert(await page.$eval('#auto', (e) => e.classList.contains('hidden')), 'with auto-fix off, opening a file starts no unattended run');
  assert(await page.evaluate(() => !window.__unflash.auto), 'no run was started');
  await page.check('#autoToggle');
  await page.waitForFunction(() => window.__unflash.auto && !window.__unflash.auto.running, null, { timeout: 120000 });

  // a file dropped on the page opens, and the run starts
  const droppedFile = fs.readFileSync(path.join(MEDIA, 'redflash.mp4')).toString('base64');
  const dt = await page.evaluateHandle((b64) => {
    const t = new DataTransfer();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    t.items.add(new File([bytes], 'redflash.mp4', { type: 'video/mp4' }));
    return t;
  }, droppedFile);
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await page.waitForFunction(() => document.querySelector('#videoInfo').textContent.includes('redflash.mp4'), null, { timeout: 60000 });
  results.autoDropped = await autoDone();
  console.log('auto-fix dropped redflash.mp4:', JSON.stringify(results.autoDropped));
  assert(results.autoDropped.steps.fix.status === 'done' && /fewest removals|keep dark|keep light|frame rate/.test(results.autoDropped.steps.fix.text) && results.autoDropped.steps.verify.status === 'done' && /Passes WCAG/.test(results.autoDropped.steps.verify.text), 'the dropped red-flash clip is fixed and checked: ' + JSON.stringify(results.autoDropped.steps));
  }
} finally {
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  if (errors.length) console.log('BROWSER ERRORS:\n' + errors.join('\n'));
  if (!process.argv.includes('--keep')) {
    await browser.close();
    srv.close();
  }
}
if (errors.length) {
  console.log('FAILED: browser errors');
  process.exit(1);
}
console.log('E2E OK');
process.exit(0);
