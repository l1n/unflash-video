// Unflash web app: wiring between the WASM detector, WebCodecs and the UI.

import init, * as wasm from './pkg/unflash.js';
import { defaultWorkerCount } from './h264pool.js';
import { Movie, tick } from './media.js';
import { createDetector } from './detector.js';
import { scanMovie, prepareSection, checkSection, suggestEdits, suggestFrameRate, shownPts, softenPlan } from './analysis.js';
import { Project, projectKey } from './project.js';
import { exportMovie, encoderCandidates, pickSaveSink } from './export.js';

const $ = (id) => document.getElementById(id);
const EXT_S = 1.0;
const CACHE_BUDGET = 700 * 1024 * 1024;

const state = {
  movie: null,
  project: null,
  config: null,
  env: null, // { wasm, config, feeder } for scans/checks
  liveFeeder: null,
  current: null,
  selection: new Set(),
  anchor: null,
  job: null,
  live: { on: false, t: [], hazard: [], hazardRed: [], pattern: [], violations: 0, lastCheck: 0 },
  decode: { supported: false, reason: '' },
  exportBlob: null,
  checkTimer: null,
  checkRunning: false,
  checkAgain: false,
  scanTrace: null,
};

// ---- small helpers -----------------------------------------------------------

function fmt(t) {
  return wasm.format_time(t);
}

function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function banner(msg, kind = 'error') {
  const b = $('banner');
  $('bannerText').textContent = msg;
  b.classList.toggle('info', kind === 'info');
  b.classList.remove('hidden');
}

function setStatus(parts) {
  $('status').innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
}

async function runJob(name, fn) {
  if (state.job) {
    toast('Another job is running');
    return null;
  }
  const job = { name, cancelled: false };
  state.job = job;
  $('jobName').textContent = name;
  $('jobBar').style.width = '0%';
  $('jobMsg').textContent = '';
  $('jobbar').classList.remove('hidden');
  const progress = (p, msg) => {
    $('jobBar').style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
    if (msg !== undefined) $('jobMsg').textContent = msg;
  };
  try {
    return await fn(progress, () => job.cancelled);
  } catch (e) {
    console.error(e);
    banner(`${name} failed: ${e && e.message ? e.message : e}`);
    return null;
  } finally {
    state.job = null;
    $('jobbar').classList.add('hidden');
  }
}

function profileConfig(name) {
  return wasm.profile_config(name);
}

/** Whether the profile that produced `result` counts violation `v`. */
function reported(result, v) {
  if (v.kind === 'extended') return !!result.flag_extended;
  if (v.kind === 'pattern') return !!result.flag_patterns;
  return true;
}

const KIND_LABEL = { flash: 'flash', red: 'red flash', extended: 'extended flash', pattern: 'stripes' };
const PATTERN_COLOUR = '#3fc1c9';

/** `?cpu=1` forces the WebAssembly detector (for comparison and tests). */
function preferGpuSetting() {
  return !new URLSearchParams(location.search).has('cpu');
}

// ---- boot ---------------------------------------------------------------------

async function boot() {
  await init();
  const hasGpu = !!navigator.gpu;
  const hasCodecs = typeof VideoDecoder !== 'undefined';
  $('support').textContent = `Unflash ${wasm.version()} · WebGPU: ${hasGpu ? 'available' : 'not available (CPU detector will be used)'} · WebCodecs: ${hasCodecs ? 'available' : 'not available (only the live monitor will work)'}`;
  setStatus([`ready · WebGPU ${hasGpu ? 'yes' : 'no'} · WebCodecs ${hasCodecs ? 'yes' : 'no'}`]);
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) openFile(f);
  });
  $('btnHome').addEventListener('click', () => {
    $('welcome').classList.remove('hidden');
    $('stage').classList.add('hidden');
  });
  $('btnCloseBanner').addEventListener('click', () => $('banner').classList.add('hidden'));
  $('btnCancelJob').addEventListener('click', () => {
    if (state.job) state.job.cancelled = true;
  });
  $('profileSel').addEventListener('change', () => setProfile($('profileSel').value));
  $('btnScan').addEventListener('click', scan);
  $('liveToggle').addEventListener('change', () => setLive($('liveToggle').checked));
  $('dimToggle').addEventListener('change', () => $('player').classList.toggle('dim', $('dimToggle').checked));
  $('player').classList.add('dim');
  $('btnExport').addEventListener('click', openExport);
  $('btnCloseExport').addEventListener('click', () => $('exportModal').classList.add('hidden'));
  $('btnDoExport').addEventListener('click', doExport);
  $('btnVerifyExport').addEventListener('click', verifyExport);
  $('exportQuality').addEventListener('input', () => ($('exportQualityText').textContent = $('exportQuality').value));
  $('btnAddSection').addEventListener('click', () => {
    const s = wasm.parse_time($('addStart').value);
    const e = wasm.parse_time($('addEnd').value);
    if (s == null || e == null || e <= s) return toast('Enter a start and an end, like 1:23.5 and 1:30');
    addSection(s, e);
  });
  for (const b of document.querySelectorAll('[data-clip]')) b.addEventListener('click', () => openClip(b.dataset.clip));
  $('btnPrepareAll').addEventListener('click', prepareAll);
  $('btnCheckAll').addEventListener('click', checkAll);
  $('btnDeleteAll').addEventListener('click', () => {
    if (!state.project || !confirm('Delete every section, including its marks?')) return;
    for (const s of [...state.project.sections]) state.project.deleteSection(s.id);
    state.current = null;
    state.project.save();
    renderAll();
  });
  wireWorkspace();
  wireTimeline();
  window.addEventListener('resize', () => {
    drawTimeline();
    drawChart();
  });
  const player = $('player');
  player.addEventListener('timeupdate', drawTimeline);
  player.addEventListener('play', () => {
    if (state.live.on) startLiveLoop();
  });
  player.addEventListener('seeked', drawTimeline);
}

// ---- opening a file -------------------------------------------------------------

