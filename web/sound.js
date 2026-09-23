// The sound of the edited timeline. Frames marked E are held: the picture
// waits, and so must the sound. Where and for how long comes from one list,
// the section's holds (`editing::holds` in the core crate, `section_holds`
// here): the same list sets the frame times, so the picture and the sound
// cannot disagree about where a hold is. SoundRun places decoded source
// sound on the edited timeline by that list; the export encodes what it
// makes, and the section player plays it.

/**
 * The sound of the edited timeline as one unbroken run of samples, handed
 * on in blocks as `emit(planes, n, start)`: `n` samples per channel (the
 * planes are views, only good for the call), starting at output sample
 * `start`. Decoded source sound comes in (`add`) in order and goes out at
 * its time on the edited timeline: its source time plus the seconds of
 * every hold at or before it, the rule the frames follow. A hold that falls
 * inside a piece of sound cuts it there, and its silence goes between, with
 * a 5 ms fade either side so it does not click. Gaps in the source stay
 * silent; overlaps keep what came first.
 *
 * `holds` are `{ at, seconds }` in source seconds, in order.
 */
export class SoundRun {
  constructor(rate, channels, holds, emit, { block = 4096 } = {}) {
    this.rate = rate;
    this.ch = channels;
    this.holds = holds;
    this.emit = emit;
    this.next = 0; // the next hold to place
    this.held = 0; // seconds of silence placed so far
    this.placed = 0;
    this.block = block;
    this.fade = Math.max(1, Math.round(rate * 0.005));
    // samples not yet handed on: the last `fade` wait for a silence to fade into
    this.buf = Array.from({ length: channels }, () => new Float32Array(2 * block + this.fade));
    this.len = 0;
    this.start = null; // output sample of buf[0]
    this.faded = this.fade; // samples of the current fade-in done
  }

  /** Output second of source second `t`: `t` plus every hold at or before it. */
  static outTime(holds, t) {
    let held = 0;
    for (const h of holds) {
      if (h.at > t) break;
      held += h.seconds;
    }
    return t + held;
  }

  /** Start at source second `t`: the holds before it are behind (their seconds counted, their silence not made). */
  from(t) {
    while (this.next < this.holds.length && this.holds[this.next].at < t) {
      this.held += this.holds[this.next].seconds;
      this.next++;
    }
    return this;
  }

  /** One decoded AudioData, in source time (its timestamp). */
  add(data) {
    const n = data.numberOfFrames;
    const planes = [];
    for (let c = 0; c < this.ch; c++) {
      const p = new Float32Array(n);
      if (c < data.numberOfChannels) data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
      else p.set(planes[0]); // more channels out than in: the first again
      planes.push(p);
    }
    this.addPlanes(planes, n, data.timestamp / 1e6, data.sampleRate);
  }

  /** Sound as planes of `n` samples at `rate`, starting at source second `t0`. */
  addPlanes(planes, n, t0, rate) {
    if (rate !== this.rate) throw new Error(`the sound changes rate (${rate} Hz, not ${this.rate} Hz)`);
    let from = 0;
    while (this.next < this.holds.length) {
      const h = this.holds[this.next];
      const k = Math.round((h.at - t0) * rate);
      if (k >= n) break; // a later piece's
      const cut = Math.min(n, Math.max(from, k));
      if (cut > from) this.sound(planes, from, cut, t0 + from / rate);
      this.silence(h);
      from = cut;
    }
    if (from < n) this.sound(planes, from, n, t0 + from / rate);
  }

  /** Sound `planes[..][a..b)`, which starts at source second `t`. */
  sound(planes, a, b, t) {
    const at = Math.round((t + this.held) * this.rate);
    if (this.start === null) this.start = at;
    const end = this.start + this.len;
    if (at > end) this.zeros(at - end);
    else if (at < end) a = Math.min(b, a + (end - at));
    while (a < b) {
      const m = Math.min(b - a, this.buf[0].length - this.len);
      for (let c = 0; c < this.ch; c++) {
        const dst = this.buf[c];
        dst.set(planes[c].subarray(a, a + m), this.len);
        // fading in after a silence
        for (let j = 0; j < m && this.faded + j < this.fade; j++) dst[this.len + j] *= (this.faded + j + 1) / (this.fade + 1);
      }
      this.faded = Math.min(this.fade, this.faded + m);
      this.len += m;
      a += m;
      this.drain(false);
    }
  }

  /** Hold `h`'s silence, where the edited timeline has got to. */
  silence(h) {
    if (this.start === null) this.start = Math.round((h.at + this.held) * this.rate);
    // fade out what comes before it
    const f = Math.min(this.fade, this.len);
    for (let c = 0; c < this.ch; c++) {
      const b = this.buf[c];
      for (let j = 0; j < f; j++) b[this.len - f + j] *= (f - j) / (f + 1);
    }
    const end = this.start + this.len;
    this.held += h.seconds;
    this.next++;
    this.placed++;
    this.zeros(Math.round((h.at + this.held) * this.rate) - end);
    this.faded = 0;
  }

