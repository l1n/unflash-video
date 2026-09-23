// Unflash web app: wiring between the WASM detector, WebCodecs and the UI.

import init, * as wasm from './pkg/unflash.js';
import { defaultWorkerCount, SoftwarePool } from './h264pool.js';
import { builtInFor } from './codecs.js';
import { Movie, tick } from './media.js';
import { createDetector, gpuAdapter } from './detector.js';
import { profile } from './profile.js';
import { scanMovie, scanChunks, CHUNK_S, prepareSection, checkSection, suggestEdits, suggestFrameRate, searchFrameRate, suggestBlend, rateLadder, keepJson, shownPts, softenPlan, blendMarks, blendStrength, blendedFrames, BLEND_DEFAULT } from './analysis.js';
import { Project, projectKey, dropCaches, lastSavedAt, projectFileText, readProjectFile, matchVideo } from './project.js';
import { exportMovie, exportPlan, encoderCandidates, formatChoices, formatInfo, pickSaveSink, privateFileSink, privateStorageAvailable, discardPrivateExport, estimateExportBytes } from './export.js';
import { SectionPlayer } from './preview.js';
import { SectionSound } from './sound.js';
import { FrameViewer } from './viewer.js';
import { loadAlertSettings, saveAlertSettings, beep, askNotifyPermission, notifyState, systemNotify, titleProgress, titleMark } from './alerts.js';
import { loadChangelog, changesSeen, markChangesSeen, hadEarlierSettings, changesSince, newestChange, renderDay } from './changes.js';
import { TourGuide, TOURS } from './tours.js';
import { watchPage, noteError, noteJob, noteFileName, debugReport } from './debug.js';

const $ = (id) => document.getElementById(id);
const EXT_S = 1.0;

/**
 * Bytes of decoded section frames kept in memory (older sections are dropped
 * and re-prepared when opened again): a share of the device's memory where
 * the browser says how much there is, a quarter of a gigabyte otherwise.
 */
function cacheBudget() {
  const gb = navigator.deviceMemory || 4;
  return Math.min(700, Math.max(192, gb * 64)) * 1024 * 1024;
}

/** The largest export worth assembling in memory when no disk sink is available. */
function memoryExportLimit() {
  const gb = navigator.deviceMemory || 4;
  return Math.min(1, gb / 4) * 1024 * 1024 * 1024;
}

function fmtBytes(b) {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
}

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
  live: { on: false, fromScan: false, t: [], hazard: [], hazardRed: [], pattern: [], violations: 0, lastCheck: 0 },
  decode: { supported: false, reason: '' },
  exportBlob: null,
  checkTimer: null,
  checkRunning: false,
  checkAgain: false,
  scanTrace: null,
  // a running scan's own: { violations: what it has found so far (chunked
  // scans), partials: when }, else null
  scanning: null,
  traceNorm: null, // the scan trace as area fractions, for the timeline and the monitor
  auto: null, // the unattended scan -> fix -> export -> verify run (see autopilot)
  // what the player shows: 'video' (the whole file) or the open section, 'edited' or 'original';
  // gen counts requests to it, so a poster that was overtaken never draws
  player: { mode: 'video', lastDraw: 0, gen: 0, playingTile: null, restartTimer: null },
  history: new Map(), // section id -> { undo: [], redo: [] } of mark snapshots
  // seconds of the whole video the chart shows around the playhead (0: all of it)
  chartSpan: 30,
  changes: null, // what's new: { log, newest, seen } (see initChanges)
};

let sectionPlayer = null;
const sectionSound = new SectionSound();

// read before this visit writes settings of its own: were they here already?
const EARLIER_SETTINGS = hadEarlierSettings();
watchPage();

// ---- small helpers -----------------------------------------------------------

function fmt(t) {
  return wasm.format_time(t);
}

