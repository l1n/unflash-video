// The project (web/project.js): sections with their marks and verdicts, as
// the page holds them and as a project file carries them. (What is kept in
// the browser's own database is the browser tests' to check:
// tests/e2e/project.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, Project, dropCaches, matchVideo, projectFileText, projectKey, readProjectFile } from '../../web/project.js';

/** Decoded frames as a section holds them, `bytes` of them; `freed` counts the ones let go. */
const freed = [];
const frames = (bytes, name = '') => ({ byte_length: () => bytes, free: () => freed.push(name) });

const movie = (more = {}) => ({ name: 'film.mp4', file: { size: 1234, lastModified: 99 }, frameCount: 300, duration: 10, width: 640, height: 360, video: { codec: 'vp09.00.21.08' }, medianDelta: 1 / 30, ...more });

test("a project's key is its file's name, size and modified time", () => {
  assert.equal(projectKey({ name: 'a:b.mp4', size: 10, lastModified: 20 }), 'a:b.mp4:10:20');
});

test('a section is kept inside the video and timed to the microsecond', () => {
  const p = new Project('k', [1, 9], []);
  const a = p.addSection(2.00000049, 4.9999996, ['flash']);
  assert.deepEqual([a.id, a.start, a.end, a.kinds, a.custom], [1, 2, 5, ['flash'], false]);
  const b = p.addSection(-5, 1.5, [], true);
  assert.deepEqual([b.id, b.start, b.end, b.custom], [2, 1, 1.5, true]);
  // nothing of it inside the video, or nothing at all: no section
  assert.equal(p.addSection(20, 30), null);
  assert.equal(p.addSection(7, 7), null);
  assert.equal(p.addSection(8, 7), null);
  assert.equal(p.sections.length, 2);
  // a new section starts without marks, frames or verdict
  assert.deepEqual([a.edits, a.keep, a.blend, a.blendStrength, a.prepared, a.check, a.soften], [{}, [], [], null, false, null, false]);
});

test('a range for a section is inside the video, is not empty, and is over no other section', () => {
  const p = new Project('k', [0, 60], []);
  const a = p.addSection(10, 20);
  const b = p.addSection(30, 40);
  // into the video, to the microsecond
  assert.deepEqual(p.rangeFor(-3, 5.0000004), { start: 0, end: 5 });
  assert.deepEqual(p.rangeFor(50, 99), { start: 50, end: 60 });
  // typed past the end of the video, both ends: nothing is left of it (it used to become a section that ended before it began)
  assert.deepEqual(p.rangeFor(70, 80), { why: 'outside' });
  assert.deepEqual(p.rangeFor(60, 61), { why: 'outside' });
  assert.deepEqual(p.rangeFor(-9, 0), { why: 'outside' });
  assert.deepEqual(p.rangeFor(25, 25), { why: 'outside' });
  assert.deepEqual(p.rangeFor(NaN, 5), { why: 'outside' });
  assert.deepEqual(p.rangeFor(45, Infinity), { start: 45, end: 60 });
  // over another section, by any part: the frames there can carry one section's marks only
  assert.deepEqual(p.rangeFor(15, 25), { why: 'overlap', other: a });
  assert.deepEqual(p.rangeFor(5, 10.5), { why: 'overlap', other: a });
  assert.deepEqual(p.rangeFor(12, 13), { why: 'overlap', other: a });
  assert.deepEqual(p.rangeFor(0, 60), { why: 'overlap', other: a });
  assert.deepEqual(p.rangeFor(35, 50), { why: 'overlap', other: b });
  // one that ends where another begins is beside it, not over it
  assert.deepEqual(p.rangeFor(20, 30), { start: 20, end: 30 });
  assert.deepEqual(p.rangeFor(40, 45), { start: 40, end: 45 });
  // a section's own range is not in its way when it is given another
  assert.deepEqual(p.rangeFor(12, 25, a), { start: 12, end: 25 });
  assert.deepEqual(p.rangeFor(12, 35, a), { why: 'overlap', other: b });
  // and a section is added only where a range is given for it; one refused takes no number
  assert.equal(p.addSection(15, 25), null);
  assert.equal(p.addSection(70, 80), null);
  assert.equal(p.addSection(20, 30).id, 3);
  assert.deepEqual(p.sectionsSorted().map((s) => [s.start, s.end]), [[10, 20], [20, 30], [30, 40]]);
});

