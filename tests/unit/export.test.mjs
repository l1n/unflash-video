// The export (web/export.js): the level each codec string names, the
// formats offered, and the plan (which stretches are re-encoded, which are
// copied from the source as they are).
import test from 'node:test';
import assert from 'node:assert/strict';
import { av1Level, estimateExportBytes, exportPlan, formatChoices, formatInfo, hevcLevel, vp9Level } from '../../web/export.js';

test('a VP9 export names the lowest level its size and rate fit', () => {
  // (the WebM project's table: luma samples a second, samples a picture, the longer side)
  assert.equal(vp9Level(256, 144, 20), '10');
  assert.equal(vp9Level(256, 144, 30), '11');
  assert.equal(vp9Level(640, 360, 30), '21');
  assert.equal(vp9Level(1280, 720, 30), '31');
  assert.equal(vp9Level(1920, 1080, 30), '40');
  assert.equal(vp9Level(1920, 1080, 60), '41');
  assert.equal(vp9Level(3840, 2160, 30), '50');
  assert.equal(vp9Level(3840, 2160, 60), '51');
  assert.equal(vp9Level(7680, 4320, 30), '60');
  // a narrow picture is held to its longer side: 2048 samples wide is level 3 at least
  assert.equal(vp9Level(2048, 16, 30), '30');
  assert.equal(vp9Level(16, 2048, 30), '30');
  // the rate alone can ask for more: 640x360 at 120 pictures a second
  assert.equal(vp9Level(640, 360, 120), '31');
  // past every level, the highest there is
  assert.equal(vp9Level(16384, 8192, 240), '62');
});

test('an AV1 export names its level as an av01 codec string has it', () => {
  // (the specification's annex A.3: seq_level_idx, two digits)
  assert.equal(av1Level(256, 144, 30), '00');
  assert.equal(av1Level(640, 360, 30), '01');
  assert.equal(av1Level(1280, 720, 30), '05');
  assert.equal(av1Level(1920, 1080, 30), '08');
  assert.equal(av1Level(1920, 1080, 60), '09');
  assert.equal(av1Level(3840, 2160, 30), '12');
  assert.equal(av1Level(3840, 2160, 60), '13');
  assert.equal(av1Level(7680, 4320, 30), '16');
  // a level bounds the width and the height each: 2100 wide is past level 2.0's 2048
  assert.equal(av1Level(2100, 64, 30), '01');
  assert.equal(av1Level(64, 1200, 30), '01');
  assert.equal(av1Level(32768, 16384, 240), '18');
});

test('an HEVC export names its general_level_idc, the picture counted in whole 8x8 blocks', () => {
  // (H.265 tables A.8 and A.9: thirty times the level)
  assert.equal(hevcLevel(176, 144, 15), 30);
  assert.equal(hevcLevel(640, 360, 30), 63);
  assert.equal(hevcLevel(1280, 720, 30), 93);
  assert.equal(hevcLevel(1920, 1080, 30), 120);
  assert.equal(hevcLevel(1920, 1080, 60), 123);
  assert.equal(hevcLevel(3840, 2160, 30), 150);
  assert.equal(hevcLevel(3840, 2160, 60), 153);
  assert.equal(hevcLevel(7680, 4320, 30), 180);
  // 1920x1082 is coded as 1920x1088: at 32 pictures a second that is 66 846 720 samples,
  // level 4's limit to the sample (1920x1082 itself would come to less, at 32.01 too)
  assert.equal(hevcLevel(1920, 1082, 32), 120);
  assert.equal(hevcLevel(1920, 1082, 32.01), 123);
  // 1080 lines are whole blocks already
  assert.equal(hevcLevel(1920, 1080, 32.01), 120);
  // neither side may be more than the root of eight pictures' samples: 543 for level 1
  assert.equal(hevcLevel(544, 8, 15), 60);
  assert.equal(hevcLevel(536, 8, 15), 30);
  assert.equal(hevcLevel(32768, 16384, 240), 186);
});

const cand = (codec) => ({ label: codec, config: { codec } });
const source = (codec) => ({ video: { codec } });

