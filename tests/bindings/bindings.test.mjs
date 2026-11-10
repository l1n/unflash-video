// The WebAssembly module as the page calls it (crates/unflash-wasm), in Node:
// what crosses as JSON has the shape the page reads, what cannot be done is
// an exception that says why, and nothing a file or a typed-in number can
// hold traps the module (a trap ends it for the page: every call after it
// fails).
//
//   ./build.sh && node --test tests/bindings/bindings.test.mjs
//
// The module has to be built (web/pkg). Where it is not, the tests say
// SKIPPED; with UNFLASH_NO_SKIPS set (CI, which has just built it) that is a
// failure, as it is for the Rust tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROFILES } from '../../web/project.js';

const glue = new URL('../../web/pkg/unflash.js', import.meta.url);
const module = new URL('../../web/pkg/unflash_bg.wasm', import.meta.url);
const built = existsSync(fileURLToPath(glue)) && existsSync(fileURLToPath(module));
if (!built && process.env.UNFLASH_NO_SKIPS) throw new Error('the WebAssembly module is not built (./build.sh), and UNFLASH_NO_SKIPS is set');
const wasm = built ? await import(glue) : null;
if (wasm) await wasm.default({ module_or_path: readFileSync(fileURLToPath(module)) });

const it = (name, fn) => test(name, { skip: built ? false : 'SKIPPED: the WebAssembly module is not built (./build.sh)' }, fn);

/** What `fn` is refused with, in words. A trap is not a refusal. */
function refusal(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(!(e instanceof WebAssembly.RuntimeError), `the module trapped: ${e}`);
    return e instanceof Error ? e.message : String(e);
  }
  return assert.fail('it went through');
}

const EXT = () => wasm.profile_config('wcag_ext');
const flash = (start, end, extra = {}) => ({ start, end, kind: 'flash', count: 1.5, onset: start, peak: start, ...extra });
const result = (extra = {}) => JSON.stringify({ events: [], violations: [], flag_extended: true, flag_patterns: true, ...extra });

it('a profile is its settings, and the settings name their profile', () => {
  // (the names a kept project may hold, web/project.js: the detector's own, the default first)
  assert.deepEqual(PROFILES, ['wcag_ext', 'wcag', 'strict']);
  assert.equal(wasm.profile_name('{}'), PROFILES[0]);
  for (const name of PROFILES) {
    const cfg = wasm.profile_config(name);
    assert.equal(wasm.profile_name(cfg), name);
    assert.equal(typeof JSON.parse(cfg).flash_limit, 'number');
  }
  const ext = EXT();
  const wcag = wasm.profile_config('wcag');
  // a signature for what can change a verdict: not how a scan is cut into sections
  const sig = wasm.config_signature(ext);
  assert.match(sig, /^[0-9a-f]{12}$/);
  assert.notEqual(wasm.config_signature(wcag), sig);
  const padded = JSON.stringify({ ...JSON.parse(ext), section_pad: 9 });
  assert.equal(wasm.config_signature(padded), sig);
  assert.equal(wasm.profile_name(padded), 'custom');
  // settings left out are the default profile's
  assert.equal(wasm.profile_name('{}'), 'wcag_ext');

  assert.deepEqual([wasm.context_seconds(ext), wasm.context_seconds(wcag)], [6.5, 4.5]);
  assert.deepEqual([wasm.safe_picture_rate(ext), wasm.safe_picture_rate(wcag)], [3.8, 5.71]);
  assert.deepEqual([wasm.rate_is_guaranteed(ext, 3.8), wasm.rate_is_guaranteed(ext, 3.81)], [true, false]);

  assert.match(refusal(() => wasm.profile_config('nope')), /^unknown profile nope$/);
  assert.match(refusal(() => wasm.context_seconds('{')), /^bad detector config: /);
  assert.match(refusal(() => wasm.config_signature('{"flash_limit":"three"}')), /^bad detector config: /);
});

