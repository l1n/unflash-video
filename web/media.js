import { profile } from './profile.js';
import { builtInFor, loadDecoders } from './codecs.js';
// Demuxing (through the WASM MP4 parser, served byte ranges from the File)
// and decoding through WebCodecs.

export const tick = () => new Promise((r) => setTimeout(r, 0));

// A turn of the event loop that a hidden tab does not slow down: timers
// there fire once a second at most (Firefox, Chrome), messages at once.
const yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const yieldQueue = [];
if (yieldChannel) yieldChannel.port1.onmessage = () => yieldQueue.shift()();
export const yieldTask = () =>
  yieldChannel
    ? new Promise((r) => {
        yieldQueue.push(r);
        yieldChannel.port2.postMessage(0);
      })
    : tick();

/**
 * Settles when `promise` does or after `ms`, whichever is first: a safety
 * net for waits on events that should come but might not (a lost device).
 */
export const orTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);

/**
 * Reads sample bytes out of a File. A file up to `wholeLimit` bytes is read
 * whole the first time and kept, so every later pass over it (prepare,
 * export, verify) costs no file access at all; a larger one is read through
 * a window that follows the reads. A Movie keeps one reader for all its
 * passes: some browsers charge a good fraction of a second for the first
 * read of a file, and that is paid once rather than per pass.
 */
export class ChunkReader {
  constructor(file, chunkSize = 8 * 1024 * 1024, wholeLimit = 64 * 1024 * 1024, parent = null) {
    this.file = file;
    this.chunk = chunkSize;
    this.wholeLimit = wholeLimit;
    this.parent = parent;
    this.whole = null; // the whole small file, read once (a promise, so readers at the same time share it)
    this.buf = null;
    this.start = 0;
    this.end = 0;
  }
  async read(offset, size) {
    if (this.file.size <= this.wholeLimit) {
      const root = this.parent || this;
      if (!root.whole) root.whole = root.file.slice(0, root.file.size).arrayBuffer().then((b) => new Uint8Array(b));
      const all = await root.whole;
      return all.subarray(offset, offset + size);
    }
    if (!(this.buf && offset >= this.start && offset + size <= this.end)) {
      const start = offset;
      const end = Math.min(this.file.size, Math.max(offset + size, offset + this.chunk));
      this.buf = new Uint8Array(await this.file.slice(start, end).arrayBuffer());
      this.start = start;
      this.end = end;
    }
    return this.buf.subarray(offset - this.start, offset - this.start + size);
  }
  /**
   * A reader of the same file with a window of its own (a small file read
   * whole is shared): for passes that read different parts of the file at
   * the same time, which would otherwise take turns re-reading one window.
   */
  fork() {
    return new ChunkReader(this.file, this.chunk, this.wholeLimit, this.parent || this);
  }
  /** Forget the bytes read so far. */
  release() {
    this.whole = null;
    this.buf = null;
    this.start = 0;
    this.end = 0;
  }
}