async function openFile(file) {
  $('banner').classList.add('hidden');
  await runJob('Opening video', async (progress) => {
    progress(0.1, 'reading the index');
    const movie = await Movie.open(file, wasm);
    if (state.movie) state.movie.close();
    state.movie = movie;
    state.decode = await movie.decoderSupport();
    progress(0.4, 'starting the detector');
    const key = projectKey(file);
    const project = await Project.load(key, movie.bounds, movie.keyframes);
    state.project = project;
    $('profileSel').value = project.profile;
    state.config = profileConfig(project.profile);
    await createFeeders(progress);
    const player = $('player');
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(file);
    $('videoInfo').textContent = `${file.name} · ${movie.width}×${movie.height} · ${movie.fps.toFixed(2)} fps · ${fmt(movie.duration)} · ${movie.video.codec}${movie.audio ? ' + ' + movie.audio.codec : ''}`;
    $('btnScan').disabled = !state.decode.supported;
    $('btnScan').title = state.decode.supported ? 'Decode every frame with WebCodecs and run the detector over it' : `Scanning needs WebCodecs: ${state.decode.reason}`;
    $('liveToggle').disabled = false;
    $('btnExport').disabled = false;
    $('welcome').classList.add('hidden');
    $('stage').classList.remove('hidden');
    $('sections').classList.remove('hidden');
    $('timelineWrap').classList.remove('hidden');
    if (!state.decode.supported) banner(`This browser cannot decode ${movie.video.codec} with WebCodecs (${state.decode.reason}). The live monitor still works while the player plays; scanning and section editing need a decodable file (H.264 in most browsers).`, 'info');
    else if (state.decode.software) {
      const info = movie.softwareInfo || {};
      banner(`This browser cannot decode ${movie.video.codec} with WebCodecs, so Unflash uses its built-in H.264 decoder (profile ${info.profile_idc}, level ${info.level_idc}) for scanning, sections and export, decoding in ${defaultWorkerCount()} parallel workers. The player cannot play this file here, so the live monitor is off.`, 'info');
    }
    $('liveToggle').disabled = !!state.decode.software;
    state.current = null;
    renderAll();
    updateStatus();
    return true;
  });
}

