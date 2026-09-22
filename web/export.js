// Export: the edited timeline back into an MP4. The frames no section
// touches are copied from the source as they are, whole GOPs at a time,
// without decoding or encoding ("smart cut"); the spans the sections touch
// are decoded, edited and re-encoded with WebCodecs, several at once, each
// from a keyframe the decoder can start at cold. When the encoder's codec
// cannot share a track with the source's (or smart cut is off), the whole
// video is re-encoded, still in parallel pieces. Audio is copied from the
// source without re-encoding. The WASM muxer writes the file.

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
  const level = avcLevel(width, height, fps);
  const list = [
    { label: 'H.264 (AVC)', config: { ...base, codec: `avc1.6400${level}`, avc: { format: 'avc' } } },
    { label: 'H.264 (AVC, Main)', config: { ...base, codec: `avc1.4D40${level}`, avc: { format: 'avc' } } },
    { label: 'H.264 (AVC, Baseline)', config: { ...base, codec: `avc1.42E0${level}`, avc: { format: 'avc' } } },
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
  async abort() {
    this.parts = [];
  }
}

/**
 * Rough size of an export: with a plan, the copied samples' bytes plus the
 * encoder's target bitrate over the re-encoded seconds; without one, the
 * bitrate over the whole duration. Plus the copied audio.
 */
export function estimateExportBytes(movie, quality, plan = null) {
  const bpp = 0.03 + (quality / 10) * 0.25;
  const perSecond = (movie.width * movie.height * movie.fps * bpp) / 8;
  let video = perSecond * movie.duration;
  if (plan && plan.mode === 'smart') video = plan.copiedBytes + perSecond * plan.encodedSeconds;
  let audio = 0;
  if (movie.a) for (let i = 0; i < movie.a.size.length; i++) audio += movie.a.size[i];
  return video + audio;
}

/** Whether this browser can write an export to its private storage on disk. */
export function privateStorageAvailable() {
  return !!(typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory && typeof FileSystemFileHandle !== 'undefined' && FileSystemFileHandle.prototype.createWritable);
}

const PRIVATE_PREFIX = 'unflash-export-';

/**
 * A sink in the browser's private storage (the origin-private file system):
 * on disk, without a dialog or a user gesture, so an export need not fit in
 * memory. Chrome and Firefox; Safari's private storage cannot be written from
 * the page, so it falls back. Earlier exports there are removed first. Null
 * when unavailable or when `bytesNeeded` would not fit the storage quota.
 */
export async function privateFileSink(bytesNeeded = 0) {
  try {
    if (!privateStorageAvailable()) return null;
    const root = await navigator.storage.getDirectory();
    await discardPrivateExport(root);
    if (navigator.storage.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota && bytesNeeded && quota - (usage || 0) < bytesNeeded * 1.2) return null;
    }
    const handle = await root.getFileHandle(`${PRIVATE_PREFIX}${Date.now()}.mp4`, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    return { sink: new FileSink(writable), handle, private: true };
  } catch (e) {
    return null;
  }
}

/** Remove every export written to private storage. */
export async function discardPrivateExport(root = null) {
  try {
    if (!privateStorageAvailable()) return;
    const dir = root || (await navigator.storage.getDirectory());
    const names = [];
    for await (const name of dir.keys()) if (name.startsWith(PRIVATE_PREFIX)) names.push(name);
    for (const name of names) await dir.removeEntry(name).catch(() => {});
  } catch (e) {
    /* nothing to remove, or no private storage */
  }
}

class FileSink {
  constructor(writable) {
    this.w = writable;
    this.size = 0;
  }
  // every write names its position: a patch moves the stream's cursor to
  // just past the patched bytes, and a plain write after it would land there
  // instead of at the end of the file
  async write(bytes) {
    await this.w.write({ type: 'write', position: this.size, data: bytes });
    this.size += bytes.byteLength;
  }
  async patch(offset, bytes) {
    await this.w.write({ type: 'write', position: offset, data: bytes });
  }
  async close() {
    await this.w.close();
    return null;
  }
  async abort() {
    try {
      await this.w.abort();
    } catch (e) {
      /* already closed */
    }
  }
}

