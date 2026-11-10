// A transport stream's samples (web/ts.js): found again in the stream's
// packets from the place the demuxer gave each, PES headers passed over,
// video's start codes turned into lengths. The streams here are built by
// hand, packet by packet. (crates/unflash-mp4's own reader, which this one
// follows step for step, is held to ffmpeg by the Rust tests, and the two
// to each other on real streams by the browser tests.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { TS_BASE, readTsSample } from '../../web/ts.js';

const VIDEO = 0x100;
const SOUND = 0x101;

/** One packet of `pid` carrying `payload` (184 bytes at most; what is short is stuffed in an adaptation field). */
function packet(pid, payload, { pusi = false, payloadOnly = true } = {}) {
  const p = new Uint8Array(188).fill(0xff);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | (pid >> 8);
  p[2] = pid & 0xff;
  if (!payloadOnly) {
    // an adaptation field and no payload at all
    p[3] = 0x20;
    p[4] = 183;
    return p;
  }
  if (payload.length === 184) p[3] = 0x10;
  else {
    assert.ok(payload.length < 184);
    p[3] = 0x30;
    p[4] = 183 - payload.length;
    if (p[4] > 0) p[5] = 0;
  }
  p.set(payload, 188 - payload.length);
  return p;
}

/** A PES header for a packet of sound or video (with a PTS: 14 bytes), or of a stream that has no optional part (6). */
function pesHead(id = 0xe0) {
  if (id === 0xbe) return Uint8Array.of(0, 0, 1, id, 0, 0);
  return Uint8Array.of(0, 0, 1, id, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1);
}

const bytes = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** `n` bytes that are never 0 or 1 (no start code among them), counting up from `from`. */
const run = (n, from = 0) => Uint8Array.from({ length: n }, (_, i) => 2 + ((from + i) % 250));

/** The stream `packets` make, as readTsSample is told of it, and how to read it. */
function stream(packets, { packet: size = 188, tracks = [{ pid: VIDEO, annexb: true }, { pid: SOUND, annexb: false }] } = {}) {
  const file = new Uint8Array(packets.length * size);
  // (192: a Blu-ray's four bytes of clock before each packet)
  packets.forEach((p, i) => file.set(p, i * size + (size - 188)));
  const reads = [];
  const read = async (offset, length) => {
    reads.push([offset, length]);
    assert.ok(offset >= 0 && offset + length <= file.length, `a read past the file: ${offset} + ${length}`);
    return file.subarray(offset, offset + length);
  };
  return { file, reads, read, ts: { packet: size, size: file.length, tracks } };
}
/** The place of byte `index` of packet number `k` for `track`. */
const place = (track, k, index, size = 188) => TS_BASE + track * 2 ** 47 + 256 * (k * size + (size - 188)) + index;

test("sound is its stream's bytes as they are, the other streams' packets and the PES headers passed over", async () => {
  const a = run(170);
  const b = run(184, 170);
  const c = run(100, 354);
  const s = stream([
    packet(SOUND, bytes(pesHead(0xc0), a), { pusi: true }),
    packet(VIDEO, run(184, 7)),
    packet(SOUND, b),
    packet(SOUND, bytes(pesHead(0xc0), c), { pusi: true }),
  ]);
  // a sample that starts after the first PES header and runs into the third packet of its stream
  const got = await readTsSample(s.read, s.ts, place(1, 0, 4 + 14), 170 + 184 + 40);
  assert.deepEqual(got, bytes(a, b, c.subarray(0, 40)));
  // one that starts part way into a packet
  assert.deepEqual(await readTsSample(s.read, s.ts, place(1, 2, 4 + 100), 84 + 10), bytes(b.subarray(100), c.subarray(0, 10)));
  // the whole file was read once and kept, not asked for packet by packet
  assert.equal(s.reads.length, 2);
});

test("video comes out as an MP4 holds it: each NAL unit behind its length, start codes and trailing zeros gone", async () => {
  const nal1 = bytes(Uint8Array.of(0x67), run(20));
  const nal2 = bytes(Uint8Array.of(0x65), run(300, 20));
  const es = bytes(Uint8Array.of(0, 0, 0, 1), nal1, Uint8Array.of(0, 0, 0, 0, 1), nal2, Uint8Array.of(0, 0, 1, 0x09, 0xf0));
  const s = stream([
    packet(VIDEO, bytes(pesHead(), es.subarray(0, 170)), { pusi: true }),
    packet(SOUND, run(184)),
    packet(VIDEO, es.subarray(170, 170 + 160)),
    packet(VIDEO, es.subarray(330)),
  ]);
  const want = bytes(Uint8Array.of(0, 0, 0, 21), nal1, Uint8Array.of(0, 0, 1, 45), nal2);
  assert.deepEqual(await readTsSample(s.read, s.ts, place(0, 0, 4 + 14), want.length), want);
});