function toast(msg, ms = 3500) {
  const el = $('toast');
  if (chain.active) chain.toast = msg;
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

// Checks, scans, prepares and suggestions all feed the one detector, and a
// check the UI schedules is not a job: everything that touches the feeder is
// serialised here.
let feederLock = Promise.resolve();
function withFeeder(fn) {
  const run = feederLock.then(fn, fn);
  feederLock = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Whether a job is under way, telling the visitor so (`then`: what they
 * wanted, to do once it is over). Asked before anything is changed: a start
 * that runJob turns away must leave the running job's state alone.
 */
function busy(then) {
  if (!state.job) return false;
  toast(`${state.job.name} is under way: ${then} once it has finished (or cancel it).`, 6000);
  return true;
}

async function runJob(name, fn) {
  if (state.job) {
    toast('Another job is running');
    return null;
  }
  const job = { name, cancelled: false, t0: performance.now(), pct: 0 };
  state.job = job;
  const ended = noteJob(name);
  chainStart(name);
  $('jobName').textContent = name;
  $('jobBar').style.width = '0%';
  $('jobMsg').textContent = '';
  $('jobbar').classList.remove('hidden');
  let shownPct = -1;
  let shownAt = 0;
  const progress = (p, msg) => {
    const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
    job.pct = pct;
    // a long scan reports thousands of times: the page shows ten a second
    const now = performance.now();
    if (pct === shownPct && now - shownAt < 100) return;
    shownAt = now;
    $('jobBar').style.width = `${pct}%`;
    if (msg !== undefined) $('jobMsg').textContent = msg;
    // the tab's title too, to be seen from another tab
    if (pct !== shownPct) {
      shownPct = pct;
      titleProgress(`${pct}% · ${name} · Unflash`);
    }
  };
  titleProgress(`${name} · Unflash`);
  let outcome = 'ok';
  let message = '';
  try {
    return await withFeeder(() => fn(progress, () => job.cancelled));
  } catch (e) {
    if (job.cancelled) {
      outcome = 'cancelled';
      toast(`${name}: cancelled`);
      return null;
    }
    console.error(e);
    outcome = 'failed';
    message = `${name} failed: ${e && e.message ? e.message : e}`;
    noteError(message);
    banner(message);
    return null;
  } finally {
    state.job = null;
    state.jobEndedAt = performance.now();
    $('jobbar').classList.add('hidden');
    titleProgress('');
    ended(job.cancelled ? 'cancelled' : outcome);
    chainEnd(job.cancelled ? 'cancelled' : outcome, message);
  }
}

// ---- telling someone who looked away that the wait is over ----------------------
//
// Jobs that follow one another (opening then scanning; every stage of an
// auto-fix run) are one wait: the beep and the notification come once, when
// no further job has started a moment after the last one ended, and only if
// the whole wait took longer than the setting.

let alertSettings = loadAlertSettings();
const CHAIN_GRACE_MS = 1500;
const chain = { active: false, start: 0, end: 0, names: [], ok: true, cancelled: false, error: '', toast: '', timer: null };

function chainStart(name) {
  clearTimeout(chain.timer);
  if (!chain.active) Object.assign(chain, { active: true, start: performance.now(), names: [], ok: true, cancelled: false, error: '', toast: '' });
  chain.names.push(name);
}

function chainEnd(outcome, message) {
  if (!chain.active) return;
  if (outcome === 'failed') {
    chain.ok = false;
    chain.error = message;
  } else if (outcome === 'cancelled') chain.cancelled = true;
  chain.end = performance.now();
  clearTimeout(chain.timer);
  chain.timer = setTimeout(finishChain, CHAIN_GRACE_MS);
}

function fmtWait(secs) {
  if (secs < 90) return `${Math.round(secs)} s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m < 60 ? `${m} min ${s} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function finishChain() {
  // an auto-fix run ends its own wait (its stages come with gaps)
  if (!chain.active || state.job || (state.auto && state.auto.running)) return;
  chain.active = false;
  const secs = (chain.end - chain.start) / 1000;
  // stopped by hand: whoever stopped it is looking
  if (chain.cancelled && chain.ok) return;
  if (secs < alertSettings.after) return;
  const last = chain.names[chain.names.length - 1] || 'job';
  const autoSummary = state.auto && state.auto.summary;
  const title = chain.ok ? `Unflash: ${chain.names.length > 1 ? chain.names.join(', then ').toLowerCase() : last.toLowerCase()} done` : `Unflash: ${last.toLowerCase()} failed`;
  const body = (chain.ok ? autoSummary || chain.toast || `Finished after ${fmtWait(secs)}.` : chain.error) + (chain.ok ? ` (${fmtWait(secs)})` : '');
  const alert = { title, body, secs, ok: chain.ok, beeped: false, notified: false };
  state.lastAlert = alert;
  titleMark(chain.ok);
  if (alertSettings.notify && (document.hidden || !document.hasFocus())) alert.notified = systemNotify(title, body);
  if (alertSettings.beep) alert.beeped = await beep(chain.ok);
}

function renderAlertNote() {
  const parts = ['While a job runs, the tab title shows how far it has got; one that ends while you are in another tab leaves a ✓ (or ✗) there.'];
  const st = notifyState();
  if (st === 'denied') parts.push('Notifications from this page are blocked in the browser; allow them in its site settings to have them.');
  else if (st === 'unsupported') parts.push('This browser has no system notifications.');
  $('alertNote').textContent = parts.join(' ');
}

function wireAlerts() {
  $('alertBeep').checked = alertSettings.beep;
  $('alertAfter').value = alertSettings.after;
  $('alertNotify').checked = alertSettings.notify && notifyState() === 'granted';
  const save = () => {
    saveAlertSettings(alertSettings);
    renderAlertNote();
  };
  $('btnAlerts').addEventListener('click', (e) => {
    e.stopPropagation();
    renderAlertNote();
    $('alertsMenu').classList.toggle('hidden');
  });
  $('alertsMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => $('alertsMenu').classList.add('hidden'));
  $('alertBeep').addEventListener('change', () => {
    alertSettings.beep = $('alertBeep').checked;
    save();
  });
  $('alertAfter').addEventListener('change', () => {
    const v = parseFloat($('alertAfter').value);
    alertSettings.after = Number.isFinite(v) && v >= 0 ? v : 60;
    $('alertAfter').value = alertSettings.after;
    save();
  });
  $('alertNotify').addEventListener('change', async () => {
    if ($('alertNotify').checked && (await askNotifyPermission()) !== 'granted') $('alertNotify').checked = false;
    alertSettings.notify = $('alertNotify').checked;
    save();
  });
  $('btnAlertTest').addEventListener('click', () => beep(true));
  renderAlertNote();
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

// The page's colours and type, for the canvases: style.css keeps them
// (:root), so the timeline and the charts draw in the same palette as the
// rest of the page.
const ink = (() => {
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue(`--${k}`).trim();
  const out = {};
  for (const k of ['bg', 'line2', 'fg', 'fg2', 'flash', 'red', 'pat', 'ext', 'held', 'blend', 'sel', 'ok', 'bad']) out[k] = v(k);
  const mono = v('mono');
  out.font = (px) => `${px}px ${mono}`;
  return out;
})();
/** Colour `hex` (#rrggbb) at opacity `a`. */
function tint(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
/** A violation's or a section's colour, by its kind. */
const kindInk = (kind) => ({ flash: ink.flash, red: ink.red, extended: ink.ext, pattern: ink.pat })[kind] || ink.fg2;

/** `?cpu=1` forces the WebAssembly detector (for comparison and tests). */
function preferGpuSetting() {
  return !new URLSearchParams(location.search).has('cpu');
}

/**
 * `?extsrc=canvas` (or `videoframe,video`, or `none`) pretends the browser's
 * WebGPU accepts only those kinds of picture as copy sources, to exercise
 * the routes other browsers need (Firefox: canvas only).
 */
function externalSourcesSetting() {
  const v = new URLSearchParams(location.search).get('extsrc');
  if (v === null) return null;
  return v === 'none' ? [] : v.split(',');
}

/** `?route=yuv` (videoframe, yuv, rgba, canvas or pixels) forces one way of feeding pictures to the detector. */
function routeSetting() {
  return new URLSearchParams(location.search).get('route');
}

// ---- what's new ----------------------------------------------------------------
//
// The changes since this browser was last here, from CHANGELOG.md: a card on
// the start page and a dot on the header's button until they are seen, the
// whole list behind the button.

/** Changes the start page's card lists; the rest are behind "everything that changed". */
const NEWS_SHOWN = 6;

/**
 * Load the changelog and work out what this browser has not seen. One that
 * has never been shown it is taken to have been here when it last saved a
 * project, or, with only earlier settings to show for a visit, to have
 * missed it all; a first visit is shown nothing and starts from here.
 */
async function initChanges() {
  let log;
  try {
    log = await loadChangelog();
  } catch (e) {
    console.warn('no changelog', e);
    return;
  }
  const newest = newestChange(log);
  if (!newest) return;
  let seen = changesSeen();
  if (seen === null) {
    let last = 0;
    try {
      last = await lastSavedAt();
    } catch (e) {
      /* no storage */
    }
    if (last) seen = last;
    else if (EARLIER_SETTINGS) seen = 0;
    else {
      seen = newest;
      markChangesSeen(newest);
      state.firstVisit = true;
    }
  }
  state.changes = { log, newest, seen };
  renderChanges();
  // the tours: getting started on a first visit, the new things' own after an update
  const fresh = changesSince(log, seen).flatMap((d) => d.items.map((it) => it.tour).filter(Boolean));
  tourGuide.plan({ firstVisit: !!state.firstVisit, tours: fresh });
}

// ---- the guided tour ------------------------------------------------------------
//
// tours.js says what each tour shows and when; here is where the app is (a
// video open, a section ready) and whether it is busy.

/** `?tour=0` never starts a tour by itself, `?tour=1` does even in an automated browser (tests). */
function tourAutoSetting() {
  const q = new URLSearchParams(location.search).get('tour');
  if (q === '0' || q === 'off') return false;
  if (q === '1' || q === 'on') return true;
  return !navigator.webdriver;
}

/** The last click, key or scroll (ms), and whether a button is down: a tour waits for a quiet moment. */
const input = { at: 0, down: false };

const tourGuide = new TourGuide({
  auto: tourAutoSetting(),
  // (`byHand`: as it will be once the guide is put away for the tour; a
  // video's part waits for its scan unless it is asked for)
  where: (byHand = false) => {
    const guide = !byHand && document.body.classList.contains('guide-open');
    const sec = currentSection();
    return {
      any: true,
      start: !state.movie,
      video: !!state.movie && !guide && (byHand || !!(state.project && state.project.scan)),
      section: !!(sec && sec.prepared && !guide && !$('wsBody').classList.contains('hidden') && /passes|fails/.test($('wsVerdict').textContent)),
    };
  },
  quiet: () =>
    !state.job &&
    // (a job that ends is often followed by another: opening, then scanning)
    performance.now() - (state.jobEndedAt || 0) > CHAIN_GRACE_MS &&
    !(state.auto && state.auto.running) &&
    !input.down &&
    performance.now() - input.at > 1500 &&
    document.visibilityState === 'visible' &&
    ![...document.querySelectorAll('.modal, .viewer, .menu')].some((m) => !m.classList.contains('hidden')),
  ready: (context) => {
    if (context !== 'start' && context !== 'any' && state.movie) setGuide(false);
  },
});

function wireTours() {
  window.addEventListener('pointerdown', () => Object.assign(input, { at: performance.now(), down: true }), true);
  window.addEventListener('pointerup', () => Object.assign(input, { at: performance.now(), down: false }), true);
  window.addEventListener('keydown', () => (input.at = performance.now()), true);
  window.addEventListener('wheel', () => (input.at = performance.now()), { capture: true, passive: true });
  $('btnTour').addEventListener('click', () => tourGuide.gettingStarted());
  // "show me" beside a change in What's new
  for (const box of [$('newsList'), $('changesList')]) {
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.show-me');
      if (!b) return;
      closeChanges();
      if (tourGuide.request(b.dataset.tour)) return;
      const t = TOURS[b.dataset.tour];
      toast(`${t && t.context === 'section' ? 'Open a section of a video' : 'Open a video'} and the tour of this starts.`);
    });
  }
}

function renderChanges() {
  const c = state.changes;
  if (!c) return;
  const fresh = changesSince(c.log, c.seen);
  const count = fresh.reduce((a, d) => a + d.items.length, 0);
  $('changesDot').classList.toggle('hidden', !count);
  $('btnChanges').title = count ? `What has changed in Unflash: ${count} change${count === 1 ? '' : 's'} since you were last here` : 'What has changed in Unflash, newest first';
  $('newsCard').classList.toggle('hidden', !count);
  if (!count) return;
  const days = [];
  let left = NEWS_SHOWN;
  for (const d of fresh) {
    if (left <= 0) break;
    days.push({ ...d, items: d.items.slice(0, left) });
    left -= d.items.length;
  }
  const more = count - Math.min(count, NEWS_SHOWN);
  $('newsList').innerHTML = days.map((d) => renderDay(d)).join('') + (more ? `<p class="news-more">…and ${more} more.</p>` : '');
}

/** The changes so far count as seen: the card and the dot go until there are new ones. */
function changesAcknowledged() {
  const c = state.changes;
  if (!c) return;
  c.seen = c.newest;
  markChangesSeen(c.newest);
  renderChanges();
}

function openChanges() {
  const c = state.changes;
  if (!c) return toast('The list of changes could not be loaded');
  const seen = c.seen;
  $('changesList').innerHTML = c.log.days.map((d) => renderDay(d, (it) => it.at > seen)).join('');
  $('changesModal').classList.remove('hidden');
  $('changesList').scrollTop = 0;
  changesAcknowledged();
}

function closeChanges() {
  $('changesModal').classList.add('hidden');
}

// ---- debug info --------------------------------------------------------------------

function makeDebugReport() {
  return debugReport({ version: wasm.version(), state, profile, gpu: gpuAdapter, segments: scanSegments(), hybrid: state.env ? hybridPlan(state.movie, state.env.feeder) : null });
}

/** The report in a dialog, copied to the clipboard at once where the browser lets it. */
function openDebug() {
  const text = makeDebugReport();
  $('debugText').value = text;
  const save = $('btnDebugSave');
  if (save.href.startsWith('blob:')) URL.revokeObjectURL(save.href);
  save.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
  $('debugNote').textContent = 'What this browser, its GPU and the open video are, and how long each job took. Paste it into a message to whoever is helping you; it names no files.';
  $('debugModal').classList.remove('hidden');
  copyDebug(text);
}

function copyDebug(text) {
  const note = $('debugNote');
  const manual = () => {
    const t = $('debugText');
    t.focus();
    t.select();
    note.textContent = `Select the text below and copy it (${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+C), or save it as a file, and paste it into a message to whoever is helping you. It names no files.`;
  };
  if (!navigator.clipboard || !navigator.clipboard.writeText) return manual();
  navigator.clipboard.writeText(text).then(
    () => {
      note.textContent = 'Copied: paste it into a message to whoever is helping you. It names no files.';
    },
    () => manual()
  );
}

function closeDebug() {
  $('debugModal').classList.add('hidden');
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
  // a file dropped anywhere on the page opens like one picked with the button
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    openFile(f);
  });
  // the guide: the start page until a file is open, then a drawer beside the
  // work that the same button, its close button or Esc put away again
  $('btnHome').addEventListener('click', () => {
    if (!state.movie) return $('welcome').scrollTo(0, 0);
    setGuide(!document.body.classList.contains('guide-open'));
  });
  $('btnCloseGuide').addEventListener('click', () => setGuide(false));
  $('btnChanges').addEventListener('click', openChanges);
  $('btnNewsAll').addEventListener('click', openChanges);
  $('btnNewsSeen').addEventListener('click', changesAcknowledged);
  $('btnCloseChanges').addEventListener('click', closeChanges);
  wireTours();
  $('changesModal').addEventListener('click', (e) => {
    if (e.target === $('changesModal')) closeChanges();
  });
  $('btnDebug').addEventListener('click', openDebug);
  $('btnDebugCopy').addEventListener('click', () => copyDebug($('debugText').value));
  $('btnCloseDebug').addEventListener('click', closeDebug);
  $('debugModal').addEventListener('click', (e) => {
    if (e.target === $('debugModal')) closeDebug();
  });
  initChanges();
  $('btnCloseBanner').addEventListener('click', () => $('banner').classList.add('hidden'));
  $('btnCancelJob').addEventListener('click', () => {
    if (state.job) state.job.cancelled = true;
  });
  $('profileSel').addEventListener('change', () => setProfile($('profileSel').value));
  $('btnScan').addEventListener('click', scan);
  $('autoToggle').checked = initialAutoSetting();
  $('autoToggle').addEventListener('change', () => {
    try {
      localStorage.setItem('unflash:auto', $('autoToggle').checked ? '1' : '0');
    } catch (e) {
      /* storage blocked: the choice lasts the session */
    }
    // ticked with a file open: the run starts, once whatever job is under way (the scan, say) is done
    if ($('autoToggle').checked && state.movie && !(state.auto && state.auto.running)) {
      afterJobs().then(() => {
        if ($('autoToggle').checked && state.movie && !(state.auto && state.auto.running)) autopilot();
      });
    }
  });
  $('btnAutoStop').addEventListener('click', () => stopAuto());
  $('btnAutoRerun').addEventListener('click', () => autopilot({ rescan: true }));
  $('liveToggle').addEventListener('change', () => setLive($('liveToggle').checked));
  $('dimToggle').addEventListener('change', () => {
    applyDim();
    renderPlayerWarning();
  });
  applyDim();
  wirePlayer();
  $('btnExport').addEventListener('click', openExport);
  wireProjectMenu();
  $('btnCloseExport').addEventListener('click', () => $('exportModal').classList.add('hidden'));
  $('btnDoExport').addEventListener('click', doExport);
  $('btnVerifyExport').addEventListener('click', verifyExport);
  $('exportQuality').addEventListener('input', () => ($('exportQualityText').textContent = $('exportQuality').value));
  $('exportQuality').addEventListener('change', () => state.movie && renderExportChoice());
  $('exportCodec').addEventListener('change', () => renderExportChoice());
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
  wireAlerts();
  window.addEventListener('resize', () => {
    drawTimeline();
    drawChart();
  });
  const player = $('player');
  player.addEventListener('timeupdate', () => {
    drawTimeline();
    if (chartMode() === 'video') drawChart();
  });
  player.addEventListener('play', () => {
    if (state.live.on && state.player.mode === 'video') startLiveLoop();
  });
  player.addEventListener('seeked', () => {
    drawTimeline();
    if (chartMode() === 'video') drawChart();
    if (state.live.on && state.live.fromScan) monitorFromScan(player.currentTime);
  });
}

// ---- opening a file -------------------------------------------------------------

async function openFile(file) {
  // an unattended run gives way to the new file; a job started by hand is waited for
  await stopAuto();
  if (busy('open the video')) return;
  noteFileName(file.name);
  $('banner').classList.add('hidden');
  if (sectionPlayer) await sectionPlayer.stop();
  closeViewer();
  const opened = await runJob('Opening video', async (progress) => {
    progress(0.05, 'reading the index');
    const movie = await Movie.open(file, wasm, {
      // a Matroska file keeps no index: it is read through once
      onProgress: (p, container) => progress(0.05 + 0.3 * p, container === 'matroska' ? `reading through the file for its frames (MKV / WebM keep no index): ${Math.round(p * 100)}%` : 'reading the index'),
    });
    // the last file, its unattended run and its export go only now that
    // the new one has opened
    if (state.movie) state.movie.close();
    forgetExport();
    if (state.project) for (const s of state.project.sections) dropCaches(s);
    state.lastScan = null;
    state.scanTrace = null;
    state.traceNorm = null;
    state.movie = movie;
    movie.forceBuiltIn = builtInSetting();
    state.decode = await movie.decoderSupport();
    progress(0.4, 'starting the detector');
    const key = projectKey(file);
    const project = await Project.load(key, movie.bounds, movie.keyframes);
    state.project = project;
    if (project.scan && project.scan.trace) state.scanTrace = project.scan.trace;
    $('profileSel').value = project.profile;
    state.config = profileConfig(project.profile);
    await createFeeders(progress);
    movie.decodeInWorkers = decodeWorkersSetting(state.env.feeder);
    movie.shrinkInWorkers = shrinkSetting();
    loadPlayer(file, movie);
    $('videoInfo').textContent = `${file.name} · ${movie.width}×${movie.height} · ${movie.fps.toFixed(2)} fps · ${fmt(movie.duration)} · ${movie.video.codec}${movie.audio ? ' + ' + movie.audio.codec : ''}`;
    sectionSound.failed = null;
    renderSoundButton();
    $('btnScan').disabled = !state.decode.supported;
    $('btnScan').title = state.decode.supported ? 'Decode every frame with WebCodecs and run the detector over it' : `Scanning needs WebCodecs: ${state.decode.reason}`;
    $('liveToggle').disabled = false;
    $('btnExport').disabled = false;
    $('btnProject').disabled = false;
    document.body.classList.add('has-movie');
    setGuide(false);
    $('stage').classList.remove('hidden');
    $('sections').classList.remove('hidden');
    $('timelineWrap').classList.remove('hidden');
    if (!state.decode.supported) banner(`This browser cannot decode ${movie.video.codec} with WebCodecs (${state.decode.reason}). The live monitor still works while the player plays; scanning and section editing need a decodable file (H.264 in most browsers).`, 'info');
    else if (state.decode.software) {
      const info = movie.softwareInfo || {};
      const about = movie.builtIn.id === 'h264' ? ` (profile ${info.profile_idc}, level ${info.level_idc})` : info.summary ? ` (${info.summary})` : '';
      const why = movie.forceBuiltIn ? 'You asked for the built-in decoder' : `This browser cannot decode ${movie.video.codec} with WebCodecs`;
      banner(`${why}, so Unflash uses its built-in ${movie.builtIn.name} decoder${about} for scanning, sections and export, decoding in ${defaultWorkerCount()} parallel workers.${movie.forceBuiltIn ? '' : ' The player cannot play this file here, so the live monitor is off.'}`, 'info');
    }
    // the live monitor watches the player, which plays what the browser can decode
    $('liveToggle').disabled = !!state.decode.software && !movie.forceBuiltIn;
    state.current = null;
    state.history.clear();
    setPlayerSource('video');
    renderAll();
    updateStatus();
    return true;
  });
  if (opened && state.project.restoredFrom) {
    // the same name and size under another modified time: a copy, or the file downloaded again
    toast(`Restored the project saved for ${state.project.restoredFrom.split(':')[0]} (the same name and size) in this browser.`, 8000);
    state.project.save();
  }
  if (!opened || !state.decode.supported) return;
  // the scan starts on its own; the fixes, the export and its check too with auto-fix on
  if (autoEnabled()) autopilot();
  else if (autoScanEnabled()) autoScan();
}

/** Resolves when no job is running. */
async function afterJobs() {
  while (state.job) await new Promise((r) => setTimeout(r, 100));
}

/** Scan a freshly opened file, unless a scan of it under this profile is stored from a previous visit. */
async function autoScan() {
  const project = state.project;
  const prior = project && project.scan;
  if (prior && prior.sig === wasm.config_signature(state.config) && prior.profile === project.profile && (prior.safe || project.sections.length)) return;
  await scan();
}

/** Open or close the guide beside the work (with no file open it is the whole page). */
function setGuide(open) {
  document.body.classList.toggle('guide-open', !!open);
}

/** Open one of the test clips published next to the app. */
async function openClip(name) {
  // (an unattended run gives way to a new video: openFile stops it)
  if (!(state.auto && state.auto.running) && busy('open the clip')) return;
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
  if (state.env && state.env.spares) for (const f of state.env.spares) f.det.free();
  if (state.liveFeeder) state.liveFeeder.det.free();
  const preferGpu = preferGpuSetting();
  const externalSources = externalSourcesSetting();
  const route = routeSetting();
  const feeder = await createDetector(wasm, state.config, movie.width, movie.height, { preferGpu, externalSources, route });
  state.env = { wasm, config: state.config, feeder };
  const live = await createDetector(wasm, state.config, movie.width, movie.height, { preferGpu, externalSources, route, batch: 1 });
  state.liveFeeder = live;
  if (feeder.note) banner(feeder.note, 'info');
  if (progress) progress(0.8, `${feeder.backend} detector at ${feeder.aw}×${feeder.ah}`);
}

async function setProfile(name) {
  if (!state.project) return;
  await stopAuto();
  state.project.profile = name;
  state.config = profileConfig(name);
  await withFeeder(() => createFeeders());
  for (const s of state.project.sections) if (s.check) s.check.stale = true;
  await state.project.save();
  renderAll();
  updateStatus();
  toast('Profile changed. Sections need re-checking (they are re-checked when opened).');
  if (!state.decode.supported) return;
  if (autoEnabled()) autopilot({ rescan: true });
  else if (autoScanEnabled()) autoScan();
}

function updateStatus() {
  const parts = [];
  if (state.env) {
    const f = state.env.feeder;
    parts.push(`detector: <b>${f.backend === 'webgpu' ? 'WebGPU' : 'CPU (WASM)'}</b> at ${f.aw}×${f.ah} (window ${f.det.window_width()}×${f.det.window_height()}, area ≥ ${f.det.area_thresh()} px)`);
    if (state.decode.software) parts.push(`decoder: <b>built-in ${state.movie.builtIn.name}</b> (${state.movie.forceBuiltIn ? 'asked for' : 'no WebCodecs decoder for this codec'})`);
    else if (state.movie && state.movie.decodeInWorkers) parts.push('decoder: WebCodecs <b>in workers</b> (this WebGPU takes no decoded frame, so pictures are copied out of the decoder off the page)');
    if (state.lastScan) {
      const s = state.lastScan;
      const fps = (s.frames / (s.elapsedMs / 1000)).toFixed(0);
      const gbs = ((f.det.bytes_per_frame() * (s.frames / (s.elapsedMs / 1000))) / 1e9).toFixed(2);
      parts.push(`last scan: ${s.frames} frames in ${(s.elapsedMs / 1000).toFixed(1)} s = ${fps} fps (${(fps / state.movie.fps).toFixed(1)}× realtime${s.segments > 1 ? `, ${s.segments} segments` : ''}), ≈${gbs} GB/s of detector state traffic`);
    }
  }
  if (state.project) parts.push(`caches: ${(state.project.cacheBytes() / 1048576).toFixed(0)} MB`);
  setStatus(parts);
}

// ---- scanning -------------------------------------------------------------------

/**
 * Spans a scan is cut into and scanned at once: one per two logical cores,
 * at most four, on the GPU detector with the browser's own decoder (the
 * built-in decoder already spreads over workers, and the CPU detector has
 * one thread); decoding in workers, all but two cores, at most six.
 * `?segments=N` forces a count.
 */
function segmentsForced() {
  return parseInt(new URLSearchParams(location.search).get('segments') || '', 10) > 0;
}

function scanSegments() {
  const forced = parseInt(new URLSearchParams(location.search).get('segments') || '', 10);
  if (forced > 0) return forced;
  if (!state.env || state.env.feeder.backend !== 'webgpu' || state.decode.software) return 1;
  const cores = navigator.hardwareConcurrency || 4;
  // decoding in workers, each segment's pictures are copied and made small
  // on a core of its own, and the page does little per frame: more of them
  if (state.movie && state.movie.decodeInWorkers) return Math.min(6, Math.max(1, cores - 2));
  return Math.min(4, Math.max(1, Math.floor(cores / 2)));
}

/**
 * Whether a scan decodes with the browser's decoder and the built-in one at
 * the same time (a hybrid scan, analysis.js scanChunked), and with how many
 * of each: for a codec the browser decodes itself and the app has a
 * decoder for (H.264, HEVC, VP9, VP8, AV1), on the GPU detector, on a
 * machine with six cores or more, for a file of two minutes or more (a
 * shorter one scans in seconds anyway). The browser's decoder gets two to
 * four lanes and the built-in decoder a worker for each core left over
 * (two stay for the page and the browser). `?hybrid=0` turns it off,
 * `?hybrid=1` on for any file, `?hybrid=H,S` makes H lanes for the
 * browser's decoder and S workers for the built-in one (0: none).
 */
function hybridPlan(movie, feeder) {
  const q = new URLSearchParams(location.search);
  let h = q.get('hybrid');
  if (h === '0' || h === 'off') return null;
  // tests: `?hybrid=sim:H,S` runs the browser's lanes on the built-in
  // decoder (the test browser has no H.264 in WebCodecs), `?hybridfail=1`
  // fails the built-in decoder's first run
  const sim = !!h && h.startsWith('sim');
  if (sim) h = h.slice(4) || '1';
  if (!movie || (movie.software && !sim) || !feeder || feeder.backend !== 'webgpu') return null;
  if (!builtInFor(movie.video.codec)) return null;
  const cores = navigator.hardwareConcurrency || 4;
  const counts = /^(\d+),(\d+)$/.exec(h || '');
  let hw;
  let sw;
  if (counts) {
    hw = Math.max(1, Math.min(8, +counts[1]));
    sw = Math.min(16, +counts[2]);
  } else {
    if (!(h === '1' || h === 'on') && (cores < 6 || movie.duration < 120)) return null;
    // decoding in workers, each lane also copies and shrinks its pictures on a core of its own
    hw = movie.decodeInWorkers ? Math.min(4, Math.max(2, Math.round(cores * 0.4))) : Math.min(3, Math.max(2, Math.floor(cores / 4)));
    sw = Math.max(1, Math.min(8, cores - hw - 2));
  }
  return { hw, sw, sim, failBuiltIn: q.get('hybridfail') === '1' };
}

/**
 * How a scan runs: a file long enough for two chunks or more is scanned in
 * chunks (analysis.js scanChunked): decoded by as many lanes of the
 * browser's decoder as a segmented scan would use, plus the built-in
 * decoder's lane when hybridPlan makes one (its workers start for the scan
 * and stop after it, and when they cannot start the scan goes on without
 * them), taken by the detector in file order, with early looks at the
 * chunks triage finds likeliest to flash (`?order=file`: none); a shorter
 * file, or with `?chunked=0`, as before. `?chunk=S` sets the chunks' length
 * and `?hold=MB` how much of the pictures decoded ahead may be held. `opts`
 * as scanMovie's.
 */
async function scanWithPlan(env, movie, opts) {
  const q = new URLSearchParams(location.search);
  const chunk = parseFloat(q.get('chunk') || '');
  const chunkS = chunk > 0 ? chunk : CHUNK_S;
  const hold = parseFloat(q.get('hold') || '');
  if (q.get('chunked') === '0' || scanChunks(movie, chunkS).length < 2) return scanMovie(env, movie, opts);
  const plan = hybridPlan(movie, env.feeder);
  let pool = null;
  if (plan && plan.sw > 0) {
    try {
      pool = await SoftwarePool.create(movie, plan.sw);
    } catch (e) {
      const why = e && e.message ? e.message : String(e);
      console.warn('hybrid scan: the built-in decoder cannot start:', why);
      noteError(`hybrid scan without the built-in decoder: ${why}`);
    }
  }
  const order = q.get('order') === 'file' ? 'file' : 'triage';
  try {
    return await scanMovie(env, movie, { ...opts, chunked: { hw: plan ? plan.hw : scanSegments(), pool, chunkS, order, budget: hold > 0 ? hold * 1024 * 1024 : null, sim: !!(plan && plan.sim), failBuiltIn: !!(plan && plan.failBuiltIn) } });
  } finally {
    if (pool) pool.close();
  }
}

/**
 * Whether scans and prepares decode in workers: where WebGPU takes no
 * VideoFrame (Firefox), every picture is copied out of the decoder before
 * the GPU sees it, and that copy is better made off the page, several at
 * once. `?decodeworkers=1` / `=0` forces it.
 */
function decodeWorkersSetting(feeder) {
  const q = new URLSearchParams(location.search).get('decodeworkers');
  if (q === '1' || q === 'on') return true;
  if (q === '0' || q === 'off') return false;
  // a forced picture route is one taken on the page
  if (routeSetting()) return false;
  return !feeder.takesFrames;
}

/** `?builtin=1`: decode with the app's built-in decoder for the codec even where WebCodecs has one (tests; a browser whose decoder misbehaves). */
function builtInSetting() {
  const q = new URLSearchParams(location.search).get('builtin');
  return q === '1' || q === 'on';
}

/** `?shrink=0`: pictures decoded in workers reach the page at full size (the detector shrinks them) rather than at its size. */
function shrinkSetting() {
  const q = new URLSearchParams(location.search).get('shrink');
  return !(q === '0' || q === 'off');
}

/** `?smartcut=0`: an export re-encodes the whole video instead of copying the GOPs no section touches. */
function smartCutSetting() {
  const q = new URLSearchParams(location.search).get('smartcut');
  return !(q === '0' || q === 'off');
}

/** `?parallel=N`: how many spans an export re-encodes at once (0: by the machine). */
function parallelSetting() {
  return Math.max(0, parseInt(new URLSearchParams(location.search).get('parallel') || '0', 10) || 0);
}

/** The export dialog's line about what an export does with this plan. */
function describePlan(plan, movie, softened, blended = []) {
  const secs = (t) => `${t.toFixed(1)} s`;
  let text;
  if (plan.mode === 'smart') {
    text = plan.spans
      ? `${plan.spans} span${plan.spans === 1 ? '' : 's'} around the sections (${secs(plan.encodedSeconds)}, ${plan.encoded} frames) ${plan.spans === 1 ? 'is' : 'are'} decoded and re-encoded${plan.parallel > 1 && plan.spans > 1 ? `, ${Math.min(plan.parallel, plan.spans)} at a time` : ''}; the other ${plan.copied} frames are copied from the source as they are`
      : `Nothing to re-encode: all ${plan.copied} frames are copied from the source as they are`;
  } else {
    const why = !smartCutSetting() ? 'smart cut is off' : plan.copyable ? 'the file does not start at a keyframe' : `${movie.video.codec.split('.')[0]} frames cannot be copied into a track of this encoder's codec`;
    text = `The whole video is decoded and re-encoded${plan.spans > 1 ? ` in ${plan.spans} pieces, ${Math.min(plan.parallel, plan.spans)} at a time` : ''} (${why})`;
  }
  const held = (plan.holds || []).length;
  text += !movie.audio
    ? '.'
    : held
      ? `; the sound is re-encoded (AAC, or Opus) to put silence under the ${held === 1 ? 'held frame' : `${held} held frames`} (E marks), where the picture waits.`
      : movie.audio.copyable
        ? '; audio is copied without re-encoding.'
        : `; the audio (${movie.audio.codec}) can't go into an MP4 as it is, so it is re-encoded (AAC, or Opus) where this browser can.`;
  if (softened.length) text += ` Section${softened.length === 1 ? '' : 's'} ${softened.map((s) => '#' + s.id).join(', ')} ${softened.length === 1 ? 'is' : 'are'} softened (blurred) where stripes were found.`;
  if (blended.length) text += ` In section${blended.length === 1 ? '' : 's'} ${blended.map((s) => '#' + s.id).join(', ')} the frames marked B are blended with the frames around them.`;
  return text;
}

/** Another detector like the current one, for a scan segment (or a verify). */
function makeFeeder(width, height) {
  return createDetector(wasm, state.config, width, height, { preferGpu: preferGpuSetting(), externalSources: externalSourcesSetting(), route: routeSetting() });
}

/**
 * `n` more detectors like state.env.feeder, for the spans of a scan or a
 * prepare that run side by side: made on first use and kept (a GPU
 * detector takes a moment to set up) until the detector is re-created.
 */
async function spareFeeders(n) {
  const env = state.env;
  env.spares = env.spares || [];
  while (env.spares.length < n) env.spares.push(await makeFeeder(state.movie.width, state.movie.height));
  return env.spares.slice(0, n);
}

async function scan() {
  if (!state.movie || !state.env || busy('scan')) return null;
  const t0 = performance.now();
  // what this scan has found so far, until the whole result is in: its own,
  // made and dropped inside its job, so nothing outside it can clear it
  // under a running scan
  const found = { violations: [], partials: [] };
  const res = await runJob('Scanning for flashes', async (progress, cancelled) => {
    setLive(false);
    $('liveToggle').checked = false;
    state.scanning = found;
    state.partials = found.partials;
    try {
      const r = await scanWithPlan(state.env, state.movie, {
        cancel: cancelled,
        segments: scanSegments(),
        forceSegments: segmentsForced(),
        moreFeeders: spareFeeders,
        // exactly what the scan has found up to where it has got, and what its early looks found after that
        onPartial: (part) => {
          found.violations = part.violations;
          found.partials.push({ ms: performance.now() - t0, until: part.until, found: part.violations.length, early: !!part.early });
          state.timelineDrawnAt = 0;
        },
        onProgress: (p, trace, count, ms) => {
          state.scanTrace = trace;
          const n = found.violations.length;
          progress(p, `${count} frames · ${(count / (ms / 1000)).toFixed(0)} fps${n ? ` · ${n} violation${n === 1 ? '' : 's'} found so far` : ''}`);
          // the timeline twice a second, not per so many frames
          const now = performance.now();
          if (!(now - (state.timelineDrawnAt || 0) < 500)) {
            state.timelineDrawnAt = now;
            drawTimeline();
            if (chartMode() === 'video') drawChart();
          }
        },
      });
      // a cancelled scan saw only part of the file: keep nothing of it
      return cancelled() ? null : r;
    } finally {
      if (state.scanning === found) state.scanning = null;
    }
  });
  if (!res) {
    drawTimeline();
    return null;
  }
  state.lastScan = res;
  const project = state.project;
  const counted = res.result.violations.filter((v) => reported(res.result, v));
  const n = counted.length;
  const np = counted.filter((v) => v.kind === 'pattern').length;
  project.scan = {
    violations: res.result.violations,
    summary: res.summary,
    frames: res.frames,
    elapsedMs: res.elapsedMs,
    profile: project.profile,
    sig: wasm.config_signature(state.config),
    safe: n === 0,
    counted: n,
    patterns: np,
    flag_patterns: !!res.result.flag_patterns,
    flag_extended: !!res.result.flag_extended,
    // the per-frame trace, packed: the timeline and the monitor read it, this visit or the next
    trace: packTrace(res.trace),
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
  state.scanTrace = project.scan.trace;
  state.traceNorm = null;
  await project.save();
  renderAll();
  updateStatus();
  const fps = (res.frames / (res.elapsedMs / 1000)).toFixed(0);
  toast(
    n
      ? `${n} violation${n === 1 ? '' : 's'} found${np ? ` (${np} regular pattern${np === 1 ? '' : 's'}, ${n - np} flash)` : ''}, ${added} new section${added === 1 ? '' : 's'} added (${fps} fps).`
      : `No flashing${res.result.flag_patterns ? ' or hazardous patterns' : ''} found in ${res.frames} frames.`,
    6000
  );
  return res;
}

// ---- live monitor ---------------------------------------------------------------

function setLive(on) {
  state.live.on = on;
  $('hud').classList.toggle('hidden', !on);
  const v = $('liveVerdict');
  if (!on) {
    v.className = 'live-verdict idle';
    v.textContent = 'monitor off';
    state.live.fromScan = false;
    return;
  }
  // the section player: the meter reads the section's check (edited) or the scan (original) as it plays
  if (state.player.mode !== 'video') {
    state.live.fromScan = false;
    v.className = 'live-verdict idle';
    v.textContent = 'meter on: press play';
    setHudBars(0, 0, 0);
    $('hudInfo').textContent = state.player.mode === 'edited' ? 'from the section check, as it plays' : 'from the scan, as it plays';
    return;
  }
  // a finished scan of this file under this profile already holds every frame's
  // numbers: the meter reads those, exactly and completely, instead of
  // detecting again on whatever frames the player happens to show
  state.live.fromScan = !!monitorTrace();
  if (state.live.fromScan) {
    monitorFromScan($('player').currentTime);
    startLiveLoop();
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
    if (state.live.fromScan) {
      monitorFromScan(meta.mediaTime);
    } else {
      const det = feeder.det;
      feeder.poll();
      if (det.can_submit()) {
        try {
          feeder.videoElementNow(player, meta.mediaTime, false);
        } catch (e) {
          console.warn(e);
        }
      }
      drainLive();
    }
    if (!player.paused && !player.ended) player.requestVideoFrameCallback(step);
    else {
      liveLoopActive = false;
      setTimeout(drainLive, 50);
    }
  };
  player.requestVideoFrameCallback(step);
}

/** `?monitor=detect` makes the live monitor run the detector on the player even when a scan exists. */
function monitorDetectSetting() {
  return new URLSearchParams(location.search).get('monitor') === 'detect';
}

/** Pack a scan's per-frame trace into typed arrays (about 24 bytes a frame) for the project store. */
function packTrace(tr) {
  return { t: Float64Array.from(tr.t), hazard: Uint32Array.from(tr.hazard), hazardRed: Uint32Array.from(tr.hazardRed), ext: Uint32Array.from(tr.ext), pattern: Uint32Array.from(tr.pattern), lum: Float32Array.from(tr.lum) };
}

/**
 * The scan trace as fractions of the area thresholds, built once and
 * extended as a scan goes on (never recomputed per draw).
 */
function normTrace() {
  const tr = state.scanTrace;
  if (!tr || !state.env) return null;
  let n = state.traceNorm;
  if (!n || n.src !== tr) {
    // (peaks: the highest general / red / at-the-limit level anywhere, and when)
    n = { src: tr, t: [], h: [], r: [], e: [], p: [], l: [], peak: { h: [0, 0], r: [0, 0], e: [0, 0] } };
    state.traceNorm = n;
  }
  const thresh = state.env.feeder.det.area_thresh() || 1;
  const pthresh = state.env.feeder.det.pattern_thresh() || 1;
  for (let i = n.t.length; i < tr.t.length; i++) {
    const t = tr.t[i];
    const h = tr.hazard[i] / thresh;
    const r = tr.hazardRed[i] / thresh;
    const e = tr.ext[i] / thresh;
    n.t.push(t);
    n.h.push(h);
    n.r.push(r);
    n.e.push(e);
    n.p.push(tr.pattern[i] / pthresh);
    n.l.push(tr.lum ? tr.lum[i] : 0);
    if (h > n.peak.h[0]) n.peak.h = [h, t];
    if (r > n.peak.r[0]) n.peak.r = [r, t];
    if (e > n.peak.e[0]) n.peak.e = [e, t];
  }
  return n;
}

/** The finished scan of this file under the current profile, as a trace the monitor can read; null to detect live instead. */
function monitorTrace() {
  if (monitorDetectSetting() || !state.project || !state.project.scan || (state.job && state.job.name === 'Scanning for flashes')) return null;
  if (state.project.scan.sig !== wasm.config_signature(state.config)) return null;
  const n = normTrace();
  return n && n.t.length ? n : null;
}

/** Whether a stored scan counts violation `v` (profiles differ on extended flashes and patterns). */
function scanReports(scan, v) {
  if (v.kind === 'extended') return scan.flag_extended !== undefined ? !!scan.flag_extended : scan.profile !== 'wcag';
  if (v.kind === 'pattern') return !!scan.flag_patterns;
  return true;
}

function setHudBars(haz, red, pat) {
  $('hudHaz').style.width = `${Math.min(100, haz * 50)}%`;
  $('hudRed').style.width = `${Math.min(100, red * 50)}%`;
  $('hudPat').style.width = `${Math.min(100, pat * 50)}%`;
  $('hudHazText').textContent = `${Math.round(haz * 100)}%`;
  $('hudRedText').textContent = `${Math.round(red * 100)}%`;
  $('hudPatText').textContent = `${Math.round(pat * 100)}%`;
}

/** The meter and the verdict at time `t`, read from the scan. */
function monitorFromScan(t) {
  const n = monitorTrace();
  if (!n) return;
  // the scanned frame at or before t
  let lo = 0;
  let hi = n.t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (n.t[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const haz = n.h[i];
  const red = n.r[i];
  const ext = n.e[i];
  const pat = n.p[i];
  setHudBars(haz, red, pat);
  const scan = state.project.scan;
  const viol = scan.violations.filter((v) => scanReports(scan, v));
  const inside = viol.filter((v) => v.start <= t && t <= v.end);
  const before = viol.filter((v) => v.end < t).length;
  const v = $('liveVerdict');
  if (inside.length) {
    const k = inside[inside.length - 1].kind;
    v.className = 'live-verdict bad';
    v.textContent = k === 'pattern' ? 'hazardous pattern: stripes' : `flashing: ${k === 'red' ? 'red flash' : k === 'extended' ? 'extended flash' : 'general flash'}`;
  } else if (haz > 0 || ext >= 1 || (pat >= 1 && scan.flag_patterns)) {
    v.className = 'live-verdict warn';
    v.textContent = haz > 0 || ext >= 1 ? 'flashing below the limit' : 'stripes on screen';
  } else {
    v.className = 'live-verdict ok';
    v.textContent = before ? `${before} violation${before === 1 ? '' : 's'} so far` : 'no flashing so far';
  }
  $('hudInfo').textContent = `from the scan · frame ${i + 1} of ${n.t.length}`;
}

function drainLive() {
  const feeder = state.liveFeeder;
  if (!feeder || !state.live.on || state.live.fromScan) return;
  const det = feeder.det;
  feeder.poll();
  profile.reportEvery(5000, `live monitor (${feeder.fed} pictures watched)`, 0, 0);
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
  setHudBars(haz, red, pat);
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

// ---- the player: the whole video, or the open section edited or as it is ---------------

const PLAYER_SIZES = { s: 320, m: 480, l: 720 };

function playerSizeSetting() {
  try {
    const v = localStorage.getItem('unflash:playerSize');
    if (v && PLAYER_SIZES[v]) return v;
  } catch (e) {
    /* storage blocked */
  }
  return 'm';
}

function setPlayerSize(size) {
  if (!PLAYER_SIZES[size]) size = 'm';
  $('playerBox').style.setProperty('--player-w', `${PLAYER_SIZES[size]}px`);
  for (const b of document.querySelectorAll('.size-switch [data-size]')) b.classList.toggle('on', b.dataset.size === size);
  try {
    localStorage.setItem('unflash:playerSize', size);
  } catch (e) {
    /* the choice lasts the session */
  }
  drawChart();
}

function applyDim() {
  const on = $('dimToggle').checked;
  $('player').classList.toggle('dim', on);
  $('preview').classList.toggle('dim', on);
}

/** Whether the section player plays sound: off unless turned on (remembered in this browser). */
function soundSetting() {
  try {
    return localStorage.getItem('unflash.sectionSound') === '1';
  } catch (e) {
    return false;
  }
}

/** The section player's sound button, as the sound stands. */
function renderSoundButton() {
  const b = $('btnPreviewSound');
  const movie = state.movie;
  b.classList.toggle('hidden', !movie || !movie.audio);
  if (!movie || !movie.audio) return;
  const on = soundSetting();
  const slow = (parseFloat($('previewSpeed').value) || 1) !== 1;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.textContent = on ? 'sound on' : 'sound off';
  b.title = sectionSound.failed
    ? `No sound: ${sectionSound.failed}.`
    : on
      ? `The section's sound plays along${slow ? ' at 1× (not at this speed)' : ''}; held frames are silent while they wait, as in the export. Click to turn it off.`
      : "Play the section's sound too (off to start with). Held frames are silent while they wait, as in the export.";
  b.classList.toggle('warn', !!sectionSound.failed && on);
}

function wirePlayer() {
  sectionPlayer = new SectionPlayer($('preview'), { onFrame: onPreviewFrame, onState: onPreviewState, sound: sectionSound });
  $('btnPreviewSound').addEventListener('click', async () => {
    const on = !soundSetting();
    try {
      localStorage.setItem('unflash.sectionSound', on ? '1' : '0');
    } catch (e) {
      /* not kept */
    }
    sectionSound.failed = null;
    renderSoundButton();
    await sectionSound.setOn(on);
  });
  frameViewer = new FrameViewer($('viewerCanvas'), {
    onShown: (i) => {
      // (the draws are kept for tests: how often a new picture came)
      (state.viewerDraws = state.viewerDraws || []).push({ i, t: performance.now() });
      if (state.viewerDraws.length > 50) state.viewerDraws.shift();
    },
  });
  $('btnViewFrame').addEventListener('click', () => openViewer(state.selection.size ? Math.min(...state.selection) : 0));
  $('btnCloseViewer').addEventListener('click', closeViewer);
  // a click outside the picture closes it too
  $('frameViewer').addEventListener('click', (e) => {
    if (e.target === $('frameViewer')) closeViewer();
  });
  setThumbSize(thumbSizeSetting(), false);
  for (const b of document.querySelectorAll('.thumb-size [data-thumb]')) b.addEventListener('click', () => setThumbSize(b.dataset.thumb));
  setPlayerSize(playerSizeSetting());
  for (const b of document.querySelectorAll('.size-switch [data-size]')) b.addEventListener('click', () => setPlayerSize(b.dataset.size));
  $('playerSource').addEventListener('change', () => setPlayerSource($('playerSource').value));
  $('btnPreviewPlay').addEventListener('click', () => {
    // sound starts only after a click: this one, when it was left on
    if (soundSetting() && !sectionSound.on) sectionSound.setOn(true);
    if (sectionPlayer.active && !sectionPlayer.run.once && !sectionPlayer.paused) sectionPlayer.pause();
    else if (sectionPlayer.paused) sectionPlayer.resume();
    else playSection(state.selection.size ? Math.min(...state.selection) : 0);
  });
  $('btnPreviewStop').addEventListener('click', async () => {
    state.player.gen++;
    await sectionPlayer.stop();
    posterSection();
  });
  $('previewSpeed').addEventListener('change', () => {
    sectionPlayer.setSpeed(parseFloat($('previewSpeed').value) || 1);
    renderSoundButton();
  });
  sectionSound.onFail = () => renderSoundButton();
}

/** Whether a section can be played: it needs the frame times its preparation records. */
function sectionPlayable(sec) {
  return !!(sec && sec.pts && sec.pts.length && state.decode.supported && state.env);
}

/**
 * Put `mode` in the player: 'video' (the whole file in the <video>, where the
 * live monitor can detect) or the open section, 'edited' (with its marks, as
 * the export renders it) or 'original', in the section player.
 */
function setPlayerSource(mode) {
  const sec = currentSection();
  if (mode !== 'video' && !sec) mode = 'video';
  const changed = state.player.mode !== mode;
  state.player.mode = mode;
  $('playerSource').value = mode;
  for (const o of $('playerSource').options) if (o.value !== 'video') o.disabled = !sec;
  const video = mode === 'video';
  $('player').classList.toggle('hidden', !video);
  $('preview').classList.toggle('hidden', video);
  $('previewBar').classList.toggle('hidden', video);
  if (!video) $('player').pause();
  markPlaying(-1);
  $('previewInfo').textContent = '';
  if (sectionPlayer) {
    state.player.gen++;
    if (video) sectionPlayer.stop();
    else posterSection();
  }
  if (changed && state.live.on) setLive(true);
  renderPlayerWarning();
  drawChart();
}

/**
 * The file into the page's <video> (the whole-video player and the live
 * monitor). A browser that turns down a Matroska file under its own type
 * often plays it offered as WebM (the same format, narrowed); when neither
 * works, the whole-video view says so, and the section player (which
 * decodes with WebCodecs) still plays sections.
 */
function loadPlayer(file, movie) {
  const player = $('player');
  if (player.src) URL.revokeObjectURL(player.src);
  const token = (state.player.loadToken = (state.player.loadToken || 0) + 1);
  const types = movie.format === 'mp4' ? [null] : [null, 'video/webm'];
  let k = 0;
  state.player.playable = true;
  const next = () => {
    if (token !== state.player.loadToken) return;
    if (k >= types.length) {
      state.player.playable = false;
      if (state.live.on && state.player.mode === 'video') setLive(false);
      renderPlayerWarning();
      return;
    }
    const t = types[k++];
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(t ? new Blob([file], { type: t }) : file);
  };
  player.onerror = () => next();
  player.onloadedmetadata = () => {
    if (token !== state.player.loadToken) return;
    state.player.playable = true;
    renderPlayerWarning();
  };
  next();
}

/** The section's first picture in the section player, when nothing is playing. */
function posterSection() {
  const sec = currentSection();
  const canvas = $('preview');
  if (state.player.mode === 'video') return;
  const gen = ++state.player.gen;
  if (!sectionPlayable(sec)) {
    sectionPlayer.stop();
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  sectionPlayer.stop().then(() => {
    if (gen !== state.player.gen || currentSection() !== sec || state.player.mode === 'video') return;
    sectionPlayer.play({ env: state.env, movie: state.movie, sec, edited: state.player.mode === 'edited', extS: EXT_S, fromSlot: 0, once: true });
  });
}

/** Play the open section in the player from slot `fromSlot` (edited unless the player is on original). */
function playSection(fromSlot = 0) {
  const sec = currentSection();
  if (!sectionPlayable(sec)) return toast(sec ? 'The section plays once it is prepared.' : 'Open a section first.');
  if (state.player.mode === 'video') setPlayerSource('edited');
  state.player.gen++;
  sectionPlayer.setSpeed(parseFloat($('previewSpeed').value) || 1);
  return sectionPlayer.play({ env: state.env, movie: state.movie, sec, edited: state.player.mode === 'edited', extS: EXT_S, fromSlot, loop: () => $('previewLoop').checked });
}

/** Outline the tile of the slot on screen (-1: none). */
function markPlaying(k) {
  const grid = $('frameGrid');
  const prev = state.player.playingTile;
  if (prev != null && grid.children[prev]) grid.children[prev].classList.remove('playing');
  state.player.playingTile = k >= 0 ? k : null;
  if (k >= 0 && grid.children[k]) grid.children[k].classList.add('playing');
}

function onPreviewFrame(info, t, plan) {
  const sec = currentSection();
  if (!sec || plan.sec !== sec) return;
  const k = info.sec ? info.slot : -1;
  markPlaying(k);
  const n = plan.seq.t.length;
  const rel = t - (sec.start + plan.base + plan.seq.t[0]);
  const total = plan.seq.t[n - 1] - plan.seq.t[0];
  let what = '';
  if (k >= 0) {
    const e = state.player.mode === 'edited' ? (sec.edits || {})[k] || {} : {};
    what = `frame ${k}${info.src !== k ? `, showing ${info.src}` : ''}${e.removed ? ' (removed)' : e.extended ? ' (held 1 s)' : ''}${info.blended ? `, blended ${Math.round(blendStrength(sec) * 100)}%` : ''}${info.softened ? ', softened' : ''}`;
  }
  $('previewInfo').textContent = `${fmt(Math.max(0, rel))} / ${fmt(total)} · ${what}`;
  if (state.live.on) previewMeter(sec, k, t);
  const now = performance.now();
  if (now - state.player.lastDraw > 250) {
    state.player.lastDraw = now;
    drawTimeline();
  }
}

function onPreviewState(s, detail) {
  const b = $('btnPreviewPlay');
  b.textContent = s === 'playing' ? '❚❚ pause' : s === 'paused' ? '▶ resume' : '▶ play';
  if (s === 'stopped' || s === 'ended') markPlaying(-1);
  if (s === 'error') banner(`The section player stopped: ${detail && detail.message ? detail.message : detail}`);
}

/** The meter for the frame the section player shows: the section's check (edited) or the scan (original). */
function previewMeter(sec, k, t) {
  const v = $('liveVerdict');
  if (state.player.mode === 'original') {
    if (monitorTrace()) monitorFromScan(t);
    else {
      v.className = 'live-verdict idle';
      v.textContent = 'no scan to read';
    }
    return;
  }
  const c = sec.check;
  if (!c || c.stale || !c.stats || k < 0 || k >= c.stats.hazard.length) {
    v.className = 'live-verdict idle';
    v.textContent = c && c.stale ? 'checking the change…' : 'not checked yet';
    return;
  }
  const thr = c.area_thresh || 1;
  const pthr = c.pattern_thresh || 1;
  setHudBars(c.stats.hazard[k] / thr, c.stats.hazardRed[k] / thr, (c.stats.pattern[k] || 0) / pthr);
  $('hudInfo').textContent = `from the section check · frame ${k} of ${c.stats.hazard.length}`;
  if (c.flagged && c.flagged.includes(k)) {
    v.className = 'live-verdict bad';
    v.textContent = 'still failing here';
  } else if (c.safe) {
    v.className = 'live-verdict ok';
    v.textContent = 'passes the check';
  } else {
    v.className = 'live-verdict warn';
    v.textContent = 'fails elsewhere in the section';
  }
}

/** Whether a section has marks that change what it shows. */
function hasMarks(sec) {
  return !!sec.soften || blendMarks(sec).length > 0 || Object.values(sec.edits || {}).some((e) => e.removed || e.extended);
}

/** The line above the player: what it shows, whether that passes, whether it is dimmed. */
function renderPlayerWarning() {
  const w = $('playerWarning');
  const sec = currentSection();
  const dim = $('dimToggle').checked ? ' Dimmed.' : ' Not dimmed: full brightness.';
  const mode = state.player.mode;
  let text = '';
  let ok = false;
  if (!state.movie) text = '';
  else if (mode === 'video' && state.player.playable === false) text = `This browser's video player can't play this ${state.movie.format === 'webm' ? 'WebM' : state.movie.format === 'matroska' ? 'MKV' : ''} file, so the whole video can't be shown here. Scanning, sections (their player shows them, marks and all) and the export work as usual.`;
  else if (mode === 'video') text = `⚠ The whole video as it is: it may flash.${dim}`;
  else if (!sec) text = '';
  else if (mode === 'original') text = `⚠ Section #${sec.id} as it is: it may flash.${dim}`;
  else {
    const marked = hasMarks(sec);
    const c = sec.check;
    if (!sectionPlayable(sec)) text = `Section #${sec.id} plays here once it is prepared.`;
    else if (!marked) text = `⚠ Section #${sec.id} has no marks yet, so this is how it is: it may flash.${dim}`;
    else if (!c || c.stale) text = `Section #${sec.id} with your marks: not checked yet.${dim}`;
    else if (c.safe) {
      text = `✓ Section #${sec.id} with your marks: passes the check.${dim}`;
      ok = true;
    } else if (c.wcag_safe) text = `Section #${sec.id} with your marks: passes WCAG; ${remainingKinds(c).join(' and ') || 'something the profile flags'} remain${remainingKinds(c).length === 1 ? 's' : ''}.${dim}`;
    else text = `⚠ Section #${sec.id} with your marks: still fails the check.${dim}`;
  }
  w.textContent = text;
  w.classList.toggle('ok', ok);
  $('btnPreviewPlay').disabled = mode !== 'video' && !sectionPlayable(sec);
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
    else {
      setPlayerSource('video');
      $('player').currentTime = t;
    }
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
        g.fillStyle = tint(ink.flash, Math.min(1, 0.25 + gcount / 6));
        g.fillRect(x(sum.t0 + i * sum.bin), 6, bw + 0.5, H - 30);
      }
      if (rcount) {
        g.fillStyle = tint(ink.red, Math.min(1, 0.25 + rcount / 6));
        g.fillRect(x(sum.t0 + i * sum.bin), 6, bw + 0.5, (H - 30) / 2);
      }
      const pcount = sum.pattern ? sum.pattern[i] : 0;
      if (pcount) {
        g.fillStyle = tint(ink.pat, Math.min(1, 0.3 + pcount / 4));
        g.fillRect(x(sum.t0 + i * sum.bin), 6 + (H - 30) / 2, bw + 0.5, (H - 30) / 2);
      }
    }
  }
  // the live trace (and the scan trace while scanning)
  const norm = state.live.on && !state.live.fromScan ? null : normTrace();
  const trace = state.live.on && !state.live.fromScan ? { t: state.live.t, h: state.live.hazard, r: state.live.hazardRed } : norm ? { t: norm.t, h: norm.h, r: norm.r } : null;
  if (trace && trace.t.length) {
    const base = H - 24;
    // one bar per pixel column, the tallest there: an hour has a hundred
    // thousand frames and the timeline a thousand pixels
    const cols = Math.max(1, Math.ceil(W));
    const hmax = new Float32Array(cols);
    const rmax = new Float32Array(cols);
    for (let i = 0; i < trace.t.length; i++) {
      const c = Math.floor(x(trace.t[i]));
      if (c < 0 || c >= cols) continue;
      if (trace.h[i] > hmax[c]) hmax[c] = trace.h[i];
      if (trace.r[i] > rmax[c]) rmax[c] = trace.r[i];
    }
    for (const [col, vals] of [
      [tint(ink.flash, 0.9), hmax],
      [tint(ink.red, 0.9), rmax],
    ]) {
      g.strokeStyle = col;
      g.beginPath();
      for (let c = 0; c < cols; c++) {
        const h = Math.min(1.5, vals[c]);
        if (h <= 0) continue;
        g.moveTo(c + 0.5, base);
        g.lineTo(c + 0.5, base - h * 14);
      }
      g.stroke();
    }
  }
  // threshold line label
  g.fillStyle = ink.line2;
  g.fillRect(0, H - 24, W, 1);
  // what a running scan has found so far (dashed: its edges may still move)
  const provisional = state.scanning ? state.scanning.violations : null;
  if (provisional && provisional.length) {
    g.save();
    g.setLineDash([4, 3]);
    g.lineWidth = 1.5;
    for (const v of provisional) {
      const x0 = x(v.start);
      const x1 = Math.max(x0 + 4, x(v.end));
      g.strokeStyle = kindInk(v.kind);
      g.strokeRect(x0 + 0.5, 4.5, x1 - x0 - 1, H - 27);
    }
    g.restore();
  }
  // sections
  for (const s of state.project.sectionsSorted()) {
    const x0 = x(s.start);
    const x1 = Math.max(x0 + 3, x(s.end));
    const isCur = state.current === s.id;
    const kind = kindInk(['red', 'flash', 'extended', 'pattern'].find((k) => (s.kinds || []).includes(k)));
    g.fillStyle = isCur ? tint(ink.fg, 0.2) : tint(ink.fg, 0.07);
    g.fillRect(x0, 4, x1 - x0, H - 26);
    g.strokeStyle = s.check && !s.check.stale ? (s.check.safe ? ink.ok : ink.bad) : kind;
    g.lineWidth = isCur ? 2 : 1;
    g.strokeRect(x0 + 0.5, 4.5, x1 - x0 - 1, H - 27);
    g.fillStyle = ink.fg;
    g.font = ink.font(11);
    g.fillText(`#${s.id}`, x0 + 3, 16);
  }
  if (dragSpan) {
    g.fillStyle = tint(ink.fg, 0.25);
    g.fillRect(x(dragSpan[0]), 4, x(dragSpan[1]) - x(dragSpan[0]), H - 26);
  }
  // time ticks
  g.fillStyle = ink.fg2;
  g.font = ink.font(10);
  const step = niceStep(span / Math.max(2, W / 90));
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    g.fillRect(x(t), H - 22, 1, 4);
    g.fillText(fmt(t), x(t) + 2, H - 12);
  }
  // playhead: the section player's, while it shows a section
  const ct = state.player.mode !== 'video' && sectionPlayer && sectionPlayer.run && sectionPlayer.run.t != null ? sectionPlayer.run.t : $('player').currentTime;
  if (ct >= lo && ct <= hi) {
    g.fillStyle = ink.fg;
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

/** Back to the whole video: no section open, the player on the file, the chart around the playhead. */
function openWholeVideo() {
  if (state.current != null) closeViewer();
  state.current = null;
  state.selection.clear();
  state.anchor = null;
  setPlayerSource('video');
  renderAll();
}

function renderSectionList() {
  const list = $('sectionList');
  list.innerHTML = '';
  const st = scanStatus();
  const [lo, hi] = state.project.bounds;
  const whole = document.createElement('div');
  // (its own class: .sec-item are the sections)
  whole.className = 'sec-whole' + (state.current == null ? ' current' : '');
  whole.title = 'The whole video in the player, and its flashing charted around the playhead (under the limit too)';
  whole.innerHTML = `<div class="sec-title">Whole video ${st ? st.badge : ''}</div><div class="sec-times">${fmt(lo)} – ${fmt(hi)}${st ? ` · ${st.text}` : ''}</div>`;
  whole.addEventListener('click', openWholeVideo);
  list.appendChild(whole);
  for (const s of state.project.sectionsSorted()) {
    const el = document.createElement('div');
    el.className = 'sec-item' + (state.current === s.id ? ' current' : '');
    const kinds = (s.kinds || []).map((k) => `<span class="badge kind-${k}">${KIND_LABEL[k] || k}</span>`).join(' ');
    const marks = Object.values(s.edits || {}).filter((e) => e.removed || e.extended).length;
    el.innerHTML = `<div class="sec-title">#${s.id} ${sectionBadge(s)}</div><div class="sec-times">${fmt(s.start)} – ${fmt(s.end)} · ${(s.end - s.start).toFixed(1)} s${marks ? ` · ${marks} marks` : ''}${s.custom ? ' · custom' : ''}</div><div>${kinds}</div>`;
    el.addEventListener('click', () => openSection(s.id));
    list.appendChild(el);
  }
  if (!state.project.sections.length) {
    const none = document.createElement('div');
    none.className = 'sec-item';
    none.style.color = 'var(--fg2)';
    none.textContent = st && st.safe ? 'No sections: the scan found nothing to fix. To look at a stretch anyway, drag over it on the timeline.' : 'No sections yet. Scan the video, or drag on the timeline.';
    list.appendChild(none);
  }
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
  const changed = state.current !== id;
  if (changed) closeViewer();
  state.current = id;
  state.selection.clear();
  state.anchor = null;
  const sec = currentSection();
  if (sec) {
    sec.usedAt = Date.now();
    $('player').currentTime = sec.start;
  }
  // the player follows: this section, edited, from its first frame
  if (changed || state.player.mode === 'video') setPlayerSource(sec ? 'edited' : 'video');
  renderAll();
  if (sec && sec.prepared && (!sec.check || sec.check.stale)) scheduleCheck(0);
  // a section prepares itself when opened (unless something else holds the decoder)
  if (sec && !sec.prepared && state.decode.supported && !state.job && !(state.auto && state.auto.running)) doPrepare(sec);
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
    sec.blendCache = null;
    sec.blendKey = null;
    sec.ctx = null;
    sec.check = null;
    sec.edits = {};
    sec.blend = [];
    sec.pts = null;
    state.project.save();
    renderAll();
  });
  $('btnCheck').addEventListener('click', () => scheduleCheck(0, true));
  $('softenToggle').addEventListener('change', () => {
    const sec = currentSection();
    if (!sec) return;
    pushHistory(sec);
    sec.soften = $('softenToggle').checked;
    afterEdit(sec);
  });
  $('btnClearEdits').addEventListener('click', () => {
    const sec = currentSection();
    if (!sec) return;
    pushHistory(sec);
    sec.edits = {};
    sec.blend = [];
    afterEdit(sec);
  });
  $('blendStrength').addEventListener('input', () => {
    $('blendValue').textContent = `${$('blendStrength').value}%`;
  });
  $('blendStrength').addEventListener('change', () => {
    const sec = currentSection();
    if (!sec) return;
    pushHistory(sec);
    sec.blendStrength = +$('blendStrength').value / 100;
    afterEdit(sec);
  });
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnSuggestLight').addEventListener('click', () => doSuggest('light'));
  $('btnSuggestDark').addEventListener('click', () => doSuggest('dark'));
  $('btnSuggestFewest').addEventListener('click', () => doSuggest('fewest'));
  $('btnSuggestBlend').addEventListener('click', () => doSuggestBlend());
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
  $('btnFpsExact').addEventListener('click', () => {
    $('fpsMenu').classList.add('hidden');
    doSuggestFpsExact();
  });
  $('fpsInput').addEventListener('input', updateFpsNote);
  $('fpsInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      $('fpsMenu').classList.add('hidden');
      doSuggestFpsExact();
    }
  });
  $('btnMarkRemoved').addEventListener('click', () => markSelection('R'));
  $('btnMarkRemovedNext').addEventListener('click', () => markSelection('F'));
  $('btnMarkExtended').addEventListener('click', () => markSelection('E'));
  $('btnMarkKeep').addEventListener('click', () => markSelection('K'));
  $('btnMarkBlend').addEventListener('click', () => markSelection('B'));
  $('btnUnmark').addEventListener('click', () => markSelection('U'));
  $('btnSelectUnsafe').addEventListener('click', () => {
    const sec = currentSection();
    if (!sec || !sec.check) return;
    selectFrames(sec, sec.check.flagged || [], 'everything still failing');
  });
  $('wsFindings').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-finding]');
    const sec = currentSection();
    if (!b || !sec || !sec.check) return;
    const f = findings(sec)[+b.dataset.finding];
    if (f) selectFrames(sec, f.frames, f.label);
  });
  const grid = $('frameGrid');
  grid.addEventListener('keydown', (e) => {
    const k = e.key.toUpperCase();
    if (k === 'A' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const sec = currentSection();
      if (sec) state.selection = new Set(Array.from({ length: sec.nFrames }, (_, i) => i));
      renderGridMarks();
    }
  });
  $('chart').addEventListener('click', (e) => {
    if (chartMode() === 'video') {
      if (!state.project) return;
      const r = $('chart').getBoundingClientRect();
      const [t0, t1] = videoChartRange();
      $('player').currentTime = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
      drawTimeline();
      drawChart();
      return;
    }
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
  $('chart').addEventListener('mousemove', chartTip);
  $('chart').addEventListener('mouseleave', () => $('chartTip').classList.add('hidden'));
  setChartSpan(chartSpanSetting(), false);
  for (const b of document.querySelectorAll('#chartSpan [data-span]')) b.addEventListener('click', () => setChartSpan(+b.dataset.span));
  // the marking keys work anywhere on the page (as in the original tool), not
  // only with the frame grid focused; typing in a field is left alone
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  // the text dialogs close with Esc wherever the focus is (the debug text, say)
  if (e.key === 'Escape' && !$('changesModal').classList.contains('hidden')) return closeChanges();
  if (e.key === 'Escape' && !$('debugModal').classList.contains('hidden')) return closeDebug();
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    if (viewerOpen()) return closeViewer();
    if (document.body.classList.contains('guide-open')) return setGuide(false);
    if (!$('exportModal').classList.contains('hidden')) return;
    state.selection.clear();
    state.anchor = null;
    renderGridMarks();
    return;
  }
  if ([...document.querySelectorAll('.modal')].some((m) => !m.classList.contains('hidden'))) return;
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (k === 'y') {
      e.preventDefault();
      redo();
    }
    return;
  }
  if (e.altKey) return;
  if (['r', 'f', 'e', 'k', 'b', 'u'].includes(k)) {
    e.preventDefault();
    markSelection(k.toUpperCase());
    renderViewerInfo();
    return;
  }
  if (k === 'z') {
    e.preventDefault();
    if (viewerOpen()) closeViewer();
    else openViewer(state.selection.size ? Math.min(...state.selection) : 0);
    return;
  }
  // the arrows step through the frames (one, or ten with shift)
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const from = viewerOpen() ? state.viewerAt : state.selection.size ? Math.min(...state.selection) : null;
    if (from == null) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(sec.nFrames - 1, from + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)));
    if (viewerOpen()) return openViewer(i);
    state.selection.clear();
    state.selection.add(i);
    state.anchor = i;
    renderGridMarks();
    const tile = $('frameGrid').children[i];
    if (tile) tile.scrollIntoView({ block: 'nearest' });
  }
}

