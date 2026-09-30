//! The public decoder: finding core frames and stepping over extension
//! substreams, and arranging or downmixing the channels.

use crate::frame::{Features, FrameDecoder, FrameError, MAX_CHANNELS};
use crate::header::{self, Header};
use crate::tables::AMODE_CHANNELS;
use crate::{Decoded, Error, Output, StreamInfo};

/// A DTS core decoder (see the crate documentation).
pub struct Decoder {
    output: Output,
    frame: FrameDecoder,
    info: Option<StreamInfo>,
    /// The layout of the last frame decoded (AMODE, LFF, sample rate).
    layout: Option<(u8, u8, u32)>,
    /// One buffer per coded channel (LFE last) for the frame being decoded.
    pcm: Vec<Vec<f32>>,
    /// The frame being decoded in the standard's packing.
    frame_bytes: Vec<u8>,
    /// The last embedded downmix (type and coefficients) of this layout.
    downmix: Option<(u8, Vec<Vec<f32>>)>,
    /// Extension substream frames stepped over so far.
    skipped: u64,
}

/// The coded channels (in Table 5-4's order; the LFE channel, when there
/// is one, has the index after them) in WAVE order: L R C LFE, then the
/// rear and side channels.
pub(crate) fn wave_order(amode: u8, lfe: bool) -> Vec<usize> {
    let n = AMODE_CHANNELS[amode as usize];
    // (front: L R C, and whatever WAVE puts after the LFE)
    let (front, rest): (&[usize], &[usize]) = match amode {
        0 => (&[0], &[]),
        1..=4 => (&[0, 1], &[]),
        5 => (&[1, 2, 0], &[]),
        6 => (&[0, 1], &[2]),
        7 => (&[1, 2, 0], &[3]),
        8 => (&[0, 1], &[2, 3]),
        9 => (&[1, 2, 0], &[3, 4]),
        // CL CR L R SL SR: L R, LFE, FLC FRC, SL SR
        10 => (&[2, 3], &[0, 1, 4, 5]),
        // C L R LR RR OV: L R C, LFE, BL BR, TC
        11 => (&[1, 2, 0], &[3, 4, 5]),
        // CF CR LF RF LR RR: FL FR FC, LFE, BL BR, BC
        _ => (&[2, 3, 0], &[4, 5, 1]),
    };
    let mut v = front.to_vec();
    if lfe {
        v.push(n);
    }
    v.extend_from_slice(rest);
    v
}

/// The default Lo/Ro downmix as the gains of each coded channel (LFE
/// last) into the left and right outputs: centre and surround channels
/// at -3 dB (a single surround channel -3 dB more, into both sides), the
/// LFE channel left out, scaled so that neither output's gains sum to
/// more than 1. Mono goes to both sides at full level, dual mono and
/// two-channel arrangements to their own sides.
pub(crate) fn default_downmix(amode: u8) -> [[f32; MAX_CHANNELS + 1]; 2] {
    let a = std::f32::consts::FRAC_1_SQRT_2;
    let mut g = [[0f32; MAX_CHANNELS + 1]; 2];
    // (channel, left gain, right gain)
    let taps: &[(usize, f32, f32)] = match amode {
        0 => &[(0, 1.0, 1.0)],
        1..=4 => &[(0, 1.0, 0.0), (1, 0.0, 1.0)],
        5 => &[(0, a, a), (1, 1.0, 0.0), (2, 0.0, 1.0)],
        6 => &[(0, 1.0, 0.0), (1, 0.0, 1.0), (2, 0.5, 0.5)],
        7 => &[(0, a, a), (1, 1.0, 0.0), (2, 0.0, 1.0), (3, 0.5, 0.5)],
        8 => &[(0, 1.0, 0.0), (1, 0.0, 1.0), (2, a, 0.0), (3, 0.0, a)],
        9 => &[(0, a, a), (1, 1.0, 0.0), (2, 0.0, 1.0), (3, a, 0.0), (4, 0.0, a)],
        10 => &[(0, a, 0.0), (1, 0.0, a), (2, 1.0, 0.0), (3, 0.0, 1.0), (4, a, 0.0), (5, 0.0, a)],
        11 => &[(0, a, a), (1, 1.0, 0.0), (2, 0.0, 1.0), (3, a, 0.0), (4, 0.0, a), (5, 0.5, 0.5)],
        _ => &[(0, a, a), (1, 0.5, 0.5), (2, 1.0, 0.0), (3, 0.0, 1.0), (4, a, 0.0), (5, 0.0, a)],
    };
    for &(ch, l, r) in taps {
        g[0][ch] = l;
        g[1][ch] = r;
    }
    let sum = g[0].iter().sum::<f32>().max(g[1].iter().sum::<f32>());
    if sum > 1.0 {
        for row in g.iter_mut() {
            for v in row.iter_mut() {
                *v /= sum;
            }
        }
    }
    g
}

