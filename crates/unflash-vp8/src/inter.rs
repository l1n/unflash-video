//! Inter prediction (RFC 6386 section 18): a block of the reference picture
//! at a sub-sample position, through the six-tap or the bilinear filter.
//!
//! Both filters run horizontally first, rounding each pass to 8 bits. The
//! reference is the macroblock-aligned picture and repeats its edge samples
//! without end, as libvpx's borders and ffmpeg's edge emulation do; blocks
//! whose filter taps stay inside it read it in place, others read a small
//! edge-replicated copy.

use crate::tables::SIXTAP_FILTERS;

/// The interpolation filter a frame's version selects.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Filter {
    SixTap,
    Bilinear,
}

/// Largest block side.
const MAX_W: usize = 16;
/// The copy of a block near the picture edge: the block plus two samples
/// before and three after in each direction (what the six taps reach).
const WIN: usize = MAX_W + 5;

/// Eight-lane row kernels (wasm simd128, SSE2 or NEON through `wide`) for
/// blocks at least eight samples wide, computing exactly what the scalar
/// loops compute. A six-tap sum can exceed 16 bits (up to 160 x 255), but
/// its negative taps are at most 32 x 255: adding those first and the
/// positive ones with saturation reaches 32767 only when the result clips
/// to 255 anyway.
#[cfg(feature = "simd")]
mod simd {
    use wide::{i16x8, u8x16};

    /// Eight consecutive samples as i16 lanes.
    #[inline(always)]
    fn load8(s: &[u8]) -> i16x8 {
        let mut a = [0u8; 16];
        a[..8].copy_from_slice(&s[..8]);
        i16x8::from_u8x16_low(u8x16::from(a))
    }

    /// Eight lanes, clipped to 0..=255, into `d[..8]`.
    #[inline(always)]
    fn store8(v: i16x8, d: &mut [u8]) {
        d[..8].copy_from_slice(&u8x16::narrow_i16x8(v, v).as_array_ref()[..8]);
    }

    /// The six-tap filter over six vectors of samples.
    #[inline(always)]
    fn taps(s: [i16x8; 6], f: &[i32; 6]) -> i16x8 {
        let t = |k: usize| s[k] * f[k] as i16;
        let v = t(1) + t(4);
        let v = v.saturating_add(t(2)).saturating_add(t(3)).saturating_add(t(0)).saturating_add(t(5));
        v.saturating_add(i16x8::splat(64)) >> 7
    }

    /// Horizontal six-tap of one row: `r` starts two samples before the
    /// block and holds W + 5 samples.
    #[inline(always)]
    pub fn sixtap_h<const W: usize>(r: &[u8], f: &[i32; 6], o: &mut [u8]) {
        for k in 0..W / 8 {
            let s: &[u8; 13] = r[8 * k..8 * k + 13].try_into().unwrap();
            let v = taps(std::array::from_fn(|t| load8(&s[t..t + 8])), f);
            store8(v, &mut o[8 * k..8 * k + 8]);
        }
    }

    /// Vertical six-tap of one row from the six rows around it.
    #[inline(always)]
    pub fn sixtap_v<const W: usize>(r: [&[u8]; 6], f: &[i32; 6], o: &mut [u8]) {
        for k in 0..W / 8 {
            let v = taps(std::array::from_fn(|t| load8(&r[t][8 * k..8 * k + 8])), f);
            store8(v, &mut o[8 * k..8 * k + 8]);
        }
    }

    /// (a * (8 - f) + b * f + 4) >> 3 of one row.
    #[inline(always)]
    pub fn bilinear<const W: usize>(a: &[u8], b: &[u8], f: usize, o: &mut [u8]) {
        let (wa, wb) = ((8 - f) as i16, f as i16);
        for k in 0..W / 8 {
            let v = load8(&a[8 * k..8 * k + 8]) * wa + load8(&b[8 * k..8 * k + 8]) * wb;
            store8((v + 4i16) >> 3, &mut o[8 * k..8 * k + 8]);
        }
    }
}

#[inline(always)]
fn sixtap(s: &[u8], at: usize, step: usize, f: &[i32; 6]) -> u8 {
    let v = f[0] * s[at - 2 * step] as i32 + f[1] * s[at - step] as i32 + f[2] * s[at] as i32 + f[3] * s[at + step] as i32 + f[4] * s[at + 2 * step] as i32 + f[5] * s[at + 3 * step] as i32;
    ((v + 64) >> 7).clamp(0, 255) as u8
}

#[inline(always)]
fn bilinear(a: u8, b: u8, f: usize) -> u8 {
    ((a as u32 * (8 - f as u32) + b as u32 * f as u32 + 4) >> 3) as u8
}

