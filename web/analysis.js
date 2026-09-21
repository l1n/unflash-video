// Scanning, section preparation, the instant check, the suggesters: the
// same flow as the Python reference (analysis.py / editing.py), driving the
// WASM detector over WebCodecs frames or cached section frames.

import { decodeRange, tick } from './media.js';
import { profile } from './profile.js';
import { dropCaches } from './project.js';

/** Whole-video scan. Returns { result, sections, summary, trace }. */
export async function scanMovie(env, movie, { onProgress, cancel } = {}) {
  const { wasm, config, feeder } = env;
  feeder.reset();
  profile.reset();
  const trace = { t: [], hazard: [], hazardRed: [], ext: [], lum: [], pattern: [] };
  const collect = () => {
    for (const r of feeder.records()) {
      trace.t.push(r.t);
      trace.hazard.push(r.hazard);
      trace.hazardRed.push(r.hazard_red);
      trace.ext.push(Math.max(r.ext, r.ext_red));
      trace.lum.push(r.lum);
      trace.pattern.push(r.pattern);
    }
  };
  let count = 0;
  const started = performance.now();
  await decodeRange(
    movie,
    movie.tsMin,
    movie.tsMax + 1,
    async (frame, t) => {
      await feeder.videoFrame(frame, t, false);
      if (++count % 30 === 0) {
        collect();
        if (onProgress) onProgress(count / Math.max(1, movie.frameCount), trace, count, performance.now() - started);
        profile.reportEvery(5000, 'scan so far', count, performance.now() - started);
      }
    },
    { cancel, raw: true, fast: true }
  );
  await feeder.drain();
  collect();
  const elapsed = performance.now() - started;
  profile.report(`scan of ${(movie.file && movie.file.name) || 'the file'} (${movie.width}×${movie.height}, ${feeder.backend})`, count, elapsed);
  const result = feeder.finish(false);
  const vjson = JSON.stringify(result.violations);
  // no keyframe snapping: the export re-encodes, so sections can follow the
  // flashing exactly instead of growing to the nearest keyframes
  const sections = JSON.parse(wasm.violations_to_sections(vjson, config, movie.tsMin, movie.tsMax, new Float64Array()));
  const summary = JSON.parse(wasm.timeline_summary(JSON.stringify(result), movie.tsMin, movie.tsMax, 1.0));
  return { result, sections, summary, trace, frames: count, elapsedMs: elapsed, patternThresh: feeder.det.pattern_thresh() };
}

/**
 * Decode a section plus its run-up and run-out, cache the analysis-size
 * pictures, and record the frame times. Fills sec.cache / sec.ctx / sec.pts.
 */
