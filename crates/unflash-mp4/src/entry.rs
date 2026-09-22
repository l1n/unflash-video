//! MP4 audio sample entries built from scratch: for audio that arrives in
//! another container (Matroska) or from an encoder, so an export can carry
//! it in an MP4 track. Each builder takes what the codec's own setup data
//! says (an AudioSpecificConfig, an OpusHead, a FLAC STREAMINFO, the first
//! AC-3 / E-AC-3 / MPEG audio frame).

use crate::reader::Writer;
use crate::Error;

/// Sampling rates by AAC sampling frequency index.
pub const AAC_RATES: [u32; 13] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/// The fixed part of an audio sample entry, then `children`.
fn audio_entry(fourcc: &[u8; 4], channels: u32, rate: u32, children: impl FnOnce(&mut Writer)) -> Vec<u8> {
    let mut w = Writer::new();
    let at = w.begin_box(fourcc);
    w.zeros(6);
    w.u16(1); // data reference index
    w.zeros(8); // version 0 fields
    w.u16(channels.clamp(1, 0xffff) as u16);
    w.u16(16); // sample size
    w.zeros(4);
    // 16.16; a rate that does not fit is left to the codec's own setup data
    w.u32(if rate <= 0xffff { rate << 16 } else { 0 });
    children(&mut w);
    w.end_box(at);
    w.buf
}

fn descriptor(w: &mut Writer, tag: u8, body: &[u8]) {
    w.u8(tag);
    let n = body.len();
    if n < 0x80 {
        w.u8(n as u8);
    } else {
        w.u8(0x80 | ((n >> 21) & 0x7f) as u8);
        w.u8(0x80 | ((n >> 14) & 0x7f) as u8);
        w.u8(0x80 | ((n >> 7) & 0x7f) as u8);
        w.u8((n & 0x7f) as u8);
    }
    w.bytes(body);
}

/// An `esds` box: object type `oti` (0x40 AAC, 0x6B MPEG-1 audio, 0x69
/// MPEG-2 audio), with a DecoderSpecificInfo when there is one.
fn esds(w: &mut Writer, oti: u8, dsi: Option<&[u8]>) {
    let mut dcd = Writer::new();
    dcd.u8(oti);
    dcd.u8(0x15); // audio stream, upstream 0, reserved 1
    dcd.u24(0); // buffer size
    dcd.u32(0); // max bitrate
    dcd.u32(0); // average bitrate
    if let Some(d) = dsi {
        descriptor(&mut dcd, 0x05, d);
    }
    let mut es = Writer::new();
    es.u16(0); // ES_ID
    es.u8(0); // flags
    descriptor(&mut es, 0x04, &dcd.buf);
    descriptor(&mut es, 0x06, &[0x02]);
    let at = w.begin_full_box(b"esds", 0, 0);
    descriptor(w, 0x03, &es.buf);
    w.end_box(at);
}

/// What an AudioSpecificConfig says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asc {
    /// The core audio object type (2 = AAC LC).
    pub aot: u8,
    pub rate: u32,
    pub channels: u32,
    /// SBR (HE-AAC) signalled explicitly, and the rate it outputs.
    pub sbr_rate: Option<u32>,
    /// 960-sample frames instead of 1024.
    pub short_frames: bool,
}

struct Bits<'a> {
    b: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    fn u(&mut self, n: usize) -> Option<u32> {
        let mut v = 0u32;
        for _ in 0..n {
            let byte = *self.b.get(self.at / 8)?;
            v = (v << 1) | ((byte >> (7 - self.at % 8)) & 1) as u32;
            self.at += 1;
        }
        Some(v)
    }
}

pub fn parse_asc(asc: &[u8]) -> Option<Asc> {
    let mut r = Bits { b: asc, at: 0 };
    let aot = |r: &mut Bits| -> Option<u8> {
        let a = r.u(5)?;
        Some(if a == 31 { 32 + r.u(6)? as u8 } else { a as u8 })
    };
    let rate = |r: &mut Bits| -> Option<u32> {
        let i = r.u(4)?;
        if i == 15 {
            r.u(24)
        } else {
            AAC_RATES.get(i as usize).copied()
        }
    };
    let mut a = aot(&mut r)?;
    let core_rate = rate(&mut r)?;
    let channels = r.u(4)?;
    let mut sbr_rate = None;
    if a == 5 || a == 29 {
        sbr_rate = Some(rate(&mut r)?);
        a = aot(&mut r)?;
    }
    let short_frames = matches!(a, 1..=4 | 6 | 7 | 17 | 19..=23) && r.u(1).unwrap_or(0) == 1;
    Some(Asc { aot: a, rate: core_rate, channels, sbr_rate, short_frames })
}

