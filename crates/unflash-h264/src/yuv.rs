//! Colour conversion of decoded pictures.

use crate::picture::Picture;

/// Which YCbCr matrix a picture uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Matrix {
    Bt601,
    Bt709,
}

/// The matrix to use for a picture, from its VUI when present, else by the
/// picture height as players do.
pub fn matrix_for(vui_matrix: Option<u8>, height: u32) -> Matrix {
    match vui_matrix {
        Some(1) => Matrix::Bt709,
        Some(5) | Some(6) => Matrix::Bt601,
        _ => {
            if height > 576 {
                Matrix::Bt709
            } else {
                Matrix::Bt601
            }
        }
    }
}

/// Convert the cropped picture to RGBA8 (chroma samples repeated over their
/// 2x2 luma block). `crop` is (left, top, width, height) in luma samples.
pub fn to_rgba(pic: &Picture, crop: (usize, usize, usize, usize), matrix: Matrix, full_range: bool, out: &mut Vec<u8>) {
    let (cx, cy, w, h) = crop;
    out.clear();
    out.resize(w * h * 4, 255);
    // 16.16 fixed point coefficients
    let (ky, kr, kgu, kgv, kb, yoff) = match (matrix, full_range) {
        (Matrix::Bt709, false) => (76309, 117489, 13975, 34925, 138438, 16),
        (Matrix::Bt601, false) => (76309, 104597, 25675, 53279, 132201, 16),
        (Matrix::Bt709, true) => (65536, 103206, 12276, 30679, 121608, 0),
        (Matrix::Bt601, true) => (65536, 91881, 22553, 46802, 116129, 0),
    };
    let lw = pic.width;
    let cw = pic.width / 2;
    for y in 0..h {
        let yrow = &pic.y[(cy + y) * lw + cx..(cy + y) * lw + cx + w];
        let crow_off = ((cy + y) / 2) * cw;
        let orow = &mut out[y * w * 4..(y + 1) * w * 4];
        for x in 0..w {
            let ci = crow_off + (cx + x) / 2;
            let yy = (yrow[x] as i32 - yoff) * ky;
            let u = pic.u[ci] as i32 - 128;
            let v = pic.v[ci] as i32 - 128;
            let r = (yy + kr * v + 32768) >> 16;
            let g = (yy - kgu * u - kgv * v + 32768) >> 16;
            let b = (yy + kb * u + 32768) >> 16;
            orow[x * 4] = r.clamp(0, 255) as u8;
            orow[x * 4 + 1] = g.clamp(0, 255) as u8;
            orow[x * 4 + 2] = b.clamp(0, 255) as u8;
        }
    }
}

/// The cropped planes as packed I420 (Y, then Cb, then Cr), as ffmpeg's
/// rawvideo output lays them out.
pub fn to_i420(pic: &Picture, crop: (usize, usize, usize, usize), out: &mut Vec<u8>) {
    let (cx, cy, w, h) = crop;
    out.clear();
    let lw = pic.width;
    for y in 0..h {
        out.extend_from_slice(&pic.y[(cy + y) * lw + cx..(cy + y) * lw + cx + w]);
    }
    let cw = pic.width / 2;
    let (ccx, ccy, cwid, chei) = (cx / 2, cy / 2, w.div_ceil(2), h.div_ceil(2));
    for plane in [&pic.u, &pic.v] {
        for y in 0..chei {
            out.extend_from_slice(&plane[(ccy + y) * cw + ccx..(ccy + y) * cw + ccx + cwid]);
        }
    }
}
