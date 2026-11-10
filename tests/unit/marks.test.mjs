// What a section's marks mean (web/analysis.js): which frames a blend mark
// mixes a frame with and how much, which frames "soften stripes" blurs, and
// the rates "reduce FPS" tries. The blend rule is unflash_core::blend's,
// restated in JavaScript for the export: the first test's cases are the
// ones crates/unflash-core/src/blend.rs holds the Rust to, so the two
// cannot drift apart unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLEND_DEFAULT, blendMarks, blendSources, blendStrength, blendWeights, hasMarks, keepJson, rateLadder, softenPlan } from '../../web/analysis.js';

test('a blended frame is mixed with the nearest unmarked frames either side of it', () => {
  const s = blendSources([false, true, true, false, true, false, false, true]);
  assert.equal(s[0], null);
  assert.deepEqual(s[1], { prev: 0, next: 3, u: 1 / 3 });
  assert.deepEqual(s[2], { prev: 0, next: 3, u: 2 / 3 });
  assert.equal(s[3], null);
  assert.deepEqual(s[4], { prev: 3, next: 5, u: 0.5 });
  // the last frame has nothing after it: toward the one before
  assert.deepEqual(s[7], { prev: 6, next: null, u: 0 });
  assert.deepEqual(blendWeights(s[4], 1), [0, 0.5, 0.5]);
  assert.deepEqual(blendWeights(s[7], 0.25), [0.75, 0.25, 0]);
  // nothing unmarked to mix with: the frames stay as they are
  assert.deepEqual(blendSources([true, true]), [null, null]);
});

test('marked frames at the start lean on the first unmarked frame after them', () => {
  assert.deepEqual(blendSources([true, true, false]), [{ prev: null, next: 2, u: 1 }, { prev: null, next: 2, u: 1 }, null]);
  assert.deepEqual(blendWeights({ prev: null, next: 2, u: 1 }, 0.4), [0.6, 0, 0.4]);
  assert.deepEqual(blendSources([]), []);
});

test('the weights of a blend always come to one, whatever strength is asked', () => {
  const between = { prev: 0, next: 4, u: 0.25 };
  for (const s of [-1, 0, 0.3, 0.8, 1, 7]) {
    const w = blendWeights(between, s);
    assert.ok(Math.abs(w[0] + w[1] + w[2] - 1) < 1e-12, `strength ${s}: ${w}`);
    assert.ok(w.every((x) => x >= 0 && x <= 1), `strength ${s}: ${w}`);
  }
  // out of range is the nearest end of it
  assert.deepEqual(blendWeights(between, -1), [1, 0, 0]);
  assert.deepEqual(blendWeights(between, 7), [0, 0.75, 0.25]);
  // a frame with no source keeps itself
  assert.deepEqual(blendWeights({ prev: null, next: null, u: 0 }, 1), [1, 0, 0]);
});

test("a section's blend strength is 80% until one is set", () => {
  assert.equal(BLEND_DEFAULT, 0.8);
  assert.equal(blendStrength({}), 0.8);
  assert.equal(blendStrength({ blendStrength: null }), 0.8);
  assert.equal(blendStrength({ blendStrength: 0 }), 0);
  assert.equal(blendStrength({ blendStrength: 0.35 }), 0.35);
});

test("the blend marks that apply are those on the section's frames, once each, in order", () => {
  assert.deepEqual(blendMarks({ nFrames: 10, blend: [7, 2, 2, 12, -1, 9] }), [2, 7, 9]);
  // at no strength nothing is blended
  assert.deepEqual(blendMarks({ nFrames: 10, blend: [1, 2], blendStrength: 0 }), []);
  // a section never prepared has no frames to mark
  assert.deepEqual(blendMarks({ blend: [1, 2] }), []);
  assert.deepEqual(blendMarks({ nFrames: 10 }), []);
  // the frames in memory count, when they are there
  assert.deepEqual(blendMarks({ nFrames: 10, cache: { len: () => 3 }, blend: [1, 5] }), [1]);
  // a suggestion's trial stands in for the section's own marks
  assert.deepEqual(blendMarks({ nFrames: 10, blend: [1] }, { marks: [4, 3], strength: 1 }), [3, 4]);
  assert.deepEqual(blendMarks({ nFrames: 10, blend: [1] }, { marks: [4, 3], strength: 0 }), []);
});

test('a section has marks when something in it changes what is shown', () => {
  assert.equal(hasMarks({}), false);
  assert.equal(hasMarks({ edits: {}, keep: [3], nFrames: 10 }), false, 'a keep mark changes nothing by itself');
  assert.equal(hasMarks({ edits: { 4: { removed: 'prev' } } }), true);
  assert.equal(hasMarks({ edits: { 4: { extended: true } } }), true);
  assert.equal(hasMarks({ edits: { 4: {} } }), false, 'a mark taken off again');
  assert.equal(hasMarks({ soften: true }), true);
  assert.equal(hasMarks({ nFrames: 10, blend: [2] }), true);
  assert.equal(hasMarks({ nFrames: 10, blend: [2], blendStrength: 0 }), false);
  assert.equal(hasMarks({ nFrames: 10, blend: [20] }), false, 'a blend mark past the frames');
});