function median(arr) {
  if (!arr.length) return 0;
  const v = Array.from(arr).sort((a, b) => a - b);
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

/**
 * An opened video file (MP4 / MOV / M4V, MKV / WebM): track info and sample
 * tables. An MP4's index is read on its own; a Matroska file keeps none, so
 * it is read through once (`onProgress(fraction)` follows that).
 */
export class Movie {
  static async open(file, wasm, { onProgress = null } = {}) {
    const dx = new wasm.Demuxer(file.size);
    while (!dx.is_done()) {
      const need = dx.need();
      if (!need.length) break;
      const [off, len] = need;
      const buf = new Uint8Array(await file.slice(off, off + len).arrayBuffer());
      try {
        dx.feed(off, buf);
      } catch (e) {
        dx.free();
        throw e instanceof Error ? e : new Error(String(e));
      }
      if (onProgress) onProgress(dx.progress(), dx.container());
    }
    if (!dx.is_done()) throw new Error('The file ended before its index could be read');
    const info = JSON.parse(dx.movie_json());
    const vt = info.tracks.find((t) => t.kind === 'video' && t.samples > 0);
    if (!vt) {
      const unusable = info.tracks.find((t) => t.kind === 'video' && t.note);
      throw new Error(unusable ? `This file's video can't be read: ${unusable.note}` : 'No video track found in this file');
    }
    const at = info.tracks.find((t) => t.kind === 'audio' && t.samples > 0) || null;
    const m = new Movie();
    m.format = info.format || 'mp4';
    // tracks an MP4 export leaves out: subtitles, other audio tracks
    m.subtitleTracks = info.tracks.filter((t) => t.kind === 'other' && /^S_/.test(t.codec)).length;
    m.otherAudioTracks = info.tracks.filter((t) => t.kind === 'audio' && t.samples > 0).length - (at ? 1 : 0);
    m.file = file;
    m.reader = new ChunkReader(file);
    m.name = file.name;
    m.wasm = wasm;
    m.software = false;
    m.dx = dx;
    m.info = info;
    m.video = vt;
    m.audio = at;
    const table = (idx) => ({
      offset: dx.sample_table(idx, 'offset'),
      size: dx.sample_table(idx, 'size'),
      pts: dx.sample_table(idx, 'pts_us'),
      dts: dx.sample_table(idx, 'dts_us'),
      dur: dx.sample_table(idx, 'duration_us'),
      ptsTicks: dx.sample_table(idx, 'pts_ticks'),
      dtsTicks: dx.sample_table(idx, 'dts_ticks'),
      durTicks: dx.sample_table(idx, 'duration_ticks'),
      sync: dx.sample_table(idx, 'sync'),
    });
    m.v = table(vt.index);
    m.a = at ? table(at.index) : null;
    m.keyframes = Array.from(dx.keyframe_times(vt.index));
    // the real timeline: presentation order, not decode order
    const pts = Array.from(m.v.pts).sort((a, b) => a - b);
    const deltas = [];
    for (let i = 1; i < pts.length; i++) deltas.push(pts[i] - pts[i - 1]);
    let med = median(deltas.filter((d) => d > 0)) || 1e6 / 30;
    // Matroska rounds times to its tick (a millisecond, usually): 29.97 fps
    // shows as gaps of 33 and 34 ms, so the file's own frame duration, when
    // it gives one close to the median, is the better figure
    const nominal = vt.frame_duration > 0 ? (vt.frame_duration / vt.timescale) * 1e6 : 0;
    if (nominal > 0 && Math.abs(nominal - med) <= 0.15 * med) med = nominal;
    m.medianDelta = med / 1e6;
    m.fps = 1e6 / med;
    m.tsMin = pts.length ? pts[0] / 1e6 : 0;
    m.tsMax = pts.length ? (pts[pts.length - 1] + med) / 1e6 : 0;
    m.bounds = [m.tsMin, m.tsMax];
    m.duration = m.tsMax - m.tsMin;
    m.frameCount = pts.length;
    m.width = vt.width;
    m.height = vt.height;
    return m;
  }

  /** Release the decoder workers (if any); the Movie is not usable afterwards. */
  close() {
    if (this.pool) {
      this.pool.close();
      this.pool = null;
    }
    for (const w of this.decodeWorkers || []) w.worker.terminate();
    this.decodeWorkers = [];
    this.poolPromise = null;
    if (this.reader) this.reader.release();
  }

  /** A WebCodecs decode worker for one pass: an idle one, or a new one (kept for the next pass). */
  decodeWorker() {
    this.decodeWorkers = this.decodeWorkers || [];
    const idle = this.decodeWorkers.find((w) => !w.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    const slot = { worker: new Worker(new URL('./decodeworker.js', import.meta.url), { type: 'module' }), busy: true };
    this.decodeWorkers.push(slot);
    return slot;
  }

  /**
   * The worker pool for the built-in decoder, created on first use; null
   * when workers cannot run it (the page then decodes inline).
   */
  async softwarePool() {
    if (this.pool) return this.pool;
    if (this.poolFailed) return null;
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        try {
          const { SoftwarePool } = await import('./h264pool.js');
          this.pool = await SoftwarePool.create(this);
          return this.pool;
        } catch (e) {
          console.warn(`built-in ${(builtInFor(this.video.codec) || { name: '' }).name} decoder: decoding on the page instead of in workers:`, e && e.message ? e.message : e);
          this.poolFailed = true;
          return null;
        }
      })();
    }
    return this.poolPromise;
  }

  decoderConfig() {
    const desc = this.dx.track_description(this.video.index);
    const cfg = {
      codec: this.video.codec,
      codedWidth: this.video.width,
      codedHeight: this.video.height,
      hardwareAcceleration: 'no-preference',
      optimizeForLatency: false,
    };
    if (desc.length) cfg.description = desc;
    return cfg;
  }

  /**
   * Whether the file can be decoded: by WebCodecs, or, for a codec the
   * browser has no decoder for (H.264 in some Chromium builds, HEVC in most
   * browsers, VP9 or AV1 in some), by the app's built-in decoder for it
   * (`software: true`; `builtIn` names it). With `forceBuiltIn` set, the
   * built-in decoder is used whenever there is one. VideoFrame itself has
   * to exist either way.
   */
  async decoderSupport() {
    this.software = false;
    this.builtIn = null;
    if (typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined') return { supported: false, software: false, reason: 'WebCodecs is not available in this browser' };
    let reason = '';
    const b = builtInFor(this.video.codec);
    if (this.forceBuiltIn && b) reason = 'the built-in decoder was asked for';
    else {
      try {
        const r = await VideoDecoder.isConfigSupported(this.decoderConfig());
        if (r.supported) return { supported: true, software: false, reason: '' };
        reason = `this browser cannot decode ${this.video.codec}`;
      } catch (e) {
        reason = String(e);
      }
    }
    if (b) {
      try {
        const desc = this.dx.track_description(this.video.index);
        const info = JSON.parse(b.id === 'h264' ? this.wasm.h264_probe(desc) : (await loadDecoders()).probe(b.id, desc));
        this.software = true;
        this.builtIn = b;
        this.softwareInfo = info;
        return { supported: true, software: true, reason: '' };
      } catch (e) {
        reason += `, and the built-in ${b.name} decoder cannot read it: ${e && e.message ? e.message : e}`;
      }
    }
    return { supported: false, software: false, reason };
  }
}

