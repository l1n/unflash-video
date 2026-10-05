// The video guard: watches every <video> on the page as it plays, runs
// Unflash's detector on each picture as it is shown, and when a video starts
// flashing hides it until the flashing has stopped for a second: holds the
// last picture from before the flashing over it (or dims it, or pauses it,
// as the settings say). Stripe patterns that the profile flags are blurred.
//
// The detector is the web app's (web/detector.js and the WebAssembly, copied
// in by extension/build.mjs): the GPU detector, a picture at a time, fed the
// <video> itself; or the CPU detector, fed the picture drawn small on a
// canvas. Its clock is the wall clock (when each picture is shown), not the
// video's: a video played at twice the speed flashes twice as fast for
// whoever watches it.

import init, * as wasm from './pkg/unflash.js';
import { createDetector } from './lib/detector.js';
import { api, loadSettings, watchSettings, siteDisabled } from './settings.js';

/** Big swings of brightness within a second that count as flashing, by sensitivity (a flash is two). */
const SWINGS_NEEDED = { early: 2, balanced: 3, limit: Infinity };
/** Seconds without flashing before the video is shown again. */
const RELEASE_S = 1.0;
/** Videos shown smaller than this (px) are left alone: thumbnails' previews still count. */
const MIN_W = 96;
const MIN_H = 54;
/** The pictures kept to hold: one every SNAP_EVERY_S, the last SNAP_KEEP, at most SNAP_MAX_W wide. */
const SNAP_EVERY_S = 0.1;
const SNAP_KEEP = 16;
const SNAP_MAX_W = 640;
/**
 * The held picture is one from at least this long before the flashing's
 * first swing: a swing is counted a little after it starts (the pooling
 * window), and the change before the first counted one may have been too
 * small to count.
 */
const SNAP_BEFORE_S = 0.3;
/**
 * In 'auto', a GPU whose verdicts come back later than this (s, on
 * average) is given up for the CPU: Firefox's GPU, in another process,
 * answers about 300 ms late, a software one later still, and the CPU
 * answers at once.
 */
const SLOW_GPU_S = 0.15;
/** The detector keeps every picture's numbers: after this long without flashing it starts afresh. */
const FRESH_AFTER_S = 600;
/** What the video looks like dimmed: its swings of brightness under WCAG's 0.1, red washed out. */
const DIM_FILTER = 'contrast(0.5) brightness(0.35) saturate(0.2)';

let settings = null;
let topHost = '';
const guards = new Map(); // <video> -> Guard
let wasmReady = null;

function loadWasm() {
  if (!wasmReady) {
    wasmReady = init({ module_or_path: api.runtime.getURL('pkg/unflash_bg.wasm') });
    // (a load cut short, by the page going away say, is tried again next time)
    wasmReady.catch(() => (wasmReady = null));
  }
  return wasmReady;
}

const isOn = () => settings && settings.enabled && !siteDisabled(settings, topHost);

export async function start() {
  settings = await loadSettings();
  try {
    const hello = await api.runtime.sendMessage({ type: 'hello' });
    topHost = (hello && hello.host) || location.hostname;
  } catch (e) {
    topHost = location.hostname;
  }
  watchSettings((s) => {
    const old = settings;
    settings = s;
    for (const g of guards.values()) g.settingsChanged(old);
    if (isOn()) for (const v of document.querySelectorAll('video')) if (!v.paused) watch(v);
  });
  // media events do not bubble, but a listener capturing on the document hears them
  document.addEventListener('playing', (e) => e.target instanceof HTMLVideoElement && watch(e.target), true);
  document.addEventListener('seeked', (e) => guards.get(e.target)?.seeked(), true);
  for (const v of document.querySelectorAll('video')) if (!v.paused) watch(v);
  setInterval(sweep, 5000);
  window.__unflashGuards = guards; // (for the extension's tests)
}

function watch(video) {
  if (!isOn()) return;
  let g = guards.get(video);
  if (!g) {
    g = new Guard(video);
    guards.set(video, g);
  }
  g.arm();
}

/** Let go of the videos that have left the page. */
function sweep() {
  for (const [v, g] of guards) {
    if (!v.isConnected) {
      g.dispose();
      guards.delete(v);
    }
  }
  report();
}

// ---- what the toolbar button shows ----------------------------------------------

let reportTimer = 0;
let reported = '';