function updateFpsNote() {
  const v = parseFloat($('fpsInput').value);
  const safe = wasm.safe_picture_rate(state.config);
  const note = $('fpsNote');
  if (!(v > 0)) note.textContent = '';
  else if (wasm.rate_is_guaranteed(state.config, v)) note.textContent = `${v}/s is at or under the guaranteed-safe ${safe}/s: no arrangement of pictures at that rate can fail this profile.`;
  else note.textContent = `${v}/s is above the guaranteed-safe ${safe}/s, so the result is a proposal that the check judges, not a promise.`;
  const ladder = rateLadder(safe, state.movie ? state.movie.fps : 30);
  $('fpsSearchNote').textContent = safe > 0
    ? `The button tries ${ladder[0]}/s first (twice the guaranteed-safe ${safe}/s) and steps down a tenth at a time, ${ladder.join(', ')}/s, keeping the first rate that passes the check.`
    : `This profile has no rate that can never fail, so the button tries ${ladder.join(', ')}/s in turn and keeps the first that passes the check.`;
  const sec = currentSection();
  $('fpsShown').textContent = sec && sec.fpsFound ? `(${sec.fpsFound}/s)` : '';
}

function renderWorkspace() {
  const sec = currentSection();
  const ws = $('workspace');
  if (!sec) {
    ws.classList.add('hidden');
    if (state.player.mode !== 'video') setPlayerSource('video');
    drawChart();
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
  renderBlend(sec);
  renderUndo();
  if (sec.prepared) {
    $('frameCount').textContent = `(${sec.nFrames})`;
    renderGrid(sec);
  }
  drawChart();
  renderPlayerWarning();
}

/** The blend strength: shown when the section has frames marked B. */
function renderBlend(sec) {
  const marks = (sec.blend || []).length;
  $('blendWrap').classList.toggle('hidden', !marks);
  const pct = Math.round(blendStrength(sec) * 100);
  $('blendStrength').value = String(pct);
  $('blendValue').textContent = `${pct}%`;
  $('blendNote').textContent = marks ? `${marks} frame${marks === 1 ? '' : 's'}` : '';
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
  renderFindings(sec);
  if (sec === currentSection()) renderPlayerWarning();
}

/**
 * What a section's check still objects to inside it, one entry per
 * violation: its kind, the frames it covers (in the edited sequence, the
 * grid's numbering) and when, for the list under the verdict.
 */
function findings(sec) {
  const c = sec.check;
  if (!c || c.stale || !c.seq || !c.seq.t) return [];
  const t = c.seq.t;
  const out = [];
  for (const v of (c.inside || []).filter((v) => c[`flag_${v.kind === 'pattern' ? 'patterns' : v.kind}`] !== false)) {
    const lo = Math.min(v.onset, v.start);
    const frames = [];
    for (let i = 0; i < t.length; i++) if (lo - 0.05 <= t[i] && t[i] <= v.end + 0.05) frames.push(i);
    if (!frames.length) continue;
    out.push({ v, kind: v.kind, frames, first: frames[0], last: frames[frames.length - 1], label: `the ${KIND_LABEL[v.kind] || v.kind} at frames ${frames[0]}–${frames[frames.length - 1]}` });
  }
  return out;
}

/** Select `frames`, bring the first into view and say what was selected. */
function selectFrames(sec, frames, what) {
  if (!frames.length) return toast('Nothing to select: the last check found nothing failing in this section.');
  state.selection = new Set(frames);
  state.anchor = frames[0];
  renderGridMarks();
  const tile = $('frameGrid').children[frames[0]];
  if (tile) tile.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast(`Selected ${frames.length} frame${frames.length === 1 ? '' : 's'}: ${what}. A Suggest button with "selection only" ticked works on just these.`, 6000);
  drawChart();
}

/** The list under the verdict: each remaining problem, where it is, and what fixes it. */
function renderFindings(sec) {
  const box = $('wsFindings');
  const list = sec.prepared ? findings(sec) : [];
  box.classList.toggle('hidden', !list.length);
  if (!list.length) {
    box.innerHTML = '';
    return;
  }
  const dur = (f) => `${fmt(sec.check.seq.t[f.first])} – ${fmt(sec.check.seq.t[f.last])} into the section`;
  const how = {
    flash: 'Flashing faster than 3 times a second over enough of the screen: remove (R, F) or blend (B) frames, or let a Suggest button pick them.',
    red: 'Red flashing faster than 3 times a second: remove or blend frames, or let a Suggest button pick them.',
    extended: 'Flashing at the limit rate (3 a second) for 5 seconds or more. WCAG allows it; this profile flags it because long runs of it affect some viewers. It clears once the flashing is broken into stretches shorter than 5 seconds by pauses of more than a second (remove or hold frames), or once its contrast is low enough: select it, tick "selection only" and use a Suggest button.',
    pattern: 'A stationary stripe pattern over a quarter of the screen: tick "soften stripes" above.',
  };
  box.innerHTML = list
    .map((f, k) => `<div class="finding ${f.kind}"><b>${(KIND_LABEL[f.kind] || f.kind).replace(/^./, (m) => m.toUpperCase())}</b>, frames ${f.first}–${f.last} (${dur(f)}, ${(sec.check.seq.t[f.last] - sec.check.seq.t[f.first]).toFixed(1)} s)<button class="small" data-finding="${k}">select these frames</button><div class="how">${how[f.kind] || ''}</div></div>`)
    .join('');
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
/** Smallest tile width per thumbnail size (the grid fills the row with them). */
const THUMB_SIZES = { s: 110, m: 146, l: 220, xl: 320 };
let THUMB_W = 160;

function thumbSizeSetting() {
  try {
    const v = localStorage.getItem('unflash:thumbSize');
    if (THUMB_SIZES[v]) return v;
  } catch (e) {
    /* storage blocked */
  }
  return 'm';
}

function setThumbSize(size, redraw = true) {
  if (!THUMB_SIZES[size]) size = 'm';
  const min = THUMB_SIZES[size];
  $('frameGrid').style.setProperty('--thumb-min', `${min}px`);
  // drawn a little over the tile's size for a sharp picture, never far past the cache's own
  THUMB_W = Math.round(Math.max(160, min * 1.3));
  for (const b of document.querySelectorAll('.thumb-size [data-thumb]')) b.classList.toggle('on', b.dataset.thumb === size);
  try {
    localStorage.setItem('unflash:thumbSize', size);
  } catch (e) {
    /* the choice lasts the session */
  }
  const sec = currentSection();
  if (redraw && sec && sec.prepared && sec.cache) renderGrid(sec);
}

// ---- one frame at full size -------------------------------------------------------

let frameViewer = null;

function viewerOpen() {
  return !$('frameViewer').classList.contains('hidden');
}

/** Show frame `i` of the open section at full size (and select it). */
function openViewer(i) {
  const sec = currentSection();
  if (!sec || !sec.prepared || !state.movie) return;
  i = Math.max(0, Math.min(sec.nFrames - 1, i));
  state.selection.clear();
  state.selection.add(i);
  state.anchor = i;
  state.viewerAt = i;
  $('viewerCanvas').classList.toggle('dim', $('dimToggle').checked);
  $('frameViewer').classList.remove('hidden');
  renderViewerInfo();
  frameViewer.show(state.movie, sec, i);
  renderGridMarks();
  const tile = $('frameGrid').children[i];
  if (tile) tile.scrollIntoView({ block: 'nearest' });
}

function closeViewer() {
  if (!viewerOpen()) return;
  $('frameViewer').classList.add('hidden');
  frameViewer.clear();
  $('frameGrid').focus({ preventScroll: true });
}

function renderViewerInfo() {
  const sec = currentSection();
  const i = state.viewerAt;
  if (!sec || i == null || !viewerOpen()) return;
  const e = (sec.edits || {})[i] || {};
  const marks = [];
  if (e.removed) marks.push(`removed: frame ${e.fill === 'next' ? 'after' : 'before'} it shows instead`);
  if (e.extended) marks.push('held for 1 s');
  if ((sec.keep || []).includes(i)) marks.push('keep');
  if ((sec.blend || []).includes(i)) marks.push(`blended ${Math.round(blendStrength(sec) * 100)}% with the frames around it in the export (shown here as it is)`);
  $('viewerInfo').textContent = `Section #${sec.id}, frame ${i} of ${sec.nFrames} · ${fmt(sec.start + sec.pts[i])} (${sec.pts[i].toFixed(3)} s in)${marks.length ? ' · ' + marks.join(' · ') : ''} · ${state.movie.width}×${state.movie.height}`;
}

/**
 * A tile's thumbnail from the section's small copies: blended, for a frame
 * marked B, as the check sees it (`tile.dataset.want` names that version;
 * the blur of softened frames is a CSS filter on top).
 */
function drawTile(sec, tile) {
  const i = +tile.dataset.i;
  const want = tile.dataset.want || '';
  const canvas = tile.querySelector('canvas');
  try {
    const cache = want ? blendedFrames(sec) : sec.cache;
    const aw = cache.width();
    const ah = cache.height();
    if (!scratch || scratch.width !== aw || scratch.height !== ah) scratch = new OffscreenCanvas(aw, ah);
    const rgba = cache.frame(i);
    const img = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), aw, ah);
    scratch.getContext('2d').putImageData(img, 0, 0);
    canvas.getContext('2d').drawImage(scratch, 0, 0, canvas.width, canvas.height);
    tile.dataset.drawnKey = want;
  } catch (e) {
    /* cache gone */
  }
}