test("zeros inside a NAL unit are its own, and the last sample of a file ends where the file does", async () => {
  // (two zeros and a 3: an emulation prevention byte, not a start code)
  const nal = Uint8Array.of(0x65, 9, 0, 0, 3, 0, 7, 0, 0, 3, 1, 8);
  const es = bytes(Uint8Array.of(0, 0, 1), nal);
  const s = stream([packet(VIDEO, bytes(pesHead(), es), { pusi: true })]);
  assert.deepEqual(await readTsSample(s.read, s.ts, place(0, 0, 188 - es.length), 4 + nal.length), bytes(Uint8Array.of(0, 0, 0, nal.length), nal));
});

test('a PES header may be split between packets, and a stream without optional fields has a short one', async () => {
  const head = pesHead();
  const a = run(184);
  const b = run(50, 184);
  const s = stream([
    packet(SOUND, a),
    // the header's first 5 bytes end one packet, its other 9 begin the next
    packet(SOUND, head.subarray(0, 5), { pusi: true }),
    packet(SOUND, bytes(head.subarray(5), b)),
  ]);
  assert.deepEqual(await readTsSample(s.read, s.ts, place(1, 0, 4), 184 + 50), bytes(a, b));
  const t = stream([packet(SOUND, a), packet(SOUND, bytes(pesHead(0xbe), b), { pusi: true })]);
  assert.deepEqual(await readTsSample(t.read, t.ts, place(1, 0, 4), 184 + 50), bytes(a, b));
});

test('packets with no payload, and what is not a PES at all, give nothing', async () => {
  const a = run(184);
  const b = run(60, 184);
  const s = stream([
    packet(SOUND, a),
    packet(SOUND, new Uint8Array(0), { payloadOnly: false }),
    // a packet that claims to start a PES but does not start with 00 00 01: it is dropped,
    // and so is what follows it, until a PES does start (as crates/unflash-mp4 drops them)
    packet(SOUND, bytes(Uint8Array.of(9, 9, 9), run(100)), { pusi: true }),
    packet(SOUND, run(184, 77)),
    packet(SOUND, bytes(pesHead(0xc0), b), { pusi: true }),
  ]);
  assert.deepEqual(await readTsSample(s.read, s.ts, place(1, 0, 4), 184 + 60), bytes(a, b));
});

test("a Blu-ray's packets of 192 bytes are read like any others", async () => {
  const a = run(184);
  const b = run(184, 184);
  const s = stream([packet(SOUND, a), packet(VIDEO, run(184)), packet(SOUND, b)], { packet: 192 });
  assert.deepEqual(await readTsSample(s.read, s.ts, place(1, 0, 4, 192), 300), bytes(a, b.subarray(0, 116)));
});

test('where the stream loses its step, the next two sync bytes a packet apart find it again', async () => {
  const a = run(184);
  const b = run(184, 184);
  const first = packet(SOUND, a);
  const second = packet(SOUND, b);
  const third = packet(VIDEO, run(184));
  // 37 stray bytes (a 0x47 among them, with no packet behind it) after the first packet
  const junk = new Uint8Array(37).fill(0x11);
  junk[5] = 0x47;
  const file = bytes(first, junk, second, third);
  const read = async (offset, length) => file.subarray(offset, offset + length);
  const ts = { packet: 188, size: file.length, tracks: [{ pid: VIDEO, annexb: true }, { pid: SOUND, annexb: false }] };
  assert.deepEqual(await readTsSample(read, ts, TS_BASE + 2 ** 47 + 256 * 0 + 4, 368), bytes(a, b));
});

test('a sample of no bytes is empty, and what cannot be read says why', async () => {
  const s = stream([packet(SOUND, run(184))]);
  assert.deepEqual(await readTsSample(s.read, s.ts, place(1, 0, 4), 0), new Uint8Array(0));
  await assert.rejects(readTsSample(s.read, s.ts, place(1, 0, 4), 500), /the file ended 184 bytes into a sample of 500/);
  await assert.rejects(readTsSample(s.read, s.ts, place(5, 0, 4), 10), /no stream for track 5/);
  // video whose NAL units come to more than the sample is said to hold
  const es = bytes(Uint8Array.of(0, 0, 1), run(60), Uint8Array.of(0, 0, 1), run(60));
  const v = stream([packet(VIDEO, bytes(pesHead(), es), { pusi: true })]);
  await assert.rejects(readTsSample(v.read, v.ts, place(0, 0, 188 - es.length), 50), /longer than its 50 bytes/);
});