  zeros(n) {
    while (n > 0) {
      const m = Math.min(n, this.buf[0].length - this.len);
      for (let c = 0; c < this.ch; c++) this.buf[c].fill(0, this.len, this.len + m);
      this.len += m;
      n -= m;
      this.drain(false);
    }
  }

  /** Hand on whole blocks, keeping the last `fade` samples back (all, when `all`). */
  drain(all) {
    while (this.len >= this.block + (all ? 0 : this.fade) || (all && this.len > 0)) {
      const m = Math.min(this.block, this.len);
      this.emit(
        this.buf.map((b) => b.subarray(0, m)),
        m,
        this.start
      );
      for (let c = 0; c < this.ch; c++) this.buf[c].copyWithin(0, m, this.len);
      this.len -= m;
      this.start += m;
    }
  }

  /** The rest of the sound. Holds after its end add nothing: there is no sound to wait. */
  finish() {
    this.drain(true);
  }
}

/** Planes (`n` samples each) as one f32-planar AudioData starting at output sample `start`. */
export function audioData(planes, n, start, rate) {
  const data = new Float32Array(planes.length * n);
  for (let c = 0; c < planes.length; c++) data.set(planes[c].subarray(0, n), c * n);
  return new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: planes.length, timestamp: Math.round((start * 1e6) / rate), data });
}

/** Source second of output second `x` (the inverse of SoundRun.outTime); inside a hold's silence, the hold's moment. */
export function sourceTime(holds, x) {
  let held = 0;
  for (const h of holds) {
    if (x < h.at + held) break;
    if (x < h.at + held + h.seconds) return h.at;
    held += h.seconds;
  }
  return x - held;
}

/** Seconds of sound the section player decodes at a time. */
const WINDOW_S = 20;
/** How long before a window ends the next is decoded. */
const AHEAD_S = 8;

/**
 * The section player's sound: the section's source sound on its edited
 * timeline, placed by its holds exactly as the export places it (SoundRun),
 * and played with Web Audio in step with the player's clock. It is decoded
 * `WINDOW_S` seconds at a time as the playing gets there. Off until turned
 * on (`setOn`, from a click: browsers start sound only after one); plays at
 * normal speed only.
 */
export class SectionSound {
  constructor() {
    this.on = false;
    this.ctx = null;
    this.out = null;
    this.plan = null; // { movie, holds, start, end } of the section playing
    this.key = '';
    this.windows = new Map(); // index -> Promise<{ a, b, buffer } | null>
    this.sources = [];
    this.gen = 0;
    this.base = null;
    this.clock = null; // the section moment the sound plays at a wall time, while it plays
    this.speed = 1;
    this.failed = null; // why there is no sound, once known
    this.onFail = null;
    this.log = []; // what was started when (tests)
  }

  /** Turn the sound on or off (on: from a click). */
  async setOn(on) {
    this.on = on;
    if (!on) return this.halt();
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.out = this.ctx.createGain();
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    if (this.base) this.follow(this.base, this.speed);
  }

  /**
   * The section about to play: `plan` as sectionRenderPlan makes it (its
   * holds, when edited). Windows decoded for another section, or other
   * marks, are dropped.
   */
  use(movie, plan) {
    const start = plan.sec.start + plan.base;
    const end = plan.end + plan.extra;
    const key = JSON.stringify([movie.name, movie.file && movie.file.size, start, end, plan.holds]);
    this.plan = { movie, holds: plan.holds, start, end };
    if (key === this.key) return;
    this.key = key;
    this.windows.clear();
  }

  /**
   * Keep in step with a clock that reads `base.media` (output seconds) at
   * `base.wall` (performance.now()). A clock that slipped less than 150 ms
   * from the sound playing keeps it playing; more starts it again there.
   */
  follow(base, speed) {
    const now = performance.now();
    if (this.clock && this.on && speed === 1 && this.speed === 1) {
      const drift = base.media + (now - base.wall) / 1000 - (this.clock.media + (now - this.clock.wall) / 1000);
      if (Math.abs(drift) < 0.15) {
        this.base = base;
        return;
      }
    }
    this.halt();
    this.base = base;
    this.speed = speed;
    if (!this.on || !this.ctx || speed !== 1 || !this.plan || !this.plan.movie.audio) return;
    this._play(this.gen).catch((e) => {
      this.failed = e && e.message ? e.message : String(e);
      console.warn('[unflash] section sound:', e);
      if (this.onFail) this.onFail(this.failed);
    });
  }