function renderGrid(sec) {
  const grid = $('frameGrid');
  grid.innerHTML = '';
  if (tileObserver) tileObserver.disconnect();
  const shown = shownPts(wasm, sec);
  const aw = sec.cache.width();
  const ah = sec.cache.height();
  const tw = THUMB_W;
  const th = Math.max(1, Math.round((THUMB_W * ah) / aw));
  tileObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const tile = en.target;
        if (tile.dataset.drawn) continue;
        tile.dataset.drawn = '1';
        drawTile(sec, tile);
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
    tile.addEventListener('dblclick', () => openViewer(i));
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
  const extFlag = new Set();
  if (sec.check && sec.check.inside) {
    const seqT = sec.check.seq ? sec.check.seq.t : null;
    if (seqT) {
      for (const v of sec.check.inside) {
        const into = v.kind === 'red' ? redFlag : v.kind === 'pattern' ? patFlag : v.kind === 'extended' ? extFlag : null;
        if (!into) continue;
        for (let i = 0; i < seqT.length; i++) if (Math.min(v.onset, v.start) - 0.05 <= seqT[i] && seqT[i] <= v.end + 0.05) into.add(i);
      }
    }
  }
  // (a frame in a flash too shows the flash: that is the one to fix first)
  const genFlag = new Set([...flagged].filter((i) => !extFlag.has(i)));
  if (sec.check && sec.check.inside) {
    const seqT = sec.check.seq ? sec.check.seq.t : null;
    for (const v of sec.check.inside) {
      if (v.kind !== 'flash' || !seqT) continue;
      for (let i = 0; i < seqT.length; i++) if (Math.min(v.onset, v.start) - 0.05 <= seqT[i] && seqT[i] <= v.end + 0.05) genFlag.add(i);
    }
  }
  const soft = new Set(sec.soften && sec.check && !sec.check.stale ? sec.check.soft_frames || [] : []);
  const kept = new Set(sec.keep || []);
  const blendSet = new Set(blendMarks(sec));
  // the blended thumbnails are redrawn when the marks or the strength change
  const blendKey = blendSet.size && sec.cache && blendedFrames(sec) !== sec.cache ? sec.blendKey : '';
  const blendPct = Math.round(blendStrength(sec) * 100);
  const softBlur = soft.size && sec.cache ? `blur(${((sec.check.soft_sigma || 1) * THUMB_W) / sec.cache.width()}px)` : '';
  for (let i = 0; i < grid.children.length; i++) {
    const tile = grid.children[i];
    const e = (sec.edits || {})[i] || {};
    tile.classList.toggle('removed', !!e.removed);
    tile.classList.toggle('extended', !!e.extended && !e.removed);
    tile.classList.toggle('selected', state.selection.has(i));
    tile.classList.toggle('flagged', genFlag.has(i) && !redFlag.has(i) && !patFlag.has(i));
    tile.classList.toggle('flagged-red', redFlag.has(i));
    tile.classList.toggle('flagged-pat', patFlag.has(i) && !redFlag.has(i));
    tile.classList.toggle('flagged-ext', extFlag.has(i) && !genFlag.has(i) && !redFlag.has(i) && !patFlag.has(i));
    tile.classList.toggle('soft', soft.has(i));
    tile.classList.toggle('kept', kept.has(i));
    const blended = blendSet.has(i) && !e.removed;
    tile.classList.toggle('blended', blended);
    tile.dataset.want = blended ? blendKey : '';
    if (tile.dataset.drawn && (tile.dataset.drawnKey || '') !== tile.dataset.want) drawTile(sec, tile);
    tile.querySelector('canvas').style.filter = soft.has(i) ? softBlur : '';
    const fb = tile.querySelector('.fb');
    if (e.removed) {
      fb.textContent = `shows ${rep[i]}`;
      fb.classList.remove('hidden');
    } else if (e.extended) {
      fb.textContent = blended ? `held 1 s · blend ${blendPct}%` : 'held 1 s';
      fb.classList.remove('hidden');
    } else if (blended) {
      fb.textContent = `blend ${blendPct}%`;
      fb.classList.remove('hidden');
    } else fb.classList.add('hidden');
  }
}

