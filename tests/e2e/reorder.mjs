// Frames reordered: the cutback clip (two scenes cut together a pair of
// frames at a time from 3 to 5 s) is scanned, and its section fails. Grouped
// by scene (G) it holds every frame, one scene and then the other, and
// passes; undo and redo take the order back and forth, [ and ] move frames
// by hand, a mark goes with its frame when frames move, the order is kept
// with the project, and the export, with every frame where the order puts
// it, passes a verify, as long as the video. "original order" puts every
// frame back.
//   node tests/e2e/reorder.mjs
import path from 'node:path';
import { MEDIA, assert, chromium, watch, idle, job, open, scan } from './playwright.mjs';

const { browser, port, close } = await chromium();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
watch(page, errors, /Failed to load resource/i);
const results = {};

/** The open section's order, marks and verdict, as the page has them. */
const sectionNow = () =>
  page.evaluate(() => {
    const s = window.__unflash.currentSection();
    return {
      id: s.id,
      n: s.nFrames,
      order: s.order || null,
      edits: s.edits,
      keep: s.keep,
      verdict: document.querySelector('#wsVerdict').textContent,
      moved: document.querySelectorAll('#frameGrid .frame.moved').length,
      badges: [...document.querySelectorAll('#frameGrid .frame.moved .fb')].slice(0, 3).map((b) => b.textContent),
      originalShown: !document.querySelector('#btnOriginalOrder').classList.contains('hidden'),
    };
  });
/** Until the open section's check has its verdict for the marks as they are. */
const checked = () =>
  page.waitForFunction(
    () => {
      const s = window.__unflash.currentSection();
      return !window.__unflash.state.job && !window.__unflash.state.checkRunning && s && s.check && !s.check.stale && /^(passes|fails)/.test(document.querySelector('#wsVerdict').textContent);
    },
    null,
    { timeout: 180000, polling: 100 }
  );
const isReorder = (order, n) => Array.isArray(order) && order.length === n && new Set(order).size === n && order.every((i) => Number.isInteger(i) && i >= 0 && i < n) && order.some((i, k) => i !== k);