test('sections are found by number, listed in time order and deleted with their frames', () => {
  const p = new Project('k', [0, 100], []);
  const late = p.addSection(50, 60);
  const early = p.addSection(10, 20);
  assert.equal(p.section(early.id), early);
  assert.equal(p.section(99), null);
  assert.deepEqual(p.sectionsSorted().map((s) => s.id), [early.id, late.id]);
  assert.deepEqual(p.sections.map((s) => s.id), [late.id, early.id], 'the list itself stays as it was made');
  late.cache = frames(10, 'late');
  late.prepared = true;
  freed.length = 0;
  p.deleteSection(late.id);
  assert.deepEqual(freed, ['late']);
  assert.deepEqual(p.sections, [early]);
  p.deleteSection(99); // (one that is not there: nothing happens)
  // numbers are not used twice
  assert.equal(p.addSection(70, 80).id, 3);
});

test("a change to a section makes its neighbours' verdicts stale, as far as their checks reach", () => {
  const p = new Project('k', [0, 100], []);
  const mid = p.addSection(40, 50);
  const near = p.addSection(52, 60);
  const far = p.addSection(70, 80);
  const before = p.addSection(30, 34);
  for (const s of [mid, near, far, before]) s.check = { safe: true, stale: false };
  p.invalidateNeighbours(mid, 6.5);
  assert.deepEqual([mid.check.stale, near.check.stale, far.check.stale, before.check.stale], [false, true, false, true]);
  // a neighbour never checked has nothing to go stale
  near.check = null;
  p.invalidateNeighbours(mid, 6.5);
  assert.equal(near.check, null);
});

test('frames in memory are counted, and the least recently used let go first', () => {
  const p = new Project('k', [0, 100], []);
  const [a, b, c] = [p.addSection(0, 10), p.addSection(20, 30), p.addSection(40, 50)];
  Object.assign(a, { prepared: true, usedAt: 3, cache: frames(100, 'a'), softCache: frames(10, 'a soft'), softKey: 'x' });
  Object.assign(b, { prepared: true, usedAt: 1, cache: frames(100, 'b'), ctx: { lead: frames(20, 'b lead'), tail: frames(20, 'b tail') } });
  Object.assign(c, { prepared: true, usedAt: 2, cache: frames(100, 'c'), blendCache: frames(50, 'c blend'), blendKey: 'y' });
  assert.equal(p.cacheBytes(), 110 + 140 + 150);
  freed.length = 0;
  // down to 260 bytes, the open section (c) not counted among those to drop
  p.evictCaches(c, 260);
  assert.deepEqual(freed, ['b', 'b lead', 'b tail']);
  assert.equal(p.cacheBytes(), 260);
  assert.deepEqual([b.prepared, b.cache, b.ctx], [false, null, null]);
  // the open section stays whatever the budget
  p.evictCaches(c, 0);
  assert.equal(p.cacheBytes(), 150);
  assert.equal(c.prepared, true);
  dropCaches(c);
  assert.deepEqual([c.cache, c.blendCache, c.blendKey, c.prepared], [null, null, null, false]);
  assert.equal(p.cacheBytes(), 0);
});

test('what is kept of a project leaves out the frames, and the scan trace unless asked', () => {
  const p = new Project('k', [0, 100], []);
  p.profile = 'strict';
  const s = p.addSection(10, 20, ['red']);
  Object.assign(s, { edits: { 3: { removed: 'prev' } }, keep: [5], blend: [7], blendStrength: 0.6, soften: true, nFrames: 300, pts: [0, 0.04], cache: frames(10), prepared: true, pattern: { thresh: 9 } });
  s.check = { safe: false, wcag_safe: true, violations: [{ kind: 'extended' }], seq: { t: [0] }, inside: [1], stale: 0 };
  p.scan = { frames: 300, violations: [], trace: { t: new Float64Array([1, 2]) } };
  const kept = p.toSaved();
  assert.deepEqual(Object.keys(kept).sort(), ['nextId', 'profile', 'savedAt', 'scan', 'sections']);
  assert.equal(kept.profile, 'strict');
  assert.equal(kept.nextId, 2);
  assert.ok(Math.abs(kept.savedAt - Date.now()) < 5000);
  assert.equal(kept.scan.trace, undefined);
  assert.ok(p.scan.trace, "the project's own scan keeps its trace");
  assert.deepEqual(p.toSaved({ trace: true }).scan.trace.t, new Float64Array([1, 2]));
  const k = kept.sections[0];
  assert.deepEqual(Object.keys(k).sort(), ['blend', 'blendStrength', 'check', 'custom', 'edits', 'end', 'id', 'keep', 'kinds', 'nFrames', 'order', 'pattern', 'pts', 'soften', 'start', 'warnings']);
  assert.deepEqual([k.edits, k.keep, k.blend, k.blendStrength, k.soften, k.nFrames, k.pts], [{ 3: { removed: 'prev' } }, [5], [7], 0.6, true, 300, [0, 0.04]]);
  // of a verdict, what the page can show again without the frames
  assert.equal(k.check.safe, false);
  assert.equal(k.check.wcag_safe, true);
  assert.equal(k.check.stale, false);
  assert.equal('seq' in k.check, false);
  assert.equal('inside' in k.check, false);
});

