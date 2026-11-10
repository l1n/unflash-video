//! H.264 and HEVC as Annex B byte streams (as a transport stream carries
//! them): the few fields of their parameter sets and slice headers a
//! container needs (the picture size, the profile and level for the codec
//! string, the bit depths, where a picture and a field pair begin), and the
//! decoder setup records (avcC, hvcC) built from the parameter sets.

// (the RBSP of a NAL unit: its emulation prevention bytes taken out, as the decoders take them)
pub use unflash_codec::bits::unescape as rbsp;

use crate::reader::Bits;

/// The most macroblocks a side an H.264 parameter set may claim here, and
/// (times sixteen) the most samples a side an HEVC one may: enough for any
/// level of either, and small enough that the arithmetic on a hostile
/// stream's sizes cannot overflow.
const MAX_MBS: u32 = 1 << 16;

/// What an H.264 sequence parameter set says that a container needs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AvcSps {
    pub id: u32,
    pub profile: u8,
    pub chroma_format: u32,
    pub bit_depth_luma: u32,
    pub bit_depth_chroma: u32,
    /// The picture size after cropping.
    pub width: u32,
    pub height: u32,
    pub log2_max_frame_num: u32,
    pub frame_mbs_only: bool,
    pub separate_colour_plane: bool,
}

fn skip_scaling_list(b: &mut Bits, size: usize) -> Option<()> {
    let (mut last, mut next) = (8i32, 8i32);
    for _ in 0..size {
        if next != 0 {
            next = (last + b.se()? + 256).rem_euclid(256);
        }
        if next != 0 {
            last = next;
        }
    }
    Some(())
}

