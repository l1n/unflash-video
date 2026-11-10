// The pool of built-in decoder workers (web/h264pool.js): how a range of
// samples is cut into groups for them, and the pass that hands the groups
// out and the pictures on, in order, whatever the workers do. The workers
// here are stand-ins that keep softworker.js's side of the protocol (a
// picture for each sample asked for, one credit each, `done` to end every
// job) and can be told to fail, damage a picture or never start.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftwarePool } from '../../web/h264pool.js';

class FakeWorker {
  static all = [];
  /** What the workers made from now on do wrong: { init: message } | { failAt: pts, error } | { damaged: [pts] }. */
  static faults = {};

  constructor() {
    this.faults = FakeWorker.faults;
    this.listeners = new Set();
    this.sent = [];
    this.credits = 0;
    this.cancelled = false;
    this.terminated = false;
    this.job = null;
    this.made = 0; // pictures sent
    FakeWorker.all.push(this);
  }
  addEventListener(type, h) {
    if (type === 'message') this.listeners.add(h);
  }
  removeEventListener(type, h) {
    this.listeners.delete(h);
  }
  terminate() {
    this.terminated = true;
  }
  /** (as from a real worker: in a turn of its own, in the order sent) */
  postMessage(m) {
    this.sent.push(m);
    setImmediate(() => this.terminated || this.take(m));
  }
  emit(data) {
    if (!this.terminated) for (const h of [...this.listeners]) h({ data });
  }
  take(m) {
    if (m.type === 'init') this.emit(this.faults.init ? { type: 'error', message: this.faults.init } : { type: 'ready' });
    else if (m.type === 'credit') this.credits = m.reset ? m.n : this.credits + m.n;
    else if (m.type === 'cancel') this.cancelled = true;
    else if (m.type === 'decode') {
      this.cancelled = false;
      // the pictures of its samples that are asked for, as a decoder puts them out: in the order shown
      const todo = Array.from(m.pts).filter((t) => t >= m.minPts && t < m.maxPts).sort((a, b) => a - b);
      this.job = { id: m.id, todo, shrink: m.shrink, damaged: 0, decoded: 0 };
    }
    this.work();
  }
  work() {
    const j = this.job;
    if (!j) return;
    while (j.todo.length && !this.cancelled) {
      if (j.todo[0] === this.faults.failAt) {
        this.job = null;
        this.emit({ type: 'done', id: j.id, damaged: 0, decodeMs: 0, decoded: 0, error: this.faults.error });
        return;
      }
      if (this.credits <= 0) return; // the page has to take some first
      this.credits--;
      const timestamp = j.todo.shift();
      const damaged = (this.faults.damaged || []).includes(timestamp);
      j.damaged += damaged ? 1 : 0;
      j.decoded++;
      this.made++;
      this.emit({ type: 'frame', id: j.id, pic: { kind: 'rgba', data: new Uint8Array(4), width: j.shrink.aw, height: j.shrink.ah, timestamp, colorSpace: null, from: [640, 360], damaged } });
    }
    this.job = null;
    this.emit({ type: 'done', id: j.id, damaged: j.damaged, decodeMs: 1, decoded: j.decoded });
  }
  /** The messages of one type it was sent. */
  got(type) {
    return this.sent.filter((m) => m.type === type);
  }
}

/** A film of `n` samples, 25 a second, a keyframe every `gop`; `pts` (µs) may be given, in decode order. */
function film(n, gop, pts = null) {
  const v = {
    pts: pts ? Float64Array.from(pts) : Float64Array.from({ length: n }, (_, i) => i * 40000),
    sync: Uint8Array.from({ length: n }, (_, i) => (i % gop === 0 ? 1 : 0)),
    offset: Float64Array.from({ length: n }, (_, i) => i * 100),
    size: new Uint32Array(n).fill(100),
  };
  return { v, video: { codec: 'avc1.640028', index: 0 }, dx: { track_description: () => new Uint8Array(3) }, file: { name: 'film.mp4' }, ts: null, width: 640, height: 360 };
}