/// Horizontal six-tap of one row of `W` samples (`r` starts two samples
/// before the block).
#[inline(always)]
fn sixtap_h<const W: usize>(r: &[u8], f: &[i32; 6], o: &mut [u8]) {
    #[cfg(feature = "simd")]
    if W >= 8 {
        simd::sixtap_h::<W>(r, f, o);
        return;
    }
    for (i, v) in o[..W].iter_mut().enumerate() {
        *v = sixtap(r, i + 2, 1, f);
    }
}

/// Vertical six-tap of one row of `W` samples from the six rows around it.
#[inline(always)]
fn sixtap_v<const W: usize>(r: [&[u8]; 6], f: &[i32; 6], o: &mut [u8]) {
    #[cfg(feature = "simd")]
    if W >= 8 {
        simd::sixtap_v::<W>(r, f, o);
        return;
    }
    for (i, v) in o[..W].iter_mut().enumerate() {
        let s = (0..6).map(|t| f[t] * r[t][i] as i32).sum::<i32>();
        *v = ((s + 64) >> 7).clamp(0, 255) as u8;
    }
}

/// One row of the bilinear filter between rows (or shifted rows) `a` and
/// `b`.
#[inline(always)]
fn bilinear_row<const W: usize>(a: &[u8], b: &[u8], f: usize, o: &mut [u8]) {
    #[cfg(feature = "simd")]
    if W >= 8 {
        simd::bilinear::<W>(a, b, f, o);
        return;
    }
    for i in 0..W {
        o[i] = bilinear(a[i], b[i], f);
    }
}

/// Filter a `W`x`h` block whose top-left source sample is `src[origin]`
/// (stride `ss`, with the six-tap margins around it) into `dst`.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn filter_block<const W: usize>(src: &[u8], origin: usize, ss: usize, fx: usize, fy: usize, h: usize, filter: Filter, dst: &mut [u8], ds: usize) {
    if fx == 0 && fy == 0 {
        for j in 0..h {
            dst[j * ds..j * ds + W].copy_from_slice(&src[origin + j * ss..origin + j * ss + W]);
        }
        return;
    }
    match filter {
        Filter::SixTap => {
            let (hf, vf) = (&SIXTAP_FILTERS[fx], &SIXTAP_FILTERS[fy]);
            if fy == 0 {
                for j in 0..h {
                    let r = origin + j * ss - 2;
                    sixtap_h::<W>(&src[r..r + W + 5], hf, &mut dst[j * ds..]);
                }
            } else if fx == 0 {
                for j in 0..h {
                    let r = origin + j * ss;
                    let rows = std::array::from_fn(|t| &src[r + t * ss - 2 * ss..r + t * ss - 2 * ss + W]);
                    sixtap_v::<W>(rows, vf, &mut dst[j * ds..]);
                }
            } else {
                // rows -2 ..= h + 2 through the horizontal filter, then down
                let mut tmp = [0u8; WIN * MAX_W];
                for j in 0..h + 5 {
                    let r = origin + j * ss - 2 * ss - 2;
                    sixtap_h::<W>(&src[r..r + W + 5], hf, &mut tmp[j * W..]);
                }
                for j in 0..h {
                    let rows = std::array::from_fn(|t| &tmp[(j + t) * W..(j + t + 1) * W]);
                    sixtap_v::<W>(rows, vf, &mut dst[j * ds..]);
                }
            }
        }
        Filter::Bilinear => {
            if fy == 0 {
                for j in 0..h {
                    let r = origin + j * ss;
                    bilinear_row::<W>(&src[r..r + W], &src[r + 1..r + W + 1], fx, &mut dst[j * ds..]);
                }
            } else if fx == 0 {
                for j in 0..h {
                    let r = origin + j * ss;
                    bilinear_row::<W>(&src[r..r + W], &src[r + ss..r + ss + W], fy, &mut dst[j * ds..]);
                }
            } else {
                let mut tmp = [0u8; (MAX_W + 1) * MAX_W];
                for j in 0..h + 1 {
                    let r = origin + j * ss;
                    bilinear_row::<W>(&src[r..r + W], &src[r + 1..r + W + 1], fx, &mut tmp[j * W..]);
                }
                for j in 0..h {
                    let (a, b) = tmp[j * W..(j + 2) * W].split_at(W);
                    bilinear_row::<W>(a, b, fy, &mut dst[j * ds..]);
                }
            }
        }
    }
}

/// `filter_block` for the block widths VP8 uses (16, 8 and 4).
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn filter_any(src: &[u8], origin: usize, ss: usize, fx: usize, fy: usize, w: usize, h: usize, filter: Filter, dst: &mut [u8], ds: usize) {
    match w {
        16 => filter_block::<16>(src, origin, ss, fx, fy, h, filter, dst, ds),
        8 => filter_block::<8>(src, origin, ss, fx, fy, h, filter, dst, ds),
        _ => filter_block::<4>(src, origin, ss, fx, fy, h, filter, dst, ds),
    }
}