it("a scan's violations become sections and a count for each second", () => {
  const violations = [flash(10, 10.5, { onset: 9.2 }), flash(12, 12.2, { kind: 'red' }), flash(30, 30.1, { kind: 'extended' })];
  const sections = JSON.parse(wasm.violations_to_sections(JSON.stringify(violations), EXT(), 0, 100, new Float64Array()));
  assert.deepEqual(sections, [
    { start: 7.7, end: 13.7, kinds: ['flash', 'red'] },
    { start: 28.5, end: 31.6, kinds: ['extended'] },
  ]);
  // grown to the keyframes around them
  const snapped = JSON.parse(wasm.violations_to_sections(JSON.stringify(violations), EXT(), 0, 100, Float64Array.of(0, 5, 10, 15, 20, 25, 30, 35)));
  assert.deepEqual(snapped.map((s) => [s.start, s.end]), [[5, 15], [25, 35]]);
  // a profile that does not report extended flashes has no section for one
  assert.equal(JSON.parse(wasm.violations_to_sections(JSON.stringify(violations), wasm.profile_config('wcag'), 0, 100, new Float64Array())).length, 1);

  const event = (t, kind) => ({ t, tc: t, kind, area: 1, bbox: [0, 0, 2, 2] });
  const scanned = result({ events: [event(2, 'general'), event(2.9, 'general'), event(3, 'red')], violations: [flash(4.2, 5.5, { kind: 'pattern', count: 2 })] });
  assert.deepEqual(JSON.parse(wasm.timeline_summary(scanned, 2, 8, 1)), {
    bin: 1,
    t0: 2,
    general: [2, 0, 0, 0, 0, 0],
    red: [0, 1, 0, 0, 0, 0],
    pattern: [0, 0, 2, 2, 0, 0],
  });

  assert.match(refusal(() => wasm.violations_to_sections('[{"start":1}]', EXT(), 0, 100, new Float64Array())), /^bad violations: /);
  assert.match(refusal(() => wasm.timeline_summary('nothing', 0, 100, 1)), /^bad analysis result: /);
});

it('timestamps that span years (a damaged file) make lists a page can hold, not a trap', () => {
  // (a 32-bit sample duration at a timescale of one is 4.3e9 s; each of these used to end the module)
  for (const far of [4.3e9, 1e13, 1e300]) {
    const summary = JSON.parse(wasm.timeline_summary(result(), 0, far, 1));
    assert.equal(summary.general.length, 1 << 18, `${far}`);
    assert.equal(summary.bin, far / (1 << 18));
    const sections = JSON.parse(wasm.violations_to_sections(JSON.stringify([flash(10, far / 2)]), EXT(), 0, far, new Float64Array()));
    assert.equal(sections.length, 1 << 12, `${far}`);
    assert.ok(sections.every((s, i) => s.start < s.end && (i === 0 || s.start === sections[i - 1].end)));
  }
  // and numbers that are none
  for (const [lo, hi] of [[NaN, 1], [0, NaN], [0, Infinity], [-Infinity, 0], [5, -5]]) {
    for (const bin of [1, 0, -1, NaN]) assert.ok(JSON.parse(wasm.timeline_summary(result(), lo, hi, bin)).general.length <= 1 << 18);
    assert.ok(JSON.parse(wasm.violations_to_sections(JSON.stringify([flash(1, 2)]), EXT(), lo, hi, new Float64Array())).length <= 1);
  }
  assert.equal(typeof wasm.version(), 'string');
});

it("a section's frame times, as the page asks for them", () => {
  assert.deepEqual(JSON.parse(wasm.sanitize_deltas(Float64Array.of(0, 0.25, 0.5, 0.125, 9, 9.25), 5)), { times: [0, 0.25, 0.5, 0.75, 1, 1.25], fixed: 2 });
  assert.deepEqual(JSON.parse(wasm.sanitize_deltas(new Float64Array(), 5)), { times: [], fixed: 0 });
  assert.equal(wasm.median_dt(Float64Array.of(0, 0.25, 0.25, 0.5, 1)), 0.25);
  assert.equal(wasm.median_dt(Float64Array.of(2)), 1 / 30);

  // the frame at the section's end is the next span's: shown are the three before it
  const pts = Float64Array.of(0.25, 0.5, 0.75, 1);
  assert.deepEqual(JSON.parse(wasm.section_timeline(pts, 10, 11)), { rel: [0, 0.25, 0.5, 0.75], n_out: 3, total: 0.75, base: 0.25, med: 0.25 });
  const shown = wasm.shown_pts(pts, 10, 11);
  assert.ok(shown instanceof Float64Array);
  assert.deepEqual(Array.from(shown), [0, 0.25, 0.5]);
  assert.deepEqual(JSON.parse(wasm.section_timeline(new Float64Array(), 10, 11)), { rel: [], n_out: 0, total: 1, base: 0, med: 1 / 30 });
  assert.deepEqual(Array.from(wasm.shown_pts(new Float64Array(), 10, 11)), []);

  assert.deepEqual([wasm.parse_time('83.5'), wasm.parse_time(' 1:23.5 '), wasm.parse_time('0:01:23.5')], [83.5, 83.5, 83.5]);
  for (const typed of ['', 'x', '1:', 'nan', 'inf', '1e400', '1:2:x']) assert.equal(wasm.parse_time(typed), undefined, typed);
  assert.deepEqual([wasm.format_time(83.5), wasm.format_time(3683.5), wasm.format_time(-1), wasm.format_time(NaN)], ['1:23.500', '1:01:23.500', '0:00.000', '0:00.000']);
});