/**
 * R, F, E, K and B toggle their own mark on the selected frames, as in the
 * original tool: pressed on frames that already carry it (judged by the
 * first frame selected) they take it off, otherwise they put it on. R and F
 * each toggle their own direction, so one pressed on a removal marked the
 * other way flips it; a removal and a blend (B) exclude each other. U takes
 * every mark off.
 */
function markSelection(key) {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  if (!state.selection.size) return toast('Select frames first (click, or shift-click for a range)');
  pushHistory(sec);
  sec.edits = sec.edits || {};
  const keep = new Set(sec.keep || []);
  const blend = new Set(sec.blend || []);
  const items = [...state.selection];
  const first = sec.edits[items[0]] || null;
  const removedAs = (fill) => !!(first && first.removed && ((first.fill || 'prev') === 'next') === (fill === 'next'));
  const set = (i, removed, extended, fill) => {
    if (!removed && !extended) delete sec.edits[i];
    else sec.edits[i] = { removed, extended: extended && !removed, fill: fill || 'prev' };
  };
  if (key === 'R' || key === 'F') {
    const fill = key === 'F' ? 'next' : 'prev';
    const on = !removedAs(fill);
    for (const i of items) {
      const e = sec.edits[i] || {};
      set(i, on, on ? false : !!e.extended, fill);
      if (on) {
        keep.delete(i);
        blend.delete(i);
      }
    }
  } else if (key === 'E') {
    const on = !(first && first.extended && !first.removed);
    for (const i of items) {
      const e = sec.edits[i] || {};
      set(i, on ? false : !!e.removed, on, e.fill);
    }
  } else if (key === 'K') {
    const on = !keep.has(items[0]);
    for (const i of items) {
      if (!on) keep.delete(i);
      else {
        keep.add(i);
        // a kept frame stays on screen: a removal goes, a hold stays
        const e = sec.edits[i];
        if (e && e.removed) delete sec.edits[i];
      }
    }
  } else if (key === 'B') {
    const on = !blend.has(items[0]);
    for (const i of items) {
      if (!on) blend.delete(i);
      else {
        blend.add(i);
        // a blended frame stays on screen: a removal goes, a hold stays
        const e = sec.edits[i];
        if (e && e.removed) delete sec.edits[i];
      }
    }
    if (on && sec.blendStrength == null) sec.blendStrength = BLEND_DEFAULT;
  } else {
    for (const i of items) {
      delete sec.edits[i];
      keep.delete(i);
      blend.delete(i);
    }
  }
  sec.keep = [...keep].sort((a, b) => a - b);
  sec.blend = [...blend].sort((a, b) => a - b);
  renderBlend(sec);
  afterEdit(sec);
}

