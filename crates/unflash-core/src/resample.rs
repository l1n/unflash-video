//! Area-average downsampling of 8-bit sRGB pictures, the same box filter
//! the GPU ingest pass applies (fractional overlap weights in code space,
//! rounded back to 8 bits), for the CPU path.

/// Downsample an RGBA8 (or RGB8 with `bpp = 3`) picture of `sw`×`sh` to
/// `aw`×`ah` RGBA8. Alpha is set to 255.
pub fn area_downsample(src: &[u8], bpp: usize, sw: u32, sh: u32, aw: u32, ah: u32) -> Vec<u8> {
    let (sw, sh, aw, ah) = (sw as usize, sh as usize, aw as usize, ah as usize);
    assert!(src.len() >= sw * sh * bpp, "source too short");
    let mut out = vec![255u8; aw * ah * 4];
    if sw == aw && sh == ah {
        for i in 0..aw * ah {
            out[i * 4..i * 4 + 3].copy_from_slice(&src[i * bpp..i * bpp + 3]);
        }
        return out;
    }
    let fx = sw as f32 / aw as f32;
    let fy = sh as f32 / ah as f32;
    for y in 0..ah {
        let fy0 = y as f32 * fy;
        let fy1 = (y + 1) as f32 * fy;
        let iy0 = fy0.floor() as usize;
        let iy1 = (fy1.ceil() as usize).min(sh);
        for x in 0..aw {
            let fx0 = x as f32 * fx;
            let fx1 = (x + 1) as f32 * fx;
            let ix0 = fx0.floor() as usize;
            let ix1 = (fx1.ceil() as usize).min(sw);
            let mut acc = [0f32; 3];
            let mut wsum = 0f32;
            for sy in iy0..iy1 {
                let wy = fy1.min((sy + 1) as f32) - fy0.max(sy as f32);
                for sx in ix0..ix1 {
                    let wx = fx1.min((sx + 1) as f32) - fx0.max(sx as f32);
                    let w = wx * wy;
                    let p = &src[(sy * sw + sx) * bpp..];
                    acc[0] += p[0] as f32 / 255.0 * w;
                    acc[1] += p[1] as f32 / 255.0 * w;
                    acc[2] += p[2] as f32 / 255.0 * w;
                    wsum += w;
                }
            }
            let o = (y * aw + x) * 4;
            let inv = 1.0 / wsum.max(1e-9);
            for c in 0..3 {
                out[o + c] = (acc[c] * inv * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_and_halving() {
        let src: Vec<u8> = (0..4 * 4 * 3).map(|i| (i * 7 % 256) as u8).collect();
        let same = area_downsample(&src, 3, 4, 4, 4, 4);
        for i in 0..16 {
            assert_eq!(&same[i * 4..i * 4 + 3], &src[i * 3..i * 3 + 3]);
            assert_eq!(same[i * 4 + 3], 255);
        }
        // 2x2 blocks of 0 and 200 average to 100
        let mut src = vec![0u8; 4 * 4 * 4];
        for y in 0..4 {
            for x in 0..4 {
                if (x + y) % 2 == 0 {
                    let i = (y * 4 + x) * 4;
                    src[i] = 200;
                    src[i + 1] = 200;
                    src[i + 2] = 200;
                }
            }
        }
        let half = area_downsample(&src, 4, 4, 4, 2, 2);
        assert_eq!(half.len(), 16);
        assert!(half.iter().step_by(4).all(|&v| v == 100));
        // fractional boxes: 3 -> 2 columns, weights 1.5 each
        let src: Vec<u8> = vec![0, 0, 0, 90, 90, 90, 180, 180, 180];
        let out = area_downsample(&src, 3, 3, 1, 2, 1);
        // left box covers px0 (w1) + half of px1 (w0.5): (0*1 + 90*0.5)/1.5 = 30
        assert_eq!(out[0], 30);
        assert_eq!(out[4], 150);
    }
}

/// Three-pass box blur of an RGBA8 picture (close to a Gaussian of
/// σ ≈ 0.9·radius, edges replicated), for softening a regular pattern.
/// `radius` 0 copies. The output is written to `dst`.
pub fn blur_rgba(src: &[u8], w: u32, h: u32, radius: u32, dst: &mut Vec<u8>) {
    blur_px::<4>(src, w, h, radius, dst)
}

/// The same blur of an RGB8 picture (three bytes per pixel).
pub fn blur_rgb(src: &[u8], w: u32, h: u32, radius: u32, dst: &mut Vec<u8>) {
    blur_px::<3>(src, w, h, radius, dst)
}

/// The blur over `C` interleaved 8-bit channels.
pub fn blur_px<const C: usize>(src: &[u8], w: u32, h: u32, radius: u32, dst: &mut Vec<u8>) {
    let (w, h) = (w as usize, h as usize);
    let n = w * h * C;
    dst.clear();
    dst.extend_from_slice(&src[..n]);
    if radius == 0 || w == 0 || h == 0 {
        return;
    }
    let r = radius as usize;
    let mut tmp = vec![0u8; n];
    let mut line: Vec<[u32; C]> = Vec::with_capacity(w.max(h));
    for _ in 0..3 {
        box_pass::<C>(dst, &mut tmp, w, h, r, true, &mut line);
        box_pass::<C>(&tmp, dst, w, h, r, false, &mut line);
    }
}

/// One box pass along rows (`horizontal`) or columns.
fn box_pass<const C: usize>(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, horizontal: bool, line: &mut Vec<[u32; C]>) {
    let (lines, len) = if horizontal { (h, w) } else { (w, h) };
    let win = (2 * r + 1) as u32;
    let half = win / 2;
    for l in 0..lines {
        let at = |i: usize| -> usize {
            if horizontal {
                (l * w + i) * C
            } else {
                (i * w + l) * C
            }
        };
        line.clear();
        for i in 0..len {
            let k = at(i);
            let mut px = [0u32; C];
            for c in 0..C {
                px[c] = src[k + c] as u32;
            }
            line.push(px);
        }
        let clamp = |i: isize| -> [u32; C] { line[i.clamp(0, len as isize - 1) as usize] };
        let mut sum = [0u32; C];
        for k in -(r as isize)..=(r as isize) {
            let v = clamp(k);
            for c in 0..C {
                sum[c] += v[c];
            }
        }
        for i in 0..len {
            let k = at(i);
            for c in 0..C {
                dst[k + c] = ((sum[c] + half) / win) as u8;
            }
            let add = clamp(i as isize + r as isize + 1);
            let sub = clamp(i as isize - r as isize);
            for c in 0..C {
                sum[c] = sum[c] + add[c] - sub[c];
            }
        }
    }
}

#[cfg(test)]
mod blur_tests {
    use super::*;

    #[test]
    fn blur_keeps_flat_pictures_and_flattens_stripes() {
        let (w, h) = (32u32, 8u32);
        let flat = vec![100u8; (w * h * 4) as usize];
        let mut out = Vec::new();
        blur_rgba(&flat, w, h, 3, &mut out);
        assert_eq!(out, flat);
        let mut stripes = vec![255u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let v = if (x / 3) % 2 == 0 { 20 } else { 200 };
                let k = ((y * w + x) * 4) as usize;
                stripes[k] = v;
                stripes[k + 1] = v;
                stripes[k + 2] = v;
            }
        }
        blur_rgba(&stripes, w, h, 3, &mut out);
        let row: Vec<u8> = (0..w).map(|x| out[(x * 4) as usize]).collect();
        let (lo, hi) = (row[4..28].iter().min().unwrap(), row[4..28].iter().max().unwrap());
        assert!(hi - lo < 20, "stripes should flatten: {row:?}");
        assert!(out.iter().skip(3).step_by(4).all(|&a| a == 255), "alpha is untouched");
        blur_rgba(&stripes, w, h, 0, &mut out);
        assert_eq!(out, stripes);
    }
}