// ---- the plan ------------------------------------------------------------------

/**
 * Every prepared section with something to apply, with its edited sequence.
 * Marks were made against a section's frame times, which outlive its frame
 * cache (dropped to save memory, or not rebuilt since the project was
 * restored): every section that was prepared once is applied.
 */
function sectionPlans(env, movie, project, extS, warnings) {
  const { wasm } = env;
  const sections = project
    .sectionsSorted()
    .filter((s) => s.pts && s.pts.length)
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
      if (s.soften) {
        const plan = softenPlan(s);
        if (plan) soft = { frames: plan.frames, sigma: plan.sigma * (movie.width / env.feeder.aw) };
      }
      return { sec: s, base: tl.base, seq, nOut: tl.n_out, hasEdits, needCount, extra, soft };
    });
  const unprepared = project.sections.filter((s) => !(s.pts && s.pts.length) && Object.values(s.edits || {}).some((e) => e.removed || e.extended));
  if (unprepared.length) warnings.push(`Sections ${unprepared.map((s) => '#' + s.id).join(', ')} have marks but were never prepared; their marks were not applied. Prepare them and export again.`);
  if (sections.some((p) => p.extra > 0) && movie.audio) warnings.push('Some frames are held for a second (E marks). The audio is copied unchanged, so it runs ahead of the picture after each hold.');
  return sections;
}

/**
 * Whether an encoder's output (`codec`) can share a track with the source's
 * samples: H.264 into an `avc1` source (the parameter sets are merged, see
 * AvcRegistry), VP9 into a VP9 source of the same profile (VP9 keeps its
 * headers in the frames). Returns { kind, lenSize } or null.
 */
function copyableCodec(movie, codec) {
  const src = movie.video;
  if (!src || !codec) return null;
  if (/^avc1/.test(codec) && src.fourcc === 'avc1' && /^avc1/.test(src.codec)) {
    const desc = movie.dx.track_description(src.index);
    if (desc.length) return { kind: 'avc', lenSize: movie.wasm.avcc_nal_length_size(desc) };
  }
  if (/^vp09/.test(codec) && src.fourcc === 'vp09' && /^vp09/.test(src.codec)) {
    if ((src.codec.split('.')[1] || '00') === (codec.split('.')[1] || '00')) return { kind: 'vp9', lenSize: 0 };
  }
  return null;
}

/** Seconds of frames a re-encoded piece has at least (each starts with a keyframe anyway). */
const MIN_PIECE_S = 2.0;
/** Re-encoded pieces per parallel worker to aim for, so the workers stay evenly busy. */
const PIECES_PER_WORKER = 3;

/**
 * Where a decoder can start cold: a sync sample that, for H.264, holds an
 * IDR picture (an open-GOP I picture is marked sync too, but the B pictures
 * after it lean on what came before). One small read per sample asked.
 */
class CutPoints {
  constructor(movie, avcLenSize) {
    this.movie = movie;
    this.lenSize = avcLenSize; // 0: not H.264, every sync sample will do
    this.cache = new Map();
    this.reader = movie.reader || new ChunkReader(movie.file);
  }
  async ok(i) {
    const v = this.movie.v;
    if (!v.sync[i]) return false;
    if (!this.lenSize) return true;
    if (this.cache.has(i)) return this.cache.get(i);
    let type = 0;
    let len = Math.min(v.size[i], 4096);
    while (type === 0) {
      const bytes = await this.reader.read(v.offset[i], len);
      type = this.movie.wasm.h264_first_vcl_nal_type(bytes, this.lenSize);
      if (len >= v.size[i]) break;
      len = v.size[i];
    }
    const idr = type === 5;
    this.cache.set(i, idr);
    return idr;
  }
}

/**
 * The plan of an export: pieces in file order, each either a copy of a run of
 * source samples (decode order `from`..`to`) or a span to decode, edit and
 * re-encode (`from` a keyframe, `startSec`..`endSec` in source time, with the
 * sections inside it). Smart cut needs the encoder's `codec` to be able to
 * share a track with the source's; otherwise everything is re-encoded, cut
 * into pieces at keyframes for the parallel workers. `spans` adds source
 * intervals to re-encode besides the sections' (tests).
 */
