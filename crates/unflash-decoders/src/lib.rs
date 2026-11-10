//! The built-in decoders for the codecs a browser's WebCodecs may lack
//! (HEVC, VP9, VP8 and AV1; H.264's is in the main module; and the sound
//! decoders for AC-3, E-AC-3 and DTS, `SoundDecoder`), as a WebAssembly
//! module of their own: the page loads it only for a file that needs one,
//! and each decode worker (`web/softworker.js`) runs one decoder over a
//! group of pictures at a time. Every decoder gives 8-bit 4:2:0 pictures
//! (deeper ones rounded), bit-exact with ffmpeg's for what it supports; here
//! each is made the detector's size (`set_shrink`, from the decoder's own
//! planes, as a decode worker makes a browser decoder's picture small) or
//! copied out as packed I420.

use std::collections::VecDeque;

use unflash_codec::{Frame, VideoDecoder};
use unflash_core::resample::Shrink;
use wasm_bindgen::prelude::*;

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Any of the built-in decoders, driven alike, its errors as the text the
/// page shows.
trait Stream {
    fn decode(&mut self, sample: &[u8], pts: f64) -> Result<Vec<Frame>, String>;
    fn flush(&mut self) -> Result<Vec<Frame>, String>;
    fn reorder_depth(&self) -> u32;
}

impl<D: VideoDecoder> Stream for D {
    fn decode(&mut self, sample: &[u8], pts: f64) -> Result<Vec<Frame>, String> {
        VideoDecoder::decode(self, sample, pts).map_err(|e| e.to_string())
    }
    fn flush(&mut self) -> Result<Vec<Frame>, String> {
        VideoDecoder::flush(self).map_err(|e| e.to_string())
    }
    fn reorder_depth(&self) -> u32 {
        VideoDecoder::reorder_depth(self)
    }
}

/// A decoder for `codec` (the app's name: hevc, vp9, vp8, av1) and the
/// track's configuration record (hvcC, vpcC, av1C or Matroska's
/// CodecPrivate; may be empty).
fn open(codec: &str, config: &[u8]) -> Result<Box<dyn Stream>, String> {
    // (boxed: one decoder at a time, of states that differ in size by kilobytes)
    fn boxed<D: VideoDecoder + 'static>(config: &[u8]) -> Result<Box<dyn Stream>, String> {
        Ok(Box::new(D::open(config).map_err(|e| e.to_string())?))
    }
    match codec {
        "hevc" => boxed::<unflash_hevc::Decoder>(config),
        "vp9" => boxed::<unflash_vp9::Decoder>(config),
        "vp8" => boxed::<unflash_vp8::Decoder>(config),
        "av1" => boxed::<unflash_av1::Decoder>(config),
        other => Err(format!("there is no built-in decoder for {other}")),
    }
}

/// One of the built-in decoders, sample by sample: `decode` (or `flush`)
/// says how many pictures are ready, `next` takes the next one, and the
/// picture's accessors read it: made small (`small`, after `set_shrink`) or
/// whole (packed I420 at `frame_ptr`, in this module's memory).
#[wasm_bindgen]
pub struct SoftDecoder {
    inner: Box<dyn Stream>,
    /// The pictures decoded and not yet taken, and the one taken last. (The
    /// decoders carry the number `decode` was given as a picture's time:
    /// the sample it was shown by.)
    ready: VecDeque<Frame>,
    cur: Option<Frame>,
    /// The current picture as packed I420, when pictures are not made small.
    frame: Vec<u8>,
    /// The analysis size pictures are made small to, and the last one made.
    shrink: Option<(u32, u32)>,
    shrinker: Option<Shrink>,
    small: Vec<u8>,
}

#[wasm_bindgen]
impl SoftDecoder {
    /// A decoder for `codec` (hevc, vp9, vp8 or av1) and the track's
    /// configuration record (`config`).
    #[wasm_bindgen(constructor)]
    pub fn new(codec: &str, config: &[u8]) -> Result<SoftDecoder, JsValue> {
        Ok(SoftDecoder { inner: open(codec, config).map_err(js_err)?, ready: VecDeque::new(), cur: None, frame: Vec::new(), shrink: None, shrinker: None, small: Vec::new() })
    }

    /// From now on make each picture `analysis_width`×`analysis_height`
    /// RGBA8 here, with the colour conversion its stream says (BT.709 or
    /// BT.601, full or limited range), instead of copying it out whole.
    pub fn set_shrink(&mut self, analysis_width: u32, analysis_height: u32) {
        self.shrink = Some((analysis_width.max(1), analysis_height.max(1)));
    }