it("a section's marks: what each frame shows, when, and where the picture waits", () => {
  const removed = (fill) => ({ removed: true, extended: false, fill });
  const marks = JSON.stringify({ 1: removed('prev'), 2: removed('next'), 4: { extended: true } });
  const rep = wasm.replacement_map(marks, 6);
  assert.ok(rep instanceof Uint32Array);
  assert.deepEqual(Array.from(rep), [0, 0, 3, 3, 4, 5]);
  // no marks at all, as an empty string or an empty object
  assert.deepEqual(Array.from(wasm.replacement_map('', 3)), [0, 1, 2]);
  assert.deepEqual(Array.from(wasm.replacement_map('{}', 3)), [0, 1, 2]);
  // marks on frames the section does not have are no one's
  assert.deepEqual(Array.from(wasm.replacement_map(JSON.stringify({ 7: removed('prev') }), 2)), [0, 1]);

  const pts = Float64Array.of(0, 0.25, 0.5, 0.75, 1, 1.25);
  // frame 4 is held half a second: frame 5 comes that much later
  assert.deepEqual(JSON.parse(wasm.edited_sequence(pts, marks, 0.5)), { t: [0, 0.25, 0.5, 0.75, 1, 1.75], src: [0, 0, 3, 3, 4, 5] });
  assert.deepEqual(JSON.parse(wasm.section_holds(pts, marks, 0.5, 1.5)), [{ at: 1.25, seconds: 0.5 }]);
  // the last frame's hold is at the section's end
  assert.deepEqual(JSON.parse(wasm.section_holds(pts, JSON.stringify({ 5: { extended: true } }), 0.5, 1.5)), [{ at: 1.5, seconds: 0.5 }]);

  // the frames a failing window covers (a twentieth of a second either side)
  assert.deepEqual(Array.from(wasm.flagged_frames(pts, JSON.stringify([flash(0.5, 0.75, { onset: 0.3 })]))), [1, 2, 3]);
  assert.deepEqual(Array.from(wasm.flagged_frames(pts, '[]')), []);

  // a suggestion replaces the marks in its scope, but not on frames marked keep
  const mine = JSON.stringify({ 1: removed('next'), 2: { extended: true }, 5: removed('prev') });
  const suggested = JSON.stringify({ 2: removed('prev'), 3: removed('prev') });
  assert.deepEqual(Object.keys(JSON.parse(wasm.apply_suggestion(mine, suggested, undefined, undefined))), ['2', '3']);
  const scoped = JSON.parse(wasm.apply_suggestion(mine, suggested, '[1,2,3]', '[2]'));
  assert.deepEqual(scoped, { 2: { removed: false, extended: true, fill: 'prev' }, 3: removed('prev'), 5: removed('prev') });

  assert.match(refusal(() => wasm.replacement_map('{"x":{}}', 3)), /^bad edits: /);
  assert.match(refusal(() => wasm.replacement_map('{"-1":{}}', 3)), /^bad edits: /);
  assert.match(refusal(() => wasm.edited_sequence(pts, '[1]', 0.5)), /^bad edits: /);
  assert.match(refusal(() => wasm.apply_suggestion('{}', '{}', '{"a":1}', undefined)), /^bad selection: /);
  assert.match(refusal(() => wasm.flagged_frames(pts, 'nothing')), /^bad violations: /);
});

it('a check sorts what it found by where it lands', () => {
  // a section of two seconds; the next one begins a second after it ends
  const found = result({ violations: [flash(-3, -2), flash(-1, 0.1), flash(0.5, 1), flash(2.5, 2.8), flash(3.2, 4), flash(1, 1.5, { kind: 'extended' })], flag_extended: false });
  const sorted = JSON.parse(wasm.classify(EXT(), found, 2, 1));
  const starts = (list) => list.map((v) => v.start);
  // (flashing that only just reaches the first frame is the run-up's; what the profile does not report is nowhere)
  assert.deepEqual([starts(sorted.before), starts(sorted.inside), starts(sorted.after), starts(sorted.elsewhere)], [[-3, -1], [0.5], [2.5], [3.2]]);
  // with no section after it, everything past its end is the footage after
  assert.deepEqual(starts(JSON.parse(wasm.classify(EXT(), found, 2, undefined)).after), [2.5, 3.2]);
  assert.match(refusal(() => wasm.classify(EXT(), '{"violations":3}', 2, undefined)), /^bad analysis result: /);
});