export async function exportPlan(env, movie, project, { extS = 1.0, codec = null, smartCut = true, parallel = 0, spans = null } = {}) {
  const warnings = [];
  const sections = sectionPlans(env, movie, project, extS, warnings);
  const v = movie.v;
  const n = v.pts.length;
  const K = parallel > 0 ? parallel : movie.software ? 1 : Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const copyable = smartCut ? copyableCodec(movie, codec) : null;
  const cuts = new CutPoints(movie, copyable && copyable.kind === 'avc' ? copyable.lenSize : /^avc1/.test(movie.video.codec) ? movie.wasm.avcc_nal_length_size(movie.dx.track_description(movie.video.index)) : 0);
  // sync samples in decode order (their times rise with their index)
  const syncs = [];
  for (let i = 0; i < n; i++) if (v.sync[i]) syncs.push(i);
  // the source intervals whose frames change
  const touched = sections.map((p) => [p.sec.start, p.sec.end]);
  if (spans) for (const [a, b] of spans) touched.push([a, b]);
  touched.sort((a, b) => a[0] - b[0]);
  const inTouched = (tSec) => touched.some(([a, b]) => tSec > a - 1e-9 && tSec < b - 1e-9);

  let mode = 'full';
  let ranges = []; // re-encoded spans [from, to) in decode order
  if (copyable && n > 0 && (await cuts.ok(0))) {
    mode = 'smart';
    for (const [t0, t1] of touched) {
      const us0 = t0 * 1e6 - 0.5;
      const us1 = t1 * 1e6 - 0.5;
      // the last cut point at or before the interval, the first at or after it
      let a = 0;
      for (let k = syncs.length - 1; k >= 0; k--) {
        if (v.pts[syncs[k]] <= us0 && (await cuts.ok(syncs[k]))) {
          a = syncs[k];
          break;
        }
      }
      let b = n;
      for (let k = 0; k < syncs.length; k++) {
        if (v.pts[syncs[k]] >= us1 && (await cuts.ok(syncs[k]))) {
          b = syncs[k];
          break;
        }
      }
      if (ranges.length && a <= ranges[ranges.length - 1][1]) ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], b);
      else ranges.push([a, b]);
    }
  } else if (n > 0) {
    ranges = [[0, n]];
  }
  // pieces: copies between the spans; long spans cut at keyframes outside
  // the sections so several workers can take them
  const framesOf = (from, to) => to - from;
  let encodedFrames = 0;
  for (const [a, b] of ranges) encodedFrames += framesOf(a, b);
  const fps = movie.fps || 30;
  const chunk = Math.max(Math.round(MIN_PIECE_S * fps), Math.ceil(encodedFrames / Math.max(1, K * PIECES_PER_WORKER)));
  const pieces = [];
  let pos = 0;
  const timeOf = (i) => (i < n ? v.pts[i] / 1e6 : movie.tsMax + 1);
  const pushEncode = (from, to) => {
    const startSec = timeOf(from);
    const endSec = timeOf(to);
    pieces.push({ kind: 'encode', from, to, startSec, endSec, frames: framesOf(from, to), sections: sections.filter((p) => p.sec.start >= startSec - 1e-9 && p.sec.end <= endSec + 1e-9) });
  };
  for (const [a, b] of ranges) {
    if (a > pos) pieces.push({ kind: 'copy', from: pos, to: a, frames: framesOf(pos, a) });
    let from = a;
    if (K > 1 && b - a > 2 * chunk) {
      let next = a + chunk;
      for (const s of syncs) {
        if (s <= from || s >= b) continue;
        if (s < next) continue;
        if (b - s < chunk / 2) break;
        if (inTouched(timeOf(s))) continue;
        if (!(await cuts.ok(s))) continue;
        pushEncode(from, s);
        from = s;
        next = s + chunk;
      }
    }
    pushEncode(from, b);
    pos = b;
  }
  if (pos < n) pieces.push({ kind: 'copy', from: pos, to: n, frames: framesOf(pos, n) });
  // a section's timing offsets (held frames) reach everything after it
  let offset = 0;
  const sorted = sections.slice().sort((x, y) => x.sec.start - y.sec.start);
  for (const piece of pieces) {
    const startSec = piece.kind === 'copy' ? timeOf(piece.from) : piece.startSec;
    while (sorted.length && sorted[0].sec.end <= startSec + 1e-9) offset += sorted.shift().extra;
    piece.offset = offset;
    if (piece.kind === 'encode') {
      for (const p of piece.sections) {
        const k = sorted.indexOf(p);
        if (k >= 0) {
          sorted.splice(k, 1);
          offset += p.extra;
        }
      }
    }
  }
  let copiedFrames = 0;
  let copiedBytes = 0;
  let encodedSeconds = 0;
  for (const piece of pieces) {
    if (piece.kind === 'copy') {
      copiedFrames += piece.frames;
      for (let i = piece.from; i < piece.to; i++) copiedBytes += v.size[i];
    } else encodedSeconds += Math.min(movie.tsMax, piece.endSec) - piece.startSec;
  }
  return { mode, copyable, pieces, sections, spans: pieces.filter((p) => p.kind === 'encode').length, encoded: encodedFrames, copied: copiedFrames, copiedBytes, encodedSeconds, parallel: K, warnings };
}

