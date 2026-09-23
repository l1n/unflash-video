// Project files and keeping a project in the browser: the WebM clip is
// scanned and one section marked; the project is saved to a file, every
// section deleted, and the file loaded back (sections, marks and the scan
// return); the same video opened again as a new copy (another modified
// time) finds its project; a project file for another video is turned down.
//   node tests/e2e/project.mjs
import { loadPlaywright } from './playwright.mjs';
import fs from 'node:fs';
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
  if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text());
  if (process.env.E2E_VERBOSE) console.log('[browser]', m.type(), m.text());
});
page.on('dialog', (d) => d.accept());
const jobDone = (timeout = 300000) => page.waitForFunction(() => document.querySelector('#jobbar').classList.contains('hidden'), null, { timeout });
const jobStarted = () => page.waitForFunction(() => !document.querySelector('#jobbar').classList.contains('hidden'), null, { timeout: 30000 }).catch(() => {});
const bannerText = () => page.evaluate(() => (document.querySelector('#banner').classList.contains('hidden') ? '' : document.querySelector('#bannerText').textContent));
const sectionsNow = () => page.evaluate(() => window.__unflash.state.project.sections.map((s) => ({ id: s.id, start: s.start, end: s.end, edits: s.edits })));
const clip = fs.readFileSync(path.join(MEDIA, 'flash.webm'));
// the clip as a fresh file: each one gets its own modified time, as a copy would
const openClip = async (name, buffer) => {
  await page.setInputFiles('#fileInput', { name, mimeType: 'video/webm', buffer });
  await page.waitForFunction((n) => document.querySelector('#videoInfo').textContent.includes(n), name, { timeout: 60000 });
  await jobDone();
};
const results = {};

try {
  await page.goto(`http://127.0.0.1:${port}/?cpu=1&auto=0`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });
  await openClip('flash.webm', clip);
  await page.click('#btnScan');
  await jobStarted();
  await jobDone();
  await page.click('#sectionList .sec-item');
  await page.waitForFunction(() => /passes|fails/.test(document.querySelector('#wsVerdict').textContent), null, { timeout: 180000 });
  await jobDone();
  // an E and an R
  for (const [slot, key] of [
    [5, 'e'],
    [6, 'r'],
  ]) {
    await page.click(`#frameGrid .frame:nth-child(${slot + 1})`);
    await page.click('#wsTitle');
    await page.keyboard.press(key);
  }
  results.before = await sectionsNow();
  const marked = results.before.find((s) => s.edits[5] && s.edits[6]);
  assert(marked && marked.edits[5].extended && marked.edits[6].removed, 'slot 5 held and slot 6 removed: ' + JSON.stringify(results.before));

  // saved to a file
  await page.click('#btnProject');
  await page.waitForSelector('#projectMenu:not(.hidden)');
  results.note = await page.textContent('#projectNote');
  assert(/1 section, 2 marks, a scan/.test(results.note), 'the menu says what the project holds: ' + results.note);
  await page.click('#btnProjectSave');
  await page.waitForFunction(() => window.__unflash.lastProjectFile, null, { timeout: 10000 });
  const text = await page.evaluate(() => window.__unflash.lastProjectFile.text());
  const doc = JSON.parse(text);
  results.file = { bytes: text.length, kind: doc.kind, version: doc.version, video: doc.video, sections: doc.project.sections.length, trace: doc.project.scan && doc.project.scan.trace && doc.project.scan.trace.t && doc.project.scan.trace.t.$typed };
  console.log('project file:', JSON.stringify(results.file));
  assert(doc.kind === 'unflash-project' && doc.version === 1 && doc.video.name === 'flash.webm' && doc.video.frames === 300, 'the file names the video: ' + JSON.stringify(doc.video));
  assert(results.file.sections === results.before.length && results.file.trace === 'Float64Array', 'and holds the sections and the scan trace');

  // every section deleted, then the file loaded back
  await page.click('#btnDeleteAll');
  await page.waitForFunction(() => window.__unflash.state.project.sections.length === 0);
  await page.setInputFiles('#projectInput', { name: 'flash.unflash.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.waitForFunction(() => window.__unflash.state.project.sections.length > 0, null, { timeout: 30000 });
  results.loaded = await sectionsNow();
  results.loadToast = await page.textContent('#toast');
  console.log('loaded:', results.loadToast);
  assert(JSON.stringify(results.loaded) === JSON.stringify(results.before), 'the sections and marks come back as they were: ' + JSON.stringify(results.loaded));
  assert(await page.evaluate(() => !!(window.__unflash.state.scanTrace && window.__unflash.state.scanTrace.t.length === 300)), 'and the scan trace');
  assert(/^Loaded flash\.unflash\.json: 1 section and the scan/.test(results.loadToast), 'the toast says what was loaded: ' + results.loadToast);
  // the loaded section prepares and checks again when opened
  await page.click('#sectionList .sec-item');
  await page.waitForFunction(() => /passes|fails/.test(document.querySelector('#wsVerdict').textContent), null, { timeout: 180000 });
  await jobDone();
  assert(await page.evaluate(() => window.__unflash.currentSection().prepared), 'the loaded section prepares when opened');
  await page.evaluate(() => window.__unflash.state.project.save());

  // the same video again, as a new copy: its project is found by name and size
  await openClip('flash.webm', clip);
  results.reopen = { sections: await sectionsNow(), toast: await page.textContent('#toast') };
  console.log('reopened:', results.reopen.toast);
  assert(JSON.stringify(results.reopen.sections) === JSON.stringify(results.before), 'a copy of the video gets its project back: ' + JSON.stringify(results.reopen.sections));
  assert(/Restored the project saved for flash\.webm/.test(results.reopen.toast), 'and says so: ' + results.reopen.toast);

  // a project file for another video is turned down
  await page.setInputFiles('#fileInput', path.join(MEDIA, 'steady.mp4'));
  await page.waitForFunction(() => document.querySelector('#videoInfo').textContent.includes('steady.mp4'), null, { timeout: 60000 });
  await jobDone();
  await page.setInputFiles('#projectInput', { name: 'flash.unflash.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.waitForFunction(() => !document.querySelector('#banner').classList.contains('hidden'), null, { timeout: 10000 });
  results.mismatch = await bannerText();
  console.log('mismatch:', results.mismatch);
  assert(/The project is for flash\.webm \(300 frames/.test(results.mismatch) && (await sectionsNow()).length === 0, 'a project for another video is turned down: ' + results.mismatch);
  // and a file that is not a project
  await page.setInputFiles('#projectInput', { name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello": 1}') });
  await page.waitForFunction(() => /not an Unflash project file/.test(document.querySelector('#bannerText').textContent), null, { timeout: 10000 });

  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  console.log('PROJECT OK');
} catch (e) {
  console.error(e);
  await page.screenshot({ path: path.join(ROOT, 'tests/e2e/out/project-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.close();
}