function report() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = 0;
    const list = [...guards.values()].filter((g) => g.feeder || g.unreadable);
    const status = {
      type: 'status',
      videos: list.filter((g) => g.feeder).length,
      unreadable: list.filter((g) => g.unreadable).length,
      events: list.reduce((a, g) => a + g.events, 0),
      active: list.some((g) => g.shown),
      backend: list.map((g) => g.feeder && g.feeder.backend).find(Boolean) || '',
      msPerFrame: Math.max(0, ...list.map((g) => g.msPerFrame())),
    };
    const key = JSON.stringify(status);
    if (key === reported) return;
    reported = key;
    api.runtime.sendMessage(status).catch(() => {});
  }, 250);
}

// ---- one video --------------------------------------------------------------------

class Guard {
  constructor(video) {
    this.video = video;
    this.feeder = null;
    this.making = null;
    this.broken = false; // the detector failed: not tried again until the settings change
    this.slowGpu = false; // the GPU answered too late: the CPU from now on
    this.unreadable = false; // a picture from another site, which the page may not read
    this.src = '';
    this.looping = false;
    this.overlay = new Overlay(video);
    this.events = 0;
    this.shown = null; // the mitigation on show: { flashing, stripes, held }
    this.pausedByUs = false; // paused for flashing (mode 'pause'): it says so until played again
    this.fresh();
  }

  /** Forget everything seen: the detector's clock and the flashing's timers start again. */
  fresh() {
    this.t0 = performance.now() / 1000;
    this.lastT = -1;
    this.swings = [];
    this.above = {};
    this.flashUntil = -1;
    this.stripesUntil = -1;
    this.onset = 0;
    this.lastSwing = 0;
    this.fed = 0;
    this.busyMs = 0;
    this.lag = 0; // how late the verdicts come, on average (s)
    this.verdicts = 0;
    this.snaps = [];
    this.lastSnap = -1;
  }

  msPerFrame() {
    return this.fed ? this.busyMs / this.fed : 0;
  }

