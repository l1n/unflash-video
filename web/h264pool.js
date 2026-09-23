// Parallel decoding with a built-in decoder: the sample range is split into
// groups of pictures at sync samples, each group goes to a Web Worker
// (h264worker.js for H.264, softworker.js for HEVC, VP9, VP8 and AV1), and
// the pictures come back in presentation order.
//
// Protocol (main -> worker): {type:'init', desc, codec} once; {type:'decode', id,
// file, offset, size, pts, minPts, maxPts} per group (samples in decode
// order; only pictures with minPts <= pts < maxPts are sent back, so the
// leading pictures of an open GOP come from the group that holds their
// references); {type:'credit', n} after consuming n pictures (the worker
// holds at most `window` unconsumed pictures; `reset: true` starts a pass
// with exactly n); {type:'cancel'}.
// Worker -> main: {type:'ready'} | {type:'error', message} |
// {type:'frame', id, pic} (a transferred I420 picture record: data, width,
// height, timestamp, colorSpace; or, for a job with `shrink` ({aw, ah}),
// kind 'rgba' at that size) | {type:'done', id, emitted, damaged,
// decodeMs, decoded}.
import { rawPicture } from './media.js';
import { profile } from './profile.js';
import { builtInFor } from './codecs.js';

/** How many decoder workers to run: leave a core for the page itself. */
export function defaultWorkerCount() {
  const forced = parseInt(new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('workers') || '', 10);
  if (forced > 0) return Math.min(forced, 16);
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(6, cores - 1));
}

/** A picture a worker made the detector's size, shaped like a raw one for the Feeder. */
function smallPicture(p) {
  return {
    raw: true,
    kind: 'rgba',
    format: 'RGBA',
    codedWidth: p.width,
    codedHeight: p.height,
    displayWidth: p.width,
    displayHeight: p.height,
    timestamp: p.timestamp,
    data: p.data,
    detail: `${p.from[0]}×${p.from[1]}, made ${p.width}×${p.height} by the built-in decoder`,
    close() {},
  };
}

export class SoftwarePool {
  constructor(movie, workers, codec) {
    this.movie = movie;
    this.workers = workers;
    this.codec = codec;
    this.busy = false;
  }

  /** Spawn and initialise the workers (rejects when workers cannot run the decoder). */
  static async create(movie, size = defaultWorkerCount()) {
    if (typeof Worker === 'undefined') throw new Error('Web Workers are not available');
    const codec = builtInFor(movie.video.codec);
    if (!codec) throw new Error(`there is no built-in decoder for ${movie.video.codec}`);
    const desc = movie.dx.track_description(movie.video.index);
    const url = codec.id === 'h264' ? new URL('./h264worker.js', import.meta.url) : new URL('./softworker.js', import.meta.url);
    const workers = [];
    try {
      for (let k = 0; k < size; k++) workers.push(new Worker(url, { type: 'module' }));
      await Promise.all(
        workers.map(
          (w) =>
            new Promise((resolve, reject) => {
              const onMessage = (e) => {
                if (e.data.type === 'ready') {
                  cleanup();
                  resolve();
                } else if (e.data.type === 'error') {
                  cleanup();
                  reject(new Error(e.data.message));
                }
              };
              const onError = (e) => {
                cleanup();
                reject(new Error(e.message || 'the decoder worker failed to start'));
              };
              const cleanup = () => {
                w.removeEventListener('message', onMessage);
                w.removeEventListener('error', onError);
              };
              w.addEventListener('message', onMessage);
              w.addEventListener('error', onError);
              w.postMessage({ type: 'init', desc, codec: codec.id });
            })
        )
      );
    } catch (e) {
      for (const w of workers) w.terminate();
      throw e;
    }
    return new SoftwarePool(movie, workers, codec);
  }