/**
 * Decode every frame with presentation time in [startSec, endSec) and hand
 * each VideoFrame to `onFrame(frame, tSec)` (which must close it). Frames
 * arrive in presentation order. With `raw`, the built-in decoder's pictures
 * come as plain I420 buffers (see rawPicture) instead of VideoFrames; with
 * `fast` it skips the deblocking filter (statistics only). Decoding starts
 * at the last keyframe at or before `startSec`, or at sample `fromIndex`
 * (decode order) when given. With `inline`, the built-in decoder decodes on
 * the page rather than in its workers.
 */
export async function decodeRange(movie, startSec, endSec, onFrame, { cancel, onProgress, raw = false, fast = false, fromIndex = null, reader = null, shrink = null, inline = false } = {}) {
  if (movie.software) return decodeRangeSoftware(movie, startSec, endSec, onFrame, { cancel, onProgress, raw, fast, fromIndex, reader, shrink, inline });
  // pictures for the detector alone: decoded and copied in a worker where
  // the detector would copy them on the page anyway (and, with `shrink`
  // ({aw, ah}), made that small there)
  if (raw && movie.decodeInWorkers && typeof Worker !== 'undefined') return decodeRangeWorker(movie, startSec, endSec, onFrame, { cancel, onProgress, fromIndex, shrink });
  const cfg = movie.decoderConfig();
  reader = reader || movie.reader || new ChunkReader(movie.file);
  const { pts, dts, offset, size, sync, dur } = movie.v;
  const n = pts.length;
  const startIdx = fromIndex !== null ? fromIndex : movie.dx.sync_before(movie.video.index, Math.max(startSec, movie.tsMin));
  const endUs = endSec * 1e6;
  let error = null;
  const queue = [];
  // the loop sleeps until the decoder does something: a picture out, an
  // input taken off its queue, an error (a timer polling instead would
  // cost the 4 ms browsers clamp repeated timeouts to, many times a second)
  let wake = null;
  const kick = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  const settle = () =>
    new Promise((r) => {
      wake = r;
      // only for a browser that sends no dequeue events
      setTimeout(kick, 20);
    });
  const decoder = new VideoDecoder({
    output: (f) => {
      queue.push(f);
      kick();
    },
    error: (e) => {
      error = e;
      kick();
    },
  });
  if ('ondequeue' in decoder) decoder.addEventListener('dequeue', kick);
  decoder.configure(cfg);
  let frames = 0;
  const pump = async () => {
    while (queue.length) {
      const f = queue.shift();
      const t = f.timestamp / 1e6;
      if (t < startSec - 1e-6 || t >= endSec - 1e-9) {
        f.close();
        continue;
      }
      await onFrame(f, t);
      frames++;
    }
  };
  let i = startIdx;
  try {
    while (i < n && !error && !(cancel && cancel())) {
      if (dts[i] >= endUs && pts[i] >= endUs) break;
      const full = () => decoder.decodeQueueSize > 12 || queue.length > 6;
      while (full() && !error) {
        await pump();
        if (!full() || error) break;
        const tw = performance.now();
        await settle();
        profile.add('decode.wait', performance.now() - tw);
      }
      if (error) break;
      const tr = performance.now();
      const data = await reader.read(offset[i], size[i]);
      profile.add('read', performance.now() - tr);
      decoder.decode(new EncodedVideoChunk({ type: sync[i] ? 'key' : 'delta', timestamp: pts[i], duration: dur[i], data }));
      i++;
      if (onProgress && i % 30 === 0) onProgress((i - startIdx) / Math.max(1, n - startIdx));
      await pump();
    }
    if (!error && !(cancel && cancel())) {
      // the last pictures, handed on as they come rather than all at the end
      const tf = performance.now();
      let flushed = false;
      decoder.flush().then(
        () => {
          flushed = true;
          kick();
        },
        (e) => {
          error = error || e;
          flushed = true;
          kick();
        }
      );
      while (!flushed) {
        await pump();
        if (!flushed && !queue.length) await settle();
      }
      profile.add('decode.flush', performance.now() - tf);
    }
    await pump();
  } finally {
    while (queue.length) queue.shift().close();
    try {
      decoder.close();
    } catch (e) {
      /* already closed */
    }
  }
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return frames;
}