/** Open one of the test clips published next to the app. */
async function openClip(name) {
  toast(`Fetching ${name}…`, 10000);
  try {
    const r = await fetch(`clips/${name}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const blob = await r.blob();
    const lm = Date.parse(r.headers.get('last-modified') || '') || 0;
    await openFile(new File([blob], name, { type: 'video/mp4', lastModified: lm }));
  } catch (e) {
    banner(`Could not fetch the test clip ${name}: ${e && e.message ? e.message : e}. The clips are generated by the Pages build; for a local copy run python3 tests/media/gen_e2e.py web/clips.`);
  }
}

async function createFeeders(progress) {
  const movie = state.movie;
  if (state.env && state.env.feeder) state.env.feeder.det.free();
  if (state.liveFeeder) state.liveFeeder.det.free();
  const preferGpu = preferGpuSetting();
  const feeder = await createDetector(wasm, state.config, movie.width, movie.height, { preferGpu });
  state.env = { wasm, config: state.config, feeder };
  const live = await createDetector(wasm, state.config, movie.width, movie.height, { preferGpu });
  state.liveFeeder = live;
  if (feeder.note) banner(feeder.note, 'info');
  if (progress) progress(0.8, `${feeder.backend} detector at ${feeder.aw}×${feeder.ah}`);
}

async function setProfile(name) {
  if (!state.project) return;
  state.project.profile = name;
  state.config = profileConfig(name);
  await createFeeders();
  for (const s of state.project.sections) if (s.check) s.check.stale = true;
  await state.project.save();
  renderAll();
  updateStatus();
  toast('Profile changed. Sections need re-checking (they are re-checked when opened).');
}

function updateStatus() {
  const parts = [];
  if (state.env) {
    const f = state.env.feeder;
    parts.push(`detector: <b>${f.backend === 'webgpu' ? 'WebGPU' : 'CPU (WASM)'}</b> at ${f.aw}×${f.ah} (window ${f.det.window_width()}×${f.det.window_height()}, area ≥ ${f.det.area_thresh()} px)`);
    if (state.decode.software) parts.push('decoder: <b>built-in H.264</b> (no WebCodecs decoder for this codec)');
    if (state.lastScan) {
      const s = state.lastScan;
      const fps = (s.frames / (s.elapsedMs / 1000)).toFixed(0);
      const gbs = ((f.det.bytes_per_frame() * (s.frames / (s.elapsedMs / 1000))) / 1e9).toFixed(2);
      parts.push(`last scan: ${s.frames} frames in ${(s.elapsedMs / 1000).toFixed(1)} s = ${fps} fps (${(fps / state.movie.fps).toFixed(1)}× realtime), ≈${gbs} GB/s of detector state traffic`);
    }
  }
  if (state.project) parts.push(`caches: ${(state.project.cacheBytes() / 1048576).toFixed(0)} MB`);
  setStatus(parts);
}

// ---- scanning -------------------------------------------------------------------

async function scan() {
  if (!state.movie || !state.env) return;
  setLive(false);
  $('liveToggle').checked = false;
  const res = await runJob('Scanning for flashes', async (progress, cancelled) => {
    const r = await scanMovie(state.env, state.movie, {
      cancel: cancelled,
      onProgress: (p, trace, count, ms) => {
        state.scanTrace = trace;
        progress(p, `${count} frames · ${(count / (ms / 1000)).toFixed(0)} fps`);
        if (count % 300 === 0) drawTimeline();
      },
    });
    return r;
  });
  if (!res) return;
  state.lastScan = res;
  state.scanTrace = res.trace;
  const project = state.project;
  project.scan = {
    violations: res.result.violations,
    summary: res.summary,
    frames: res.frames,
    elapsedMs: res.elapsedMs,
    profile: project.profile,
    sig: wasm.config_signature(state.config),
    safe: res.result.violations.every((v) => !reported(res.result, v)),
    anomalies: res.result.anomalies,
    held: res.result.held,
  };
  let added = 0;
  for (const s of res.sections) {
    const overlaps = project.sections.some((o) => o.end > s.start && o.start < s.end);
    if (overlaps) continue;
    project.addSection(s.start, s.end, s.kinds, false);
    added++;
  }
  await project.save();
  renderAll();
  updateStatus();
  const counted = res.result.violations.filter((v) => reported(res.result, v));
  const n = counted.length;
  const np = counted.filter((v) => v.kind === 'pattern').length;
  const fps = (res.frames / (res.elapsedMs / 1000)).toFixed(0);
  toast(
    n
      ? `${n} violation${n === 1 ? '' : 's'} found${np ? ` (${np} regular pattern${np === 1 ? '' : 's'}, ${n - np} flash)` : ''}, ${added} new section${added === 1 ? '' : 's'} added (${fps} fps).`
      : `No flashing${res.result.flag_patterns ? ' or hazardous patterns' : ''} found in ${res.frames} frames.`,
    6000
  );
}

// ---- live monitor ---------------------------------------------------------------

function setLive(on) {
  state.live.on = on;
  $('hud').classList.toggle('hidden', !on);
  const v = $('liveVerdict');
  if (!on) {
    v.className = 'live-verdict idle';
    v.textContent = 'monitor off';
    return;
  }
  state.liveFeeder.reset();
  state.live.t = [];
  state.live.hazard = [];
  state.live.hazardRed = [];
  state.live.pattern = [];
  state.live.violations = 0;
  v.className = 'live-verdict ok';
  v.textContent = 'watching';
  startLiveLoop();
}

let liveLoopActive = false;
function startLiveLoop() {
  const player = $('player');
  if (liveLoopActive || !state.live.on) return;
  liveLoopActive = true;
  const feeder = state.liveFeeder;
  const step = (now, meta) => {
    if (!state.live.on || !state.liveFeeder) {
      liveLoopActive = false;
      return;
    }
    const det = feeder.det;
    det.poll();
    if (det.can_submit()) {
      const t0 = performance.now();
      try {
        if (feeder.gpu) det.feed_video_element(player, meta.mediaTime, false);
        else {
          feeder.ctx.drawImage(player, 0, 0, feeder.aw, feeder.ah);
          const img = feeder.ctx.getImageData(0, 0, feeder.aw, feeder.ah);
          det.feed_rgba(img.data, feeder.aw, feeder.ah, meta.mediaTime, false);
        }
        feeder.fed++;
        feeder.busyNs += (performance.now() - t0) * 1e6;
      } catch (e) {
        console.warn(e);
      }
    }
    drainLive();
    if (!player.paused && !player.ended) player.requestVideoFrameCallback(step);
    else {
      liveLoopActive = false;
      setTimeout(drainLive, 50);
    }
  };
  player.requestVideoFrameCallback(step);
}

function drainLive() {
  const feeder = state.liveFeeder;
  if (!feeder || !state.live.on) return;
  const det = feeder.det;
  det.poll();
  const recs = feeder.records();
  if (!recs.length) return;
  const thresh = det.area_thresh();
  const pthresh = det.pattern_thresh() || 1;
  const L = state.live;
  for (const r of recs) {
    L.t.push(r.t);
    L.hazard.push(r.hazard / thresh);
    L.hazardRed.push(r.hazard_red / thresh);
    L.pattern.push(r.pattern / pthresh);
  }
  const last = recs[recs.length - 1];
  const haz = last.hazard / thresh;
  const red = last.hazard_red / thresh;
  const ext = Math.max(last.ext, last.ext_red) / thresh;
  const pat = last.pattern / pthresh;
  $('hudHaz').style.width = `${Math.min(100, haz * 50)}%`;
  $('hudRed').style.width = `${Math.min(100, red * 50)}%`;
  $('hudPat').style.width = `${Math.min(100, pat * 50)}%`;
  $('hudHazText').textContent = `${Math.round(haz * 100)}%`;
  $('hudRedText').textContent = `${Math.round(red * 100)}%`;
  $('hudPatText').textContent = `${Math.round(pat * 100)}%`;
  const now = performance.now();
  if (now - L.lastCheck > 700) {
    L.lastCheck = now;
    const res = feeder.finish(false);
    const viol = res.violations.filter((v) => reported(res, v));
    L.violations = viol.length;
    const v = $('liveVerdict');
    const recent = viol.length && viol[viol.length - 1].end >= last.t - 1.5;
    if (recent) {
      const k = viol[viol.length - 1].kind;
      v.className = 'live-verdict bad';
      v.textContent = k === 'pattern' ? 'hazardous pattern: stripes' : `flashing: ${k === 'red' ? 'red flash' : k === 'extended' ? 'extended flash' : 'general flash'}`;
    } else if (haz > 0 || ext >= 1 || (pat >= 1 && res.flag_patterns)) {
      v.className = 'live-verdict warn';
      v.textContent = haz > 0 || ext >= 1 ? 'flashing below the limit' : 'stripes on screen';
    } else {
      v.className = 'live-verdict ok';
      v.textContent = viol.length ? `${viol.length} violation${viol.length === 1 ? '' : 's'} so far` : 'no flashing so far';
    }
    $('hudInfo').textContent = `${res.frames} frames watched · ${res.held} re-shown · ${feeder.backend === 'webgpu' ? 'GPU' : 'CPU'} ${(feeder.busyNs / 1e6 / Math.max(1, feeder.fed)).toFixed(2)} ms/frame on the main thread`;
    drawTimeline();
  }
}

// ---- timeline -------------------------------------------------------------------

function wireTimeline() {
  const c = $('timeline');
  let drag = null;
  const xToT = (x) => {
    const r = c.getBoundingClientRect();
    const [lo, hi] = state.project.bounds;
    return lo + ((x - r.left) / r.width) * (hi - lo);
  };
  c.addEventListener('mousedown', (e) => {
    if (!state.project) return;
    drag = { x0: e.clientX, t0: xToT(e.clientX), moved: false };
  });
  c.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) > 4) drag.moved = true;
    drag.t1 = xToT(e.clientX);
    drawTimeline(drag.moved ? [Math.min(drag.t0, drag.t1), Math.max(drag.t0, drag.t1)] : null);
  });
  window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!state.project) return;
    if (d.moved) {
      const a = Math.min(d.t0, d.t1);
      const b = Math.max(d.t0, d.t1);
      if (b - a >= 0.3) addSection(a, b);
      drawTimeline();
      return;
    }
    const t = xToT(e.clientX);
    const hit = state.project.sectionsSorted().find((s) => t >= s.start && t <= s.end);
    if (hit) openSection(hit.id);
    else $('player').currentTime = t;
    drawTimeline();
  });
}

function drawTimeline(dragSpan = null) {
  const c = $('timeline');
  if (!state.project || c.classList.contains('hidden')) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth;
  const H = c.clientHeight;
  if (c.width !== Math.round(W * dpr)) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const [lo, hi] = state.project.bounds;
  const span = Math.max(1e-6, hi - lo);
  const x = (t) => ((t - lo) / span) * W;
  // heat from the scan
  const sum = state.project.scan && state.project.scan.summary;
  if (sum) {
    const n = sum.general.length;
    const bw = Math.max(1, W / n);
    for (let i = 0; i < n; i++) {
      const gcount = sum.general[i];
      const rcount = sum.red[i];
      if (gcount) {
        g.fillStyle = `rgba(232,163,60,${Math.min(1, 0.25 + gcount / 6)})`;
        g.fillRect(x(sum.t0 + i * sum.bin), 6, bw + 0.5, H - 30);
      }
      if (rcount) {
        g.fillStyle = `rgba(224,79,176,${Math.min(1, 0.25 + rcount / 6)})`;
        g.fillRect(x(sum.t0 + i * sum.bin), 6, bw + 0.5, (H - 30) / 2);
      }
      const pcount = sum.pattern ? sum.pattern[i] : 0;
      if (pcount) {
        g.fillStyle = `rgba(63,193,201,${Math.min(1, 0.3 + pcount / 4)})`;
        g.fillRect(x(sum.t0 + i * sum.bin), 6 + (H - 30) / 2, bw + 0.5, (H - 30) / 2);
      }
    }
  }
  // the live trace (and the scan trace while scanning)
  const trace = state.live.on ? { t: state.live.t, h: state.live.hazard, r: state.live.hazardRed } : state.scanTrace ? { t: state.scanTrace.t, h: state.scanTrace.hazard.map((v) => v / state.env.feeder.det.area_thresh()), r: state.scanTrace.hazardRed.map((v) => v / state.env.feeder.det.area_thresh()) } : null;
  if (trace && trace.t.length) {
    const base = H - 24;
    g.strokeStyle = 'rgba(232,163,60,.9)';
    g.beginPath();
    for (let i = 0; i < trace.t.length; i++) {
      const h = Math.min(1.5, trace.h[i]);
      if (h <= 0) continue;
      const px = x(trace.t[i]);
      g.moveTo(px, base);
      g.lineTo(px, base - h * 14);
    }
    g.stroke();
    g.strokeStyle = 'rgba(224,79,176,.9)';
    g.beginPath();
    for (let i = 0; i < trace.t.length; i++) {
      const h = Math.min(1.5, trace.r[i]);
      if (h <= 0) continue;
      const px = x(trace.t[i]);
      g.moveTo(px, base);
      g.lineTo(px, base - h * 14);
    }
    g.stroke();
  }
  // threshold line label
  g.fillStyle = '#5a6070';
  g.fillRect(0, H - 24, W, 1);
  // sections
  for (const s of state.project.sectionsSorted()) {
    const x0 = x(s.start);
    const x1 = Math.max(x0 + 3, x(s.end));
    const isCur = state.current === s.id;
    const kind = (s.kinds || []).includes('red') ? '#e04fb0' : (s.kinds || []).includes('flash') ? '#e8a33c' : (s.kinds || []).includes('extended') ? '#7f9bff' : (s.kinds || []).includes('pattern') ? PATTERN_COLOUR : '#9aa0ad';
    g.fillStyle = isCur ? 'rgba(79,140,255,.35)' : 'rgba(255,255,255,.08)';
    g.fillRect(x0, 4, x1 - x0, H - 26);
    g.strokeStyle = s.check && !s.check.stale ? (s.check.safe ? '#3dbb6a' : '#e0503f') : kind;
    g.lineWidth = isCur ? 2 : 1;
    g.strokeRect(x0 + 0.5, 4.5, x1 - x0 - 1, H - 27);
    g.fillStyle = '#fff';
    g.font = '11px system-ui';
    g.fillText(`#${s.id}`, x0 + 3, 16);
  }
  if (dragSpan) {
    g.fillStyle = 'rgba(79,140,255,.3)';
    g.fillRect(x(dragSpan[0]), 4, x(dragSpan[1]) - x(dragSpan[0]), H - 26);
  }
  // time ticks
  g.fillStyle = '#7d8494';
  g.font = '10px system-ui';
  const step = niceStep(span / Math.max(2, W / 90));
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    g.fillRect(x(t), H - 22, 1, 4);
    g.fillText(fmt(t), x(t) + 2, H - 12);
  }
  // playhead
  const ct = $('player').currentTime;
  if (ct >= lo && ct <= hi) {
    g.fillStyle = '#fff';
    g.fillRect(x(ct), 0, 1.5, H);
  }
}

