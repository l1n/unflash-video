// The sound of an edited timeline (web/sound.js): where every sample of the
// source lands once frames are held, sample for sample. (tests/e2e/sound.mjs
// asks the same of a whole export in a browser; the rule's corners are here.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundRun, audioData, soundName } from '../../web/sound.js';

const RATE = 1000; // a sample a millisecond: a hold's seconds are its samples over a thousand
const FADE = 5; // 5 ms either side of a silence

/**
 * A run over `holds` that writes what it emits into one array (NaN where
 * nothing was written), and checks that the blocks come in order with
 * nothing between them.
 */
function collect(holds, { channels = 1, block = 64, rate = RATE } = {}) {
  const out = Array.from({ length: channels }, () => new Float32Array(6000).fill(NaN));
  const seen = { first: null, next: null, blocks: 0 };
  const run = new SoundRun(rate, channels, holds, (planes, n, start) => {
    if (seen.first === null) seen.first = start;
    else assert.equal(start, seen.next, 'each block starts where the last ended');
    seen.next = start + n;
    seen.blocks++;
    assert.ok(n > 0 && n <= block);
    planes.forEach((p, c) => out[c].set(p.subarray(0, n), start));
  }, { block });
  return { run, out, seen };
}

/** Source samples `from`..`to` (sample i is worth 1 + i, so each can be told apart), handed over in pieces of `sizes` in turn. */
function feed(run, from, to, sizes = [100], rate = RATE) {
  for (let at = from, k = 0; at < to; k++) {
    const n = Math.min(to - at, sizes[k % sizes.length]);
    run.addPlanes([Float32Array.from({ length: n }, (_, j) => 1 + at + j)], n, at / rate, rate);
    at += n;
  }
}

/** Where source sample `i` lands: after the samples of every hold at or before it. */
const lands = (holds, i) => i + holds.reduce((sum, h) => sum + (Math.round(h.at * RATE) <= i ? Math.round(h.seconds * RATE) : 0), 0);

test('every sample lands after the holds at or before it, whatever the pieces the sound comes in', () => {
  // (xorshift: the same holds and pieces every run)
  let seed = 0x2545f491;
  const rnd = (n) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  for (let round = 0; round < 60; round++) {
    // up to six holds, at least 20 ms apart so that their fades do not meet
    const holds = [];
    for (let at = 20 + rnd(300); at < 1980 && holds.length < 6; at += 20 + rnd(500)) holds.push({ at: at / RATE, seconds: (1 + rnd(200)) / RATE });
    const sizes = Array.from({ length: 1 + rnd(5) }, () => 1 + rnd(300));
    const { run, out, seen } = collect(holds, { block: 1 + rnd(200) });
    feed(run, 0, 2000, sizes);
    run.finish();
    const what = `round ${round}: holds ${JSON.stringify(holds)}, pieces of ${sizes}`;
    assert.equal(run.placed, holds.length, what);
    assert.equal(seen.first, 0, what);
    const at = holds.map((h) => Math.round(h.at * RATE));
    for (let i = 0; i < 2000; i++) {
      const v = out[0][lands(holds, i)];
      // within 5 ms of a silence the sound is faded: quieter, never louder or gone
      if (at.some((h) => i >= h - FADE && i < h + FADE)) assert.ok(v > 0 && v < 1 + i, `${what}: sample ${i} is ${v}`);
      else assert.equal(v, 1 + i, `${what}: sample ${i}`);
    }
    // under each hold, silence: from where its moment lands to where the sample at it does
    for (const [k, h] of holds.entries()) {
      const end = lands(holds, at[k]);
      for (let s = end - Math.round(h.seconds * RATE); s < end; s++) assert.equal(out[0][s], 0, `${what}: silence at ${s}`);
    }
    // and the run ends with the last sample
    assert.equal(seen.next, lands(holds, 1999) + 1, what);
    assert.ok(Number.isNaN(out[0][seen.next]), what);
  }
});