/// The stream a frame describes. (Arrangements this decoder does not
/// take, AMODE 13 and above, count as two channels: their frames decode
/// to stereo silence.)
fn info_of(h: &Header) -> StreamInfo {
    let coded = AMODE_CHANNELS.get(h.amode as usize).copied().filter(|_| h.amode < 13).unwrap_or(2);
    StreamInfo { sample_rate: h.sample_rate, channels: coded + (h.lff > 0) as usize, amode: h.amode, lfe: h.lff > 0, frame_samples: h.samples() }
}

/// A core frame's header at `data[pos..]`, in whatever packing, and the
/// bytes it takes there.
fn core_header(data: &[u8], pos: usize, scratch: &mut Vec<u8>) -> Option<(Header, header::Packing, usize)> {
    let packing = header::core_sync(&data[pos..])?;
    // 32 bytes hold the header in any packing
    header::to_be16(&data[pos..(pos + 32).min(data.len())], packing, scratch);
    let h = header::parse(scratch).ok()?;
    let raw = header::raw_len(h.bytes, packing);
    Some((h, packing, raw))
}

/// Whether the frame ending at `end` is followed by the end of the data
/// or, after at most three zero bytes of alignment, another frame.
fn followed(data: &[u8], end: usize) -> bool {
    let mut p = end;
    while p < data.len() && p < end + 3 && data[p] == 0 {
        p += 1;
    }
    p >= data.len() || header::any_sync(data, p)
}

impl Decoder {
    pub fn new(output: Output) -> Decoder {
        Decoder { output, frame: FrameDecoder::new(), info: None, layout: None, pcm: Vec::new(), frame_bytes: Vec::new(), downmix: None, skipped: 0 }
    }

    /// Decode every core frame in `data` (a whole number of frames: a
    /// Matroska block, an MP4 sample, or a run of frames from an
    /// elementary or transport stream) and append each output channel's
    /// samples to `out[ch]`. DTS-HD extension substreams, and the core
    /// extensions inside core frames, are stepped over.
    ///
    /// `out` is first resized to the output channel count: 2 for
    /// `Output::Stereo`; for `Output::Native`, the count of the first
    /// core frame in `data`. Should the stream change its channel layout
    /// at a later frame (in this call or a later one), `out` is resized
    /// there to the new count: new channels start with silence as long as
    /// the others so far, and channels past the new count are removed
    /// with their samples. Channels are filled by position in the WAVE
    /// order of each frame's own layout.
    ///
    /// Errs only when not one core frame could be found (`Error::NoCore`
    /// when there were extension substreams, as in DTS-HD Master Audio or
    /// DTS Express without a core); damaged frames give silence and count
    /// in `Decoded::damaged`. Once a core frame has been decoded, though,
    /// data of extension substreams alone (a frame's substream handed over
    /// apart from its core) is no error: it gives no samples.
    pub fn decode(&mut self, data: &[u8], out: &mut Vec<Vec<f32>>) -> Result<Decoded, Error> {
        let mut result = Decoded::default();
        let (mut found, mut substreams, mut sized) = (false, false, false);
        let mut scratch = Vec::new();
        let mut pos = 0;
        while pos + 6 <= data.len() {
            if data[pos..pos + 4] == header::SUBSTREAM_SYNC {
                if let Some(size) = header::substream_size(&data[pos..]) {
                    substreams = true;
                    self.skipped += 1;
                    pos += size;
                } else {
                    pos += 1;
                }
                continue;
            }
            let Some((h, packing, raw)) = core_header(data, pos, &mut scratch) else {
                pos += 1;
                continue;
            };
            let end = pos + raw;
            if end > data.len() {
                // cut off: a frame that does not fit is silence
                found = true;
                self.silence(&h, out, &mut sized);
                result.damaged += 1;
                result.samples += h.samples();
                break;
            }
            header::to_be16(&data[pos..end], packing, &mut self.frame_bytes);
            match self.decode_frame(&h, out, &mut sized) {
                Ok(()) => {}
                // A frame that does not decode is taken for one when the
                // next frame (or the end of the data) follows it; else
                // for a chance sync word inside other data.
                Err(_) if followed(data, end) => {
                    self.silence(&h, out, &mut sized);
                    result.damaged += 1;
                }
                Err(_) => {
                    // (what it did to the filter banks' history goes)
                    self.frame.reset();
                    pos += 1;
                    continue;
                }
            }
            found = true;
            result.samples += h.samples();
            pos = end;
        }
        if !found {
            if substreams && self.info.is_some() {
                return Ok(result);
            }
            return Err(if substreams { Error::NoCore } else { Error::NoSync });
        }
        Ok(result)
    }

