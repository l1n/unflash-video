// Timing of the pipeline's operations, summarised on the console at debug
// level (enable "Debug" / "Verbose" messages in the devtools console to see
// them, or read window.__unflash.profile.summary() at any time).

class Profile {
  constructor() {
    this.ops = new Map(); // name -> { n, ms, max }
    this.notes = new Map(); // free-form facts (the picture route, the decoder)
    this.lastReport = 0;
  }

  /** Account `ms` milliseconds to `name` (`n` operations). */
  add(name, ms, n = 1) {
    let o = this.ops.get(name);
    if (!o) {
      o = { n: 0, ms: 0, max: 0 };
      this.ops.set(name, o);
    }
    o.n += n;
    o.ms += ms;
    if (ms > o.max) o.max = ms;
  }

  time(name, fn) {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }

  async timeAsync(name, fn) {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }

  note(key, value) {
    this.notes.set(key, value);
  }

  reset() {
    this.ops.clear();
    this.notes.clear();
    this.lastReport = 0;
  }

  /**
   * The operations as text, one per line, costliest first: total, mean per
   * call, calls, worst call, and (when `frames` is known) the cost per
   * frame. Latencies (submit to result, waiting for a decoder) overlap
   * other work, so their totals are not time spent by the page.
   */
  summary(frames = 0) {
    const rows = [...this.ops.entries()].sort((a, b) => b[1].ms - a[1].ms);
    const lines = [];
    for (const [name, o] of rows) {
      const perFrame = frames > 0 && !/latency|wait/.test(name) ? ` · ${(o.ms / frames).toFixed(2)} ms/frame` : '';
      lines.push(`  ${name.padEnd(16)} ${o.ms.toFixed(0).padStart(7)} ms total · ${(o.ms / Math.max(1, o.n)).toFixed(2)} ms/call · ${o.n} calls · max ${o.max.toFixed(1)} ms${perFrame}`);
    }
    return lines.join('\n');
  }

  /** One console.debug message: the label, the throughput, the notes and the operations. */
  report(label, frames, elapsedMs) {
    const head = frames > 0 && elapsedMs > 0 ? `${label}: ${frames} frames in ${(elapsedMs / 1000).toFixed(2)} s = ${(frames / (elapsedMs / 1000)).toFixed(1)} fps` : label;
    const notes = [...this.notes.entries()].map(([k, v]) => `${k}: ${v}`).join(' · ');
    console.debug(`[unflash] ${head}${notes ? '\n  ' + notes : ''}\n${this.summary(frames)}`);
    this.lastReport = performance.now();
  }

  /** report() at most every `everyMs` (progress reports during long jobs). */
  reportEvery(everyMs, label, frames, elapsedMs) {
    if (performance.now() - this.lastReport >= everyMs) this.report(label, frames, elapsedMs);
  }
}

export const profile = new Profile();
