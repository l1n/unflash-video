// A scan in chunks (web/analysis.js): where the file is cut, and which
// chunk each decode lane takes next (ChunkPicker).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_S, ChunkPicker, scanChunks } from '../../web/analysis.js';

/** A film at 10 pictures a second, `seconds` long, a keyframe every `gop` pictures, starting at `t0` seconds. */
function film(seconds, gop, t0 = 0) {
  const count = seconds * 10;
  const pts = Array.from({ length: count }, (_, i) => Math.round((t0 + i / 10) * 1e6));
  const sync = Array.from({ length: count }, (_, i) => (i % gop === 0 ? 1 : 0));
  return { v: { pts, sync }, tsMin: t0, tsMax: t0 + (count - 1) / 10 };
}

test('chunks are cut at keyframes about ten seconds apart', () => {
  assert.equal(CHUNK_S, 10);
  const c = scanChunks(film(30, 25));
  assert.deepEqual(c.idx, [0, 100, 200]);
  assert.deepEqual(c.t.slice(0, 3), [0, 10, 20]);
  // the last bound is past the last picture, so a decode up to it takes that picture in
  assert.ok(c.t[3] > 29.9);
  assert.deepEqual(c.n, [100, 100, 100]);
  assert.equal(c.length, 3);
});

test('no chunk starts within half a chunk of the end', () => {
  // keyframes at 0, 10 and 20 s of 24: the one at 20 is 3.9 s from the last picture
  const c = scanChunks(film(24, 100));
  assert.deepEqual(c.idx, [0, 100]);
  assert.deepEqual(c.n, [100, 140]);
});

test('a cut waits for the next keyframe', () => {
  // keyframes every 7 s: the first at or past 10 s is at 14, the next at or past 24 is at 28
  const c = scanChunks(film(60, 70));
  assert.deepEqual(c.idx, [0, 140, 280, 420]);
  assert.deepEqual(c.t.slice(0, 4), [0, 14, 28, 42]);
});

test('a film with one keyframe, or none past the first picture, is one chunk', () => {
  const c = scanChunks(film(40, 1000));
  assert.deepEqual(c.idx, [0]);
  assert.deepEqual(c.n, [400]);
  assert.equal(c.t.length, 2);
});

test('a film that does not start at zero is cut from where it starts', () => {
  const c = scanChunks(film(30, 50, 100));
  assert.equal(c.t[0], 100);
  assert.deepEqual(c.idx, [0, 100, 200]);
  assert.deepEqual(c.t.slice(1, 3), [110, 120]);
});

test('another chunk length cuts accordingly', () => {
  const c = scanChunks(film(30, 25), 5);
  assert.deepEqual(c.idx, [0, 50, 100, 150, 200, 250]);
});

test('a film in which two pictures share a time is one chunk', () => {
  // (in chunks, a picture stamped like the one before it is taken for one that is in
  // already, from a lane that had the chunk before: such a film is scanned in one piece)
  const movie = film(30, 25);
  movie.v.pts[130] = movie.v.pts[129];
  const c = scanChunks(movie);
  assert.deepEqual(c.idx, [0]);
  assert.deepEqual(c.n, [300]);
  assert.equal(c.t.length, 2);
  // pictures decoded out of the order they are shown in share no time for that
  const reordered = film(30, 25);
  [reordered.v.pts[131], reordered.v.pts[132]] = [reordered.v.pts[132], reordered.v.pts[131]];
  assert.equal(scanChunks(reordered).length, 3);
});

const four = () => new ChunkPicker([10, 10, 10, 10], [0, 10, 20, 30, 40], { bytes: 1, budget: 15 });

test('lanes take the chunks in order, within the budget for pictures held', () => {
  const p = four();
  assert.equal(p.ahead(), 0); // the detector's own chunk holds nothing
  assert.equal(p.used, 0);
  assert.equal(p.ahead(), 1);
  assert.equal(p.used, 10);
  assert.equal(p.ahead(), -2); // 10 held, 10 more would pass 15
  // the detector moves on to chunk 1: what chunk 0 held is free, chunk 1's pictures still wait
  p.advance(1);
  assert.equal(p.ahead(), -2);
  p.advance(2);
  assert.equal(p.used, 0);
  assert.equal(p.ahead(), 2);
  assert.equal(p.ahead(), 3);
  assert.equal(p.ahead(), -1);
  assert.deepEqual(p.log, [0, 1, 2, 3]);
  assert.equal(p.left, 0);
});

test("the detector's own chunk always has room", () => {
  const p = new ChunkPicker([1000, 1000], [0, 10, 20], { bytes: 1000, budget: 1 });
  assert.equal(p.ahead(), 0);
  assert.equal(p.ahead(), -2);
  p.advance(1);
  assert.equal(p.ahead(), 1);
});

