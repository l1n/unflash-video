//! What Unflash's built-in video decoders share: the picture HEVC, VP9,
//! VP8 and AV1 each hand out ([`Frame`]), the trait the bindings and the
//! tests drive them through ([`VideoDecoder`]), the guess at the colour
//! matrix of a stream that names none ([`bt709_by_height`]), and the bit
//! reader of the two NAL-unit codecs, H.264 and HEVC ([`bits`]). Each
//! decoder used to state these for itself, in the same words; the bindings
//! then turned four like structs into a fifth.
//!
//! (H.264's decoder hands out its own reference-counted picture with a
//! cropping rectangle instead, to spare the main module a copy of every
//! picture: it is driven on its own, in `unflash-wasm`.)

pub mod bits;

/// A decoded picture, cropped to what is shown.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    /// The size shown, which may be odd.
    pub width: u32,
    pub height: u32,
    /// 8-bit 4:2:0 planes, tightly packed; chroma is (width + 1) / 2 by
    /// (height + 1) / 2 (grey where the stream has none). Deeper samples
    /// are rounded: (v + (1 << (depth - 9))) >> (depth - 8).
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
    /// The stream's bit depth.
    pub bit_depth: u8,
    /// The planes at full precision, when the stream is deeper than 8 bits
    /// and the decoder was asked to keep them (`set_keep_deep`, on the
    /// decoders that have it: the tests compare them with ffmpeg's).
    pub y16: Option<Vec<u16>>,
    pub u16: Option<Vec<u16>>,
    pub v16: Option<Vec<u16>>,
    /// The timestamp of the sample that showed the picture, as `decode` was
    /// given it.
    pub pts: f64,
    /// Part of it could not be decoded (and is concealed), or it was
    /// predicted from such a picture.
    pub damaged: bool,
    /// The colour matrix is BT.709, else BT.601: what the stream says, or
    /// where it says nothing, [`bt709_by_height`].
    pub bt709: bool,
    /// Full-range samples (else limited: 16 to 235).
    pub full_range: bool,
}

impl Frame {
    /// The size of each chroma plane.
    pub fn chroma_size(&self) -> (usize, usize) {
        ((self.width as usize).div_ceil(2), (self.height as usize).div_ceil(2))
    }

    /// The 8-bit planes one after the other (Y, then Cb, then Cr, no
    /// padding) into `out`: packed I420, as ffmpeg's rawvideo and a
    /// WebCodecs `VideoFrame` take it.
    pub fn pack_i420(&self, out: &mut Vec<u8>) {
        let (w, h) = (self.width as usize, self.height as usize);
        let (cw, ch) = self.chroma_size();
        out.clear();
        out.reserve(w * h + 2 * cw * ch);
        out.extend_from_slice(&self.y[..w * h]);
        out.extend_from_slice(&self.u[..cw * ch]);
        out.extend_from_slice(&self.v[..cw * ch]);
    }
}

/// A decoder of one video stream, sample by sample.
pub trait VideoDecoder: Sized {
    /// Why a stream or a sample could not be decoded.
    type Error: std::error::Error + 'static;

    /// A decoder for a track with this configuration record (hvcC, vpcC,
    /// av1C or Matroska's CodecPrivate; it may be empty).
    fn open(config: &[u8]) -> Result<Self, Self::Error>;

    /// Decode one sample (an MP4 sample, a Matroska block, an IVF frame):
    /// the pictures it completes, each with the `pts` of the sample that
    /// showed it.
    fn decode(&mut self, sample: &[u8], pts: f64) -> Result<Vec<Frame>, Self::Error>;

    /// The pictures still held at the end of the stream.
    fn flush(&mut self) -> Result<Vec<Frame>, Self::Error>;

    /// How many pictures may come out before one shown earlier (a caller
    /// holds that many back to hand them on in the order they are shown).
    /// None, for the decoders whose pictures come in that order already.
    fn reorder_depth(&self) -> u32 {
        0
    }
}

/// Whether a picture of `height` lines whose stream does not name its
/// colour matrix is taken as BT.709: above 576 lines (past PAL's), as
/// players guess. Every decoder here and `web/media.js` (`yuvLayoutWords`)
/// go by this one rule, so a picture is the same colours whoever decodes
/// it.
pub fn bt709_by_height(height: u32) -> bool {
    height > 576
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_definition_ends_at_576_lines() {
        for (lines, hd) in [(240, false), (480, false), (576, false), (577, true), (720, true), (1080, true), (2160, true)] {
            assert_eq!(bt709_by_height(lines), hd, "{lines} lines");
        }
    }

    #[test]
    fn an_odd_sized_picture_packs_with_its_chroma_rounded_up() {
        let f = Frame { width: 5, height: 3, y: (0..15).collect(), u: (100..106).collect(), v: (200..206).collect(), bit_depth: 8, y16: None, u16: None, v16: None, pts: 0.0, damaged: false, bt709: false, full_range: false };
        assert_eq!(f.chroma_size(), (3, 2));
        let mut out = vec![9; 4];
        f.pack_i420(&mut out);
        assert_eq!(out.len(), 15 + 6 + 6);
        assert_eq!(&out[..3], &[0, 1, 2]);
        assert_eq!(&out[15..17], &[100, 101]);
        assert_eq!(&out[21..], &[200, 201, 202, 203, 204, 205]);
    }
}
