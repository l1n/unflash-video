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