it('thinning to a rate: the proposal and what is said of it', () => {
  // 24 pictures a second for two seconds
  const pts = Float64Array.from({ length: 48 }, (_, i) => i / 24);
  const p = JSON.parse(wasm.rate_proposal(EXT(), pts, '{}', undefined, undefined, 0.5, undefined));
  // the profile's safe rate: 3.8 a second is a picture every 0.263 s, every seventh frame
  assert.deepEqual([p.fps, p.safe_fps, p.guaranteed, p.pool, p.only, p.kept], [3.8, 3.8, true, 48, false, 0]);
  const kept = Array.from({ length: 48 }, (_, i) => i).filter((i) => !(i in p.removals));
  assert.deepEqual(kept, [0, 7, 14, 21, 28, 35, 42]);
  assert.equal(p.n_removed, 41);
  assert.deepEqual(p.edits, p.removals);
  assert.equal(wasm.rate_note(JSON.stringify(p), true), 'Thinned to 3.8/s: 7 of 48 frames kept, 41 removed.');
  assert.match(wasm.rate_note(JSON.stringify(p), false), /Still failing\. The flashing that is left runs into the footage either side/);

  // a rate of one's own, in a selection, with a frame marked keep
  const own = JSON.parse(wasm.rate_proposal(EXT(), pts, '{}', JSON.stringify(Array.from({ length: 24 }, (_, i) => i)), 12, 0.5, '[1]'));
  assert.deepEqual([own.fps, own.guaranteed, own.pool, own.only, own.kept], [12, false, 24, true, 1]);
  // every other frame of the selection goes; the kept frame stays and sets the pace for those after it
  assert.deepEqual(Object.keys(own.removals).map(Number), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  assert.equal(wasm.rate_note(JSON.stringify(own), false).startsWith('Thinned to 12/s: 13 of 24 frames in the selection kept, 11 removed. Still failing above the guaranteed-safe 3.8/s.'), true);
  assert.match(wasm.rate_note(JSON.stringify(own), true), /^Thinned to 12\/s: .* in the selection kept, .* That is above the guaranteed-safe 3\.8\/s/);

  for (const typed of [0, -5, 1001, NaN, Infinity]) assert.match(refusal(() => wasm.rate_proposal(EXT(), pts, '{}', undefined, typed, 0.5, undefined)), /^A target rate has to be between 0 and 1000/, `${typed}`);
  assert.equal(refusal(() => wasm.rate_proposal(EXT(), new Float64Array(), '{}', undefined, undefined, 0.5, undefined)), 'Section has no frames');
  assert.match(refusal(() => wasm.rate_note('{"fps":"fast"}', true)), /^bad rate proposal: /);
});

/** A `w`×`h` RGBA picture of one colour. */
const flat = (w, h, [r, g, b]) => {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([r, g, b, 255], i * 4);
  return px;
};

it("a section's cached frames: kept, joined, blended and blurred", () => {
  const cache = new wasm.FrameCache(4, 2);
  assert.deepEqual([cache.len(), cache.is_empty(), cache.width(), cache.height(), cache.byte_length()], [0, true, 4, 2, 0]);
  // RGBA as a capture comes, or RGB
  assert.equal(cache.push(flat(4, 2, [10, 20, 30])), 0);
  assert.equal(cache.push(new Uint8Array(4 * 2 * 3).fill(200)), 1);
  assert.deepEqual([cache.len(), cache.is_empty(), cache.byte_length()], [2, false, 48]);
  assert.deepEqual(Array.from(cache.frame(0).subarray(0, 8)), [10, 20, 30, 255, 10, 20, 30, 255]);
  assert.deepEqual(Array.from(cache.frame(1).subarray(0, 4)), [200, 200, 200, 255]);
  assert.equal(refusal(() => cache.frame(2)), 'no such frame');
  assert.equal(refusal(() => cache.push(new Uint8Array(5))), 'frame has 5 bytes, expected 32 (RGBA) or 24 (RGB)');
  assert.equal(cache.len(), 2);

  // another span's frames go on the end, and leave where they were
  const more = new wasm.FrameCache(4, 2);
  more.push(flat(4, 2, [100, 100, 100]));
  cache.append(more);
  assert.deepEqual([cache.len(), more.len(), more.byte_length()], [3, 0, 0]);
  assert.deepEqual(Array.from(cache.frame(2).subarray(0, 4)), [100, 100, 100, 255]);
  const other = new wasm.FrameCache(2, 2);
  assert.equal(refusal(() => cache.append(other)), 'cannot join a 2×2 cache onto a 4×2 one');

  // the middle frame, blended all the way, is the frames either side of it, half and half
  const blended = cache.blended(Uint8Array.of(0, 1, 0), 1);
  assert.deepEqual(Array.from(blended.frame(1).subarray(0, 4)), [55, 60, 65, 255]);
  assert.deepEqual(Array.from(blended.frame(0)), Array.from(cache.frame(0)));
  // half way: half of itself as well
  assert.deepEqual(Array.from(cache.blended(Uint8Array.of(0, 1, 0), 0.5).frame(1).subarray(0, 4)), [128, 130, 133, 255]);
  // a mask shorter than the cache marks nothing past its end; the cache itself is as it was
  assert.deepEqual(Array.from(cache.blended(new Uint8Array(), 1).frame(1)), Array.from(cache.frame(1)));
  // blurring a flat picture leaves it flat, marked or not
  const blurred = cache.blurred(2, Uint8Array.of(1, 0, 0));
  assert.deepEqual([blurred.len(), Array.from(blurred.frame(0)), Array.from(blurred.frame(1))], [3, Array.from(cache.frame(0)), Array.from(cache.frame(1))]);

  for (const c of [cache, more, other, blended, blurred]) c.free();
});

it('pictures made small where they are decoded', () => {
  const k = new wasm.Shrinker(4, 4, 2, 2);
  assert.deepEqual([k.fits(4, 4, 2, 2), k.fits(4, 4, 2, 1), k.fits(8, 4, 2, 2)], [true, false, false]);
  // four quarters, one colour each, with eight bytes of padding after every row
  const quarters = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [80, 80, 80]];
  const stride = 4 * 4 + 8;
  const picture = new Uint8Array(4 + 4 * stride);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) picture.set([...quarters[(y >> 1) * 2 + (x >> 1)], 255], 4 + y * stride + x * 4);
  // (the address is good until the module's memory next grows: taken, then written at once)
  const put = (bytes) => new Uint8Array(wasm.wasm_memory().buffer, k.input(bytes.length), bytes.length).set(bytes);
  put(picture);
  assert.deepEqual(Array.from(k.packed(4, stride, false)), [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 80, 80, 80, 255]);
  // B first, as some decoders give it
  assert.deepEqual(Array.from(k.packed(4, stride, true)), [0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 80, 80, 80, 255]);
  assert.equal(refusal(() => k.packed(4, 8, false)), 'picture data too short for its size');
  assert.equal(refusal(() => k.packed(64, stride, false)), 'picture data too short for its size');

  // 4:2:0, full range: mid grey with no colour is mid grey
  const yuv = new Uint8Array(16 + 4 + 4).fill(128);
  put(yuv);
  assert.deepEqual(Array.from(k.yuv(Uint32Array.of(0, 0, 4, 16, 2, 20, 2, 0, 1))), new Array(4).fill([128, 128, 128, 255]).flat());
  assert.equal(refusal(() => k.yuv(Uint32Array.of(0, 0, 4))), 'bad picture layout');
  assert.equal(refusal(() => k.yuv(Uint32Array.of(0, 0, 4, 16, 2, 4000, 2, 0, 1))), 'picture data too short for its layout');
  k.free();
  assert.equal(refusal(() => new wasm.Shrinker(0, 4, 2, 2)), 'a 0×4 picture has nothing to make small');
});

