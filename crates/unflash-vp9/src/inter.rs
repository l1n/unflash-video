//! Inter prediction (8.5.2): motion vector selection and clamping, the
//! scaling of positions into a reference of another size, and the 8-tap
//! interpolation (horizontal pass into an intermediate array, then
//! vertical), averaged over two references for compound blocks.
//!
//! References extend infinitely past their edges (sample positions clamp
//! to the last row and column). Unscaled blocks whose filter footprint lies
//! inside the reference read it in place; others go through a small
//! edge-replicated copy. Unscaled blocks are interpolated by
//! `Pixel::predict`, in SIMD lanes for 8-bit frames.

use crate::frame::{Pixel, Plane};
use crate::header::INTRA_FRAME;
use crate::tables::{BLOCK_8X8, NUM_8X8_HIGH, NUM_8X8_WIDE, SUBPEL_FILTERS};
use crate::tile::{Block, Mv, TileDecoder};

/// round_mv_comp_q4: the average of four vectors, rounded away from zero.
fn round_q4(v: i32) -> i32 {
    (if v < 0 { v - 2 } else { v + 2 }) / 4
}

impl<'a, 'd, T: Pixel> TileDecoder<'a, 'd, T> {
    /// Predict the `w` x `h` samples at (`x`, `y`) of `plane` (the whole
    /// block, or one 4x4 sub-block `block_idx` of a block smaller than 8x8).
    #[allow(clippy::too_many_arguments)]
    pub fn predict_inter(&mut self, b: &Block, plane: usize, x: usize, y: usize, w: usize, h: usize, block_idx: usize) {
        let is_compound = b.ref_frame[1] > INTRA_FRAME;
        for list in 0..1 + is_compound as usize {
            // motion vector selection (8.5.2.1): chroma of a sub-8x8 block
            // uses the average of its four vectors
            let mv = if plane == 0 || b.size >= BLOCK_8X8 {
                b.mvs[list][block_idx]
            } else {
                let m = &b.mvs[list];
                let row = round_q4(m.iter().map(|v| v.row as i32).sum());
                let col = round_q4(m.iter().map(|v| v.col as i32).sum());
                Mv { row: row as i16, col: col as i16 }
            };
            let (mv_row, mv_col) = self.clamp_mv_to_edges(b, plane, mv);
            let ref_idx = (b.ref_frame[list] as usize).wrapping_sub(1);
            let Some(rf) = self.refs.get(ref_idx).and_then(|r| r.as_ref()).filter(|r| r.valid) else {
                // a reference the frame header did not provide
                self.damaged = true;
                let grey = T::new(1 << (self.bit_depth - 1));
                let p = &mut self.cur.planes[plane];
                for row in p.data[y * p.stride..].chunks_mut(p.stride).take(h) {
                    row[x..x + w].fill(grey);
                }
                continue;
            };
            let refp = &rf.buf.planes[plane];
            let filter = &SUBPEL_FILTERS[b.filter as usize & 3];
            let bd = self.bit_depth;
            // scaling (8.5.2.3); for unscaled references the start is simply
            // the position plus the vector
            let (start_x, start_y) = if rf.scaled {
                let sub = (plane > 0) as u32;
                let (lx, ly) = ((x as i64) << sub, (y as i64) << sub);
                let (xs, ys) = (rf.x_scale as i64, rf.y_scale as i64);
                let base_x = (x as i64 * xs) >> 14;
                let base_y = (y as i64 * ys) >> 14;
                let frac_x = ((16 * lx * xs) >> 14) & 15;
                let frac_y = ((16 * ly * ys) >> 14) & 15;
                let dx = ((mv_col as i64 * xs) >> 14) + frac_x;
                let dy = ((mv_row as i64 * ys) >> 14) + frac_y;
                ((base_x << 4) + dx, (base_y << 4) + dy)
            } else {
                (((x as i64) << 4) + mv_col as i64, ((y as i64) << 4) + mv_row as i64)
            };
            let cur = &mut self.cur.planes[plane];
            let average = list == 1;
            if rf.scaled {
                predict_scaled(refp, cur, x, y, w, h, start_x, start_y, rf.x_step, rf.y_step, filter, bd, average, &mut self.scratch.mc_tmp);
            } else {
                predict_unscaled(refp, cur, x, y, w, h, start_x, start_y, filter, bd, average, &mut self.scratch.mc_tmp, &mut self.scratch.edge);
            }
        }
    }

