// The built-in decoder driven on the page (web/media.js decodeRange for a
// film the browser cannot decode, with no worker pool to hand): the
// decoder here is a stand-in that makes blank pictures, or fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRange } from '../../web/media.js';
import { fakeMovie } from './fakes.mjs';

/** A film whose decoder is `Decoder` (given the stand-in's class to build on). */
function filmWith(build) {
  const movie = fakeMovie({ seconds: 4 });
  movie.wasm = { H264Decoder: build(movie.wasm.H264Decoder) };
  return movie;
}

test('every picture of a stretch comes out, made the size the detector wants', async () => {
  const freed = [];
  const movie = filmWith(
    (Base) =>
      class extends Base {
        free() {
          freed.push(true);
        }
      }
  );
  const got = [];
  const count = await decodeRange(movie, 1, 2, async (pic, t) => got.push([t, pic.kind, pic.codedWidth, pic.codedHeight, pic.data.length]), { raw: true, shrink: { aw: 32, ah: 18 } });
  assert.equal(count, 30);
  assert.equal(got.length, 30);
  assert.deepEqual(got[0], [1, 'rgba', 32, 18, 32 * 18 * 4]);
  assert.ok(Math.abs(got[29][0] - (1 + 29 / 30)) < 1e-6);
  assert.deepEqual(freed, [true], 'the decoder is freed once');
});

test('a cancel stops the decode and frees the decoder', async () => {
  let freed = 0;
  const movie = filmWith(
    (Base) =>
      class extends Base {
        free() {
          freed++;
        }
      }
  );
  let seen = 0;
  const count = await decodeRange(movie, 0, 4, async () => void seen++, { raw: true, shrink: { aw: 32, ah: 18 }, cancel: () => seen >= 5 });
  assert.ok(count >= 5 && count < 120, `${count} pictures`);
  assert.equal(freed, 1);
});

test('after a sample the decoder cannot take, every picture says it is damaged', async () => {
  // (what follows such a sample is predicted from what is missing: a scan stops at the first
  // damaged picture and hands the stretch to another decoder)
  const movie = filmWith(
    (Base) =>
      class extends Base {
        decode() {
          this.n = (this.n || 0) + 1;
          if (this.n === 3) throw new Error('invalid H.264 data');
          return true;
        }
      }
  );
  const got = [];
  const count = await decodeRange(movie, 0, 1, async (pic) => got.push(!!pic.damaged), { raw: true, shrink: { aw: 32, ah: 18 } });
  // the third sample gave no picture; the two before it are whole, the rest marked
  assert.equal(count, 29);
  assert.deepEqual(got.slice(0, 4), [false, false, true, true]);
  assert.ok(got.slice(2).every(Boolean));
});

test('a decoder that cannot even be freed fails the decode: its module is not to be trusted', async () => {
  // (after a trap in WebAssembly every call fails, freeing the decoder among them: the
  // decode must not end as if it had gone well)
  const movie = filmWith(
    (Base) =>
      class extends Base {
        decode() {
          throw new Error('unreachable');
        }
        free() {
          throw new Error('null pointer passed to rust');
        }
      }
  );
  await assert.rejects(decodeRange(movie, 0, 1, async () => {}, { raw: true, shrink: { aw: 32, ah: 18 } }), /null pointer passed to rust/);
});
