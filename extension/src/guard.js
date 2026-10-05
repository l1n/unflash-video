// The video guard: watches every <video> on the page as it plays and runs
// Unflash's detector on each picture.
//
// With lookahead (the default) the video is shown a little late: each
// picture is copied as the video plays and judged at once, and the copy is
// shown `lookahead` seconds later over the video, its sound delayed as much
// through Web Audio. By the time a picture is due, the detector has already
// seen the pictures after it, so a stretch of flashing is known before its
// first picture is shown: from its start, it is replaced by the last
// picture from before it (or dimmed, or the video paused, as the settings
// say), and none of it is seen.
//
// Where the delayed copy cannot be shown (the video full screen on its own,
// in picture-in-picture, or its sound delayed neither by us nor muted), the
// guard reacts as the video plays instead: the first moment of flashing is
// seen before it steps in.
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
/**
 * A stretch of flashing starts this long before its first counted swing:
 * a swing is counted a little after it starts (the pooling window), and the
 * change before the first counted one may have been too small to count.
 */
const ONSET_MARGIN_S = 0.3;
/** Without lookahead: the pictures kept to hold, one every SNAP_EVERY_S, the last SNAP_KEEP, at most SNAP_MAX_W wide. */
const SNAP_EVERY_S = 0.1;
const SNAP_KEEP = 16;
const SNAP_MAX_W = 640;
/** With lookahead: the delayed copies are at most this many pixels (720p), and never larger than shown. */
const AHEAD_MAX_PIXELS = 1280 * 720;
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
const LABELS = { hold: 'Flashing hidden', dim: 'Flashing dimmed', pause: 'Paused: flashing', warn: 'Flashing' };

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
/** The guard's clock: seconds on the performance clock. */
const clock = () => performance.now() / 1000;

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
  document.addEventListener('seeking', (e) => guards.get(e.target)?.seeking(), true);
  // (a page may have no sound to delay until it is clicked: tried again then)
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => AudioDelay.gesture(), true);
  for (const v of document.querySelectorAll('video')) if (!v.paused) watch(v);
  setInterval(sweep, 5000);
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
      ahead: list.filter((g) => g.ahead.on).length,
      unreadable: list.filter((g) => g.unreadable).length,
      events: list.reduce((a, g) => a + g.events, 0),
      active: list.some((g) => g.active()),
      backend: list.map((g) => g.feeder && g.feeder.backend).find(Boolean) || '',
      msPerFrame: Math.max(0, ...list.map((g) => g.msPerFrame())),
      // videos that would be shown late but are not: their sound cannot be delayed (yet)
      onTime: list.filter((g) => g.feeder && g.wantsAhead() && !g.ahead.on).length,
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
    this.broken = false; // the detector failed: tried again for the element's next video
    this.slowGpu = false; // the GPU answered too late: the CPU from now on
    this.unreadable = false; // a picture from another site, which the page may not read
    this.src = '';
    this.looping = false;
    this.overlay = new Overlay(video);
    this.ahead = new Lookahead(this);
    this.events = 0;
    this.shown = null; // without lookahead, the mitigation on show: { flashing, stripes, held }
    this.pausedByUs = false; // paused for flashing (mode 'pause'): it says so until played again
    this.fresh();
  }

  /** Forget what the detector has seen. */
  fresh() {
    this.lastT = -1;
    this.swings = [];
    this.above = {};
    this.flashUntil = -1;
    this.stripesUntil = -1;
    this.onset = 0;
    this.lastSwing = clock();
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

  /** Whether the flashing is being kept from view right now. */
  active() {
    return this.ahead.on ? this.ahead.active : !!(this.shown && this.shown.flashing);
  }

  /** Whether the video is to be shown late: lookahead is on, and the late copy can go over it. */
  wantsAhead() {
    const v = this.video;
    return settings.lookahead > 0 && !!this.feeder && document.fullscreenElement !== v && document.pictureInPictureElement !== v;
  }

  arm() {
    if (this.pausedByUs) {
      this.pausedByUs = false;
      this.ahead.unpaused(clock());
      this.update();
    }
    if (this.looping || !isOn()) return;
    const v = this.video;
    this.looping = true;
    if (typeof v.requestVideoFrameCallback === 'function') {
      const step = (now, meta) => {
        if (!this.picture((meta.expectedDisplayTime || now) / 1000)) return;
        v.requestVideoFrameCallback(step);
      };
      v.requestVideoFrameCallback(step);
    } else {
      // (no picture callbacks: every animation frame the video's time has moved)
      let last = -1;
      const step = (now) => {
        if (v.currentTime !== last) {
          last = v.currentTime;
          if (!this.picture(now / 1000)) return;
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

  /** A picture shown at `t` (the guard's clock). False when the loop is to stop. */
  picture(t) {
    const v = this.video;
    if (!isOn() || !v.isConnected) {
      this.looping = false;
      this.ahead.stop();
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
      else this.see(t);
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
        this.broken = true;
        console.warn('[unflash] no detector for this video', e);
      })
      .finally(() => (this.making = null));
  }

  /** Copy the picture on show (shown at `t`) for later, feed it to the detector, and read what it found. */
  see(t) {
    if (t <= this.lastT) return;
    this.lastT = t;
    const v = this.video;
    const f = this.feeder;
    // (lookahead on or off: on, the copy is what is shown, a moment from now)
    if (this.wantsAhead()) this.ahead.start();
    else this.ahead.stop();
    if (this.ahead.on) this.ahead.push(t);
    else if (settings.mode === 'hold' && !this.shown && t - this.lastSnap >= SNAP_EVERY_S) this.snap(t);
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
    if (t - this.lastSwing > FRESH_AFTER_S && !this.active() && this.fed > 1000) {
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
    this.ahead.stop();
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
    const now = clock();
    for (const r of recs) {
      this.lag += (now - r.t - this.lag) / Math.min(++this.verdicts, 30);
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
        // the flashing started at the first swing still counted, or where
        // the detector says the swings it is counting started
        let onset = this.swings.length ? this.swings[0] : r.t;
        if (violating) onset = Math.min(onset, r.t - Math.max(0, r.tc - Math.min(r.hazard_onset, r.hazard_red_onset)));
        onset -= ONSET_MARGIN_S;
        if (this.ahead.on) {
          // with lookahead, the pictures are replaced from where the flashing starts
          if (this.ahead.flag(onset, r.t + RELEASE_S)) this.flashed();
        } else {
          if (now > this.flashUntil) this.onset = onset;
          // (from when it is known: a verdict comes a little after its picture)
          this.flashUntil = now + RELEASE_S;
        }
      }
      if (this.flagPatterns && r.pattern >= pth) {
        if (this.ahead.on) this.ahead.flagStripes(r.t - ONSET_MARGIN_S, r.t + RELEASE_S);
        else this.stripesUntil = now + RELEASE_S;
      }
    }
    this.update();
    if (f.gpu && settings.detector === 'auto' && this.verdicts >= 10 && this.lag > SLOW_GPU_S && !this.active()) {
      console.debug(`[unflash] the GPU's verdicts come ${Math.round(this.lag * 1000)} ms late: the CPU detector from now on`);
      this.slowGpu = true;
      this.free();
      report();
    }
  }

  /** A new stretch of flashing (with lookahead: found before it is shown). */
  flashed() {
    this.events++;
    if (settings.mode === 'pause' && !this.video.paused) {
      this.video.pause();
      this.pausedByUs = true;
    }
    report();
  }

  // ---- without lookahead: as the video plays ----------------------------------------

  /** Keep the picture on show, small, to hold should flashing come. */
  snap(t) {
    const v = this.video;
    this.lastSnap = t;
    let s = this.snaps.length >= SNAP_KEEP ? this.snaps.shift() : null;
    // (the picture on show over the video is not drawn over)
    if (!s || s.canvas === this.overlay.drawn) s = { canvas: new OffscreenCanvas(1, 1) };
    const scale = Math.min(1, SNAP_MAX_W / v.videoWidth);
    if (!drawInto(s.canvas, v, Math.round(v.videoWidth * scale), Math.round(v.videoHeight * scale))) return;
    s.t = t;
    this.snaps.push(s);
  }

  /** The kept picture to hold: the last from before the flashing began (null: none kept from so long ago). */
  heldPicture() {
    let pick = null;
    for (const s of this.snaps) if (s.t < this.onset) pick = s.canvas;
    return pick;
  }

  /** Show what the flashing calls for now, or the video as it is (the lookahead draws its own). */
  update() {
    if (this.ahead.on) {
      this.release();
      return;
    }
    const now = clock();
    const v = this.video;
    const flashing = (this.feeder && now < this.flashUntil) || (this.pausedByUs && v.paused);
    const stripes = this.feeder && now < this.stripesUntil;
    if (!flashing && !stripes) {
      this.release();
      return;
    }
    const mode = settings.mode;
    if (flashing && !(this.shown && this.shown.flashing)) this.flashed();
    let held = this.shown && this.shown.flashing && this.shown.held;
    if (flashing && mode === 'hold' && !held && document.fullscreenElement !== v) held = this.heldPicture();
    if (!flashing) held = null;
    // (a video with no picture to hold, or shown full screen on its own, where nothing goes over it, is dimmed)
    const dim = flashing && (mode === 'dim' || (mode === 'hold' && !held));
    const blur = stripes && mode !== 'warn';
    setFilter(v, [dim ? DIM_FILTER : '', blur ? `blur(${blurPx(v)}px)` : ''].filter(Boolean).join(' '));
    const label = flashing ? (mode === 'hold' && !held ? LABELS.dim : LABELS[mode]) : mode === 'warn' ? 'Stripes' : 'Stripes blurred';
    this.overlay.paint(held, blur ? `blur(${blurPx(v)}px)` : '');
    this.overlay.label(settings.badge || mode === 'warn' ? label : '', flashing);
    this.shown = { flashing, stripes, held };
    // (the video may stop: the picture comes back when the time is up, pictures or not)
    clearTimeout(this.releaseTimer);
    const until = Math.max(this.flashUntil, this.stripesUntil);
    if (until > now) this.releaseTimer = setTimeout(() => this.update(), (until - now) * 1000 + 20);
  }

  /** The video as it is (without lookahead). */
  release() {
    clearTimeout(this.releaseTimer);
    if (!this.shown) return;
    this.shown = null;
    setFilter(this.video, '');
    if (!this.ahead.on) {
      this.overlay.paint(null);
      this.overlay.label('');
    }
    report();
  }

  seeking() {
    // (a picture from before the seek is from somewhere else in the video)
    // (with lookahead, those still to be shown are shown: a seek is seen as late as the rest)
    this.snaps = [];
  }

  settingsChanged(old) {
    if (!isOn()) {
      this.ahead.stop();
      this.release();
      this.free();
      return;
    }
    if (old.profile !== settings.profile || old.detector !== settings.detector) {
      this.broken = false;
      this.slowGpu = false;
      this.ahead.stop();
      this.release();
      this.free();
    }
    if (old.mode !== settings.mode || old.badge !== settings.badge || old.lookahead !== settings.lookahead) {
      this.pausedByUs = false;
      this.ahead.stop();
      this.release();
    }
    if (!this.video.paused) this.arm();
  }

  free() {
    if (this.feeder) this.feeder.det.free();
    this.feeder = null;
  }

  dispose() {
    this.ahead.stop();
    this.release();
    this.free();
    this.overlay.destroy();
  }
}

// ---- lookahead: the video shown late, judged before it is seen -------------------------

/**
 * The video shown `settings.lookahead` seconds late, over itself, its sound
 * as late: each picture copied as it plays (push), and shown when it is
 * due (render, every animation frame). The detector flags stretches of
 * flashing (flag) from where they start, which is still to be shown, and
 * the pictures in them are shown as the mode says.
 */
class Lookahead {
  constructor(guard) {
    this.g = guard;
    this.video = guard.video;
    this.audio = new AudioDelay(guard.video);
    this.on = false;
    this.frames = []; // { canvas, t }, oldest first
    this.pool = []; // canvases to copy into
    this.flashes = []; // { a, b, held }: stretches of flashing, on the guard's clock
    this.stripes = []; // { a, b }
    this.active = false; // a flagged picture is on show
    this.raf = 0;
    this.shownKey = '';
    this.render = this.render.bind(this);
  }

  get delay() {
    return settings.lookahead;
  }

  /** Show the video late, if its sound can be made as late (or it has none to hear). */
  start() {
    if (this.on) return;
    const v = this.video;
    if (!v.muted && v.volume > 0 && !this.audio.set(this.delay)) return;
    this.on = true;
    this.g.release();
    this.raf = requestAnimationFrame(this.render);
    console.debug(`[unflash] showing the video ${this.delay} s late, judged before it is seen`);
    report();
  }

  /** Show the video as it plays again. */
  stop() {
    if (!this.on) {
      // (its sound too, should it have been delayed)
      this.audio.set(0);
      return;
    }
    this.on = false;
    cancelAnimationFrame(this.raf);
    this.audio.set(0);
    this.pool.push(...this.frames.map((f) => f.canvas));
    this.frames = [];
    this.flashes = [];
    this.stripes = [];
    this.active = false;
    this.shownKey = '';
    this.g.overlay.paint(null);
    this.g.overlay.label('');
    report();
  }

  /** Copy the picture on show (shown at `t`), for when it is due. */
  push(t) {
    const v = this.video;
    // as large as it is shown (up to 720p): a copy larger than that would only cost memory
    const r = v.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    let k = Math.min(1, (r.width * dpr) / v.videoWidth, (r.height * dpr) / v.videoHeight);
    k = Math.min(k, Math.sqrt(AHEAD_MAX_PIXELS / (v.videoWidth * v.videoHeight)));
    const canvas = this.pool.pop() || new OffscreenCanvas(1, 1);
    if (!drawInto(canvas, v, Math.round(v.videoWidth * k), Math.round(v.videoHeight * k))) {
      this.pool.push(canvas);
      return;
    }
    this.frames.push({ canvas, t });
    // (the pictures already shown, but the last, are done with)
    const due = clock() - this.delay;
    while (this.frames.length > 1 && this.frames[1].t <= due - 0.05) this.pool.push(this.frames.shift().canvas);
  }

  /**
   * Flashing from `a` until `b` (the guard's clock): a stretch of its own,
   * true, or more of the last one. Its pictures are replaced by the last
   * one from before it, kept aside now.
   */
  flag(a, b) {
    const last = this.flashes[this.flashes.length - 1];
    if (last && a <= last.b) {
      last.b = Math.max(last.b, b);
      return false;
    }
    let held = null;
    for (const f of this.frames) if (f.t < a) held = f;
    // (none: the flashing started before the oldest copy kept, as at the start of a video; it is dimmed)
    if (held && settings.mode !== 'dim' && settings.mode !== 'warn') {
      const c = new OffscreenCanvas(held.canvas.width, held.canvas.height);
      c.getContext('2d').drawImage(held.canvas, 0, 0);
      held = c;
    } else held = null;
    this.flashes.push({ a, b, held });
    return true;
  }

  flagStripes(a, b) {
    const last = this.stripes[this.stripes.length - 1];
    if (last && a <= last.b) last.b = Math.max(last.b, b);
    else this.stripes.push({ a, b });
  }

  /** Paused for flashing, then played again: the stretch that paused it ends where it was. */
  unpaused(t) {
    const last = this.flashes[this.flashes.length - 1];
    if (last && last.b > t) last.b = t;
  }

  /** Every animation frame: show the picture that is due. */
  render() {
    if (!this.on) return;
    this.raf = requestAnimationFrame(this.render);
    const v = this.video;
    // (unmuted since: its sound is to be as late as its pictures, or the pictures go back to on time)
    if (!v.muted && v.volume > 0 && !this.audio.node && !this.audio.set(this.delay)) {
      this.stop();
      return;
    }
    const due = clock() - this.delay;
    // the last picture due; before any is due (the video just started, or
    // was sought), the first, held still until it is
    let f = null;
    for (const x of this.frames) {
      if (x.t <= due) f = x;
      else break;
    }
    if (!f) f = this.frames[0];
    if (!f) return;
    while (this.flashes.length && this.flashes[0].b < due - 10) this.flashes.shift();
    while (this.stripes.length && this.stripes[0].b < due - 10) this.stripes.shift();
    const flash = this.flashes.find((s) => f.t >= s.a && f.t <= s.b) || (this.g.pausedByUs && this.flashes.length && f.t >= this.flashes[this.flashes.length - 1].a ? this.flashes[this.flashes.length - 1] : null);
    const stripes = settings.mode !== 'warn' && this.stripes.some((s) => f.t >= s.a && f.t <= s.b);
    const mode = settings.mode;
    let source = f.canvas;
    let filter = '';
    if (flash) {
      if (flash.held) source = flash.held;
      else if (mode !== 'warn') filter = DIM_FILTER;
    }
    if (stripes) filter += ` blur(${blurPx(this.video)}px)`;
    const label = flash ? (flash.held || mode === 'dim' || mode === 'warn' ? LABELS[mode] : LABELS.dim) : stripes ? 'Stripes blurred' : '';
    const key = `${f.t}|${!!flash}|${filter}|${label}`;
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.g.overlay.paint(source, filter.trim(), true);
      this.g.overlay.label(settings.badge || mode === 'warn' ? label : '', !!flash);
      if (!!flash !== this.active) {
        this.active = !!flash;
        report();
      }
    } else {
      // (where the video is may change without a new picture: a scroll, a new size)
      this.g.overlay.place();
    }
  }
}

/**
 * The video's sound, delayed through Web Audio: the element's sound goes
 * through a DelayNode instead of straight out. Once routed it stays routed
 * (an element's sound can be taken only once); a delay of 0 plays it as it is.
 */
class AudioDelay {
  static all = new Set();

  /** A click or a key: the page may now start sound. */
  static gesture() {
    for (const a of AudioDelay.all) if (a.ctx && a.ctx.state !== 'running') a.ctx.resume().catch(() => {});
  }

  constructor(video) {
    this.video = video;
    this.ctx = null;
    this.node = null;
    this.failed = false; // the page has taken the element's sound itself
  }

  /** Delay the sound by `s` seconds: false when it cannot be (yet). */
  set(s) {
    if (!s) {
      if (this.node) this.node.delayTime.setValueAtTime(0, this.ctx.currentTime);
      return true;
    }
    if (this.failed) return false;
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext({ latencyHint: 'playback' });
        AudioDelay.all.add(this);
      }
      // (a page not yet clicked may start no sound: the element's own plays until one is)
      if (this.ctx.state !== 'running') {
        this.ctx.resume().catch(() => {});
        return false;
      }
      if (!this.node) {
        const src = this.ctx.createMediaElementSource(this.video);
        this.node = this.ctx.createDelay(5);
        src.connect(this.node).connect(this.ctx.destination);
      }
      this.node.delayTime.setValueAtTime(s, this.ctx.currentTime);
      return true;
    } catch (e) {
      console.debug('[unflash] the sound of this video cannot be delayed: it is shown as it plays', e);
      this.failed = true;
      return false;
    }
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

/** Draw `source` into `canvas` at w×h (resizing it first): false when it cannot be drawn. */
function drawInto(canvas, source, w, h) {
  w = Math.max(1, w);
  h = Math.max(1, h);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  try {
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
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
 * come later): a picture (the held one, or with lookahead the video shown
 * late), and a badge saying what was done.
 */
class Overlay {
  constructor(video) {
    this.video = video;
    this.host = null;
    this.drawn = null; // the source of the picture on show
    this.showing = false;
    this.labelled = false;
  }

  build() {
    this.host = document.createElement('unflash-overlay');
    const root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.badge = document.createElement('div');
    this.badge.className = 'badge';
    const dot = document.createElement('span');
    dot.className = 'dot';
    this.badgeText = document.createElement('span');
    this.badge.append(dot, this.badgeText);
    root.append(style, this.canvas, this.badge);
    this.resize = new ResizeObserver(() => this.host && this.host.isConnected && this.place());
    this.resize.observe(this.video);
  }

  /** Over the video, wherever it is now. */
  place() {
    const v = this.video;
    const host = this.host;
    if (!host || !v.parentNode) return null;
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

  /** Show `source` (a canvas, or null for none) over the video, with CSS filter `filter`; `redraw` even if it was drawn last. */
  paint(source, filter = '', redraw = false) {
    if (!source) {
      this.showing = false;
      this.drawn = null;
      if (this.canvas) this.canvas.classList.remove('on');
      this.detachIfIdle();
      return;
    }
    if (!this.host) this.build();
    this.showing = true;
    const vr = this.place();
    if (vr && (redraw || source !== this.drawn)) this.draw(source, vr);
    this.canvas.classList.add('on');
    this.canvas.style.filter = filter;
  }

  /** The badge: `text` ('' for none), red while `flashing`. */
  label(text, flashing = false) {
    if (!text && !this.host) return;
    if (!this.host) this.build();
    this.labelled = !!text;
    this.badge.classList.toggle('on', !!text);
    this.badge.classList.toggle('flashing', !!flashing);
    this.badgeText.textContent = text;
    if (text) this.place();
    else this.detachIfIdle();
  }

  detachIfIdle() {
    if (this.host && !this.showing && !this.labelled) this.host.remove();
  }

  /** Draw the picture as the video draws its own (contain, unless it says cover or fill). */
  draw(source, vr) {
    this.drawn = source;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(vr.width * dpr));
    const ch = Math.max(1, Math.round(vr.height * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    const fit = getComputedStyle(this.video).objectFit;
    const pw = source.width;
    const ph = source.height;
    let w = cw;
    let h = ch;
    if (fit !== 'fill') {
      const k = fit === 'cover' ? Math.max(cw / pw, ch / ph) : Math.min(cw / pw, ch / ph);
      w = pw * k;
      h = ph * k;
    }
    ctx.drawImage(source, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  destroy() {
    if (!this.host) return;
    this.resize.disconnect();
    this.host.remove();
    this.host = null;
  }
}
