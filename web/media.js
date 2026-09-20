// Demuxing (through the WASM MP4 parser, served byte ranges from the File)
// and decoding through WebCodecs.

export const tick = () => new Promise((r) => setTimeout(r, 0));

/** Reads sample bytes out of a File with a read-ahead window. */
export class ChunkReader {
  constructor(file, chunkSize = 8 * 1024 * 1024) {
    this.file = file;
    this.chunk = chunkSize;
    this.buf = null;
    this.start = 0;
    this.end = 0;
  }
  async read(offset, size) {
    if (!(this.buf && offset >= this.start && offset + size <= this.end)) {
      const start = offset;
      const end = Math.min(this.file.size, Math.max(offset + size, offset + this.chunk));
      this.buf = new Uint8Array(await this.file.slice(start, end).arrayBuffer());
      this.start = start;
      this.end = end;
    }
    return this.buf.subarray(offset - this.start, offset - this.start + size);
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
 * arrive in presentation order.
 */
export async function decodeRange(movie, startSec, endSec, onFrame, { cancel, onProgress } = {}) {
  if (movie.software) return decodeRangeSoftware(movie, startSec, endSec, onFrame, { cancel, onProgress });
  const cfg = movie.decoderConfig();
  const reader = new ChunkReader(movie.file);
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
        await tick();
      }
      if (error) break;
      const data = await reader.read(offset[i], size[i]);
      decoder.decode(new EncodedVideoChunk({ type: sync[i] ? 'key' : 'delta', timestamp: pts[i], duration: dur[i], data }));
      i++;
      if (onProgress && i % 30 === 0) onProgress((i - startIdx) / Math.max(1, n - startIdx));
      await pump();
    }
    if (!error && !(cancel && cancel())) {
      try {
        await decoder.flush();
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
 * The same as decodeRange, through the built-in H.264 decoder in WASM.
 * Samples are decoded in file (decode) order and the pictures handed out in
 * presentation order once every earlier picture has been decoded.
 */
async function decodeRangeSoftware(movie, startSec, endSec, onFrame, { cancel, onProgress } = {}) {
  const reader = new ChunkReader(movie.file);
  const { pts, dts, offset, size } = movie.v;
  const n = pts.length;
  const startIdx = movie.dx.sync_before(movie.video.index, Math.max(startSec, movie.tsMin));
  const endUs = endSec * 1e6;
  const dec = new movie.wasm.H264Decoder(movie.dx.track_description(movie.video.index));
  // presentation order of the samples this pass will decode
  const ptsSorted = [];
  for (let i = startIdx; i < n; i++) {
    if (dts[i] >= endUs && pts[i] >= endUs) break;
    ptsSorted.push(pts[i]);
  }
  ptsSorted.sort((a, b) => a - b);
  const ready = new Map(); // pts -> VideoFrame
  let next = 0;
  let frames = 0;
  let damaged = 0;
  const release = async () => {
    while (next < ptsSorted.length && ready.has(ptsSorted[next])) {
      const f = ready.get(ptsSorted[next]);
      ready.delete(ptsSorted[next]);
      next++;
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
    while (i < n && !(cancel && cancel())) {
      if (dts[i] >= endUs && pts[i] >= endUs) break;
      const data = await reader.read(offset[i], size[i]);
      let got = false;
      try {
        got = dec.decode(data, pts[i] / 1e6);
      } catch (e) {
        console.warn('built-in H.264 decoder:', e);
        damaged++;
      }
      if (got) {
        if (dec.frame_damaged()) damaged++;
        const w = dec.width();
        const h = dec.height();
        const rgba = dec.frame_rgba();
        ready.set(pts[i], new VideoFrame(rgba, { format: 'RGBA', codedWidth: w, codedHeight: h, timestamp: pts[i] }));
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
    for (const f of ready.values()) f.close();
    dec.free();
  }
  if (damaged) console.warn(`built-in H.264 decoder: ${damaged} damaged pictures`);
  return frames;
}
