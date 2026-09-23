//! Inter prediction samples: fractional sample interpolation (8.5.3.3.3)
//! into 14-bit intermediates, and the default and explicit weighted
//! sample prediction (8.5.3.3.4) that turns them into samples.

use crate::picture::{Plane, Sample};

/// The 8-tap luma filters for the quarter positions (Table 8-8 taps).
const LUMA: [[i32; 8]; 4] = [[0, 0, 0, 64, 0, 0, 0, 0], [-1, 4, -10, 58, 17, -5, 1, 0], [-1, 4, -11, 40, 40, -11, 4, -1], [0, 1, -5, 17, 58, -10, 4, -1]];
/// The 4-tap chroma filters for the eighth positions.
const CHROMA: [[i32; 4]; 8] = [[0, 64, 0, 0], [-2, 58, 10, -2], [-4, 54, 16, -2], [-6, 46, 28, -4], [-4, 36, 36, -4], [-4, 28, 46, -6], [-2, 16, 54, -4], [-2, 10, 58, -2]];

/// Largest prediction block side.
pub const MAX_PB: usize = 64;
/// The source window of the largest block with the 8-tap margins.
const WIN: usize = MAX_PB + 7;

/// Reusable buffers for the interpolation: an edge-replicated source
/// window and the first filter pass of two-dimensional positions.
pub struct Scratch<P> {
    win: Vec<P>,
    tmp: Vec<i16>,
}

impl<P: Sample> Scratch<P> {
    pub fn new() -> Scratch<P> {
        Scratch { win: vec![P::default(); WIN * WIN], tmp: vec![0; WIN * MAX_PB] }
    }
}

impl<P: Sample> Default for Scratch<P> {
    fn default() -> Self {
        Self::new()
    }
}

/// Interpolate a `w`×`h` block of `plane` whose top-left full-sample
/// position is (`xi`, `yi`) at fractional offset (`xf`, `yf`) (in
/// 1/4 samples for luma, `TAPS` = 8, or 1/8 for chroma, `TAPS` = 4), into
/// `dst` (stride `w`) at 14-bit precision. Samples outside the plane
/// repeat the nearest edge sample (8-222, 8-239).
#[allow(clippy::too_many_arguments)]
fn interpolate<P: Sample, const TAPS: usize>(plane: &Plane<P>, xi: i32, yi: i32, xf: usize, yf: usize, w: usize, h: usize, bit_depth: u32, dst: &mut [i16], scratch: &mut Scratch<P>) {
    let before = TAPS / 2 - 1;
    let (pw, ph) = (plane.width as i32, plane.height as i32);
    let (x0, y0) = (xi - before as i32, yi - before as i32);
    let (ww, wh) = (w + TAPS - 1, h + TAPS - 1);
    // the source rows: straight from the plane when the window is inside,
    // else an edge-replicated copy
    let Scratch { win, tmp } = scratch;
    let (src, base, ss): (&[P], usize, usize) = if x0 >= 0 && y0 >= 0 && x0 + ww as i32 <= pw && y0 + wh as i32 <= ph {
        (&plane.data, y0 as usize * plane.stride + x0 as usize, plane.stride)
    } else {
        for j in 0..wh {
            let sy = (y0 + j as i32).clamp(0, ph - 1) as usize;
            let row = &plane.data[sy * plane.stride..sy * plane.stride + plane.width];
            for i in 0..ww {
                win[j * ww + i] = row[(x0 + i as i32).clamp(0, pw - 1) as usize];
            }
        }
        (&win[..], 0, ww)
    };
    let filt = |f: usize| -> [i32; TAPS] {
        let mut c = [0i32; TAPS];
        for (k, v) in c.iter_mut().enumerate() {
            *v = if TAPS == 8 { LUMA[f][k] } else { CHROMA[f][k] };
        }
        c
    };
    let shift1 = bit_depth - 8;
    let shift3 = 14 - bit_depth;
    match (xf, yf) {
        (0, 0) => {
            for j in 0..h {
                let r = &src[base + (j + before) * ss + before..][..w];
                for (d, s) in dst[j * w..j * w + w].iter_mut().zip(r) {
                    *d = (s.get() << shift3) as i16;
                }
            }
        }
        (_, 0) => {
            let c = filt(xf);
            for j in 0..h {
                let r = &src[base + (j + before) * ss..][..ww];
                for i in 0..w {
                    let mut s = 0;
                    for k in 0..TAPS {
                        s += c[k] * r[i + k].get();
                    }
                    dst[j * w + i] = (s >> shift1) as i16;
                }
            }
        }
        (0, _) => {
            let c = filt(yf);
            for j in 0..h {
                for i in 0..w {
                    let mut s = 0;
                    for k in 0..TAPS {
                        s += c[k] * src[base + (j + k) * ss + before + i].get();
                    }
                    dst[j * w + i] = (s >> shift1) as i16;
                }
            }
        }
        _ => {
            let (ch, cv) = (filt(xf), filt(yf));
            for j in 0..wh {
                let r = &src[base + j * ss..][..ww];
                for i in 0..w {
                    let mut s = 0;
                    for k in 0..TAPS {
                        s += ch[k] * r[i + k].get();
                    }
                    tmp[j * w + i] = (s >> shift1) as i16;
                }
            }
            for j in 0..h {
                for i in 0..w {
                    let mut s = 0;
                    for k in 0..TAPS {
                        s += cv[k] * tmp[(j + k) * w + i] as i32;
                    }
                    dst[j * w + i] = (s >> 6) as i16;
                }
            }
        }
    }
}