    /// Decode one sample (`index`: its number, which the picture it shows
    /// carries back in `frame_pts`). Returns how many pictures are ready.
    pub fn decode(&mut self, sample: &[u8], index: u32) -> Result<u32, JsValue> {
        self.ready.extend(self.inner.decode(sample, index as f64).map_err(js_err)?);
        Ok(self.ready.len() as u32)
    }

    /// The pictures still held at the end; returns how many are ready.
    pub fn flush(&mut self) -> Result<u32, JsValue> {
        self.ready.extend(self.inner.flush().map_err(js_err)?);
        Ok(self.ready.len() as u32)
    }

    /// How many pictures may come out before one shown earlier (a caller
    /// holds that many back to hand them on in presentation order).
    pub fn reorder_depth(&self) -> u32 {
        self.inner.reorder_depth()
    }

    /// Take the next ready picture; false when there is none.
    // (JavaScript calls it by this name; it is no iterator's `next`)
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> bool {
        let Some(p) = self.ready.pop_front() else {
            self.cur = None;
            return false;
        };
        match self.shrink {
            Some((aw, ah)) => {
                let (w, cw) = (p.width as usize, p.chroma_size().0);
                let k = Shrink::reuse(&mut self.shrinker, p.width, p.height, aw, ah);
                k.yuv420_planes(&p.y, w, &p.u, cw, &p.v, cw, p.bt709, p.full_range, &mut self.small);
            }
            None => p.pack_i420(&mut self.frame),
        }
        self.cur = Some(p);
        true
    }

    pub fn width(&self) -> u32 {
        self.cur.as_ref().map_or(0, |p| p.width)
    }
    pub fn height(&self) -> u32 {
        self.cur.as_ref().map_or(0, |p| p.height)
    }
    /// The number of the sample the current picture was shown by.
    pub fn frame_pts(&self) -> u32 {
        self.cur.as_ref().map_or(0, |p| p.pts as u32)
    }
    pub fn frame_damaged(&self) -> bool {
        self.cur.as_ref().is_some_and(|p| p.damaged)
    }
    /// The current picture as packed I420 (Y, then Cb, then Cr, no padding)
    /// in this module's memory: its address and length in bytes.
    pub fn frame_ptr(&self) -> *const u8 {
        self.frame.as_ptr()
    }
    pub fn frame_len(&self) -> u32 {
        self.frame.len() as u32
    }
    /// The current picture made small (RGBA8 at the analysis size).
    pub fn small(&self) -> Vec<u8> {
        self.small.clone()
    }
    /// The current picture's colour space as a `VideoColorSpaceInit` JSON object.
    pub fn color_json(&self) -> String {
        let (bt709, full) = self.cur.as_ref().map_or((true, false), |p| (p.bt709, p.full_range));
        let m = if bt709 { "bt709" } else { "smpte170m" };
        serde_json::json!({ "primaries": m, "transfer": m, "matrix": m, "fullRange": full }).to_string()
    }
}

/// Whether the built-in decoder for `codec` can take a track with this
/// configuration record: an empty JSON object (the page reads nothing from
/// it), or an error saying why not (an unsupported profile, say).
#[wasm_bindgen]
pub fn probe(codec: &str, config: &[u8]) -> Result<String, JsValue> {
    open(codec, config).map_err(js_err)?;
    Ok("{}".into())
}

/// The sound no browser's WebCodecs decodes, for the section player to play
/// and the export to re-encode (`web/audiodec.js`): AC-3 and E-AC-3 (Dolby
/// Digital, Dolby Digital Plus), and DTS (the core of DTS Coherent
/// Acoustics, which every DTS, DTS-ES and DTS-HD stream with a core
/// carries; DTS-HD's extensions are stepped over, and a stream without a
/// core, DTS-HD Master Audio or DTS Express without one, is an error that
/// says so). Each `decode` takes a whole number of frames (an MP4 sample, a
/// Matroska block, a transport stream's PES payload) and gives their
/// samples mixed down to stereo (DTS's Lo/Ro with the stream's own
/// coefficients when it has them) as f32 planes, one after the other, as an
/// AudioData of format f32-planar takes them.
#[wasm_bindgen]
pub struct SoundDecoder {
    dec: Sound,
    out: Vec<Vec<f32>>,
    samples: usize,
    rate: u32,
}

