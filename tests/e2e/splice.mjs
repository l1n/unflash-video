// The H.264 smart-cut export end to end, with a stand-in encoder: the
// source is splice_a (High profile, CABAC, B-frames); the spans the export
// "re-encodes" come from an encoder that hands back splice_b's samples
// (Main profile, CAVLC) for the same frames. The exported file, read with
// the built-in decoder (this Chromium has no H.264), shows splice_a's
// pictures outside the spans and splice_b's inside them, from one track
// whose record holds both streams' parameter sets. Also the full
// re-encode, and two spans two at a time.
//   node tests/e2e/splice.mjs
import { loadPlaywright } from './playwright.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { serve } from './server.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WEB = path.join(ROOT, 'web');
const CLIPS = path.join(WEB, 'clips');
fs.mkdirSync(CLIPS, { recursive: true });
for (const f of ['splice_a.mp4', 'splice_b.mp4']) fs.copyFileSync(path.join(ROOT, 'tests/media/h264', f), path.join(CLIPS, f));

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

const { chromium } = await loadPlaywright();
const { srv, port } = await serve(WEB);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
  if (process.env.E2E_VERBOSE) console.log('[browser]', m.type(), m.text());
});
await page.goto(`http://127.0.0.1:${port}/?auto=0&cpu=1`);
await page.waitForFunction(() => document.querySelector('#support').textContent.includes('WebGPU'), null, { timeout: 60000 });

