// A Web Worker running the built-in H.264 decoder over one group of
// pictures at a time (see h264pool.js for the protocol). Pictures leave as
// plain I420 buffers (transferred, not copied), or, for a job with
// `shrink`, made the detector's size here straight from the decoder's own
// picture, so the full-size picture never leaves WebAssembly memory.
import init, * as wasm from './pkg/unflash.js';
import { ChunkReader, yuvLayoutWords } from './media.js';

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

/** The picture the decoder just produced, copied out of WASM memory as a transferable record. */
function picture(dec, timestamp) {
  const width = dec.width();
  const height = dec.height();
  const data = new Uint8Array(wasm.wasm_memory().buffer, dec.frame_ptr(), dec.frame_len()).slice();
  let colorSpace = null;
  try {
    colorSpace = JSON.parse(dec.color_json());
  } catch (e) {
    /* default colour space */
  }
  return { data, width, height, timestamp, colorSpace };
}

/** The picture the decoder just made small (see `run`). */
function smallPicture(dec, shrink, timestamp) {
  const data = dec.small();
  return { kind: 'rgba', data, width: shrink.aw, height: shrink.ah, timestamp, colorSpace: null, from: [dec.width(), dec.height()] };
}

async function run(job) {
  const { id, file, offset, size, pts, minPts, maxPts, fast, shrink } = job;
  cancelled = false;
  // each worker keeps its own window over the file; a whole copy per worker would cost too much
  const reader = new ChunkReader(file, 8 * 1024 * 1024, 16 * 1024 * 1024);
  let dec;
  try {
    dec = new wasm.H264Decoder(desc, !!fast);
    if (shrink) {
      // the colour conversion the page would pick for these pictures
      let colorSpace = null;
      try {
        colorSpace = JSON.parse(dec.color_json());
      } catch (e) {
        /* default colour space */
      }
      const words = yuvLayoutWords('I420', [{ offset: 0, stride: 0 }, { offset: 0, stride: 0 }, { offset: 0, stride: 0 }], colorSpace, dec.height());
      dec.set_shrink(shrink.aw, shrink.ah, words[7] === 1, words[8] === 1);
    }
  } catch (e) {
    postMessage({ type: 'done', id, emitted: 0, damaged: pts.length, decodeMs: 0, decoded: 0, error: String(e && e.message ? e.message : e) });
    return;
  }
  // presentation order of the pictures this job emits
  const order = Array.from(pts).filter((p) => p >= minPts && p < maxPts).sort((a, b) => a - b);
  const pictures = new Map(); // pts -> picture record
  let next = 0;
  let emitted = 0;
  let damaged = 0;
  let decodeMs = 0;
  let decoded = 0;
  // after a sample the decoder could not take, what refers to it is not to be trusted
  let tainted = false;
  const release = async () => {
    while (next < order.length && pictures.has(order[next])) {
      const pic = pictures.get(order[next]);
      pictures.delete(order[next]);
      next++;
      while (credits <= 0 && !cancelled) await wait();
      if (cancelled) continue;
      credits--;
      postMessage({ type: 'frame', id, pic }, [pic.data.buffer]);
      emitted++;
    }
  };
  try {
    for (let i = 0; i < pts.length && !cancelled; i++) {
      const data = await reader.read(offset[i], size[i]);
      let got = false;
      const t0 = performance.now();
      try {
        got = dec.decode(data, pts[i] / 1e6);
      } catch (e) {
        damaged++;
        tainted = true;
      }
      decodeMs += performance.now() - t0;
      decoded++;
      if (got) {
        // each picture says whether it is damaged, so that a scan can stop at it
        const bad = dec.frame_damaged() || tainted;
        if (bad) damaged++;
        if (pts[i] >= minPts && pts[i] < maxPts) {
          const pic = shrink ? smallPicture(dec, shrink, pts[i]) : picture(dec, pts[i]);
          if (bad) pic.damaged = true;
          pictures.set(pts[i], pic);
        }
      } else {
        // no picture for this sample: do not wait for it
        const k = order.indexOf(pts[i]);
        if (k >= 0) order.splice(k, 1);
      }
      await release();
    }
  } finally {
    dec.free();
  }
  postMessage({ type: 'done', id, emitted, damaged, decodeMs, decoded });
}

self.onmessage = async (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      try {
        await ready;
        desc = m.desc;
        new wasm.H264Decoder(desc, false).free();
        postMessage({ type: 'ready' });
      } catch (err) {
        postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
      }
      break;
    case 'credit':
      credits = m.reset ? m.n : credits + m.n;
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
