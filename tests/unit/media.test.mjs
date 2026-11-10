// The small things a decode leans on (web/media.js): reading sample bytes
// out of a file, a wait that an event ends, which samples a stretch of
// time needs decoded, and how a picture's planes are described to the
// detector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkReader, frameSize, orTimeout, rawPicture, sampleRange, shown, smallSize, waker, yuvLayoutWords } from '../../web/media.js';

/** A file of `size` bytes, each its own offset's low byte, that notes every read of it (and fails the first `failures`). */
function file(size, { failures = 0 } = {}) {
  const f = {
    size,
    reads: [],
    slice(a, b) {
      return {
        async arrayBuffer() {
          f.reads.push([a, b]);
          if (failures-- > 0) throw new Error('the file could not be read');
          return Uint8Array.from({ length: Math.max(0, Math.min(b, size) - a) }, (_, i) => (a + i) & 255).buffer;
        },
      };
    },
  };
  return f;
}

test('a small file is read whole, once, whoever reads it', async () => {
  const f = file(1000);
  const reader = new ChunkReader(f);
  const other = reader.fork();
  const [a, b] = await Promise.all([reader.read(10, 4), other.read(500, 2)]);
  assert.deepEqual([Array.from(a), Array.from(b)], [[10, 11, 12, 13], [244, 245]]);
  assert.deepEqual(Array.from(await other.fork().read(999, 1)), [231]);
  assert.deepEqual(f.reads, [[0, 1000]]);
  // until it is told to forget what it read
  reader.release();
  await reader.read(0, 1);
  assert.equal(f.reads.length, 2);
});

test('a large file is read through a window that follows the reads, one to each reader', async () => {
  const f = file(1000);
  const reader = new ChunkReader(f, 100, 500);
  assert.deepEqual(Array.from(await reader.read(10, 3)), [10, 11, 12]);
  // inside the window: no read; past it: a new window from there
  assert.deepEqual(Array.from(await reader.read(105, 5)), [105, 106, 107, 108, 109]);
  assert.deepEqual(Array.from(await reader.read(111, 200)).length, 200);
  assert.deepEqual(f.reads, [[10, 110], [111, 311]]);
  // a fork reads elsewhere without moving this one's window
  const fork = reader.fork();
  await fork.read(900, 10);
  await reader.read(120, 10);
  assert.deepEqual(f.reads.slice(2), [[900, 1000]]);
  // a read that runs past the end of the file comes short
  assert.equal((await fork.read(995, 10)).length, 5);
});

test('a read that fails is tried again by the next, for a small file as for a large one', async () => {
  const small = file(1000, { failures: 1 });
  const reader = new ChunkReader(small);
  await assert.rejects(reader.read(0, 4), /could not be read/);
  assert.deepEqual(Array.from(await reader.read(0, 4)), [0, 1, 2, 3]);
  assert.equal(small.reads.length, 2);
  const large = file(1000, { failures: 1 });
  const windowed = new ChunkReader(large, 100, 500);
  await assert.rejects(windowed.read(0, 4), /could not be read/);
  assert.deepEqual(Array.from(await windowed.read(0, 4)), [0, 1, 2, 3]);
});

test("a wait ends at its wake, or when its time runs out", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order = [];
  const w = waker(50);
  // a wake with nobody waiting does nothing, and is not saved up
  w.wake();
  const first = w.wait().then(() => order.push('first'));
  await Promise.resolve();
  assert.deepEqual(order, []);
  w.wake();
  await first;
  assert.deepEqual(order, ['first']);
  // the timer of the wait that was woken is gone: 40 ms into the next wait, it must not end it
  t.mock.timers.tick(10);
  const second = w.wait().then(() => order.push('second'));
  t.mock.timers.tick(40);
  await Promise.resolve();
  assert.deepEqual(order, ['first']);
  t.mock.timers.tick(10);
  await second;
  assert.deepEqual(order, ['first', 'second']);
  // without a time, only a wake ends it
  const plain = waker();
  const third = plain.wait().then(() => order.push('third'));
  t.mock.timers.tick(100000);
  await Promise.resolve();
  assert.equal(order.length, 2);
  plain.wake();
  await third;
  assert.equal(order.length, 3);
});

test('a promise is waited for no longer than its timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await orTimeout(Promise.resolve('done'), 1000), 'done');
  const never = orTimeout(new Promise(() => {}), 250);
  t.mock.timers.tick(250);
  assert.equal(await never, undefined);
  await assert.rejects(orTimeout(Promise.reject(new Error('lost')), 1000), /lost/);
});

test('a picture is one of a stretch from its start up to, not at, its end', () => {
  assert.equal(shown(1, 1, 2), true);
  assert.equal(shown(1.999, 1, 2), true);
  assert.equal(shown(2, 1, 2), false);
  // a time's rounding (a microsecond) does not put a picture out of its stretch
  assert.equal(shown(0.9999995, 1, 2), true);
  assert.equal(shown(0.999998, 1, 2), false);
});

/**
 * Frames a tenth of a second apart, coded I P B B (the B pictures shown
 * before the P decoded ahead of them), each decoded a tenth of a second
 * before the first of them is shown: sample i at (i - 1) / 10 s.
 */