enum Sound {
    // (boxed: the decoders' states differ in size, about 20 and 5 KB)
    Ac3(Box<unflash_sound::ac3::Decoder>),
    Dts(Box<unflash_sound::dts::Decoder>),
}

#[wasm_bindgen]
impl SoundDecoder {
    /// A decoder for `codec`: `ac3` (AC-3 and E-AC-3) or `dts`.
    #[wasm_bindgen(constructor)]
    pub fn new(codec: &str) -> Result<SoundDecoder, JsValue> {
        let dec = match codec {
            "ac3" => Sound::Ac3(Box::new(unflash_sound::ac3::Decoder::new(unflash_sound::Output::Stereo))),
            "dts" => Sound::Dts(Box::new(unflash_sound::dts::Decoder::new(unflash_sound::Output::Stereo))),
            other => return Err(js_err(format!("there is no built-in sound decoder for {other}"))),
        };
        Ok(SoundDecoder { dec, out: Vec::new(), samples: 0, rate: 0 })
    }

    /// Decode `data`'s frames: every channel's samples, one plane after another.
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<f32>, JsValue> {
        for plane in &mut self.out {
            plane.clear();
        }
        let (samples, rate) = match &mut self.dec {
            Sound::Ac3(d) => (d.decode(data, &mut self.out).map_err(js_err)?.samples, d.info().map(|i| i.sample_rate)),
            Sound::Dts(d) => (d.decode(data, &mut self.out).map_err(js_err)?.samples, d.info().map(|i| i.sample_rate)),
        };
        self.samples = samples;
        if let Some(rate) = rate {
            self.rate = rate;
        }
        Ok(self.out.iter().flat_map(|p| p.iter().copied()).collect())
    }

    /// Samples each channel had in the last `decode`.
    pub fn samples(&self) -> u32 {
        self.samples as u32
    }

    /// Channels of the last `decode`'s output.
    pub fn channels(&self) -> u32 {
        self.out.len() as u32
    }

    /// The sample rate (Hz) of the last frame decoded (0 before a frame has
    /// decoded: those before came out as silence).
    pub fn sample_rate(&self) -> u32 {
        self.rate
    }
}

/// This module's memory, so JavaScript can read a picture in place
/// (`SoftDecoder::frame_ptr`).
#[wasm_bindgen]
pub fn wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}

/// The bindings natively, as a decode worker drives them (`web/softworker.js`,
/// `web/media.js`'s `decodeBuiltIn`): no JavaScript here, so only what gives
/// no error is called through the exported API; the errors' text is read
/// from `open` and the decoders themselves.
#[cfg(test)]
mod tests {
    use unflash_testkit::{expected, load, md5_hex, Stream as Film};

    use super::*;

    /// Every picture of `film` through a `SoftDecoder`: each sample goes in
    /// under its number, each picture comes back with the number of the
    /// sample that showed it. In the order shown: (sample, the MD5 of the
    /// picture as packed I420, damaged).
    fn through(codec: &str, film: &Film, shrink: Option<(u32, u32)>, mut each: impl FnMut(&SoftDecoder)) -> Vec<(u32, String, bool)> {
        let mut dec = SoftDecoder::new(codec, &film.config).unwrap();
        if let Some((aw, ah)) = shrink {
            dec.set_shrink(aw, ah);
        }
        let mut out = Vec::new();
        let mut take = |dec: &mut SoftDecoder, ready: u32| {
            for left in (0..ready).rev() {
                assert!(dec.next());
                assert_eq!(dec.ready.len() as u32, left);
                each(dec);
                // (JavaScript reads the picture in this module's memory, where these point)
                assert_eq!((dec.frame_ptr(), dec.frame_len() as usize), (dec.frame.as_ptr(), dec.frame.len()));
                out.push((dec.frame_pts(), md5_hex(&dec.frame), dec.frame_damaged()));
            }
            assert!(!dec.next(), "no more pictures than it said were ready");
            assert_eq!((dec.width(), dec.height(), dec.frame_pts(), dec.frame_damaged()), (0, 0, 0, false));
        };
        for (i, sample) in film.samples.iter().enumerate() {
            let ready = dec.decode(&sample.data, i as u32).unwrap();
            take(&mut dec, ready);
        }
        let ready = dec.flush().unwrap();
        take(&mut dec, ready);
        out.sort_by(|a, b| film.samples[a.0 as usize].pts.total_cmp(&film.samples[b.0 as usize].pts));
        out
    }