/// A two-byte AudioSpecificConfig for an object type, rate and channel
/// count (with the SBR sync extension when `sbr_rate` is given).
pub fn make_asc(aot: u8, rate: u32, channels: u32, sbr_rate: Option<u32>) -> Vec<u8> {
    let idx = |r: u32| AAC_RATES.iter().position(|&x| x == r).unwrap_or(4) as u8;
    let sri = idx(rate);
    let mut v = vec![(aot << 3) | (sri >> 1), ((sri & 1) << 7) | ((channels.min(15) as u8) << 3)];
    if let Some(s) = sbr_rate {
        // sync extension 0x2b7, SBR (object type 5), present, extension rate
        v.extend_from_slice(&[0x56, 0xe5, 0x80 | (idx(s) << 3)]);
    }
    v
}

/// `mp4a` + `esds` for AAC.
pub fn aac_entry(asc: &[u8], rate: u32, channels: u32) -> Vec<u8> {
    audio_entry(b"mp4a", channels, rate, |w| esds(w, 0x40, Some(asc)))
}

/// MPEG audio (layers I-III) in `mp4a`, object type 0x6B (MPEG-1 rates)
/// or 0x69 (MPEG-2's half rates).
pub fn mpeg_audio_entry(rate: u32, channels: u32) -> Vec<u8> {
    let oti = if rate >= 32000 { 0x6B } else { 0x69 };
    audio_entry(b"mp4a", channels, rate, |w| esds(w, oti, None))
}

/// What the head of an MPEG audio frame says: (rate, channels, samples per frame).
pub fn mpeg_audio_frame(h: &[u8]) -> Option<(u32, u32, u32)> {
    if h.len() < 4 || h[0] != 0xff || h[1] & 0xe0 != 0xe0 {
        return None;
    }
    let version = (h[1] >> 3) & 3; // 0: 2.5, 2: 2, 3: 1
    let layer = (h[1] >> 1) & 3; // 1: III, 2: II, 3: I
    let ri = (h[2] >> 2) & 3;
    if version == 1 || layer == 0 || ri == 3 {
        return None;
    }
    let base = [44100u32, 48000, 32000][ri as usize];
    let rate = match version {
        3 => base,
        2 => base / 2,
        _ => base / 4,
    };
    let channels = if h[3] >> 6 == 3 { 1 } else { 2 };
    let samples = match (layer, version) {
        (3, _) => 384,
        (2, _) => 1152,
        (_, 3) => 1152,
        _ => 576,
    };
    Some((rate, channels, samples))
}

/// `Opus` + `dOps`, from an OpusHead (Ogg / Matroska / WebCodecs form).
pub fn opus_entry(head: &[u8]) -> Result<Vec<u8>, Error> {
    if head.len() < 19 || &head[..8] != b"OpusHead" {
        return Err("Opus without an OpusHead".into());
    }
    let channels = head[9];
    let pre_skip = u16::from_le_bytes([head[10], head[11]]);
    let input_rate = u32::from_le_bytes([head[12], head[13], head[14], head[15]]);
    let gain = i16::from_le_bytes([head[16], head[17]]);
    let family = head[18];
    let mapping = if family != 0 {
        let need = 21 + channels as usize;
        if head.len() < need {
            return Err("OpusHead too short for its channel mapping".into());
        }
        head[19..need].to_vec()
    } else {
        vec![]
    };
    Ok(audio_entry(b"Opus", channels as u32, 48000, |w| {
        let at = w.begin_box(b"dOps");
        w.u8(0);
        w.u8(channels);
        w.u16(pre_skip);
        w.u32(input_rate);
        w.i16(gain);
        w.u8(family);
        w.bytes(&mapping);
        w.end_box(at);
    }))
}

/// An OpusHead for a stream without one (up to two channels).
pub fn make_opus_head(channels: u32, pre_skip: u16, input_rate: u32) -> Vec<u8> {
    let mut v = b"OpusHead".to_vec();
    v.push(1);
    v.push(channels.clamp(1, 2) as u8);
    v.extend_from_slice(&pre_skip.to_le_bytes());
    v.extend_from_slice(&input_rate.to_le_bytes());
    v.extend_from_slice(&0i16.to_le_bytes());
    v.push(0);
    v
}

/// Samples in an Opus packet, from its TOC byte (and the frame count byte
/// of a code 3 packet), at 48 kHz.
pub fn opus_packet_samples(p: &[u8]) -> Option<u32> {
    let toc = *p.first()?;
    let config = toc >> 3;
    let per_frame = match config {
        0..=11 => [480, 960, 1920, 2880][(config & 3) as usize],
        12..=15 => [480, 960][(config & 1) as usize],
        _ => [120, 240, 480, 960][(config & 3) as usize],
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => (*p.get(1)? & 0x3f) as u32,
    };
    Some(per_frame * frames)
}