function afterEdit(sec) {
  if (sec.check) sec.check.stale = true;
  state.project.invalidateNeighbours(sec, wasm.context_seconds(state.config));
  state.project.save();
  renderGridMarks();
  renderVerdict(sec);
  renderSectionList();
  renderUndo();
  renderPlayerWarning();
  drawChart();
  if ($('autoCheck').checked) scheduleCheck(120);
  // a section playing edited picks the change up where it is
  if (sec.id === state.current && state.player.mode === 'edited' && sectionPlayer && sectionPlayer.active && !sectionPlayer.paused) {
    clearTimeout(state.player.restartTimer);
    state.player.restartTimer = setTimeout(() => playSection(Math.max(0, sectionPlayer.slot)), 150);
  }
}

// ---- undo / redo of a section's marks --------------------------------------------------

function historyOf(sec) {
  let h = state.history.get(sec.id);
  if (!h) {
    h = { undo: [], redo: [] };
    state.history.set(sec.id, h);
  }
  return h;
}

function markSnapshot(sec) {
  return JSON.stringify({ edits: sec.edits || {}, keep: sec.keep || [], soften: !!sec.soften, blend: sec.blend || [], blendStrength: sec.blendStrength == null ? null : sec.blendStrength });
}

/** Remember a section's marks before a change, for undo. */
function pushHistory(sec) {
  const h = historyOf(sec);
  const snap = markSnapshot(sec);
  if (h.undo[h.undo.length - 1] !== snap) h.undo.push(snap);
  if (h.undo.length > 200) h.undo.shift();
  h.redo = [];
  renderUndo();
}

function restoreMarks(sec, snap) {
  const o = JSON.parse(snap);
  sec.edits = o.edits || {};
  sec.keep = o.keep || [];
  sec.soften = !!o.soften;
  sec.blend = o.blend || [];
  sec.blendStrength = o.blendStrength == null ? null : o.blendStrength;
}

function undo() {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const h = historyOf(sec);
  if (!h.undo.length) return toast('Nothing to undo');
  h.redo.push(markSnapshot(sec));
  restoreMarks(sec, h.undo.pop());
  renderSoften(sec);
  renderBlend(sec);
  afterEdit(sec);
}

function redo() {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const h = historyOf(sec);
  if (!h.redo.length) return toast('Nothing to redo');
  h.undo.push(markSnapshot(sec));
  restoreMarks(sec, h.redo.pop());
  renderSoften(sec);
  renderBlend(sec);
  afterEdit(sec);
}

function renderUndo() {
  const sec = currentSection();
  const h = sec ? state.history.get(sec.id) : null;
  $('btnUndo').disabled = !h || !h.undo.length;
  $('btnRedo').disabled = !h || !h.redo.length;
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
    const c = await withFeeder(() => checkSection(state.env, state.project, sec, null, { extS: EXT_S }));
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
  // (before the eviction: a running job may be reading another section's frames)
  if (busy('prepare the section')) return false;
  state.project.evictCaches(sec, cacheBudget());
  const ok = await runJob(`Preparing section #${sec.id}`, async (progress, cancelled) => {
    await prepareSection(state.env, state.movie, sec, {
      cancel: cancelled,
      spans: scanSegments(),
      moreFeeders: spareFeeders,
      onProgress: (n) => progress(Math.min(0.95, n / Math.max(1, (sec.end - sec.start + 2 * wasm.context_seconds(state.config)) * state.movie.fps)), `${n} frames decoded`),
    });
    return !cancelled();
  });
  if (!ok) {
    // a cancelled prepare decoded only part of the section: forget it
    dropCaches(sec);
    renderAll();
    return false;
  }
  sec.check = null;
  await state.project.save();
  renderAll();
  updateStatus();
  if (state.current === sec.id) {
    scheduleCheck(0);
    if (state.player.mode !== 'video' && !sectionPlayer.active) posterSection();
  }
  return true;
}


/**
 * Take a suggester's result into the section (undoably): its edits (frames
 * marked keep keep theirs), its verdict (or none), and the neighbours'
 * checks go stale.
 */
function applySuggestion(sec, res, only) {
  pushHistory(sec);
  sec.edits = JSON.parse(wasm.apply_suggestion(JSON.stringify(sec.edits || {}), JSON.stringify(res.edits), only ? JSON.stringify(only) : undefined, keepJson(sec)));
  sec.check = res.verdict || null;
  state.project.invalidateNeighbours(sec, wasm.context_seconds(state.config));
  if (sec.id === state.current && state.player.mode === 'edited' && sectionPlayer && sectionPlayer.active && !sectionPlayer.paused) playSection(Math.max(0, sectionPlayer.slot));
}

async function doSuggest(prefer) {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const only = $('suggestSelOnly').checked && state.selection.size ? Array.from(state.selection) : null;
  const what = prefer === 'fewest' ? 'fewest removals' : `keep ${prefer}`;
  const res = await runJob(`Suggesting (${what})`, async (progress) => suggestEdits(state.env, state.project, sec, prefer, only, { extS: EXT_S, onProgress: (r) => progress(Math.min(0.95, 0.1 + r * 0.08), `check ${r + 1}`) }));
  if (!res) return;
  applySuggestion(sec, res, only);
  await state.project.save();
  renderAll();
  toast(res.note, 6000);
}

/** Lower contrast: blend the flashing frames with the frames around them, as little as passes. */
async function doSuggestBlend() {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const only = $('suggestSelOnly').checked && state.selection.size ? Array.from(state.selection) : null;
  const res = await runJob('Suggesting (lower contrast)', async (progress) => suggestBlend(state.env, state.project, sec, only, { extS: EXT_S, onProgress: (r) => progress(Math.min(0.95, 0.05 + r * 0.09), `check ${r + 1}`) }));
  if (!res) return;
  pushHistory(sec);
  sec.edits = res.edits;
  sec.blend = res.blend;
  sec.blendStrength = res.strength;
  sec.check = res.verdict || null;
  state.project.invalidateNeighbours(sec, wasm.context_seconds(state.config));
  if (sec.id === state.current && state.player.mode === 'edited' && sectionPlayer && sectionPlayer.active && !sectionPlayer.paused) playSection(Math.max(0, sectionPlayer.slot));
  await state.project.save();
  renderAll();
  toast(res.note, 8000);
}

/** Reduce FPS: from twice the guaranteed-safe rate down, a tenth at a time, to the first rate that passes. */
async function doSuggestFps() {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const only = $('suggestSelOnly').checked && state.selection.size ? Array.from(state.selection) : null;
  const res = await runJob('Reducing the frame rate', async (progress) =>
    searchFrameRate(state.env, state.project, sec, only, { extS: EXT_S, sourceFps: state.movie.fps, onProgress: (p, r) => progress(p, `checking ${r} pictures/s`) })
  );
  if (!res) return;
  applySuggestion(sec, res, only);
  sec.fpsFound = res.fps;
  $('fpsInput').value = String(res.fps);
  await state.project.save();
  renderAll();
  toast(res.note, 9000);
}

/** Reduce FPS to exactly the rate typed in the menu. */
async function doSuggestFpsExact() {
  const sec = currentSection();
  if (!sec || !sec.prepared) return;
  const v = parseFloat($('fpsInput').value);
  if (!(v > 0)) return toast('Type a rate, in pictures a second');
  const only = $('suggestSelOnly').checked && state.selection.size ? Array.from(state.selection) : null;
  const res = await runJob(`Thinning to ${v} pictures/s`, async () => suggestFrameRate(state.env, state.project, sec, only, v, { extS: EXT_S }));
  if (!res) return;
  applySuggestion(sec, res, only);
  sec.fpsFound = res.fps;
  await state.project.save();
  renderAll();
  toast(res.note, 7000);
}

// ---- chart -------------------------------------------------------------------------------

/**
 * What the chart shows: the open section while the player plays it, else
 * the whole video around the playhead.
 */
function chartMode() {
  return currentSection() && state.player.mode !== 'video' ? 'section' : 'video';
}

const CHART_SPANS = [10, 30, 120, 0];

function chartSpanSetting() {
  try {
    const v = localStorage.getItem('unflash.chartSpan');
    if (v !== null && CHART_SPANS.includes(+v)) return +v;
  } catch (e) {
    /* no storage */
  }
  return 30;
}

function setChartSpan(span, redraw = true) {
  state.chartSpan = span;
  try {
    localStorage.setItem('unflash.chartSpan', String(span));
  } catch (e) {
    /* no storage */
  }
  for (const b of document.querySelectorAll('#chartSpan [data-span]')) b.classList.toggle('on', +b.dataset.span === span);
  if (redraw) drawChart();
}

/** The stretch of the video the whole-video chart shows: `chartSpan` seconds around the playhead, or all of it. */
function videoChartRange() {
  const [lo, hi] = state.project.bounds;
  const span = state.chartSpan;
  if (!span || span >= hi - lo) return [lo, hi];
  const ct = $('player').currentTime || lo;
  const t0 = Math.max(lo, Math.min(ct - span / 2, hi - span));
  return [t0, t0 + span];
}

/** Index of the first of `ts` (ascending) at or after `t`. */
function lowerBound(ts, t) {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}


/** The scan's verdict on the whole video, for the section list and the chart. */
function scanStatus() {
  const p = state.project;
  if (!p) return null;
  if (state.job && state.job.name === 'Scanning for flashes') return { badge: '<span class="badge">scanning…</span>', text: 'scanning…' };
  const s = p.scan;
  if (!s) return { badge: '<span class="badge">not scanned</span>', text: state.decode.supported ? 'not scanned yet' : 'this browser cannot scan it' };
  if (s.sig !== wasm.config_signature(state.config)) return { badge: '<span class="badge stale">scan again</span>', text: 'scanned under another profile: scan again' };
  const kinds = `flashing${s.flag_extended ? ' (extended flashes included)' : ''}${s.flag_patterns ? ' or stripe patterns' : ''}`;
  if (s.safe) return { badge: '<span class="badge safe">nothing found</span>', text: `✓ no ${kinds} found in ${s.frames} frames`, safe: true, kinds };
  return { badge: `<span class="badge unsafe">${s.counted} found</span>`, text: `${s.counted} violation${s.counted === 1 ? '' : 's'} found in ${s.frames} frames` };
}

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
  const video = chartMode() === 'video';
  $('chartSpan').classList.toggle('hidden', !video || !state.project);
  if (video) return drawVideoChart(g, W, H);
  $('chartTitle').textContent = `Section #${sec.id}, frame by frame`;
  if (!sec.prepared || !sec.check || !sec.check.stats || !sec.check.stats.t.length) {
    $('chartHint').textContent = 'The chart appears once the section has been checked.';
    return;
  }
  const st = sec.check.stats;
  const n = st.t.length;
  const thresh = sec.check.area_thresh || 1;
  const mid = H * 0.62;
  const bw = W / n;
  $('chartHint').textContent = 'Brightness (line) and how much of the window is changing (bars: brightening up, darkening down, magenta for red, orange when the flash rate is over the limit). The blue line is flashing at the limit rate (extended flashes are made of it; shaded blue where one is), the teal line how much of the picture is a stripe pattern. Red shading is removed, blue is held, violet is blended. Click to jump to a frame.';
  const blendSet = new Set(blendMarks(sec));
  // frames only an extended flash flags
  const extOnly = new Set();
  const inFlash = new Set();
  for (const f of findings(sec)) for (const i of f.frames) (f.kind === 'extended' ? extOnly : inFlash).add(i);
  for (const i of inFlash) extOnly.delete(i);
  for (let i = 0; i < n; i++) {
    const e = (sec.edits || {})[i] || {};
    if (blendSet.has(i) && !e.removed) {
      g.fillStyle = tint(ink.blend, 0.22);
      g.fillRect(i * bw, 0, bw + 0.5, H);
    }
    if (e.removed) {
      g.fillStyle = tint(ink.bad, 0.22);
      g.fillRect(i * bw, 0, bw + 0.5, H);
    } else if (e.extended) {
      g.fillStyle = tint(ink.held, 0.22);
      g.fillRect(i * bw, 0, bw + 0.5, H);
    }
    if (sec.check.flagged && sec.check.flagged.includes(i)) {
      g.fillStyle = extOnly.has(i) ? tint(ink.ext, 0.14) : tint(ink.flash, 0.12);
      g.fillRect(i * bw, 0, bw + 0.5, H);
    }
  }
  const scale = (H * 0.36) / (thresh * 1.5);
  for (let i = 0; i < n; i++) {
    const x = i * bw;
    const up = st.up[i] * scale;
    const dn = st.down[i] * scale;
    g.fillStyle = st.hazard[i] >= thresh ? ink.flash : tint(ink.flash, 0.5);
    g.fillRect(x, mid - up, Math.max(1, bw - 0.5), up);
    g.fillRect(x, mid, Math.max(1, bw - 0.5), dn);
    const red = st.red[i] * scale;
    if (red > 0) {
      g.fillStyle = st.hazardRed[i] >= thresh ? ink.red : tint(ink.red, 0.6);
      g.fillRect(x, mid - red, Math.max(1, bw - 0.5), red);
    }
  }
  g.strokeStyle = tint(ink.fg, 0.35);
  g.beginPath();
  g.moveTo(0, mid - thresh * scale);
  g.lineTo(W, mid - thresh * scale);
  g.moveTo(0, mid + thresh * scale);
  g.lineTo(W, mid + thresh * scale);
  g.stroke();
  g.strokeStyle = ink.fg;
  g.lineWidth = 1.2;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const y = H * 0.55 - st.lum[i] * H * 0.5;
    if (i === 0) g.moveTo(i * bw + bw / 2, y);
    else g.lineTo(i * bw + bw / 2, y);
  }
  g.stroke();
  if (st.ext && st.ext.length === n) {
    g.strokeStyle = ink.ext;
    g.lineWidth = 1.2;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const yv = mid - st.ext[i] * scale;
      if (i === 0) g.moveTo(i * bw + bw / 2, yv);
      else g.lineTo(i * bw + bw / 2, yv);
    }
    g.stroke();
  }
  if (st.pattern && st.pattern.length === n && sec.check.pattern_thresh) {
    const pt = sec.check.pattern_thresh;
    g.strokeStyle = ink.pat;
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
    g.fillStyle = tint(ink.sel, 0.35);
    g.fillRect(i * bw, 0, bw + 0.5, H);
  }
}

/**
 * The whole video around the playhead, from the scan: per pixel column, how
 * much of the screen flashed faster than the limit (bars; general and red,
 * as a share of the area limit), how much flashed at the limit rate (the
 * blue line: extended flashes are built from it), the stripes (teal) and
 * the brightness (grey), under the sections and what the scan found. It
 * shows the flashing that stays under the limit too, to see what is close
 * to a section or close to failing.
 */
function drawVideoChart(g, W, H) {
  const hint = $('chartHint');
  const title = $('chartTitle');
  if (!state.project || !state.movie) {
    title.textContent = '';
    hint.textContent = 'Open a video to see its flashing over time.';
    return;
  }
  const [t0, t1] = videoChartRange();
  const span = Math.max(1e-6, t1 - t0);
  const x = (t) => ((t - t0) / span) * W;
  const scan = state.project.scan;
  const [lo, hi] = state.project.bounds;
  title.textContent = t0 <= lo + 1e-6 && t1 >= hi - 1e-6 ? 'Whole video' : `Whole video, ${fmt(t0)} – ${fmt(t1)}`;
  const top = 13;
  const bottom = H - 16;
  const plotH = bottom - top;
  // per column of the chart: the most any frame showing in it reached, and
  // its mean brightness (a frame fills the columns it is on screen for, so a
  // short video draws unbroken lines)
  const n = normTrace();
  const cols = Math.max(1, Math.floor(W));
  const hmax = new Float32Array(cols);
  const rmax = new Float32Array(cols);
  const emax = new Float32Array(cols);
  const pmax = new Float32Array(cols);
  const lsum = new Float32Array(cols);
  const lcnt = new Uint32Array(cols);
  let peak = 0;
  if (n && n.t.length) {
    const med = state.movie.medianDelta || 1 / 30;
    const first = Math.max(0, lowerBound(n.t, t0) - 1);
    const env = limitRateEnvelope(n, first, t1);
    for (let i = first; i < n.t.length && n.t[i] <= t1; i++) {
      const ta = n.t[i];
      const tb = i + 1 < n.t.length ? Math.min(n.t[i + 1], ta + 1) : ta + med;
      const c0 = Math.max(0, Math.floor(x(ta)));
      const c1 = Math.min(cols - 1, Math.max(c0, Math.ceil(x(tb)) - 1));
      const e = env[i - first];
      for (let c = c0; c <= c1; c++) {
        if (n.h[i] > hmax[c]) hmax[c] = n.h[i];
        if (n.r[i] > rmax[c]) rmax[c] = n.r[i];
        if (e > emax[c]) emax[c] = e;
        if (n.p[i] > pmax[c]) pmax[c] = n.p[i];
        lsum[c] += n.l[i];
        lcnt[c]++;
      }
      peak = Math.max(peak, n.h[i], n.r[i], e, scan && scan.flag_patterns ? n.p[i] : 0);
    }
  }
  // levels as shares of the limit: room for the highest in view, up to eight times it
  const MAXL = Math.min(8, Math.max(1.5, peak * 1.1));
  const y = (lev) => bottom - (Math.min(MAXL, Math.max(0, lev)) / MAXL) * plotH;
  // the sections
  g.font = ink.font(10);
  for (const s of state.project.sectionsSorted()) {
    if (s.end < t0 || s.start > t1) continue;
    const x0 = Math.max(0, x(s.start));
    const x1 = Math.min(W, Math.max(x0 + 2, x(s.end)));
    g.fillStyle = state.current === s.id ? tint(ink.fg, 0.16) : tint(ink.fg, 0.06);
    g.fillRect(x0, top, x1 - x0, plotH);
    g.fillStyle = ink.fg2;
    g.fillText(`#${s.id}`, x0 + 3, top + 10);
  }
  // what the scan found, along the top
  const found = state.scanning ? state.scanning.violations : scan ? scan.violations.filter((v) => scanReports(scan, v)) : [];
  for (const v of found) {
    if (v.end < t0 || v.start > t1) continue;
    g.fillStyle = kindInk(v.kind);
    const x0 = Math.max(0, x(v.start));
    g.fillRect(x0, 2, Math.max(2, Math.min(W, x(v.end)) - x0), 7);
  }
  if (n && n.t.length) {
    // bars: flashing faster than the limit, general then red
    for (let c = 0; c < cols; c++) {
      if (hmax[c] > 0) {
        g.fillStyle = hmax[c] >= 1 ? ink.flash : tint(ink.flash, 0.55);
        g.fillRect(c, y(hmax[c]), 1, bottom - y(hmax[c]));
      }
      if (rmax[c] > 0) {
        g.fillStyle = rmax[c] >= 1 ? ink.red : tint(ink.red, 0.6);
        g.fillRect(c, y(rmax[c]), 1, bottom - y(rmax[c]));
      }
    }
    // lines: brightness, flashing at the limit rate, stripes
    const line = (vals, colour, level, cnt = null) => {
      g.strokeStyle = colour;
      g.lineWidth = 1.2;
      g.beginPath();
      let on = false;
      for (let c = 0; c < cols; c++) {
        if (cnt && !cnt[c]) {
          on = false;
          continue;
        }
        const v = level(vals[c], c);
        if (v == null) {
          on = false;
          continue;
        }
        if (on) g.lineTo(c + 0.5, v);
        else g.moveTo(c + 0.5, v);
        on = true;
      }
      g.stroke();
    };
    line(lsum, tint(ink.fg, 0.45), (v, c) => bottom - (v / lcnt[c]) * plotH * 0.9, lcnt);
    line(emax, ink.ext, (v) => y(v), lcnt);
    if (scan && scan.flag_patterns) line(pmax, ink.pat, (v) => y(v), lcnt);
  }
  // the limit
  g.save();
  g.setLineDash([4, 3]);
  g.strokeStyle = tint(ink.fg, 0.45);
  g.beginPath();
  g.moveTo(0, y(1) + 0.5);
  g.lineTo(W, y(1) + 0.5);
  g.stroke();
  g.restore();
  g.fillStyle = tint(ink.fg, 0.6);
  const limitLabel = MAXL > 1.6 ? `limit (top: ${Math.round(MAXL * 10) / 10}×)` : 'limit';
  g.fillText(limitLabel, W - g.measureText(limitLabel).width - 4, y(1) - 3);
  // time ticks and the playhead
  g.fillStyle = ink.fg2;
  const step = niceStep(span / Math.max(2, W / 90));
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    g.fillRect(x(t), bottom, 1, 3);
    g.fillText(fmt(t), x(t) + 2, H - 3);
  }
  const ct = $('player').currentTime;
  if (ct >= t0 && ct <= t1) {
    g.fillStyle = ink.fg;
    g.fillRect(x(ct), 0, 1.5, H);
  }
  // the words under it
  const st = scanStatus();
  let lead = '';
  if (!n || !n.t.length) lead = st && st.text === 'scanning…' ? 'Scanning… ' : 'Scan the video to chart its flashing. ';
  else if (st && st.safe) {
    const pk = n.peak;
    const worst = pk.h[0] >= pk.r[0] ? ['general', pk.h] : ['red', pk.r];
    lead = `<span class="found-none">✓ No ${st.kinds} found.</span> ${worst[1][0] > 0 ? `The closest it came: ${Math.round(worst[1][0] * 100)}% of the area limit (${worst[0]} flashing, at ${fmt(worst[1][1])}). ` : 'Nothing flashes faster than the limit anywhere. '}`;
  }
  hint.innerHTML = `${lead}Bars: how much of the screen flashes faster than the limit (orange; magenta for red), as a share of the area limit (the dashed line). Blue: flashing at the limit rate, which extended flashes are made of; grey: brightness${scan && scan.flag_patterns ? '; teal: stripes' : ''}. Boxes are sections; the strip along the top is what the scan found. Click to play from there.`;
}

