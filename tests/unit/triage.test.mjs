// Triage (web/triage.js): which chunks of a scan are likeliest to flash,
// from the sizes of the file's frames alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { triageChunks } from '../../web/triage.js';

/** A film of `chunks` one-second chunks of ten frames, the first of each a keyframe: `key` bytes it, `other` each of the rest. */
function film(chunks, { key = 5000, other = 1000 } = {}) {
  const size = [];
  const sync = [];
  for (let c = 0; c < chunks; c++) {
    for (let i = 0; i < 10; i++) {
      size.push(i === 0 ? key : other);
      sync.push(i === 0 ? 1 : 0);
    }
  }
  const idx = Array.from({ length: chunks }, (_, c) => c * 10);
  const t = Array.from({ length: chunks + 1 }, (_, c) => c);
  return { movie: { v: { size, sync }, width: 100, height: 100 }, chunks: { idx, t, length: chunks } };
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('chunks that are all alike score alike, and go in file order', () => {
  const { movie, chunks } = film(6);
  const r = triageChunks(movie, chunks);
  for (const s of r.score) near(s, 0.5);
  assert.deepEqual(r.order, [0, 1, 2, 3, 4, 5]);
});

test('a quarter of the chunks are hot, at least one, and none of fewer than four', () => {
  for (const [n, hot] of [[1, 0], [3, 0], [4, 1], [6, 2], [8, 2], [10, 3], [40, 10]]) {
    const { movie, chunks } = film(n);
    assert.equal(triageChunks(movie, chunks).hot, hot, `${n} chunks`);
  }
});

test('a costly frame and a near-empty keyframe each raise their chunk', () => {
  const { movie, chunks } = film(4);
  // chunk 2: one frame that is no keyframe costs nine times the others
  movie.v.size[25] = 9000;
  // chunk 3: its keyframe has next to nothing in it
  movie.v.size[30] = 10;
  const r = triageChunks(movie, chunks);
  // bytes a frame against the film's median frame (1000 bytes)
  near(r.features[0].bits, 1.4);
  near(r.features[2].bits, 2.2);
  near(r.features[3].bits, 0.901);
  assert.deepEqual(r.features.map((f) => f.keys), [1, 1, 1, 1]);
  assert.deepEqual(r.features.map((f) => f.spikes), [0, 0, 1, 0]);
  assert.deepEqual(r.features.map((f) => f.flat), [0, 0, 0, 1]);
  // score: 0.25 bits + 0.2 keyframes + 0.3 spikes + 0.25 flat, each as its rank among the chunks
  near(r.score[0], 0.25 * 0.5 + 0.2 * 0.5 + 0.3 / 3 + 0.25 / 3);
  near(r.score[1], r.score[0]);
  near(r.score[2], 0.25 * 1 + 0.2 * 0.5 + 0.3 * 1 + 0.25 / 3);
  near(r.score[3], 0.25 * 0 + 0.2 * 0.5 + 0.3 / 3 + 0.25 * 1);
  assert.deepEqual(r.order, [2, 3, 0, 1]);
  assert.equal(r.hot, 1);
});

test('a keyframe is flat under 0.002 bytes a pixel, whatever the film is like', () => {
  // every keyframe tiny: a quarter of their median is tinier still, the floor is what counts
  const { movie, chunks } = film(4, { key: 30, other: 1000 });
  movie.width = 200;
  movie.height = 100; // 0.002 bytes a pixel is 40 bytes
  const r = triageChunks(movie, chunks);
  assert.deepEqual(r.features.map((f) => f.flat), [1, 1, 1, 1]);
  movie.width = 100; // now 20 bytes: none is under it
  assert.deepEqual(triageChunks(movie, chunks).features.map((f) => f.flat), [0, 0, 0, 0]);
});

test('a film without frames, or of one chunk, gives no order to speak of', () => {
  const empty = triageChunks({ v: { size: [], sync: [] }, width: 0, height: 0 }, { idx: [], t: [0], length: 0 });
  assert.deepEqual(empty.order, []);
  assert.equal(empty.hot, 0);
  const { movie, chunks } = film(1);
  const one = triageChunks(movie, chunks);
  assert.deepEqual(one.order, [0]);
  near(one.score[0], 0.5);
});