const r = await page.evaluate(async () => {
  const wasm = await import('./pkg/unflash.js');
  const { Movie, decodeRange } = await import('./media.js');
  const { exportMovie, exportPlan } = await import('./export.js');
  const load = async (name) => {
    const blob = await (await fetch(`clips/${name}`)).blob();
    const m = await Movie.open(new File([blob], name, { type: 'video/mp4' }), wasm);
    const sup = await m.decoderSupport();
    if (!sup.supported) throw new Error(`${name}: ${sup.reason}`);
    return m;
  };
  const hash = (bytes) => {
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
    return h;
  };
  // every frame's picture, presentation order
  const pictures = async (m) => {
    const out = [];
    await decodeRange(m, m.tsMin, m.tsMax + 1, async (pic, t) => out.push({ t, h: hash(pic.data) }), { raw: true });
    return out;
  };
  const a = await load('splice_a.mp4');
  const b = await load('splice_b.mp4');
  const software = a.software;
  const ha = await pictures(a);
  const hb = await pictures(b);
  // splice_b's samples, to hand out as "encoder output" by timestamp
  const bDesc = b.dx.track_description(b.video.index);
  const bSamples = new Map();
  for (let i = 0; i < b.v.pts.length; i++) bSamples.set(b.v.pts[i], { bytes: (await b.reader.read(b.v.offset[i], b.v.size[i])).slice(), sync: !!b.v.sync[i] });
  const encoded = [];
  // a stand-in encoder that hands out splice_b's samples; `desc` is the record
  // it reports, `inband` parameter sets it puts in front of its IDR samples
  const standIn = (desc, inband = []) => (config, { output }) => {
    let first = true;
    return {
      encodeQueueSize: 0,
      configure() {},
      encode(frame, opts) {
        const s = bSamples.get(frame.timestamp);
        if (!s) throw new Error('no stand-in sample at ' + frame.timestamp);
        encoded.push({ t: frame.timestamp, key: !!(opts && opts.keyFrame) });
        let bytes = s.bytes;
        if (s.sync && inband.length) {
          const parts = [];
          for (const n of inband) parts.push(Uint8Array.of(0, 0, (n.length >> 8) & 255, n.length & 255), n);
          parts.push(bytes);
          bytes = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
          let o = 0;
          for (const x of parts) {
            bytes.set(x, o);
            o += x.length;
          }
        }
        output({ byteLength: bytes.length, copyTo: (dst) => dst.set(bytes), timestamp: frame.timestamp, duration: frame.duration, type: s.sync ? 'key' : 'delta' }, first ? { decoderConfig: { codec: b.video.codec, description: desc } } : {});
        first = false;
      },
      async flush() {},
      close() {},
    };
  };
  const makeEncoder = standIn(bDesc);
  // the record's parameter sets, and the same record written the way
  // Firefox's Windows encoder writes it: every set with its header byte twice
  const avccSets = (d) => {
    const out = { sps: [], pps: [] };
    let p = 6;
    for (let k = 0; k < (d[5] & 31); k++) {
      const len = (d[p] << 8) | d[p + 1];
      out.sps.push(d.slice(p + 2, p + 2 + len));
      p += 2 + len;
    }
    const npps = d[p++];
    for (let k = 0; k < npps; k++) {
      const len = (d[p] << 8) | d[p + 1];
      out.pps.push(d.slice(p + 2, p + 2 + len));
      p += 2 + len;
    }
    return out;
  };
  const bSets = avccSets(bDesc);
  const firefoxDesc = (() => {
    const bytes = [1, bDesc[1], bDesc[2], bDesc[3], 3, bSets.sps.length];
    for (const n of bSets.sps) bytes.push(((n.length + 1) >> 8) & 255, (n.length + 1) & 255, n[0], ...n);
    bytes.push(bSets.pps.length);
    for (const n of bSets.pps) bytes.push(((n.length + 1) >> 8) & 255, (n.length + 1) & 255, n[0], ...n);
    return Uint8Array.from(bytes);
  })();
  const candidate = { label: 'stand-in H.264', config: { codec: 'avc1.64000A', width: a.width, height: a.height } };
  const project = { sectionsSorted: () => [], sections: [] };
  const env = { wasm, feeder: null };
  const paramSets = (desc) => {
    const nsps = desc[5] & 31;
    let p = 6;
    for (let i = 0; i < nsps; i++) p += 2 + ((desc[p] << 8) | desc[p + 1]);
    return [nsps, desc[p]];
  };
  const run = async (name, opts, expectB) => {
    encoded.length = 0;
    const plan = await exportPlan(env, a, project, { codec: candidate.config.codec, ...opts });
    const res = await exportMovie(env, a, project, { quality: 7, candidate, makeEncoder, plan, ...opts });
    if (res.warnings.length) console.log(name + ': ' + res.warnings.join(' | '));
    const m = await Movie.open(new File([res.blob], 'out.mp4', { type: 'video/mp4' }), wasm);
    const sup = await m.decoderSupport();
    if (!sup.supported) throw new Error(`${name}: exported file: ${sup.reason}`);
    const ho = await pictures(m);
    const mismatches = [];
    for (let k = 0; k < ho.length; k++) {
      const want = expectB(k) ? hb[k] : ha[k];
      if (ho[k].h !== want.h || Math.abs(ho[k].t - want.t) > 1e-6) mismatches.push(k);
    }
    // decode times rise, and no frame is composed before it is decoded (the
    // edit list moves the presentation earlier by the reordering delay: the
    // demuxer's pts are the file's composition times plus edit_shift)
    let timing = true;
    for (let i = 0; i < m.v.dtsTicks.length; i++) {
      if (m.v.ptsTicks[i] - m.video.edit_shift < m.v.dtsTicks[i] || (i > 0 && m.v.dtsTicks[i] <= m.v.dtsTicks[i - 1])) timing = false;
    }
    const timingInfo = { editShift: m.video.edit_shift, first: Array.from({ length: 6 }, (_, i) => [m.v.ptsTicks[i], m.v.dtsTicks[i]]) };
    return { name, mode: res.mode, spans: res.spans, frames: res.frames, copied: res.copied, parallel: res.parallel, codec: res.codec, plan: plan.pieces.map((p) => `${p.kind} ${p.from}-${p.to}`), paramSets: paramSets(m.dx.track_description(m.video.index)), outFrames: ho.length, mismatches, timing, timingInfo, keyRequests: encoded.filter((e) => e.key).map((e) => e.t), size: res.blob.size, hasAudio: !!m.audio };
  };
  const results = {};
  // one span in the middle: GOP 1 (frames 10..19, an IDR every 10 frames)
  results.one = await run('one span', { spans: [[0.4, 0.5]], parallel: 1 }, (k) => k >= 10 && k < 20);
  // two spans, two at a time: GOPs 1 and 3
  results.two = await run('two spans', { spans: [[0.4, 0.5], [1.05, 1.1]], parallel: 2 }, (k) => (k >= 10 && k < 20) || k >= 30);
  // everything re-encoded (smart cut off), in parallel pieces
  results.full = await run('full', { smartCut: false, parallel: 2 }, () => true);
  // Firefox's Windows encoder: a record with every header byte twice, the
  // parameter sets again in front of each IDR sample
  results.firefox = await run('firefox-style encoder', { spans: [[0.4, 0.5], [1.05, 1.1]], parallel: 2, makeEncoder: standIn(firefoxDesc, [...bSets.sps, ...bSets.pps]) }, (k) => (k >= 10 && k < 20) || k >= 30);
  // a record nothing can read: the export is redone the plain way (one
  // encoder, no joining) instead of failing
  const garbage = Uint8Array.of(1, 0x4d, 0x40, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0xff, 0xff, 0xff, 0x01, 0x00, 0x02, 0x68, 0xff);
  const fb = await exportMovie(env, a, project, { quality: 7, candidate, makeEncoder: standIn(garbage), spans: [[0.4, 0.5]], parallel: 2 });
  const fbMovie = await Movie.open(new File([fb.blob], 'fallback.mp4', { type: 'video/mp4' }), wasm);
  results.fallback = { mode: fb.mode, frames: fb.frames, copied: fb.copied, spans: fb.spans, parallel: fb.parallel, warnings: fb.warnings, samples: fbMovie.v.pts.length, record: Array.from(fbMovie.dx.track_description(fbMovie.video.index)) };
  // an encoder that gives no record (WebCodecs' Annex B: start codes, the
  // parameter sets in front of each IDR picture): the record is made from
  // the first keyframe and the samples are converted, so it splices as well
  const annexB = (config, cb) => {
    const inner = standIn(undefined, [...bSets.sps, ...bSets.pps])(config, {
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        // 4-byte lengths -> start codes
        const out = [];
        for (let p = 0; p + 4 <= data.length; ) {
          const len = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3];
          out.push(0, 0, 0, 1, ...data.subarray(p + 4, p + 4 + len));
          p += 4 + len;
        }
        const bytes = Uint8Array.from(out);
        cb.output({ byteLength: bytes.length, copyTo: (dst) => dst.set(bytes), timestamp: chunk.timestamp, duration: chunk.duration, type: chunk.type }, meta);
      },
      error: cb.error,
    });
    return inner;
  };
  results.annexB = await run('annex-b encoder', { spans: [[0.4, 0.5]], parallel: 1, makeEncoder: annexB }, (k) => k >= 10 && k < 20);
  return { software, frames: ha.length, results };
});
console.log(JSON.stringify(r, null, 1));
assert(r.software, 'this Chromium decodes H.264 with the built-in decoder, which the check needs');
assert(r.frames === 40, 'splice_a has 40 frames');
const one = r.results.one;
assert(one.mode === 'smart' && one.spans === 1 && one.frames === 10 && one.copied === 30, 'one span: GOP 1 re-encoded, the rest copied: ' + JSON.stringify(one));
assert(one.plan.join(',') === 'copy 0-10,encode 10-20,copy 20-40', 'one span: the pieces: ' + one.plan.join(','));
assert(one.paramSets[0] === 2 && one.paramSets[1] === 2, 'one span: the record holds both streams\' parameter sets: ' + one.paramSets);
assert(one.outFrames === 40 && one.mismatches.length === 0, 'one span: every frame decodes as its source: mismatches ' + JSON.stringify(one.mismatches));
assert(one.timing, 'one span: decode times are consistent');
assert(one.keyRequests.length === 1 && one.keyRequests[0] === 333333, 'one span: the span starts with a keyframe request: ' + one.keyRequests);
assert(one.hasAudio === false, 'no audio in the test streams');
const two = r.results.two;
assert(two.mode === 'smart' && two.spans === 2 && two.frames === 20 && two.copied === 20 && two.parallel === 2, 'two spans: ' + JSON.stringify(two));
assert(two.plan.join(',') === 'copy 0-10,encode 10-20,copy 20-30,encode 30-40', 'two spans: the pieces: ' + two.plan.join(','));
assert(two.outFrames === 40 && two.mismatches.length === 0 && two.timing, 'two spans: every frame decodes as its source: ' + JSON.stringify(two.mismatches));
assert(two.paramSets[0] === 2 && two.paramSets[1] === 2, 'two spans: one extra set of parameter sets, shared by both spans: ' + two.paramSets);
const full = r.results.full;
assert(full.mode === 'full' && full.frames === 40 && full.copied === 0, 'full: everything re-encoded: ' + JSON.stringify(full));
assert(full.outFrames === 40 && full.mismatches.length === 0 && full.timing, 'full: every frame is the stand-in encoder\'s: ' + JSON.stringify(full.mismatches));
assert(full.paramSets[0] === 1 && full.paramSets[1] === 1, 'full: only the encoder\'s parameter sets: ' + full.paramSets);
const ff = r.results.firefox;
assert(ff.mode === 'smart' && ff.spans === 2 && ff.frames === 20 && ff.copied === 20, 'firefox-style encoder: the spans are spliced in: ' + JSON.stringify(ff));
assert(ff.outFrames === 40 && ff.mismatches.length === 0 && ff.timing, 'firefox-style encoder: every frame decodes as its source: ' + JSON.stringify(ff.mismatches));
assert(ff.paramSets[0] === 2 && ff.paramSets[1] === 2, 'firefox-style encoder: the repaired sets join the source\'s: ' + ff.paramSets);
const fbr = r.results.fallback;
assert(fbr.mode === 'full' && fbr.frames === 40 && fbr.copied === 0 && fbr.spans === 1 && fbr.parallel === 1, 'an unreadable record: the export is redone by one encoder: ' + JSON.stringify(fbr));
assert(fbr.samples === 40 && /re-encoded by one encoder/.test(fbr.warnings[0] || ''), 'and says so: ' + JSON.stringify(fbr));
assert(JSON.stringify(fbr.record) === JSON.stringify([1, 0x4d, 0x40, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0xff, 0xff, 0xff, 0x01, 0x00, 0x02, 0x68, 0xff]), 'the unreadable record goes in as it came: ' + JSON.stringify(fbr.record));
assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
const ab = r.results.annexB;
assert(ab.mode === 'smart' && ab.frames === 10 && ab.copied === 30, 'an Annex B encoder with no record: spliced all the same: ' + JSON.stringify(ab));
assert(ab.outFrames === 40 && ab.mismatches.length === 0 && ab.timing, 'an Annex B encoder: every frame decodes as its source: ' + JSON.stringify(ab.mismatches));
assert(ab.paramSets[0] === 2 && ab.paramSets[1] === 2, 'an Annex B encoder: its parameter sets join the source\'s: ' + ab.paramSets);
console.log('SPLICE OK');
await browser.close();
srv.close();