function niceStep(raw) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  for (const s of steps) if (s >= raw) return s;
  return 3600;
}

// ---- sections list ----------------------------------------------------------------

function addSection(a, b) {
  const sec = state.project.addSection(a, b, [], true);
  if (!sec) return toast('That range is outside the video');
  state.project.save();
  renderAll();
  openSection(sec.id);
}

function sectionBadge(s) {
  if (!s.prepared && !s.check) return `<span class="badge">unprepared</span>`;
  if (!s.check) return `<span class="badge">unchecked</span>`;
  if (s.check.stale) return `<span class="badge stale">re-check</span>`;
  if (s.check.safe) return `<span class="badge safe">safe</span>`;
  if (s.check.wcag_safe) {
    const kinds = remainingKinds(s.check);
    return kinds.includes('stripes') ? `<span class="badge pat">stripes</span>` : `<span class="badge ext">extended flash</span>`;
  }
  return `<span class="badge unsafe">unsafe</span>`;
}

/** The non-WCAG problems a check still reports, as labels. */
function remainingKinds(c) {
  const inside = c.inside || c.violations || [];
  const out = [];
  if (c.flag_extended !== false && inside.some((v) => v.kind === 'extended')) out.push('extended flash');
  if (c.flag_patterns !== false && inside.some((v) => v.kind === 'pattern')) out.push('stripes');
  return out;
}

function renderSectionList() {
  const list = $('sectionList');
  list.innerHTML = '';
  for (const s of state.project.sectionsSorted()) {
    const el = document.createElement('div');
    el.className = 'sec-item' + (state.current === s.id ? ' current' : '');
    const kinds = (s.kinds || []).map((k) => `<span class="badge kind-${k}">${KIND_LABEL[k] || k}</span>`).join(' ');
    const marks = Object.values(s.edits || {}).filter((e) => e.removed || e.extended).length;
    el.innerHTML = `<div class="sec-title">#${s.id} ${sectionBadge(s)}</div><div class="sec-times">${fmt(s.start)} – ${fmt(s.end)} · ${(s.end - s.start).toFixed(1)} s${marks ? ` · ${marks} marks` : ''}${s.custom ? ' · custom' : ''}</div><div>${kinds}</div>`;
    el.addEventListener('click', () => openSection(s.id));
    list.appendChild(el);
  }
  if (!state.project.sections.length) list.innerHTML = `<div class="sec-item" style="color:var(--fg2)">No sections yet. Scan the video, or drag on the timeline.</div>`;
}

function renderAll() {
  renderSectionList();
  drawTimeline();
  renderWorkspace();
}

async function prepareAll() {
  for (const s of state.project.sectionsSorted()) {
    if (s.prepared) continue;
    await doPrepare(s);
  }
}

async function checkAll() {
  for (const s of state.project.sectionsSorted()) {
    if (!s.prepared) continue;
    const c = await runJob(`Checking section #${s.id}`, async () => checkSection(state.env, state.project, s, null, { extS: EXT_S }));
    if (c) s.check = c;
  }
  await state.project.save();
  renderAll();
}

// ---- workspace ----------------------------------------------------------------------

function currentSection() {
  return state.project && state.current != null ? state.project.section(state.current) : null;
}

function openSection(id) {
  state.current = id;
  state.selection.clear();
  state.anchor = null;
  const sec = currentSection();
  if (sec) {
    sec.usedAt = Date.now();
    $('player').currentTime = sec.start;
  }
  renderAll();
  if (sec && sec.prepared && (!sec.check || sec.check.stale)) scheduleCheck(0);
  $('workspace').scrollIntoView({ block: 'nearest' });
}