    #[test]
    fn each_decoder_gives_ffmpeg_s_pictures_through_the_bindings() {
        for (codec, path) in [("hevc", "hevc/b_pyramid.mp4"), ("hevc", "hevc/odd_size.mp4"), ("vp9", "vp9/altref.ivf"), ("vp9", "vp9/odd.ivf"), ("vp8", "vp8/altref.webm"), ("vp8", "vp8/odd.ivf"), ("av1", "av1/aom_altref_tiles.mp4"), ("av1", "av1/aom_odd.mp4")] {
            let film = load(path);
            let dec = SoftDecoder::new(codec, &film.config).unwrap();
            // HEVC's pictures come out in decoding order (under the samples that showed
            // them), as many held back as the stream says; the others' in the order shown
            match (codec, path) {
                ("hevc", "hevc/b_pyramid.mp4") => assert!((1..=15).contains(&dec.reorder_depth()), "{path}: B pictures are reordered"),
                ("hevc", _) => assert!(dec.reorder_depth() <= 15, "{path}"),
                _ => assert_eq!(dec.reorder_depth(), 0, "{path}"),
            }
            let want = expected(path);
            let mut sizes = std::collections::BTreeSet::new();
            let got = through(codec, &film, None, |d| {
                sizes.insert((d.width(), d.height(), d.frame_len()));
            });
            assert_eq!(got.len(), want.len(), "{path}: pictures");
            for (i, ((_, md5, damaged), want)) in got.iter().zip(&want).enumerate() {
                assert!(!damaged, "{path}: picture {i} damaged");
                assert_eq!(md5, want, "{path}: picture {i} is not ffmpeg's");
            }
            // every sample that shows a picture shows one, and once
            let shown: std::collections::BTreeSet<u32> = got.iter().map(|g| g.0).collect();
            assert_eq!(shown.len(), got.len(), "{path}");
            // packed I420: the luma, and two chroma planes of the size rounded up
            for (w, h, len) in sizes {
                assert_eq!(len, w * h + 2 * w.div_ceil(2) * h.div_ceil(2), "{path}: {w}x{h}");
            }
        }
    }

    #[test]
    fn pictures_made_small_are_the_whole_ones_averaged() {
        for (codec, path) in [("vp8", "vp8/smooth.ivf"), ("hevc", "hevc/intra.mp4"), ("av1", "av1/aom_altref_tiles.mp4")] {
            let film = load(path);
            // the same pictures whole, for their mean samples
            let mut whole = Vec::new();
            through(codec, &film, None, |d| {
                let p = d.cur.as_ref().unwrap();
                let mean = |plane: &[u8]| plane.iter().map(|&s| s as f64).sum::<f64>() / plane.len() as f64;
                whole.push((mean(&p.y), mean(&p.u), mean(&p.v), p.bt709, p.full_range));
            });
            let (aw, ah) = (32u32, 18u32);
            let mut small = Vec::new();
            through(codec, &film, Some((aw, ah)), |d| {
                assert_eq!(d.frame_len(), 0, "{path}: no whole picture is copied out beside the small one");
                small.push(d.small());
            });
            assert_eq!(small.len(), whole.len(), "{path}");
            for (i, (rgba, &(y, u, v, bt709, full))) in small.iter().zip(&whole).enumerate() {
                assert_eq!(rgba.len(), (aw * ah * 4) as usize, "{path}: picture {i}");
                assert!(rgba.chunks_exact(4).all(|px| px[3] == 255), "{path}: picture {i} opaque");
                let mean = |c: usize| rgba.chunks_exact(4).map(|px| px[c] as f64).sum::<f64>() / (aw * ah) as f64;
                // the picture's mean colour, converted as the stream says: a mean of clipped
                // samples is not quite the clipped mean, so to within a few codes
                let (kr, kb) = if bt709 { (0.2126, 0.0722) } else { (0.299, 0.114) };
                let (yy, cb, cr) = if full { (y, u - 128.0, v - 128.0) } else { ((y - 16.0) * 255.0 / 219.0, (u - 128.0) * 255.0 / 224.0, (v - 128.0) * 255.0 / 224.0) };
                let r = yy + 2.0 * (1.0 - kr) * cr;
                let b = yy + 2.0 * (1.0 - kb) * cb;
                let g = (yy - kr * r - kb * b) / (1.0 - kr - kb);
                for (c, want) in [r, g, b].into_iter().enumerate() {
                    assert!((mean(c) - want.clamp(0.0, 255.0)).abs() < 4.0, "{path}: picture {i} channel {c}: {} against {want}", mean(c));
                }
            }
        }
    }