it('the detector, fed as the page feeds it', () => {
  const det = new wasm.Detector(wasm.profile_config('wcag'), 640, 480);
  const [aw, ah] = [det.analysis_width(), det.analysis_height()];
  // 640×480 fills the model's 1024×768 screen, which is analysed at a quarter of its size each way
  assert.deepEqual([aw, ah, det.pending(), det.can_submit()], [256, 192, 0, true]);
  assert.ok(det.area_thresh() > 0 && det.window_width() <= aw && det.window_height() <= ah && det.pattern_thresh() > 0 && det.bytes_per_frame() > 0);

  // eight flashes a second over the whole picture, for two seconds at 24 a second
  const dark = flat(aw, ah, [20, 20, 20]);
  const light = flat(aw, ah, [230, 230, 230]);
  for (let i = 0; i < 48; i++) det.feed_rgba(i % 3 === 1 ? light : dark, aw, ah, i / 24, i === 4);
  const records = JSON.parse(det.drain_records());
  assert.deepEqual([records.length, records[0].index, records[47].index, records[47].t], [48, 0, 47, 47 / 24]);
  assert.equal(det.drain_records(), '[]');
  // the picture asked for, once
  const capture = det.take_capture(4);
  assert.deepEqual([capture.length, Array.from(capture.subarray(0, 4))], [aw * ah * 4, [230, 230, 230, 255]]);
  assert.equal(det.take_capture(4), undefined);
  assert.equal(det.take_capture(5), undefined);

  const partial = JSON.parse(det.partial_verdict());
  const whole = JSON.parse(det.finish(false));
  const stats = JSON.parse(det.finish(true));
  assert.deepEqual(partial.violations.map((v) => v.kind), ['flash']);
  assert.deepEqual([partial.frames, whole.frames, stats.frames], [48, 48, 48]);
  assert.deepEqual(whole.violations, partial.violations);
  assert.ok(!('events' in partial) && whole.events.length > 0);
  assert.deepEqual([whole.frame_stats.t.length, stats.frame_stats.t.length, stats.frame_stats.hazard.length], [0, 48, 48]);
  // every violation as the page reads one
  assert.deepEqual(Object.keys(whole.violations[0]).sort(), ['count', 'end', 'kind', 'onset', 'peak', 'start']);

  // a picture of another size is made small first; BGRA has its channels swapped; 4:2:0 is converted
  det.reset();
  assert.equal(JSON.parse(det.finish(false)).frames, 0);
  det.feed_rgba(flat(64, 48, [200, 0, 0]), 64, 48, 0, true);
  det.feed_bgra(flat(64, 48, [0, 0, 200]), 64, 48, 0.04, true);
  det.feed_yuv(new Uint8Array(64 * 48 * 3 / 2).fill(128), 64, 48, Uint32Array.of(0, 0, 64, 64 * 48, 32, 64 * 48 + 32 * 24, 32, 0, 1), 0.08, true);
  assert.deepEqual(Array.from(det.take_capture(0).subarray(0, 4)), [200, 0, 0, 255]);
  assert.deepEqual(Array.from(det.take_capture(1).subarray(0, 4)), [200, 0, 0, 255]);
  assert.deepEqual(Array.from(det.take_capture(2).subarray(0, 4)), [128, 128, 128, 255]);

  // a cached frame goes in without leaving the module, if it is the detector's size
  const cache = new wasm.FrameCache(aw, ah);
  cache.push(dark);
  det.feed_cached(cache, 0, 0.12);
  assert.equal(JSON.parse(det.finish(false)).frames, 4);
  assert.equal(refusal(() => det.feed_cached(cache, 1, 0.16)), 'no such cached frame');
  const wrong = new wasm.FrameCache(4, 2);
  wrong.push(flat(4, 2, [0, 0, 0]));
  assert.equal(refusal(() => det.feed_cached(wrong, 0, 0.16)), `cache is 4x2 but the detector analyses at ${aw}x${ah}`);

  assert.equal(refusal(() => det.feed_rgba(new Uint8Array(0), 0, 48, 1, false)), 'empty picture');
  assert.equal(refusal(() => det.feed_rgba(new Uint8Array(16), 64, 48, 1, false)), 'frame data too short');
  assert.equal(refusal(() => det.feed_bgra(new Uint8Array(16), 64, 48, 1, false)), 'frame data too short');
  assert.equal(refusal(() => det.feed_yuv(new Uint8Array(16), 64, 48, Uint32Array.of(0, 0, 64, 3072, 32, 3840, 32, 0, 1), 1, false)), 'picture data too short for its layout');
  assert.equal(refusal(() => det.feed_yuv(new Uint8Array(16), 64, 48, new Uint32Array(3), 1, false)), 'bad picture layout');
  // nothing refused was counted
  assert.equal(JSON.parse(det.finish(false)).frames, 4);
  assert.match(refusal(() => new wasm.Detector('not json', 640, 480)), /^bad detector config: /);

  // a source of no size, or of any, has a detector of a size that can be analysed
  for (const [w, h] of [[0, 0], [1, 1], [65535, 1], [1, 65535], [4294967295, 4294967295]]) {
    const odd = new wasm.Detector(EXT(), w, h);
    assert.ok(odd.analysis_width() >= 2 && odd.analysis_width() <= 256 && odd.analysis_height() >= 2 && odd.analysis_height() <= 192, `${w}×${h}`);
    odd.free();
  }
  for (const x of [det, cache, wrong]) x.free();
});