/** A pool of `size` stand-in workers over `movie`, the workers faulty as `faults` says. */
async function pool(movie, size, faults = {}) {
  FakeWorker.all = [];
  FakeWorker.faults = faults;
  globalThis.Worker = FakeWorker;
  try {
    return await SoftwarePool.create(movie, size);
  } finally {
    delete globalThis.Worker;
  }
}

const SMALL = { raw: true, shrink: { aw: 256, ah: 144 } };
/** The whole of samples [a, b) as one stretch. */
const stretch = (movie, a, b) => ({ startIdx: a, endIdx: b, startSec: movie.v.pts[a] / 1e6, endSec: b < movie.v.pts.length ? movie.v.pts[b] / 1e6 : Infinity });
/** `stretches`, handed out one at a time. */
const each = (stretches) => {
  const left = [...stretches];
  return () => left.shift() || null;
};

test('a range is cut into groups at keyframes, each with the pictures that are shown before the next', () => {
  const movie = film(32, 8);
  const p = new SoftwarePool(movie, [], null);
  const t = (i) => i * 40000;
  assert.deepEqual(p.groups(0, 32), [
    { a: 0, ext: 8, minPts: t(0), maxPts: t(8) },
    { a: 8, ext: 16, minPts: t(8), maxPts: t(16) },
    { a: 16, ext: 24, minPts: t(16), maxPts: t(24) },
    { a: 24, ext: 32, minPts: t(24), maxPts: Infinity },
  ]);
  // part of the film; a range that ends inside a group
  assert.deepEqual(p.groups(8, 20), [
    { a: 8, ext: 16, minPts: t(8), maxPts: t(16) },
    { a: 16, ext: 20, minPts: t(16), maxPts: Infinity },
  ]);
  assert.deepEqual(p.groups(8, 8), [{ a: 8, ext: 8, minPts: t(8), maxPts: Infinity }]);
  // keyframes closer than four samples are not worth a group of their own
  const dense = film(12, 2);
  assert.deepEqual(new SoftwarePool(dense, [], null).groups(0, 12).map((g) => [g.a, g.ext]), [[0, 4], [4, 8], [8, 12]]);

  // an open GOP: the two pictures after the second keyframe are shown before it (decode order I P P P, I b b P)
  const open = film(8, 4, [0, 1, 2, 3, 6, 4, 5, 7].map(t));
  assert.deepEqual(new SoftwarePool(open, [], null).groups(0, 8), [
    // they need the first group's pictures: it decodes on through them, and keeps what is shown before the keyframe
    { a: 0, ext: 7, minPts: t(0), maxPts: t(6) },
    // the second group decodes them too, and drops them
    { a: 4, ext: 8, minPts: t(6), maxPts: Infinity },
  ]);
});

test('the pictures each worker may hold: a share of a memory budget, within bounds', () => {
  const withMemory = (gb, fn) => {
    Object.defineProperty(navigator, 'deviceMemory', { value: gb, configurable: true });
    try {
      return fn();
    } finally {
      delete navigator.deviceMemory;
    }
  };
  const sized = (width, height, workers) => new SoftwarePool({ width, height }, new Array(workers), null);
  // 4 GB: 384 MB for all the workers' pictures, whole ones at a byte and a half a pixel
  assert.equal(withMemory(4, () => sized(1920, 1080, 4).window()), 32);
  assert.equal(withMemory(4, () => sized(3840, 2160, 6).window()), 5);
  // never fewer than four, never more than 256
  assert.equal(withMemory(4, () => sized(7680, 4320, 6).window()), 4);
  assert.equal(withMemory(4, () => sized(320, 240, 1).window()), 256);
  // the budget is 96 MB a gigabyte, from 192 MB to 768 MB
  assert.equal(withMemory(0.5, () => sized(1920, 1080, 4).window()), 16);
  assert.equal(withMemory(8, () => sized(1920, 1080, 4).window()), 64);
  assert.equal(withMemory(64, () => sized(1920, 1080, 4).window()), 64);
  // pictures made small cost four bytes a pixel of the small size: 64 to 512 of them
  assert.equal(withMemory(4, () => sized(3840, 2160, 2).window({ aw: 256, ah: 144 })), 512);
  assert.equal(withMemory(4, () => sized(3840, 2160, 6).window({ aw: 1024, ah: 768 })), 64);
  assert.equal(withMemory(4, () => sized(3840, 2160, 6).window({ aw: 512, ah: 384 })), 85);
});

