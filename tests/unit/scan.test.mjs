// A scan in chunks, whole (web/analysis.js scanMovie), with stand-ins for
// the film, its decoders and the detector (fakes.mjs): several lanes decode
// at once, one detector takes every picture in file order, and a cancel
// ends it wherever its lanes are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runupStart, scanChunks, scanMovie } from '../../web/analysis.js';
import { fakeEnv, fakeMovie, sanitizeDeltas, within } from './fakes.mjs';

// (a scan reports its timings at debug level)
console.debug = () => {};

/** A scan of `movie` in 10 s chunks, `lanes` decoding at once (the built-in decoder standing in for the browser's). */
const scan = (env, movie, { lanes = 2, budget = 0, cancel = null } = {}) => scanMovie(env, movie, { cancel, chunked: { hw: lanes, sim: true, chunkS: 10, order: 'file', budget } });

test('every picture reaches the one detector, in file order, whichever lane decoded it', async () => {
  const movie = fakeMovie({ seconds: 60 });
  const { env, fed } = fakeEnv();
  const r = await scan(env, movie, { lanes: 3 });
  assert.equal(r.frames, 1800);
  assert.equal(fed.length, 1800);
  for (let i = 1; i < fed.length; i++) assert.ok(fed[i] > fed[i - 1], `picture ${i} out of order`);
  assert.equal(r.chunked.chunks, 6);
  assert.deepEqual([...r.chunked.taken].sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(r.chunked.lanes.length, 3);
  assert.equal(r.chunked.lanes.reduce((n, l) => n + l.frames, 0), 1800);
});

test('the pictures held for the detector keep to the budget, give or take its own chunk', async () => {
  const movie = fakeMovie({ seconds: 60 });
  const { env, fed } = fakeEnv({ feedMs: 0 });
  // room for 30 pictures of 256x144 RGBA: every lane has to wait for the detector, over and over
  const budget = 30 * 256 * 144 * 4;
  const r = await scan(env, movie, { budget });
  assert.equal(fed.length, 1800);
  assert.equal(r.chunked.budget, budget);
  assert.ok(r.chunked.peak <= budget + 300 * 256 * 144 * 4, `held ${r.chunked.peak} bytes at most, of ${budget}`);
});

test('a cancel ends the scan while its lanes wait for room', async () => {
  // a detector slower than the decoders, and room for few pictures: the lanes spend the scan
  // waiting for the detector to free some (as with a CPU detector, or ?hold=)
  for (const lanes of [1, 2]) {
    const movie = fakeMovie({ seconds: 60 });
    const { env, fed } = fakeEnv({ feedMs: 1 });
    const outcome = await within(scan(env, movie, { lanes, budget: 5 * 1024 * 1024, cancel: () => fed.length >= 100 }), 5000);
    assert.notEqual(outcome, 'pending', `${lanes} lane(s): the scan never ended, 100 pictures in`);
    assert.match(String(outcome.error && outcome.error.message), /^cancelled$/);
    assert.equal(fed.length, 100);
  }
});

test('a cancel ends a scan whose detector keeps up, too', async () => {
  const movie = fakeMovie({ seconds: 60 });
  const { env, fed } = fakeEnv();
  const outcome = await within(scan(env, movie, { cancel: () => fed.length >= 100 }), 5000);
  assert.match(String(outcome.error && outcome.error.message), /^cancelled$/);
  assert.equal(fed.length, 100);
});

test("a detector that fails ends the scan with its error, and with nothing left for the page to trip over", async () => {
  // (a rejection nobody is waiting for is reported to the page as an error of its own)
  const stray = [];
  const note = (e) => stray.push(e);
  process.on('unhandledRejection', note);
  try {
    for (const budget of [0, 5 * 1024 * 1024]) {
      const movie = fakeMovie({ seconds: 60 });
      const { env, fed } = fakeEnv({ failAt: 50 });
      const outcome = await within(scan(env, movie, { budget }), 5000);
      assert.notEqual(outcome, 'pending', 'the scan never ended');
      assert.match(String(outcome.error && outcome.error.message), /^the detector failed$/);
      assert.equal(fed.length, 50);
    }
    // (a turn of the event loop: that is when a stray rejection is reported)
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(stray.map((e) => e.message), []);
  } finally {
    process.off('unhandledRejection', note);
  }
});

test('a film whose pictures share times is scanned whole, every picture of it', async () => {
  const movie = fakeMovie({ seconds: 60 });
  // every hundredth picture stamped like the one before it
  for (let i = 100; i < movie.v.pts.length; i += 100) movie.v.pts[i] = movie.v.pts[i - 1];
  // the page scans in chunks a film of two chunks or more (app.js): this one is one
  assert.equal(scanChunks(movie).length, 1);
  const { env, fed } = fakeEnv();
  const r = await scanMovie(env, movie, {});
  assert.equal(r.frames, 1800);
  assert.equal(fed.length, 1800);
});

/** A film of `seconds` at 30 pictures a second whose pictures from `at` seconds on are stamped `gap` seconds later. */
function filmWithAJump(seconds, at, gap) {
  const movie = fakeMovie({ seconds });
  for (let i = at * 30; i < movie.v.pts.length; i++) movie.v.pts[i] += gap * 1e6;
  movie.tsMax += gap;
  return movie;
}

test("a segment's run-up is measured by the detector's clock, which steps over a jump in the timestamps", () => {
  // twenty seconds of pictures, the second ten stamped ten seconds late (10 s to 20 s is missing)
  const times = Array.from({ length: 600 }, (_, i) => (i < 300 ? i / 30 : i / 30 + 10));
  const clock = sanitizeDeltas(times, 5).times;
  assert.ok(Math.abs(clock[300] - 10) < 1e-9 && Math.abs(clock[599] - 599 / 30) < 1e-9, 'the clock runs on over the jump');
  const near = (x, want) => assert.ok(Math.abs(x - want) < 1e-9, `${x}, not ${want}`);
  // with no jump in the way, the run-up starts where it always did
  const even = Array.from({ length: 600 }, (_, i) => i / 30);
  near(runupStart(even, even, 10, 6.5), 3.5);
  near(runupStart(even, even, 10.01, 6.5), 3.51);
  near(runupStart(times, clock, 28, 6.5), 21.5);
  near(runupStart(times, clock, 6, 6.5), -0.5);
  // a seam in the jump: the run-up is the 6.5 s before the jump, not the jump itself
  near(runupStart(times, clock, 15.5, 6.5), 3.5);
  near(runupStart(times, clock, 20, 6.5), 3.5);
  // a second after the jump: a second after it, and 5.5 s before
  near(runupStart(times, clock, 21, 6.5), 4.5);
  // past the film's end there is nothing to start at
  near(runupStart(times, clock, 99, 6.5), 92.5);
  near(runupStart([], [], 5, 6.5), -1.5);
});

test('a scan in segments starts each one a run-up early, across a jump in the timestamps too', async () => {
  const fedBy = async (movie) => {
    const { env, fed } = fakeEnv();
    const others = [];
    const r = await scanMovie(env, movie, {
      segments: 2,
      forceSegments: true,
      makeFeeder: async () => {
        const other = fakeEnv();
        others.push(other.fed);
        return other.feeder;
      },
    });
    return { r, first: fed, second: others[0] };
  };
  // an even film of 30 s: the seam is just past 15.5 s (the scan's span ends a second past the last picture's end),
  // so the picture at 15.5 s is the first segment's last, and the second starts its run-up 6.5 s before the seam
  const even = await fedBy(fakeMovie({ seconds: 30 }));
  assert.equal(even.r.segments, 2);
  assert.deepEqual([even.first[0], even.first.length, even.second[0], even.second.length], [0, 466, 9, 630]);
  assert.equal(even.r.frames, 900);
  // twenty seconds of pictures with ten missing in the middle: the same seam now falls in the jump.
  // The second segment's first picture is the one stamped 20 s, and its run-up the 6.5 s before the jump
  const jump = await fedBy(filmWithAJump(20, 10, 10));
  assert.deepEqual([jump.first[0], jump.first.length], [0, 300]);
  assert.deepEqual([jump.second[0], jump.second.length], [3.5, 195 + 300]);
  assert.equal(jump.r.frames, 600);
});