/// FLAC's STREAMINFO block (34 bytes) out of a `fLaC` + metadata blocks
/// record, or out of the blocks alone.
pub fn flac_streaminfo(private: &[u8]) -> Option<&[u8]> {
    let b = private.strip_prefix(b"fLaC").unwrap_or(private);
    if b.len() < 4 + 34 || b[0] & 0x7f != 0 {
        return None;
    }
    Some(&b[4..4 + 34])
}

/// (rate, channels, fixed block size or 0) from a STREAMINFO.
pub fn flac_info(si: &[u8]) -> (u32, u32, u32) {
    let min_block = u16::from_be_bytes([si[0], si[1]]) as u32;
    let max_block = u16::from_be_bytes([si[2], si[3]]) as u32;
    let rate = ((si[10] as u32) << 12) | ((si[11] as u32) << 4) | (si[12] as u32 >> 4);
    let channels = ((si[12] >> 1) & 7) as u32 + 1;
    (rate, channels, if min_block == max_block { max_block } else { 0 })
}

/// `fLaC` + `dfLa` holding the STREAMINFO.
pub fn flac_entry(si: &[u8]) -> Vec<u8> {
    let (rate, channels, _) = flac_info(si);
    audio_entry(b"fLaC", channels, rate, |w| {
        let at = w.begin_full_box(b"dfLa", 0, 0);
        w.u8(0x80); // last metadata block, STREAMINFO
        w.u24(si.len() as u32);
        w.bytes(si);
        w.end_box(at);
    })
}

const AC3_RATES: [u32; 3] = [48000, 44100, 32000];

/// `ac-3` + `dac3` from the head of an AC-3 frame; with its rate and
/// channel count.
pub fn ac3_entry(frame: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    if frame.len() < 8 || frame[0] != 0x0b || frame[1] != 0x77 {
        return None;
    }
    let mut r = Bits { b: &frame[4..], at: 0 };
    let fscod = r.u(2)?;
    let frmsizecod = r.u(6)?;
    let bsid = r.u(5)?;
    let bsmod = r.u(3)?;
    let acmod = r.u(3)?;
    if bsid > 10 || fscod == 3 {
        return None;
    }
    if acmod & 1 != 0 && acmod != 1 {
        r.u(2)?;
    }
    if acmod & 4 != 0 {
        r.u(2)?;
    }
    if acmod == 2 {
        r.u(2)?;
    }
    let lfeon = r.u(1)?;
    let channels = [2u32, 1, 2, 3, 3, 4, 4, 5][acmod as usize] + lfeon;
    let rate = AC3_RATES[fscod as usize];
    let dac3 = [((fscod << 6) | (bsid << 1) | (bsmod >> 2)) as u8, (((bsmod & 3) << 6) | (acmod << 3) | (lfeon << 2) | ((frmsizecod >> 1) >> 3)) as u8, (((frmsizecod >> 1) & 7) << 5) as u8];
    Some((
        audio_entry(b"ac-3", channels, rate, |w| {
            let at = w.begin_box(b"dac3");
            w.bytes(&dac3);
            w.end_box(at);
        }),
        rate,
        channels,
    ))
}

/// `ec-3` + `dec3` from the head of an E-AC-3 frame (one independent
/// substream); with its rate, channel count and samples per frame.
pub fn eac3_entry(frame: &[u8]) -> Option<(Vec<u8>, u32, u32, u32)> {
    if frame.len() < 8 || frame[0] != 0x0b || frame[1] != 0x77 {
        return None;
    }
    let mut r = Bits { b: &frame[2..], at: 0 };
    let _strmtyp = r.u(2)?;
    let _substreamid = r.u(3)?;
    let frmsiz = r.u(11)?;
    let fscod = r.u(2)?;
    let (rate, blocks) = if fscod == 3 {
        let fscod2 = r.u(2)?;
        ([24000u32, 22050, 16000].get(fscod2 as usize).copied()?, 6)
    } else {
        let numblkscod = r.u(2)?;
        (AC3_RATES[fscod as usize], [1u32, 2, 3, 6][numblkscod as usize])
    };
    let acmod = r.u(3)?;
    let lfeon = r.u(1)?;
    let bsid = r.u(5)?;
    if !(11..=16).contains(&bsid) {
        return None;
    }
    let channels = [2u32, 1, 2, 3, 3, 4, 4, 5][acmod as usize] + lfeon;
    let samples = 256 * blocks;
    // kbit/s from the frame size
    let frame_bytes = (frmsiz + 1) * 2;
    let data_rate = (frame_bytes as u64 * 8 * rate as u64 / samples as u64 / 1000) as u32;
    let mut w = Writer::new();
    // data_rate(13) num_ind_sub(3) = 0 (one), then fscod(2) bsid(5) reserved(1) asvc(1) bsmod(3) acmod(3) lfeon(1) reserved(3) num_dep_sub(4) reserved(1)
    w.u16(((data_rate.min(0x1fff)) << 3) as u16);
    let fs = if fscod == 3 { 3 } else { fscod };
    let v: u32 = (fs << 22) | (bsid << 17) | (acmod << 9) | (lfeon << 8);
    w.u24(v);
    let dec3 = w.buf;
    Some((
        audio_entry(b"ec-3", channels, rate, |w| {
            let at = w.begin_box(b"dec3");
            w.bytes(&dec3);
            w.end_box(at);
        }),
        rate,
        channels,
        samples,
    ))
}

