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

  async decoderSupport() {
    if (typeof VideoDecoder === 'undefined') return { supported: false, reason: 'WebCodecs is not available in this browser' };
    try {
      const r = await VideoDecoder.isConfigSupported(this.decoderConfig());
      return { supported: !!r.supported, reason: r.supported ? '' : `this browser cannot decode ${this.video.codec}` };
    } catch (e) {
      return { supported: false, reason: String(e) };
    }
  }
}

/**
 * Decode every frame with presentation time in [startSec, endSec) and hand
 * each VideoFrame to `onFrame(frame, tSec)` (which must close it). Frames
 * arrive in presentation order.
 */
export async function decodeRange(movie, startSec, endSec, onFrame, { cancel, onProgress } = {}) {
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