    /// The motion vector clamping process (8.5.2.2): in sixteenth samples of
    /// the plane, no further past the frame than the block plus the filter
    /// margin.
    fn clamp_mv_to_edges(&self, b: &Block, plane: usize, mv: Mv) -> (i32, i32) {
        let s = (plane > 0) as u32;
        let bh = NUM_8X8_HIGH[b.size] as i32;
        let bw = NUM_8X8_WIDE[b.size] as i32;
        let (row, col, rows, cols) = (b.row as i32, b.col as i32, self.mi_rows as i32, self.mi_cols as i32);
        let to_top = -((row * 8) * 16) >> s;
        let to_bottom = (((rows - bh - row) * 8) * 16) >> s;
        let to_left = -((col * 8) * 16) >> s;
        let to_right = (((cols - bw - col) * 8) * 16) >> s;
        let spel_left = (4 + ((bw * 8) >> s)) << 4;
        let spel_right = spel_left - 16;
        let spel_top = (4 + ((bh * 8) >> s)) << 4;
        let spel_bottom = spel_top - 16;
        let r = ((2 * mv.row as i32) >> s).clamp(to_top - spel_top, to_bottom + spel_bottom);
        let c = ((2 * mv.col as i32) >> s).clamp(to_left - spel_left, to_right + spel_right);
        (r, c)
    }
}

/// Write `v` to the prediction, or average it with the first reference's.
#[inline(always)]
fn store<T: Pixel>(d: &mut T, v: i32, average: bool) {
    *d = if average { T::new((d.get() + v + 1) >> 1) } else { T::new(v) };
}

#[inline(always)]
fn tap8<T: Pixel>(s: &[T], f: &[i16; 8]) -> i32 {
    let mut sum = 0;
    for t in 0..8 {
        sum += f[t] as i32 * s[t].get();
    }
    sum
}

/// How to interpolate one block.
pub struct Mc<'a> {
    pub w: usize,
    pub h: usize,
    /// The fractions of the horizontal and vertical positions, in sixteenths.
    pub fx: usize,
    pub fy: usize,
    pub filter: &'a [[i16; 8]; 16],
    pub bd: u32,
    /// Average with the prediction already there (the second reference of a
    /// compound block) rather than overwrite it.
    pub average: bool,
}

/// An unscaled block (8.5.2.4 with steps of 16): find the samples the
/// filters need, in place or as an edge-replicated copy, and interpolate.
#[allow(clippy::too_many_arguments)]
fn predict_unscaled<T: Pixel>(refp: &Plane<T>, cur: &mut Plane<T>, x: usize, y: usize, w: usize, h: usize, start_x: i64, start_y: i64, filter: &[[i16; 8]; 16], bd: u32, average: bool, tmp: &mut [i32], edge: &mut [T]) {
    // the footprint of the filters: 3 samples before, 4 after
    let (x0, y0) = ((start_x >> 4) - 3, (start_y >> 4) - 3);
    let (fw, fh) = (w + 7, h + 7);
    let last_x = refp.width as i64 - 1;
    let last_y = refp.height as i64 - 1;
    let (src, sstride): (&[T], usize) = if x0 >= 0 && y0 >= 0 && x0 + fw as i64 - 1 <= last_x && y0 + fh as i64 - 1 <= last_y {
        (&refp.data[y0 as usize * refp.stride + x0 as usize..], refp.stride)
    } else {
        for (r, row) in edge.chunks_exact_mut(fw).take(fh).enumerate() {
            let yy = (y0 + r as i64).clamp(0, last_y) as usize * refp.stride;
            for (c, e) in row.iter_mut().enumerate() {
                *e = refp.data[yy + (x0 + c as i64).clamp(0, last_x) as usize];
            }
        }
        (&*edge, fw)
    };
    let cs = cur.stride;
    let mc = Mc { w, h, fx: (start_x & 15) as usize, fy: (start_y & 15) as usize, filter, bd, average };
    T::predict(src, sstride, &mut cur.data[y * cs + x..], cs, &mc, tmp);
}