    /// Forget the filter banks' and predictors' history (after a seek).
    pub fn reset(&mut self) {
        self.frame.reset();
    }

    /// The stream as its last decoded frame described it.
    pub fn info(&self) -> Option<StreamInfo> {
        self.info
    }

    /// Apply the dynamic range coefficients of streams that carry them
    /// (clause 5.5.1: the decoder may ignore them, and does by default,
    /// as ffmpeg's does).
    pub fn set_dynamic_range(&mut self, on: bool) {
        self.frame.dynamic_range = on;
    }

    /// The coding tools the stream has used so far, and how many
    /// extension substream frames were stepped over (for diagnostics and
    /// tests).
    pub fn features(&self) -> (Features, u64) {
        (self.frame.features, self.skipped)
    }

    /// Size `out` for a frame with this layout (see `decode`).
    fn fit(&self, info: &StreamInfo, out: &mut Vec<Vec<f32>>, sized: &mut bool) {
        let n = match self.output {
            Output::Stereo => 2,
            Output::Native => info.channels,
        };
        if out.len() != n || !*sized {
            let len = out.iter().map(|c| c.len()).max().unwrap_or(0);
            out.truncate(n);
            while out.len() < n {
                out.push(Vec::new());
            }
            for c in out.iter_mut() {
                c.resize(len.max(c.len()), 0.0);
            }
            *sized = true;
        }
    }

    fn silence(&mut self, h: &Header, out: &mut Vec<Vec<f32>>, sized: &mut bool) {
        // the layout: what the stream had, else what this frame claims
        let info = self.info.unwrap_or(info_of(h));
        self.fit(&info, out, sized);
        for c in out.iter_mut() {
            c.resize(c.len() + h.samples(), 0.0);
        }
        self.frame.reset();
    }