export async function prepareSection(env, movie, sec, { onProgress, cancel } = {}) {
  const { wasm, config, feeder } = env;
  const need = wasm.context_seconds(config);
  const leadFrom = Math.max(movie.tsMin, sec.start - need);
  const tailTo = Math.min(movie.tsMax, sec.end + need);
  const aw = feeder.aw;
  const ah = feeder.ah;
  const cache = new wasm.FrameCache(aw, ah);
  const lead = new wasm.FrameCache(aw, ah);
  const tail = new wasm.FrameCache(aw, ah);
  const rawPts = [];
  const rawPat = []; // patterned pixels per section frame
  const rawPer = []; // mean stripe half-period per section frame (analysis px)
  const leadPts = [];
  const tailPts = [];
  const pending = []; // [index, t]
  feeder.reset();
  const settle = () => {
    for (const r of feeder.records()) {
      const rgba = feeder.det.take_capture(r.index);
      if (!rgba) continue;
      const t = r.t;
      if (t < sec.start - 1e-6) {
        lead.push(rgba);
        leadPts.push(Math.round((t - sec.start) * 1e6) / 1e6);
      } else if (t <= sec.end + 1e-6 && t < sec.end + 1e-6) {
        cache.push(rgba);
        rawPts.push(t - sec.start);
        rawPat.push(r.pattern || 0);
        rawPer.push(r.pattern_period || 0);
      } else {
        tail.push(rgba);
        tailPts.push(Math.round((t - sec.start) * 1e6) / 1e6);
      }
    }
  };
  let count = 0;
  profile.reset();
  const prepStarted = performance.now();
  await decodeRange(
    movie,
    leadFrom,
    tailTo,
    async (frame, t) => {
      await feeder.videoFrame(frame, t, true);
      pending.push(t);
      if (++count % 16 === 0) {
        settle();
        if (onProgress) onProgress(count);
      }
    },
    { cancel, raw: true, fast: true }
  );
  await feeder.drain();
  settle();
  profile.report(`section prepare (${count} frames with captures)`, count, performance.now() - prepStarted);
  if (cache.len() === 0) throw new Error('Section decoded zero frames');
  // the section works on a sanitised timeline (timestamp anomalies bridged)
  const san = JSON.parse(wasm.sanitize_deltas(Float64Array.from(rawPts), JSON.parse(config).max_frame_gap));
  const relPts = san.times.map((t) => Math.round(t * 1e6) / 1e6);
  const warnings = [];
  if (san.fixed) {
    warnings.push(`Bridged ${san.fixed} timestamp glitches in the source (its timestamps jump backwards or by several seconds). Output timing uses the repaired timeline.`);
  }
  const was = sec.nFrames || 0;
  if (sec.prepared && Object.keys(sec.edits || {}).length && was && was !== relPts.length) {
    warnings.push(`Re-prepared with ${relPts.length} frames where the marks were made against ${was}. They were kept, but they now sit on different frames, so check them before exporting.`);
  }
  dropCaches(sec);
  sec.prepared = true;
  sec.nFrames = relPts.length;
  sec.pts = relPts;
  sec.pattern = { counts: rawPat, periods: rawPer, thresh: feeder.det.pattern_thresh() };
  sec.cache = cache;
  sec.ctx = { lead, leadPts, tail, tailPts, seconds: need };
  sec.warnings = warnings;
  sec.edits = sec.edits || {};
  sec.preparedAt = Date.now();
  return sec;
}

export function shownPts(wasm, sec) {
  return Array.from(wasm.shown_pts(Float64Array.from(sec.pts), sec.start, sec.end));
}

/** Blur strength that takes a stripe pattern under the detector's swing. */
const SOFTEN_SIGMA_PER_HALF_PERIOD = 1.0;
/** Seconds of frames around a patterned frame that are softened with it. */
const SOFTEN_MARGIN_S = 0.25;

/**
 * Which of a prepared section's frames the "soften stripes" option blurs,
 * and how much: the frames where a regular pattern covered at least half
 * the area threshold (plus a short margin either side), blurred with a
 * Gaussian of σ = the stripes' mean half-period, which flattens them. In
 * analysis pixels; scale by the source/analysis width for the export.
 * Returns null when the section has no patterned frames.
 */
export function softenPlan(sec) {
  const p = sec.pattern;
  if (!p || !p.counts || !p.counts.length || !p.thresh) return null;
  const bar = p.thresh / 2;
  const hot = [];
  for (let i = 0; i < p.counts.length; i++) if (p.counts[i] >= bar) hot.push(i);
  if (!hot.length) return null;
  const pts = sec.pts || [];
  const at = (i) => (pts[i] === undefined ? i / 30 : pts[i]);
  const frames = new Set();
  for (const i of hot) {
    frames.add(i);
    for (let j = i - 1; j >= 0 && at(j) >= at(i) - SOFTEN_MARGIN_S; j--) frames.add(j);
    for (let j = i + 1; j < p.counts.length && at(j) <= at(i) + SOFTEN_MARGIN_S; j++) frames.add(j);
  }
  let wsum = 0;
  let psum = 0;
  for (const i of hot) {
    if (p.periods[i] > 0) {
      psum += p.periods[i] * p.counts[i];
      wsum += p.counts[i];
    }
  }
  const period = wsum ? psum / wsum : 2;
  const sigma = Math.max(1, SOFTEN_SIGMA_PER_HALF_PERIOD * period);
  // three box passes of radius r have σ² = ((2r+1)² − 1) / 4
  const radius = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  return { frames, hot, period, sigma, radius };
}