    #[test]
    fn a_picture_s_colours_are_named_for_the_page() {
        let film = load("vp8/smooth.ivf");
        let mut dec = SoftDecoder::new("vp8", &film.config).unwrap();
        // before any picture: the usual guess
        assert_eq!(dec.color_json(), r#"{"fullRange":false,"matrix":"bt709","primaries":"bt709","transfer":"bt709"}"#);
        assert_eq!(dec.decode(&film.samples[0].data, 0).unwrap(), 1);
        assert!(dec.next());
        // VP8 is BT.601, limited range
        assert_eq!(dec.color_json(), r#"{"fullRange":false,"matrix":"smpte170m","primaries":"smpte170m","transfer":"smpte170m"}"#);
    }

    #[test]
    fn what_cannot_be_decoded_says_why_in_words() {
        assert_eq!(open("mpeg2", &[]).err().unwrap(), "there is no built-in decoder for mpeg2");
        assert_eq!(open("", &[]).err().unwrap(), "there is no built-in decoder for ");
        // each decoder's own error, as the page shows it
        for codec in ["hevc", "vp9", "vp8", "av1"] {
            // (without a configuration record: the samples' own headers will do)
            let mut dec = open(codec, &[]).unwrap_or_else(|e| panic!("{codec}: {e}"));
            // HEVC may reorder as far as the standard allows until a stream says less
            assert_eq!(dec.reorder_depth(), if codec == "hevc" { 15 } else { 0 }, "{codec}");
            assert!(dec.flush().unwrap().is_empty(), "{codec}");
        }
        let e = open("vp9", &[]).unwrap().decode(&[0xff, 0xff, 0xff, 0xff], 0.0).err().unwrap();
        assert!(e.starts_with("invalid VP9 data") || e.starts_with("unsupported VP9 stream"), "{e}");
        // (a key frame whose start code is not VP8's)
        let e = open("vp8", &[]).unwrap().decode(&[0x10, 0x00, 0x00, 0xff, 0xff, 0xff, 0, 0, 0, 0], 0.0).err().unwrap();
        assert!(e.starts_with("invalid VP8 data"), "{e}");
        // a stream the AV1 decoder does not turn into pictures is turned down from its
        // configuration record alone, which is what `probe` tells the page
        assert_eq!(open("av1", &load("av1/aom_444.mp4").config).err().unwrap(), "unsupported AV1 stream: 4:4:4 chroma");
        assert_eq!(open("av1", &load("av1/aom_422.mp4").config).err().unwrap(), "unsupported AV1 stream: 4:2:2 chroma");
        assert!(open("av1", &load("av1/aom_12bit.mp4").config).err().unwrap().starts_with("unsupported AV1 stream: 12-bit"));
        assert!(open("av1", &load("av1/aom_odd.mp4").config).is_ok());
    }

    #[test]
    fn dolby_and_dts_sound_come_out_as_stereo_planes() {
        for (codec, path, rate, block) in [("ac3", "ac3/ac3_stereo_44k.ac3", 44100, 1536), ("ac3", "ac3/ac3_3f2r_lfe_48k.ac3", 48000, 1536), ("ac3", "ac3/eac3_stereo_48k.eac3", 48000, 256), ("dts", "dts/dts_stereo_48k_1411k.dts", 48000, 256), ("dts", "dts/dts_5.1_48k_768k.dts", 48000, 256)] {
            let data = unflash_testkit::read(path);
            let mut dec = SoundDecoder::new(codec).unwrap();
            assert_eq!((dec.samples(), dec.channels(), dec.sample_rate()), (0, 0, 0), "{path}: nothing decoded yet");
            // (a file of whole frames is a chunk of whole frames)
            let out = dec.decode(&data).unwrap();
            assert_eq!(dec.channels(), 2, "{path}: mixed down to stereo");
            assert_eq!(dec.sample_rate(), rate, "{path}");
            assert!(dec.samples() > 0 && dec.samples().is_multiple_of(block), "{path}: {} samples", dec.samples());
            assert_eq!(out.len() as u32, dec.samples() * dec.channels(), "{path}: one plane after the other");
            assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 1.5), "{path}: samples in range");
            assert!(out.iter().any(|&s| s != 0.0) || path.contains("silence"), "{path}: not silence");
            // the next chunk starts from nothing held over in the planes
            let again = dec.decode(&data).unwrap();
            assert_eq!(again.len(), out.len(), "{path}");
        }
    }
}