/** A file of `samples` (each { bytes, dts, pts, duration, sync }, in ticks) on one VP9 track, as an export writes it. */
function muxed(samples, timescale) {
  const mx = new wasm.Muxer();
  const track = mx.add_video_track('vp09.00.10.08', 64, 48, timescale, new Uint8Array());
  const parts = [mx.start()];
  for (const s of samples) {
    parts.push(s.bytes);
    mx.add_sample(track, s.dts, s.pts, s.duration, s.sync, s.bytes.length);
  }
  parts.push(mx.finish());
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    file.set(p, at);
    at += p.length;
  }
  // the size of the samples' box, known only now
  file.set(mx.patch_bytes(), mx.patch_offset());
  mx.free();
  return file;
}

/** The file's index read as the page reads it: the range asked for, fed, until it is done (in `most` reads at most). */
function demuxed(file, most = 1000) {
  const dx = new wasm.Demuxer(file.length);
  for (let rounds = 0; !dx.is_done(); rounds++) {
    assert.ok(rounds < most, `the reader is still asking after ${most} reads`);
    const need = dx.need();
    if (!need.length) break;
    dx.feed(need[0], file.subarray(need[0], need[0] + need[1]));
  }
  return dx;
}

it('an export written and read back: the same samples at the same times', () => {
  // (in decode order, the third shown before the second)
  const samples = [
    { bytes: Uint8Array.of(1, 2, 3, 4, 5), dts: 0, pts: 0, duration: 1000, sync: true },
    { bytes: Uint8Array.of(6, 7, 8), dts: 1000, pts: 2000, duration: 1000, sync: false },
    { bytes: Uint8Array.of(9), dts: 2000, pts: 1000, duration: 1000, sync: false },
    { bytes: Uint8Array.of(10, 11), dts: 3000, pts: 3000, duration: 500, sync: true },
  ];
  const file = muxed(samples, 30000);
  const dx = demuxed(file);
  assert.deepEqual([dx.is_done(), dx.progress(), dx.container()], [true, 1, 'mp4']);
  const movie = JSON.parse(dx.movie_json());
  assert.deepEqual([movie.format, movie.fragmented, movie.tracks.length], ['mp4', false, 1]);
  const t = movie.tracks[0];
  assert.deepEqual([t.index, t.kind, t.fourcc, t.codec, t.timescale, t.width, t.height, t.samples, t.copyable, t.note], [0, 'video', 'vp09', 'vp09.00.10.08', 30000, 64, 48, 4, true, '']);
  const column = (field) => Array.from(dx.sample_table(0, field));
  assert.deepEqual(column('size'), [5, 3, 1, 2]);
  assert.deepEqual(column('sync'), [1, 0, 0, 1]);
  assert.deepEqual(column('dts_ticks'), [0, 1000, 2000, 3000]);
  assert.deepEqual(column('pts_ticks'), [0, 2000, 1000, 3000]);
  assert.deepEqual(column('duration_ticks'), [1000, 1000, 1000, 500]);
  // (in microseconds: the nearest whole one)
  assert.deepEqual(column('pts_us'), [0, 66667, 33333, 100000]);
  assert.deepEqual(column('dts_us'), [0, 33333, 66667, 100000]);
  assert.deepEqual(column('duration_us'), [33333, 33333, 33333, 16667]);
  // each sample's bytes are where its offset says
  const offsets = column('offset');
  samples.forEach((s, i) => assert.deepEqual(Array.from(file.subarray(offsets[i], offsets[i] + s.bytes.length)), Array.from(s.bytes)));
  assert.deepEqual(Array.from(dx.keyframe_times(0)), [0, 0.1]);
  // the keyframe a decoder starts from to show a time
  assert.deepEqual([dx.sync_before(0, 0), dx.sync_before(0, 0.09), dx.sync_before(0, 0.1), dx.sync_before(0, 99), dx.sync_before(0, -5)], [0, 0, 3, 3, 0]);
  // the track's sample entry, to copy it into another file as it is
  const entry = dx.track_sample_entry(0);
  assert.equal(String.fromCharCode(...entry.subarray(4, 8)), 'vp09');

  assert.equal(refusal(() => dx.sample_table(0, 'colour')), 'unknown sample field colour');
  assert.equal(refusal(() => dx.sample_table(1, 'size')), 'no such track');
  assert.equal(refusal(() => dx.keyframe_times(7)), 'no such track');
  dx.free();


  // a muxer asked for what it cannot write
  const mx = new wasm.Muxer();
  assert.equal(refusal(() => mx.add_sample(0, 0, 0, 1, true, 1)), 'call start() first');
  assert.equal(refusal(() => mx.finish()), 'call start() first');
  assert.equal(refusal(() => mx.use_description(0, 5)), 'no such track');
  assert.deepEqual([mx.patch_offset(), Array.from(mx.patch_bytes())], [-1, []]);
  const theora = mx.add_video_track('theora', 64, 48, 30000, new Uint8Array());
  mx.start();
  mx.add_sample(theora, 0, 0, 1, true, 1);
  assert.equal(refusal(() => mx.finish()), 'unsupported video codec for muxing: theora');
  mx.free();
});