/** The frames a check or suggestion should read: softened when asked. */
export function sectionFrames(sec) {
  if (!sec.soften || !sec.cache) return sec.cache;
  const plan = softenPlan(sec);
  if (!plan) return sec.cache;
  const key = `${plan.radius}:${sec.preparedAt}:${[...plan.frames].join(',')}`;
  if (sec.softCache && sec.softKey === key) return sec.softCache;
  if (sec.softCache) sec.softCache.clear();
  const mask = new Uint8Array(sec.cache.len());
  for (const i of plan.frames) if (i < mask.length) mask[i] = 1;
  sec.softCache = sec.cache.blurred(plan.radius, mask);
  sec.softKey = key;
  sec.softPlan = plan;
  return sec.softCache;
}

function sectionsIn(project, sec, tLo, tHi) {
  return project
    .sectionsSorted()
    .filter((s) => s.id !== sec.id && s.end > tLo + 1e-6 && s.start < tHi - 1e-6);
}

/** The last/first `seconds` of another section as the export will contain it. */
function editedEdge(wasm, o, seconds, side, extS) {
  if (!o.prepared || !o.cache || !o.pts || !o.pts.length) return null;
  const seq = JSON.parse(wasm.edited_sequence(Float64Array.from(shownPts(wasm, o)), JSON.stringify(o.edits || {}), extS));
  if (!seq.t.length) return null;
  const cache = sectionFrames(o);
  const idx = [];
  const last = seq.t[seq.t.length - 1];
  const first = seq.t[0];
  for (let k = 0; k < seq.t.length; k++) {
    if (side === 'lead' ? seq.t[k] > last - seconds : seq.t[k] < first + seconds) idx.push(k);
  }
  if (!idx.length) return null;
  return { frames: idx.map((k) => ({ cache, i: seq.src[k] })), times: idx.map((k) => seq.t[k]) };
}

function compose(wasm, project, sec, src, secStart, tLo, tHi, need, extS, side, notes) {
  const others = sectionsIn(project, sec, tLo, tHi);
  const frames = src ? src.frames : [];
  const times = src ? src.times : [];
  const parts = [];
  const original = (lo, hi) => {
    const f = [];
    const ts = [];
    for (let k = 0; k < frames.length; k++) {
      const t = times[k] + secStart;
      if (lo - 1e-6 <= t && t < hi - 1e-6) {
        f.push(frames[k]);
        ts.push(times[k]);
      }
    }
    if (f.length) parts.push({ frames: f, times: ts });
  };
  let cursor = tLo;
  for (const o of others) {
    original(cursor, o.start);
    const edge = editedEdge(wasm, o, need, side, extS);
    if (edge) parts.push(edge);
    else {
      original(Math.max(cursor, o.start), Math.min(tHi, o.end));
      notes.push(`Section #${o.id} is inside this one's ${side === 'lead' ? 'run-up' : 'run-out'} but is not prepared, so this check reads its original frames. Edits made there are not included here.`);
    }
    cursor = Math.max(cursor, o.end);
  }
  original(cursor, tHi);
  return parts;
}

function join(parts, dt) {
  const frames = [];
  const times = [];
  let cursor = 0;
  for (const p of parts) {
    if (!p.frames.length) continue;
    const base = p.times[0];
    for (let k = 0; k < p.frames.length; k++) {
      frames.push(p.frames[k]);
      times.push(cursor + (p.times[k] - base));
    }
    cursor = times[times.length - 1] + dt;
  }
  return { frames, times };
}

