//! Inter prediction sample interpolation (8.4.2.2) and weighted sample
//! prediction (8.4.2.3).

#[inline(always)]
fn clip(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

#[inline(always)]
fn tap(a: i32, b: i32, c: i32, d: i32, e: i32, f: i32) -> i32 {
    a - 5 * b + 20 * c + 20 * d - 5 * e + f
}

/// Quarter-sample luma prediction of a `w`×`h` block whose top-left luma
/// sample is at (`x`, `y`) in the picture, displaced by (`mvx`, `mvy`) in
/// quarter samples. `dst` has stride `w`.
pub fn mc_luma(plane: &[u8], pw: usize, ph: usize, x: i32, y: i32, mvx: i32, mvy: i32, w: usize, h: usize, dst: &mut [u8]) {
    let xi = x + (mvx >> 2);
    let yi = y + (mvy >> 2);
    let xf = (mvx & 3) as usize;
    let yf = (mvy & 3) as usize;
    let ww = w + 6;
    let hh = h + 6;
    // the source window with two samples of margin (edge-replicated)
    let mut win = [0i32; 22 * 22];
    let fast = xi >= 2 && yi >= 2 && (xi as usize) + w + 4 <= pw && (yi as usize) + h + 4 <= ph;
    for j in 0..hh {
        let sy = (yi + j as i32 - 2).clamp(0, ph as i32 - 1) as usize;
        let row = &plane[sy * pw..sy * pw + pw];
        if fast {
            let sx = (xi - 2) as usize;
            for i in 0..ww {
                win[j * ww + i] = row[sx + i] as i32;
            }
        } else {
            for i in 0..ww {
                let sx = (xi + i as i32 - 2).clamp(0, pw as i32 - 1) as usize;
                win[j * ww + i] = row[sx] as i32;
            }
        }
    }
    let g = |i: usize, j: usize| win[(j + 2) * ww + i + 2];
    if xf == 0 && yf == 0 {
        for j in 0..h {
            for i in 0..w {
                dst[j * w + i] = g(i, j) as u8;
            }
        }
        return;
    }
    // horizontal half samples b1 (unclipped) for rows -2..h+3 and columns 0..=w
    let bw = w + 1;
    let mut b1 = [0i32; 22 * 17];
    for j in 0..hh {
        for i in 0..bw {
            let r = &win[j * ww + i..j * ww + i + 6];
            b1[j * bw + i] = tap(r[0], r[1], r[2], r[3], r[4], r[5]);
        }
    }
    let b = |i: usize, j: usize| -> i32 { clip((b1[(j + 2) * bw + i] + 16) >> 5) as i32 };
    // vertical half samples h for rows 0..h and columns 0..=w
    let hv = |i: usize, j: usize| -> i32 {
        let c = |k: usize| win[(j + k) * ww + i + 2];
        clip((tap(c(0), c(1), c(2), c(3), c(4), c(5)) + 16) >> 5) as i32
    };
    // centre samples j from the unclipped b1
    let jv = |i: usize, j: usize| -> i32 {
        let c = |k: usize| b1[(j + k) * bw + i];
        clip((tap(c(0), c(1), c(2), c(3), c(4), c(5)) + 512) >> 10) as i32
    };
    let avg = |p: i32, q: i32| ((p + q + 1) >> 1) as u8;
    for j in 0..h {
        for i in 0..w {
            let v = match (xf, yf) {
                (1, 0) => avg(g(i, j), b(i, j)),
                (2, 0) => b(i, j) as u8,
                (3, 0) => avg(b(i, j), g(i + 1, j)),
                (0, 1) => avg(g(i, j), hv(i, j)),
                (0, 2) => hv(i, j) as u8,
                (0, 3) => avg(hv(i, j), g(i, j + 1)),
                (2, 2) => jv(i, j) as u8,
                (2, 1) => avg(b(i, j), jv(i, j)),
                (2, 3) => avg(jv(i, j), b(i, j + 1)),
                (1, 2) => avg(hv(i, j), jv(i, j)),
                (3, 2) => avg(jv(i, j), hv(i + 1, j)),
                (1, 1) => avg(b(i, j), hv(i, j)),
                (3, 1) => avg(b(i, j), hv(i + 1, j)),
                (1, 3) => avg(hv(i, j), b(i, j + 1)),
                _ => avg(hv(i + 1, j), b(i, j + 1)), // (3, 3)
            };
            dst[j * w + i] = v;
        }
    }
}

/// Eighth-sample chroma prediction (4:2:0): block at chroma position
/// (`x`, `y`) of size `w`×`h`, motion vector in eighth chroma samples.
pub fn mc_chroma(plane: &[u8], pw: usize, ph: usize, x: i32, y: i32, mvx: i32, mvy: i32, w: usize, h: usize, dst: &mut [u8]) {
    let xi = x + (mvx >> 3);
    let yi = y + (mvy >> 3);
    let xf = mvx & 7;
    let yf = mvy & 7;
    let w00 = (8 - xf) * (8 - yf);
    let w10 = xf * (8 - yf);
    let w01 = (8 - xf) * yf;
    let w11 = xf * yf;
    for j in 0..h {
        let y0 = (yi + j as i32).clamp(0, ph as i32 - 1) as usize;
        let y1 = (yi + j as i32 + 1).clamp(0, ph as i32 - 1) as usize;
        for i in 0..w {
            let x0 = (xi + i as i32).clamp(0, pw as i32 - 1) as usize;
            let x1 = (xi + i as i32 + 1).clamp(0, pw as i32 - 1) as usize;
            let a = plane[y0 * pw + x0] as i32;
            let b = plane[y0 * pw + x1] as i32;
            let c = plane[y1 * pw + x0] as i32;
            let d = plane[y1 * pw + x1] as i32;
            dst[j * w + i] = ((w00 * a + w10 * b + w01 * c + w11 * d + 32) >> 6) as u8;
        }
    }
}

/// 8.4.2.3: combine the predictions of one block. `p1` is None for a
/// single-direction block. Explicit weights are (w, o) per list with the
/// shared logWD; `weights` None means the default (unweighted) process.
pub fn weight(p0: &[u8], p1: Option<&[u8]>, weights: Option<(i32, i32, i32, i32, i32)>, dst: &mut [u8]) {
    let n = p0.len();
    match (p1, weights) {
        (None, None) => dst[..n].copy_from_slice(p0),
        (Some(q), None) => {
            for i in 0..n {
                dst[i] = ((p0[i] as i32 + q[i] as i32 + 1) >> 1) as u8;
            }
        }
        (None, Some((w0, o0, _, _, log_wd))) => {
            if log_wd >= 1 {
                let round = 1 << (log_wd - 1);
                for i in 0..n {
                    dst[i] = clip(((p0[i] as i32 * w0 + round) >> log_wd) + o0);
                }
            } else {
                for i in 0..n {
                    dst[i] = clip(p0[i] as i32 * w0 + o0);
                }
            }
        }
        (Some(q), Some((w0, o0, w1, o1, log_wd))) => {
            let round = 1 << log_wd;
            let o = (o0 + o1 + 1) >> 1;
            for i in 0..n {
                dst[i] = clip(((p0[i] as i32 * w0 + q[i] as i32 * w1 + round) >> (log_wd + 1)) + o);
            }
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

    #[test]
    fn full_and_half_sample_luma() {
        // a horizontal ramp: half-sample positions interpolate exactly
        let (pw, ph) = (32usize, 8usize);
        let plane: Vec<u8> = (0..pw * ph).map(|i| ((i % pw) * 4) as u8).collect();
        let mut dst = [0u8; 16];
        mc_luma(&plane, pw, ph, 8, 2, 0, 0, 4, 4, &mut dst);
        assert_eq!(&dst[..4], &[32, 36, 40, 44]);
        mc_luma(&plane, pw, ph, 8, 2, 2, 0, 4, 4, &mut dst);
        assert_eq!(&dst[..4], &[34, 38, 42, 46]);
        mc_luma(&plane, pw, ph, 8, 2, 1, 0, 4, 4, &mut dst);
        assert_eq!(&dst[..4], &[33, 37, 41, 45]);
        // vertical motion on a horizontal ramp changes nothing
        mc_luma(&plane, pw, ph, 8, 2, 0, 6, 4, 4, &mut dst);
        assert_eq!(&dst[..4], &[32, 36, 40, 44]);
        // edge replication outside the picture
        mc_luma(&plane, pw, ph, -20, -20, 0, 0, 4, 4, &mut dst);
        assert!(dst.iter().all(|&v| v == 0));
    }

    #[test]
    fn chroma_bilinear() {
        let (pw, ph) = (8usize, 8usize);
        let plane: Vec<u8> = (0..pw * ph).map(|i| ((i % pw) * 8) as u8).collect();
        let mut dst = [0u8; 4];
        mc_chroma(&plane, pw, ph, 2, 2, 4, 0, 2, 2, &mut dst);
        assert_eq!(&dst[..2], &[20, 28]);
    }

    #[test]
    fn weights() {
        let p0 = [100u8; 4];
        let p1 = [50u8; 4];
        let mut d = [0u8; 4];
        weight(&p0, Some(&p1), None, &mut d);
        assert_eq!(d, [75; 4]);
        weight(&p0, None, Some((2, 3, 0, 0, 1)), &mut d);
        assert_eq!(d, [103; 4]);
        weight(&p0, Some(&p1), Some((32, 0, 32, 0, 5)), &mut d);
        assert_eq!(d, [75; 4]);
        assert_eq!(dist_scale_factor(4, 0, 8), Some(128));
        assert_eq!(dist_scale_factor(4, 0, 0), None);
    }
}
