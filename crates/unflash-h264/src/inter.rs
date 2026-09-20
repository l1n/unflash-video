//! Inter prediction sample interpolation (8.4.2.2) and weighted sample
//! prediction (8.4.2.3).
//!
//! The kernels read the reference plane directly when the block and its
//! filter margins lie inside the picture, and from a small edge-replicated
//! window otherwise. They write into the destination picture with its
//! stride, optionally averaging with what is already there (the default
//! bi-predictive average), so the common paths need no temporary buffers.

#[inline(always)]
fn clip(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

#[inline(always)]
fn tap(a: i32, b: i32, c: i32, d: i32, e: i32, f: i32) -> i32 {
    a - 5 * b + 20 * c + 20 * d - 5 * e + f
}

/// Largest luma block side.
const MAX_W: usize = 16;
/// Edge-emulated luma window: the block plus two samples before and three after.
const WIN: usize = MAX_W + 5;

/// Store `a` (or the rounded average of `a` and `b`) into `dst`, averaging
/// with the previous contents when `avg` is set.
#[inline(always)]
fn emit<const W: usize>(a: &[u8], b: Option<&[u8]>, h: usize, dst: &mut [u8], ds: usize, avg: bool) {
    for j in 0..h {
        let ra = &a[j * W..j * W + W];
        let d = &mut dst[j * ds..j * ds + W];
        match b {
            Some(b) => {
                let rb = &b[j * W..j * W + W];
                if avg {
                    for i in 0..W {
                        let v = (ra[i] as u32 + rb[i] as u32 + 1) >> 1;
                        d[i] = ((d[i] as u32 + v + 1) >> 1) as u8;
                    }
                } else {
                    for i in 0..W {
                        d[i] = ((ra[i] as u32 + rb[i] as u32 + 1) >> 1) as u8;
                    }
                }
            }
            None => {
                if avg {
                    for i in 0..W {
                        d[i] = ((d[i] as u32 + ra[i] as u32 + 1) >> 1) as u8;
                    }
                } else {
                    d.copy_from_slice(ra);
                }
            }
        }
    }
}

/// Full-sample block whose top-left is `src[base]` (stride `ss`).
#[inline(always)]
fn full<const W: usize>(src: &[u8], base: usize, ss: usize, h: usize, out: &mut [u8]) {
    for j in 0..h {
        out[j * W..j * W + W].copy_from_slice(&src[base + j * ss..base + j * ss + W]);
    }
}

/// Horizontal half-sample positions (b) of the rows starting at `src[base]`.
#[inline(always)]
fn hhalf<const W: usize>(src: &[u8], base: usize, ss: usize, h: usize, out: &mut [u8]) {
    for j in 0..h {
        let r = &src[base + j * ss - 2..base + j * ss + W + 3];
        let o = &mut out[j * W..j * W + W];
        for i in 0..W {
            o[i] = clip((tap(r[i] as i32, r[i + 1] as i32, r[i + 2] as i32, r[i + 3] as i32, r[i + 4] as i32, r[i + 5] as i32) + 16) >> 5);
        }
    }
}

/// Vertical half-sample positions (h) of the columns starting at `src[base]`.
#[inline(always)]
fn vhalf<const W: usize>(src: &[u8], base: usize, ss: usize, h: usize, out: &mut [u8]) {
    for j in 0..h {
        let p = base + j * ss;
        let (r0, r1, r2, r3, r4, r5) = (&src[p - 2 * ss..p - 2 * ss + W], &src[p - ss..p - ss + W], &src[p..p + W], &src[p + ss..p + ss + W], &src[p + 2 * ss..p + 2 * ss + W], &src[p + 3 * ss..p + 3 * ss + W]);
        let o = &mut out[j * W..j * W + W];
        for i in 0..W {
            o[i] = clip((tap(r0[i] as i32, r1[i] as i32, r2[i] as i32, r3[i] as i32, r4[i] as i32, r5[i] as i32) + 16) >> 5);
        }
    }
}

/// Centre half-sample positions (j): the vertical filter over the
/// unclipped horizontal intermediates.
#[inline(always)]
fn center<const W: usize>(src: &[u8], base: usize, ss: usize, h: usize, out: &mut [u8]) {
    let mut t = [0i16; WIN * MAX_W];
    for j in 0..h + 5 {
        let p = base + j * ss - 2 * ss - 2;
        let r = &src[p..p + W + 5];
        let o = &mut t[j * W..j * W + W];
        for i in 0..W {
            o[i] = tap(r[i] as i32, r[i + 1] as i32, r[i + 2] as i32, r[i + 3] as i32, r[i + 4] as i32, r[i + 5] as i32) as i16;
        }
    }
    for j in 0..h {
        let (r0, r1, r2, r3, r4, r5) = (&t[j * W..j * W + W], &t[(j + 1) * W..(j + 1) * W + W], &t[(j + 2) * W..(j + 2) * W + W], &t[(j + 3) * W..(j + 3) * W + W], &t[(j + 4) * W..(j + 4) * W + W], &t[(j + 5) * W..(j + 5) * W + W]);
        let o = &mut out[j * W..j * W + W];
        for i in 0..W {
            o[i] = clip((tap(r0[i] as i32, r1[i] as i32, r2[i] as i32, r3[i] as i32, r4[i] as i32, r5[i] as i32) + 512) >> 10);
        }
    }
}

/// One W×h luma block at fractional position (`xf`, `yf`) whose integer
/// position is `src[base]`; the source must have 2 samples of margin
/// before and 3 after the block in both directions.
#[inline(always)]
fn luma_block<const W: usize>(src: &[u8], base: usize, ss: usize, xf: i32, yf: i32, h: usize, dst: &mut [u8], ds: usize, avg: bool) {
    let mut a = [0u8; MAX_W * MAX_W];
    let mut b = [0u8; MAX_W * MAX_W];
    match (xf, yf) {
        (0, 0) => {
            // copy straight from the source
            for j in 0..h {
                let r = &src[base + j * ss..base + j * ss + W];
                let d = &mut dst[j * ds..j * ds + W];
                if avg {
                    for i in 0..W {
                        d[i] = ((d[i] as u32 + r[i] as u32 + 1) >> 1) as u8;
                    }
                } else {
                    d.copy_from_slice(r);
                }
            }
            return;
        }
        (2, 0) => hhalf::<W>(src, base, ss, h, &mut a),
        (0, 2) => vhalf::<W>(src, base, ss, h, &mut a),
        (2, 2) => center::<W>(src, base, ss, h, &mut a),
        (1, 0) | (3, 0) => {
            full::<W>(src, base + (xf == 3) as usize, ss, h, &mut a);
            hhalf::<W>(src, base, ss, h, &mut b);
            emit::<W>(&a, Some(&b), h, dst, ds, avg);
            return;
        }
        (0, 1) | (0, 3) => {
            full::<W>(src, base + if yf == 3 { ss } else { 0 }, ss, h, &mut a);
            vhalf::<W>(src, base, ss, h, &mut b);
            emit::<W>(&a, Some(&b), h, dst, ds, avg);
            return;
        }
        (2, 1) | (2, 3) => {
            hhalf::<W>(src, base + if yf == 3 { ss } else { 0 }, ss, h, &mut a);
            center::<W>(src, base, ss, h, &mut b);
            emit::<W>(&a, Some(&b), h, dst, ds, avg);
            return;
        }
        (1, 2) | (3, 2) => {
            vhalf::<W>(src, base + (xf == 3) as usize, ss, h, &mut a);
            center::<W>(src, base, ss, h, &mut b);
            emit::<W>(&a, Some(&b), h, dst, ds, avg);
            return;
        }
        _ => {
            // the four diagonal quarter positions: average of a horizontal
            // and a vertical half-sample
            hhalf::<W>(src, base + if yf == 3 { ss } else { 0 }, ss, h, &mut a);
            vhalf::<W>(src, base + (xf == 3) as usize, ss, h, &mut b);
            emit::<W>(&a, Some(&b), h, dst, ds, avg);
            return;
        }
    }
    emit::<W>(&a, None, h, dst, ds, avg);
}

/// Quarter-sample luma prediction of a `w`×`h` block whose top-left luma
/// sample is at (`x`, `y`) in the picture, displaced by (`mvx`, `mvy`) in
/// quarter samples, written to `dst` (stride `ds`); with `avg` the
/// prediction is averaged into `dst` (the default bi-prediction).
#[allow(clippy::too_many_arguments)]
pub fn mc_luma(plane: &[u8], pw: usize, ph: usize, x: i32, y: i32, mvx: i32, mvy: i32, w: usize, h: usize, dst: &mut [u8], ds: usize, avg: bool) {
    let xi = x + (mvx >> 2);
    let yi = y + (mvy >> 2);
    let xf = mvx & 3;
    let yf = mvy & 3;
    let inside = xi >= 2 && yi >= 2 && xi + w as i32 + 3 <= pw as i32 && yi + h as i32 + 3 <= ph as i32;
    if inside {
        let base = yi as usize * pw + xi as usize;
        match w {
            16 => luma_block::<16>(plane, base, pw, xf, yf, h, dst, ds, avg),
            8 => luma_block::<8>(plane, base, pw, xf, yf, h, dst, ds, avg),
            _ => luma_block::<4>(plane, base, pw, xf, yf, h, dst, ds, avg),
        }
        return;
    }
    // edge-replicated window of (w + 5) × (h + 5) samples
    let ww = w + 5;
    let mut win = [0u8; WIN * WIN];
    for j in 0..h + 5 {
        let sy = (yi + j as i32 - 2).clamp(0, ph as i32 - 1) as usize;
        let row = &plane[sy * pw..sy * pw + pw];
        let o = &mut win[j * ww..j * ww + ww];
        let x0 = xi - 2;
        if x0 >= 0 && x0 as usize + ww <= pw {
            o.copy_from_slice(&row[x0 as usize..x0 as usize + ww]);
        } else {
            for (i, v) in o.iter_mut().enumerate() {
                *v = row[(x0 + i as i32).clamp(0, pw as i32 - 1) as usize];
            }
        }
    }
    let base = 2 * ww + 2;
    match w {
        16 => luma_block::<16>(&win, base, ww, xf, yf, h, dst, ds, avg),
        8 => luma_block::<8>(&win, base, ww, xf, yf, h, dst, ds, avg),
        _ => luma_block::<4>(&win, base, ww, xf, yf, h, dst, ds, avg),
    }
}

#[inline(always)]
fn chroma_block<const W: usize>(src: &[u8], base: usize, ss: usize, xf: i32, yf: i32, h: usize, dst: &mut [u8], ds: usize, avg: bool) {
    if xf == 0 && yf == 0 {
        for j in 0..h {
            let r = &src[base + j * ss..base + j * ss + W];
            let d = &mut dst[j * ds..j * ds + W];
            if avg {
                for i in 0..W {
                    d[i] = ((d[i] as u32 + r[i] as u32 + 1) >> 1) as u8;
                }
            } else {
                d.copy_from_slice(r);
            }
        }
        return;
    }
    let w00 = (8 - xf) * (8 - yf);
    let w10 = xf * (8 - yf);
    let w01 = (8 - xf) * yf;
    let w11 = xf * yf;
    for j in 0..h {
        let p = base + j * ss;
        let r0 = &src[p..p + W + 1];
        let r1 = &src[p + ss..p + ss + W + 1];
        let d = &mut dst[j * ds..j * ds + W];
        for i in 0..W {
            let v = (w00 * r0[i] as i32 + w10 * r0[i + 1] as i32 + w01 * r1[i] as i32 + w11 * r1[i + 1] as i32 + 32) >> 6;
            d[i] = if avg { ((d[i] as i32 + v + 1) >> 1) as u8 } else { v as u8 };
        }
    }
}

/// Eighth-sample chroma prediction (4:2:0): block at chroma position
/// (`x`, `y`) of size `w`×`h`, motion vector in eighth chroma samples,
/// into `dst` with stride `ds` (averaged in when `avg`).
#[allow(clippy::too_many_arguments)]
pub fn mc_chroma(plane: &[u8], pw: usize, ph: usize, x: i32, y: i32, mvx: i32, mvy: i32, w: usize, h: usize, dst: &mut [u8], ds: usize, avg: bool) {
    let xi = x + (mvx >> 3);
    let yi = y + (mvy >> 3);
    let xf = mvx & 7;
    let yf = mvy & 7;
    let inside = xi >= 0 && yi >= 0 && xi + w as i32 + 1 <= pw as i32 && yi + h as i32 + 1 <= ph as i32;
    if inside {
        let base = yi as usize * pw + xi as usize;
        match w {
            8 => chroma_block::<8>(plane, base, pw, xf, yf, h, dst, ds, avg),
            4 => chroma_block::<4>(plane, base, pw, xf, yf, h, dst, ds, avg),
            _ => chroma_block::<2>(plane, base, pw, xf, yf, h, dst, ds, avg),
        }
        return;
    }
    let ww = w + 1;
    let mut win = [0u8; 9 * 9];
    for j in 0..h + 1 {
        let sy = (yi + j as i32).clamp(0, ph as i32 - 1) as usize;
        let row = &plane[sy * pw..sy * pw + pw];
        for i in 0..ww {
            win[j * ww + i] = row[(xi + i as i32).clamp(0, pw as i32 - 1) as usize];
        }
    }
    match w {
        8 => chroma_block::<8>(&win, 0, ww, xf, yf, h, dst, ds, avg),
        4 => chroma_block::<4>(&win, 0, ww, xf, yf, h, dst, ds, avg),
        _ => chroma_block::<2>(&win, 0, ww, xf, yf, h, dst, ds, avg),
    }
}

/// Explicit or implicit weights of one block: (w0, o0, w1, o1, logWD).
pub type Weights = (i32, i32, i32, i32, i32);

/// Whether these weights reproduce the default prediction exactly (so the
/// unweighted kernels can be used): unit weight and no offset for a single
/// list, equal unit weights for two.
pub fn weights_are_default(w: Weights, bi: bool) -> bool {
    let (w0, o0, w1, o1, log_wd) = w;
    if bi {
        w0 == (1 << log_wd) && w1 == (1 << log_wd) && o0 == 0 && o1 == 0
    } else {
        w0 == (1 << log_wd) && o0 == 0
    }
}

/// 8.4.2.3.2: explicit single-list weighting of a packed `w`×`h` block into
/// `dst` (stride `ds`).
pub fn weight_uni(p: &[u8], w: usize, h: usize, weights: Weights, dst: &mut [u8], ds: usize) {
    let (w0, o0, _, _, log_wd) = weights;
    for j in 0..h {
        let r = &p[j * w..j * w + w];
        let d = &mut dst[j * ds..j * ds + w];
        if log_wd >= 1 {
            let round = 1 << (log_wd - 1);
            for i in 0..w {
                d[i] = clip(((r[i] as i32 * w0 + round) >> log_wd) + o0);
            }
        } else {
            for i in 0..w {
                d[i] = clip(r[i] as i32 * w0 + o0);
            }
        }
    }
}

/// 8.4.2.3.2: weighted bi-prediction of two packed blocks into `dst`.
pub fn weight_bi(p0: &[u8], p1: &[u8], w: usize, h: usize, weights: Weights, dst: &mut [u8], ds: usize) {
    let (w0, o0, w1, o1, log_wd) = weights;
    let round = 1 << log_wd;
    let o = (o0 + o1 + 1) >> 1;
    for j in 0..h {
        let r0 = &p0[j * w..j * w + w];
        let r1 = &p1[j * w..j * w + w];
        let d = &mut dst[j * ds..j * ds + w];
        for i in 0..w {
            d[i] = clip(((r0[i] as i32 * w0 + r1[i] as i32 * w1 + round) >> (log_wd + 1)) + o);
        }
    }
}

/// 8.4.1.2.3 / 8.4.2.3.2: the scaling of a temporal-direct or implicit
/// weight: (tb, td) -> DistScaleFactor, or None when td is zero.
pub fn dist_scale_factor(poc_cur: i32, poc_ref0: i32, poc_ref1: i32) -> Option<i32> {
    let tb = (poc_cur - poc_ref0).clamp(-128, 127);
    let td = (poc_ref1 - poc_ref0).clamp(-128, 127);
    if td == 0 {
        return None;
    }
    let tx = (16384 + (td / 2).abs()) / td;
    Some(((tb * tx + 32) >> 6).clamp(-1024, 1023))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The straightforward reference implementation of 8.4.2.2.1 for one sample.
    fn reference_luma(plane: &[u8], pw: usize, ph: usize, x: i32, y: i32, mvx: i32, mvy: i32) -> u8 {
        let at = |xx: i32, yy: i32| -> i32 { plane[yy.clamp(0, ph as i32 - 1) as usize * pw + xx.clamp(0, pw as i32 - 1) as usize] as i32 };
        let xi = x + (mvx >> 2);
        let yi = y + (mvy >> 2);
        let xf = mvx & 3;
        let yf = mvy & 3;
        let b1 = |xx: i32, yy: i32| tap(at(xx - 2, yy), at(xx - 1, yy), at(xx, yy), at(xx + 1, yy), at(xx + 2, yy), at(xx + 3, yy));
        let h1 = |xx: i32, yy: i32| tap(at(xx, yy - 2), at(xx, yy - 1), at(xx, yy), at(xx, yy + 1), at(xx, yy + 2), at(xx, yy + 3));
        let b = |xx: i32, yy: i32| clip((b1(xx, yy) + 16) >> 5) as i32;
        let hh = |xx: i32, yy: i32| clip((h1(xx, yy) + 16) >> 5) as i32;
        let j = |xx: i32, yy: i32| clip((tap(b1(xx, yy - 2), b1(xx, yy - 1), b1(xx, yy), b1(xx, yy + 1), b1(xx, yy + 2), b1(xx, yy + 3)) + 512) >> 10) as i32;
        let g = at(xi, yi);
        let avg = |p: i32, q: i32| ((p + q + 1) >> 1) as u8;
        match (xf, yf) {
            (0, 0) => g as u8,
            (1, 0) => avg(g, b(xi, yi)),
            (2, 0) => b(xi, yi) as u8,
            (3, 0) => avg(b(xi, yi), at(xi + 1, yi)),
            (0, 1) => avg(g, hh(xi, yi)),
            (0, 2) => hh(xi, yi) as u8,
            (0, 3) => avg(hh(xi, yi), at(xi, yi + 1)),
            (2, 2) => j(xi, yi) as u8,
            (2, 1) => avg(b(xi, yi), j(xi, yi)),
            (2, 3) => avg(j(xi, yi), b(xi, yi + 1)),
            (1, 2) => avg(hh(xi, yi), j(xi, yi)),
            (3, 2) => avg(j(xi, yi), hh(xi + 1, yi)),
            (1, 1) => avg(b(xi, yi), hh(xi, yi)),
            (3, 1) => avg(b(xi, yi), hh(xi + 1, yi)),
            (1, 3) => avg(hh(xi, yi), b(xi, yi + 1)),
            _ => avg(hh(xi + 1, yi), b(xi, yi + 1)),
        }
    }

    fn noise(n: usize, seed: &mut u32) -> Vec<u8> {
        (0..n)
            .map(|_| {
                *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (*seed >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn luma_matches_the_reference_everywhere() {
        let (pw, ph) = (48usize, 40usize);
        let mut seed = 7;
        let plane = noise(pw * ph, &mut seed);
        let mut dst = vec![0u8; 32 * 32];
        for &(w, h) in &[(16usize, 16usize), (16, 8), (8, 16), (8, 8), (8, 4), (4, 8), (4, 4)] {
            for &(x, y) in &[(16i32, 16i32), (0, 0), (-9, 5), (40, 30), (3, -7), (47, 39)] {
                for mvx in -11..12 {
                    for mvy in -9..10 {
                        mc_luma(&plane, pw, ph, x, y, mvx, mvy, w, h, &mut dst, 32, false);
                        for j in 0..h {
                            for i in 0..w {
                                let want = reference_luma(&plane, pw, ph, x + i as i32, y + j as i32, mvx, mvy);
                                assert_eq!(dst[j * 32 + i], want, "{w}x{h} at ({x},{y}) mv ({mvx},{mvy}) sample ({i},{j})");
                            }
                        }
                    }
                }
            }
        }
        // averaging into the destination
        let mut a = vec![0u8; 256];
        let mut b = vec![0u8; 256];
        mc_luma(&plane, pw, ph, 5, 6, 3, -5, 16, 16, &mut a, 16, false);
        mc_luma(&plane, pw, ph, 9, 2, -7, 1, 16, 16, &mut b, 16, false);
        let mut c = a.clone();
        mc_luma(&plane, pw, ph, 9, 2, -7, 1, 16, 16, &mut c, 16, true);
        for i in 0..256 {
            assert_eq!(c[i] as u32, (a[i] as u32 + b[i] as u32 + 1) >> 1);
        }
    }

    #[test]
    fn chroma_matches_the_reference() {
        let (pw, ph) = (24usize, 20usize);
        let mut seed = 3;
        let plane = noise(pw * ph, &mut seed);
        let at = |xx: i32, yy: i32| -> i32 { plane[yy.clamp(0, ph as i32 - 1) as usize * pw + xx.clamp(0, pw as i32 - 1) as usize] as i32 };
        let mut dst = vec![0u8; 16 * 16];
        for &(w, h) in &[(8usize, 8usize), (8, 4), (4, 8), (4, 4), (4, 2), (2, 4), (2, 2)] {
            for &(x, y) in &[(8i32, 8i32), (0, 0), (-5, 3), (20, 15), (2, -4)] {
                for mvx in -19..20 {
                    for mvy in -17..18 {
                        mc_chroma(&plane, pw, ph, x, y, mvx, mvy, w, h, &mut dst, 16, false);
                        let xi = x + (mvx >> 3);
                        let yi = y + (mvy >> 3);
                        let (xf, yf) = (mvx & 7, mvy & 7);
                        for j in 0..h as i32 {
                            for i in 0..w as i32 {
                                let want = ((8 - xf) * (8 - yf) * at(xi + i, yi + j) + xf * (8 - yf) * at(xi + i + 1, yi + j) + (8 - xf) * yf * at(xi + i, yi + j + 1) + xf * yf * at(xi + i + 1, yi + j + 1) + 32) >> 6;
                                assert_eq!(dst[j as usize * 16 + i as usize] as i32, want, "{w}x{h} at ({x},{y}) mv ({mvx},{mvy})");
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn weights() {
        let p0 = [100u8; 4];
        let p1 = [50u8; 4];
        let mut d = [0u8; 4];
        weight_uni(&p0, 4, 1, (2, 3, 0, 0, 1), &mut d, 4);
        assert_eq!(d, [103; 4]);
        weight_bi(&p0, &p1, 4, 1, (32, 0, 32, 0, 5), &mut d, 4);
        assert_eq!(d, [75; 4]);
        assert!(weights_are_default((32, 0, 32, 0, 5), true));
        assert!(!weights_are_default((31, 0, 33, 0, 5), true));
        assert!(weights_are_default((1, 0, 0, 0, 0), false));
        assert_eq!(dist_scale_factor(4, 0, 8), Some(128));
        assert_eq!(dist_scale_factor(4, 0, 0), None);
    }
}