/// An H.264 SPS NAL unit (its header byte first).
pub fn parse_avc_sps(nal: &[u8]) -> Option<AvcSps> {
    let r = rbsp(nal.get(1..)?);
    let mut b = Bits::new(&r);
    let profile = b.u(8)? as u8;
    // (the constraint flags and the level: an avcC copies them from the SPS's bytes)
    b.skip(16)?;
    let id = b.ue()?;
    let (mut chroma, mut separate, mut depth_luma, mut depth_chroma) = (1, false, 8, 8);
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
        // (each value within what the standard lets it be: 7.4.2.1.1)
        chroma = b.ue_max(3)?;
        if chroma == 3 {
            separate = b.flag()?;
        }
        depth_luma = 8 + b.ue_max(6)?;
        depth_chroma = 8 + b.ue_max(6)?;
        b.flag()?; // qpprime_y_zero_transform_bypass
        if b.flag()? {
            for i in 0..(if chroma != 3 { 8 } else { 12 }) {
                if b.flag()? {
                    skip_scaling_list(&mut b, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    let log2_max_frame_num = b.ue_max(12)? + 4;
    match b.ue()? {
        0 => {
            b.ue()?;
        }
        1 => {
            b.flag()?;
            b.se()?;
            b.se()?;
            for _ in 0..b.ue()? {
                b.se()?;
            }
        }
        _ => {}
    }
    b.ue()?; // max_num_ref_frames
    b.flag()?; // gaps_in_frame_num_value_allowed
    // (a picture of 65 536 macroblocks a side at most: far past any level,
    // and its size in samples still a number)
    let width_mbs = b.ue_max(MAX_MBS - 1)? + 1;
    let height_units = b.ue_max(MAX_MBS - 1)? + 1;
    let frame_mbs_only = b.flag()?;
    if !frame_mbs_only {
        b.flag()?; // mb_adaptive_frame_field
    }
    b.flag()?; // direct_8x8_inference
    let mut crop = [0u32; 4];
    if b.flag()? {
        for c in &mut crop {
            // (no more is cropped than there is)
            *c = b.ue_max(MAX_MBS * 32)?;
        }
    }
    // the crop's units: chroma samples, and field pairs' rows
    let (sub_w, sub_h) = match (chroma, separate) {
        (1, _) => (2, 2),
        (2, _) => (2, 1),
        _ => (1, 1),
    };
    let fields = 2 - frame_mbs_only as u32;
    let width = (width_mbs * 16).saturating_sub(sub_w * (crop[0] + crop[1]));
    let height = (fields * height_units * 16).saturating_sub(sub_h * fields * (crop[2] + crop[3]));
    Some(AvcSps { id, profile, chroma_format: chroma, bit_depth_luma: depth_luma, bit_depth_chroma: depth_chroma, width, height, log2_max_frame_num, frame_mbs_only, separate_colour_plane: separate })
}

/// (pps id, sps id) of an H.264 PPS NAL unit.
pub fn avc_pps_ids(nal: &[u8]) -> Option<(u32, u32)> {
    let r = rbsp(nal.get(1..)?);
    let mut b = Bits::new(&r);
    Some((b.ue()?, b.ue()?))
}

/// The start of an H.264 slice header, as far as a container cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AvcSlice {
    pub frame_num: u32,
    /// A field picture: Some(bottom).
    pub field: Option<bool>,
}

/// The head of an H.264 slice NAL unit (types 1 and 5), the SPS it uses
/// given by `sps_for(pps_id)`.
pub fn avc_slice(nal: &[u8], sps_for: impl Fn(u32) -> Option<AvcSps>) -> Option<AvcSlice> {
    let r = rbsp(nal.get(1..)?);
    let mut b = Bits::new(&r);
    b.ue()?; // first_mb_in_slice
    b.ue()?; // slice_type
    let pps_id = b.ue()?;
    let sps = sps_for(pps_id)?;
    if sps.separate_colour_plane {
        b.u(2)?;
    }
    let frame_num = b.u(sps.log2_max_frame_num as usize)?;
    let field = if !sps.frame_mbs_only && b.flag()? { Some(b.flag()?) } else { None };
    Some(AvcSlice { frame_num, field })
}

/// Whether an H.264 SEI NAL unit holds a recovery point (a picture that
/// decoding can start at, as an IDR is).
pub fn avc_sei_recovery_point(nal: &[u8]) -> bool {
    let Some(body) = nal.get(1..) else { return false };
    let r = rbsp(body);
    let mut i = 0;
    let read = |i: &mut usize| -> Option<usize> {
        let mut v = 0usize;
        loop {
            let c = *r.get(*i)?;
            *i += 1;
            v += c as usize;
            if c != 0xff {
                return Some(v);
            }
        }
    };
    // (the trailing bits: a lone 0x80)
    while i + 1 < r.len() {
        let (Some(kind), Some(size)) = (read(&mut i), read(&mut i)) else { return false };
        if kind == 6 {
            return true;
        }
        i += size;
    }
    false
}

/// An AVCDecoderConfigurationRecord (avcC) for the parameter sets, the first
/// SPS's fields in its head; lengths of 4 bytes.
pub fn avcc(sps: &[&[u8]], pps: &[&[u8]], info: &AvcSps) -> Vec<u8> {
    let s0 = sps.first().copied().unwrap_or(&[]);
    let at = |i: usize| s0.get(i).copied().unwrap_or(0);
    let mut v = vec![1, at(1), at(2), at(3), 0xff, 0xe0 | sps.len().min(31) as u8];
    for s in sps.iter().take(31) {
        v.extend_from_slice(&(s.len() as u16).to_be_bytes());
        v.extend_from_slice(s);
    }
    v.push(pps.len().min(255) as u8);
    for p in pps.iter().take(255) {
        v.extend_from_slice(&(p.len() as u16).to_be_bytes());
        v.extend_from_slice(p);
    }
    if matches!(info.profile, 100 | 110 | 122 | 144) {
        v.push(0xfc | info.chroma_format as u8);
        v.push(0xf8 | info.bit_depth_luma.saturating_sub(8) as u8);
        v.push(0xf8 | info.bit_depth_chroma.saturating_sub(8) as u8);
        v.push(0);
    }
    v
}

/// An avcC for one SPS and one PPS (NAL units, each with its header byte),
/// with the chroma format and bit depths a High profile's record carries
/// after the sets; None when they are not an SPS and a PPS, or the SPS
/// can't be read.
pub fn avcc_record(sps: &[u8], pps: &[u8]) -> Option<Vec<u8>> {
    if sps.first()? & 0x1f != 7 || pps.first()? & 0x1f != 8 {
        return None;
    }
    let info = parse_avc_sps(sps)?;
    Some(avcc(&[sps], &[pps], &info))
}

/// What an HEVC sequence parameter set says that a container needs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HevcSps {
    /// The general profile_tier_level: profile space, tier and profile; the
    /// compatibility flags; the constraint flags; the level.
    pub ptl: [u8; 12],
    pub max_sub_layers: u32,
    pub temporal_id_nesting: bool,
    pub chroma_format: u32,
    pub bit_depth_luma: u32,
    pub bit_depth_chroma: u32,
    pub width: u32,
    pub height: u32,
}

/// An HEVC SPS NAL unit (its two header bytes first).
pub fn parse_hevc_sps(nal: &[u8]) -> Option<HevcSps> {
    let r = rbsp(nal.get(2..)?);
    let mut b = Bits::new(&r);
    b.u(4)?; // sps_video_parameter_set_id
    let sub_layers_minus1 = b.u(3)?;
    let nesting = b.flag()?;
    let mut ptl = [0u8; 12];
    for p in &mut ptl {
        *p = b.u(8)? as u8;
    }
    let mut present = Vec::new();
    for _ in 0..sub_layers_minus1 {
        present.push((b.flag()?, b.flag()?));
    }
    if sub_layers_minus1 > 0 {
        for _ in sub_layers_minus1..8 {
            b.u(2)?;
        }
    }
    for (profile, level) in present {
        if profile {
            b.skip(88)?;
        }
        if level {
            b.skip(8)?;
        }
    }
    b.ue()?; // sps_seq_parameter_set_id
    // (each value within what the standard lets it be: 7.4.3.2.1)
    let chroma = b.ue_max(3)?;
    if chroma == 3 {
        b.flag()?;
    }
    let w = b.ue_max(MAX_MBS * 16)?;
    let h = b.ue_max(MAX_MBS * 16)?;
    let mut crop = [0u32; 4];
    if b.flag()? {
        for c in &mut crop {
            *c = b.ue_max(MAX_MBS * 16)?;
        }
    }
    let depth_luma = 8 + b.ue_max(8)?;
    let depth_chroma = 8 + b.ue_max(8)?;
    let (sub_w, sub_h) = match chroma {
        1 => (2, 2),
        2 => (2, 1),
        _ => (1, 1),
    };
    Some(HevcSps {
        ptl,
        max_sub_layers: sub_layers_minus1 + 1,
        temporal_id_nesting: nesting,
        chroma_format: chroma,
        bit_depth_luma: depth_luma,
        bit_depth_chroma: depth_chroma,
        width: w.saturating_sub(sub_w * (crop[0] + crop[1])),
        height: h.saturating_sub(sub_h * (crop[2] + crop[3])),
    })
}

/// An HEVCDecoderConfigurationRecord (hvcC) for the parameter sets, the
/// SPS's fields in its head; lengths of 4 bytes. The sets may come again
/// in the stream (`hev1`), so the arrays are not marked complete.
pub fn hvcc(vps: &[&[u8]], sps: &[&[u8]], pps: &[&[u8]], info: &HevcSps) -> Vec<u8> {
    let mut v = vec![1];
    v.extend_from_slice(&info.ptl);
    v.extend_from_slice(&[0xf0, 0x00, 0xfc]);
    v.push(0xfc | info.chroma_format as u8);
    v.push(0xf8 | info.bit_depth_luma.saturating_sub(8) as u8);
    v.push(0xf8 | info.bit_depth_chroma.saturating_sub(8) as u8);
    v.extend_from_slice(&[0, 0]);
    v.push(((info.max_sub_layers.min(7) as u8) << 3) | ((info.temporal_id_nesting as u8) << 2) | 3);
    let arrays: Vec<(u8, &[&[u8]])> = [(32u8, vps), (33, sps), (34, pps)].into_iter().filter(|(_, a)| !a.is_empty()).collect();
    v.push(arrays.len() as u8);
    for (kind, nals) in arrays {
        v.push(kind);
        v.extend_from_slice(&(nals.len() as u16).to_be_bytes());
        for n in nals {
            v.extend_from_slice(&(n.len() as u16).to_be_bytes());
            v.extend_from_slice(n);
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emulation_prevention() {
        assert_eq!(rbsp(&[0, 0, 3, 1, 0, 0, 3, 0, 0, 3]), vec![0, 0, 1, 0, 0, 0, 0]);
    }

    #[test]
    fn avc_sps_fields() {
        // x264, High 4:2:0 8-bit, 1920x1080 (1088 coded, cropped by 8)
        let sps = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8, 0x3c, 0x60, 0xc6, 0x58];
        let s = parse_avc_sps(&sps).unwrap();
        assert_eq!((s.profile, s.width, s.height, s.chroma_format, s.bit_depth_luma, s.frame_mbs_only), (100, 1920, 1080, 1, 8, true));
        let rec = avcc(&[&sps], &[&[0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]], &s);
        assert_eq!(&rec[..6], &[1, 0x64, 0x00, 0x28, 0xff, 0xe1]);
        assert_eq!(&rec[rec.len() - 4..], &[0xfd, 0xf8, 0xf8, 0]);
        assert_eq!(crate::codec::avc_codec(&rec).unwrap().codec, "avc1.640028");
        // interlaced (field pairs: 68 map units of 16 rows each field)
        let sps = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x04, 0x4f, 0xde, 0x02, 0x20, 0x00, 0x00, 0x03, 0x00, 0x20, 0x00, 0x00, 0x06, 0x43, 0xe2, 0xc5, 0xb2, 0xc0];
        let s = parse_avc_sps(&sps).unwrap();
        assert_eq!((s.width, s.height, s.frame_mbs_only), (1920, 1080, false));
        // Constrained Baseline
        let sps = [0x67, 0x42, 0xc0, 0x28, 0xda, 0x01, 0xe0, 0x08, 0x9f, 0x97, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0x20, 0xf1, 0x83, 0x2a];
        let s = parse_avc_sps(&sps).unwrap();
        assert_eq!((s.profile, s.width, s.height), (66, 1920, 1080));
        assert_eq!(avcc(&[&sps], &[&[0x68, 0xce, 0x0f, 0xc8]], &s).len(), 6 + 2 + sps.len() + 1 + 2 + 4);
    }

    /// A parameter set written bit by bit, to say what no encoder would.
    #[derive(Default)]
    struct Written {
        bits: Vec<bool>,
    }

    impl Written {
        fn u(&mut self, n: u32, v: u64) -> &mut Self {
            for i in (0..n).rev() {
                self.bits.push((v >> i) & 1 == 1);
            }
            self
        }
        fn ue(&mut self, v: u64) -> &mut Self {
            let x = v + 1;
            let n = 64 - x.leading_zeros();
            self.u(n - 1, 0).u(n, x)
        }
        /// The NAL unit: `header`, the bits and their stop bit, emulation
        /// prevention bytes put in where two zeros would be followed by a
        /// byte under four.
        fn nal(&self, header: &[u8]) -> Vec<u8> {
            let mut bits = self.bits.clone();
            bits.push(true);
            let mut out = header.to_vec();
            let mut zeros = 0;
            for chunk in bits.chunks(8) {
                let byte = chunk.iter().enumerate().fold(0u8, |b, (i, &on)| b | ((on as u8) << (7 - i)));
                if zeros >= 2 && byte <= 3 {
                    out.push(3);
                    zeros = 0;
                }
                out.push(byte);
                zeros = if byte == 0 { zeros + 1 } else { 0 };
            }
            out
        }
    }

    /// A Baseline H.264 SPS of `width` by `height` macroblocks, its
    /// log2_max_frame_num_minus4 and its four crop values as given.
    fn avc_sps(log2_frame_num: u64, width: u64, height: u64, crop: Option<[u64; 4]>) -> Vec<u8> {
        let mut w = Written::default();
        // profile 66, no constraint flags, level 3.0; sps id 0
        w.u(8, 66).u(8, 0).u(8, 30).ue(0);
        // frame numbers; picture order count type 2; one reference frame; no gaps
        w.ue(log2_frame_num).ue(2).ue(1).u(1, 0);
        w.ue(width - 1).ue(height - 1);
        // frames only; direct 8x8 inference
        w.u(1, 1).u(1, 1);
        match crop {
            Some(c) => {
                w.u(1, 1);
                for v in c {
                    w.ue(v);
                }
            }
            None => {
                w.u(1, 0);
            }
        }
        // no VUI
        w.u(1, 0);
        w.nal(&[0x67])
    }

    #[test]
    fn a_parameter_set_that_claims_the_impossible_is_none() {
        // (what is written here reads back: 20 by 15 macroblocks, 8 rows of chroma cropped)
        let s = parse_avc_sps(&avc_sps(0, 20, 15, None)).unwrap();
        assert_eq!((s.profile, s.width, s.height, s.log2_max_frame_num, s.frame_mbs_only), (66, 320, 240, 4, true));
        assert_eq!(parse_avc_sps(&avc_sps(12, 20, 15, Some([0, 0, 0, 4]))).map(|s| (s.width, s.height, s.log2_max_frame_num)), Some((320, 232, 16)));
        // sizes that are no picture's: in a build that checks its arithmetic these
        // overflowed (a panic, which in the page is the end of it); in one that does
        // not, they came out as some other size
        let huge = u32::MAX as u64 - 1;
        assert_eq!(parse_avc_sps(&avc_sps(0, huge + 1, 15, None)), None);
        assert_eq!(parse_avc_sps(&avc_sps(0, 20, huge + 1, None)), None);
        assert_eq!(parse_avc_sps(&avc_sps(0, 1 << 16, 1 << 16, None)).map(|s| (s.width, s.height)), Some((1 << 20, 1 << 20)));
        assert_eq!(parse_avc_sps(&avc_sps(0, (1 << 16) + 1, 15, None)), None);
        assert_eq!(parse_avc_sps(&avc_sps(13, 20, 15, None)), None);
        assert_eq!(parse_avc_sps(&avc_sps(huge, 20, 15, None)), None);
        assert_eq!(parse_avc_sps(&avc_sps(0, 20, 15, Some([huge, huge, 0, 0]))), None);
        assert_eq!(parse_avc_sps(&avc_sps(0, 20, 15, Some([0, 0, huge, huge]))), None);
        // more cropped than there is: nothing left, not a size wrapped round
        assert_eq!(parse_avc_sps(&avc_sps(0, 20, 15, Some([400, 400, 300, 300]))).map(|s| (s.width, s.height)), Some((0, 0)));
        // a High profile's chroma format and bit depths
        let high = |chroma: u64, depth: u64| {
            let mut w = Written::default();
            w.u(8, 100).u(8, 0).u(8, 30).ue(0);
            // chroma format, luma and chroma depths, no bypass, no scaling matrices
            w.ue(chroma).ue(depth).ue(depth).u(1, 0).u(1, 0);
            w.ue(0).ue(2).ue(1).u(1, 0).ue(19).ue(14).u(1, 1).u(1, 1).u(1, 0).u(1, 0);
            parse_avc_sps(&w.nal(&[0x67])).map(|s| (s.chroma_format, s.bit_depth_luma, s.bit_depth_chroma, s.width))
        };
        assert_eq!(high(1, 2), Some((1, 10, 10, 320)));
        assert_eq!(high(2, 6), Some((2, 14, 14, 320)));
        assert_eq!(high(4, 0), None);
        assert_eq!(high(1, 7), None);
        assert_eq!(high(1, huge), None);
    }

    /// An HEVC SPS of `width` by `height` samples (one sub-layer, 4:2:0),
    /// its bit depths less eight and its conformance window as given.
    fn hevc_sps(width: u64, height: u64, crop: Option<[u64; 4]>, depth: u64) -> Vec<u8> {
        let mut w = Written::default();
        // vps id 0, one sub-layer, temporal id nesting; a profile_tier_level of 12 bytes
        w.u(4, 0).u(3, 0).u(1, 1);
        for byte in [1u64, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93] {
            w.u(8, byte);
        }
        // sps id 0, 4:2:0
        w.ue(0).ue(1).ue(width).ue(height);
        match crop {
            Some(c) => {
                w.u(1, 1);
                for v in c {
                    w.ue(v);
                }
            }
            None => {
                w.u(1, 0);
            }
        }
        w.ue(depth).ue(depth);
        w.nal(&[0x42, 0x01])
    }

    #[test]
    fn an_hevc_parameter_set_that_claims_the_impossible_is_none() {
        let s = parse_hevc_sps(&hevc_sps(1920, 1088, Some([0, 0, 0, 4]), 2)).unwrap();
        assert_eq!((s.width, s.height, s.chroma_format, s.bit_depth_luma, s.bit_depth_chroma, s.max_sub_layers, s.temporal_id_nesting), (1920, 1080, 1, 10, 10, 1, true));
        assert_eq!(s.ptl[0], 1);
        let huge = u32::MAX as u64 - 1;
        assert_eq!(parse_hevc_sps(&hevc_sps(huge, 1088, None, 0)), None);
        assert_eq!(parse_hevc_sps(&hevc_sps(1920, huge, None, 0)), None);
        assert_eq!(parse_hevc_sps(&hevc_sps(1920, 1088, Some([huge, huge, 0, 0]), 0)), None);
        assert_eq!(parse_hevc_sps(&hevc_sps(1920, 1088, Some([0, 0, huge, huge]), 0)), None);
        assert_eq!(parse_hevc_sps(&hevc_sps(1920, 1088, None, 9)), None);
        assert_eq!(parse_hevc_sps(&hevc_sps(1920, 1088, None, huge)), None);
        assert_eq!(parse_hevc_sps(&hevc_sps(1920, 1088, Some([2000, 2000, 0, 0]), 0)).map(|s| s.width), Some(0));
    }

    #[test]
    fn avcc_from_one_sps_and_one_pps() {
        // x264, High 4:2:0 8-bit: the record ends with its chroma format and bit depths
        let sps = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8, 0x3c, 0x60, 0xc6, 0x58];
        let pps = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];
        let want = [&[1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 27][..], &sps, &[1, 0, 6], &pps, &[0xfd, 0xf8, 0xf8, 0]].concat();
        assert_eq!(avcc_record(&sps, &pps), Some(want));
        // Constrained Baseline: no tail
        let sps = [0x67, 0x42, 0xc0, 0x28, 0xda, 0x01, 0xe0, 0x08, 0x9f, 0x97, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0x20, 0xf1, 0x83, 0x2a];
        let pps = [0x68, 0xce, 0x0f, 0xc8];
        assert_eq!(avcc_record(&sps, &pps), Some([&[1, 0x42, 0xc0, 0x28, 0xff, 0xe1, 0, 25][..], &sps, &[1, 0, 4], &pps].concat()));
        // the sets the wrong way round, an SPS cut short, nothing
        assert_eq!(avcc_record(&pps, &sps), None);
        assert_eq!(avcc_record(&sps[..3], &pps), None);
        assert_eq!(avcc_record(&[], &[]), None);
    }

    #[test]
    fn sei_recovery_point() {
        // SEI: recovery point (type 6, 1 byte), then trailing bits
        assert!(avc_sei_recovery_point(&[0x06, 0x06, 0x01, 0xc4, 0x80]));
        // user data unregistered only (type 5)
        assert!(!avc_sei_recovery_point(&[0x06, 0x05, 0x02, 0xaa, 0xbb, 0x80]));
    }
}