test('every picture reaches the page once, in the order shown, across groups, workers and stretches', async () => {
  const movie = film(96, 8);
  const p = await pool(movie, 3);
  const seen = [];
  const asked = [];
  const stretches = [stretch(movie, 0, 40), stretch(movie, 40, 96)];
  const next = each(stretches);
  const frames = await p.decodeStretches(
    () => {
      asked.push(seen.length);
      return next();
    },
    (pic, t) => {
      assert.deepEqual([pic.kind, pic.codedWidth, pic.codedHeight, pic.timestamp / 1e6], ['rgba', 256, 144, t]);
      seen.push(Math.round(t * 25));
    },
    { ...SMALL, onStretchDone: (s) => seen.push(`end of ${stretches.indexOf(s)}`) }
  );
  assert.equal(frames, 96);
  const order = Array.from({ length: 96 }, (_, i) => i);
  assert.deepEqual(seen, [...order.slice(0, 40), 'end of 0', ...order.slice(40), 'end of 1']);
  // the second stretch was asked for only once a worker had nothing left of the first, and the end only after that
  assert.equal(asked.length, 3);
  assert.equal(asked[0], 0);
  // every worker did some of it, was given this pass's window to start with and a credit for each picture taken
  const window = p.window(SMALL.shrink);
  for (const w of FakeWorker.all) {
    assert.ok(w.made > 0);
    assert.deepEqual(w.got('credit')[0], { type: 'credit', n: window, reset: true });
    assert.equal(w.got('credit').length - 1, w.made);
    // and at the end was told to stop, and is listened to no more
    assert.equal(w.got('cancel').length, 1);
    assert.equal(w.listeners.size, 0);
  }
  assert.equal(FakeWorker.all.reduce((n, w) => n + w.made, 0), 96);
  // each group went to one worker, with its samples' places in the file
  const jobs = FakeWorker.all.flatMap((w) => w.got('decode')).sort((a, b) => a.id - b.id);
  assert.deepEqual(jobs.map((j) => [j.id, j.offset[0], j.offset.length, j.minPts, j.maxPts]).slice(0, 3), [[0, 0, 8, 0, 320000], [1, 800, 8, 320000, 640000], [2, 1600, 8, 640000, 960000]]);
  assert.deepEqual([jobs.length, jobs[0].shrink, jobs[0].file, jobs[0].ts], [12, SMALL.shrink, movie.file, null]);
  assert.equal(p.busy, false);
});

test("an open GOP's leading pictures reach the page once, from the group that has what they refer to", async () => {
  // decode order I P P P, I b b P, I b b P: the b pictures are shown before the keyframe they follow
  const movie = film(12, 4, [0, 1, 2, 3, 6, 4, 5, 7, 10, 8, 9, 11].map((i) => i * 40000));
  const p = await pool(movie, 2);
  const seen = [];
  assert.equal(await p.decodeRange(0, 12, 0, Infinity, (pic, t) => seen.push(Math.round(t * 25)), SMALL), 12);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // (the first group was given the second keyframe and its two leading pictures to decode: seven samples)
  const jobs = FakeWorker.all.flatMap((w) => w.got('decode')).sort((a, b) => a.id - b.id);
  assert.deepEqual(jobs.map((j) => j.pts.length), [7, 7, 4]);
});

test('a stretch keeps the pictures shown in its span, and the worker has its credit back for the rest', async () => {
  const movie = film(48, 8);
  const p = await pool(movie, 2);
  const seen = [];
  // from the keyframe before 0.44 s (sample 8) to sample 24, for what is shown from sample 11 up to sample 20
  const frames = await p.decodeRange(8, 24, 11 / 25, 20 / 25, (pic, t) => seen.push(Math.round(t * 25)), SMALL);
  assert.deepEqual([frames, seen], [9, [11, 12, 13, 14, 15, 16, 17, 18, 19]]);
  assert.deepEqual(FakeWorker.all.map((w) => [w.made, w.got('credit').length - 1]), [[8, 8], [8, 8]]);
});