// ---- one re-encoded piece --------------------------------------------------------

/**
 * Decodes one piece of the source, lays its sections' edited sequences onto
 * the timeline and encodes the frames; the encoded chunks are kept until the
 * writer takes them (a piece is a few seconds, so a few megabytes).
 */
class PieceEncoder {
  constructor(ctx, piece) {
    this.ctx = ctx;
    this.piece = piece;
    this.chunks = []; // { pts, sync, bytes, desc, codec }
    this.frames = 0;
    this.softened = 0;
    this.warnings = [];
    this.error = null;
    this.description = null; // the encoder's current decoderConfig description
    this.codec = ctx.chosen.config.codec;
  }

  async run() {
    const { ctx, piece } = this;
    const { movie } = ctx;
    const enc = ctx.makeEncoder(ctx.chosen.config, {
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig) {
          if (meta.decoderConfig.description) this.description = new Uint8Array(meta.decoderConfig.description.slice ? meta.decoderConfig.description.slice(0) : meta.decoderConfig.description);
          if (meta.decoderConfig.codec) this.codec = meta.decoderConfig.codec;
        }
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        this.chunks.push({ pts: chunk.timestamp, sync: chunk.type === 'key', bytes: buf, desc: this.description, codec: this.codec });
      },
      error: (e) => {
        this.error = e;
      },
    });
    let lastKey = -Infinity;
    let pending = null; // { frame, tUs } waiting for its duration
    const encodeOne = async (frame, tUs, durUs) => {
      while (enc.encodeQueueSize > 8 && !this.error) await tick();
      if (this.error) throw this.error;
      const f = new VideoFrame(frame, { timestamp: tUs, duration: durUs });
      frame.close();
      const key = tUs - lastKey >= 2e6 || this.frames === 0;
      if (key) lastKey = tUs;
      enc.encode(f, { keyFrame: key });
      f.close();
      this.frames++;
      ctx.onFrame();
    };
    const emit = async (frame, tSec) => {
      const tUs = Math.round(tSec * 1e6);
      if (pending) {
        const dur = Math.max(1, tUs - pending.tUs);
        await encodeOne(pending.frame, pending.tUs, dur);
        pending = null;
      }
      pending = { frame: new VideoFrame(frame, { timestamp: tUs }), tUs };
    };
    // the piece's sections, in order, as the frames come by in presentation order
    let offset = piece.offset; // cumulative extension seconds
    const sections = piece.sections;
    let si = 0;
    let cur = null;
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
          this.softened++;
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
      if (st.next < st.p.seq.t.length) this.warnings.push(`Section #${st.p.sec.id}: ${st.p.seq.t.length - st.next} slots could not be filled (the decode returned fewer frames than when it was prepared).`);
      offset += st.p.extra;
      cur = null;
    };
    try {
      await decodeRange(
        movie,
        piece.startSec,
        piece.endSec,
        async (frame, t) => {
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
        { cancel: ctx.cancel, fromIndex: piece.from }
      );
      if (cur) await endSection(cur);
      if (pending) {
        await encodeOne(pending.frame, pending.tUs, ctx.medianUs);
        pending = null;
      }
      if (this.error) throw this.error;
      await enc.flush();
    } finally {
      if (pending) pending.frame.close();
      try {
        enc.close();
      } catch (e) {
        /* already closed */
      }
    }
    if (this.error) throw this.error;
    if (ctx.cancel && ctx.cancel()) throw new Error('cancelled');
    return this;
  }
}

