// Uncompressed sound (web/audiodec.js): PCM in each form a file may hold it,
// read into planes of samples from -1 to 1, and what a sound decoder is
// told about a track.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmDecoder, noSoundDecoder, soundConfig } from '../../web/audiodec.js';

const decode = (codec, bytes, channels = 1) => Array.from(new PcmDecoder(codec, channels, 48000).decode(Uint8Array.from(bytes)));

test('whole-number samples become fractions of their full scale', () => {
  assert.deepEqual(decode('pcm-u8', [128, 255, 0, 192]), [0, 127 / 128, -1, 0.5]);
  assert.deepEqual(decode('pcm-s8', [0, 64, 0x80, 0xff]), [0, 0.5, -1, -1 / 128]);
  assert.deepEqual(decode('pcm-s16', [0x00, 0x40, 0x00, 0x80, 0xff, 0x7f]), [0.5, -1, 32767 / 32768]);
  assert.deepEqual(decode('pcm-s16be', [0x40, 0x00, 0x80, 0x00, 0x7f, 0xff]), [0.5, -1, 32767 / 32768]);
  assert.deepEqual(decode('pcm-s24', [0x00, 0x00, 0x40, 0x00, 0x00, 0xc0, 0xff, 0xff, 0x7f]), [0.5, -0.5, 8388607 / 8388608]);
  assert.deepEqual(decode('pcm-s24be', [0x40, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x7f, 0xff, 0xff]), [0.5, -0.5, 8388607 / 8388608]);
  assert.deepEqual(decode('pcm-s32', [0, 0, 0, 0x40, 0, 0, 0, 0x80]), [0.5, -1]);
  assert.deepEqual(decode('pcm-s32be', [0x40, 0, 0, 0, 0x80, 0, 0, 0]), [0.5, -1]);
});

test('floating-point samples are read as they are, in either byte order', () => {
  const f32 = new Uint8Array(new Float32Array([0.25, -0.75]).buffer);
  const f64 = new Uint8Array(new Float64Array([0.25, -0.75]).buffer);
  assert.deepEqual(decode('pcm-f32', f32), [0.25, -0.75]);
  assert.deepEqual(decode('pcm-f64', f64), [0.25, -0.75]);
  const swap = (b, n) => Array.from(b).flatMap((_, i) => (i % n ? [] : [Array.from(b.subarray(i, i + n)).reverse()])).flat();
  assert.deepEqual(decode('pcm-f32be', swap(f32, 4)), [0.25, -0.75]);
  assert.deepEqual(decode('pcm-f64be', swap(f64, 8)), [0.25, -0.75]);
});

test("telephone sound (G.711) is read through the standard's tables", () => {
  // µ-law: 0xff and 0x7f are silence, 0x80 and 0x00 the loudest either way
  assert.deepEqual(decode('ulaw', [0xff, 0x7f, 0x80, 0x00]), [0, 0, 32124 / 32768, -32124 / 32768]);
  // A-law: 0xd5 and 0x55 the quietest steps either way, 0xaa and 0x2a the loudest
  assert.deepEqual(decode('alaw', [0xd5, 0x55, 0xaa, 0x2a]), [8 / 32768, -8 / 32768, 32256 / 32768, -32256 / 32768]);
});

test("each channel's samples come out together, one channel after another", () => {
  // two frames of three channels, 16 bits: (1, 2, 3) and (4, 5, 6) thirty-two-thousandths
  const frames = [1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0];
  const d = new PcmDecoder('pcm-s16', 3, 44100);
  const out = Array.from(d.decode(Uint8Array.from(frames)), (x) => Math.round(x * 32768));
  assert.deepEqual(out, [1, 4, 2, 5, 3, 6]);
  assert.deepEqual([d.samples(), d.channels(), d.sample_rate()], [2, 3, 44100]);
});

test('part of a frame at the end of a chunk is dropped, and a chunk may be a view into a larger buffer', () => {
  const d = new PcmDecoder('pcm-s16', 2, 48000);
  // two whole frames of two channels and three bytes more
  const whole = Uint8Array.from([9, 9, 0, 0x40, 0, 0x20, 0, 0x10, 0, 0x08, 1, 2, 3]);
  assert.deepEqual(Array.from(d.decode(whole.subarray(2))), [0.5, 0.125, 0.25, 0.0625]);
  assert.equal(d.samples(), 2);
  assert.deepEqual(Array.from(d.decode(new Uint8Array(3))), []);
  assert.equal(d.samples(), 0);
  // a track that says it has no channels has one
  assert.equal(new PcmDecoder('pcm-u8', 0, 8000).channels(), 1);
});

test("a decoder is told the track's codec, rate and channels, and its setup record when it has one", () => {
  const track = { codec: 'mp4a.40.2', sample_rate: 44100, channels: 2 };
  assert.deepEqual(soundConfig(track, new Uint8Array(0)), { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2 });
  assert.deepEqual(soundConfig(track, null), { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2 });
  const record = Uint8Array.of(0x12, 0x10);
  assert.deepEqual(soundConfig(track, record), { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, description: record });
});

test('sound that cannot be played says whose decoder is missing', () => {
  assert.equal(noSoundDecoder('vorbis', 'Vorbis sound'), "this browser can't decode Vorbis sound");
  // (the app's own decoders are in every build: until one fails to load, the browser is what lacks it)
  assert.equal(noSoundDecoder('ac-3', 'Dolby Digital sound'), "this browser can't decode Dolby Digital sound");
});