test('the frames marked keep go to the suggesters as JSON, or not at all', () => {
  assert.equal(keepJson({}), undefined);
  assert.equal(keepJson({ keep: [] }), undefined);
  assert.equal(keepJson({ keep: [3, 1] }), '[3,1]');
});

/** A section of `n` frames at 20 a second with stripes (`period` analysis pixels) on the frames `on`. */
function striped(n, on, { thresh = 1000, count = 800, period = 6 } = {}) {
  const counts = new Array(n).fill(0);
  const periods = new Array(n).fill(0);
  for (const i of on) {
    counts[i] = count;
    periods[i] = period;
  }
  return { pts: Array.from({ length: n }, (_, i) => i / 20), pattern: { thresh, counts, periods } };
}

test('soften stripes blurs the patterned frames and a quarter second either side', () => {
  const plan = softenPlan(striped(40, [20]));
  assert.deepEqual(plan.hot, [20]);
  // a quarter second at 20 frames a second is five frames each way
  assert.deepEqual([...plan.frames].sort((a, b) => a - b), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  assert.equal(plan.period, 6);
  assert.equal(plan.sigma, 6);
  // three box passes of radius r have a variance of ((2r+1)² − 1) / 4: r = 5.5 for σ = 6, rounded to 6
  assert.equal(plan.radius, 6);
});

test('a pattern counts from half the area threshold, and the margin stops at the ends', () => {
  assert.equal(softenPlan(striped(40, [20], { count: 499 })), null);
  assert.deepEqual(softenPlan(striped(40, [20], { count: 500 })).hot, [20]);
  const plan = softenPlan(striped(40, [0, 39]));
  assert.deepEqual([...plan.frames].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 34, 35, 36, 37, 38, 39]);
});

test('the blur is sized by the mean stripe spacing, weighted by how much of the frame each covers', () => {
  const sec = striped(40, [10, 11]);
  sec.pattern.counts[10] = 600;
  sec.pattern.periods[10] = 4;
  sec.pattern.counts[11] = 1800;
  sec.pattern.periods[11] = 8;
  const plan = softenPlan(sec);
  assert.equal(plan.period, (4 * 600 + 8 * 1800) / 2400);
  assert.equal(plan.sigma, 7);
  // fine stripes still get a blur of one pixel, and a spacing nobody measured counts as two
  assert.equal(softenPlan(striped(40, [20], { period: 0.5 })).sigma, 1);
  const unmeasured = softenPlan(striped(40, [20], { period: 0 }));
  assert.equal(unmeasured.period, 2);
  assert.equal(unmeasured.radius, 2);
});

test('a section with nothing patterned has nothing to soften', () => {
  assert.equal(softenPlan({}), null);
  assert.equal(softenPlan({ pattern: null }), null);
  assert.equal(softenPlan({ pattern: { thresh: 0, counts: [5], periods: [4] } }), null);
  assert.equal(softenPlan({ pattern: { thresh: 100, counts: [], periods: [] } }), null);
  assert.equal(softenPlan(striped(40, [])), null);
  // without frame times, 30 frames a second is assumed: seven frames to a quarter second
  const sec = striped(40, [20]);
  delete sec.pts;
  assert.equal(softenPlan(sec).frames.size, 15);
});

test('reduce FPS tries twice the rate that cannot fail first, then a tenth less each time', () => {
  const ladder = rateLadder(3.6, 30);
  assert.equal(ladder[0], 7.2);
  assert.equal(ladder[ladder.length - 1], 3.6);
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i] < ladder[i - 1], `${ladder}`);
  // each step keeps nine tenths of the last, to a tenth of a picture a second
  assert.deepEqual(ladder.slice(0, 4), [7.2, 6.5, 5.9, 5.3]);
  assert.ok(ladder.length <= 11, `no more than ten tries and the floor: ${ladder}`);
});

test("the ladder never starts above nine tenths of the section's own rate", () => {
  assert.equal(rateLadder(3.6, 6)[0], 5.4);
  // a section slower than the safe rate already: the safe rate alone
  assert.deepEqual(rateLadder(3.6, 3), [3.6]);
  assert.deepEqual(rateLadder(3.6, 0), [3.6]);
  assert.deepEqual(rateLadder(3.6, NaN), [3.6]);
});

test('a profile with no safe rate goes from half the rate down to one picture a second', () => {
  const ladder = rateLadder(0, 30);
  assert.equal(ladder[0], 15);
  assert.equal(ladder[ladder.length - 1], 1);
  // from 15 to 1 a tenth at a time would take 26 checks: the steps are bigger, ten at most
  assert.ok(ladder.length <= 11, `${ladder}`);
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i] < ladder[i - 1], `${ladder}`);
});