/** A WebCodecs encoder, configured. Tests substitute their own. */
function defaultEncoder(config, callbacks) {
  const enc = new VideoEncoder(callbacks);
  enc.configure(config);
  return enc;
}

// ---- the export ----------------------------------------------------------------

/**
 * Export the project. Returns { blob (null when streamed to a file), warnings,
 * frames (re-encoded), copied, spans, mode, elapsedMs, ... }. `parallel`
 * sets how many pieces are re-encoded at once (0: by the machine);
 * `smartCut` off re-encodes everything; `plan` reuses a plan made for the
 * same encoder. Tests pass their own encoder (`candidate` with its config,
 * `makeEncoder` building it) and extra `spans` to re-encode.
 */
export async function exportMovie(env, movie, project, { encoder, quality, extS = 1.0, sink = null, onProgress, cancel, smartCut = true, parallel = 0, spans = null, makeEncoder = null, candidate = null, plan: given = null } = {}) {
  const { wasm } = env;
  const fps = movie.fps;
  const cands = candidate ? [candidate] : await encoderCandidates(movie.width, movie.height, fps, quality);
  const chosen = encoder ? cands.find((c) => c.label === encoder) || cands[0] : cands[0];
  if (!chosen) throw new Error('This browser has no video encoder WebCodecs can use.');
  const plan = given || (await exportPlan(env, movie, project, { extS, codec: chosen.config.codec, smartCut, parallel, spans }));
  const warnings = plan.warnings.slice();
  const total = plan.encoded + plan.copied;
  const started = performance.now();
  profile.reset();

  // --- the pieces: re-encoded ones run K at a time, in order -------------------
  let encodedFrames = 0;
  let copiedFrames = 0;
  let failed = null;
  const cancelled = () => !!failed || (cancel && cancel());
  const ctx = { movie, chosen, medianUs: Math.round(movie.medianDelta * 1e6), cancel: cancelled, makeEncoder: makeEncoder || defaultEncoder, onFrame: () => {} };
  const report = () => {
    if (onProgress) onProgress((encodedFrames + copiedFrames) / Math.max(1, total), encodedFrames, performance.now() - started, copiedFrames);
  };
  let tickCount = 0;
  ctx.onFrame = () => {
    encodedFrames++;
    if (++tickCount % 15 === 0) report();
  };
  const encodePieces = plan.pieces.filter((p) => p.kind === 'encode');
  const queue = encodePieces.slice();
  let running = 0;
  const K = Math.max(1, plan.parallel);
  const pump = () => {
    while (running < K && queue.length && !failed) {
      const piece = queue.shift();
      running++;
      const pe = new PieceEncoder(ctx, piece);
      piece.done = pe
        .run()
        .catch((e) => {
          failed = failed || e;
          throw e;
        })
        .finally(() => {
          running--;
          pump();
        });
      piece.done.catch(() => {});
    }
  };
  pump();

  // --- the writer: pieces in file order --------------------------------------
  const out = sink || new MemorySink();
  const mx = new wasm.Muxer();
  await out.write(mx.start());
  const samples = []; // { pts, sync, size } in file order
  const reader = movie.reader || new ChunkReader(movie.file);
  const v = movie.v;
  const MAX_RUN = 8 * 1024 * 1024;
  let registry = null; // AvcRegistry, when H.264 samples of several origins share the track
  const rewriters = new Map(); // description bytes -> AvcRewriter | null
  let description = null;
  let codecString = chosen.config.codec;
  let softened = 0;
  const rewriterFor = (desc) => {
    if (!desc || !/^avc1/.test(codecString)) return null;
    const key = Array.from(desc).join(',');
    if (rewriters.has(key)) return rewriters.get(key);
    if (!registry) registry = new wasm.AvcRegistry(plan.mode === 'smart' ? movie.dx.track_description(movie.video.index) : desc);
    const rw = registry.register(desc);
    const use = rw.is_identity() ? null : rw;
    if (!use) rw.free();
    rewriters.set(key, use);
    return use;
  };
  try {
    for (const piece of plan.pieces) {
      if (cancelled()) throw failed || new Error('cancelled');
      if (piece.kind === 'copy') {
        const offUs = Math.round(piece.offset * 1e6);
        let i = piece.from;
        while (i < piece.to) {
          // a run of samples that sit next to each other in the file
          const off = v.offset[i];
          let len = v.size[i];
          let j = i + 1;
          while (j < piece.to && v.offset[j] === off + len && len + v.size[j] <= MAX_RUN) len += v.size[j++];
          const bytes = await reader.read(off, len);
          await out.write(bytes.slice());
          for (let k = i; k < j; k++) samples.push({ pts: v.pts[k] + offUs, sync: !!v.sync[k], size: v.size[k] });
          copiedFrames += j - i;
          i = j;
          report();
          if (cancelled()) throw failed || new Error('cancelled');
        }
      } else {
        const pe = await piece.done;
        softened += pe.softened;
        warnings.push(...pe.warnings);
        if (pe.codec) codecString = pe.codec;
        for (const c of pe.chunks) {
          if (c.desc && !description) description = c.desc;
          const rw = rewriterFor(c.desc);
          const bytes = rw ? rw.rewrite_sample(c.bytes) : c.bytes;
          await out.write(bytes);
          samples.push({ pts: c.pts, sync: c.sync, size: bytes.byteLength });
        }
        pe.chunks.length = 0;
      }
    }
  } catch (e) {
    failed = failed || e;
    // let the running pieces wind down before the caller aborts the sink
    await Promise.allSettled(encodePieces.map((p) => p.done).filter(Boolean));
    for (const rw of rewriters.values()) if (rw) rw.free();
    if (registry) registry.free();
    mx.free();
    throw e;
  }
  if (cancel && cancel()) throw new Error('cancelled');

  // --- video samples: decode order, dts from the sorted presentation times ----
  const medianUs = ctx.medianUs;
  const sorted = samples.map((c) => c.pts).sort((a, b) => a - b);
  let shift = 0;
  for (let i = 0; i < samples.length; i++) shift = Math.max(shift, sorted[i] - samples[i].pts);
  if (registry) {
    description = registry.record();
    codecString = `avc1.${Array.from(description.subarray(1, 4), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  } else if (plan.mode === 'smart' && !description) description = movie.dx.track_description(movie.video.index);
  const vt = mx.add_video_track(codecString, movie.width, movie.height, 1000000, description || new Uint8Array());
  for (let i = 0; i < samples.length; i++) {
    const dts = sorted[i] - shift;
    const dur = i + 1 < samples.length ? sorted[i + 1] - sorted[i] : medianUs;
    mx.add_sample(vt, dts, samples[i].pts, Math.max(1, dur), samples[i].sync, samples[i].size);
  }

  // --- audio: stream copy ----------------------------------------------------
  if (movie.audio && movie.a) {
    const at = mx.add_copy_track('audio', movie.dx.track_sample_entry(movie.audio.index), movie.audio.timescale, 0, 0);
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
  for (const rw of rewriters.values()) if (rw) rw.free();
  if (registry) registry.free();
  mx.free();
  const elapsedMs = performance.now() - started;
  profile.report(`export (${chosen.label}, ${plan.mode})`, encodedFrames, elapsedMs);
  return { blob, warnings, frames: encodedFrames, copied: copiedFrames, spans: encodePieces.length, mode: plan.mode, parallel: K, softened, elapsedMs, codec: codecString, encoderLabel: chosen.label };
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
