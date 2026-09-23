// A Web Worker running one of the decoders module's built-in decoders
// (HEVC, VP9, VP8, AV1) over one group of pictures at a time, with the
// protocol of h264worker.js (see h264pool.js); `init` names the codec.
// Pictures leave as plain I420 buffers (transferred, not copied) or, for a
// job with `shrink`, made the detector's size here straight from the
// decoder's own picture.
import init, * as dec from './pkg-dec/unflash_decoders.js';
import { ChunkReader } from './media.js';

const ready = init();
let codec = null;
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

/** The decoder's current picture as a transferable record, at `timestamp` (µs). */
function picture(d, shrink, timestamp) {
  if (shrink) return { kind: 'rgba', data: d.small(), width: shrink.aw, height: shrink.ah, timestamp, colorSpace: null, from: [d.width(), d.height()] };
  const data = new Uint8Array(dec.wasm_memory().buffer, d.frame_ptr(), d.frame_len()).slice();
  let colorSpace = null;
  try {
    colorSpace = JSON.parse(d.color_json());
  } catch (e) {
    /* default colour space */
  }
  return { data, width: d.width(), height: d.height(), timestamp, colorSpace };
}

async function run(job) {
  const { id, file, offset, size, pts, minPts, maxPts, fast, shrink } = job;
  cancelled = false;
  // each worker keeps its own window over the file; a whole copy per worker would cost too much
  const reader = new ChunkReader(file, 8 * 1024 * 1024, 16 * 1024 * 1024);
  let d;
  try {
    d = new dec.SoftDecoder(codec, desc, !!fast);
    if (shrink) d.set_shrink(shrink.aw, shrink.ah);
  } catch (e) {
    postMessage({ type: 'done', id, emitted: 0, damaged: pts.length, decodeMs: 0, decoded: 0, error: String(e && e.message ? e.message : e) });
    return;
  }
  // pictures by presentation time, handed on in that order: a decoder that
  // gives them in decode order says how many can come before one shown
  // earlier (none, for one that gives them in presentation order)
  const held = [];
  const reorder = d.reorder_depth();
  let emitted = 0;
  let damaged = 0;
  let decodeMs = 0;
  let decoded = 0;
  // after a sample the decoder could not take, what refers to it is not to be trusted
  let tainted = false;
  const post = async (pic) => {
    while (credits <= 0 && !cancelled) await wait();
    if (cancelled) return;
    credits--;
    postMessage({ type: 'frame', id, pic }, [pic.data.buffer]);
    emitted++;
  };
  // the pictures ready in the decoder: each is tagged with the index of
  // the sample it came from (exact, where a time might not round-trip)
  const collect = (n) => {
    for (let k = 0; k < n && d.next(); k++) {
      // each picture says whether it is damaged, so that a scan can stop at it
      const bad = d.frame_damaged() || tainted;
      if (bad) damaged++;
      const at = pts[d.frame_pts()];
      if (at === undefined || at < minPts || at >= maxPts) continue;
      const pic = picture(d, shrink, at);
      if (bad) pic.damaged = true;
      held.push(pic);
    }
    held.sort((a, b) => a.timestamp - b.timestamp);
  };
  try {
    for (let i = 0; i < pts.length && !cancelled; i++) {
      const data = await reader.read(offset[i], size[i]);
      const t0 = performance.now();
      let n = 0;
      try {
        n = d.decode(data, i);
      } catch (e) {
        damaged++;
        tainted = true;
      }
      decodeMs += performance.now() - t0;
      decoded++;
      collect(n);
      while (held.length > reorder && !cancelled) await post(held.shift());
    }
    if (!cancelled) {
      try {
        collect(d.flush());
      } catch (e) {
        damaged++;
        tainted = true;
      }
      while (held.length && !cancelled) await post(held.shift());
    }
  } finally {
    d.free();
  }
  postMessage({ type: 'done', id, emitted, damaged, decodeMs, decoded });
}

self.onmessage = async (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      try {
        await ready;
        codec = m.codec;
        desc = m.desc;
        new dec.SoftDecoder(codec, desc, false).free();
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