test('the fades are a ramp of five samples down into a silence and five up out of it', () => {
  const { run, out } = collect([{ at: 0.1, seconds: 0.05 }]);
  // (a level sound, so that the ramp is all there is to see)
  for (const t of [0, 0.1]) run.addPlanes([new Float32Array(100).fill(6)], 100, t, RATE);
  run.finish();
  assert.deepEqual(Array.from(out[0].subarray(93, 101)), [6, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(Array.from(out[0].subarray(149, 157)), [0, 1, 2, 3, 4, 5, 6, 6]);
});

test('a hold before any sound is silence first; holds after the sound ends add nothing', () => {
  const holds = [{ at: 0, seconds: 0.03 }, { at: 0.2, seconds: 0.5 }, { at: 7, seconds: 1 }];
  const { run, out, seen } = collect(holds);
  feed(run, 0, 200);
  run.finish();
  // thirty samples of silence, then the sound (fading in)
  assert.equal(seen.first, 0);
  assert.ok(out[0].subarray(0, 30).every((v) => v === 0));
  assert.ok(out[0][30] > 0 && out[0][30] < 1);
  assert.equal(out[0][30 + FADE], 1 + FADE);
  // the hold at the very end of the sound, and the one long after it, were never reached
  assert.equal(run.placed, 1);
  assert.equal(seen.next, 230);
});

test('a hold exactly where one piece ends and the next begins goes between them', () => {
  const holds = [{ at: 0.1, seconds: 0.04 }];
  const { run, out } = collect(holds);
  feed(run, 0, 200, [100]);
  run.finish();
  assert.equal(out[0][99 - FADE], 100 - FADE);
  assert.ok(out[0].subarray(100, 140).every((v) => v === 0));
  assert.equal(out[0][140 + FADE], 101 + FADE);
  assert.equal(out[0][239], 200);
});

test('a run that starts part way has the earlier holds behind it, a hold at its first moment still ahead', () => {
  const holds = [{ at: 0.1, seconds: 0.05 }, { at: 0.2, seconds: 0.02 }, { at: 0.3, seconds: 0.1 }];
  const { run, out, seen } = collect(holds);
  assert.equal(run.from(0.2), run);
  feed(run, 200, 400);
  run.finish();
  // the hold at 0.1 is counted, not made; the one at 0.2 is made before the first sample
  assert.equal(run.placed, 2);
  assert.equal(seen.first, 250);
  assert.ok(out[0].subarray(250, 270).every((v) => v === 0));
  assert.equal(out[0][lands(holds, 250)], 251);
  assert.equal(lands(holds, 250), 320);
  // every time the frames are given agrees
  for (const t of [0.2, 0.25, 0.3, 0.399]) assert.equal(Math.round(SoundRun.outTime(holds, t) * RATE), lands(holds, Math.round(t * RATE)), `${t}`);
  assert.deepEqual([SoundRun.outTime(holds, 0.05), SoundRun.outTime(holds, 0.1), SoundRun.outTime([], 3)], [0.05, 0.1 + 0.05, 3]);
});

test('a gap in the source stays silent, and where pieces overlap the first one is kept', () => {
  const { run, out, seen } = collect([], { block: 8 });
  run.addPlanes([Float32Array.of(1, 2, 3, 4)], 4, 0, RATE);
  run.addPlanes([Float32Array.of(5, 6)], 2, 0.006, RATE); // two samples late
  run.addPlanes([Float32Array.of(7, 8, 9)], 3, 0.007, RATE); // one sample early
  run.addPlanes([Float32Array.of(10, 11)], 2, 0.002, RATE); // wholly inside what has gone
  run.finish();
  assert.deepEqual(Array.from(out[0].subarray(0, seen.next)), [1, 2, 3, 4, 0, 0, 5, 6, 8, 9]);
});

test('sound that does not start at zero starts the run where it starts', () => {
  const { run, out, seen } = collect([{ at: 1.5, seconds: 0.25 }]);
  feed(run, 1400, 1600);
  run.finish();
  assert.deepEqual([seen.first, seen.next], [1400, 1850]);
  assert.equal(out[0][1400], 1401);
  assert.equal(out[0][1849], 1600);
});

test('decoded sound comes in as the browser gives it: by channel, and a missing channel is the first again', () => {
  const { run, out } = collect([], { channels: 2, block: 16 });
  const mono = { numberOfFrames: 4, numberOfChannels: 1, sampleRate: RATE, timestamp: 2000, copyTo: (dst, { planeIndex, format }) => (assert.deepEqual([planeIndex, format], [0, 'f32-planar']), dst.set([0.25, 0.5, 0.75, 1])) };
  run.add(mono);
  const stereo = { numberOfFrames: 2, numberOfChannels: 2, sampleRate: RATE, timestamp: 6000, copyTo: (dst, { planeIndex }) => dst.fill(planeIndex ? -1 : 1) };
  run.add(stereo);
  run.finish();
  // (the timestamp is in microseconds: sample 2, then sample 6)
  assert.deepEqual(Array.from(out[0].subarray(2, 8)), [0.25, 0.5, 0.75, 1, 1, 1]);
  assert.deepEqual(Array.from(out[1].subarray(2, 8)), [0.25, 0.5, 0.75, 1, -1, -1]);
  // sound at another rate is not placed wrong: it is refused
  assert.throws(() => run.addPlanes([new Float32Array(4)], 4, 1, 2 * RATE), /the sound changes rate \(2000 Hz, not 1000 Hz\)/);
});

test("what the run hands on becomes the encoder's input: planes one after another, timed by the first sample", () => {
  const made = [];
  globalThis.AudioData = class {
    constructor(init) {
      made.push(init);
    }
  };
  try {
    // (the planes are views that may be longer than the block)
    audioData([Float32Array.of(1, 2, 3, 9), Float32Array.of(4, 5, 6, 9)], 3, 24000, 48000);
  } finally {
    delete globalThis.AudioData;
  }
  const [{ data, ...rest }] = made;
  assert.deepEqual(rest, { format: 'f32-planar', sampleRate: 48000, numberOfFrames: 3, numberOfChannels: 2, timestamp: 500000 });
  assert.deepEqual(Array.from(data), [1, 2, 3, 4, 5, 6]);
});

test('a codec is called what people call it', () => {
  const names = {
    'mp4a.40.2': 'AAC',
    'mp4a.40.5': 'AAC',
    // MP3, under each of the names an MP4, a Matroska file or a transport stream gives it
    'mp4a.40.34': 'MP3',
    'mp4a.6B': 'MP3',
    'mp4a.69': 'MP3',
    mp3: 'MP3',
    opus: 'Opus',
    vorbis: 'Vorbis',
    flac: 'FLAC',
    alac: 'ALAC',
    // (the long name is for where there is room: here, the short one)
    'ac-3': 'AC-3',
    'mp4a.A5': 'AC-3',
    'ec-3': 'E-AC-3',
    dtsc: 'DTS',
    dtsh: 'DTS',
    'pcm-s16': 'PCM',
    ulaw: 'PCM',
    // one with no such name keeps its own
    'mp4a.E1': 'mp4a.E1',
    '': 'unknown',
  };
  for (const [codec, name] of Object.entries(names)) assert.equal(soundName(codec), name, codec);
  assert.equal(soundName(undefined), 'unknown');
});
