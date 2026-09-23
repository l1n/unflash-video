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

#[inline(always)]
fn sixtap(s: &[u8], at: usize, step: usize, f: &[i32; 6]) -> u8 {
    let v = f[0] * s[at - 2 * step] as i32 + f[1] * s[at - step] as i32 + f[2] * s[at] as i32 + f[3] * s[at + step] as i32 + f[4] * s[at + 2 * step] as i32 + f[5] * s[at + 3 * step] as i32;
    ((v + 64) >> 7).clamp(0, 255) as u8
}

#[inline(always)]
fn bilinear(a: u8, b: u8, f: usize) -> u8 {
    ((a as u32 * (8 - f as u32) + b as u32 * f as u32 + 4) >> 3) as u8
}

/// Filter a `w`x`h` block whose top-left source sample is `src[origin]`
/// (stride `ss`, with the six-tap margins around it) into `dst`.
#[allow(clippy::too_many_arguments)]
fn filter_block(src: &[u8], origin: usize, ss: usize, fx: usize, fy: usize, w: usize, h: usize, filter: Filter, dst: &mut [u8], ds: usize) {
    if fx == 0 && fy == 0 {
        for j in 0..h {
            dst[j * ds..j * ds + w].copy_from_slice(&src[origin + j * ss..origin + j * ss + w]);
        }
        return;
    }
    match filter {
        Filter::SixTap => {
            let (hf, vf) = (&SIXTAP_FILTERS[fx], &SIXTAP_FILTERS[fy]);
            if fy == 0 {
                for j in 0..h {
                    for i in 0..w {
                        dst[j * ds + i] = sixtap(src, origin + j * ss + i, 1, hf);
                    }
                }
            } else if fx == 0 {
                for j in 0..h {
                    for i in 0..w {
                        dst[j * ds + i] = sixtap(src, origin + j * ss + i, ss, vf);
                    }
                }
            } else {
                // rows -2 ..= h + 2 through the horizontal filter, then down
                let mut tmp = [0u8; WIN * MAX_W];
                for j in 0..h + 5 {
                    for i in 0..w {
                        tmp[j * MAX_W + i] = sixtap(src, origin + (j * ss + i) - 2 * ss, 1, hf);
                    }
                }
                for j in 0..h {
                    for i in 0..w {
                        dst[j * ds + i] = sixtap(&tmp, (j + 2) * MAX_W + i, MAX_W, vf);
                    }
                }
            }
        }
        Filter::Bilinear => {
            if fy == 0 {
                for j in 0..h {
                    let r = &src[origin + j * ss..];
                    for i in 0..w {
                        dst[j * ds + i] = bilinear(r[i], r[i + 1], fx);
                    }
                }
            } else if fx == 0 {
                for j in 0..h {
                    let (r0, r1) = (&src[origin + j * ss..], &src[origin + (j + 1) * ss..]);
                    for i in 0..w {
                        dst[j * ds + i] = bilinear(r0[i], r1[i], fy);
                    }
                }
            } else {
                let mut tmp = [0u8; (MAX_W + 1) * MAX_W];
                for j in 0..h + 1 {
                    let r = &src[origin + j * ss..];
                    for i in 0..w {
                        tmp[j * MAX_W + i] = bilinear(r[i], r[i + 1], fx);
                    }
                }
                for j in 0..h {
                    for i in 0..w {
                        dst[j * ds + i] = bilinear(tmp[j * MAX_W + i], tmp[(j + 1) * MAX_W + i], fy);
                    }
                }
            }
        }
    }
}

/// Predict a `w`x`h` block (at most 16x16) into `dst` (stride `ds`) from
/// the reference plane `src` (`pw`x`ph` samples, stride `ps`). The block's
/// top-left source sample is (`x`, `y`) in whole samples plus (`fx`, `fy`)
/// eighths of a sample.
#[allow(clippy::too_many_arguments)]
pub fn predict(src: &[u8], ps: usize, pw: usize, ph: usize, x: i32, y: i32, fx: usize, fy: usize, w: usize, h: usize, filter: Filter, dst: &mut [u8], ds: usize) {
    let inside = x >= 2 && y >= 2 && x + w as i32 + 3 <= pw as i32 && y + h as i32 + 3 <= ph as i32;
    if inside {
        let origin = y as usize * ps + x as usize;
        filter_block(src, origin, ps, fx, fy, w, h, filter, dst, ds);
        return;
    }
    let mut win = [0u8; WIN * WIN];
    for j in 0..h + 5 {
        let sy = (y + j as i32 - 2).clamp(0, ph as i32 - 1) as usize;
        let row = &src[sy * ps..sy * ps + pw];
        for (i, v) in win[j * WIN..j * WIN + w + 5].iter_mut().enumerate() {
            *v = row[(x + i as i32 - 2).clamp(0, pw as i32 - 1) as usize];
        }
    }
    filter_block(&win, 2 * WIN + 2, WIN, fx, fy, w, h, filter, dst, ds);
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

    #[test]
    fn matches_the_reference_everywhere() {
        let (pw, ph) = (32usize, 24usize);
        let mut seed = 5u32;
        let plane: Vec<u8> = (0..pw * ph)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 24) as u8
            })
            .collect();
        let mut dst = vec![0u8; 16 * 16];
        for filter in [Filter::SixTap, Filter::Bilinear] {
            for &(w, h) in &[(16usize, 16usize), (8, 8), (4, 4), (16, 8), (8, 16)] {
                for &(x, y) in &[(8i32, 6i32), (0, 0), (-7, 3), (20, 13), (-30, -40), (40, 30), (3, -2)] {
                    for fx in 0..8 {
                        for fy in 0..8 {
                            predict(&plane, pw, pw, ph, x, y, fx, fy, w, h, filter, &mut dst, 16);
                            for j in 0..h {
                                for i in 0..w {
                                    let want = reference(&plane, pw, ph, x + i as i32, y + j as i32, fx, fy, filter);
                                    assert_eq!(dst[j * 16 + i], want, "{filter:?} {w}x{h} at ({x},{y}) frac ({fx},{fy}) sample ({i},{j})");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
