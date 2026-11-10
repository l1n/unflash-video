// What the page says and draws from numbers alone (web/readouts.js), and
// the way back from an export's clock to the video's (web/sound.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVELOPE_S, cleanExportName, fmtWait, limitRateEnvelope, niceStep } from '../../web/readouts.js';
import { SoundRun, sourceTime } from '../../web/sound.js';

test("a time axis's ticks are a round step apart, a dozen or so whatever it spans", () => {
  assert.deepEqual([0.01, 0.5, 0.6, 3, 11, 15, 16, 61, 1000, 1801, 3600].map(niceStep), [0.5, 0.5, 1, 5, 15, 15, 30, 120, 1200, 3600, 3600]);
  // past an hour the steps double (they stopped at an hour, however long the axis)
  assert.deepEqual([3601, 7200, 7201, 1e6].map(niceStep), [7200, 7200, 14400, 3600 * 512]);
  // a timeline 1000 pixels wide asks for a tick every 90: a day, a year, and timestamps 136 years apart
  for (const span of [600, 86400, 3.15e7, 4.3e9, 1e15, 1e300]) {
    const step = niceStep(span / (1000 / 90));
    const ticks = Math.floor(span / step) + 1;
    assert.ok(ticks >= 5 && ticks <= 12, `${span} s: ${ticks} ticks, ${step} s apart`);
  }
  // no numbers: a step all the same, and no loop without end
  assert.deepEqual([niceStep(NaN), niceStep(-5), niceStep(0), niceStep(Infinity)], [3600, 0.5, 0.5, Infinity]);
});

test('how long a job took is said to the second, then to the minute', () => {
  assert.deepEqual([0.2, 45.4, 89.4, 90, 119.4, 185, 3540].map(fmtWait), ['0 s', '45 s', '89 s', '1 min 30 s', '1 min 59 s', '3 min 5 s', '59 min 0 s']);
  // rounded before it is split (119.6 s was "1 min 60 s", and an hour less a moment "59 min 60 s")
  assert.deepEqual([119.6, 3599.7, 3600, 7325, 86399.9].map(fmtWait), ['2 min 0 s', '1 h 0 min', '1 h 0 min', '2 h 2 min', '24 h 0 min']);
});

test('an export is saved under a name a file system takes, ending in .mp4', () => {
  const names = {
    'clip.mp4': 'clip.mp4',
    'clip.MP4': 'clip.MP4',
    'clip.mkv': 'clip.mp4',
    'clip.final.webm': 'clip.final.mp4',
    // an ending that is no video's stays in the name
    'clip.txt': 'clip.txt.mp4',
    clip: 'clip.mp4',
    // no path, nothing a file system refuses, no dots or spaces at its ends
    'a/b:c*.mov': 'a b c .mp4',
    '  spaced   out . ': 'spaced out.mp4',
    '..hidden': 'hidden.mp4',
    '.mp4': 'mp4.mp4',
    'line\nbreak': 'line break.mp4',
  };
  for (const [typed, name] of Object.entries(names)) assert.equal(cleanExportName(typed), name, JSON.stringify(typed));
  // nothing left of it: no name
  for (const typed of ['', '   ', '...', '/\\:', null, undefined]) assert.equal(cleanExportName(typed), null, JSON.stringify(typed));
});

test('flashing at the limit rate is read as an envelope: at each frame the most within a quarter second either side', () => {
  assert.equal(ENVELOPE_S, 0.25);
  const n = { t: [0, 0.1, 0.2, 0.3, 0.6, 1], e: [0, 5, 0, 0, 0, 2] };
  // (0.6 s is more than a quarter second from the spike at 0.1 and from the one at 1)
  assert.deepEqual(limitRateEnvelope(n, 0, 1), [5, 5, 5, 5, 0, 2]);
  // from a later frame: the frames before it still count
  assert.deepEqual(limitRateEnvelope(n, 2, 1), [5, 5, 0, 2]);
  // up to a time: the frames at or before it
  assert.deepEqual(limitRateEnvelope(n, 0, 0.25), [5, 5, 5]);
  assert.deepEqual(limitRateEnvelope(n, 5, 1), [2]);
  assert.deepEqual(limitRateEnvelope(n, 3, 0.2), []);
  assert.deepEqual(limitRateEnvelope({ t: [], e: [] }, 0, 9), []);
  // a level stretch, and spikes that fall: each frame reads the highest still in reach
  assert.deepEqual(limitRateEnvelope({ t: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6], e: [9, 7, 5, 3, 1, 0, 0] }, 0, 9), [9, 9, 9, 7, 5, 3, 1]);
});

test("a moment on an export's clock is found again on the video's, the holds before it taken off", () => {
  // two frames held a second each, at 10 s and at 12 s of the video
  const holds = [{ at: 10, seconds: 1 }, { at: 12, seconds: 1 }];
  assert.deepEqual([0, 9.5, 11.5, 12.9, 14, 14.5, 100].map((x) => sourceTime(holds, x)), [0, 9.5, 10.5, 11.9, 12, 12.5, 98]);
  // inside a hold's silence: the hold's moment, or the frame held there, which is the one just before it
  assert.deepEqual([sourceTime(holds, 10.4), sourceTime(holds, 13.2), sourceTime(holds, 10.999)], [10, 12, 10]);
  assert.deepEqual([sourceTime(holds, 10.4, 0.001), sourceTime(holds, 13.2, 0.001)], [9.999, 11.999]);
  // and it is the way back from where the sound and the frames are put
  for (const t of [0, 3.25, 9.999, 10, 10.5, 11.999, 12, 40]) assert.ok(Math.abs(sourceTime(holds, SoundRun.outTime(holds, t)) - t) < 1e-9, `${t}`);
  assert.equal(sourceTime([], 7.5), 7.5);
});
