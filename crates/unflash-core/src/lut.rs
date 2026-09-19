//! sRGB -> linear lookup and the per-pixel colour quantities.
//!
//! The table is computed in f64 and stored as f32, exactly as the reference
//! does, so the CPU kernels and the GPU (which is handed this same table as
//! a uniform) linearise identically.

/// sRGB 8-bit code value -> linear light, f32.
pub const fn srgb_lut() -> [f32; 256] {
    // const fn cannot use powf; build at first use instead.
    [0.0; 256]
}

static LUT: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();

/// The 256-entry sRGB linearisation table (f64 math, f32 storage).
pub fn lut() -> &'static [f32; 256] {
    LUT.get_or_init(|| {
        let mut t = [0f32; 256];
        for (c, slot) in t.iter_mut().enumerate() {
            let v = c as f64 / 255.0;
            let lin = if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
            *slot = lin as f32;
        }
        t
    })
}

/// Per-pixel colour quantities the detector tracks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PixelValues {
    /// Relative luminance, linear, 0..1.
    pub l: f32,
    /// Saturated-red value max(0, R-G-B) * 320.
    pub v: f32,
    /// R / (R+G+B) >= red_saturation (and the pixel is not black).
    pub sat: bool,
}

/// Compute L, V and the saturation flag from 8-bit sRGB. The arithmetic is
/// f32 in exactly the reference's order: numpy evaluates
/// `0.2126*R + 0.7152*G + 0.0722*B` left to right in float32.
#[inline]
pub fn pixel_values(r: u8, g: u8, b: u8, red_saturation: f32) -> PixelValues {
    let t = lut();
    let (r, g, b) = (t[r as usize], t[g as usize], t[b as usize]);
    let l = 0.2126f32 * r + 0.7152f32 * g + 0.0722f32 * b;
    let total = r + g + b;
    let sat = total > 1e-5 && r >= red_saturation * total;
    let v = (r - g - b).max(0.0) * 320.0;
    PixelValues { l, v, sat }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lut_endpoints() {
        let t = lut();
        assert_eq!(t[0], 0.0);
        assert_eq!(t[255], 1.0);
        assert!((t[128] - 0.2158605).abs() < 1e-6);
    }

    #[test]
    fn white_and_red() {
        let w = pixel_values(255, 255, 255, 0.8);
        assert!((w.l - 1.0).abs() < 1e-6);
        assert!(!w.sat);
        assert_eq!(w.v, 0.0);
        let r = pixel_values(255, 0, 0, 0.8);
        assert!(r.sat);
        assert!((r.v - 320.0).abs() < 1e-4);
        assert!((r.l - 0.2126).abs() < 1e-6);
        let k = pixel_values(0, 0, 0, 0.8);
        assert!(!k.sat);
    }
}
