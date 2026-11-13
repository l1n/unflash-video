// Frames reordered (web/analysis.js): which orders apply, and two scenes cut
// together frame by frame told apart and put back one after the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validOrder, sectionOrder, orderedFrame, groupScenes, hasMarks, SCENE_APART, softPlaces } from '../../web/analysis.js';

test('an order applies when it is a reorder of all the frames that moves one', () => {
  assert.deepEqual(validOrder([1, 0, 2], 3), [1, 0, 2]);
  // nothing moved: no reorder
  assert.equal(validOrder([0, 1, 2], 3), null);
  // made for another count of frames (prepared again since), a frame twice, one that is none
  assert.equal(validOrder([1, 0], 3), null);
  assert.equal(validOrder([1, 0, 2, 3], 3), null);
  assert.equal(validOrder([1, 1, 2], 3), null);
  assert.equal(validOrder([1, 0, 3], 3), null);
  assert.equal(validOrder([1, 0, 2.5], 3), null);
  assert.equal(validOrder([-1, 0, 1], 3), null);
  assert.equal(validOrder(null, 3), null);
  assert.equal(validOrder('210', 3), null);
  assert.equal(validOrder([], 0), null);
});

test("a section's order is checked against its frames, and a place shows the frame its order gives", () => {
  const sec = { nFrames: 4, order: [0, 2, 1, 3] };
  assert.deepEqual(sectionOrder(sec), [0, 2, 1, 3]);
  assert.deepEqual([0, 1, 2, 3].map((k) => orderedFrame(sec, k)), [0, 2, 1, 3]);
  // a cache's count is the one that counts once prepared
  assert.equal(sectionOrder({ ...sec, cache: { len: () => 5 } }), null);
  assert.equal(orderedFrame({ nFrames: 4, order: [3, 3, 1, 0] }, 1), 1);
});

test('a reorder is a mark: an export applies a section that has one', () => {
  assert.equal(hasMarks({ nFrames: 3, edits: {} }), false);
  assert.equal(hasMarks({ nFrames: 3, edits: {}, order: [1, 0, 2] }), true);
  assert.equal(hasMarks({ nFrames: 3, edits: {}, order: [0, 1, 2] }), false);
});

/** A signature of a picture that is `v` all over (as sceneSignature makes them: 8x8 cells, three channels). */
const flat = (r, g, b) => Float64Array.from({ length: 64 * 3 }, (_, i) => [r, g, b][i % 3]);
const noisy = (sig, seed) => sig.map((v, i) => v + (((i * 7919 + seed * 104729) % 9) - 4));

test('two scenes cut together frame by frame come apart, the first frame\'s scene first, each in its own order', () => {
  const A = flat(200, 60, 40);
  const B = flat(30, 90, 180);
  // A B A B A A B A B B
  const which = 'ABABAABABB';
  const sigs = [...which].map((c, i) => noisy(c === 'A' ? A : B, i));
  const g = groupScenes(sigs);
  assert.deepEqual(g.order, [0, 2, 4, 5, 7, 1, 3, 6, 8, 9]);
  assert.deepEqual([g.first, g.second], [5, 5]);
  assert.ok(g.apart > SCENE_APART);
  // starting on the other scene, that one comes first
  const h = groupScenes([...'BABA'].map((c, i) => noisy(c === 'A' ? A : B, i)));
  assert.deepEqual(h.order, [0, 2, 1, 3]);
});

test('frames of one scene, or two scenes already one after the other, are left as they are', () => {
  const A = flat(120, 120, 120);
  const one = groupScenes([0, 1, 2, 3, 4, 5].map((i) => noisy(A, i)));
  assert.equal(one.order, null);
  assert.ok(one.apart < SCENE_APART);
  const B = flat(10, 10, 10);
  const done = groupScenes([A, A, A, B, B].map((s, i) => noisy(s, i)));
  assert.equal(done.order, null);
  assert.equal(done.already, true);
  // too few to tell apart
  assert.equal(groupScenes([A, B]).order, null);
});

test('stripes softened go where the reorder puts their frames', () => {
  const plan = { frames: new Set([1, 2]) };
  assert.deepEqual(softPlaces({ nFrames: 4 }, plan), [1, 2]);
  assert.deepEqual(softPlaces({ nFrames: 4, order: [2, 3, 0, 1] }, plan), [0, 3]);
});