test('a project comes back as it was kept, less the frames', () => {
  const p = new Project('k', [0, 100], []);
  const s = p.addSection(10, 20, ['flash', 'pattern']);
  Object.assign(s, { edits: { 3: { extended: true } }, keep: [5], blend: [7], blendStrength: 0, soften: true, nFrames: 250, pts: [0, 0.04], cache: frames(10), prepared: true });
  s.check = { safe: true, violations: [], stale: false };
  p.scan = { frames: 250 };
  const q = new Project('k', [0, 100], []);
  q.restore(JSON.parse(JSON.stringify(p.toSaved())));
  assert.equal(q.sections.length, 1);
  const r = q.sections[0];
  assert.deepEqual([r.id, r.start, r.end, r.kinds, r.edits, r.keep, r.blend, r.blendStrength, r.soften, r.nFrames], [1, 10, 20, ['flash', 'pattern'], { 3: { extended: true } }, [5], [7], 0, true, 250]);
  assert.deepEqual([r.prepared, r.cache, r.softCache, r.blendCache, r.ctx], [false, null, null, null, null]);
  assert.equal(r.check.safe, true);
  assert.deepEqual(q.scan, { frames: 250 });
  assert.equal(q.nextId, 2);
});

test('a project file is text anyone can write: what goes into the page is made safe', () => {
  const p = new Project('k', [0, 100], []);
  p.restore({
    nextId: 1,
    sections: [
      null,
      { id: '<img src=x onerror=alert(1)>', start: 1, end: 2 },
      { id: '7', start: 3, end: 4, kinds: ['flash', '<b>bold</b>', 'pattern', 7], check: { safe: true, seq: { t: [0] }, inside: [{ kind: '<i>' }], before: [{ kind: '<i>' }] } },
      { id: 2, start: 5, end: 6, kinds: 'flash' },
    ],
  });
  assert.deepEqual(p.sections.map((s) => s.id), [7, 2], 'an id is a number, or the section is left out');
  assert.deepEqual(p.sections[0].kinds, ['flash', 'pattern'], 'the kinds a scan names, and no others');
  assert.deepEqual(p.sections[1].kinds, []);
  // only the part of a verdict toSaved keeps comes back: nothing the findings list is drawn from
  assert.deepEqual([p.sections[0].check.seq, p.sections[0].check.inside, p.sections[0].check.before], [undefined, undefined, undefined]);
  // marks default to none
  assert.deepEqual([p.sections[1].edits, p.sections[1].keep, p.sections[1].blend, p.sections[1].blendStrength, p.sections[1].soften, p.sections[1].pattern], [{}, [], [], null, false, null]);
  // the next number is past every one in use, whatever the file says
  assert.equal(p.nextId, 8);
  assert.equal(p.profile, 'wcag_ext');
  assert.equal(p.scan, null);
  // and one with nothing in it is an empty project
  const q = new Project('k', [0, 100], []);
  q.restore({});
  assert.deepEqual([q.sections, q.nextId, q.scan, q.profile], [[], 1, null, 'wcag_ext']);
});