/// 8.5.3.3.3.2: the luma prediction of a `w`×`h` block at (`x`, `y`)
/// displaced by `mv` (quarter samples).
#[allow(clippy::too_many_arguments)]
pub fn luma<P: Sample>(plane: &Plane<P>, x: i32, y: i32, mv: [i16; 2], w: usize, h: usize, bit_depth: u32, dst: &mut [i16], scratch: &mut Scratch<P>) {
    let (mx, my) = (mv[0] as i32, mv[1] as i32);
    interpolate::<P, 8>(plane, x + (mx >> 2), y + (my >> 2), (mx & 3) as usize, (my & 3) as usize, w, h, bit_depth, dst, scratch);
}

/// 8.5.3.3.3.3: the chroma prediction (4:2:0) of a `w`×`h` block at chroma
/// position (`x`, `y`) for the luma vector `mv` (eighth chroma samples).
#[allow(clippy::too_many_arguments)]
pub fn chroma<P: Sample>(plane: &Plane<P>, x: i32, y: i32, mv: [i16; 2], w: usize, h: usize, bit_depth: u32, dst: &mut [i16], scratch: &mut Scratch<P>) {
    let (mx, my) = (mv[0] as i32, mv[1] as i32);
    interpolate::<P, 4>(plane, x + (mx >> 3), y + (my >> 3), (mx & 7) as usize, (my & 7) as usize, w, h, bit_depth, dst, scratch);
}

/// Explicit weighting parameters of one component: log2WD, and the
/// weight and offset per list.
#[derive(Clone, Copy, Debug)]
pub struct Weights {
    pub log2wd: u32,
    pub w: [i32; 2],
    pub o: [i32; 2],
}

/// 8.5.3.3.4.2: the default single-list prediction into `dst`.
pub fn put_uni<P: Sample>(src: &[i16], w: usize, h: usize, bit_depth: u32, dst: &mut [P], ds: usize) {
    let shift = 14 - bit_depth;
    let offset = 1 << (shift - 1);
    let max = (1 << bit_depth) - 1;
    for j in 0..h {
        for (d, &s) in dst[j * ds..j * ds + w].iter_mut().zip(&src[j * w..j * w + w]) {
            *d = P::new(((s as i32 + offset) >> shift).clamp(0, max));
        }
    }
}

/// 8.5.3.3.4.2: the default bi-prediction average.
pub fn put_bi<P: Sample>(a: &[i16], b: &[i16], w: usize, h: usize, bit_depth: u32, dst: &mut [P], ds: usize) {
    let shift = 15 - bit_depth;
    let offset = 1 << (shift - 1);
    let max = (1 << bit_depth) - 1;
    for j in 0..h {
        let (ra, rb) = (&a[j * w..j * w + w], &b[j * w..j * w + w]);
        for ((d, &p), &q) in dst[j * ds..j * ds + w].iter_mut().zip(ra).zip(rb) {
            *d = P::new(((p as i32 + q as i32 + offset) >> shift).clamp(0, max));
        }
    }
}