test('one worker takes the groups one after another, and the next stretch only when it has none', async () => {
  const movie = film(48, 8);
  const p = await pool(movie, 1);
  const log = [];
  const next = each([stretch(movie, 0, 16), stretch(movie, 16, 32), stretch(movie, 32, 48)]);
  await p.decodeStretches(() => (log.push('next'), next()), (pic, t) => log.push(Math.round(t * 25)), SMALL);
  // (a worker works ahead of the page by a group: the pictures of one wait while it decodes the next)
  assert.deepEqual(log.filter((x) => x === 'next').length, 4);
  assert.deepEqual(log.filter((x) => x !== 'next'), Array.from({ length: 48 }, (_, i) => i));
  assert.ok(log.indexOf('next', 1) > log.indexOf(0), 'the second stretch is not asked for before the first is under way');
});

test('a worker that fails ends the pass where it failed; the pictures before that were handed on, and the pool goes on without it', async () => {
  const movie = film(48, 8);
  const p = await pool(movie, 2, { failAt: 21 * 40000, error: 'unreachable' });
  const seen = [];
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await assert.rejects(p.decodeRange(0, 48, 0, Infinity, (pic, t) => seen.push(Math.round(t * 25)), SMALL), /^Error: the built-in decoder failed: unreachable$/);
    // every picture up to the one it failed at (those of its own group that it had made, too), and none after
    assert.deepEqual(seen, Array.from({ length: 21 }, (_, i) => i));
    assert.deepEqual(warned, ['built-in H.264 decoder: unreachable']);
    // its module is not to be trusted after that: stopped and gone
    const [gone, kept] = FakeWorker.all[0].terminated ? FakeWorker.all : [...FakeWorker.all].reverse();
    assert.deepEqual([gone.terminated, kept.terminated, p.workers, p.busy], [true, false, [kept], false]);

    // the next pass has one worker (which fails at the same picture), and then the pool has none
    seen.length = 0;
    await assert.rejects(p.decodeRange(0, 48, 0, Infinity, (pic, t) => seen.push(Math.round(t * 25)), SMALL), /the built-in decoder failed/);
    assert.equal(seen.length, 21);
    assert.deepEqual(p.workers, []);
    await assert.rejects(p.decodeRange(0, 48, 0, Infinity, () => {}, SMALL), /^Error: the decoder pool has no workers left$/);
  } finally {
    console.warn = warn;
  }
});

test('a damaged picture is handed on marked so, or with `strict` fails the pass where it is', async () => {
  const movie = film(24, 8);
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const p = await pool(movie, 2, { damaged: [10 * 40000, 11 * 40000] });
    const marked = [];
    assert.equal(await p.decodeRange(0, 24, 0, Infinity, (pic, t) => pic.damaged && marked.push(Math.round(t * 25)), SMALL), 24);
    assert.deepEqual([marked, warned], [[10, 11], ['built-in H.264 decoder: 2 damaged pictures']]);

    const seen = [];
    await assert.rejects(p.decodeRange(0, 24, 0, Infinity, (pic, t) => seen.push(Math.round(t * 25)), { ...SMALL, strict: true }), /^Error: the built-in H\.264 decoder damaged the picture at 0\.400 s$/);
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // one that is damaged but not shown in the span still fails a strict pass, at the end of its group
    await assert.rejects(p.decodeRange(8, 24, 12 / 25, Infinity, () => {}, { ...SMALL, strict: true }), /^Error: the built-in decoder damaged 2 pictures$/);
    assert.equal(p.busy, false);
  } finally {
    console.warn = warn;
  }
});

test('a pass that is cancelled stops handing on, waits for its workers, and leaves the pool ready', async () => {
  const movie = film(96, 8);
  const p = await pool(movie, 3);
  const seen = [];
  const frames = await p.decodeRange(0, 96, 0, Infinity, (pic, t) => seen.push(Math.round(t * 25)), { ...SMALL, cancel: () => seen.length >= 10 });
  assert.deepEqual([frames, seen.length, p.busy], [10, 10, false]);
  // every job handed out was answered before the pass ended
  for (const w of FakeWorker.all) assert.deepEqual([w.job, w.got('cancel').length, w.listeners.size], [null, 1, 0]);
  // and the next pass starts clean: this pass's window, every picture
  seen.length = 0;
  assert.equal(await p.decodeRange(0, 96, 0, Infinity, (pic, t) => seen.push(Math.round(t * 25)), SMALL), 96);
  assert.deepEqual(seen, Array.from({ length: 96 }, (_, i) => i));
});