  arm() {
    if (this.pausedByUs) {
      this.pausedByUs = false;
      this.update();
    }
    if (this.looping || !isOn()) return;
    const v = this.video;
    this.looping = true;
    if (typeof v.requestVideoFrameCallback === 'function') {
      const step = (now, meta) => {
        if (!this.picture(meta.expectedDisplayTime || now)) return;
        v.requestVideoFrameCallback(step);
      };
      v.requestVideoFrameCallback(step);
    } else {
      // (no picture callbacks: every animation frame the video's time has moved)
      let last = -1;
      const step = (now) => {
        if (v.currentTime !== last) {
          last = v.currentTime;
          if (!this.picture(now)) return;
        } else if (v.paused || v.ended) {
          this.looping = false;
          this.update();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }

  /** A picture shown at `atMs` (performance clock). False when the loop is to stop. */
  picture(atMs) {
    const v = this.video;
    if (!isOn() || !v.isConnected) {
      this.looping = false;
      this.release();
      return false;
    }
    if (v.currentSrc !== this.src) {
      // another video in the same element (YouTube's next video): read it afresh
      this.src = v.currentSrc;
      this.unreadable = false;
      this.broken = false;
      this.snaps = [];
    }
    const r = v.getBoundingClientRect();
    if (v.videoWidth && r.width >= MIN_W && r.height >= MIN_H && !this.unreadable && !this.broken) {
      if (!this.feeder) this.make();
      else this.see(atMs / 1000 - this.t0);
    }
    this.update();
    if (v.paused || v.ended) {
      this.looping = false;
      return false;
    }
    return true;
  }

  make() {
    if (this.making) return;
    const v = this.video;
    if (!readable(v)) {
      this.unreadable = true;
      report();
      return;
    }
    this.making = (async () => {
      await loadWasm();
      const config = wasm.profile_config(settings.profile);
      const gpu = settings.detector === 'gpu' || (settings.detector === 'auto' && !this.slowGpu && !/Firefox\//.test(navigator.userAgent));
      const f = await createDetector(wasm, config, v.videoWidth, v.videoHeight, { preferGpu: gpu, batch: 1 });
      // the CPU detector gets the picture drawn on a canvas at twice its own
      // size (it makes it small itself): a fraction of the cost of the whole picture
      this.fw = Math.min(v.videoWidth, f.aw * 2);
      this.fh = Math.min(v.videoHeight, f.ah * 2);
      const verdict = f.partialVerdict();
      this.flagExt = !!verdict.flag_extended;
      this.flagPatterns = !!verdict.flag_patterns;
      if (this.feeder) this.feeder.det.free();
      this.feeder = f;
      this.release();
      this.fresh();
      console.debug(`[unflash] guarding a ${v.videoWidth}×${v.videoHeight} video with the ${f.backend} detector at ${f.aw}×${f.ah}`);
      report();
    })()
      .catch((e) => {
        // (tried again for the element's next video)
        this.broken = true;
        console.warn('[unflash] no detector for this video', e);
      })
      .finally(() => (this.making = null));
  }

  /** Feed the picture on show (`t`: seconds on the guard's clock) to the detector, and read what it found. */
  see(t) {
    if (t <= this.lastT) return;
    this.lastT = t;
    const v = this.video;
    const f = this.feeder;
    if (settings.mode === 'hold' && !this.shown && t - this.lastSnap >= SNAP_EVERY_S) this.snap(t);
    const t0 = performance.now();
    try {
      if (f.gpu) {
        f.poll();
        // (a picture still on its way holds the next back, as a full GPU does)
        if (f.videoReady()) {
          // (the detector may be let go meanwhile: a slow GPU, new settings)
          f.videoElementNow(v, t).then(
            () => this.feeder === f && f.gpuWait().then(() => this.collect()),
            (e) => this.feeder === f && this.fail(e),
          );
          this.fed++;
        }
      } else {
        f.feedPixels(v, this.fw, this.fh, t, false);
        this.fed++;
      }
    } catch (e) {
      this.fail(e);
      return;
    }
    this.busyMs += performance.now() - t0;
    this.collect();
    if (t - this.lastSwing > FRESH_AFTER_S && !this.shown && this.fed > 1000) {
      f.reset();
      this.fresh();
    }
  }

  fail(e) {
    if (e && e.name === 'SecurityError') {
      this.unreadable = true;
    } else {
      this.broken = true;
      console.warn('[unflash] the detector failed on this video', e);
    }
    this.free();
    this.release();
    report();
  }

  /** Read the detector's verdicts on the pictures it has finished. */
  collect() {
    const f = this.feeder;
    if (!f) return;
    if (f.gpu) f.poll();
    const recs = f.records();
    if (!recs.length) return;
    const th = f.det.area_thresh();
    const pth = f.det.pattern_thresh() || 1;
    const need = SWINGS_NEEDED[settings.sensitivity] || SWINGS_NEEDED.balanced;
    const now = performance.now() / 1000 - this.t0;
    for (const r of recs) {
      this.lag += ((now - r.t) - this.lag) / Math.min(++this.verdicts, 30);
      // a swing: a big enough part of the picture getting brighter, darker,
      // or redder or less red (the detector's area threshold, in its window)
      let swung = false;
      for (const k of ['up_area', 'down_area', 'red_area']) {
        const above = r[k] >= th;
        if (above && !this.above[k]) {
          this.swings.push(r.t);
          this.lastSwing = r.t;
          swung = true;
        }
        this.above[k] = above;
      }
      while (this.swings.length && this.swings[0] < r.t - 1) this.swings.shift();
      const violating = r.hazard > 0 || r.hazard_red > 0;
      const atLimit = this.flagExt && Math.max(r.ext, r.ext_red) >= th;
      // (a swing that makes `need` in a second starts the flashing or keeps it
      // going: the video comes back a second after the last such swing)
      if (violating || atLimit || (swung && this.swings.length >= need)) {
        if (now > this.flashUntil) {
          // a new stretch of flashing: it started at its first swing, or
          // where the detector says the swings it is counting started
          let onset = this.swings.length ? this.swings[0] : r.t;
          if (violating) onset = Math.min(onset, r.t - Math.max(0, r.tc - Math.min(r.hazard_onset, r.hazard_red_onset)));
          this.onset = onset;
        }
        // (from when it is known: a verdict comes a little after its picture)
        this.flashUntil = now + RELEASE_S;
      }
      if (this.flagPatterns && r.pattern >= pth) this.stripesUntil = now + RELEASE_S;
    }
    this.update();
    if (f.gpu && settings.detector === 'auto' && this.verdicts >= 10 && this.lag > SLOW_GPU_S && !this.shown) {
      console.debug(`[unflash] the GPU's verdicts come ${Math.round(this.lag * 1000)} ms late: the CPU detector from now on`);
      this.slowGpu = true;
      this.free();
      report();
    }
  }

  /** Keep the picture on show, small, to hold should flashing come. */
  snap(t) {
    const v = this.video;
    this.lastSnap = t;
    let s = this.snaps.length >= SNAP_KEEP ? this.snaps.shift() : null;
    // (the picture on show over the video is not drawn over)
    if (!s || s === this.overlay.drawn) s = { canvas: new OffscreenCanvas(1, 1) };
    const scale = Math.min(1, SNAP_MAX_W / v.videoWidth);
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    if (s.canvas.width !== w || s.canvas.height !== h) {
      s.canvas.width = w;
      s.canvas.height = h;
    }
    try {
      s.canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    } catch (e) {
      return;
    }
    s.t = t;
    this.snaps.push(s);
  }

  /** The kept picture to hold: the last from before the flashing began (null: none kept from so long ago). */
  heldPicture() {
    let pick = null;
    for (const s of this.snaps) if (s.t < this.onset - SNAP_BEFORE_S) pick = s;
    return pick;
  }

  /** Show what the flashing calls for now, or the video as it is. */
  update() {
    const now = performance.now() / 1000 - this.t0;
    const v = this.video;
    const flashing = (this.feeder && now < this.flashUntil) || (this.pausedByUs && v.paused);
    const stripes = this.feeder && now < this.stripesUntil;
    if (!flashing && !stripes) {
      this.release();
      return;
    }
    const mode = settings.mode;
    if (flashing && !(this.shown && this.shown.flashing)) {
      this.events++;
      if (mode === 'pause' && !v.paused) {
        v.pause();
        this.pausedByUs = true;
      }
      report();
    }
    let held = this.shown && this.shown.flashing && this.shown.held;
    if (flashing && mode === 'hold' && !held && document.fullscreenElement !== v) held = this.heldPicture();
    if (!flashing) held = null;
    // (a video with no picture to hold, or shown full screen on its own, where nothing goes over it, is dimmed)
    const dim = flashing && (mode === 'dim' || (mode === 'hold' && !held));
    const blur = stripes && mode !== 'warn';
    setFilter(v, [dim ? DIM_FILTER : '', blur ? `blur(${blurPx(v)}px)` : ''].filter(Boolean).join(' '));
    const label = flashing ? { hold: held ? 'Flashing hidden' : 'Flashing dimmed', dim: 'Flashing dimmed', pause: 'Paused: flashing', warn: 'Flashing' }[mode] : mode === 'warn' ? 'Stripes' : 'Stripes blurred';
    this.overlay.show(held, blur ? blurPx(v) : 0, settings.badge || mode === 'warn' ? label : '', flashing);
    this.shown = { flashing, stripes, held };
    // (the video may stop: the picture comes back when the time is up, pictures or not)
    clearTimeout(this.releaseTimer);
    const until = Math.max(this.flashUntil, this.stripesUntil);
    if (until > now) this.releaseTimer = setTimeout(() => this.update(), (until - now) * 1000 + 20);
  }

  /** The video as it is. */
  release() {
    clearTimeout(this.releaseTimer);
    if (!this.shown) return;
    this.shown = null;
    setFilter(this.video, '');
    this.overlay.hide();
    report();
  }

  seeked() {
    // (a picture from before the seek is from somewhere else in the video)
    this.snaps = [];
  }

  settingsChanged(old) {
    if (!isOn()) {
      this.release();
      this.free();
      return;
    }
    if (old.profile !== settings.profile || old.detector !== settings.detector) {
      this.broken = false;
      this.slowGpu = false;
      this.release();
      this.free();
    }
    if (old.mode !== settings.mode || old.badge !== settings.badge) {
      this.pausedByUs = false;
      this.release();
    }
    if (!this.video.paused) this.arm();
  }

  free() {
    if (this.feeder) this.feeder.det.free();
    this.feeder = null;
  }

  dispose() {
    this.release();
    this.free();
    this.overlay.destroy();
  }
}

/** Whether the page may read the video's pictures (a video from another site, sent without CORS, may not). */
function readable(video) {
  try {
    const c = new OffscreenCanvas(1, 1);
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
    return true;
  } catch (e) {
    return false;
  }
}

const savedFilters = new WeakMap();

/** Put CSS filter `f` on the video ('' for its own back). */
function setFilter(video, f) {
  if (!savedFilters.has(video)) {
    if (!f) return;
    savedFilters.set(video, { value: video.style.getPropertyValue('filter'), priority: video.style.getPropertyPriority('filter') });
  }
  if (f) {
    video.style.setProperty('filter', f, 'important');
  } else {
    const s = savedFilters.get(video);
    savedFilters.delete(video);
    if (s.value) video.style.setProperty('filter', s.value, s.priority);
    else video.style.removeProperty('filter');
  }
}

/** Enough blur to take out fine stripes at the size the video is shown. */
function blurPx(video) {
  return Math.max(3, Math.round(video.getBoundingClientRect().width / 160));
}

// ---- what goes over the video ---------------------------------------------------------

const OVERLAY_CSS = `
:host { all: initial; position: absolute; pointer-events: none; overflow: hidden; display: block; margin: 0; padding: 0; border: 0; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: none; background: #000; }
canvas.on { display: block; }
.badge { position: absolute; top: 8px; left: 8px; display: none; align-items: center; gap: 6px;
  font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; background: rgba(20, 20, 24, 0.82);
  padding: 5px 9px 5px 7px; border-radius: 999px; letter-spacing: 0.01em; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.badge.on { display: inline-flex; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #f5a524; }
.badge.flashing .dot { background: #f04438; }
`;

/**
 * A layer over a video, put right after it in the page (so that it covers
 * the video and stays under the player's own controls and captions, which
 * come later): the held picture, and a badge saying what was done.
 */
class Overlay {
  constructor(video) {
    this.video = video;
    this.host = null;
    this.visible = false;
  }

  build() {
    this.host = document.createElement('unflash-overlay');
    const root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    this.canvas = document.createElement('canvas');
    this.badge = document.createElement('div');
    this.badge.className = 'badge';
    const dot = document.createElement('span');
    dot.className = 'dot';
    this.badgeText = document.createElement('span');
    this.badge.append(dot, this.badgeText);
    root.append(style, this.canvas, this.badge);
    this.resize = new ResizeObserver(() => this.visible && this.place());
    this.resize.observe(this.video);
  }

  /** Over the video, wherever it is now. */
  place() {
    const v = this.video;
    const host = this.host;
    if (!v.parentNode) return;
    if (host.previousSibling !== v) v.after(host);
    const vr = v.getBoundingClientRect();
    let left;
    let top;
    const op = host.offsetParent;
    if (!op || (op === document.body && getComputedStyle(op).position === 'static')) {
      // nothing positioned above it: placed on the page
      left = vr.left + window.scrollX;
      top = vr.top + window.scrollY;
    } else {
      const pr = op.getBoundingClientRect();
      left = vr.left - pr.left - op.clientLeft + op.scrollLeft;
      top = vr.top - pr.top - op.clientTop + op.scrollTop;
    }
    const s = host.style;
    s.setProperty('left', `${left}px`, 'important');
    s.setProperty('top', `${top}px`, 'important');
    s.setProperty('width', `${vr.width}px`, 'important');
    s.setProperty('height', `${vr.height}px`, 'important');
    const z = getComputedStyle(v).zIndex;
    if (z !== 'auto') s.setProperty('z-index', z, 'important');
    return vr;
  }

  /** Show `held` (a kept picture, or null) blurred by `blur` px, and the badge `label` ('' for none). */
  show(held, blur, label, flashing) {
    if (!held && !label) {
      this.hide();
      return;
    }
    if (!this.host) this.build();
    this.visible = true;
    const vr = this.place();
    if (held && vr && held !== this.drawn) this.draw(held, vr);
    if (!held) this.drawn = null;
    this.canvas.classList.toggle('on', !!held);
    this.canvas.style.filter = blur ? `blur(${blur}px)` : '';
    this.badge.classList.toggle('on', !!label);
    this.badge.classList.toggle('flashing', !!flashing);
    this.badgeText.textContent = label;
  }

  /** Draw the kept picture as the video draws its own (contain, unless it says cover or fill). */
  draw(held, vr) {
    this.drawn = held;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(vr.width * dpr));
    const ch = Math.max(1, Math.round(vr.height * dpr));
    this.canvas.width = cw;
    this.canvas.height = ch;
    const ctx = this.canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    const fit = getComputedStyle(this.video).objectFit;
    const pw = held.canvas.width;
    const ph = held.canvas.height;
    let w = cw;
    let h = ch;
    if (fit !== 'fill') {
      const k = fit === 'cover' ? Math.max(cw / pw, ch / ph) : Math.min(cw / pw, ch / ph);
      w = pw * k;
      h = ph * k;
    }
    ctx.drawImage(held.canvas, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  hide() {
    if (!this.host) return;
    this.visible = false;
    this.drawn = null;
    this.canvas.classList.remove('on');
    this.badge.classList.remove('on');
    this.host.remove();
  }

  destroy() {
    if (!this.host) return;
    this.resize.disconnect();
    this.host.remove();
    this.host = null;
  }
}