/**
 * The samples (decode order) a decode of the pictures shown in [startSec,
 * endSec) runs over: from sample `fromIndex`, or else the last sync sample
 * at or before `startSec`, up to the first sample both decoded and shown at
 * or after `endSec` (so the leading pictures of the next GOP, shown before
 * `endSec` but decoded after its sync sample, are included).
 */
export function sampleRange(movie, startSec, endSec, fromIndex = null) {
  const { pts, dts } = movie.v;
  const n = pts.length;
  const startIdx = fromIndex !== null && fromIndex !== undefined ? fromIndex : movie.dx.sync_before(movie.video.index, Math.max(startSec, movie.tsMin));
  const endUs = endSec * 1e6;
  let endIdx = startIdx;
  while (endIdx < n && !(dts[endIdx] >= endUs && pts[endIdx] >= endUs)) endIdx++;
  return { startIdx, endIdx };
}

let workerJobs = 0;

/**
 * decodeRange through a decode worker (decodeworker.js): the worker
 * decodes and copies, the page feeds the copies on and hands each buffer
 * back. At most four pictures wait for the page at a time.
 */
async function decodeRangeWorker(movie, startSec, endSec, onFrame, { cancel, onProgress, fromIndex = null, shrink = null } = {}) {
  const { pts, offset, size, sync, dur } = movie.v;
  const { startIdx, endIdx } = sampleRange(movie, startSec, endSec, fromIndex);
  const endUs = endSec * 1e6;
  const slot = movie.decodeWorker();
  const worker = slot.worker;
  const id = ++workerJobs;
  const small = shrink && shrink.aw > 0 && shrink.ah > 0 ? { aw: shrink.aw, ah: shrink.ah } : null;
  const inbox = [];
  let done = false;
  let failed = null;
  let wake = null;
  const kick = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  const settle = () =>
    new Promise((r) => {
      wake = r;
      setTimeout(kick, 250);
    });
  const onMessage = (e) => {
    const m = e.data;
    if (m.id !== id) return;
    if (m.type === 'frame') inbox.push(m);
    else if (m.type === 'done') done = true;
    else if (m.type === 'error') failed = new Error(m.message);
    kick();
  };
  const onError = (e) => {
    failed = new Error(`the decode worker stopped: ${e.message || e}`);
    kick();
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  worker.postMessage({
    type: 'decode',
    id,
    file: movie.file,
    config: movie.decoderConfig(),
    offset: offset.slice(startIdx, endIdx),
    size: size.slice(startIdx, endIdx),
    pts: pts.slice(startIdx, endIdx),
    dur: dur.slice(startIdx, endIdx),
    sync: sync.slice(startIdx, endIdx),
    startUs: startSec * 1e6,
    endUs,
    // pictures made small cost little to hold: the decoder runs further
    // ahead of the detector
    window: small ? 32 : 4,
    shrink: small,
  });
  const credit = (buffer) => (buffer ? worker.postMessage({ type: 'credit', n: 1, buffer }, [buffer]) : worker.postMessage({ type: 'credit', n: 1 }));
  let frames = 0;
  let stopped = false;
  let healthy = true;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      worker.postMessage({ type: 'cancel' });
    }
  };
  try {
    for (;;) {
      if (cancel && cancel()) stop();
      if (inbox.length) {
        const m = inbox.shift();
        if (stopped) {
          if (m.frame) m.frame.close();
          credit(m.pic ? m.pic.data : null);
          continue;
        }
        const t = (m.frame ? m.frame.timestamp : m.pic.timestamp) / 1e6;
        if (m.frame) {
          try {
            await onFrame(m.frame, t);
          } finally {
            credit(null);
          }
        } else {
          await onFrame(workerPicture(m.pic, credit), t);
        }
        frames++;
        if (onProgress && frames % 30 === 0) onProgress(frames / Math.max(1, endIdx - startIdx));
        continue;
      }
      if (failed) throw failed;
      if (done) break;
      // the page waiting for the worker (decoding is what holds it up)
      const t0 = performance.now();
      await settle();
      profile.add('worker.wait', performance.now() - t0);
    }
  } catch (e) {
    stop();
    // the worker's job is waited out before it takes another
    const until = performance.now() + 5000;
    while (!done && !failed && performance.now() < until) {
      while (inbox.length) {
        const m = inbox.shift();
        if (m.frame) m.frame.close();
        credit(m.pic ? m.pic.data : null);
      }
      await settle();
    }
    healthy = done || !!failed;
    throw e;
  } finally {
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    if (healthy && !failed) slot.busy = false;
    else {
      worker.terminate();
      movie.decodeWorkers = (movie.decodeWorkers || []).filter((w) => w !== slot);
    }
  }
  return frames;
}