test('a lane takes the first chunk that falls to it, leaving room for those it passes over', () => {
  const p = new ChunkPicker([10, 10, 10, 10], [0, 10, 20, 30, 40], { bytes: 1, budget: 25 });
  // chunk 0 is another lane's; chunk 1 falls to this one
  assert.equal(p.ahead((c) => c === 1), 1);
  assert.equal(p.used, 10);
  // chunk 0 (free of charge, the detector's) and chunk 2 are passed over: 10 held + 10 for
  // chunk 2 + 10 for chunk 3 would pass 25
  assert.equal(p.ahead((c) => c === 3), -3);
  // nothing fits at all: the same answer
  assert.equal(p.ahead(() => false), -3);
  // and with no room even for the first free chunk, -2
  const q = new ChunkPicker([10, 10, 10], [0, 10, 20, 30], { bytes: 1, budget: 5 });
  assert.equal(q.ahead(), 0);
  assert.equal(q.ahead(() => true), -2);
});

test('a chunk given back is taken again', () => {
  const p = four();
  assert.equal(p.ahead(), 0);
  assert.equal(p.ahead(), 1);
  p.release(1);
  assert.equal(p.used, 0);
  assert.equal(p.left, 3);
  assert.equal(p.ahead(), 1);
  // a chunk nobody has cannot be given back
  p.release(3);
  assert.equal(p.left, 2);
});

const eight = (more = {}) => new ChunkPicker(new Array(8).fill(10), [0, 10, 20, 30, 40, 50, 60, 70, 80], { bytes: 1, budget: 1000, runup: 6.5, ...more });

test('an early look takes the likeliest hot chunk with its run-up and the hot chunks after it', () => {
  const p = eight({ order: [5, 6, 2, 0, 1, 3, 4, 7], hot: 2 });
  const run = p.hotRun();
  // chunk 4 is the 6.5 s of run-up (a whole chunk of 10 s covers it), 5 and 6 are hot
  assert.deepEqual(run, { first: 4, from: 5, last: 6 });
  assert.deepEqual(p.log, [4, 5, 6]);
  assert.equal(p.used, 30);
  assert.equal(p.usedEarly, 30);
  assert.deepEqual(p.runs, [run]);
  // nothing hot is left
  assert.equal(p.hotRun(), null);
  // the lanes go on in file order around it
  assert.deepEqual([p.ahead(), p.ahead(), p.ahead(), p.ahead(), p.ahead(), p.ahead()], [0, 1, 2, 3, 7, -1]);
});

test('an early look leaves alone what the lanes get to soon anyway', () => {
  // two lanes take the first two free chunks soon: hot chunk 1 is one of them, so the look is at 5
  const p = eight({ order: [1, 5], hot: 2 });
  assert.deepEqual(p.hotRun(2), { first: 4, from: 5, last: 5 });
  // one lane only gets to the first free chunk: chunk 1 is worth an early look, with chunk 0 as its run-up
  const q = eight({ order: [1, 5], hot: 2 });
  assert.deepEqual(q.hotRun(1), { first: 0, from: 1, last: 1 });
  // and the first free chunk itself is never looked at early
  const r = eight({ order: [0, 5], hot: 2 });
  assert.deepEqual(r.hotRun(1), { first: 4, from: 5, last: 5 });
});

test('the start of the file will do for a run-up; a run-up someone else has cut short will not', () => {
  // chunks of 4 s: 6.5 s of run-up is two chunks, and chunk 1 has only chunk 0 before it
  const t = [0, 4, 8, 12, 16, 20, 24, 28, 32];
  const p = new ChunkPicker(new Array(8).fill(10), t, { bytes: 1, budget: 1000, runup: 6.5, order: [1], hot: 1 });
  assert.deepEqual(p.hotRun(0), { first: 0, from: 1, last: 1 });
  const q = new ChunkPicker(new Array(8).fill(10), t, { bytes: 1, budget: 1000, runup: 6.5, order: [5], hot: 1 });
  // a lane has chunks 0 to 3: chunk 4 alone is 4 s of run-up, not 6.5
  for (let i = 0; i < 4; i++) q.ahead();
  assert.equal(q.hotRun(0), null);
});

test('early looks keep to their share of the budget', () => {
  // 20 bytes for the look, of a budget of 30 whose share for early looks is 60% (18)
  const p = eight({ order: [5], hot: 1, budget: 30 });
  assert.equal(p.hotRun(), null);
  const q = eight({ order: [5], hot: 1, budget: 30, hotShare: 0.7 });
  assert.deepEqual(q.hotRun(), { first: 4, from: 5, last: 5 });
});

test('what an early look held is free once the detector has passed it', () => {
  const p = eight({ order: [5], hot: 1 });
  p.hotRun();
  assert.equal(p.usedEarly, 20);
  p.advance(5);
  assert.equal(p.usedEarly, 10);
  p.advance(6);
  assert.equal(p.used, 0);
  assert.equal(p.usedEarly, 0);
});