test('each format says where it plays and whether the untouched parts are copied', () => {
  const same = formatInfo(cand('avc1.640028'), source('avc1.4d401f'));
  assert.deepEqual([same.family, same.name, same.copies], ['h264', 'H.264', true]);
  assert.equal(same.label, 'H.264: plays everywhere, copies what you did not edit');
  assert.match(same.note, /^H\.264 plays everywhere.*Only the stretches around the sections you marked are re-encoded/);
  const other = formatInfo(cand('vp09.00.40.08'), source('avc1.4d401f'));
  assert.deepEqual([other.family, other.copies], ['vp9', false]);
  assert.equal(other.label, 'VP9: browsers and VLC');
  assert.match(other.note, /Your file is H\.264, so every frame is re-encoded/);
  assert.equal(formatInfo(cand('vp09.00.40.08'), source('vp09.00.31.08')).copies, true);
  // HEVC and AV1 are always re-encoded whole, from themselves too
  const hevc = formatInfo(cand('hvc1.1.6.L120.B0'), source('hev1.1.6.L93.B0'));
  assert.deepEqual([hevc.family, hevc.name, hevc.copies], ['hevc', 'H.265 (HEVC)', false]);
  assert.match(hevc.note, /Your file is H\.265 \(HEVC\), so every frame is re-encoded/);
  assert.equal(formatInfo(cand('av01.0.08M.08'), source('av01.0.08M.08')).copies, false);
  // a source in a codec the app has no name for
  assert.match(formatInfo(cand('avc1.640028'), source('mp4v.20.9')).note, /Your file is other, so every frame/);
});

test('one choice is offered for each format, the first the encoder takes', () => {
  const cands = ['avc1.640028', 'avc1.4D4028', 'avc1.42E028', 'vp09.00.40.08', 'av01.0.08M.08', 'hvc1.1.6.L120.B0'].map(cand);
  assert.deepEqual(formatChoices(cands).map((c) => c.config.codec), ['avc1.640028', 'vp09.00.40.08', 'av01.0.08M.08', 'hvc1.1.6.L120.B0']);
  // an encoder without High: Main stands for H.264
  assert.deepEqual(formatChoices(cands.slice(1, 4)).map((c) => c.config.codec), ['avc1.4D4028', 'vp09.00.40.08']);
  assert.deepEqual(formatChoices([]), []);
});

test("an export's size is guessed from the encoder's aim, the frames copied and the sound", () => {
  const movie = { width: 1000, height: 1000, fps: 10, duration: 8, a: { size: [100, 200, 300] } };
  // quality 10 aims at 0.28 bits a pixel: 350 000 bytes a second of 1000x1000 at 10 a second
  assert.equal(Math.round(estimateExportBytes(movie, 10)), 350000 * 8 + 600);
  assert.equal(Math.round(estimateExportBytes(movie, 10, { mode: 'full' })), 350000 * 8 + 600);
  assert.equal(Math.round(estimateExportBytes(movie, 10, { mode: 'smart', copiedBytes: 5000, encodedSeconds: 2 })), 5000 + 350000 * 2 + 600);
  // quality 0 would be 0.03 bits a pixel, and a video without sound adds none
  assert.equal(Math.round(estimateExportBytes({ ...movie, a: null }, 0)), 37500 * 8);
});

/**
 * A VP9 film at 30 pictures a second, `seconds` long, a keyframe every
 * `gop` pictures, each picture 1000 bytes (a keyframe 5000): enough of a
 * Movie for the plan. `keys` names the keyframes instead, when given.
 */
function film(seconds, gop, { codec = 'vp09.00.21.08', fourcc = 'vp09', keys = null } = {}) {
  const n = seconds * 30;
  const sync = Array.from({ length: n }, (_, i) => (keys ? keys.includes(i) : i % gop === 0) ? 1 : 0);
  return {
    v: { pts: Array.from({ length: n }, (_, i) => Math.round((i / 30) * 1e6)), sync, size: sync.map((s) => (s ? 5000 : 1000)) },
    video: { codec, fourcc, index: 0 },
    fps: 30,
    tsMin: 0,
    tsMax: (n - 1) / 30,
    software: false,
  };
}
const project = { sectionsSorted: () => [], sections: [] };
const plan = (movie, spans, more = {}) => exportPlan({}, movie, project, { codec: 'vp09.00.21.08', parallel: 2, spans, ...more });
const shape = (p) => p.pieces.map((x) => [x.kind, x.from, x.to]);

test('only the keyframe-to-keyframe stretch around what changed is re-encoded', async () => {
  const p = await plan(film(20, 60), [[5, 7]]);
  assert.equal(p.mode, 'smart');
  // keyframes every 2 s: the stretch 5 to 7 s lies between those at 4 s and 8 s
  assert.deepEqual(shape(p), [['copy', 0, 120], ['encode', 120, 240], ['copy', 240, 600]]);
  const enc = p.pieces[1];
  assert.deepEqual([enc.startSec, enc.endSec, enc.frames], [4, 8, 120]);
  assert.deepEqual([p.encoded, p.copied, p.spans, p.encodedSeconds], [120, 480, 1, 4]);
  // 480 frames copied, 8 of them keyframes
  assert.equal(p.copiedBytes, 472 * 1000 + 8 * 5000);
  assert.deepEqual(p.pieces.map((x) => x.offset), [0, 0, 0]);
  assert.deepEqual([p.holds, p.warnings, p.parallel], [[], [], 2]);
});