/** Seconds either side over which "flashing at the limit rate" is read: it comes in spikes, one per transition. */
const ENVELOPE_S = 0.25;

/**
 * The trace's flashing at the limit rate as an envelope, from frame `first`
 * to the last at or before `t1`: at each frame the most within
 * ENVELOPE_S either side, so a stretch of it reads as one.
 */
function limitRateEnvelope(n, first, t1) {
  const out = [];
  const q = []; // frames in the window, their values falling
  let hi = first;
  let lo = first;
  for (let i = first; i < n.t.length && n.t[i] <= t1; i++) {
    while (hi < n.t.length && n.t[hi] <= n.t[i] + ENVELOPE_S) {
      while (q.length && n.e[q[q.length - 1]] <= n.e[hi]) q.pop();
      q.push(hi++);
    }
    while (lo < i && n.t[lo] < n.t[i] - ENVELOPE_S) lo++;
    while (q.length && q[0] < lo) q.shift();
    // (frames before `first` count too)
    let e = q.length ? n.e[q[0]] : 0;
    for (let j = first - 1; j >= 0 && n.t[j] >= n.t[i] - ENVELOPE_S; j--) e = Math.max(e, n.e[j]);
    out.push(e);
  }
  return out;
}

/** The readout under the pointer on the whole-video chart. */
function chartTip(e) {
  const tip = $('chartTip');
  const n = chartMode() === 'video' && state.project ? normTrace() : null;
  if (!n || !n.t.length) return tip.classList.add('hidden');
  const r = $('chart').getBoundingClientRect();
  const [t0, t1] = videoChartRange();
  const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
  const i = Math.min(n.t.length - 1, lowerBound(n.t, t));
  const pct = (v) => `${Math.round(v * 100)}%`;
  const sec = state.project.sectionsSorted().find((s) => t >= s.start && t <= s.end);
  const atLimit = limitRateEnvelope(n, i, n.t[i])[0];
  tip.textContent = `${fmt(n.t[i])} · faster than the limit ${pct(n.h[i])}${n.r[i] > 0 ? `, red ${pct(n.r[i])}` : ''} · at the limit rate ${pct(atLimit)}${n.p[i] > 0 ? ` · stripes ${pct(n.p[i])}` : ''}${sec ? ` · section #${sec.id}` : ''}`;
  tip.classList.remove('hidden');
  const w = tip.offsetWidth;
  tip.style.left = `${Math.max(2, Math.min(r.width - w - 2, e.clientX - r.left + 10))}px`;
}

// ---- export ----------------------------------------------------------------------------

async function openExport() {
  const p = state.project;
  if (!p) return;
  const rows = p.sectionsSorted().map((s) => {
    const marks = Object.values(s.edits || {}).filter((e) => e.removed || e.extended).length + (s.blend || []).length;
    const applies = marks || (s.soften && softenPlan(s));
    const status = !applies ? 'nothing to apply' : !(s.pts && s.pts.length) ? 'has marks but was never prepared: marks will NOT be applied' : s.check && !s.check.stale ? (s.check.safe ? 'passes' : 'still failing') : 'unchecked';
    return `<tr><td>#${s.id}</td><td>${fmt(s.start)} – ${fmt(s.end)}</td><td>${marks} marks</td><td>${status}</td></tr>`;
  });
  $('exportSummary').innerHTML = rows.length ? `<table><tr><th>section</th><th>range</th><th>edits</th><th>status</th></tr>${rows.join('')}</table>` : '<p class="hint">No sections. The export re-encodes the video unchanged.</p>';
  const sel = $('exportCodec');
  const previous = sel.value;
  sel.innerHTML = '';
  const cands = formatChoices(await encoderCandidates(state.movie.width, state.movie.height, state.movie.fps, +$('exportQuality').value));
  state.exportCands = cands;
  for (const c of cands) {
    const info = formatInfo(c, state.movie);
    const o = document.createElement('option');
    o.value = c.label;
    o.textContent = info.label + (c === cands[0] ? ' (recommended)' : '');
    o.title = c.config.codec;
    sel.appendChild(o);
  }
  if (cands.some((c) => c.label === previous)) sel.value = previous;
  await renderExportChoice();
  $('btnDoExport').disabled = !cands.length || !state.decode.supported;
  if (!state.exportBlob) $('exportResult').innerHTML = '';
  $('exportDownload').classList.toggle('hidden', !(state.exportBlob && $('exportDownload').getAttribute('href')));
  $('btnVerifyExport').disabled = !state.exportBlob;
  $('exportModal').classList.remove('hidden');
}

/** The export dialog's lines for the chosen format: what it means, what will be re-encoded, how big. */
async function renderExportChoice() {
  const cands = state.exportCands || [];
  const chosen = cands.find((c) => c.label === $('exportCodec').value) || cands[0];
  const softened = state.project.sectionsSorted().filter((s) => s.soften && softenPlan(s));
  const blended = state.project.sectionsSorted().filter((s) => s.pts && s.pts.length && blendMarks(s).length);
  const plan = chosen ? await exportPlan(state.env, state.movie, state.project, { extS: EXT_S, codec: chosen.config.codec, smartCut: smartCutSetting(), parallel: parallelSetting() }) : null;
  state.exportPlan = plan;
  $('exportFormatNote').textContent = chosen ? formatInfo(chosen, state.movie).note : '';
  $('exportPlan').textContent = plan ? describePlan(plan, state.movie, softened, blended) : 'This browser has no WebCodecs video encoder, so it cannot export.';
  const need = estimateExportBytes(state.movie, +$('exportQuality').value, plan);
  $('exportSize').textContent = chosen ? `About ${fmtBytes(need)}. ${window.showSaveFilePicker ? 'You will be asked where to save it.' : privateStorageAvailable() ? "It is written to the browser's private storage on disk and offered for download." : `It is assembled in memory and offered for download${need > memoryExportLimit() ? ', which is more than this browser is likely to hold' : ''}.`}` : '';
}

async function doExport() {
  if (busy('export')) return;
  const movie = state.movie;
  const quality = +$('exportQuality').value;
  // a file of the user's choosing where the browser has the dialog, private
  // storage on disk where it has that, memory as the last resort
  let sinkInfo = await pickSaveSink(exportName(movie));
  if (sinkInfo && sinkInfo.cancelled) return;
  if (!sinkInfo) sinkInfo = await privateFileSink(estimateExportBytes(movie, quality, state.exportPlan));
  $('exportModal').classList.add('hidden');
  const res = await runJob('Exporting', async (progress, cancelled) =>
    exportMovie(state.env, movie, state.project, {
      encoder: $('exportCodec').value,
      quality,
      extS: EXT_S,
      sink: sinkInfo ? sinkInfo.sink : null,
      cancel: cancelled,
      smartCut: smartCutSetting(),
      parallel: parallelSetting(),
      onProgress: (p, frames, ms, copied, sound) => progress(p, exportProgressText(frames, ms, copied, sound)),
    })
  );
  $('exportModal').classList.remove('hidden');
  if (!res) {
    if (sinkInfo) await sinkInfo.sink.abort();
    return;
  }
  await readBackExport(res, sinkInfo);
  showExportResult(res, exportName(movie));
  if (res.saved) {
    state.exportBlob = res.saved;
    $('btnVerifyExport').disabled = false;
  }
}

function exportProgressText(frames, ms, copied, sound) {
  return `${frames} frames encoded${copied ? ` · ${copied} copied` : ''} · ${(frames / (ms / 1000)).toFixed(0)} fps${sound != null ? ` · the sound, re-encoded: ${Math.round(sound * 100)}%` : ''}`;
}

/** What an export did, for the dialog and the auto-fix strip. */
function exportSummary(res) {
  const total = res.frames + (res.copied || 0);
  const parts = [`${res.frames} re-encoded with ${res.encoderLabel} (${res.codec})${res.spans > 1 ? ` in ${res.spans} spans` : ''}`];
  if (res.copied) parts.push(`${res.copied} copied from the source as they are`);
  return `Exported ${total} frames in ${(res.elapsedMs / 1000).toFixed(1)} s: ${parts.join(', ')}${res.blended ? `; ${res.blended} blended` : ''}${res.softened ? `; ${res.softened} softened` : ''}.`;
}

/**
 * An export that streamed to disk is read back as a File: from private
 * storage it is what the dialog offers for download (`res.blob`); from the
 * user's own file it is only there to verify (`res.saved`).
 */
async function readBackExport(res, sinkInfo) {
  if (res.blob || !sinkInfo || !sinkInfo.handle) return;
  try {
    const file = await sinkInfo.handle.getFile();
    if (sinkInfo.private) res.blob = file;
    else res.saved = file;
  } catch (e) {
    /* no read access to the chosen file */
  }
}

function exportName(movie) {
  return movie.name.replace(/\.[^.]+$/, '') + '.unflashed.mp4';
}

// ---- project files ------------------------------------------------------------

