// The small modules: which decoder is built in for a codec (web/codecs.js),
// what the page keeps between visits (web/storage.js), the timings a scan
// reports (web/profile.js), and how many decode workers run (web/h264pool.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { builtInFor, keptLoad } from '../../web/codecs.js';
import { stored, store } from '../../web/storage.js';
import { profile } from '../../web/profile.js';
import { defaultWorkerCount } from '../../web/h264pool.js';

test('a codec string names the built-in decoder of its family, if there is one', () => {
  const id = (codec) => (builtInFor(codec) || { id: null }).id;
  assert.equal(id('avc1.64001f'), 'h264');
  assert.equal(id('avc3.42e01e'), 'h264');
  assert.equal(id('hev1.1.6.L93.B0'), 'hevc');
  assert.equal(id('hvc1.2.4.L120.B0'), 'hevc');
  assert.equal(id('vp09.00.31.08'), 'vp9');
  assert.equal(id('vp8'), 'vp8');
  assert.equal(id('av01.0.08M.08'), 'av1');
  // WebCodecs' names, to the letter: no other spelling, and nothing for what is not video
  for (const other of ['vp9', 'AVC1.64001f', 'mp4v.20.9', 'mp4a.40.2', '', null, undefined]) assert.equal(id(other), null, String(other));
  assert.equal(builtInFor('hev1.1.6.L93.B0').name, 'HEVC');
});

test('what the page keeps lasts in the browser, and is done without where storage is blocked', () => {
  // (no storage at all, as in Node: reads find nothing, writes are dropped)
  assert.equal(typeof localStorage, 'undefined');
  assert.equal(stored('unflash:test'), null);
  store('unflash:test', 'x');
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)) };
  try {
    assert.equal(stored('unflash:test'), null);
    store('unflash:test', 7);
    assert.equal(stored('unflash:test'), '7');
    // storage that refuses (a private window, a full disk)
    globalThis.localStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('full');
      },
    };
    assert.equal(stored('unflash:test'), null);
    store('unflash:test', 'y');
  } finally {
    delete globalThis.localStorage;
  }
});

test("a scan's operations are summed, the costliest first, with the cost a frame where that means something", () => {
  profile.reset();
  profile.add('read', 2);
  profile.add('read', 6);
  profile.add('decode', 30, 10);
  profile.add('gpu.latency', 100);
  profile.note('route', 'yuv');
  const read = profile.ops.get('read');
  assert.deepEqual([read.n, read.ms, read.max], [2, 8, 6]);
  assert.deepEqual([profile.ops.get('decode').n, profile.ops.get('decode').max], [10, 30]);
  const lines = profile.summary(10).split('\n');
  assert.deepEqual(lines.map((l) => l.trim().split(/\s+/)[0]), ['gpu.latency', 'decode', 'read']);
  // a latency overlaps other work: no cost a frame for it
  assert.doesNotMatch(lines[0], /ms\/frame/);
  assert.match(lines[1], /30 ms total · 3\.00 ms\/call · 10 calls · max 30\.0 ms · 3\.00 ms\/frame$/);
  assert.match(lines[2], /8 ms total · 4\.00 ms\/call · 2 calls · max 6\.0 ms · 0\.80 ms\/frame$/);
  assert.doesNotMatch(profile.summary(), /ms\/frame/);
  const text = profile.text('scan', 300, 2000);
  assert.match(text, /^scan: 300 frames in 2\.00 s = 150\.0 fps\n  route: yuv\n/);
  assert.equal(profile.text('scan', 0, 0).split('\n')[0], 'scan');
  profile.reset();
  assert.equal(profile.summary(), '');
});

test('decode workers: one for each core but one, six at most, or as many as the address asks for', () => {
  const cores = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'hardwareConcurrency') || Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency');
  const withCores = (n, search = '') => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: n, configurable: true });
    globalThis.location = { search };
    try {
      return defaultWorkerCount();
    } finally {
      delete globalThis.location;
      delete navigator.hardwareConcurrency;
    }
  };
  assert.ok(cores, 'this Node has a navigator');
  assert.equal(withCores(1), 1);
  assert.equal(withCores(4), 3);
  assert.equal(withCores(8), 6);
  assert.equal(withCores(64), 6);
  assert.equal(withCores(8, '?workers=3'), 3);
  assert.equal(withCores(2, '?workers=40'), 16);
  // a number that is none: by the cores
  assert.equal(withCores(4, '?workers=0'), 3);
  assert.equal(withCores(4, '?workers=many'), 3);
});

test('a module is loaded once and kept, but a load that failed is tried again', async () => {
  // (the decoders module, fetched when a film first needs it: with the network down for that one moment,
  // every film after it used to fail the same way until the page was loaded again)
  const outcomes = [new Error('offline'), new Error('still offline'), { name: 'the module' }];
  let loads = 0;
  const load = keptLoad(async () => {
    const o = outcomes[loads++];
    if (o instanceof Error) throw o;
    return o;
  });
  // asked twice before the first load ends: one load, one promise
  const [a, b] = [load(), load()];
  assert.equal(a, b);
  await assert.rejects(a, /^Error: offline$/);
  assert.equal(loads, 1);
  // it failed: the next one who asks sets off another
  await assert.rejects(load(), /^Error: still offline$/);
  assert.equal(loads, 2);
  const mod = await load();
  assert.deepEqual([mod, loads], [{ name: 'the module' }, 3]);
  // and once loaded it is kept
  assert.equal(await load(), mod);
  assert.equal(await load(), mod);
  assert.equal(loads, 3);
});
