// A Web Worker running the built-in H.264 decoder over one group of
// pictures at a time (see h264pool.js for the protocol).
import init, * as wasm from './pkg/unflash.js';
import { ChunkReader, softwareFrame } from './media.js';

const ready = init();
let desc = null;
let credits = 0;
let cancelled = false;
let wakeResolve = null;
const wait = () => new Promise((r) => (wakeResolve = r));
const wake = () => {
  if (wakeResolve) {
    const r = wakeResolve;
    wakeResolve = null;
    r();
  }
};

async function run(job) {
  const { id, file, offset, size, pts, minPts, maxPts } = job;
  cancelled = false;
  const reader = new ChunkReader(file);
  let dec;
  try {
    dec = new wasm.H264Decoder(desc);
  } catch (e) {
    postMessage({ type: 'done', id, emitted: 0, damaged: pts.length, error: String(e && e.message ? e.message : e) });
    return;
  }
  // presentation order of the pictures this job emits
  const order = Array.from(pts).filter((p) => p >= minPts && p < maxPts).sort((a, b) => a - b);
  const pictures = new Map(); // pts -> VideoFrame
  let next = 0;
  let emitted = 0;
  let damaged = 0;
  const release = async () => {
    while (next < order.length && pictures.has(order[next])) {
      const f = pictures.get(order[next]);
      pictures.delete(order[next]);
      next++;
      while (credits <= 0 && !cancelled) await wait();
      if (cancelled) {
        f.close();
        continue;
      }
      credits--;
      postMessage({ type: 'frame', id, frame: f }, [f]);
      emitted++;
    }
  };
  try {
    for (let i = 0; i < pts.length && !cancelled; i++) {
      const data = await reader.read(offset[i], size[i]);
      let got = false;
      try {
        got = dec.decode(data, pts[i] / 1e6);
      } catch (e) {
        damaged++;
      }
      if (got) {
        if (dec.frame_damaged()) damaged++;
        if (pts[i] >= minPts && pts[i] < maxPts) pictures.set(pts[i], softwareFrame(wasm, dec, pts[i]));
      } else {
        // no picture for this sample: do not wait for it
        const k = order.indexOf(pts[i]);
        if (k >= 0) order.splice(k, 1);
      }
      await release();
    }
  } finally {
    for (const f of pictures.values()) f.close();
    dec.free();
  }
  postMessage({ type: 'done', id, emitted, damaged });
}

self.onmessage = async (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      try {
        await ready;
        desc = m.desc;
        new wasm.H264Decoder(desc).free();
        postMessage({ type: 'ready' });
      } catch (err) {
        postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
      }
      break;
    case 'credit':
      credits += m.n;
      wake();
      break;
    case 'cancel':
      cancelled = true;
      wake();
      break;
    case 'decode':
      await run(m);
      break;
    default:
      break;
  }
};