it('a file that is no video is refused in so many words, and soon', () => {
  const text = new TextEncoder().encode('These are words in a row, and no video at all.\n'.repeat(40));
  const packets = new Uint8Array(188 * 4);
  for (let i = 0; i < 4; i++) packets[i * 188] = 0x47;
  for (const [file, why] of [
    [new Uint8Array(), /^no moov box found \(not an MP4 file\?\)$/],
    [Uint8Array.of(0), /^no moov box found/],
    [new Uint8Array(64), /^no moov box found/],
    [text, /^box .{4} at 0 has an impossible size \d+$/],
    [new Uint8Array(4096).fill(0xff), /has an impossible size 4294967295$/],
    // the first bytes of a Matroska file and nothing after; transport stream packets that carry nothing
    [Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x80), /^not a Matroska file \(no segment found\)$/],
    [packets, /^no program found in this transport stream \(no PAT\/PMT\)$/],
  ]) {
    // (soon: by the second read)
    assert.match(refusal(() => demuxed(file, 2).free()), why);
  }
  // before its index is read there is no movie to ask about
  const early = new wasm.Demuxer(64);
  assert.deepEqual([early.is_done(), Array.from(early.need())], [false, [0, 64]]);
  assert.equal(refusal(() => early.movie_json()), 'not parsed yet');
  assert.equal(refusal(() => early.sample_table(0, 'size')), 'not parsed yet');
  early.free();
});