  close() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }

  /**
   * Split the samples [startIdx, endIdx) (decode order) into groups that
   * start at sync samples; small groups are merged with the next one.
   */
  groups(startIdx, endIdx) {
    const { pts, sync } = this.movie.v;
    const n = pts.length;
    const bounds = [startIdx];
    for (let i = startIdx + 1; i < endIdx; i++) if (sync[i] && i - bounds[bounds.length - 1] >= 4) bounds.push(i);
    bounds.push(endIdx);
    const groups = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const a = bounds[k];
      const b = bounds[k + 1];
      let ext = b;
      let maxPts = Infinity;
      if (k + 2 < bounds.length) {
        // the next group's leading pictures (pts before its sync sample)
        // reference this group: decode them here, the next group drops them
        maxPts = pts[b];
        let j = b + 1;
        while (j < n && pts[j] < maxPts) j++;
        if (j > b + 1) ext = j;
      }
      groups.push({ a, ext, minPts: pts[a], maxPts });
    }
    return groups;
  }

  /**
   * How many decoded pictures each worker may hold for the page: a memory
   * budget shared by the workers, so that a worker can decode a group or
   * more ahead while the page consumes an earlier one (the page takes the
   * groups in order: a worker that has to stop a few pictures into its
   * group leaves the pool little faster than one worker). Pictures made
   * `small` ({aw, ah}, RGBA) cost little to hold: a long GOP's worth.
   */
  window(small = null) {
    const frameBytes = small ? small.aw * small.ah * 4 : Math.max(1, this.movie.width * this.movie.height * 1.5);
    const gb = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4;
    const budget = Math.min(768, Math.max(192, gb * 96)) * 1024 * 1024;
    const fit = Math.floor(budget / Math.max(1, this.workers.length) / Math.max(1, frameBytes));
    return small ? Math.max(64, Math.min(512, fit)) : Math.max(4, Math.min(256, fit));
  }

  /**
   * Decode the samples [startIdx, endIdx) and hand every picture with a
   * presentation time in [startSec, endSec) to `onFrame(frame, tSec)` in
   * presentation order. Returns the number of frames delivered.
   */
  async decodeRange(startIdx, endIdx, startSec, endSec, onFrame, opts = {}) {
    let given = false;
    const next = () => {
      if (given) return null;
      given = true;
      return { startIdx, endIdx, startSec, endSec };
    };
    const { onProgress } = opts;
    return this.decodeStretches(next, onFrame, { ...opts, onProgress: onProgress ? (k, n) => onProgress(k / n) : null });
  }

  /**
   * Decode stretch after stretch as one pass: `next()` hands out the next
   * stretch, { startIdx, endIdx, startSec, endSec } (samples in decode
   * order; the pictures shown in [startSec, endSec) are kept), or null when
   * there are no more. It is asked only when a worker is free for more, so
   * what it has not handed out yet can still go elsewhere (a hybrid scan
   * gives it to another decoder). The pictures of consecutive stretches
   * reach `onFrame(frame, tSec)` in presentation order, with no pause for
   * the workers at the seams. With `strict`, a damaged picture fails the
   * pass instead of being handed on. Returns the number of frames delivered.
   */
  async decodeStretches(next, onFrame, { cancel, onProgress, window, raw = false, fast = false, shrink = null, strict = false } = {}) {
    if (this.busy) throw new Error('the decoder pool is busy');
    this.busy = true;
    // pictures made small (raw ones for the detector only) cost little to hold
    const small = raw && shrink && shrink.aw > 0 && shrink.ah > 0 ? { aw: shrink.aw, ah: shrink.ah } : null;
    if (!window) window = this.window(small);
    const { pts, offset, size } = this.movie.v;
    const groups = [];
    const out = [];
    let exhausted = false;
    // the next stretch's groups, when a worker needs one
    const more = () => {
      while (!exhausted) {
        const s = next();
        if (!s) {
          exhausted = true;
          break;
        }
        const gs = this.groups(s.startIdx, s.endIdx);
        for (const g of gs) {
          groups.push({ ...g, startSec: s.startSec, endSec: s.endSec });
          out.push({ queue: [], done: false, damaged: 0, error: null, worker: null });
        }
        if (gs.length) return true;
      }
      return false;
    };
    let nextJob = 0;
    let inflight = 0;
    let wakeResolve = null;
    const wait = () => new Promise((r) => (wakeResolve = r));
    const wake = () => {
      if (wakeResolve) {
        const r = wakeResolve;
        wakeResolve = null;
        r();
      }
    };
    const assign = (w) => {
      if (nextJob >= groups.length && !more()) return;
      const k = nextJob++;
      const g = groups[k];
      out[k].worker = w;
      inflight++;
      w.postMessage({ type: 'decode', id: k, file: this.movie.file, offset: offset.slice(g.a, g.ext), size: size.slice(g.a, g.ext), pts: pts.slice(g.a, g.ext), minPts: g.minPts, maxPts: g.maxPts, fast: !!fast, shrink: small });
    };
    const handlers = this.workers.map((w) => {
      const h = (e) => {
        const m = e.data;
        if (m.type === 'frame') out[m.id].queue.push(m.pic.kind === 'rgba' ? smallPicture(m.pic) : rawPicture(m.pic.data, m.pic.width, m.pic.height, m.pic.timestamp, m.pic.colorSpace));
        else if (m.type === 'done') {
          const o = out[m.id];
          o.done = true;
          o.damaged = m.damaged;
          o.error = m.error || null;
          if (m.decoded) profile.add('sw.decode', m.decodeMs, m.decoded);
          if (m.error) console.warn(`built-in ${this.codec.name} decoder:`, m.error);
          inflight--;
          assign(w);
        }
        wake();
      };
      w.addEventListener('message', h);
      // this pass's window, whatever an earlier pass left unused
      w.postMessage({ type: 'credit', n: window, reset: true });
      return h;
    });
    let frames = 0;
    let damaged = 0;
    let stopped = false;
    try {
      for (const w of this.workers) assign(w);
      // a worker that finishes a group takes the next one, or asks for the
      // next stretch: once the page is past the last group there is no more
      for (let k = 0; k < groups.length; k++) {
        const o = out[k];
        const g = groups[k];
        for (;;) {
          if (cancel && cancel()) {
            stopped = true;
            break;
          }
          if (o.queue.length) {
            const pic = o.queue.shift();
            const t = pic.timestamp / 1e6;
            if (t >= g.startSec - 1e-6 && t < g.endSec - 1e-9) {
              await onFrame(raw ? pic : pic.toVideoFrame(), t);
              frames++;
            }
            o.worker.postMessage({ type: 'credit', n: 1 });
          } else if (o.done) break;
          else {
            const tw = performance.now();
            await wait();
            profile.add('sw.wait', performance.now() - tw);
          }
        }
        if (stopped) break;
        damaged += o.damaged;
        if (strict && o.damaged) throw new Error(o.error ? `the built-in decoder failed: ${o.error}` : `the built-in decoder damaged ${o.damaged} picture${o.damaged === 1 ? '' : 's'}`);
        if (onProgress) onProgress(k + 1, groups.length);
      }
    } finally {
      // stop whatever is still running and take the workers back
      exhausted = true;
      nextJob = groups.length;
      for (const w of this.workers) w.postMessage({ type: 'cancel' });
      while (inflight > 0) await wait();
      for (const o of out) o.queue.length = 0;
      this.workers.forEach((w, i) => w.removeEventListener('message', handlers[i]));
      this.busy = false;
    }
    if (damaged) console.warn(`built-in ${this.codec.name} decoder: ${damaged} damaged pictures`);
    return frames;
  }
}