    fn decode_frame(&mut self, h: &Header, out: &mut Vec<Vec<f32>>, sized: &mut bool) -> Result<(), FrameError> {
        let layout = (h.amode, h.lff, h.sample_rate);
        if self.layout.is_some_and(|l| l != layout) {
            // the old history belongs to other channels
            self.frame.reset();
            self.downmix = None;
        }
        let lfe = h.lff > 0;
        let coded = AMODE_CHANNELS[(h.amode as usize).min(12)] + lfe as usize;
        let samples = h.samples();
        self.pcm.resize(MAX_CHANNELS + 1, Vec::new());
        for c in self.pcm.iter_mut() {
            c.clear();
            c.resize(samples, 0.0);
        }
        let extras = self.frame.decode(&self.frame_bytes, h, &mut self.pcm[..coded])?;
        self.layout = Some(layout);
        if extras.downmix.is_some() {
            self.downmix = extras.downmix;
        }
        let info = info_of(h);
        self.info = Some(info);
        self.fit(&info, out, sized);
        match self.output {
            Output::Native => {
                for (o, &c) in wave_order(h.amode, lfe).iter().enumerate() {
                    out[o].extend_from_slice(&self.pcm[c]);
                }
            }
            Output::Stereo => {
                let gains: Vec<Vec<f32>> = match &self.downmix {
                    // (a two-channel stream is its own Lo/Ro, as ffmpeg has it)
                    Some((1 | 2, m)) if coded > 2 && m.len() == 2 && m[0].len() == coded => m.clone(),
                    _ => default_downmix(h.amode).iter().map(|row| row[..coded].to_vec()).collect(),
                };
                for (o, row) in gains.iter().enumerate() {
                    let start = out[o].len();
                    out[o].resize(start + samples, 0.0);
                    let dst = &mut out[o][start..];
                    for (c, &gain) in row.iter().enumerate() {
                        if gain == 0.0 {
                            continue;
                        }
                        for (d, &s) in dst.iter_mut().zip(&self.pcm[c]) {
                            *d += gain * s;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// The first core frame's description, without decoding. A frame that
/// the next frame (or the end of the data) follows is preferred; failing
/// that, the first one whose header reads.
pub fn probe(data: &[u8]) -> Result<StreamInfo, Error> {
    let mut first: Option<StreamInfo> = None;
    let (mut unsupported, mut substreams) = (false, false);
    let mut scratch = Vec::new();
    let mut pos = 0;
    while pos + 6 <= data.len() {
        if data[pos..pos + 4] == header::SUBSTREAM_SYNC {
            if let Some(size) = header::substream_size(&data[pos..]) {
                substreams = true;
                pos += size;
                continue;
            }
        }
        if let Some((h, _, raw)) = core_header(data, pos, &mut scratch) {
            if h.amode >= 13 || h.vernum > 7 {
                unsupported = true;
            } else {
                if pos + raw <= data.len() && followed(data, pos + raw) {
                    return Ok(info_of(&h));
                }
                first.get_or_insert(info_of(&h));
            }
        }
        pos += 1;
    }
    match first {
        Some(i) => Ok(i),
        None if unsupported => Err(Error::Unsupported("more than six channels, a user defined arrangement or an encoder revision above 7")),
        None if substreams => Err(Error::NoCore),
        None => Err(Error::NoSync),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wave_orders() {
        assert_eq!(wave_order(9, true), [1, 2, 0, 5, 3, 4]);
        assert_eq!(wave_order(9, false), [1, 2, 0, 3, 4]);
        assert_eq!(wave_order(2, true), [0, 1, 2]);
        assert_eq!(wave_order(0, true), [0, 1]);
        assert_eq!(wave_order(6, true), [0, 1, 3, 2]);
        assert_eq!(wave_order(7, false), [1, 2, 0, 3]);
        assert_eq!(wave_order(8, true), [0, 1, 4, 2, 3]);
        assert_eq!(wave_order(5, true), [1, 2, 0, 3]);
        assert_eq!(wave_order(10, true), [2, 3, 6, 0, 1, 4, 5]);
        assert_eq!(wave_order(12, false), [2, 3, 0, 4, 5, 1]);
        for amode in 0..13 {
            for lfe in [false, true] {
                let mut v = wave_order(amode, lfe);
                v.sort();
                assert_eq!(v, (0..AMODE_CHANNELS[amode as usize] + lfe as usize).collect::<Vec<_>>());
            }
        }
    }

    #[test]
    fn default_downmix_sums_to_one() {
        let g = default_downmix(9);
        let a = std::f32::consts::FRAC_1_SQRT_2;
        let sum = 1.0 + 2.0 * a;
        assert!((g[0].iter().sum::<f32>() - 1.0).abs() < 1e-6);
        assert!((g[0][1] - 1.0 / sum).abs() < 1e-6 && (g[0][0] - a / sum).abs() < 1e-6 && g[0][4] == 0.0 && g[1][3] == 0.0);
        assert_eq!(default_downmix(2)[0][..2], [1.0, 0.0]);
        assert_eq!(default_downmix(0)[1][0], 1.0);
        let g = default_downmix(6);
        assert!((g[0][2] - 0.5 / 1.5).abs() < 1e-6 && g[0][2] == g[1][2]);
        // the LFE channel (index 5 in 3/2) stays out
        assert!(g.iter().all(|row| row[MAX_CHANNELS] == 0.0));
    }
}