/** Run-up and run-out for a section's check, as the export will contain them. */
export function sectionContext(env, project, sec, extS) {
  const { wasm, config } = env;
  const need = wasm.context_seconds(config);
  const notes = [];
  let leadSrc = null;
  let tailSrc = null;
  if (sec.ctx) {
    if (sec.ctx.lead.len()) leadSrc = { frames: Array.from({ length: sec.ctx.lead.len() }, (_, i) => ({ cache: sec.ctx.lead, i })), times: sec.ctx.leadPts };
    if (sec.ctx.tail.len()) tailSrc = { frames: Array.from({ length: sec.ctx.tail.len() }, (_, i) => ({ cache: sec.ctx.tail, i })), times: sec.ctx.tailPts };
    if ((sec.ctx.seconds || 0) + 1e-6 < need) {
      notes.push('This profile needs a longer run-up than the section was prepared with. Prepare it again so its check sees what a verify of the whole export sees.');
    }
  } else {
    notes.push('This section has no cached run-up, so its check starts cold and cannot see flashing in its opening second. Prepare it again for a full check.');
  }
  const dt = wasm.median_dt(Float64Array.from(sec.pts || []));
  const [tsMin, tsMax] = project.bounds;
  const leadParts = compose(wasm, project, sec, leadSrc, sec.start, Math.max(tsMin, sec.start - need), sec.start, need, extS, 'lead', notes);
  const lead = join(leadParts, dt);
  if (lead.frames.length) {
    const shift = lead.times[lead.times.length - 1] + dt;
    lead.times = lead.times.map((t) => t - shift);
  }
  const tailParts = compose(wasm, project, sec, tailSrc, sec.start, sec.end, Math.min(tsMax, sec.end + need), need, extS, 'tail', notes);
  const tail = join(tailParts, dt);
  tail.times = tail.times.map((t) => t + dt);
  const nxt = sectionsIn(project, sec, sec.end, sec.end + need);
  const nextAt = nxt.length ? nxt[0].start - sec.end : null;
  return { lead, tail, notes, nextAt };
}