try {
  await page.goto(`http://127.0.0.1:${port}/?cpu=1&auto=0`);
  await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU') || document.querySelector('#support').textContent.length > 10, null, { timeout: 60000 });
  await open(page, path.join(MEDIA, 'cutback.mp4'));
  results.scan = await scan(page);
  console.log('scan:', JSON.stringify(results.scan));
  const sections = await page.evaluate(() => window.__unflash.state.project.sections.map((s) => [s.id, s.start, s.end]));
  assert(sections.length === 1 && sections[0][1] <= 3.1 && sections[0][2] >= 4.9, 'one section, round the cutting back and forth: ' + JSON.stringify(sections));

  await page.click('#sectionList .sec-item');
  await checked();
  results.before = await sectionNow();
  console.log('before:', results.before.verdict, results.before.n, 'frames');
  assert(results.before.verdict.startsWith('fails') && !results.before.order, 'cut back and forth, the section fails: ' + JSON.stringify(results.before));

  // a frame in the second scene, marked keep, goes where its frame goes
  const keepAt = await page.evaluate(() => {
    const s = window.__unflash.currentSection();
    // (3.0 s is the first frame the cutback swaps; the second scene is on frames 2 and 3 of every 4 from there)
    for (let k = 0; k < s.pts.length; k++) if (s.start + s.pts[k] >= 3.0 - 1e-6 && Math.round((s.start + s.pts[k]) * 30) % 4 === 2) return k;
    return -1;
  });
  assert(keepAt > 0, 'a frame of the second scene: ' + keepAt);
  await page.click(`#frameGrid .frame:nth-child(${keepAt + 1})`);
  await page.click('#wsTitle');
  await page.keyboard.press('k');

  // G on the whole section
  await page.focus('#frameGrid');
  await page.keyboard.press('Control+a');
  await page.click('#wsTitle');
  await page.keyboard.press('g');
  await checked();
  results.grouped = await sectionNow();
  console.log('grouped:', results.grouped.verdict, `${results.grouped.moved} tiles moved`, JSON.stringify(results.grouped.badges), (await page.textContent('#toast')).trim());
  const n = results.grouped.n;
  assert(isReorder(results.grouped.order, n), 'grouping gives a reorder of every frame: ' + JSON.stringify(results.grouped.order));
  assert(Object.values(results.grouped.edits).every((e) => !e.removed && !e.extended), 'no frame is removed or held: ' + JSON.stringify(results.grouped.edits));
  assert(results.grouped.verdict === 'passes', 'one scene then the other passes: ' + results.grouped.verdict);
  assert(results.grouped.moved > 10 && /^frame \d+$/.test(results.grouped.badges[0]) && results.grouped.originalShown, 'the moved tiles say which frame they show: ' + JSON.stringify(results.grouped));
  // the first scene first, the second after it, each in its own order: the order rises twice at most
  const order = results.grouped.order;
  let falls = 0;
  for (let k = 1; k < n; k++) if (order[k] < order[k - 1]) falls++;
  assert(falls === 1, 'two runs, each in its own order: ' + JSON.stringify(order));
  // the keep mark went with its frame
  const keptAt = order.indexOf(keepAt);
  assert(results.grouped.keep.length === 1 && results.grouped.keep[0] === keptAt && keptAt !== keepAt, `the K on frame ${keepAt} moved to its new place ${keptAt}: ` + JSON.stringify(results.grouped.keep));

  // G again: one scene then the other already
  await page.keyboard.press('g');
  await page.waitForFunction(() => /already/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });

  // undo, redo
  await page.keyboard.press('Control+z');
  await checked();
  results.undone = await sectionNow();
  assert(!results.undone.order && results.undone.verdict.startsWith('fails') && results.undone.moved === 0 && results.undone.keep[0] === keepAt, 'undo puts the frames back where they were: ' + JSON.stringify(results.undone));
  await page.keyboard.press('Control+Shift+z');
  await checked();
  results.redone = await sectionNow();
  assert(JSON.stringify(results.redone.order) === JSON.stringify(order) && results.redone.verdict === 'passes', 'redo groups them again: ' + JSON.stringify(results.redone.order));

  // ] then [ on one frame: one place later, then back
  await page.click('#frameGrid .frame:nth-child(3)');
  await page.click('#wsTitle');
  await page.keyboard.press(']');
  results.moved = await sectionNow();
  const sel = await page.evaluate(() => [...window.__unflash.state.selection]);
  assert(results.moved.order[3] === order[2] && results.moved.order[2] === order[3] && sel.join() === '3', '] swaps the frame with the one after it, and the selection follows: ' + JSON.stringify([results.moved.order.slice(0, 5), sel]));
  await page.keyboard.press('[');
  results.back = await sectionNow();
  assert(JSON.stringify(results.back.order) === JSON.stringify(order), '[ takes it back');
  await checked();

  // the section player plays every place, each showing the frame the order puts there
  await page.evaluate(() => {
    window.__played = [];
    const orig = window.__unflash.sectionPlayer.onFrame;
    window.__unflash.sectionPlayer.onFrame = (info, t, plan) => {
      window.__played.push([info.slot, info.src]);
      orig(info, t, plan);
    };
  });
  await page.keyboard.press('Escape'); // no selection: play from the start
  await page.click('#btnPreviewPlay');
  await page.waitForFunction(() => window.__unflash.sectionPlayer.active, null, { timeout: 10000 });
  await page.waitForFunction(() => !window.__unflash.sectionPlayer.active, null, { timeout: 120000 });
  results.played = await page.evaluate(() => window.__played);
  await page.evaluate(() => (window.__unflash.sectionPlayer.onFrame = null));
  console.log('section player:', results.played.length, 'pictures, the first', JSON.stringify(results.played.slice(0, 3)));
  const tiles = await page.evaluate(() => document.querySelectorAll('#frameGrid .frame').length);
  assert(results.played.length === tiles && results.played.every(([slot, src], i) => slot === i && src === order[slot]), 'the player shows every place in turn, each with its frame: ' + JSON.stringify(results.played.filter(([slot, src], i) => slot !== i || src !== order[slot]).slice(0, 5)));

  // kept with the project
  const saved = await page.evaluate(() => window.__unflash.state.project.toSaved().sections[0].order);
  assert(JSON.stringify(saved) === JSON.stringify(order), 'the order is kept with the project');

  // the export, verified: every frame, the whole length, and it passes
  await idle(page);
  await page.click('#btnExport');
  await page.waitForSelector('#exportModal', { state: 'visible' });
  // VP9 into VP9, as the source: the GOPs the section leaves alone are copied, and the reorder re-encoded among them
  const vp9 = await page.$$eval('#exportCodec option', (o) => (o.find((x) => /^VP9/.test(x.textContent)) || {}).value);
  assert(vp9 !== undefined, 'a VP9 encoder');
  await page.selectOption('#exportCodec', vp9);
  await job(page, () => page.click('#btnDoExport'), 600000);
  await page.waitForFunction(() => !document.querySelector('#btnVerifyExport').disabled, null, { timeout: 30000 });
  results.export = await page.textContent('#exportResult');
  console.log('export:', results.export);
  await job(page, () => page.click('#btnVerifyExport'), 600000);
  results.verify = await page.textContent('#exportResult');
  console.log('verify:', results.verify);
  assert(/Passes WCAG/.test(results.verify), 'the export, reordered, passes: ' + results.verify);
  assert(/^Exported 240 frames/.test(results.export) && / copied from the source/.test(results.export), 'every frame of the video, the untouched GOPs copied: ' + results.export);
  results.exported = await page.evaluate(() => window.__unflash.state.exportPlan && window.__unflash.state.exportPlan.sections.map((p) => ({ id: p.sec.id, reordered: p.reordered, slots: p.seq.src.length, distinct: new Set(p.seq.src).size })));
  console.log('the export plan:', JSON.stringify(results.exported));
  assert(results.exported.length === 1 && results.exported[0].reordered && results.exported[0].distinct === results.exported[0].slots, 'the export shows every frame of the section once: ' + JSON.stringify(results.exported));
  const frames = (results.verify.match(/(\d+) frames/) || results.export.match(/(\d+) frames/) || [])[1];
  console.log('frames verified:', frames);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('#exportModal .modal-close, #btnCloseExport') && document.querySelector('#exportModal .modal-close, #btnCloseExport').click());
  await idle(page);

  // original order: every frame back where it was decoded, the K with it
  await page.evaluate(() => {
    const m = document.querySelector('#exportModal');
    if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
  });
  await page.click('#btnOriginalOrder');
  await checked();
  results.original = await sectionNow();
  assert(!results.original.order && !results.original.originalShown && results.original.keep[0] === keepAt && results.original.verdict.startsWith('fails'), 'original order puts every frame back: ' + JSON.stringify(results.original));

  assert(!errors.length, 'no errors on the page: ' + errors.join('\n'));
  console.log('OK reorder');
} catch (e) {
  console.error(e);
  console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await close();
}