function wireWorkspace() {
  $('btnPrepare').addEventListener('click', () => doPrepare(currentSection()));
  $('btnReprepare').addEventListener('click', () => doPrepare(currentSection()));
  $('btnDeleteSection').addEventListener('click', () => {
    const sec = currentSection();
    if (!sec || !confirm(`Delete section #${sec.id}?`)) return;
    state.project.deleteSection(sec.id);
    state.current = null;
    state.project.save();
    renderAll();
  });
  $('btnApplyRange').addEventListener('click', () => {
    const sec = currentSection();
    if (!sec) return;
    const s = wasm.parse_time($('secStart').value);
    const e = wasm.parse_time($('secEnd').value);
    if (s == null || e == null || e <= s) return toast('Enter valid times');
    const [lo, hi] = state.project.bounds;
    sec.start = Math.max(lo, s);
    sec.end = Math.min(hi, e);
    sec.prepared = false;
    sec.cache = null;
    sec.ctx = null;
    sec.check = null;
    sec.edits = {};
    sec.pts = null;
    state.project.save();
    renderAll();
  });
  $('btnCheck').addEventListener('click', () => scheduleCheck(0, true));
  $('softenToggle').addEventListener('change', () => {
    const sec = currentSection();
    if (!sec) return;
    sec.soften = $('softenToggle').checked;
    afterEdit(sec);
  });
  $('btnClearEdits').addEventListener('click', () => {
    const sec = currentSection();
    if (!sec) return;
    sec.edits = {};
    afterEdit(sec);
  });
  $('btnSuggestLight').addEventListener('click', () => doSuggest('light'));
  $('btnSuggestDark').addEventListener('click', () => doSuggest('dark'));
  $('btnSuggestFps').addEventListener('click', () => doSuggestFps());
  $('btnFpsMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    $('fpsMenu').classList.toggle('hidden');
  });
  $('fpsMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => $('fpsMenu').classList.add('hidden'));
  $('btnFpsSafe').addEventListener('click', () => {
    $('fpsInput').value = wasm.safe_picture_rate(state.config).toString();
    updateFpsNote();
  });
  $('fpsInput').addEventListener('input', updateFpsNote);
  $('btnMarkRemoved').addEventListener('click', () => markSelection('R'));
  $('btnMarkRemovedNext').addEventListener('click', () => markSelection('F'));
  $('btnMarkExtended').addEventListener('click', () => markSelection('E'));
  $('btnUnmark').addEventListener('click', () => markSelection('U'));
  $('btnSelectUnsafe').addEventListener('click', () => {
    const sec = currentSection();
    if (!sec || !sec.check) return;
    state.selection = new Set(sec.check.flagged || []);
    renderGridMarks();
  });
  const grid = $('frameGrid');
  grid.addEventListener('keydown', (e) => {
    const k = e.key.toUpperCase();
    if (['R', 'F', 'E', 'U'].includes(k)) {
      e.preventDefault();
      markSelection(k);
    } else if (e.key === 'Escape') {
      state.selection.clear();
      state.anchor = null;
      renderGridMarks();
    } else if (k === 'A' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const sec = currentSection();
      if (sec) state.selection = new Set(Array.from({ length: sec.nFrames }, (_, i) => i));
      renderGridMarks();
    }
  });
  $('chart').addEventListener('click', (e) => {
    const sec = currentSection();
    if (!sec || !sec.prepared) return;
    const r = $('chart').getBoundingClientRect();
    const shown = shownPts(wasm, sec);
    const i = Math.min(shown.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * shown.length)));
    state.selection = new Set([i]);
    state.anchor = i;
    renderGridMarks();
    const tile = $('frameGrid').children[i];
    if (tile) tile.scrollIntoView({ block: 'nearest' });
    $('player').currentTime = sec.start + shown[i] + (sec.pts ? sec.pts[0] : 0);
  });
}

function updateFpsNote() {
  const v = parseFloat($('fpsInput').value);
  const safe = wasm.safe_picture_rate(state.config);
  const note = $('fpsNote');
  if (!(v > 0)) note.textContent = '';
  else if (wasm.rate_is_guaranteed(state.config, v)) note.textContent = `${v}/s is at or under the guaranteed-safe ${safe}/s: no arrangement of pictures at that rate can fail this profile.`;
  else note.textContent = `${v}/s is above the guaranteed-safe ${safe}/s, so the result is a proposal that the check judges, not a promise.`;
  $('fpsShown').textContent = `(${v > 0 ? v : safe}/s)`;
}

function renderWorkspace() {
  const sec = currentSection();
  const ws = $('workspace');
  if (!sec) {
    ws.classList.add('hidden');
    return;
  }
  ws.classList.remove('hidden');
  $('wsTitle').textContent = `Section #${sec.id}: ${fmt(sec.start)} – ${fmt(sec.end)}`;
  $('secStart').value = fmt(sec.start);
  $('secEnd').value = fmt(sec.end);
  $('wsUnprepared').classList.toggle('hidden', !!sec.prepared);
  $('wsBody').classList.toggle('hidden', !sec.prepared);
  const warn = $('wsWarnings');
  const notes = [...(sec.warnings || []), ...((sec.check && sec.check.context_notes) || [])];
  warn.textContent = notes.join('\n');
  warn.classList.toggle('hidden', !notes.length);
  renderVerdict(sec);
  if (!$('fpsInput').value) $('fpsInput').value = wasm.safe_picture_rate(state.config).toString();
  updateFpsNote();
  renderSoften(sec);
  if (sec.prepared) {
    $('frameCount').textContent = `(${sec.nFrames})`;
    renderGrid(sec);
  }
  drawChart();
}

/** The "soften stripes" switch: shown when the section has a pattern. */
function renderSoften(sec) {
  const plan = sec.prepared && sec.cache ? softenPlan(sec) : null;
  const relevant = !!plan || !!sec.soften || (sec.kinds || []).includes('pattern');
  $('softenWrap').classList.toggle('hidden', !relevant);
  $('softenToggle').checked = !!sec.soften;
  $('softenToggle').disabled = !sec.prepared;
  let note = '';
  if (plan) {
    const scale = state.movie ? state.movie.width / sec.cache.width() : 1;
    note = `${plan.frames.size} of ${sec.nFrames} frames · blur σ ≈ ${(plan.sigma * scale).toFixed(1)} px (stripes ${(2 * plan.period * scale).toFixed(0)} px apart)`;
  } else if (sec.prepared) note = 'no stripes found in this section';
  $('softenNote').textContent = note;
}

function renderVerdict(sec) {
  const v = $('wsVerdict');
  const c = sec.check;
  if (!c) {
    v.className = 'verdict';
    v.textContent = sec.prepared ? 'unchecked' : 'not prepared';
  } else if (c.stale) {
    v.className = 'verdict';
    v.textContent = 'needs re-check';
  } else if (c.safe) {
    v.className = 'verdict safe';
    v.textContent = 'passes';
  } else if (c.wcag_safe) {
    const kinds = remainingKinds(c);
    v.className = 'verdict ' + (kinds.includes('stripes') ? 'pat' : 'ext');
    v.textContent = kinds.length ? `passes WCAG, ${kinds.join(' and ')} remain${kinds.length === 1 && kinds[0] === 'extended flash' ? 's' : ''}` : 'passes WCAG';
  } else {
    v.className = 'verdict unsafe';
    v.textContent = describeFailure(c);
  }
  $('btnSelectUnsafe').classList.toggle('hidden', !(c && !c.safe && c.flagged && c.flagged.length));
}