function reordered(groups) {
  const pts = [];
  const dts = [];
  for (let g = 0; g < groups; g++) {
    const base = g * 4;
    // decode order: I (shown first), P (shown fourth), B, B (shown second and third)
    for (const shownAt of [0, 3, 1, 2]) {
      dts.push((pts.length - 1) * 100000);
      pts.push((base + shownAt) * 100000);
    }
  }
  const keys = Array.from({ length: groups }, (_, g) => g * 4);
  return { v: { pts, dts }, video: { index: 0 }, tsMin: 0, dx: { sync_before: (_t, sec) => keys.filter((k) => pts[k] / 1e6 <= sec + 1e-9).pop() ?? 0 } };
}

test('a stretch is decoded from the keyframe before it to the first sample both decoded and shown after it', () => {
  const movie = reordered(4);
  // 0.1 to 0.5 s: from the first keyframe. The second group's I (shown at 0.4 s) is needed;
  // its P (sample 5) is shown past 0.5 s but decoded before it, so it does not end the
  // stretch: the B after it (sample 6: decoded and shown at 0.5 s) does
  assert.deepEqual(sampleRange(movie, 0.1, 0.5), { startIdx: 0, endIdx: 6 });
  // 0.6 to 0.7 s: from the second keyframe, through the B pictures decoded after its P
  assert.deepEqual(sampleRange(movie, 0.6, 0.7), { startIdx: 4, endIdx: 8 });
  // a start before the film is its first sample; one told where to start starts there
  assert.deepEqual(sampleRange(movie, -3, 0.05), { startIdx: 0, endIdx: 2 });
  assert.deepEqual(sampleRange(movie, 0.6, 0.7, 4), { startIdx: 4, endIdx: 8 });
  // to past the end: every sample
  assert.deepEqual(sampleRange(movie, 1.2, 99), { startIdx: 12, endIdx: 16 });
});

test("a picture's planes are described to the detector in nine words", () => {
  const i420 = [{ offset: 0, stride: 1920 }, { offset: 2073600, stride: 960 }, { offset: 2592000, stride: 960 }];
  assert.deepEqual(Array.from(yuvLayoutWords('I420', i420, { matrix: 'bt709', fullRange: false }, 1080)), [0, 0, 1920, 2073600, 960, 2592000, 960, 1, 0]);
  // NV12: one plane holds both chromas
  const nv12 = [{ offset: 0, stride: 1920 }, { offset: 2073600, stride: 1920 }];
  assert.deepEqual(Array.from(yuvLayoutWords('NV12', nv12, { matrix: 'smpte170m', fullRange: true }, 1080)), [1, 0, 1920, 2073600, 1920, 2073600, 1920, 0, 1]);
});

test('the colour matrix is the one the picture names, else guessed from its height as players do', () => {
  const planes = [{ offset: 0, stride: 2 }, { offset: 4, stride: 1 }, { offset: 5, stride: 1 }];
  const matrix = (cs, h) => yuvLayoutWords('I420', planes, cs, h)[7];
  assert.equal(matrix({ matrix: 'bt709' }, 480), 1);
  assert.equal(matrix({ matrix: 'bt2020-ncl' }, 480), 1);
  for (const m of ['smpte170m', 'bt470bg', 'fcc']) assert.equal(matrix({ matrix: m }, 1080), 0, m);
  assert.equal(matrix(null, 576), 0);
  assert.equal(matrix(null, 577), 1);
  assert.equal(matrix({ matrix: 'rgb' }, 1080), 1);
  assert.equal(matrix({}, 360), 0);
});

test('packed 4:2:0 planes of an odd-sized picture have chroma rounded up', () => {
  const data = new Uint8Array(5 * 3 + 2 * (3 * 2));
  const pic = rawPicture(data, 5, 3, 1234, null);
  assert.deepEqual(Array.from(pic.layout), [0, 0, 5, 15, 3, 21, 3, 0, 0]);
  assert.deepEqual([pic.raw, pic.format, pic.codedWidth, pic.codedHeight, pic.displayWidth, pic.displayHeight, pic.timestamp, pic.data], [true, 'I420', 5, 3, 5, 3, 1234, data]);
  pic.close(); // (nothing to free: it is memory like any other)
});

test('pictures for the detector alone are made small where a size is given', () => {
  assert.deepEqual(smallSize(true, { aw: 256, ah: 144 }), { aw: 256, ah: 144 });
  assert.equal(smallSize(false, { aw: 256, ah: 144 }), null);
  assert.equal(smallSize(true, null), null);
  assert.equal(smallSize(true, { aw: 0, ah: 144 }), null);
});

test("a frame's size is that of the part of it that is shown", () => {
  // (a decoder's frame may be coded larger than it is shown: 1088 lines for 1080)
  assert.deepEqual(frameSize({ codedWidth: 1920, codedHeight: 1088, visibleRect: { width: 1920, height: 1080 } }), { w: 1920, h: 1080 });
  assert.deepEqual(frameSize({ codedWidth: 640, codedHeight: 360 }), { w: 640, h: 360 });
  assert.deepEqual(frameSize({ codedWidth: 640, codedHeight: 360, visibleRect: null }), { w: 640, h: 360 });
});