/** A picture a decode worker copied, shaped for Feeder.feedRaw; closing it hands the buffer back. */
function workerPicture(p, credit) {
  let returned = false;
  if (p.shrunk) {
    profile.add('worker.copy', p.shrunk.copyMs);
    profile.add('worker.shrink', p.shrunk.shrinkMs);
  }
  return {
    raw: true,
    kind: p.kind,
    format: p.format,
    codedWidth: p.width,
    codedHeight: p.height,
    displayWidth: p.width,
    displayHeight: p.height,
    timestamp: p.timestamp,
    colorSpace: p.colorSpace,
    data: new Uint8Array(p.data, 0, p.bytes),
    layout: p.layout,
    detail: p.shrunk ? `${p.format} ${p.shrunk.from[0]}×${p.shrunk.from[1]}, made ${p.width}×${p.height} in a decode worker` : `${p.format}, copied in a decode worker`,
    close() {
      if (returned) return;
      returned = true;
      credit(p.data);
    },
  };
}

/**
 * The layout words Detector.feed_yuv takes: [format (0 I420, 1 NV12), y_off,
 * y_stride, u_off, u_stride, v_off, v_stride, matrix (0 BT.601, 1 BT.709),
 * full_range], from WebCodecs plane layouts and a VideoColorSpace (the
 * matrix is guessed from the picture height when unknown, as players do).
 */
export function yuvLayoutWords(format, planes, colorSpace, height) {
  const nv12 = format === 'NV12';
  const cs = colorSpace || {};
  let bt709;
  if (cs.matrix === 'bt709' || cs.matrix === 'bt2020-ncl') bt709 = 1;
  else if (cs.matrix === 'smpte170m' || cs.matrix === 'bt470bg' || cs.matrix === 'fcc') bt709 = 0;
  else bt709 = height > 576 ? 1 : 0;
  const u = planes[1];
  const v = nv12 ? planes[1] : planes[2];
  return Uint32Array.from([nv12 ? 1 : 0, planes[0].offset, planes[0].stride, u.offset, u.stride, v.offset, v.stride, bt709, cs.fullRange ? 1 : 0]);
}

/**
 * A picture as packed I420 planes in memory (from the built-in decoder),
 * shaped enough like a VideoFrame for the detector's Feeder (`raw` marks
 * it); toVideoFrame() makes a real one for the encoder or a canvas.
 */