/// Interpolate a block from `src`, the top left of its filter footprint
/// (3 rows and columns before the block): a copy, one 8-tap pass or two,
/// depending on which of the position's components have a fraction.
pub fn predict_block<T: Pixel>(src: &[T], ss: usize, dst: &mut [T], ds: usize, mc: &Mc, tmp: &mut [i32]) {
    let (w, h, bd, average) = (mc.w, mc.h, mc.bd, mc.average);
    match (mc.fx != 0, mc.fy != 0) {
        (false, false) => {
            for r in 0..h {
                let s = &src[(3 + r) * ss + 3..];
                for c in 0..w {
                    store(&mut dst[r * ds + c], s[c].get(), average);
                }
            }
        }
        (true, false) => {
            let f = &mc.filter[mc.fx];
            for r in 0..h {
                let s = &src[(3 + r) * ss..];
                for c in 0..w {
                    let v = T::clip((tap8(&s[c..c + 8], f) + 64) >> 7, bd).get();
                    store(&mut dst[r * ds + c], v, average);
                }
            }
        }
        (false, true) => {
            let f = &mc.filter[mc.fy];
            for r in 0..h {
                for c in 0..w {
                    let mut sum = 0;
                    for t in 0..8 {
                        sum += f[t] as i32 * src[(r + t) * ss + 3 + c].get();
                    }
                    let v = T::clip((sum + 64) >> 7, bd).get();
                    store(&mut dst[r * ds + c], v, average);
                }
            }
        }
        (true, true) => {
            let f = &mc.filter[mc.fx];
            for r in 0..h + 7 {
                let s = &src[r * ss..];
                for c in 0..w {
                    tmp[r * w + c] = T::clip((tap8(&s[c..c + 8], f) + 64) >> 7, bd).get();
                }
            }
            let f = &mc.filter[mc.fy];
            for r in 0..h {
                for c in 0..w {
                    let mut sum = 0;
                    for t in 0..8 {
                        sum += f[t] as i32 * tmp[(r + t) * w + c];
                    }
                    let v = T::clip((sum + 64) >> 7, bd).get();
                    store(&mut dst[r * ds + c], v, average);
                }
            }
        }
    }
}

/// A block predicted from a reference of another size (8.5.2.4): each
/// output sample steps `x_step` / `y_step` sixteenths through the reference.
#[allow(clippy::too_many_arguments)]
fn predict_scaled<T: Pixel>(refp: &Plane<T>, cur: &mut Plane<T>, x: usize, y: usize, w: usize, h: usize, start_x: i64, start_y: i64, x_step: i32, y_step: i32, filter: &[[i16; 8]; 16], bd: u32, average: bool, tmp: &mut [i32]) {
    let last_x = refp.width as i64 - 1;
    let last_y = refp.height as i64 - 1;
    let (xs, ys) = (x_step as i64, y_step as i64);
    let rows = ((((h as i64 - 1) * ys + (start_y & 15)) >> 4) + 8) as usize;
    let y0 = (start_y >> 4) - 3;
    for r in 0..rows {
        let row = (y0 + r as i64).clamp(0, last_y) as usize * refp.stride;
        for c in 0..w {
            let p = start_x + xs * c as i64;
            let f = &filter[(p & 15) as usize];
            let px = (p >> 4) - 3;
            let mut sum = 0;
            for t in 0..8 {
                sum += f[t] as i32 * refp.data[row + (px + t as i64).clamp(0, last_x) as usize].get();
            }
            tmp[r * w + c] = T::clip((sum + 64) >> 7, bd).get();
        }
    }
    let cs = cur.stride;
    let dst = &mut cur.data[y * cs + x..];
    for r in 0..h {
        let p = (start_y & 15) + ys * r as i64;
        let f = &filter[(p & 15) as usize];
        let base = (p >> 4) as usize;
        for c in 0..w {
            let mut sum = 0;
            for t in 0..8 {
                sum += f[t] as i32 * tmp[(base + t) * w + c];
            }
            let v = T::clip((sum + 64) >> 7, bd).get();
            store(&mut dst[r * cs + c], v, average);
        }
    }
}

/// The 8-bit interpolation in 16-bit SIMD lanes, a strip of 8 columns (4
/// for 4-wide blocks) at a time.
#[cfg(feature = "simd")]
pub mod simd {
    use super::Mc;
    use wide::{i16x8, u8x16};

    /// Over all the filters, an 8-tap sum of 8-bit samples lies in
    /// -13770..=46410: too wide for signed 16-bit lanes, but offset by
    /// 108 * 128 (and the rounding 64) it is exact in wrapping 16-bit
    /// arithmetic read as unsigned, and its logical shift right by 7 is the
    /// rounded value plus 108.
    const BIAS: i16 = 108 * 128 + 64;

