// Export: decode the source, lay the edited sections onto the timeline,
// re-encode with WebCodecs and mux with the WASM muxer. Audio is copied
// from the source without re-encoding.

import { decodeRange, ChunkReader, tick } from './media.js';
import { profile } from './profile.js';
import { shownPts, softenPlan } from './analysis.js';

function avcLevel(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const rate = mbs * fps;
  if (mbs <= 8192 && rate <= 245760) return '28'; // 4.0
  if (mbs <= 8192 && rate <= 522240) return '2A'; // 4.2
  if (mbs <= 22080 && rate <= 589824) return '32'; // 5.0
  if (mbs <= 36864 && rate <= 983040) return '33'; // 5.1
  return '34'; // 5.2
}

/** Encoder configurations to try, best first. */
export async function encoderCandidates(width, height, fps, quality) {
  const bpp = 0.03 + (quality / 10) * 0.25;
  const bitrate = Math.round(width * height * fps * bpp);
  const base = { width, height, framerate: fps, bitrate, latencyMode: 'quality' };
  const list = [
    { label: 'H.264 (AVC)', config: { ...base, codec: `avc1.6400${avcLevel(width, height, fps)}`, avc: { format: 'avc' } } },
    { label: 'VP9', config: { ...base, codec: 'vp09.00.10.08' } },
    { label: 'AV1', config: { ...base, codec: 'av01.0.08M.08' } },
    { label: 'H.265 (HEVC)', config: { ...base, codec: 'hvc1.1.6.L120.B0', hevc: { format: 'hevc' } } },
  ];
  const out = [];
  if (typeof VideoEncoder === 'undefined') return out;
  for (const c of list) {
    try {
      const r = await VideoEncoder.isConfigSupported(c.config);
      if (r.supported) out.push({ ...c, config: r.config || c.config });
    } catch (e) {
      /* unsupported */
    }
  }
  return out;
}

class MemorySink {
  constructor() {
    this.parts = [];
    this.size = 0;
  }
  async write(bytes) {
    this.parts.push(bytes);
    this.size += bytes.byteLength;
  }
  async patch(offset, bytes) {
    // the head is always the first part
    this.parts[0].set(bytes, offset);
  }
  async close() {
    return new Blob(this.parts, { type: 'video/mp4' });
  }
}

class FileSink {
  constructor(writable) {
    this.w = writable;
    this.size = 0;
  }
  async write(bytes) {
    await this.w.write(bytes);
    this.size += bytes.byteLength;
  }
  async patch(offset, bytes) {
    await this.w.write({ type: 'write', position: offset, data: bytes });
  }
  async close() {
    await this.w.close();
    return null;
  }
}

/**
 * Export the project. Returns { blob (null when streamed to a file), warnings,
 * frames, elapsedMs }.
 */