/// 8.5.3.3.4.3: explicit weighting of a single list `l`.
pub fn put_weighted_uni<P: Sample>(src: &[i16], w: usize, h: usize, bit_depth: u32, wt: &Weights, l: usize, dst: &mut [P], ds: usize) {
    let max = (1 << bit_depth) - 1;
    let (w0, o0, sh) = (wt.w[l], wt.o[l], wt.log2wd);
    let round = if sh >= 1 { 1 << (sh - 1) } else { 0 };
    for j in 0..h {
        for (d, &s) in dst[j * ds..j * ds + w].iter_mut().zip(&src[j * w..j * w + w]) {
            *d = P::new((((s as i32 * w0 + round) >> sh) + o0).clamp(0, max));
        }
    }
}

/// 8.5.3.3.4.3: explicit weighted bi-prediction.
pub fn put_weighted_bi<P: Sample>(a: &[i16], b: &[i16], w: usize, h: usize, bit_depth: u32, wt: &Weights, dst: &mut [P], ds: usize) {
    let max = (1 << bit_depth) - 1;
    let sh = wt.log2wd;
    let add = (wt.o[0] + wt.o[1] + 1) << sh;
    for j in 0..h {
        let (ra, rb) = (&a[j * w..j * w + w], &b[j * w..j * w + w]);
        for ((d, &p), &q) in dst[j * ds..j * ds + w].iter_mut().zip(ra).zip(rb) {
            *d = P::new(((p as i32 * wt.w[0] + q as i32 * wt.w[1] + add) >> (sh + 1)).clamp(0, max));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(n: usize, seed: &mut u32) -> Vec<u8> {
        (0..n)
            .map(|_| {
                *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (*seed >> 24) as u8
            })
            .collect()
    }

    /// The spec's per-sample formulation of the luma interpolation.
    fn reference(p: &Plane<u8>, x: i32, y: i32, mv: [i16; 2]) -> i32 {
        let at = |xx: i32, yy: i32| p.data[yy.clamp(0, p.height as i32 - 1) as usize * p.stride + xx.clamp(0, p.width as i32 - 1) as usize] as i32;
        let (xi, yi) = (x + (mv[0] as i32 >> 2), y + (mv[1] as i32 >> 2));
        let (xf, yf) = ((mv[0] & 3) as usize, (mv[1] & 3) as usize);
        let h = |yy: i32| -> i32 { (0..8).map(|k| LUMA[xf][k] * at(xi + k as i32 - 3, yy)).sum::<i32>() };
        match (xf, yf) {
            (0, 0) => at(xi, yi) << 6,
            (_, 0) => h(yi),
            (0, _) => (0..8).map(|k| LUMA[yf][k] * at(xi, yi + k as i32 - 3)).sum::<i32>(),
            _ => (0..8).map(|k| LUMA[yf][k] * h(yi + k as i32 - 3)).sum::<i32>() >> 6,
        }
    }

    #[test]
    fn luma_interpolation_matches_the_spec() {
        let mut seed = 5;
        let plane = Plane { data: noise(40 * 30, &mut seed), stride: 40, width: 40, height: 30 };
        let mut dst = vec![0i16; 16 * 16];
        let mut scratch = Scratch::new();
        for &(x, y) in &[(8, 8), (0, 0), (-5, 3), (36, 26), (20, -9)] {
            for mvx in -9..10 {
                for mvy in -9..10 {
                    luma(&plane, x, y, [mvx, mvy], 8, 4, 8, &mut dst, &mut scratch);
                    for j in 0..4 {
                        for i in 0..8 {
                            assert_eq!(dst[j * 8 + i] as i32, reference(&plane, x + i as i32, y + j as i32, [mvx, mvy]), "({x},{y}) mv ({mvx},{mvy})");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn default_weighting() {
        let a = [64i16 * 100; 4];
        let b = [64i16 * 50; 4];
        let mut d = [0u8; 4];
        put_uni(&a, 4, 1, 8, &mut d, 4);
        assert_eq!(d, [100; 4]);
        put_bi(&a, &b, 4, 1, 8, &mut d, 4);
        assert_eq!(d, [75; 4]);
    }
}