test('a project file with things of the wrong kind in it comes back as a project the page can use', () => {
  // (each of these, kept as it was, stopped the page: at once, at the next draw, or at every later open of the video)
  const p = new Project('k', [0, 100], []);
  p.restore({
    profile: 'x',
    nextId: 'abc',
    scan: 'yes',
    sections: [
      {
        id: 1,
        start: '1',
        end: '2.5',
        edits: { 3: null, 4: { removed: true, fill: 'sideways', extended: 'yes' }, x: { removed: true }, '-1': { removed: true }, 5: 7, '06': { removed: true }, 7: { extended: true, fill: 'next', more: 1 }, 8: {} },
        keep: 5,
        blend: [1, '2', -1, 2.5, 3, 3],
        blendStrength: 'full',
        pts: [0, 'a'],
        nFrames: -3,
        warnings: 5,
        pattern: 'stripes',
        check: 'safe',
        custom: 'yes',
        soften: 1,
        order: [0, 1, 1],
      },
      { id: 2, start: 5, end: 5 },
      { id: 3, start: 9, end: 8 },
      { id: 4, start: null, end: 3 },
      { id: 5, start: 6, end: Infinity },
      { id: 6, start: 'soon', end: 7 },
      { id: 1, start: 20, end: 30 },
      { id: 8, start: 40, end: 50, order: [1, 0], edits: [1, 2], pts: new Float64Array([0, 0.04]), nFrames: 2, warnings: ['a note', 7], pattern: { period: 4 }, blendStrength: 0.5, check: { safe: false, violations: [{ kind: 'flash' }, null], after: [] } },
      { id: 9, start: 60, end: 70, order: [2, 'x'], check: { safe: true, violations: [{ kind: 'flash' }], context_notes: 'none', flagged: [1, 2] } },
      'section',
      7,
    ],
  });
  assert.deepEqual([p.profile, p.nextId, p.scan], ['wcag_ext', 10, null]);
  // a section with no range that is one is left out, and so is a second one under a number in use
  assert.deepEqual(p.sections.map((s) => [s.id, s.start, s.end]), [[1, 1, 2.5], [8, 40, 50], [9, 60, 70]]);
  const [a, b, c] = p.sections;
  // marks: frame numbers, each with what a mark can say and nothing else
  assert.deepEqual(a.edits, { 4: { removed: true }, 7: { extended: true, fill: 'next' }, 8: {} });
  assert.deepEqual([a.keep, a.blend, a.blendStrength, a.pts, a.nFrames, a.warnings, a.pattern, a.check, a.custom, a.soften], [[], [1, 3], null, null, 0, [], null, null, true, true]);
  assert.deepEqual([b.edits, Array.from(b.pts), b.nFrames, b.warnings, b.pattern, b.blendStrength], [{}, [0, 0.04], 2, ['a note'], { period: 4 }, 0.5]);
  // a reorder: frame numbers, each once (a frame shown twice, or a number that is none, is no reorder)
  assert.deepEqual([a.order, b.order, c.order], [null, [1, 0], null]);
  // a verdict whose lists are not lists of findings is no verdict (the section shows as unchecked)
  assert.equal(b.check, null);
  assert.equal(c.check, null);
  // and what the page keeps of the wrong kind at the top is an empty project of the default profile
  for (const kept of [null, 7, 'project', [], { sections: 'none' }, { sections: {} }]) {
    const q = new Project('k', [0, 100], []);
    q.restore(kept);
    assert.deepEqual([q.sections, q.nextId, q.scan, q.profile], [[], 1, null, 'wcag_ext'], JSON.stringify(kept));
  }
  // a scan comes back with the parts that are what they should be: a summary that cannot be drawn is none
  const q = new Project('k', [0, 100], []);
  q.restore({ profile: 'strict', scan: { sig: 'abc', safe: true, summary: { bin: 1, t0: 0, general: 'many', red: [] }, warnings: 'none' }, sections: [] });
  assert.deepEqual([q.profile, q.scan], ['strict', { sig: 'abc', safe: true, warnings: 'none' }]);
  q.restore({ scan: { summary: { bin: 1, t0: 0, general: [0, 2], red: [0, 0], pattern: [0, 1] } }, sections: [] });
  assert.deepEqual(q.scan.summary, { bin: 1, t0: 0, general: [0, 2], red: [0, 0], pattern: [0, 1] });
  // the profiles a project can name are the ones the page offers
  assert.deepEqual(PROFILES, ['wcag_ext', 'wcag', 'strict']);
});

