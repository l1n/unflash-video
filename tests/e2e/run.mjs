// End-to-end test of the web app in headless Chromium with WebGPU (SwiftShader).
//   node tests/e2e/run.mjs [--headed] [--keep]
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
const jobStarted = async (page) => {
  await page.waitForFunction(() => !document.querySelector('#jobbar').classList.contains('hidden') || !document.querySelector('#banner').classList.contains('hidden'), null, { timeout: 30000 }).catch(() => {});
  const banner = await page.evaluate(() => (document.querySelector('#banner').classList.contains('hidden') ? '' : document.querySelector('#bannerText').textContent));
  if (banner) throw new Error('banner: ' + banner);
};
const noBanner = async (page) => {
  const banner = await page.evaluate(() => (document.querySelector('#banner').classList.contains('hidden') ? '' : document.querySelector('#bannerText').textContent));
  if (banner && !/using the CPU detector|cannot decode/.test(banner)) throw new Error('banner: ' + banner);
};
const verdictReady = (page, timeout = 120000) => page.waitForFunction(() => /passes|fails/.test(document.querySelector('#wsVerdict').textContent), null, { timeout });

const { chromium } = await loadPlaywright();
const { srv, port } = await serve(WEB);
const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
  if (process.env.E2E_VERBOSE) console.log('[browser]', m.type(), m.text());
});

const results = {};
async function openFile(name) {
  await page.setInputFiles('#fileInput', path.join(MEDIA, name));
  await page.waitForFunction((n) => document.querySelector('#videoInfo').textContent.includes(n), name, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#status').textContent.includes('ready ·'), null, { timeout: 60000 });
}
async function scanCurrent() {
  const t0 = Date.now();
  await page.click('#btnScan');
  await jobStarted(page);
  await jobDone(page);
  const ms = Date.now() - t0;
  const project = await page.evaluate(() => JSON.parse(localStorage.getItem('unflash:lastScan') || 'null'));
  return { ms, project, status: await page.textContent('#status'), toast: await page.textContent('#toast') };
}

try {
  // ======== the editing flow, CPU detector ==================================
  await page.goto(`http://127.0.0.1:${port}/?cpu=1`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
  results.support = await page.textContent('#support');
  console.log(results.support);

  await openFile('flash.mp4');
  results.videoInfo = await page.textContent('#videoInfo');
  results.status = await page.textContent('#status');
  console.log(results.videoInfo, '|', results.status);
  assert(results.status.includes('CPU'), 'with ?cpu=1 the detector must run on the CPU');

  let scan = await scanCurrent();
  results.cpuScan = scan;
  console.log('cpu scan:', scan.ms, 'ms |', scan.status, '|', scan.toast);
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

  // --- open, prepare, check the section ---------------------------------------
  await page.click('#sectionList .sec-item');
  await page.waitForSelector('#btnPrepare', { state: 'visible' });
  let t0 = Date.now();
  await page.click('#btnPrepare');
  await page.waitForFunction(() => !document.querySelector('#wsBody').classList.contains('hidden'), null, { timeout: 120000 });
  await verdictReady(page);
  results.prepareMs = Date.now() - t0;
  results.verdictBefore = await page.textContent('#wsVerdict');
  results.frameCount = await page.textContent('#frameCount');
  console.log('prepared in', results.prepareMs, 'ms; verdict:', results.verdictBefore, results.frameCount);
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

  // --- export and verify -----------------------------------------------------
  await page.click('#btnExport');
  await page.waitForSelector('#exportModal', { state: 'visible' });
  results.exportCodecs = await page.$$eval('#exportCodec option', (o) => o.map((x) => x.textContent));
  console.log('encoders:', results.exportCodecs);
  assert(results.exportCodecs.length >= 1, 'an encoder must be available');
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
  const exported = await page.evaluate(async () => {
    const a = document.querySelector('#exportDownload');
    const blob = await (await fetch(a.href)).blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  fs.writeFileSync(path.join(OUT, 'exported.mp4'), Buffer.from(exported, 'base64'));
  t0 = Date.now();
  await page.click('#btnVerifyExport');
  await jobStarted(page);
  await jobDone(page, 600000);
  results.verifyMs = Date.now() - t0;
  results.verify = await page.textContent('#exportResult');
  console.log('verify:', results.verifyMs, 'ms;', results.verify);
  assert(results.verify.includes('Passes WCAG'), 'the exported file must pass WCAG');
  await page.screenshot({ path: path.join(OUT, '4-export.png') });
  await page.click('#btnCloseExport');

  // --- the live monitor on the original -------------------------------------
  await page.check('#liveToggle');
  await page.evaluate(() => {
    const v = document.querySelector('#player');
    v.muted = true;
    v.currentTime = 2.0;
    return v.play();
  });
  const seen = new Set();
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    seen.add(await page.textContent('#liveVerdict'));
    await page.waitForTimeout(200);
  }
  results.liveVerdicts = [...seen];
  results.hud = await page.textContent('#hudInfo');
  console.log('live verdicts seen:', results.liveVerdicts, '|', results.hud);
  assert([...seen].some((s) => /flashing/.test(s)), 'the live monitor must report the flashing while it plays');
  await page.screenshot({ path: path.join(OUT, '5-live.png') });
  await page.uncheck('#liveToggle');
  await page.evaluate(() => document.querySelector('#player').pause());

  // --- a steady file passes; an extended flash is flagged only by the default profile
  await openFile('steady.mp4');
  scan = await scanCurrent();
  console.log('steady:', scan.toast);
  assert(scan.toast.includes('No flashing'), 'the steady file must be clean');

  await openFile('extended.mp4');
  scan = await scanCurrent();
  results.extendedSections = await page.$$eval('#sectionList .sec-item', (els) => els.map((e) => e.textContent));
  console.log('extended (wcag_ext):', results.extendedSections);
  assert(results.extendedSections.some((s) => s.includes('extended flash')), 'the 3 Hz file must produce an extended-flash section under the default profile');
  page.once('dialog', (d) => d.accept());
  await page.click('#btnDeleteAll');
  await page.waitForFunction(() => document.querySelectorAll('#sectionList .sec-item').length === 1);
  await page.selectOption('#profileSel', 'wcag');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Profile changed'), null, { timeout: 30000 });
  scan = await scanCurrent();
  console.log('extended (wcag):', scan.toast);
  assert(scan.toast.includes('No flashing'), 'under exact WCAG the 3 Hz file passes');

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
  await page.click('#sectionList .sec-item');
  await page.waitForSelector('#btnPrepare', { state: 'visible' });
  await page.click('#btnPrepare');
  await page.waitForFunction(() => !document.querySelector('#wsBody').classList.contains('hidden'), null, { timeout: 120000 });
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

  // --- H.264 in a browser without H.264: the app says so ---------------------
  await openFile('flash_h264.mp4');
  results.h264 = { scanDisabled: await page.$eval('#btnScan', (b) => b.disabled), banner: await page.textContent('#bannerText') };
  console.log('h264:', results.h264);
  const h264Decodable = await page.evaluate(() => VideoDecoder.isConfigSupported({ codec: 'avc1.42C01E', codedWidth: 64, codedHeight: 64 }).then((r) => r.supported));
  if (!h264Decodable) assert(results.h264.scanDisabled && results.h264.banner.includes('cannot decode'), 'without an H.264 decoder the app must explain');

  // ======== the same scans on the GPU must agree ==============================
  await page.goto(`http://127.0.0.1:${port}/`);
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
