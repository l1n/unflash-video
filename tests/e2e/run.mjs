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

try {
  // ======== the editing flow, CPU detector ==================================
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

  // --- open the section: it prepares itself and is checked --------------------
  let t0 = Date.now();
  await openSectionPrepared();
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

  // --- the section player plays the section with the marks applied -------------
  assert((await page.$eval('#playerSource', (s) => s.value)) === 'edited', 'with a section open the player shows it, edited');
  results.playerWarning = await page.textContent('#playerWarning');
  assert(/Section #\d+ with your marks: passes the check/.test(results.playerWarning), 'the player says what it shows: ' + results.playerWarning);
  await page.evaluate(() => {
    window.__slots = [];
    const orig = window.__unflash.sectionPlayer.onFrame;
    window.__unflash.sectionPlayer.onFrame = (info, t, plan) => {
      window.__slots.push(info.slot);
      window.__playingTiles = Math.max(window.__playingTiles || 0, document.querySelectorAll('#frameGrid .frame.playing').length);
      orig(info, t, plan);
    };
  });
  await page.keyboard.press('Escape'); // no selection: play from the start
  await page.click('#btnPreviewPlay');
  await page.waitForFunction(() => window.__unflash.sectionPlayer.active, null, { timeout: 10000 });
  await page.waitForFunction(() => !window.__unflash.sectionPlayer.active, null, { timeout: 120000 });
  results.play = await page.evaluate(() => ({ n: window.__slots.length, first: window.__slots[0], last: window.__slots[window.__slots.length - 1], inOrder: window.__slots.every((s, i, a) => i === 0 || s === a[i - 1] + 1), tiles: document.querySelectorAll('#frameGrid .frame').length, playing: document.querySelectorAll('#frameGrid .frame.playing').length }));
  console.log('section player:', JSON.stringify(results.play));
  assert(results.play.first === 0 && results.play.last === results.play.tiles - 1 && results.play.inOrder, 'the section plays every frame of the section in order: ' + JSON.stringify(results.play));
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
  while (Date.now() < until) {
    seen.add(await page.textContent('#liveVerdict'));
    await page.waitForTimeout(200);
  }
  results.liveVerdicts = [...seen];
  results.hud = await page.textContent('#hudInfo');
  console.log('live verdicts seen:', results.liveVerdicts, '|', results.hud);
  assert([...seen].some((s) => /flashing/.test(s)), 'the live monitor must report the flashing while it plays');
  // a scan of this file exists, so the meter reads it instead of detecting again
  assert(/from the scan/.test(results.hud), 'after a scan the monitor reads the scan trace: ' + results.hud);
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

  // ======== the same scans on the GPU must agree ==============================
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

  // ======== every route a picture can take to the GPU detector =============
  // ?route forces one: the frame itself (videoframe), its own YUV planes
  // (yuv: what Firefox's WebGPU needs, and what the built-in decoder hands
  // over), WebCodecs' RGBA conversion (rgba), a canvas blit (canvas) or
  // canvas pixels (pixels). ?extsrc=none pretends WebGPU rejects the frame
  // and the canvas, so the automatic choice must land on yuv. Each must find
  // the same violations as the CPU scan, and the live monitor's <video>
  // must work by its own routes.
  for (const [query, route, liveRoute] of [
    ['route=yuv', 'yuv', 'video'],
    ['route=rgba', 'rgba', 'video'],
    ['route=canvas', 'canvas', 'canvas'],
    ['route=pixels', 'pixels', 'pixels'],
    ['extsrc=none', 'yuv', 'pixels'],
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
    console.log(`gpu scan, pictures via ${route}:`, scan.ms, 'ms |', scan.toast, '| route', taken, '|', JSON.stringify(violations));
    assert(taken === route, `?${query} must feed pictures as ${route}, not ${taken}`);
    assert(violations.length === results.cpuViolations.length, `the ${route} route must find the same violations as the CPU scan`);
    for (let i = 0; i < violations.length; i++) {
      const a = violations[i];
      const b = results.cpuViolations[i];
      assert(a.kind === b.kind && Math.abs(a.start - b.start) < 0.05 && Math.abs(a.end - b.end) < 0.05, `violation ${i} differs via ${route}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    results[`gpuScan_${route}`] = { ms: scan.ms, violations };
    // the live monitor feeds the <video> element by its own routes
    await page.check('#liveToggle');
    await page.evaluate(() => {
      const v = document.querySelector('#player');
      v.muted = true;
      v.currentTime = 2.0;
      return v.play();
    });
    const liveSeen = new Set();
    const liveUntil = Date.now() + 8000;
    while (Date.now() < liveUntil) {
      liveSeen.add(await page.textContent('#liveVerdict'));
      await page.waitForTimeout(200);
    }
    const liveTaken = await page.evaluate(() => window.__unflash.state.liveFeeder && window.__unflash.state.liveFeeder.route);
    console.log(`live monitor with ?${query}:`, [...liveSeen], '| route', liveTaken);
    assert([...liveSeen].some((s) => /flashing/.test(s)), `the live monitor must report the flashing with ?${query}`);
    assert(liveTaken === liveRoute, `the live monitor must feed the <video> as ${liveRoute} with ?${query}, not ${liveTaken}`);
    await page.uncheck('#liveToggle');
    await page.evaluate(() => document.querySelector('#player').pause());
  }
  // the profiling summary is on the console at debug level
  const profileText = await page.evaluate(() => window.__unflash.profile.summary(1));
  console.log('profile summary:\n' + profileText);
  assert(/feed/.test(profileText) && /gpu.latency/.test(profileText), 'the profile knows the feed and GPU latency timings');

  // ======== auto-fix: open a file and the rest happens by itself =============
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
  assert(st.fix.status === 'done' && /keep dark|keep light|frame rate/.test(st.fix.text), 'auto-fix takes the flashing out: ' + JSON.stringify(st.fix));
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
  assert(results.autoDropped.steps.fix.status === 'done' && /keep dark|keep light|frame rate/.test(results.autoDropped.steps.fix.text) && results.autoDropped.steps.verify.status === 'done' && /Passes WCAG/.test(results.autoDropped.steps.verify.text), 'the dropped red-flash clip is fixed and checked: ' + JSON.stringify(results.autoDropped.steps));
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
