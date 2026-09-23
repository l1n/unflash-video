//! Inter prediction (8.5.2): motion vector selection and clamping, the
//! scaling of positions into a reference of another size, and the 8-tap
//! interpolation (horizontal pass into an intermediate array, then
//! vertical), averaged over two references for compound blocks.
//!
//! References extend infinitely past their edges (sample positions clamp
//! to the last row and column). Unscaled blocks whose filter footprint lies
//! inside the reference read it in place; others go through a small
//! edge-replicated copy.

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

/// An unscaled block (8.5.2.4 with steps of 16): a copy, one 8-tap pass or
/// two, depending on which of the vector's components have a fraction.
#[allow(clippy::too_many_arguments)]
fn predict_unscaled<T: Pixel>(refp: &Plane<T>, cur: &mut Plane<T>, x: usize, y: usize, w: usize, h: usize, start_x: i64, start_y: i64, filter: &[[i16; 8]; 16], bd: u32, average: bool, tmp: &mut [i32], edge: &mut [T]) {
    let (fx, fy) = ((start_x & 15) as usize, (start_y & 15) as usize);
    let (ix, iy) = (start_x >> 4, start_y >> 4);
    // the footprint of the filters: 3 samples before, 4 after
    let (x0, y0) = (ix - 3, iy - 3);
    let (fw, fh) = (w + 7, h + 7);
    let last_x = refp.width as i64 - 1;
    let last_y = refp.height as i64 - 1;
    let (src, sstride, sx, sy): (&[T], usize, usize, usize) = if x0 >= 0 && y0 >= 0 && x0 + fw as i64 - 1 <= last_x && y0 + fh as i64 - 1 <= last_y {
        (&refp.data, refp.stride, x0 as usize, y0 as usize)
    } else {
        for r in 0..fh {
            let yy = (y0 + r as i64).clamp(0, last_y) as usize * refp.stride;
            for c in 0..fw {
                edge[r * fw + c] = refp.data[yy + (x0 + c as i64).clamp(0, last_x) as usize];
            }
        }
        (&*edge, fw, 0, 0)
    };
    let cs = cur.stride;
    let dst = &mut cur.data[y * cs + x..];
    match (fx != 0, fy != 0) {
        (false, false) => {
            for r in 0..h {
                let s = &src[(sy + 3 + r) * sstride + sx + 3..];
                for c in 0..w {
                    store(&mut dst[r * cs + c], s[c].get(), average);
                }
            }
        }
        (true, false) => {
            let f = &filter[fx];
            for r in 0..h {
                let s = &src[(sy + 3 + r) * sstride + sx..];
                for c in 0..w {
                    let v = T::clip((tap8(&s[c..c + 8], f) + 64) >> 7, bd).get();
                    store(&mut dst[r * cs + c], v, average);
                }
            }
        }
        (false, true) => {
            let f = &filter[fy];
            for r in 0..h {
                for c in 0..w {
                    let mut sum = 0;
                    for t in 0..8 {
                        sum += f[t] as i32 * src[(sy + r + t) * sstride + sx + 3 + c].get();
                    }
                    let v = T::clip((sum + 64) >> 7, bd).get();
                    store(&mut dst[r * cs + c], v, average);
                }
            }
        }
        (true, true) => {
            let f = &filter[fx];
            for r in 0..fh {
                let s = &src[(sy + r) * sstride + sx..];
                for c in 0..w {
                    tmp[r * w + c] = T::clip((tap8(&s[c..c + 8], f) + 64) >> 7, bd).get();
                }
            }
            let f = &filter[fy];
            for r in 0..h {
                for c in 0..w {
                    let mut sum = 0;
                    for t in 0..8 {
                        sum += f[t] as i32 * tmp[(r + t) * w + c];
                    }
                    let v = T::clip((sum + 64) >> 7, bd).get();
                    store(&mut dst[r * cs + c], v, average);
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