it('H.264 records that are none are refused, not read', () => {
  assert.equal(typeof refusal(() => wasm.h264_probe(Uint8Array.of(1, 2, 3))), 'string');
  assert.equal(typeof refusal(() => wasm.h264_probe(new Uint8Array())), 'string');
  assert.equal(typeof refusal(() => new wasm.H264Decoder(new Uint8Array(64).fill(0xff), false)), 'string');
  assert.equal(typeof refusal(() => new wasm.AvcRegistry(Uint8Array.of(1))), 'string');
  // the NAL length size is in the record's fifth byte (four where there is none)
  assert.deepEqual([wasm.avcc_nal_length_size(Uint8Array.of(1, 100, 0, 31, 0xff)), wasm.avcc_nal_length_size(Uint8Array.of(1, 100, 0, 31, 0xfc)), wasm.avcc_nal_length_size(new Uint8Array())], [4, 1, 4]);
  // a sample with no slice in it yet, and one that starts with an IDR slice (type 5)
  assert.equal(wasm.h264_first_vcl_nal_type(new Uint8Array(), 4), 0);
  assert.equal(wasm.h264_first_vcl_nal_type(Uint8Array.of(0, 0, 0, 2, 0x09, 0xf0, 0, 0, 0, 2, 0x65, 0x88), 4), 5);
  assert.equal(wasm.h264_first_vcl_nal_type(Uint8Array.of(0, 0, 0, 2, 0x41, 0x9a), 4), 1);
  assert.equal(wasm.avcc_record(Uint8Array.of(1, 2), Uint8Array.of(3)), undefined);
  assert.equal(typeof refusal(() => wasm.audio_sample_entry('mp3', new Uint8Array(), 44100, 2)), 'string');
  // after all that was refused, the module still answers
  assert.equal(wasm.format_time(1), '0:01.000');
});