/// Predict a `w`x`h` block (16, 8 or 4 wide, at most 16 high) into `dst`
/// (stride `ds`) from the reference plane `src` (`pw`x`ph` samples, stride
/// `ps`). The block's top-left source sample is (`x`, `y`) in whole
/// samples plus (`fx`, `fy`) eighths of a sample.
#[allow(clippy::too_many_arguments)]
pub fn predict(src: &[u8], ps: usize, pw: usize, ph: usize, x: i32, y: i32, fx: usize, fy: usize, w: usize, h: usize, filter: Filter, dst: &mut [u8], ds: usize) {
    let inside = x >= 2 && y >= 2 && x + w as i32 + 3 <= pw as i32 && y + h as i32 + 3 <= ph as i32;
    if inside {
        filter_any(src, y as usize * ps + x as usize, ps, fx, fy, w, h, filter, dst, ds);
        return;
    }
    // the columns of the window that fall inside the plane, the rest
    // repeating its first or last sample
    let x0 = x - 2;
    let n = w as i32 + 5;
    let (in0, in1) = (x0.clamp(0, pw as i32), (x0 + n).clamp(0, pw as i32));
    // where they are in the window
    let (a, b) = ((in0 - x0).clamp(0, n) as usize, (in1 - x0).clamp(0, n) as usize);
    let mut win = [0u8; WIN * WIN];
    for j in 0..h + 5 {
        let sy = (y + j as i32 - 2).clamp(0, ph as i32 - 1) as usize;
        let row = &src[sy * ps..sy * ps + pw];
        let out = &mut win[j * WIN..j * WIN + n as usize];
        out[..a].fill(row[0]);
        out[a..b].copy_from_slice(&row[in0 as usize..in0 as usize + (b - a)]);
        out[b..].fill(row[pw - 1]);
    }
    filter_any(&win, 2 * WIN + 2, WIN, fx, fy, w, h, filter, dst, ds);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One sample the plain way: taps on the endlessly edge-extended plane.
    #[allow(clippy::too_many_arguments)]
    fn reference(plane: &[u8], pw: usize, ph: usize, x: i32, y: i32, fx: usize, fy: usize, filter: Filter) -> u8 {
        let at = |xx: i32, yy: i32| plane[yy.clamp(0, ph as i32 - 1) as usize * pw + xx.clamp(0, pw as i32 - 1) as usize] as i32;
        match filter {
            Filter::SixTap => {
                let hf = &SIXTAP_FILTERS[fx];
                let vf = &SIXTAP_FILTERS[fy];
                let h = |yy: i32| -> i32 {
                    let v: i32 = (0..6).map(|k| hf[k] * at(x + k as i32 - 2, yy)).sum();
                    ((v + 64) >> 7).clamp(0, 255)
                };
                let v: i32 = (0..6).map(|k| vf[k] * h(y + k as i32 - 2)).sum();
                ((v + 64) >> 7).clamp(0, 255) as u8
            }
            Filter::Bilinear => {
                let h = |yy: i32| (at(x, yy) * (8 - fx as i32) + at(x + 1, yy) * fx as i32 + 4) >> 3;
                ((h(y) * (8 - fy as i32) + h(y + 1) * fy as i32 + 4) >> 3) as u8
            }
        }
    }

    fn check(plane: &[u8], pw: usize, ph: usize) {
        let mut dst = vec![0u8; 16 * 16];
        for filter in [Filter::SixTap, Filter::Bilinear] {
            for &(w, h) in &[(16usize, 16usize), (8, 8), (4, 4), (16, 8), (8, 16), (8, 4), (4, 8)] {
                for &(x, y) in &[(8i32, 6i32), (0, 0), (-7, 3), (20, 13), (-30, -40), (40, 30), (3, -2)] {
                    for fx in 0..8 {
                        for fy in 0..8 {
                            predict(plane, pw, pw, ph, x, y, fx, fy, w, h, filter, &mut dst, 16);
                            for j in 0..h {
                                for i in 0..w {
                                    let want = reference(plane, pw, ph, x + i as i32, y + j as i32, fx, fy, filter);
                                    assert_eq!(dst[j * 16 + i], want, "{filter:?} {w}x{h} at ({x},{y}) frac ({fx},{fy}) sample ({i},{j})");
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn matches_the_reference_everywhere() {
        let (pw, ph) = (32usize, 24usize);
        let mut seed = 5u32;
        let noise: Vec<u8> = (0..pw * ph)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 24) as u8
            })
            .collect();
        check(&noise, pw, ph);
        // the largest sums: bright columns between black ones, where the
        // six-tap result clips at both ends
        let stripes: Vec<u8> = (0..pw * ph).map(|i| if (i % pw) % 4 < 2 { 255 } else { 0 }).collect();
        check(&stripes, pw, ph);
        let rows: Vec<u8> = (0..pw * ph).map(|i| if (i / pw) % 4 < 2 { 255 } else { 0 }).collect();
        check(&rows, pw, ph);
    }
}