  /** Stop the sound (a pause, a stop, the end of a pass). */
  halt() {
    this.gen++;
    this.clock = null;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch (e) {
        /* not started */
      }
      s.disconnect();
    }
    this.sources = [];
  }

  async _play(gen) {
    const { start, end } = this.plan;
    const mediaAt = (wall) => this.base.media + (wall - this.base.wall) / 1000;
    let k = Math.max(0, Math.floor((mediaAt(performance.now()) - start) / WINDOW_S));
    let w = await this._window(k);
    if (gen !== this.gen) return;
    // the Web Audio clock that plays the moment `media` of the section: sound
    // leaves the speakers `outputLatency` after it is played, so it is played that much early
    const ctx = this.ctx;
    const lat = ctx.outputLatency || ctx.baseLatency || 0;
    const wall = performance.now();
    const map = { ctx: ctx.currentTime - lat, media: mediaAt(wall) };
    const when = (x) => map.ctx + (x - map.media);
    this.clock = { wall, media: map.media };
    for (;;) {
      if (w) {
        const src = ctx.createBufferSource();
        src.buffer = w.buffer;
        src.connect(this.out);
        const t = when(w.a);
        const now = ctx.currentTime + 0.01;
        const skip = Math.max(0, now - t);
        if (skip < w.b - w.a) {
          src.start(Math.max(t, now), skip);
          this.sources.push(src);
          src.onended = () => {
            const i = this.sources.indexOf(src);
            if (i >= 0) this.sources.splice(i, 1);
          };
          this.log.push({ a: w.a, b: w.b, at: Math.max(t, now), skip, media: map.media + (Math.max(t, now) - map.ctx) });
          if (this.log.length > 20) this.log.shift();
        }
      }
      const b = start + (k + 1) * WINDOW_S;
      if (b >= end) return;
      // the next window, decoded a little before it is needed
      const wait = (when(b) - AHEAD_S - ctx.currentTime) * 1000;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (gen !== this.gen) return;
      k++;
      w = await this._window(k);
      if (gen !== this.gen) return;
      // (only this window and the next are kept)
      for (const i of this.windows.keys()) if (i < k - 1) this.windows.delete(i);
    }
  }

  /** Window `k` of the section's edited sound, decoded (null: no sound there). */
  _window(k) {
    if (!this.windows.has(k)) {
      const p = this._decode(k).catch((e) => {
        this.windows.delete(k);
        throw e;
      });
      this.windows.set(k, p);
    }
    return this.windows.get(k);
  }

  async _decode(k) {
    const { movie, holds, start, end } = this.plan;
    const at = movie.audio;
    const a = movie.a;
    const A = start + k * WINDOW_S;
    const B = Math.min(end, A + WINDOW_S);
    if (!(B > A)) return null;
    // the source sound for it, from a little before (the decoder warms up on it)
    const from = sourceTime(holds, A) - 0.3;
    const to = sourceTime(holds, B) + 0.1;
    const pts = a.pts;
    let lo = 0;
    let hi = pts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pts[mid] + a.dur[mid]) / 1e6 <= from) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;
    let last = first;
    while (last < pts.length && pts[last] / 1e6 < to) last++;
    if (last <= first) return null;
    const desc = movie.dx.track_description(at.index);
    const cfg = { codec: at.codec, sampleRate: at.sample_rate, numberOfChannels: at.channels };
    if (desc.length) cfg.description = desc;
    if (!(await AudioDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) throw new Error(`this browser can't decode the sound (${at.codec})`);
    const reader = movie.reader ? movie.reader.fork() : null;
    const prefix = at.prefix && at.prefix.length ? Uint8Array.from(at.prefix) : null;
    let buffer = null;
    let run = null;
    let error = null;
    let a0 = 0;
    let n = 0;
    const dec = new AudioDecoder({
      output: (data) => {
        try {
          if (!run) {
            const rate = data.sampleRate;
            a0 = Math.round(A * rate);
            n = Math.max(1, Math.round(B * rate) - a0);
            buffer = this.ctx.createBuffer(Math.min(32, data.numberOfChannels), n, rate);
            const planes = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
            run = new SoundRun(rate, buffer.numberOfChannels, holds, (p, m, s) => {
              // the part of the block inside the window
              const i0 = Math.max(s, a0);
              const i1 = Math.min(s + m, a0 + n);
              for (let c = 0; c < planes.length && i1 > i0; c++) planes[c].set(p[c].subarray(i0 - s, i1 - s), i0 - a0);
            }).from(from);
          }
          run.add(data);
        } catch (e) {
          error = error || e;
        } finally {
          data.close();
        }
      },
      error: (e) => (error = error || e),
    });
    try {
      dec.configure(cfg);
      for (let i = first; i < last && !error; i++) {
        let bytes = reader ? await reader.read(a.offset[i], a.size[i]) : new Uint8Array(await movie.file.slice(a.offset[i], a.offset[i] + a.size[i]).arrayBuffer());
        if (prefix) {
          const b = new Uint8Array(prefix.length + bytes.length);
          b.set(prefix);
          b.set(bytes, prefix.length);
          bytes = b;
        }
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((a.ptsTicks[i] * 1e6) / at.timescale), duration: Math.round((a.durTicks[i] * 1e6) / at.timescale), data: bytes.slice() }));
      }
      if (!error) await dec.flush();
    } finally {
      try {
        dec.close();
      } catch (e) {
        /* closed */
      }
      if (reader && reader.release) reader.release();
    }
    if (error) throw error;
    if (!run) return null;
    run.finish();
    return { a: a0 / buffer.sampleRate, b: (a0 + n) / buffer.sampleRate, buffer };
  }
}