function wireProjectMenu() {
  $('btnProject').addEventListener('click', (e) => {
    e.stopPropagation();
    $('alertsMenu').classList.add('hidden');
    $('projectMenu').classList.toggle('hidden');
    renderProjectNote();
  });
  $('projectMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => $('projectMenu').classList.add('hidden'));
  $('btnProjectSave').addEventListener('click', saveProjectFile);
  $('projectInput').addEventListener('change', async () => {
    const f = $('projectInput').files[0];
    $('projectInput').value = '';
    $('projectMenu').classList.add('hidden');
    if (f) await loadProjectFile(f);
  });
}

/** What the project here holds, under the menu's buttons. */
function renderProjectNote() {
  const p = state.project;
  if (!p) return ($('projectNote').textContent = '');
  const marks = p.sections.reduce((n, s) => n + Object.values(s.edits || {}).filter((e) => e.removed || e.extended).length + (s.blend || []).length, 0);
  $('projectNote').textContent = `Here now: ${p.sections.length} section${p.sections.length === 1 ? '' : 's'}${marks ? `, ${marks} marks` : ''}${p.scan ? ', a scan' : ''}.`;
}

/** Download the project as a file. */
async function saveProjectFile() {
  const p = state.project;
  if (!p || !state.movie) return;
  $('projectMenu').classList.add('hidden');
  await p.save();
  const blob = new Blob([projectFileText(p, state.movie, state.movie.file)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.movie.name.replace(/\.[^.]+$/, '') + '.unflash.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  state.lastProjectFile = blob; // (tests read it back)
  toast(`Saved the project (${p.sections.length} section${p.sections.length === 1 ? '' : 's'}) as ${a.download}.`);
}

/** Load a project file for the open video: its sections, marks and scan replace the ones here. */
async function loadProjectFile(f) {
  const p = state.project;
  if (!p || !state.movie) return toast('Open the video the project is for, then load the project.');
  let doc;
  try {
    doc = readProjectFile(await f.text());
  } catch (e) {
    return banner(e.message);
  }
  const m = matchVideo(doc.video, state.movie, state.movie.file);
  if (!m.ok) return banner(m.why);
  const n = doc.saved.sections.length;
  const here = p.sections.length;
  if (here && !confirm(`Replace the ${here} section${here === 1 ? '' : 's'} here (and their marks) with the ${n} in ${f.name}?`)) return;
  await stopAuto();
  if (state.job) return toast('Wait for the job under way to finish (or cancel it), then load the project.');
  if (sectionPlayer) await sectionPlayer.stop();
  closeViewer();
  for (const s of p.sections) dropCaches(s);
  const before = p.profile;
  p.restore(doc.saved);
  state.current = null;
  state.history.clear();
  state.lastScan = null;
  state.scanTrace = p.scan && p.scan.trace ? p.scan.trace : null;
  state.traceNorm = null;
  if (p.profile !== before) {
    $('profileSel').value = p.profile;
    state.config = profileConfig(p.profile);
    await withFeeder(() => createFeeders());
  }
  await p.save();
  setPlayerSource('video');
  renderAll();
  updateStatus();
  toast(`Loaded ${f.name}: ${n} section${n === 1 ? '' : 's'}${p.scan ? ' and the scan' : ''}${m.same ? '' : '. It was saved for another copy of this video (its frames match)'}. Sections are prepared again when opened.`, 8000);
}

/** Show a finished export in the export dialog: what was written, a download link, and the verify button. */
function showExportResult(res, name) {
  const lines = [exportSummary(res), ...res.warnings];
  $('exportResult').innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
  // the dialog offers this export and no earlier one
  const a = $('exportDownload');
  if (a.getAttribute('href')) {
    URL.revokeObjectURL(a.href);
    a.removeAttribute('href');
  }
  state.exportBlob = res.blob || null;
  a.classList.toggle('hidden', !res.blob);
  $('btnVerifyExport').disabled = !res.blob;
  if (!res.blob) return;
  a.href = URL.createObjectURL(res.blob);
  a.download = name;
}

/** Drop the last file's unattended run and export, object URLs included. */
function forgetExport() {
  if (state.auto && state.auto.blobUrl) URL.revokeObjectURL(state.auto.blobUrl);
  state.auto = null;
  renderAuto();
  state.exportBlob = null;
  const a = $('exportDownload');
  if (a.getAttribute('href')) {
    URL.revokeObjectURL(a.href);
    a.removeAttribute('href');
  }
  a.classList.add('hidden');
  $('btnVerifyExport').disabled = true;
  discardPrivateExport();
}

async function verifyExport() {
  if (!state.exportBlob) return;
  $('exportModal').classList.add('hidden');
  const v = await verifyBlob(state.exportBlob);
  $('exportModal').classList.remove('hidden');
  if (!v) return;
  $('exportResult').innerHTML += `<p>${v.html}</p>`;
}

/**
 * Re-scan an exported file with the current profile. Returns the scan, the
 * verdict as HTML for the dialog and as plain text, and the WCAG failures.
 */
async function verifyBlob(blob) {
  const res = await runJob('Verifying the exported file', async (progress, cancelled) => {
    const m = await Movie.open(blob, wasm);
    const feeder = await makeFeeder(m.width, m.height);
    m.decodeInWorkers = decodeWorkersSetting(feeder);
    m.shrinkInWorkers = shrinkSetting();
    try {
      return await scanWithPlan({ wasm, config: state.config, feeder }, m, {
        cancel: cancelled,
        segments: scanSegments(),
        forceSegments: segmentsForced(),
        makeFeeder: () => makeFeeder(m.width, m.height),
        onProgress: (p, _t, count, ms) => progress(p, `${count} frames · ${(count / (ms / 1000)).toFixed(0)} fps`),
      });
    } finally {
      feeder.det.free();
      m.close();
    }
  });
  if (!res) return null;
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
  const html = `${msg} (${res.frames} frames re-scanned in ${(res.elapsedMs / 1000).toFixed(1)} s)`;
  return { res, wcagBad, html, text: html.replace(/<[^>]+>/g, '') };
}

// ---- auto-fix: open a file, and the scan, the fixes, the export and its check follow -----

/**
 * The switch in the header starts as `?auto=0` / `?auto=1` says, else as it
 * was last left, else off: what auto-fix makes is a starting point that
 * hand editing beats, so it is something to ask for.
 */
function initialAutoSetting() {
  const q = new URLSearchParams(location.search).get('auto');
  if (q === '0' || q === 'off') return false;
  if (q === '1' || q === 'on') return true;
  try {
    return localStorage.getItem('unflash:auto') === '1';
  } catch (e) {
    return false;
  }
}

/** Whether a file is scanned as soon as it is opened: always, except with `?auto=0` (nothing automatic at all). */
function autoScanEnabled() {
  const q = new URLSearchParams(location.search).get('auto');
  return !(q === '0' || q === 'off');
}

/** Whether opening a file (or changing the profile) starts the unattended run: the switch decides. */
function autoEnabled() {
  return $('autoToggle').checked;
}

const AUTO_STEPS = [
  ['scan', 'scan'],
  ['fix', 'fix'],
  ['export', 'export'],
  ['verify', 'verify'],
];

function autoStep(auto, name, status, text = '') {
  auto.steps[name] = { status, text };
  if (state.auto === auto) renderAuto();
}

function renderAuto() {
  const a = state.auto;
  const box = $('auto');
  if (!a) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const steps = $('autoSteps');
  steps.innerHTML = '';
  for (const [key, label] of AUTO_STEPS) {
    const s = a.steps[key] || { status: 'pending', text: '' };
    const el = document.createElement('span');
    el.className = `auto-step ${s.status}`;
    el.dataset.step = key;
    const b = document.createElement('b');
    b.textContent = label;
    el.appendChild(b);
    if (s.text) {
      const t = document.createElement('span');
      t.textContent = s.text;
      el.appendChild(t);
    }
    steps.appendChild(el);
  }
  $('autoSummary').textContent = a.summary || '';
  $('btnAutoStop').classList.toggle('hidden', !a.running);
  $('btnAutoRerun').classList.toggle('hidden', a.running);
  $('autoDownload').classList.toggle('hidden', !a.blobUrl);
}

/** One line about a stored scan. */
function describeScan(s) {
  if (!s) return '';
  const n = s.counted != null ? s.counted : s.violations.length;
  const np = s.patterns || 0;
  if (!n) return `nothing found in ${s.frames} frames`;
  return `${n} violation${n === 1 ? '' : 's'}${np ? ` (${np} stripe pattern${np === 1 ? '' : 's'})` : ''} in ${s.frames} frames`;
}

/** Stop the unattended run (cancelling the job it is on) and wait for it to end. */
async function stopAuto() {
  const a = state.auto;
  if (!a || !a.running) return;
  a.stopped = true;
  const until = performance.now() + 30000;
  while (a.running && performance.now() < until) {
    // whatever job the run is on, or starts next, is cancelled too
    if (state.job) state.job.cancelled = true;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The whole job without a click: scan the file (or reuse this profile's scan
 * from a previous visit), prepare every section and make it pass, export the
 * result and re-scan the export. Every stage is an ordinary job, so the job
 * bar shows its progress and "stop" cancels it. Stops short, saying why,
 * when a section still fails; that section is opened for editing by hand.
 */
async function autopilot({ rescan = false } = {}) {
  if (!state.movie || !state.env || !state.project || !state.decode.supported) return;
  if (state.job || (state.auto && state.auto.running)) return;
  const movie = state.movie;
  const project = state.project;
  if (state.auto && state.auto.blobUrl) URL.revokeObjectURL(state.auto.blobUrl);
  const auto = { running: true, stopped: false, steps: {}, summary: '', blobUrl: null, fileName: null };
  state.auto = auto;
  renderAuto();
  const halted = () => auto.stopped || state.movie !== movie;
  const bail = (step, why) => {
    autoStep(auto, step, halted() ? 'stopped' : 'failed', halted() ? '' : why);
    auto.summary = halted() ? 'Stopped. The buttons do each step by hand; "run again" starts over.' : why;
  };
  try {
    // 1. scan
    const sig = wasm.config_signature(state.config);
    const prior = project.scan;
    if (!rescan && prior && prior.sig === sig && prior.profile === project.profile && (prior.safe || project.sections.length)) {
      autoStep(auto, 'scan', 'done', `${describeScan(prior)} (${state.lastScan ? 'scanned when the file was opened' : 'from the last visit'})`);
    } else {
      autoStep(auto, 'scan', 'running', 'decoding every frame');
      const res = await scan();
      if (!res || halted()) return bail('scan', 'The scan did not finish.');
      autoStep(auto, 'scan', 'done', describeScan(project.scan));
    }
    if (project.scan.safe && !project.sections.some(hasMarks)) {
      autoStep(auto, 'fix', 'skipped', 'nothing to fix');
      autoStep(auto, 'export', 'skipped', 'the file passes as it is');
      autoStep(auto, 'verify', 'skipped');
      auto.summary = 'Nothing to fix: the file passes as it is.';
      return;
    }
    // 2. fix every section
    const secs = project.sectionsSorted();
    const notes = [];
    const failing = [];
    const partial = [];
    for (const sec of secs) {
      if (halted()) return bail('fix', '');
      autoStep(auto, 'fix', 'running', `section #${sec.id} of ${secs.length}${notes.length ? ' · ' + notes.join(' · ') : ''}`);
      const r = await autoFixSection(sec, auto);
      if (!r) return bail('fix', `Section #${sec.id} could not be fixed automatically.`);
      notes.push(`#${sec.id}: ${r.note}`);
      if (!r.wcagSafe) failing.push(sec);
      else if (!r.safe) partial.push(sec);
      renderAll();
    }
    await project.save();
    updateStatus();
    if (failing.length) {
      autoStep(auto, 'fix', 'failed', notes.join(' · '));
      autoStep(auto, 'export', 'skipped', 'not while a section fails');
      autoStep(auto, 'verify', 'skipped');
      const ids = failing.map((s) => '#' + s.id).join(', ');
      auto.summary = `Section${failing.length === 1 ? '' : 's'} ${ids} still fail${failing.length === 1 ? 's' : ''} WCAG: edit ${failing.length === 1 ? 'it' : 'them'} by hand, then Export.`;
      openSection(failing[0].id);
      return;
    }
    autoStep(auto, 'fix', 'done', notes.join(' · '));
    if (halted()) return bail('export', '');
    // 3. export
    const quality = +$('exportQuality').value;
    const cands = await encoderCandidates(movie.width, movie.height, movie.fps, quality);
    if (!cands.length) {
      autoStep(auto, 'export', 'failed', 'this browser has no WebCodecs video encoder');
      autoStep(auto, 'verify', 'skipped');
      auto.summary = 'The sections are fixed, but this browser has no video encoder to export with.';
      return;
    }
    // to disk when the browser has private storage; in memory otherwise, and
    // only when it will fit
    const plan = await exportPlan(state.env, movie, project, { extS: EXT_S, codec: cands[0].config.codec, smartCut: smartCutSetting(), parallel: parallelSetting() });
    const need = estimateExportBytes(movie, quality, plan);
    const sinkInfo = await privateFileSink(need);
    if (!sinkInfo && need > memoryExportLimit()) {
      autoStep(auto, 'export', 'skipped', `about ${fmtBytes(need)}: more than this browser can build in memory`);
      autoStep(auto, 'verify', 'skipped');
      auto.summary = `The sections are fixed. The export would be about ${fmtBytes(need)}, more than this browser can hold in memory: ${window.showSaveFilePicker ? 'use Export… to write it to a file of your choice' : 'export from a browser with a save dialog or private storage'}.`;
      return;
    }
    autoStep(auto, 'export', 'running', `${plan.mode === 'smart' ? `re-encoding ${plan.spans} span${plan.spans === 1 ? '' : 's'} with ${cands[0].label}, copying ${plan.copied} frames` : `encoding with ${cands[0].label}`}${sinkInfo ? ' to private storage on disk' : ''}`);
    const res = await runJob('Exporting', (progress, cancelled) =>
      exportMovie(state.env, movie, project, {
        encoder: cands[0].label,
        quality,
        extS: EXT_S,
        sink: sinkInfo ? sinkInfo.sink : null,
        cancel: cancelled,
        plan,
        onProgress: (p, frames, ms, copied, sound) => progress(p, exportProgressText(frames, ms, copied, sound)),
      })
    );
    if (!res || halted()) {
      if (sinkInfo) await sinkInfo.sink.abort();
      return bail('export', 'The export did not finish.');
    }
    await readBackExport(res, sinkInfo);
    if (!res.blob) return bail('export', 'The exported file could not be read back.');
    auto.fileName = exportName(movie);
    auto.blobUrl = URL.createObjectURL(res.blob);
    const dl = $('autoDownload');
    dl.href = auto.blobUrl;
    dl.download = auto.fileName;
    showExportResult(res, auto.fileName);
    autoStep(auto, 'export', 'done', `${exportSummary(res)}${res.warnings.length ? ' · ' + res.warnings.join(' ') : ''}`);
    // 4. verify
    if (halted()) return bail('verify', '');
    autoStep(auto, 'verify', 'running', 're-scanning the exported file');
    const v = await verifyBlob(res.blob);
    if (!v || halted()) return bail('verify', 'The check of the exported file did not finish.');
    autoStep(auto, 'verify', v.wcagBad.length ? 'failed' : 'done', v.text);
    const ids = partial.map((s) => '#' + s.id).join(', ');
    const left = partial.length ? ` Section${partial.length === 1 ? '' : 's'} ${ids} pass${partial.length === 1 ? 'es' : ''} WCAG but keep${partial.length === 1 ? 's' : ''} something the profile flags.` : '';
    auto.summary = v.wcagBad.length ? `The exported file still fails WCAG. ${v.text}` : `Done: the fixed video is ready to download. ${v.text}${left}`;
  } catch (e) {
    console.error(e);
    const step = AUTO_STEPS.map(([k]) => k).find((k) => auto.steps[k] && auto.steps[k].status === 'running') || 'scan';
    autoStep(auto, step, 'failed', e && e.message ? e.message : String(e));
    auto.summary = 'Auto-fix stopped on an error; the buttons do each step by hand.';
  } finally {
    auto.running = false;
    if (state.auto === auto) renderAuto();
    // the run was one wait: its alert comes now
    if (chain.active) {
      if (auto.steps.verify && auto.steps.verify.status === 'failed') chain.ok = false;
      chain.end = performance.now();
      clearTimeout(chain.timer);
      chain.timer = setTimeout(finishChain, CHAIN_GRACE_MS);
    }
  }
}

/**
 * Prepare one section and make it pass: soften its stripes, then take the
 * flashing out by removing as few frames as it can (the fewest removals,
 * which end by letting frames back into long removed stretches at the
 * rate that cannot fail), else keep dark, then keep light, and when that is
 * not enough, by thinning to a rate that cannot flash fast enough to fail.
 * Returns what was done and where the section stands, or null when a step
 * failed or the run was stopped.
 */
async function autoFixSection(sec, auto) {
  const env = state.env;
  const project = state.project;
  const ctxS = wasm.context_seconds(state.config);
  const hadMarks = blendMarks(sec).length > 0 || Object.values(sec.edits || {}).some((e) => e.removed || e.extended);
  if (!sec.prepared && !(await doPrepare(sec))) return null;
  const check = async () => {
    if (auto.stopped) return null;
    const c = await runJob(`Checking section #${sec.id}`, () => checkSection(env, project, sec, null, { extS: EXT_S }));
    if (c) sec.check = c;
    return c;
  };
  const standing = (note) => ({ note, safe: !!(sec.check && sec.check.safe), wcagSafe: !!(sec.check && sec.check.wcag_safe) });
  // a check's verdict counts what runs past the section's end too
  const violations = (x) => x.violations || x.inside || [];
  let c = await check();
  if (!c) return null;
  if (c.safe) return standing(hadMarks || sec.soften ? 'passes with the marks from before' : 'already passes');
  const did = [];
  // stripes cannot be removed a frame at a time: soften them
  if (c.flag_patterns && violations(c).some((v) => v.kind === 'pattern') && !sec.soften && softenPlan(sec)) {
    pushHistory(sec);
    sec.soften = true;
    project.invalidateNeighbours(sec, ctxS);
    did.push('softened the stripes');
    c = await check();
    if (!c) return null;
    if (c.safe) return standing(did.join(' · '));
  }
  // flashing: the gentle suggesters first, the guaranteed one last
  const flashing = violations(c).some((v) => v.kind === 'flash' || v.kind === 'red' || (v.kind === 'extended' && c.flag_extended));
  if (flashing) {
    const rounds = (progress) => (r) => progress(Math.min(0.95, 0.2 + r * 0.06), `check ${r + 1}`);
    const tries = [
      ['fewest removals', (progress) => suggestEdits(env, project, sec, 'fewest', null, { extS: EXT_S, onProgress: rounds(progress) })],
      ['keep dark', (progress) => suggestEdits(env, project, sec, 'dark', null, { extS: EXT_S, onProgress: rounds(progress) })],
      ['keep light', (progress) => suggestEdits(env, project, sec, 'light', null, { extS: EXT_S, onProgress: rounds(progress) })],
      ['reduce the frame rate', (progress) => searchFrameRate(env, project, sec, null, { extS: EXT_S, sourceFps: state.movie.fps, onProgress: (p, r) => progress(p, `checking ${r} pictures/s`) })],
    ];
    let last = null;
    for (const [label, run] of tries) {
      if (auto.stopped) return null;
      const res = await runJob(`Fixing section #${sec.id}: ${label}`, (progress) => run(progress));
      if (!res) return null;
      last = [label, res];
      if (res.safe) break;
    }
    const [label, res] = last;
    applySuggestion(sec, res, null);
    did.push(`${label}: ${res.note}`);
    if (!sec.check && !(await check())) return null;
  }
  await project.save();
  const kinds = remainingKinds(sec.check);
  return standing(did.join(' · ') || (kinds.length ? `no automatic fix for the ${kinds.join(' and ')}` : 'no automatic fix'));
}

// a small surface for tests and debugging
window.__unflash = {
  get state() {
    return state;
  },
  get lastScan() {
    return state.lastScan;
  },
  get auto() {
    return state.auto;
  },
  currentSection,
  softenPlan,
  openClip,
  autopilot,
  stopAuto,
  profile,
  get sectionPlayer() {
    return sectionPlayer;
  },
  sectionSound,
  loadProjectFile,
  tours: tourGuide,
  get lastProjectFile() {
    return state.lastProjectFile;
  },
  get changes() {
    return state.changes;
  },
  debugReport: makeDebugReport,
  setPlayerSource,
  playSection,
  undo,
  redo,
  /**
   * Prepare a copy of section `id` in `spans` spans and describe what came
   * out (frame counts, times, a checksum of the cached pictures), leaving
   * the section itself alone (tests: a prepare in spans must match one in
   * a single pass).
   */
  async prepareDigest(id, spans) {
    const sec = state.project.sections.find((s) => s.id === id);
    const copy = { id: sec.id, start: sec.start, end: sec.end, edits: {} };
    const t0 = performance.now();
    await withFeeder(() => prepareSection(state.env, state.movie, copy, { spans, moreFeeders: spareFeeders }));
    const ms = performance.now() - t0;
    const sum = (cache) => {
      let h = 0;
      for (let i = 0; i < cache.len(); i++) {
        const f = cache.frame(i);
        for (let k = 0; k < f.length; k += 7) h = (h * 31 + f[k] + k) >>> 0;
      }
      return h;
    };
    const out = { ms, spans: copy.preparedSpans, frames: copy.cache.len(), lead: copy.ctx.lead.len(), tail: copy.ctx.tail.len(), pts: copy.pts, leadPts: copy.ctx.leadPts, tailPts: copy.ctx.tailPts, pattern: copy.pattern.counts, hash: [sum(copy.cache), sum(copy.ctx.lead), sum(copy.ctx.tail)] };
    dropCaches(copy);
    return out;
  },
  /**
   * Prepare a copy of section `id` through the decode workers twice, the
   * pictures made small there and made small by the detector, and compare
   * the cached pictures (tests: the workers' shrink is the GPU's, to a code).
   */
  async compareShrink(id) {
    const sec = state.project.sections.find((s) => s.id === id);
    const m = state.movie;
    const was = { workers: m.decodeInWorkers, shrink: m.shrinkInWorkers };
    const prepare = async (shrink) => {
      const copy = { id: sec.id, start: sec.start, end: sec.end, edits: {} };
      m.decodeInWorkers = true;
      m.shrinkInWorkers = shrink;
      try {
        await withFeeder(() => prepareSection(state.env, m, copy, { spans: 1 }));
      } finally {
        m.decodeInWorkers = was.workers;
        m.shrinkInWorkers = was.shrink;
      }
      return copy;
    };
    const big = await prepare(false);
    const bigRoute = state.env.feeder.routeDetail;
    const small = await prepare(true);
    const smallRoute = state.env.feeder.routeDetail;
    let n = 0;
    let differ = 0;
    let max = 0;
    for (let i = 0; i < Math.min(big.cache.len(), small.cache.len()); i++) {
      const a = big.cache.frame(i);
      const b = small.cache.frame(i);
      for (let k = 0; k < a.length; k++) {
        if ((k & 3) === 3) continue;
        const d = Math.abs(a[k] - b[k]);
        n++;
        if (d) differ++;
        if (d > max) max = d;
      }
    }
    const out = { frames: [big.cache.len(), small.cache.len()], n, differ, max, routes: [bigRoute, smallRoute] };
    dropCaches(big);
    dropCaches(small);
    return out;
  },
  /**
   * Show the frame at `t` in the (paused) player and have the live monitor
   * watch it: after the player's `seeked`, the picture waits for a free
   * detector slot instead of being skipped as it is while playing, and its
   * result is in before this resolves, with the verdict it gives. Tests step
   * through a clip this way, so that every frame is seen however slow the
   * GPU is.
   */
  async liveStep(t) {
    const player = $('player');
    const feeder = state.liveFeeder;
    if (!feeder || !state.live.on || state.live.fromScan) throw new Error('the live monitor is not detecting');
    player.pause();
    await new Promise((resolve) => {
      player.addEventListener('seeked', resolve, { once: true });
      player.currentTime = t;
    });
    await feeder.videoElement(player, player.currentTime, false);
    await feeder.drain();
    state.live.lastCheck = 0;
    drainLive();
    return $('liveVerdict').textContent;
  },
  /** What the last scan had found as it finished each chunk and each early look, and when (tests). */
  get partials() {
    return state.partials || [];
  },
  /** Change the finish-alert settings for this visit (tests). */
  setAlerts(s) {
    Object.assign(alertSettings, s);
  },
  get lastAlert() {
    return state.lastAlert || null;
  },
};

boot().catch((e) => {
  console.error(e);
  banner(`Unflash could not start: ${e.message || e}`);
});