export async function exportMovie(env, movie, project, { encoder, quality, extS = 1.0, sink = null, onProgress, cancel } = {}) {
  const { wasm } = env;
  const warnings = [];
  const fps = movie.fps;
  const cands = await encoderCandidates(movie.width, movie.height, fps, quality);
  const chosen = encoder ? cands.find((c) => c.label === encoder) || cands[0] : cands[0];
  if (!chosen) throw new Error('This browser has no video encoder WebCodecs can use.');

  // --- the plan: every prepared section with marks ---------------------------
  const sections = project
    .sectionsSorted()
    .filter((s) => s.prepared && s.pts && s.pts.length)
    .map((s) => {
      const tl = JSON.parse(wasm.section_timeline(Float64Array.from(s.pts), s.start, s.end));
      const shown = shownPts(wasm, s);
      const seq = JSON.parse(wasm.edited_sequence(Float64Array.from(shown), JSON.stringify(s.edits || {}), extS));
      const hasEdits = Object.values(s.edits || {}).some((e) => e.removed || e.extended);
      const needCount = new Map();
      for (const src of seq.src) needCount.set(src, (needCount.get(src) || 0) + 1);
      const extra = seq.t.length ? seq.t[seq.t.length - 1] - shown[shown.length - 1] : 0;
      // "soften stripes": blur the patterned frames at source resolution with
      // the σ the section's check used, scaled up from analysis pixels
      let soft = null;
      if (s.soften && s.cache) {
        const plan = softenPlan(s);
        if (plan) soft = { frames: plan.frames, sigma: plan.sigma * (movie.width / s.cache.width()) };
      }
      return { sec: s, base: tl.base, seq, nOut: tl.n_out, hasEdits, needCount, extra, soft };
    });
  const unprepared = project.sections.filter((s) => !s.prepared && Object.values(s.edits || {}).some((e) => e.removed || e.extended));
  if (unprepared.length) warnings.push(`Sections ${unprepared.map((s) => '#' + s.id).join(', ')} have marks but are not prepared; their marks were not applied. Prepare them and export again.`);
  if (sections.some((p) => p.extra > 0) && movie.audio) warnings.push('Some frames are held for a second (E marks). The audio is copied unchanged, so it runs ahead of the picture after each hold.');

  // --- encoder ---------------------------------------------------------------
  let encError = null;
  let description = null;
  let codecString = chosen.config.codec;
  const chunks = []; // { pts, dur, size, sync }
  const out = sink || new MemorySink();
  const writeQueue = [];
  let writing = Promise.resolve();
  const enqueueWrite = (bytes) => {
    writing = writing.then(() => out.write(bytes));
    return writing;
  };
  const encoder_ = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig) {
        if (meta.decoderConfig.description && !description) description = new Uint8Array(meta.decoderConfig.description.slice ? meta.decoderConfig.description.slice(0) : meta.decoderConfig.description);
        if (meta.decoderConfig.codec) codecString = meta.decoderConfig.codec;
      }
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      chunks.push({ pts: chunk.timestamp, dur: chunk.duration || 0, size: buf.byteLength, sync: chunk.type === 'key' });
      enqueueWrite(buf);
    },
    error: (e) => {
      encError = e;
    },
  });
  encoder_.configure(chosen.config);

  const mx = new wasm.Muxer();
  await out.write(mx.start());

  let outFrames = 0;
  let softened = 0;
  let lastKey = -Infinity;
  let pending = null; // { frame, tUs } waiting for its duration
  const medianUs = Math.round(movie.medianDelta * 1e6);
  const emit = async (frame, tSec) => {
    const tUs = Math.round(tSec * 1e6);
    if (pending) {
      const dur = Math.max(1, tUs - pending.tUs);
      await encodeOne(pending.frame, pending.tUs, dur);
      pending = null;
    }
    pending = { frame: new VideoFrame(frame, { timestamp: tUs }), tUs };
  };
  const encodeOne = async (frame, tUs, durUs) => {
    while (encoder_.encodeQueueSize > 8 && !encError) await tick();
    if (encError) throw encError;
    const f = new VideoFrame(frame, { timestamp: tUs, duration: durUs });
    frame.close();
    const key = tUs - lastKey >= 2e6 || outFrames === 0;
    if (key) lastKey = tUs;
    encoder_.encode(f, { keyFrame: key });
    f.close();
    outFrames++;
  };

  // --- walk the source in presentation order ---------------------------------
  let offset = 0; // cumulative extension seconds
  let si = 0; // next section to enter
  let cur = null; // active section state
  const total = movie.frameCount;
  let seen = 0;
  const started = performance.now();
  profile.reset();
  const enterSection = (p) => ({ p, ordinal: 0, next: 0, frames: new Map(), need: new Map(p.needCount) });
  const flushSection = async (st) => {
    const { p } = st;
    while (st.next < p.seq.t.length && st.frames.has(p.seq.src[st.next])) {
      const src = p.seq.src[st.next];
      const t = p.sec.start + p.base + p.seq.t[st.next] + offset;
      if (p.soft && p.soft.frames.has(src)) {
        const b = blurFrame(st.frames.get(src), p.soft.sigma);
        await emit(b, t);
        b.close();
        softened++;
      } else await emit(st.frames.get(src), t);
      const left = st.need.get(src) - 1;
      st.need.set(src, left);
      if (left <= 0) {
        st.frames.get(src).close();
        st.frames.delete(src);
      }
      st.next++;
    }
  };
  const endSection = async (st) => {
    await flushSection(st);
    for (const f of st.frames.values()) f.close();
    if (st.next < st.p.seq.t.length) warnings.push(`Section #${st.p.sec.id}: ${st.p.seq.t.length - st.next} slots could not be filled (the decode returned fewer frames than when it was prepared).`);
    offset += st.p.extra;
    cur = null;
  };

  await decodeRange(
    movie,
    movie.tsMin,
    movie.tsMax + 1,
    async (frame, t) => {
      seen++;
      if (onProgress && seen % 15 === 0) onProgress(seen / Math.max(1, total), outFrames, performance.now() - started);
      // leave a section whose frames are exhausted
      if (cur && (cur.ordinal >= cur.p.nOut || t >= cur.p.sec.end - 1e-9)) await endSection(cur);
      // enter a section?
      while (!cur && si < sections.length && t >= sections[si].sec.end - 1e-9) si++; // skipped entirely (empty)
      if (!cur && si < sections.length && t >= sections[si].sec.start - 1e-9 && t < sections[si].sec.end - 1e-9) {
        cur = enterSection(sections[si]);
        si++;
      }
      if (cur) {
        const j = cur.ordinal++;
        if (cur.need.has(j) && cur.need.get(j) > 0) cur.frames.set(j, frame);
        else frame.close();
        await flushSection(cur);
        return;
      }
      await emit(frame, t + offset);
      frame.close();
    },
    { cancel }
  );
  if (cur) await endSection(cur);
  if (pending) {
    await encodeOne(pending.frame, pending.tUs, medianUs);
    pending = null;
  }
  if (encError) throw encError;
  await encoder_.flush();
  encoder_.close();
  await writing;
  if (cancel && cancel()) throw new Error('cancelled');

  // --- video samples: decode order, dts from the sorted presentation times ----
  const sorted = chunks.map((c) => c.pts).sort((a, b) => a - b);
  let shift = 0;
  for (let i = 0; i < chunks.length; i++) shift = Math.max(shift, sorted[i] - chunks[i].pts);
  const vt = mx.add_video_track(codecString, movie.width, movie.height, 1000000, description || new Uint8Array());
  for (let i = 0; i < chunks.length; i++) {
    const dts = sorted[i] - shift;
    const dur = i + 1 < chunks.length ? sorted[i + 1] - sorted[i] : medianUs;
    mx.add_sample(vt, dts, chunks[i].pts, Math.max(1, dur), chunks[i].sync, chunks[i].size);
  }

  // --- audio: stream copy ----------------------------------------------------
  if (movie.audio && movie.a) {
    const at = mx.add_copy_track('audio', movie.dx.track_sample_entry(movie.audio.index), movie.audio.timescale, 0, 0);
    const reader = new ChunkReader(movie.file);
    const a = movie.a;
    for (let i = 0; i < a.offset.length; i++) {
      const bytes = await reader.read(a.offset[i], a.size[i]);
      await out.write(bytes.slice());
      mx.add_sample(at, a.dtsTicks[i], a.ptsTicks[i], a.durTicks[i], true, a.size[i]);
    }
  }

  const moov = mx.finish();
  await out.patch(mx.patch_offset(), mx.patch_bytes());
  await out.write(moov);
  const blob = await out.close();
  mx.free();
  profile.report(`export (${chosen.label})`, outFrames, performance.now() - started);
  return { blob, warnings, frames: outFrames, softened, elapsedMs: performance.now() - started, codec: codecString, encoderLabel: chosen.label };
}