test('a project file carries the project and its video, arrays of numbers as they are', () => {
  const p = new Project('k', [0, 10], []);
  const s = p.addSection(1, 2, ['flash']);
  s.edits = { 4: { removed: 'next' } };
  const t = Float64Array.from({ length: 70000 }, (_, i) => i / 30);
  p.scan = { frames: 70000, trace: { t, hazard: new Uint16Array([0, 65535, 7]), lum: new Float32Array([0.5, -1.25]), bytes: new Uint8Array([255, 0, 128]) } };
  const text = projectFileText(p, movie());
  const doc = JSON.parse(text);
  assert.deepEqual([doc.kind, doc.version], ['unflash-project', 1]);
  assert.ok(!Number.isNaN(Date.parse(doc.saved)));
  assert.deepEqual(doc.video, { name: 'film.mp4', size: 1234, lastModified: 99, frames: 300, duration: 10, width: 640, height: 360, codec: 'vp09.00.21.08' });
  assert.equal(doc.project.scan.trace.t.$typed, 'Float64Array');
  const back = readProjectFile(text);
  assert.deepEqual(back.video, doc.video);
  const trace = back.saved.scan.trace;
  assert.ok(trace.t instanceof Float64Array && trace.hazard instanceof Uint16Array && trace.lum instanceof Float32Array && trace.bytes instanceof Uint8Array);
  assert.deepEqual(trace.t, t);
  assert.deepEqual(trace.hazard, new Uint16Array([0, 65535, 7]));
  assert.deepEqual(trace.lum, new Float32Array([0.5, -1.25]));
  assert.deepEqual(trace.bytes, new Uint8Array([255, 0, 128]));
  assert.deepEqual(back.saved.sections[0].edits, { 4: { removed: 'next' } });
  // and the project it gives is the one that was saved
  const q = new Project('k', [0, 10], []);
  q.restore(back.saved);
  assert.deepEqual([q.sections[0].id, q.sections[0].start, q.sections[0].end, q.sections[0].kinds], [1, 1, 2, ['flash']]);
});

test('an array that is a view of part of a buffer is saved as that part alone', () => {
  const whole = new Float64Array([1, 2, 3, 4, 5]);
  const p = new Project('k', [0, 10], []);
  p.scan = { trace: { t: whole.subarray(1, 4) } };
  assert.deepEqual(readProjectFile(projectFileText(p, movie())).saved.scan.trace.t, new Float64Array([2, 3, 4]));
});

test('a file that is no project file says so, in words', () => {
  const doc = (more) => JSON.stringify({ kind: 'unflash-project', version: 1, video: {}, project: { sections: [] }, ...more });
  assert.deepEqual(readProjectFile(doc({})), { video: {}, saved: { sections: [] } });
  assert.throws(() => readProjectFile('not json at all'), /^Error: This is not an Unflash project file \(/);
  assert.throws(() => readProjectFile(''), /not an Unflash project file/);
  assert.throws(() => readProjectFile('null'), /^Error: This is not an Unflash project file\.$/);
  assert.throws(() => readProjectFile('[]'), /not an Unflash project file\.$/);
  assert.throws(() => readProjectFile(doc({ kind: 'something-else' })), /not an Unflash project file\.$/);
  assert.throws(() => readProjectFile(doc({ project: null })), /not an Unflash project file\.$/);
  assert.throws(() => readProjectFile(doc({ video: null })), /not an Unflash project file\.$/);
  assert.throws(() => readProjectFile(doc({ version: 2 })), /comes from a newer Unflash/);
  assert.throws(() => readProjectFile(doc({ project: { sections: {} } })), /has no sections list/);
  assert.throws(() => readProjectFile(doc({ project: { sections: [], x: { $typed: 'Function', b64: '' } } })), /not an Unflash project file \(an array of an unknown type \(Function\)\)/);
  assert.throws(() => readProjectFile(doc({ project: { sections: [], x: { $typed: 'Uint8Array', b64: '*not base64*' } } })), /not an Unflash project file \(/);
});

test("a project file's marks are on frames: it fits a video with the same frames and length", () => {
  const fp = { name: 'film.mp4', size: 1234, frames: 300, duration: 10 };
  assert.deepEqual(matchVideo(fp, movie()), { ok: true, same: true });
  // the same film under another name, or encoded again: its frames are the same
  assert.deepEqual(matchVideo({ ...fp, name: 'copy.mp4' }, movie()), { ok: true, same: false });
  assert.deepEqual(matchVideo({ ...fp, size: 99 }, movie()), { ok: true, same: false });
  // lengths within a frame of each other count as the same
  assert.equal(matchVideo({ ...fp, duration: 10.03 }, movie()).ok, true);
  const longer = matchVideo({ ...fp, duration: 10.04 }, movie());
  assert.equal(longer.ok, false);
  assert.match(longer.why, /film\.mp4 \(300 frames, 10\.040 s\).*300 frames and lasts 10\.000 s/);
  const fewer = matchVideo({ ...fp, frames: 299 }, movie());
  assert.deepEqual([fewer.ok, fewer.same], [false, true]);
  assert.match(fewer.why, /299 frames/);
  // a file that says nothing of its video's length does not fit one of any length
  assert.equal(matchVideo({ name: 'film.mp4', size: 1234, frames: 300 }, movie()).ok, false);
});
