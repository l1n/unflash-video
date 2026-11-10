// Stand-ins for what a scan needs of the page, so that web/analysis.js's
// chunked scan runs in Node as it is: a film of nothing but an index, a
// built-in decoder that hands back blank pictures, and a detector that
// counts what it is fed.

/** A film `seconds` long at `fps`, a keyframe every `gop` pictures: its index, and a decoder for it. */
export function fakeMovie({ seconds = 60, fps = 30, gop = 30, width = 1920, height = 1080 } = {}) {
  const n = Math.round(seconds * fps);
  const pts = new Float64Array(n);
  const sync = new Uint8Array(n);
  const size = new Uint32Array(n);
  const offset = new Float64Array(n);
  let at = 0;
  for (let i = 0; i < n; i++) {
    pts[i] = Math.round((i * 1e6) / fps);
    sync[i] = i % gop === 0 ? 1 : 0;
    size[i] = sync[i] ? 40000 : 4000;
    offset[i] = at;
    at += size[i];
  }
  /** The built-in H.264 decoder as the scan drives it: a picture for every sample, made small. */
  class Decoder {
    set_shrink(aw, ah) {
      this.aw = aw;
      this.ah = ah;
    }
    decode() {
      return true;
    }
    flush() {
      return false;
    }
    frame_damaged() {
      return false;
    }
    small() {
      return new Uint8Array(this.aw * this.ah * 4);
    }
    width() {
      return width;
    }
    height() {
      return height;
    }
    free() {}
  }
  const reader = {
    fork: () => reader,
    read: async () => new Uint8Array(1),
    release() {},
  };
  return {
    software: true,
    softwarePool: async () => null,
    builtIn: { id: 'h264', name: 'H.264' },
    wasm: { H264Decoder: Decoder },
    v: { pts, dts: pts, sync, size, offset },
    dx: {
      track_description: () => new Uint8Array(0),
      sync_before(_track, t) {
        let k = 0;
        for (let i = 0; i < n; i++) if (sync[i] && pts[i] / 1e6 <= t + 1e-9) k = i;
        return k;
      },
    },
    video: { index: 0, codec: 'avc1.64001f' },
    reader,
    file: { name: 'film.mp4' },
    tsMin: 0,
    tsMax: (pts[n - 1] + 1e6 / fps) / 1e6,
    fps,
    frameCount: n,
    width,
    height,
    duration: seconds,
  };
}

/**
 * What a scan runs in: a detector that takes `feedMs` over each picture
 * and finds nothing (or fails at picture number `failAt`). `fed` holds the
 * time of each picture it was given.
 */
export function fakeEnv({ feedMs = 0, failAt = -1 } = {}) {
  const fed = [];
  const feeder = {
    aw: 256,
    ah: 144,
    backend: 'cpu',
    det: { free() {} },
    reset() {
      fed.length = 0;
    },
    async videoFrame(pic, t) {
      if (fed.length === failAt) {
        pic.close();
        throw new Error('the detector failed');
      }
      fed.push(t);
      pic.close();
      if (feedMs) await new Promise((r) => setTimeout(r, feedMs));
    },
    records: () => [],
    async drain() {},
    finish: () => ({ violations: [] }),
    partialVerdict: () => ({ violations: [], flag_extended: false, flag_patterns: false }),
  };
  const wasm = {
    context_seconds: () => 6.5,
    violations_to_sections: () => '[]',
    timeline_summary: () => '{}',
    sanitize_deltas: (times, maxGap) => JSON.stringify(sanitizeDeltas(Array.from(times), maxGap === undefined ? 5 : maxGap)),
    merge_scan_segments: () => JSON.stringify({ violations: [] }),
  };
  return { env: { wasm, config: '{}', feeder }, fed, feeder };
}

/**
 * The detector's clock over `times`, as the module's sanitize_deltas gives
 * it (`Clock` in crates/unflash-core): a step that does not go forwards, or
 * is longer than `maxGap`, is taken as the median of the last 120 good ones
 * (a thirtieth of a second before there is one). tests/bindings holds the
 * module's to the case the unit tests use.
 */
export function sanitizeDeltas(times, maxGap) {
  const out = [];
  const recent = [];
  let fixed = 0;
  let at = times.length ? times[0] : 0;
  for (let i = 0; i < times.length; i++) {
    let step = 0;
    if (i > 0) {
      const dt = times[i] - times[i - 1];
      if (dt <= 0 || dt > maxGap) {
        fixed++;
        const sorted = [...recent].sort((a, b) => a - b);
        const n = sorted.length;
        step = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 1 / 30;
      } else {
        step = dt;
        recent.push(dt);
        if (recent.length > 120) recent.shift();
      }
    }
    at += step;
    out.push(at);
  }
  return { times: out, fixed };
}

/** `promise`'s outcome, or 'pending' if it has none after `ms`. */
export function within(promise, ms) {
  let timer;
  const late = new Promise((r) => {
    timer = setTimeout(() => r('pending'), ms);
  });
  return Promise.race([promise.then((v) => ({ value: v }), (e) => ({ error: e })), late]).finally(() => clearTimeout(timer));
}