test('a stretch that ends on a keyframe stops there', async () => {
  const p = await plan(film(20, 60), [[5, 8]]);
  assert.deepEqual(shape(p), [['copy', 0, 120], ['encode', 120, 240], ['copy', 240, 600]]);
});

test('a stretch that starts exactly on a keyframe is re-encoded from the keyframe before it', async () => {
  // (the keyframe at its start would do, and save a GOP of re-encoding: the plan passes it
  // over. A microsecond later it is taken.)
  const p = await plan(film(20, 60), [[4, 7]]);
  assert.deepEqual(shape(p), [['copy', 0, 60], ['encode', 60, 240], ['copy', 240, 600]]);
  const q = await plan(film(20, 60), [[4.000001, 7]]);
  assert.deepEqual(shape(q), [['copy', 0, 120], ['encode', 120, 240], ['copy', 240, 600]]);
  // at the very start of the file there is no keyframe before: from the first
  const r = await plan(film(20, 60), [[0, 1]]);
  assert.deepEqual(shape(r), [['encode', 0, 60], ['copy', 60, 600]]);
});

test('stretches whose keyframes meet are re-encoded as one, and the ends of the file need no keyframe', async () => {
  const p = await plan(film(20, 60), [[5, 7], [8.5, 9], [19, 19.5]], { parallel: 1 });
  assert.deepEqual(shape(p), [['copy', 0, 120], ['encode', 120, 300], ['copy', 300, 540], ['encode', 540, 600]]);
  assert.equal(p.pieces[3].endSec, 20 - 1 / 30 + 1, 'past the last picture, so the decode takes it in');
  assert.deepEqual([p.spans, p.encoded, p.copied], [2, 240, 360]);
  const whole = await plan(film(20, 60), [[0, 20]], { parallel: 1 });
  assert.deepEqual(shape(whole), [['encode', 0, 600]]);
  assert.equal(whole.copied, 0);
});

test('with nothing changed, everything is copied', async () => {
  const p = await plan(film(20, 60), null);
  assert.deepEqual(shape(p), [['copy', 0, 600]]);
  assert.deepEqual([p.mode, p.encoded, p.copied, p.spans, p.encodedSeconds], ['smart', 0, 600, 0, 0]);
});

test('a long stretch is cut for the parallel encoders at keyframes between what changed, never inside it', async () => {
  // six stretches of 2.6 s, a keyframe (one a second) in each gap between them: one span, 1 s to 19 s
  const changed = [1.2, 4.2, 7.2, 10.2, 13.2, 16.2].map((a) => [a, a + 2.6]);
  const p = await plan(film(20, 30), changed, { parallel: 3 });
  assert.equal(p.encoded, 540);
  // 540 frames for 3 encoders, three pieces each to aim for: 60 frames a piece at least, and
  // the first keyframe past that which no stretch covers is 90 frames on
  assert.deepEqual(shape(p), [['copy', 0, 30], ['encode', 30, 120], ['encode', 120, 210], ['encode', 210, 300], ['encode', 300, 390], ['encode', 390, 480], ['encode', 480, 570], ['copy', 570, 600]]);
  assert.equal(p.spans, 6);
  // one stretch has no keyframe to cut at that is not inside it
  const solid = await plan(film(20, 30), [[1.5, 18.5]], { parallel: 3 });
  assert.deepEqual(shape(solid), [['copy', 0, 30], ['encode', 30, 570], ['copy', 570, 600]]);
  // and one encoder takes a span whole
  const one = await plan(film(20, 30), changed, { parallel: 1 });
  assert.deepEqual(shape(one), [['copy', 0, 30], ['encode', 30, 570], ['copy', 570, 600]]);
});

test("an encoder whose format cannot share the source's track re-encodes everything", async () => {
  const hevc = await plan(film(20, 60, { codec: 'hev1.1.6.L93.B0', fourcc: 'hev1' }), [[5, 7]], { codec: 'hvc1.1.6.L93.B0' });
  assert.equal(hevc.mode, 'full');
  assert.equal(hevc.copyable, null);
  assert.deepEqual([hevc.encoded, hevc.copied], [600, 0]);
  // VP9 into VP9 of another profile, and smart cut turned off
  assert.equal((await plan(film(20, 60, { codec: 'vp09.02.21.10' }), [[5, 7]])).mode, 'full');
  assert.equal((await plan(film(20, 60), [[5, 7]], { smartCut: false })).mode, 'full');
  // a file that does not start with a keyframe cannot be copied from its start
  assert.equal((await plan(film(20, 60, { keys: [30, 90] }), [[5, 7]])).mode, 'full');
  // and one with no frames has nothing to plan
  const none = await plan(film(0, 60), null);
  assert.deepEqual([none.pieces, none.encoded, none.copied], [[], 0, 0]);
});
