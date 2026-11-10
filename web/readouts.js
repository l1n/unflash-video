// What the page says and draws from numbers alone: the steps between a
// timeline's ticks, how long a job took, where a video's sound starts
// against its picture, the name an export is saved under, the envelope the
// chart reads flashing at the limit rate from. No page is
// needed for any of it, so that each can be held to its rule in Node
// (tests/unit/readouts.test.mjs).

/**
 * The seconds between the ticks of a time axis that wants them `raw`
 * seconds apart at least: the next round step up. Past an hour the steps
 * double, so that an axis has a dozen ticks whatever it spans (a damaged
 * file's timestamps can span years, and at a tick an hour the page did
 * nothing but draw them).
 */
export function niceStep(raw) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  for (const s of steps) if (s >= raw) return s;
  let s = 3600;
  while (s < raw) s *= 2;
  return s;
}

/** How long a job took, in words: "42 s", "3 min 5 s", "1 h 12 min" (rounded to the second first, so that no minute has 60 of them). */
export function fmtWait(secs) {
  if (secs < 90) return `${Math.round(secs)} s`;
  const total = Math.round(secs);
  const m = Math.floor(total / 60);
  return m < 60 ? `${m} min ${total % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Where a video's sound starts against its picture, in words, from each
 * one's earliest time (µs on the one clock): "starts with the picture",
 * "starts 701 ms before the picture" (a recording that begins part-way
 * through a scene has sound before its first whole picture), "starts 67 ms
 * after the picture". Null where either has no time.
 */
export function soundStart(pictureUs, soundUs) {
  if (!Number.isFinite(pictureUs) || !Number.isFinite(soundUs)) return null;
  const ms = Math.round((soundUs - pictureUs) / 1000);
  if (ms === 0) return 'starts with the picture';
  const by = Math.abs(ms) < 10000 ? `${Math.abs(ms)} ms` : `${(Math.abs(ms) / 1000).toFixed(1)} s`;
  return `starts ${by} ${ms < 0 ? 'before' : 'after'} the picture`;
}

/** `raw` as a file name: no characters a file system refuses, no path, ending in .mp4 (null: nothing left). */
export function cleanExportName(raw) {
  let n = String(raw || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!n) return null;
  if (!/\.mp4$/i.test(n)) n = n.replace(/\.(mov|m4v|mkv|webm|avi|mp4v)$/i, '') + '.mp4';
  return n;
}

/** Seconds either side over which "flashing at the limit rate" is read: it comes in spikes, one per transition. */
export const ENVELOPE_S = 0.25;

/**
 * The trace's flashing at the limit rate as an envelope, from frame `first`
 * to the last at or before `t1`: at each frame the most within
 * ENVELOPE_S either side, so a stretch of it reads as one.
 */
export function limitRateEnvelope(n, first, t1) {
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