    /// `N` samples (4 or 8) widened to 16-bit lanes.
    #[inline(always)]
    fn load<const N: usize>(s: &[u8]) -> i16x8 {
        let mut a = [0u8; 16];
        a[..N].copy_from_slice(&s[..N]);
        i16x8::from_u8x16_low(u8x16::from(a))
    }

    /// Round2(the filtered value, 7) before clipping: -108..=363.
    #[inline(always)]
    fn taps(s: [i16x8; 8], f: &[i16x8; 8]) -> i16x8 {
        let mut acc = i16x8::splat(BIAS);
        for t in 0..8 {
            acc = acc + s[t] * f[t];
        }
        ((acc >> 7_i32) & i16x8::splat(511)) - i16x8::splat(108)
    }

    #[inline(always)]
    fn clip(v: i16x8) -> i16x8 {
        v.max(i16x8::ZERO).min(i16x8::splat(255))
    }

    /// Store `N` samples, clipped, or their average with those there.
    #[inline(always)]
    fn put<const N: usize>(v: i16x8, d: &mut [u8], average: bool) {
        let v = if average { (clip(v) + load::<N>(d) + i16x8::splat(1)) >> 1_i32 } else { v };
        d[..N].copy_from_slice(&u8x16::narrow_i16x8(v, v).as_array_ref()[..N]);
    }

    pub fn predict(src: &[u8], ss: usize, dst: &mut [u8], ds: usize, mc: &Mc) {
        match (mc.w, mc.fx != 0) {
            (4, false) => columns::<4, false>(src, ss, dst, ds, mc),
            (4, true) => columns::<4, true>(src, ss, dst, ds, mc),
            (w, false) => {
                for c in (0..w).step_by(8) {
                    columns::<8, false>(&src[c..], ss, &mut dst[c..], ds, mc);
                }
            }
            (w, true) => {
                for c in (0..w).step_by(8) {
                    columns::<8, true>(&src[c..], ss, &mut dst[c..], ds, mc);
                }
            }
        }
    }

    /// `N` columns of a block, filtered horizontally if `H`.
    #[inline(always)]
    fn columns<const N: usize, const H: bool>(src: &[u8], ss: usize, dst: &mut [u8], ds: usize, mc: &Mc) {
        let fx = mc.filter[mc.fx].map(i16x8::splat);
        let fy = mc.filter[mc.fy].map(i16x8::splat);
        // row r of the footprint, horizontally filtered or as it is
        let row = |r: usize| {
            let s = &src[r * ss..];
            if H {
                clip(taps(std::array::from_fn(|t| load::<N>(&s[t..])), &fx))
            } else {
                load::<N>(&s[3..])
            }
        };
        if mc.fy == 0 {
            for r in 0..mc.h {
                put::<N>(row(3 + r), &mut dst[r * ds..], mc.average);
            }
        } else {
            // a window of the 8 rows the vertical filter reads
            let mut win = [i16x8::ZERO; 8];
            for (r, v) in win[1..].iter_mut().enumerate() {
                *v = row(r);
            }
            for r in 0..mc.h {
                win = [win[1], win[2], win[3], win[4], win[5], win[6], win[7], row(r + 7)];
                put::<N>(taps(win, &fy), &mut dst[r * ds..], mc.average);
            }
        }
    }
}

#[cfg(all(test, feature = "simd"))]
mod tests {
    use super::*;

    /// The SIMD interpolation agrees with the portable one, for every
    /// filter, fraction and block width, at the extremes of the sums too.
    #[test]
    fn simd_matches_scalar() {
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed as usize
        };
        let ss = 80;
        let mut tmp = vec![0; 64 * 71];
        for trial in 0..6000 {
            let src: Vec<u8> = (0..ss * 71).map(|_| if trial % 2 == 0 { rnd() as u8 } else { [0, 255][rnd() % 2] }).collect();
            let mc = Mc { w: [4, 8, 16, 32, 64][trial % 5], h: [4, 8, 16, 32, 64][rnd() % 5], fx: rnd() % 16, fy: rnd() % 16, filter: &SUBPEL_FILTERS[rnd() % 4], bd: 8, average: trial % 3 == 0 };
            let mut a: Vec<u8> = (0..64 * 64).map(|_| rnd() as u8).collect();
            let mut b = a.clone();
            predict_block(&src, ss, &mut a, 64, &mc, &mut tmp);
            simd::predict(&src, ss, &mut b, 64, &mc);
            assert_eq!(a, b, "trial {trial}");
        }
    }
}