function describeFailure(c) {
  const parts = [];
  const inside = c.inside || c.violations || [];
  for (const v of inside.slice(0, 3)) {
    const kind = KIND_LABEL[v.kind] || v.kind;
    let s = `${kind} at ${fmt(v.start)}`;
    if (v.kind === 'pattern') s += ` (${v.count.toFixed(1)}× the area limit)`;
    else if (v.kind !== 'extended' && v.count < 1.08) s += ` (only ${Math.round((v.count - 1) * 100)}% over the area threshold, just over the line)`;
    parts.push(s);
  }
  if (inside.length > 3) parts.push(`+${inside.length - 3} more`);
  if (c.after && c.after.length) parts.push(`${c.after.length} past the end of this section`);
  return `fails: ${parts.join('; ')}`;
}

// ---- frame grid ---------------------------------------------------------------------

let tileObserver = null;
let scratch = null; // one analysis-size canvas; tiles are drawn at thumbnail size
const THUMB_W = 160;
function renderGrid(sec) {
  const grid = $('frameGrid');
  grid.innerHTML = '';
  if (tileObserver) tileObserver.disconnect();
  const shown = shownPts(wasm, sec);
  const aw = sec.cache.width();
  const ah = sec.cache.height();
  const tw = THUMB_W;
  const th = Math.max(1, Math.round((THUMB_W * ah) / aw));
  if (!scratch || scratch.width !== aw || scratch.height !== ah) {
    scratch = new OffscreenCanvas(aw, ah);
  }
  const sctx = scratch.getContext('2d');
  tileObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const tile = en.target;
        if (tile.dataset.drawn) continue;
        tile.dataset.drawn = '1';
        const i = +tile.dataset.i;
        const canvas = tile.querySelector('canvas');
        try {
          const rgba = sec.cache.frame(i);
          const img = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), aw, ah);
          sctx.putImageData(img, 0, 0);
          canvas.getContext('2d').drawImage(scratch, 0, 0, tw, th);
        } catch (e) {
          /* cache gone */
        }
        tileObserver.unobserve(tile);
      }
    },
    { root: null, rootMargin: '200px' }
  );
  const frag = document.createDocumentFragment();
  for (let i = 0; i < shown.length; i++) {
    const tile = document.createElement('div');
    tile.className = 'frame';
    tile.dataset.i = i;
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    tile.appendChild(canvas);
    const no = document.createElement('span');
    no.className = 'fno';
    no.textContent = i;
    tile.appendChild(no);
    const ft = document.createElement('span');
    ft.className = 'ft';
    ft.textContent = shown[i].toFixed(3);
    tile.appendChild(ft);
    const fb = document.createElement('span');
    fb.className = 'fb hidden';
    tile.appendChild(fb);
    tile.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onTileClick(i, e);
    });
    frag.appendChild(tile);
    tileObserver.observe(tile);
  }
  grid.appendChild(frag);
  renderGridMarks();
}

function onTileClick(i, e) {
  const sel = state.selection;
  const sec = currentSection();
  if (e.shiftKey && state.anchor != null) {
    const caps = e.getModifierState && e.getModifierState('CapsLock');
    if (caps) {
      const cols = Math.max(1, Math.round($('frameGrid').clientWidth / ($('frameGrid').children[0].offsetWidth + 6)));
      const [r0, c0] = [Math.floor(state.anchor / cols), state.anchor % cols];
      const [r1, c1] = [Math.floor(i / cols), i % cols];
      sel.clear();
      for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) if (r * cols + c < sec.nFrames) sel.add(r * cols + c);
    } else {
      sel.clear();
      for (let k = Math.min(state.anchor, i); k <= Math.max(state.anchor, i); k++) sel.add(k);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (sel.has(i)) sel.delete(i);
    else sel.add(i);
    state.anchor = i;
  } else {
    sel.clear();
    sel.add(i);
    state.anchor = i;
  }
  $('frameGrid').focus({ preventScroll: true });
  renderGridMarks();
}

function renderGridMarks() {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const grid = $('frameGrid');
  const rep = Array.from(wasm.replacement_map(JSON.stringify(sec.edits || {}), sec.nFrames));
  const flagged = new Set(sec.check && !sec.check.stale ? sec.check.flagged || [] : []);
  const redFlag = new Set();
  const patFlag = new Set();
  if (sec.check && sec.check.inside) {
    const seqT = sec.check.seq ? sec.check.seq.t : null;
    if (seqT) {
      for (const v of sec.check.inside) {
        if (v.kind !== 'red' && v.kind !== 'pattern') continue;
        for (let i = 0; i < seqT.length; i++) if (Math.min(v.onset, v.start) - 0.05 <= seqT[i] && seqT[i] <= v.end + 0.05) (v.kind === 'red' ? redFlag : patFlag).add(i);
      }
    }
  }
  const soft = new Set(sec.soften && sec.check && !sec.check.stale ? sec.check.soft_frames || [] : []);
  const softBlur = soft.size && sec.cache ? `blur(${((sec.check.soft_sigma || 1) * THUMB_W) / sec.cache.width()}px)` : '';
  for (let i = 0; i < grid.children.length; i++) {
    const tile = grid.children[i];
    const e = (sec.edits || {})[i] || {};
    tile.classList.toggle('removed', !!e.removed);
    tile.classList.toggle('extended', !!e.extended && !e.removed);
    tile.classList.toggle('selected', state.selection.has(i));
    tile.classList.toggle('flagged', flagged.has(i) && !redFlag.has(i) && !patFlag.has(i));
    tile.classList.toggle('flagged-red', redFlag.has(i));
    tile.classList.toggle('flagged-pat', patFlag.has(i) && !redFlag.has(i));
    tile.classList.toggle('soft', soft.has(i));
    tile.querySelector('canvas').style.filter = soft.has(i) ? softBlur : '';
    const fb = tile.querySelector('.fb');
    if (e.removed) {
      fb.textContent = `shows ${rep[i]}`;
      fb.classList.remove('hidden');
    } else if (e.extended) {
      fb.textContent = 'held 1 s';
      fb.classList.remove('hidden');
    } else fb.classList.add('hidden');
  }
}

function markSelection(key) {
  const sec = currentSection();
  if (!sec || !sec.prepared || !state.selection.size) return;
  sec.edits = sec.edits || {};
  for (const i of state.selection) {
    if (key === 'U') delete sec.edits[i];
    else if (key === 'E') sec.edits[i] = { removed: false, extended: true, fill: 'prev' };
    else sec.edits[i] = { removed: true, extended: false, fill: key === 'F' ? 'next' : 'prev' };
  }
  afterEdit(sec);
}

function afterEdit(sec) {
  if (sec.check) sec.check.stale = true;
  state.project.invalidateNeighbours(sec, wasm.context_seconds(state.config));
  state.project.save();
  renderGridMarks();
  renderVerdict(sec);
  renderSectionList();
  drawChart();
  if ($('autoCheck').checked) scheduleCheck(120);
}