export function rawPicture(data, width, height, timestampUs, colorSpace) {
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  const planes = [
    { offset: 0, stride: width },
    { offset: width * height, stride: cw },
    { offset: width * height + cw * ch, stride: cw },
  ];
  return {
    raw: true,
    format: 'I420',
    codedWidth: width,
    codedHeight: height,
    displayWidth: width,
    displayHeight: height,
    timestamp: timestampUs,
    colorSpace,
    data,
    layout: yuvLayoutWords('I420', planes, colorSpace, height),
    close() {},
    toVideoFrame() {
      const init = { format: 'I420', codedWidth: width, codedHeight: height, timestamp: timestampUs };
      if (colorSpace) init.colorSpace = colorSpace;
      return new VideoFrame(data, init);
    },
  };
}

/** The picture the built-in decoder just produced, copied out of WebAssembly memory. */
export function softwarePicture(wasm, dec, timestampUs) {
  const w = dec.width();
  const h = dec.height();
  const data = new Uint8Array(wasm.wasm_memory().buffer, dec.frame_ptr(), dec.frame_len()).slice();
  let colorSpace = null;
  try {
    colorSpace = JSON.parse(dec.color_json());
  } catch (e) {
    /* default colour space */
  }
  return rawPicture(data, w, h, timestampUs, colorSpace);
}

/**
 * Decode stretch after stretch with the built-in decoder through `pool` (a
 * SoftwarePool of its own), whatever decoder the movie normally uses: a
 * hybrid scan's built-in lane. `next()` hands out { startSec, endSec,
 * fromIndex } (as decodeRange takes them) or null; the pictures reach
 * `onFrame` in order, made the detector's size (`shrink`) in the workers,
 * fully decoded (the deblocking filter too, so they are the pictures the
 * browser's decoder gives). A damaged picture fails the pass.
 */
export function decodeStretchesBuiltIn(movie, pool, next, onFrame, { cancel, shrink = null } = {}) {
  const stretch = () => {
    const s = next();
    return s ? { ...sampleRange(movie, s.startSec, s.endSec, s.fromIndex), startSec: s.startSec, endSec: s.endSec } : null;
  };
  return pool.decodeStretches(stretch, onFrame, { cancel, raw: true, fast: false, shrink, strict: true });
}

/**
 * decodeRange on the page through one of the decoders module's built-in
 * decoders (HEVC, VP9, VP8, AV1), for when its workers cannot run. Each
 * picture is tagged with the index of the sample it came from, and handed
 * on in presentation order (a decoder that gives them in decode order says
 * how far out of order they can be).
 */
async function decodeRangeBuiltInInline(movie, startSec, endSec, onFrame, { cancel, onProgress, raw = false, fast = false, fromIndex = null, reader = null } = {}) {
  const mod = await loadDecoders();
  reader = reader || movie.reader || new ChunkReader(movie.file);
  const { pts, offset, size } = movie.v;
  const { startIdx, endIdx } = sampleRange(movie, startSec, endSec, fromIndex);
  const d = new mod.SoftDecoder(movie.builtIn.id, movie.dx.track_description(movie.video.index), fast);
  const reorder = d.reorder_depth();
  const held = [];
  let frames = 0;
  let damaged = 0;
  const collect = (n) => {
    for (let k = 0; k < n && d.next(); k++) {
      if (d.frame_damaged()) damaged++;
      const data = new Uint8Array(mod.wasm_memory().buffer, d.frame_ptr(), d.frame_len()).slice();
      let colorSpace = null;
      try {
        colorSpace = JSON.parse(d.color_json());
      } catch (e) {
        /* default colour space */
      }
      held.push(rawPicture(data, d.width(), d.height(), pts[d.frame_pts()], colorSpace));
    }
    held.sort((a, b) => a.timestamp - b.timestamp);
  };
  const release = async (keep) => {
    while (held.length > keep) {
      const pic = held.shift();
      const t = pic.timestamp / 1e6;
      if (t < startSec - 1e-6 || t >= endSec - 1e-9) continue;
      await onFrame(raw ? pic : pic.toVideoFrame(), t);
      frames++;
    }
  };
  try {
    for (let i = startIdx; i < endIdx && !(cancel && cancel()); i++) {
      const data = await reader.read(offset[i], size[i]);
      const td = performance.now();
      let n = 0;
      try {
        n = d.decode(data, i);
      } catch (e) {
        console.warn(`built-in ${movie.builtIn.name} decoder:`, e);
        damaged++;
      }
      profile.add('sw.decode', performance.now() - td);
      collect(n);
      await release(reorder);
      if (onProgress && (i - startIdx) % 30 === 0) onProgress((i - startIdx) / Math.max(1, endIdx - startIdx));
      if (i % 4 === 0) await yieldTask();
    }
    if (!(cancel && cancel())) {
      collect(d.flush());
      await release(0);
    }
  } finally {
    d.free();
  }
  if (damaged) console.warn(`built-in ${movie.builtIn.name} decoder: ${damaged} damaged pictures`);
  return frames;
}