/** The instant safety check for a section's (or the given) edits. */
export async function checkSection(env, project, sec, edits, { extS = 1.0, onProgress } = {}) {
  const { wasm, feeder } = env;
  if (!sec.prepared || !sec.cache) throw new Error('Section not prepared');
  const useEdits = edits || sec.edits || {};
  const ctx = sectionContext(env, project, sec, extS);
  const shown = shownPts(wasm, sec);
  const seq = JSON.parse(wasm.edited_sequence(Float64Array.from(shown), JSON.stringify(useEdits), extS));
  const frames = sectionFrames(sec);
  feeder.reset();
  let fed = 0;
  const total = ctx.lead.frames.length + seq.t.length + ctx.tail.frames.length;
  for (let k = 0; k < ctx.lead.frames.length; k++) {
    await feeder.cached(ctx.lead.frames[k].cache, ctx.lead.frames[k].i, ctx.lead.times[k]);
    if (onProgress && ++fed % 60 === 0) onProgress(fed / total);
  }
  for (let k = 0; k < seq.t.length; k++) {
    await feeder.cached(frames, seq.src[k], seq.t[k]);
    if (onProgress && ++fed % 60 === 0) onProgress(fed / total);
  }
  const endDisp = seq.t.length ? seq.t[seq.t.length - 1] : 0;
  for (let k = 0; k < ctx.tail.frames.length; k++) {
    await feeder.cached(ctx.tail.frames[k].cache, ctx.tail.frames[k].i, endDisp + ctx.tail.times[k]);
    if (onProgress && ++fed % 60 === 0) onProgress(fed / total);
  }
  await feeder.drain();
  const result = feeder.finish(true);
  const cls = JSON.parse(wasm.classify(JSON.stringify(result), endDisp, ctx.nextAt === null ? undefined : ctx.nextAt));
  const violations = [...cls.inside, ...cls.after];
  const wcagSafe = !violations.some((v) => v.kind === 'flash' || v.kind === 'red');
  const extendedBad = result.flag_extended && violations.some((v) => v.kind === 'extended');
  const patternBad = result.flag_patterns && violations.some((v) => v.kind === 'pattern');
  const safe = wcagSafe && !extendedBad && !patternBad;
  const soft = sec.soften && frames !== sec.cache && sec.softPlan ? sec.softPlan : null;
  const flagged = Array.from(wasm.flagged_frames(Float64Array.from(seq.t), JSON.stringify(cls.inside)));
  const spills = cls.inside.filter((v) => v.end > endDisp + 1e-6);
  // chart statistics for the section's own frames
  const lo = ctx.lead.frames.length;
  const hi = lo + seq.t.length;
  const fs = result.frame_stats;
  const slice = (a) => (a ? a.slice(lo, hi) : []);
  const stats = {
    t: slice(fs.t),
    lum: slice(fs.lum),
    up: slice(fs.up_area),
    down: slice(fs.down_area),
    red: slice(fs.red_area),
    hazard: slice(fs.hazard),
    hazardRed: slice(fs.hazard_red),
    pattern: slice(fs.pattern),
  };
  return {
    safe,
    wcag_safe: wcagSafe,
    flag_extended: result.flag_extended,
    flag_patterns: result.flag_patterns,
    pattern_thresh: result.pattern_thresh,
    soften: !!sec.soften,
    soft_frames: soft ? [...soft.frames] : [],
    soft_sigma: soft ? soft.sigma : 0,
    violations,
    inside: cls.inside,
    after: cls.after,
    elsewhere: cls.elsewhere,
    flagged,
    spills,
    stats,
    seq,
    endDisp,
    events: result.events,
    area_thresh: result.area_thresh,
    context_notes: ctx.notes,
    context_lead: ctx.lead.times.length ? -ctx.lead.times[0] : 0,
    context_tail: ctx.tail.times.length ? ctx.tail.times[ctx.tail.times.length - 1] : 0,
    profile: wasm.profile_name(env.config),
    detector_sig: wasm.config_signature(env.config),
    raw: { ...result, violations },
    frames: hi - lo,
  };
}

/** Keep-light / keep-dark suggestion. `only` is an array of ordinals or null. */
export async function suggestEdits(env, project, sec, prefer, only, { extS = 1.0, onProgress } = {}) {
  const { wasm } = env;
  const shown = shownPts(wasm, sec);
  const sug = new wasm.Suggester(Float64Array.from(shown), JSON.stringify(sec.edits || {}), prefer, only ? JSON.stringify(only) : undefined);
  const frames = sectionFrames(sec);
  let step = JSON.parse(sug.step(frames, undefined));
  let round = 0;
  let last = null;
  while (step.simulate) {
    if (onProgress) onProgress(round);
    last = await checkSection(env, project, sec, step.simulate, { extS });
    step = JSON.parse(sug.step(frames, JSON.stringify(last.raw)));
    round++;
  }
  sug.free();
  return { ...step.done, verdict: last };
}

/** "Reduce FPS": thin to a rate from timestamps alone, then check. */
export async function suggestFrameRate(env, project, sec, only, fps, { extS = 1.0 } = {}) {
  const { wasm, config } = env;
  const shown = shownPts(wasm, sec);
  const p = JSON.parse(
    wasm.rate_proposal(config, Float64Array.from(shown), JSON.stringify(sec.edits || {}), only ? JSON.stringify(only) : undefined, fps == null ? undefined : fps, extS)
  );
  const verdict = await checkSection(env, project, sec, p.edits, { extS });
  const note = wasm.rate_note(JSON.stringify(p), verdict.safe);
  return { edits: p.removals, safe: verdict.safe, rounds: 1, fps: p.fps, safe_fps: p.safe_fps, guaranteed: p.guaranteed, note, verdict };
}

export { tick };