// ---- checking -------------------------------------------------------------------------

function scheduleCheck(delay, announce = false) {
  clearTimeout(state.checkTimer);
  state.checkTimer = setTimeout(() => runCheck(announce), delay);
}

async function runCheck(announce) {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  if (state.checkRunning) {
    state.checkAgain = true;
    return;
  }
  state.checkRunning = true;
  const v = $('wsVerdict');
  v.className = 'verdict';
  v.textContent = 'checking…';
  const t0 = performance.now();
  try {
    const c = await checkSection(state.env, state.project, sec, null, { extS: EXT_S });
    sec.check = c;
    sec.checkMs = performance.now() - t0;
    if (announce) toast(`${c.safe ? 'Passes' : 'Fails'} (${c.frames} frames checked in ${(sec.checkMs / 1000).toFixed(2)} s)`);
  } catch (e) {
    console.error(e);
    banner(`Check failed: ${e.message || e}`);
  } finally {
    state.checkRunning = false;
  }
  await state.project.save();
  renderVerdict(sec);
  renderGridMarks();
  renderSectionList();
  drawTimeline();
  drawChart();
  if (state.checkAgain) {
    state.checkAgain = false;
    scheduleCheck(0);
  }
}

async function doPrepare(sec) {
  if (!sec) return;
  if (!state.decode.supported) return banner(`Preparing needs WebCodecs to decode ${state.movie.video.codec}: ${state.decode.reason}`);
  state.project.evictCaches(sec, CACHE_BUDGET);
  const ok = await runJob(`Preparing section #${sec.id}`, async (progress, cancelled) => {
    await prepareSection(state.env, state.movie, sec, { cancel: cancelled, onProgress: (n) => progress(Math.min(0.95, n / Math.max(1, (sec.end - sec.start + 2 * wasm.context_seconds(state.config)) * state.movie.fps)), `${n} frames decoded`) });
    return true;
  });
  if (!ok) return;
  sec.check = null;
  await state.project.save();
  renderAll();
  updateStatus();
  if (state.current === sec.id) scheduleCheck(0);
}

async function doSuggest(prefer) {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const only = $('suggestSelOnly').checked && state.selection.size ? Array.from(state.selection) : null;
  const res = await runJob(`Suggesting (keep ${prefer})`, async (progress) => suggestEdits(state.env, state.project, sec, prefer, only, { extS: EXT_S, onProgress: (r) => progress(0.2 + r * 0.15, `round ${r + 1}`) }));
  if (!res) return;
  sec.edits = JSON.parse(wasm.apply_suggestion(JSON.stringify(sec.edits || {}), JSON.stringify(res.edits), only ? JSON.stringify(only) : undefined));
  sec.check = res.verdict || null;
  state.project.invalidateNeighbours(sec, wasm.context_seconds(state.config));
  await state.project.save();
  renderAll();
  toast(res.note, 6000);
}

async function doSuggestFps() {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const only = $('suggestSelOnly').checked && state.selection.size ? Array.from(state.selection) : null;
  const v = parseFloat($('fpsInput').value);
  const fps = v > 0 ? v : null;
  const res = await runJob('Thinning to a frame rate', async () => suggestFrameRate(state.env, state.project, sec, only, fps, { extS: EXT_S }));
  if (!res) return;
  sec.edits = JSON.parse(wasm.apply_suggestion(JSON.stringify(sec.edits || {}), JSON.stringify(res.edits), only ? JSON.stringify(only) : undefined));
  sec.check = res.verdict || null;
  state.project.invalidateNeighbours(sec, wasm.context_seconds(state.config));
  await state.project.save();
  renderAll();
  toast(res.note, 7000);
}

// ---- chart -------------------------------------------------------------------------------

function drawChart() {
  const c = $('chart');
  const sec = currentSection();
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth;
  const H = c.clientHeight;
  if (c.width !== Math.round(W * dpr)) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!sec || !sec.prepared || !sec.check || !sec.check.stats || !sec.check.stats.t.length) {
    $('chartHint').textContent = sec ? 'The chart appears once the section has been checked.' : 'Open a section to see its brightness and flash area per frame.';
    return;
  }
  const st = sec.check.stats;
  const n = st.t.length;
  const thresh = sec.check.area_thresh || 1;
  const mid = H * 0.62;
  const bw = W / n;
  $('chartHint').textContent = 'Brightness (line) and how much of the window is changing (bars: brightening up, darkening down, magenta for red, orange when the flash rate is over the limit). The teal line is how much of the picture is a stripe pattern. Red shading is removed, blue is held. Click to jump to a frame.';
  for (let i = 0; i < n; i++) {
    const e = (sec.edits || {})[i] || {};
    if (e.removed) {
      g.fillStyle = 'rgba(224,80,63,.22)';
      g.fillRect(i * bw, 0, bw + 0.5, H);
    } else if (e.extended) {
      g.fillStyle = 'rgba(79,140,255,.22)';
      g.fillRect(i * bw, 0, bw + 0.5, H);
    }
    if (sec.check.flagged && sec.check.flagged.includes(i)) {
      g.fillStyle = 'rgba(232,163,60,.12)';
      g.fillRect(i * bw, 0, bw + 0.5, H);
    }
  }
  const scale = (H * 0.36) / (thresh * 1.5);
  for (let i = 0; i < n; i++) {
    const x = i * bw;
    const up = st.up[i] * scale;
    const dn = st.down[i] * scale;
    g.fillStyle = st.hazard[i] >= thresh ? '#e8a33c' : 'rgba(232,163,60,.5)';
    g.fillRect(x, mid - up, Math.max(1, bw - 0.5), up);
    g.fillRect(x, mid, Math.max(1, bw - 0.5), dn);
    const red = st.red[i] * scale;
    if (red > 0) {
      g.fillStyle = st.hazardRed[i] >= thresh ? '#e04fb0' : 'rgba(224,79,176,.6)';
      g.fillRect(x, mid - red, Math.max(1, bw - 0.5), red);
    }
  }
  g.strokeStyle = 'rgba(255,255,255,.35)';
  g.beginPath();
  g.moveTo(0, mid - thresh * scale);
  g.lineTo(W, mid - thresh * scale);
  g.moveTo(0, mid + thresh * scale);
  g.lineTo(W, mid + thresh * scale);
  g.stroke();
  g.strokeStyle = '#e6e8ee';
  g.lineWidth = 1.2;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const y = H * 0.55 - st.lum[i] * H * 0.5;
    if (i === 0) g.moveTo(i * bw + bw / 2, y);
    else g.lineTo(i * bw + bw / 2, y);
  }
  g.stroke();
  if (st.pattern && st.pattern.length === n && sec.check.pattern_thresh) {
    const pt = sec.check.pattern_thresh;
    g.strokeStyle = PATTERN_COLOUR;
    g.lineWidth = 1.2;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const y = H * 0.98 - Math.min(1.5, st.pattern[i] / pt) * H * 0.3;
      if (i === 0) g.moveTo(i * bw + bw / 2, y);
      else g.lineTo(i * bw + bw / 2, y);
    }
    g.stroke();
  }
  for (const i of state.selection) {
    g.fillStyle = 'rgba(255,216,79,.35)';
    g.fillRect(i * bw, 0, bw + 0.5, H);
  }
}

