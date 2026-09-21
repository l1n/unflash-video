import { profile } from './profile.js';
// Demuxing (through the WASM MP4 parser, served byte ranges from the File)
// and decoding through WebCodecs.

export const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Reads sample bytes out of a File. A file up to `wholeLimit` bytes is read
 * whole the first time and kept, so every later pass over it (prepare,
 * export, verify) costs no file access at all; a larger one is read through
 * a window that follows the reads. A Movie keeps one reader for all its
 * passes: some browsers charge a good fraction of a second for the first
 * read of a file, and that is paid once rather than per pass.
 */
export class ChunkReader {
  constructor(file, chunkSize = 8 * 1024 * 1024, wholeLimit = 64 * 1024 * 1024) {
    this.file = file;
    this.chunk = chunkSize;
    this.wholeLimit = wholeLimit;
    this.buf = null;
    this.start = 0;
    this.end = 0;
  }
  async read(offset, size) {
    if (!(this.buf && offset >= this.start && offset + size <= this.end)) {
      const whole = this.file.size <= this.wholeLimit;
      const start = whole ? 0 : offset;
      const end = whole ? this.file.size : Math.min(this.file.size, Math.max(offset + size, offset + this.chunk));
      this.buf = new Uint8Array(await this.file.slice(start, end).arrayBuffer());
      this.start = start;
      this.end = end;
    }
    return this.buf.subarray(offset - this.start, offset - this.start + size);
  }
  /** Forget the bytes read so far. */
  release() {
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

/** An opened MP4: track info and sample tables. */
export class Movie {
  static async open(file, wasm) {
    const dx = new wasm.Demuxer(file.size);
    while (!dx.is_done()) {
      const need = dx.need();
      if (!need.length) break;
      const [off, len] = need;
      const buf = new Uint8Array(await file.slice(off, off + len).arrayBuffer());
      dx.feed(off, buf);
    }
    const info = JSON.parse(dx.movie_json());
    const vt = info.tracks.find((t) => t.kind === 'video' && t.samples > 0);
    if (!vt) throw new Error('No video track found in this file');
    const at = info.tracks.find((t) => t.kind === 'audio' && t.samples > 0) || null;
    const m = new Movie();
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
    const med = median(deltas.filter((d) => d > 0)) || 1e6 / 30;
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
    this.poolPromise = null;
    if (this.reader) this.reader.release();
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
          console.warn('built-in H.264 decoder: decoding on the page instead of in workers:', e && e.message ? e.message : e);
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
   * Whether the file can be decoded: by WebCodecs, or, for H.264 in a
   * browser without an H.264 decoder, by the built-in software decoder
   * (`software: true`). VideoFrame itself has to exist either way.
   */
  async decoderSupport() {
    this.software = false;
    if (typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined') return { supported: false, software: false, reason: 'WebCodecs is not available in this browser' };
    let reason = '';
    try {
      const r = await VideoDecoder.isConfigSupported(this.decoderConfig());
      if (r.supported) return { supported: true, software: false, reason: '' };
      reason = `this browser cannot decode ${this.video.codec}`;
    } catch (e) {
      reason = String(e);
    }
    if (/^avc[13]/.test(this.video.codec)) {
      try {
        const info = JSON.parse(this.wasm.h264_probe(this.dx.track_description(this.video.index)));
        this.software = true;
        this.softwareInfo = info;
        return { supported: true, software: true, reason: '' };
      } catch (e) {
        reason += `, and the built-in H.264 decoder cannot read it: ${e && e.message ? e.message : e}`;
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
 * `fast` it skips the deblocking filter (statistics only).
 */
export async function decodeRange(movie, startSec, endSec, onFrame, { cancel, onProgress, raw = false, fast = false } = {}) {
  if (movie.software) return decodeRangeSoftware(movie, startSec, endSec, onFrame, { cancel, onProgress, raw, fast });
  const cfg = movie.decoderConfig();
  const reader = movie.reader || new ChunkReader(movie.file);
  const { pts, dts, offset, size, sync, dur } = movie.v;
  const n = pts.length;
  const startIdx = movie.dx.sync_before(movie.video.index, Math.max(startSec, movie.tsMin));
  const endUs = endSec * 1e6;
  let error = null;
  const queue = [];
  const decoder = new VideoDecoder({
    output: (f) => queue.push(f),
    error: (e) => {
      error = e;
    },
  });
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
      while ((decoder.decodeQueueSize > 12 || queue.length > 6) && !error) {
        await pump();
        const tw = performance.now();
        await tick();
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
      try {
        await profile.timeAsync('decode.flush', () => decoder.flush());
      } catch (e) {
        error = error || e;
      }
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
 * The same as decodeRange, through the built-in H.264 decoder in WASM.
 * Samples are decoded in file (decode) order and the pictures handed out in
 * presentation order once every earlier picture has been decoded.
 */
async function decodeRangeSoftware(movie, startSec, endSec, onFrame, { cancel, onProgress, raw = false, fast = false } = {}) {
  const reader = movie.reader || new ChunkReader(movie.file);
  const { pts, dts, offset, size } = movie.v;
  const n = pts.length;
  const startIdx = movie.dx.sync_before(movie.video.index, Math.max(startSec, movie.tsMin));
  const endUs = endSec * 1e6;
  const pool = await movie.softwarePool();
  if (pool && !pool.busy) {
    let endIdx = startIdx;
    while (endIdx < n && !(dts[endIdx] >= endUs && pts[endIdx] >= endUs)) endIdx++;
    return pool.decodeRange(startIdx, endIdx, startSec, endSec, onFrame, { cancel, onProgress, raw, fast });
  }
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
      if (i % 4 === 0) await tick();
    }
    await release();
  } finally {
    dec.free();
  }
  if (damaged) console.warn(`built-in H.264 decoder: ${damaged} damaged pictures`);
  return frames;
}