test('one pass at a time; a pool closed under a pass ends it', async () => {
  const movie = film(96, 8);
  const p = await pool(movie, 2);
  let second = null;
  let closing = null;
  const seen = [];
  const pass = p.decodeRange(0, 96, 0, Infinity, (pic, t) => {
    seen.push(Math.round(t * 25));
    // (refused at once: the refusal is taken where it is made)
    if (seen.length === 1) second = assert.rejects(p.decodeRange(0, 8, 0, Infinity, () => {}, SMALL), /^Error: the decoder pool is busy$/);
    if (seen.length === 20) closing = p.close();
  }, SMALL);
  await assert.rejects(pass, /^Error: the decoder pool was closed$/);
  await second;
  assert.equal(closing, undefined);
  assert.ok(seen.length >= 20 && seen.length < 96, `${seen.length} pictures`);
  assert.deepEqual(seen, Array.from({ length: seen.length }, (_, i) => i));
  assert.ok(FakeWorker.all.every((w) => w.terminated));
  assert.deepEqual([p.workers, p.busy], [[], false]);
  await assert.rejects(p.decodeRange(0, 8, 0, Infinity, () => {}, SMALL), /^Error: the decoder pool was closed$/);
  globalThis.Worker = FakeWorker;
  try {
    assert.equal(await p.grow(), false);
  } finally {
    delete globalThis.Worker;
  }
});

test('a worker the pool gains during a pass takes groups of it', async () => {
  const movie = film(160, 8);
  const p = await pool(movie, 1);
  const seen = [];
  let grown = null;
  globalThis.Worker = FakeWorker;
  try {
    const frames = await p.decodeRange(0, 160, 0, Infinity, (pic, t) => {
      seen.push(Math.round(t * 25));
      if (seen.length === 4) grown = p.grow();
    }, SMALL);
    assert.equal(frames, 160);
    assert.equal(await grown, true);
    assert.deepEqual(seen, Array.from({ length: 160 }, (_, i) => i));
    const [first, joined] = FakeWorker.all;
    assert.deepEqual([p.workers.length, FakeWorker.all.length], [2, 2]);
    assert.ok(joined.made > 0 && first.made + joined.made === 160, `${first.made} + ${joined.made}`);
    assert.deepEqual(joined.got('credit')[0], { type: 'credit', n: p.window(SMALL.shrink), reset: true });
    assert.equal(joined.listeners.size, 0);

    // one that cannot start is not taken on
    FakeWorker.faults = { init: 'no WebAssembly here' };
    assert.equal(await p.grow(), false);
    assert.deepEqual([p.workers.length, FakeWorker.all.length, FakeWorker.all[2].terminated], [2, 3, true]);
  } finally {
    delete globalThis.Worker;
  }
});

test('a pool is made only of workers that can decode the film', async () => {
  const movie = film(8, 8);
  await assert.rejects(SoftwarePool.create(movie, 2), /^Error: Web Workers are not available$/);
  await assert.rejects(pool({ ...movie, video: { codec: 'theora', index: 0 } }, 2), /^Error: there is no built-in decoder for theora$/);
  assert.equal(FakeWorker.all.length, 0);
  // each is told the track's record and the decoder to use
  const p = await pool(movie, 2);
  assert.deepEqual(FakeWorker.all.map((w) => w.sent[0]), new Array(2).fill({ type: 'init', desc: new Uint8Array(3), codec: 'h264' }));
  assert.deepEqual([p.workers.length, p.codec.name, p.busy], [2, 'H.264', false]);
  // one that cannot start: no pool, and none of them left running
  await assert.rejects(pool(movie, 3, { init: 'no WebAssembly here' }), /^Error: no WebAssembly here$/);
  assert.deepEqual(FakeWorker.all.map((w) => w.terminated), [true, true, true]);
});