/// An MP4 sample entry for audio an encoder made (WebCodecs' codec string
/// and decoderConfig description): AAC, Opus or FLAC.
pub fn encoded_audio_entry(codec: &str, description: &[u8], rate: u32, channels: u32) -> Result<Vec<u8>, Error> {
    if let Some(rest) = codec.strip_prefix("mp4a.40.") {
        let asc = if description.is_empty() { make_asc(rest.parse().unwrap_or(2), rate, channels, None) } else { description.to_vec() };
        return Ok(aac_entry(&asc, rate, channels));
    }
    match codec {
        "opus" => {
            let head = if description.len() >= 19 && description.starts_with(b"OpusHead") { description.to_vec() } else { make_opus_head(channels, 312, rate) };
            opus_entry(&head)
        }
        "flac" => flac_streaminfo(description).map(flac_entry).ok_or_else(|| "FLAC without a STREAMINFO".to_string()),
        other => Err(format!("no MP4 sample entry for {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mux::codec_of_entry;

    #[test]
    fn asc_round_trip() {
        let asc = make_asc(2, 48000, 2, None);
        assert_eq!(asc, vec![0x11, 0x90]);
        let a = parse_asc(&asc).unwrap();
        assert_eq!((a.aot, a.rate, a.channels, a.sbr_rate, a.short_frames), (2, 48000, 2, None, false));
        let he = make_asc(2, 24000, 2, Some(48000));
        let a = parse_asc(&he).unwrap();
        assert_eq!((a.aot, a.rate), (2, 24000));
        // explicit hierarchical SBR: object type 5 first
        let a = parse_asc(&[0x2b, 0x92, 0x08, 0x00]).unwrap();
        assert_eq!((a.aot, a.rate, a.sbr_rate, a.channels), (2, 22050, Some(44100), 2));
    }

    #[test]
    fn entries_parse_back() {
        let e = aac_entry(&make_asc(2, 44100, 2, None), 44100, 2);
        let c = codec_of_entry(&e).unwrap();
        assert_eq!(c.codec, "mp4a.40.2");
        assert_eq!(c.description.as_deref(), Some(&make_asc(2, 44100, 2, None)[..]));
        assert_eq!(codec_of_entry(&mpeg_audio_entry(44100, 2)).unwrap().codec, "mp3");
        let head = make_opus_head(2, 312, 48000);
        assert_eq!(codec_of_entry(&opus_entry(&head).unwrap()).unwrap().codec, "opus");
        // AC-3 at 48 kHz, 5.1 (acmod 7 + LFE), 448 kbit/s
        let frame = [0x0b, 0x77, 0, 0, 0x1c, 0x40, 0xe1, 0xf0];
        let (e, rate, ch) = ac3_entry(&frame).unwrap();
        assert_eq!((rate, ch), (48000, 6));
        assert_eq!(codec_of_entry(&e).unwrap().codec, "ac-3");
    }

    #[test]
    fn packet_lengths() {
        assert_eq!(opus_packet_samples(&[0xfc]), Some(960)); // CELT 20 ms, one frame
        assert_eq!(opus_packet_samples(&[0x0b]), None); // code 3 without its frame count
        assert_eq!(opus_packet_samples(&[0x0b, 0x02]), Some(1920)); // SILK 20 ms, two frames
        assert_eq!(opus_packet_samples(&[0x7b, 0x03]), Some(2880)); // hybrid 20 ms, three frames
        assert_eq!(opus_packet_samples(&[0x81]), Some(240)); // CELT 2.5 ms, two frames (code 1)
        assert_eq!(mpeg_audio_frame(&[0xff, 0xfb, 0x90, 0x64]), Some((44100, 2, 1152)));
        assert_eq!(mpeg_audio_frame(&[0xff, 0xf3, 0x84, 0xc4]), Some((24000, 1, 576)));
    }
}