let blurCanvas = null;
/**
 * A Gaussian-blurred copy of a frame (σ in source pixels). The sharp frame
 * is drawn first so the blur's transparent fringe at the picture edge shows
 * the original there rather than black.
 */
function blurFrame(frame, sigma) {
  const w = frame.displayWidth || frame.codedWidth;
  const h = frame.displayHeight || frame.codedHeight;
  if (!blurCanvas || blurCanvas.width !== w || blurCanvas.height !== h) blurCanvas = new OffscreenCanvas(w, h);
  const ctx = blurCanvas.getContext('2d');
  ctx.filter = 'none';
  ctx.drawImage(frame, 0, 0, w, h);
  ctx.filter = `blur(${Math.max(0.5, sigma).toFixed(2)}px)`;
  ctx.drawImage(frame, 0, 0, w, h);
  ctx.filter = 'none';
  return new VideoFrame(blurCanvas, { timestamp: frame.timestamp || 0 });
}

export async function pickSaveSink(suggestedName) {
  if (!window.showSaveFilePicker) return null;
  const t0 = performance.now();
  try {
    const handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
    const writable = await handle.createWritable();
    return { sink: new FileSink(writable), handle };
  } catch (e) {
    // a real cancel takes the user a moment; an instant AbortError means the
    // picker could not be shown at all, so fall back to an in-memory file
    if (e && e.name === 'AbortError' && performance.now() - t0 > 400) return { cancelled: true };
    return null;
  }
}
