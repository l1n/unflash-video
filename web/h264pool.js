// Parallel decoding with the built-in H.264 decoder: the sample range is
// split into groups of pictures at sync samples, each group goes to a Web
// Worker (h264worker.js), and the pictures come back in presentation order.
//
// Protocol (main -> worker): {type:'init', desc} once; {type:'decode', id,
// file, offset, size, pts, minPts, maxPts} per group (samples in decode
// order; only pictures with minPts <= pts < maxPts are sent back, so the
// leading pictures of an open GOP come from the group that holds their
// references); {type:'credit', n} after consuming n pictures (the worker
// holds at most `window` unconsumed pictures); {type:'cancel'}.
// Worker -> main: {type:'ready'} | {type:'error', message} |
// {type:'frame', id, pic} (a transferred I420 picture record: data, width,
// height, timestamp, colorSpace) | {type:'done', id, emitted, damaged,
// decodeMs, decoded}.
import { rawPicture } from './media.js';
import { profile } from './profile.js';

/** How many decoder workers to run: leave a core for the page itself. */
export function defaultWorkerCount() {
  const forced = parseInt(new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('workers') || '', 10);
  if (forced > 0) return Math.min(forced, 16);
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(6, cores - 1));
}

export class SoftwarePool {
  constructor(movie, workers) {
    this.movie = movie;
    this.workers = workers;
    this.busy = false;
  }

  /** Spawn and initialise the workers (rejects when workers cannot run the decoder). */
  static async create(movie, size = defaultWorkerCount()) {
    if (typeof Worker === 'undefined') throw new Error('Web Workers are not available');
    const desc = movie.dx.track_description(movie.video.index);
    const url = new URL('./h264worker.js', import.meta.url);
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
              w.postMessage({ type: 'init', desc });
            })
        )
      );
    } catch (e) {
      for (const w of workers) w.terminate();
      throw e;
    }
    return new SoftwarePool(movie, workers);
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
   * Decode the samples [startIdx, endIdx) and hand every picture with a
   * presentation time in [startSec, endSec) to `onFrame(frame, tSec)` in
   * presentation order. Returns the number of frames delivered.
   */
  /**
   * How many decoded pictures each worker may hold for the page: a memory
   * budget shared by the workers, so later groups can be decoded while an
   * earlier one is being consumed.
   */
  window() {
    const frameBytes = Math.max(1, this.movie.width * this.movie.height * 1.5);
    const gb = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4;
    const budget = Math.min(768, Math.max(192, gb * 96)) * 1024 * 1024;
    return Math.max(4, Math.min(256, Math.floor(budget / Math.max(1, this.workers.length) / frameBytes)));
  }

  async decodeRange(startIdx, endIdx, startSec, endSec, onFrame, { cancel, onProgress, window, raw = false, fast = false } = {}) {
    if (this.busy) throw new Error('the decoder pool is busy');
    this.busy = true;
    if (!window) window = this.window();
    const { pts, offset, size } = this.movie.v;
    const groups = this.groups(startIdx, endIdx);
    const out = groups.map(() => ({ queue: [], done: false, damaged: 0, worker: null }));
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
      if (nextJob >= groups.length) return;
      const k = nextJob++;
      const g = groups[k];
      out[k].worker = w;
      inflight++;
      w.postMessage({ type: 'decode', id: k, file: this.movie.file, offset: offset.slice(g.a, g.ext), size: size.slice(g.a, g.ext), pts: pts.slice(g.a, g.ext), minPts: g.minPts, maxPts: g.maxPts, fast: !!fast });
    };
    const handlers = this.workers.map((w) => {
      const h = (e) => {
        const m = e.data;
        if (m.type === 'frame') out[m.id].queue.push(rawPicture(m.pic.data, m.pic.width, m.pic.height, m.pic.timestamp, m.pic.colorSpace));
        else if (m.type === 'done') {
          out[m.id].done = true;
          out[m.id].damaged = m.damaged;
          if (m.decoded) profile.add('sw.decode', m.decodeMs, m.decoded);
          if (m.error) console.warn('built-in H.264 decoder:', m.error);
          inflight--;
          assign(w);
        }
        wake();
      };
      w.addEventListener('message', h);
      w.postMessage({ type: 'credit', n: window });
      return h;
    });
    let frames = 0;
    let damaged = 0;
    let stopped = false;
    try {
      for (const w of this.workers) assign(w);
      for (let k = 0; k < groups.length; k++) {
        const o = out[k];
        for (;;) {
          if (cancel && cancel()) {
            stopped = true;
            break;
          }
          if (o.queue.length) {
            const pic = o.queue.shift();
            const t = pic.timestamp / 1e6;
            if (t >= startSec - 1e-6 && t < endSec - 1e-9) {
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
        if (onProgress) onProgress((k + 1) / groups.length);
      }
    } finally {
      // stop whatever is still running and take the workers back
      nextJob = groups.length;
      for (const w of this.workers) w.postMessage({ type: 'cancel' });
      while (inflight > 0) await wait();
      for (const o of out) o.queue.length = 0;
      this.workers.forEach((w, i) => w.removeEventListener('message', handlers[i]));
      // credits granted but unused must not carry over
      this.busy = false;
    }
    if (damaged) console.warn(`built-in H.264 decoder: ${damaged} damaged pictures`);
    return frames;
  }
}
