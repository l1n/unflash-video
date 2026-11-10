// A decode in a worker, from the page's side (web/media.js decodeRange):
// the worker here is a stand-in that sends what a test tells it to. The
// page hands each picture on, gives the worker credit for it, and leaves
// no picture open whatever goes wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRange } from '../../web/media.js';

// (decodeRange takes a worker only where there are workers)
globalThis.Worker = class {};

/** A worker that, asked to decode, does what `script(worker, job)` says. */
class FakeWorker {
  constructor(script) {
    this.script = script;
    this.listeners = { message: new Set(), error: new Set() };
    this.posted = [];
    this.terminated = false;
  }
  addEventListener(type, fn) {
    this.listeners[type].add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type].delete(fn);
  }
  postMessage(m) {
    this.posted.push(m);
    if (m.type === 'decode') queueMicrotask(() => this.script(this, m));
    if (m.type === 'cancel' && this.onCancel) this.onCancel(m);
  }
  /** A message from the worker to the page. */
  say(data) {
    for (const fn of [...this.listeners.message]) fn({ data });
  }
  fail(message) {
    for (const fn of [...this.listeners.error]) fn({ message });
  }
  terminate() {
    this.terminated = true;
  }
  count(type) {
    return this.posted.filter((m) => m.type === type).length;
  }
}

/** A picture the worker could not copy, sent as it is: it counts its closings. */
const frame = (seconds) => ({ timestamp: seconds * 1e6, closed: 0, close() { this.closed++; } });

/** Ten seconds of film at ten frames a second, every frame a keyframe, decoded by `worker`. */
function movie(worker) {
  const n = 100;
  const pts = Float64Array.from({ length: n }, (_, i) => i * 100000);
  const slot = { worker, busy: false };
  const m = {
    v: { pts, dts: pts, offset: new Float64Array(n), size: new Uint32Array(n), sync: new Uint8Array(n).fill(1), dur: new Float64Array(n).fill(100000) },
    video: { index: 0 },
    dx: { sync_before: (_t, sec) => Math.max(0, Math.min(n - 1, Math.floor(sec * 10 + 1e-9))) },
    tsMin: 0,
    file: {},
    decoderConfig: () => ({ codec: 'vp09.00.21.08' }),
    decodeWorkers: [slot],
    decodeWorker() {
      slot.busy = true;
      return slot;
    },
    slot,
  };
  return m;
}
const decode = (m, onFrame, more = {}) => decodeRange(m, 2, 3, onFrame, { raw: true, workers: true, ...more });

test('the page hands on each picture the worker sends, and gives it credit for each', async () => {
  const frames = [frame(2), frame(2.1), frame(2.2)];
  const worker = new FakeWorker((w, job) => {
    for (const f of frames) w.say({ id: job.id, type: 'frame', frame: f });
    w.say({ id: job.id, type: 'done' });
  });
  const m = movie(worker);
  const got = [];
  const count = await decode(m, async (f, t) => {
    got.push(t);
    f.close();
  });
  assert.equal(count, 3);
  assert.deepEqual(got, [2, 2.1, 2.2]);
  assert.deepEqual(frames.map((f) => f.closed), [1, 1, 1]);
  // the job as the worker was told of it: the samples from the keyframe before 2 s to past 3 s
  const job = worker.posted[0];
  assert.deepEqual([job.type, job.startUs, job.endUs, job.pts[0], job.pts.length, job.window, job.shrink], ['decode', 2e6, 3e6, 2e6, 10, 4, null]);
  assert.equal(worker.count('credit'), 3);
  // done with, the worker is free for the next pass and nobody listens to it any more
  assert.deepEqual([m.slot.busy, worker.terminated, worker.listeners.message.size, worker.listeners.error.size], [false, false, 0, 0]);
});

test('messages of another job are not this one\'s', async () => {
  const mine = frame(2);
  const worker = new FakeWorker((w, job) => {
    w.say({ id: job.id + 1000, type: 'frame', frame: frame(9) });
    w.say({ id: job.id + 1000, type: 'done' });
    w.say({ id: job.id, type: 'frame', frame: mine });
    w.say({ id: job.id, type: 'done' });
  });
  const got = [];
  await decode(movie(worker), async (f, t) => got.push(t));
  assert.deepEqual(got, [2]);
});

test('when the page cannot take a picture, the ones already sent are closed too', async () => {
  const frames = [frame(2), frame(2.1), frame(2.2)];
  // (all three and the end of the job are in before the page looks at the first)
  const worker = new FakeWorker((w, job) => {
    for (const f of frames) w.say({ id: job.id, type: 'frame', frame: f });
    w.say({ id: job.id, type: 'done' });
  });
  const m = movie(worker);
  await assert.rejects(
    decode(m, async (f) => {
      f.close();
      throw new Error('the detector failed');
    }),
    /the detector failed/
  );
  assert.deepEqual(frames.map((f) => f.closed), [1, 1, 1], 'a picture left open is memory the browser cannot take back');
  assert.equal(worker.count('cancel'), 1);
  // the worker ended its job: it is kept
  assert.deepEqual([m.slot.busy, worker.terminated], [false, false]);
});

test('a cancel tells the worker to stop, and closes what it had sent', async () => {
  const frames = [frame(2), frame(2.1), frame(2.2), frame(2.3)];
  let cancelled = false;
  const worker = new FakeWorker((w, job) => {
    for (const f of frames.slice(0, 3)) w.say({ id: job.id, type: 'frame', frame: f });
    // told to stop, the worker sends what it was in the middle of and ends its job
    w.onCancel = () =>
      queueMicrotask(() => {
        w.say({ id: job.id, type: 'frame', frame: frames[3] });
        w.say({ id: job.id, type: 'done' });
      });
  });
  const got = [];
  const count = await decode(
    movie(worker),
    async (f, t) => {
      got.push(t);
      f.close();
      cancelled = true;
    },
    { cancel: () => cancelled }
  );
  assert.equal(count, 1);
  assert.deepEqual(got, [2]);
  assert.deepEqual(frames.map((f) => f.closed), [1, 1, 1, 1]);
  assert.equal(worker.count('cancel'), 1);
});

test('a worker that stops, or says its decoder failed, ends the pass with the reason', async () => {
  const crashed = new FakeWorker((w) => w.fail('out of memory'));
  const m = movie(crashed);
  await assert.rejects(decode(m, async () => {}), /the decode worker stopped: out of memory/);
  // a worker that stopped is not used again
  assert.deepEqual([crashed.terminated, m.decodeWorkers.length], [true, 0]);
  const refused = new FakeWorker((w, job) => w.say({ id: job.id, type: 'error', message: 'the decoder would not start' }));
  const m2 = movie(refused);
  await assert.rejects(decode(m2, async () => {}), /the decoder would not start/);
  assert.deepEqual([refused.terminated, m2.decodeWorkers.length], [true, 0]);
});