// ---- export ----------------------------------------------------------------------------

async function openExport() {
  const p = state.project;
  if (!p) return;
  const rows = p.sectionsSorted().map((s) => {
    const marks = Object.values(s.edits || {}).filter((e) => e.removed || e.extended).length;
    const status = !s.prepared ? (marks ? 'has marks but is not prepared: marks will NOT be applied' : 'unprepared (nothing to apply)') : s.check && !s.check.stale ? (s.check.safe ? 'passes' : 'still failing') : 'unchecked';
    return `<tr><td>#${s.id}</td><td>${fmt(s.start)} – ${fmt(s.end)}</td><td>${marks} marks</td><td>${status}</td></tr>`;
  });
  $('exportSummary').innerHTML = rows.length ? `<table><tr><th>section</th><th>range</th><th>edits</th><th>status</th></tr>${rows.join('')}</table>` : '<p class="hint">No sections. The export re-encodes the video unchanged.</p>';
  const sel = $('exportCodec');
  sel.innerHTML = '';
  const cands = await encoderCandidates(state.movie.width, state.movie.height, state.movie.fps, +$('exportQuality').value);
  for (const c of cands) {
    const o = document.createElement('option');
    o.value = c.label;
    o.textContent = `${c.label} (${c.config.codec})`;
    sel.appendChild(o);
  }
  const softened = p.sectionsSorted().filter((s) => s.soften && s.prepared && softenPlan(s));
  $('exportPlan').textContent = cands.length
    ? `The whole video is decoded and re-encoded in the browser${state.movie.audio ? '; audio is copied without re-encoding' : ''}.${softened.length ? ` Section${softened.length === 1 ? '' : 's'} ${softened.map((s) => '#' + s.id).join(', ')} ${softened.length === 1 ? 'is' : 'are'} softened (blurred) where stripes were found.` : ''} ${window.showSaveFilePicker ? 'You will be asked where to save it.' : 'The file is assembled in memory and offered for download.'}`
    : 'This browser has no WebCodecs video encoder, so it cannot export.';
  $('btnDoExport').disabled = !cands.length || !state.decode.supported;
  $('exportResult').innerHTML = '';
  $('exportDownload').classList.add('hidden');
  $('btnVerifyExport').disabled = !state.exportBlob;
  $('exportModal').classList.remove('hidden');
}

async function doExport() {
  const movie = state.movie;
  let sinkInfo = await pickSaveSink(movie.name.replace(/\.[^.]+$/, '') + '.unflashed.mp4');
  if (sinkInfo && sinkInfo.cancelled) return;
  $('exportModal').classList.add('hidden');
  const res = await runJob('Exporting', async (progress, cancelled) =>
    exportMovie(state.env, movie, state.project, {
      encoder: $('exportCodec').value,
      quality: +$('exportQuality').value,
      extS: EXT_S,
      sink: sinkInfo ? sinkInfo.sink : null,
      cancel: cancelled,
      onProgress: (p, frames, ms) => progress(p, `${frames} frames encoded · ${(frames / (ms / 1000)).toFixed(0)} fps`),
    })
  );
  $('exportModal').classList.remove('hidden');
  if (!res) return;
  const lines = [`Exported ${res.frames} frames with ${res.encoderLabel} (${res.codec}) in ${(res.elapsedMs / 1000).toFixed(1)} s${res.softened ? `, ${res.softened} of them softened` : ''}.`, ...res.warnings];
  $('exportResult').innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
  if (res.blob) {
    state.exportBlob = res.blob;
    const a = $('exportDownload');
    if (a.href) URL.revokeObjectURL(a.href);
    a.href = URL.createObjectURL(res.blob);
    a.download = movie.name.replace(/\.[^.]+$/, '') + '.unflashed.mp4';
    a.classList.remove('hidden');
    $('btnVerifyExport').disabled = false;
  } else if (sinkInfo && sinkInfo.handle) {
    try {
      state.exportBlob = await sinkInfo.handle.getFile();
      $('btnVerifyExport').disabled = false;
    } catch (e) {
      /* no read access */
    }
  }
}

async function verifyExport() {
  if (!state.exportBlob) return;
  $('exportModal').classList.add('hidden');
  const res = await runJob('Verifying the exported file', async (progress, cancelled) => {
    const m = await Movie.open(state.exportBlob, wasm);
    const feeder = await createDetector(wasm, state.config, m.width, m.height, { preferGpu: preferGpuSetting() });
    try {
      return await scanMovie({ wasm, config: state.config, feeder }, m, { cancel: cancelled, onProgress: (p, _t, count, ms) => progress(p, `${count} frames · ${(count / (ms / 1000)).toFixed(0)} fps`) });
    } finally {
      feeder.det.free();
    }
  });
  $('exportModal').classList.remove('hidden');
  if (!res) return;
  const v = res.result.violations;
  const wcagBad = v.filter((x) => x.kind === 'flash' || x.kind === 'red');
  const ext = v.filter((x) => x.kind === 'extended');
  const pat = v.filter((x) => x.kind === 'pattern');
  let msg = wcagBad.length ? `<b>Fails WCAG:</b> ${wcagBad.length} violation${wcagBad.length === 1 ? '' : 's'}: ` + wcagBad.slice(0, 8).map((x) => `${x.kind} ${fmt(x.start)}–${fmt(x.end)}`).join(', ') : '<b>Passes WCAG.</b>';
  if (ext.length && res.result.flag_extended) msg += ` ${ext.length} extended flash${ext.length === 1 ? '' : 'es'} remain${ext.length === 1 ? 's' : ''}: ` + ext.slice(0, 8).map((x) => `${fmt(x.start)}–${fmt(x.end)}`).join(', ');
  if (res.result.flag_patterns) {
    if (pat.length) msg += ` ${pat.length} hazardous stripe pattern${pat.length === 1 ? '' : 's'} remain${pat.length === 1 ? 's' : ''}: ` + pat.slice(0, 8).map((x) => `${fmt(x.start)}–${fmt(x.end)}`).join(', ');
    else msg += ' No hazardous stripe patterns.';
  }
  $('exportResult').innerHTML += `<p>${msg} (${res.frames} frames re-scanned in ${(res.elapsedMs / 1000).toFixed(1)} s)</p>`;
}

// a small surface for tests and debugging
window.__unflash = {
  get state() {
    return state;
  },
  get lastScan() {
    return state.lastScan;
  },
  currentSection,
  softenPlan,
  openClip,
};

boot().catch((e) => {
  console.error(e);
  banner(`Unflash could not start: ${e.message || e}`);
});