/**
 * The same as decodeRange, through the built-in H.264 decoder in WASM.
 * Samples are decoded in file (decode) order and the pictures handed out in
 * presentation order once every earlier picture has been decoded.
 */
async function decodeRangeSoftware(movie, startSec, endSec, onFrame, { cancel, onProgress, raw = false, fast = false, fromIndex = null, reader = null, shrink = null, inline = false } = {}) {
  reader = reader || movie.reader || new ChunkReader(movie.file);
  const { pts, dts, offset, size } = movie.v;
  const n = pts.length;
  const startIdx = fromIndex !== null ? fromIndex : movie.dx.sync_before(movie.video.index, Math.max(startSec, movie.tsMin));
  const endUs = endSec * 1e6;
  // `inline`: on the page even with workers to hand (a simulated hybrid scan's lanes)
  const pool = inline ? null : await movie.softwarePool();
  if (pool && !pool.busy) {
    const { endIdx } = sampleRange(movie, startSec, endSec, startIdx);
    // pictures for the detector are made small in the workers
    return pool.decodeRange(startIdx, endIdx, startSec, endSec, onFrame, { cancel, onProgress, raw, fast, shrink: raw ? shrink : null });
  }
  if (movie.builtIn && movie.builtIn.id !== 'h264') return decodeRangeBuiltInInline(movie, startSec, endSec, onFrame, { cancel, onProgress, raw, fast, fromIndex: startIdx, reader });
  const dec = new movie.wasm.H264Decoder(movie.dx.track_description(movie.video.index), fast);
  // presentation order of the samples this pass will decode
  const ptsSorted = [];
  for (let i = startIdx; i < n; i++) {
    if (dts[i] >= endUs && pts[i] >= endUs) break;
    ptsSorted.push(pts[i]);
  }
  ptsSorted.sort((a, b) => a - b);
  const ready = new Map(); // pts -> picture (rawPicture)
  let next = 0;
  let frames = 0;
  let damaged = 0;
  const release = async () => {
    while (next < ptsSorted.length && ready.has(ptsSorted[next])) {
      const pic = ready.get(ptsSorted[next]);
      ready.delete(ptsSorted[next]);
      next++;
      const t = pic.timestamp / 1e6;
      if (t < startSec - 1e-6 || t >= endSec - 1e-9) continue;
      await onFrame(raw ? pic : pic.toVideoFrame(), t);
      frames++;
    }
  };
  let i = startIdx;
  try {
    while (i < n && !(cancel && cancel())) {
      if (dts[i] >= endUs && pts[i] >= endUs) break;
      const data = await reader.read(offset[i], size[i]);
      let got = false;
      const td = performance.now();
      try {
        got = dec.decode(data, pts[i] / 1e6);
      } catch (e) {
        console.warn('built-in H.264 decoder:', e);
        damaged++;
      }
      profile.add('sw.decode', performance.now() - td);
      if (got) {
        if (dec.frame_damaged()) damaged++;
        ready.set(pts[i], softwarePicture(movie.wasm, dec, pts[i]));
      } else {
        // no picture for this sample: do not wait for it
        const k = ptsSorted.indexOf(pts[i]);
        if (k >= 0) ptsSorted.splice(k, 1);
      }
      i++;
      await release();
      if (onProgress && i % 30 === 0) onProgress((i - startIdx) / Math.max(1, n - startIdx));
      if (i % 4 === 0) await yieldTask();
    }
    await release();
  } finally {
    dec.free();
  }
  if (damaged) console.warn(`built-in H.264 decoder: ${damaged} damaged pictures`);
  return frames;
}
