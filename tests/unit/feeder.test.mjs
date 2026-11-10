// The feeder (web/detector.js): pictures into a detector, with the
// detector here a stand-in that notes what it is fed. A picture handed to
// the feeder is the feeder's to close, whatever becomes of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Feeder } from '../../web/detector.js';
import { rawPicture, smallPicture } from '../../web/media.js';

console.debug = () => {};

/** A detector that takes pictures as they come (or, with `more`, does otherwise) and lists what it was fed. */
function detector(more = {}) {
  const fed = [];
  return {
    fed,
    analysis_width: () => 256,
    analysis_height: () => 144,
    can_submit: () => true,
    poll: () => 0,
    gpu_wait: async () => {},
    feed_rgba: (data, w, h, t) => fed.push(['rgba', w, h, t, data.length]),
    feed_bgra: (data, w, h, t) => fed.push(['bgra', w, h, t, data.length]),
    feed_yuv: (data, w, h, layout, t) => fed.push(['yuv', w, h, t, Array.from(layout)]),
    ...more,
  };
}
/** A picture that says whether it was closed. */
const watched = (pic) => {
  pic.closed = 0;
  pic.close = () => pic.closed++;
  return pic;
};

test("pictures already in memory go to the detector as they are, and are closed once it has them", async () => {
  const det = detector();
  const feeder = new Feeder({}, det, 'cpu', () => {});
  const small = watched(smallPicture(new Uint8Array(256 * 144 * 4), 256, 144, 0, 1920, 1080));
  await feeder.videoFrame(small, 0.5);
  assert.deepEqual(det.fed, [['rgba', 256, 144, 0.5, 256 * 144 * 4]]);
  assert.equal(small.closed, 1);
  assert.equal(feeder.route, 'raw');
  assert.match(feeder.routeDetail, /1920×1080, made 256×144 by the built-in decoder/);
  // packed 4:2:0 planes from the built-in decoder, an odd size among them: chroma of 3 by 2
  const planes = watched(rawPicture(new Uint8Array(5 * 3 + 2 * 3 * 2), 5, 3, 40000, { matrix: 'smpte170m', fullRange: true }));
  await feeder.videoFrame(planes, 0.54);
  assert.deepEqual(det.fed[1], ['yuv', 5, 3, 0.54, [0, 0, 5, 15, 3, 21, 3, 0, 1]]);
  assert.equal(planes.closed, 1);
  assert.equal(feeder.fed, 2);
});

test('a picture the detector will not take is closed all the same', async () => {
  const det = detector({
    feed_rgba() {
      throw new Error('the detector would not take it');
    },
  });
  const feeder = new Feeder({}, det, 'cpu', () => {});
  const pic = watched(smallPicture(new Uint8Array(4), 1, 1, 0, 2, 2));
  await assert.rejects(feeder.videoFrame(pic, 0), /would not take it/);
  assert.equal(pic.closed, 1);
  assert.equal(feeder.fed, 0);
});

test('a picture is closed when the wait for room in the detector fails, too', async () => {
  // a detector with no room whose results cannot be read back (a lost GPU device)
  const det = detector({
    can_submit: () => false,
    poll() {
      throw new Error('the readback failed');
    },
  });
  const feeder = new Feeder({}, det, 'webgpu', () => {});
  const pic = watched(smallPicture(new Uint8Array(4), 1, 1, 0, 2, 2));
  await assert.rejects(feeder.videoFrame(pic, 0), /the readback failed/);
  assert.equal(pic.closed, 1, 'a picture left open holds its decoder up');
  assert.deepEqual(det.fed, []);
});

test('with no room in the detector, a picture waits until a result comes back', async () => {
  let room = false;
  let polls = 0;
  const det = detector({
    can_submit: () => room,
    poll() {
      polls++;
      return 0;
    },
    // (the readback wakes the wait)
    gpu_wait: async () => {
      room = true;
    },
  });
  const feeder = new Feeder({}, det, 'webgpu', () => {});
  const pic = watched(smallPicture(new Uint8Array(4), 1, 1, 0, 2, 2));
  await feeder.videoFrame(pic, 1.25);
  assert.deepEqual(det.fed, [['rgba', 1, 1, 1.25, 4]]);
  assert.ok(polls >= 1);
  assert.equal(pic.closed, 1);
});
