//! Damaged and unusual input, and the API's promises: frames that do not
//! parse are silence of their length and are counted, the decoder carries
//! on, and nothing in any input makes it panic (a panic aborts the
//! WebAssembly instance). Also: DTS-HD extension substreams are stepped
//! over and a chunk of nothing else says there is no core, a layout
//! change resizes the output, `reset` forgets the history, the dynamic
//! range coefficients on request, and the frames ffmpeg does not play
//! (termination frames, the six-channel arrangements, V1.2.1's downmix
//! indexes) or that the standard mutes.

mod common;

use std::path::PathBuf;

use common::{frames, write_frame, Band, Channel, Frame, Subframe};
use unflash_dts::{Decoded, Decoder, Error, Output};

fn media(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/media/dts").join(name)
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(media(name)).unwrap_or_else(|e| panic!("{name}: {e} (run tests/media/dts/gen.sh)"))
}

fn decode(data: &[u8]) -> (Result<Decoded, Error>, Vec<Vec<f32>>) {
    let mut dec = Decoder::new(Output::Native);
    let mut out = Vec::new();
    let r = dec.decode(data, &mut out);
    (r, out)
}

/// A small deterministic generator for the damage done below.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

const STREAMS: [&str; 5] = ["dts_stereo_44k_384k.dts", "dts_5.1_48k_768k.dts", "dts_mono_22k_320k.dts", "dts_quad_48k_640k.dts", "dts_5.1_48k_adpcm.dts"];

/// The bit position of channel 0's SHUFF in a frame of ffmpeg's encoder
/// (no CRC words): after the header's 104 bits, SUBFS, PCHS and, per
/// channel, SUBS, VQSUB, JOINX and THUFF.
fn shuff_bit(channels: usize) -> usize {
    104 + 4 + 3 + channels * (5 + 5 + 3 + 2)
}

/// A frame that does not parse (here: scale factor code book 7) is
/// silence of its length; the frames before are as they were, and the
/// ones after too once the filter banks' history has refilled (one frame
/// of 512 samples; ADPCM prediction may carry the difference further).
#[test]
fn a_frame_that_does_not_parse_is_silence_of_its_length() {
    for name in STREAMS {
        let data = read(name);
        let (clean, clean_out) = decode(&data);
        let clean = clean.unwrap();
        let fr = frames(&data);
        let k = fr.len() / 2;
        let mut bad = data.clone();
        let at = fr[k].start * 8 + shuff_bit(clean_out.len() - name.contains("5.1") as usize);
        for bit in at..at + 3 {
            bad[bit / 8] |= 0x80 >> (bit % 8);
        }
        let (r, out) = decode(&bad);
        let r = r.unwrap();
        assert_eq!(r.damaged, 1, "{name}");
        assert_eq!(r.samples, clean.samples, "{name}: the damaged frame keeps its length");
        let spf = clean.samples / fr.len();
        for (c, (o, co)) in out.iter().zip(&clean_out).enumerate() {
            assert!(o[k * spf..(k + 1) * spf].iter().all(|&v| v == 0.0), "{name} channel {c}: not silent");
            assert_eq!(&o[..k * spf], &co[..k * spf], "{name} channel {c}: the frames before changed");
            if !name.contains("adpcm") {
                assert_eq!(&o[(k + 2) * spf..], &co[(k + 2) * spf..], "{name} channel {c}: the frames after changed");
            }
        }
    }
}

#[test]
fn a_stream_cut_mid_frame_ends_with_a_damaged_frame() {
    for name in STREAMS {
        let data = read(name);
        let fr = frames(&data);
        let (clean, clean_out) = decode(&data);
        let spf = clean.unwrap().samples / fr.len();
        for cut in [fr[3].start + 40, fr[3].end - 1, (fr[3].start + fr[3].end) / 2] {
            let (r, out) = decode(&data[..cut]);
            let r = r.unwrap();
            assert_eq!(r.damaged, 1, "{name} cut at {cut}");
            assert_eq!(r.samples, 4 * spf, "{name} cut at {cut}");
            for (o, co) in out.iter().zip(&clean_out) {
                assert_eq!(&o[..3 * spf], &co[..3 * spf]);
                assert!(o[3 * spf..].iter().all(|&v| v == 0.0));
            }
        }
        // cut within a frame's first bytes, before its header ends
        let (r, _) = decode(&data[..fr[2].start + 5]);
        assert_eq!(r.unwrap().samples, 2 * spf, "{name}: five bytes are not a frame");
    }
}

/// A DTS-HD extension substream frame of `size` bytes (clause 7.5.2) with
/// a header whose CRC checks and random contents.
fn substream(rng: &mut Lcg, size: usize) -> Vec<u8> {
    let header = 16;
    let mut w = common::BitWriter::default();
    w.put(32, 0x64582025);
    w.put(8, 0); // UserDefinedBits
    w.put(2, 0); // nExtSSIndex
    w.put(1, 0); // bHeaderSizeType: short
    w.put(8, header as u32 - 1);
    w.put(16, size as u32 - 1);
    w.put(1, 0); // bStaticFieldsPresent
    w.align(8);
    let mut v = w.bytes;
    v.resize(header - 2, 0);
    let crc = unflash_dts::testing::crc16(&v[5..]);
    v.extend_from_slice(&crc.to_be_bytes());
    v.extend((header..size).map(|_| rng.next() as u8));
    v
}

#[test]
fn nothing_to_decode() {
    assert_eq!(decode(&[]).0, Err(Error::NoSync));
    assert_eq!(decode(&[0x7f, 0xfe, 0x80, 0x01, 0xfc, 0x3c]).0, Err(Error::NoSync));
    let mut rng = Lcg(7);
    for size in [1, 5, 6, 100, 1000, 5000, 100_000] {
        let data: Vec<u8> = (0..size).map(|_| rng.next() as u8).collect();
        // random bytes may happen to hold a sync word and a plausible
        // header: that is a damaged frame, not an error
        match decode(&data) {
            (Ok(d), out) => assert!(out.iter().all(|c| c.len() == d.samples)),
            (Err(e), _) => assert_eq!(e, Error::NoSync),
        }
    }
    // extension substreams alone: DTS-HD Master Audio or DTS Express
    // without a core
    let mut data = Vec::new();
    for _ in 0..3 {
        data.extend(substream(&mut rng, 300));
    }
    assert_eq!(decode(&data).0, Err(Error::NoCore));
    assert_eq!(unflash_dts::probe(&data), Err(Error::NoCore));
    assert!(Error::NoCore.to_string().contains("without a core"));
}

/// Extension substreams after the core frames (DTS-HD High Resolution
/// Audio and Master Audio with a core), aligned to four bytes with zeros,
/// and core frames alone decode to the same samples, all at once or a
/// frame at a time; handed over apart from their cores, the substreams
/// give no samples and no error.
#[test]
fn substreams_are_stepped_over() {
    let mut rng = Lcg(5);
    for name in ["dts_5.1_48k_768k.dts", "dts_stereo_44k_384k.dts"] {
        let data = read(name);
        let (want, want_out) = decode(&data);
        let mut mixed = Vec::new();
        let (mut starts, mut cores) = (Vec::new(), Vec::new());
        let fr = frames(&data);
        for f in &fr {
            starts.push(mixed.len());
            mixed.extend_from_slice(&data[f.clone()]);
            while mixed.len() % 4 != 0 {
                mixed.push(0);
            }
            cores.push(mixed.len());
            let size = 100 + rng.below(3000);
            mixed.extend(substream(&mut rng, size));
        }
        starts.push(mixed.len());
        let mut dec = Decoder::new(Output::Native);
        let mut out = Vec::new();
        let got = dec.decode(&mixed, &mut out).unwrap();
        assert_eq!(got, want.unwrap(), "{name}");
        assert_eq!(out, want_out, "{name}");
        assert_eq!(dec.features().1, fr.len() as u64);
        // and a chunk at a time: a core frame and its substream
        let mut dec = Decoder::new(Output::Native);
        let mut out = Vec::new();
        for w in starts.windows(2) {
            dec.decode(&mixed[w[0]..w[1]], &mut out).unwrap();
        }
        assert_eq!(out, want_out, "{name}");
        // and each substream apart from its core
        let mut dec = Decoder::new(Output::Native);
        let mut out = Vec::new();
        for (k, w) in starts.windows(2).enumerate() {
            dec.decode(&mixed[w[0]..cores[k]], &mut out).unwrap();
            assert_eq!(dec.decode(&mixed[cores[k]..w[1]], &mut out), Ok(Decoded::default()), "{name}");
        }
        assert_eq!(out, want_out, "{name}");
    }
}

/// Mutations of frames: no panics, every channel as long as the others,
/// every sample finite; a frame either decodes or is silence.
#[test]
fn mutated_frames_do_not_panic() {
    let mut rng = Lcg(1);
    let mut rounds = 0;
    for name in STREAMS {
        let data = read(name);
        let fr = frames(&data);
        for _ in 0..400 {
            let k = rng.below(fr.len());
            // the frame before it too, so that the history is in play
            let start = fr[k.saturating_sub(1)].start;
            let mut piece = data[start..fr[k].end].to_vec();
            let f0 = fr[k].start - start;
            let len = fr[k].len();
            match rng.below(6) {
                0 => {
                    for _ in 0..1 + rng.below(8) {
                        let p = f0 + 5 + rng.below(len - 5);
                        piece[p] ^= 1 << rng.below(8);
                    }
                }
                1 => {
                    let p = f0 + 5 + rng.below(len - 5);
                    let n = 1 + rng.below(40);
                    for b in piece.iter_mut().skip(p).take(n) {
                        *b = rng.next() as u8;
                    }
                }
                2 => {
                    // the headers: size, arrangement, rate, flags, the
                    // coding header
                    let p = f0 + 4 + rng.below(24);
                    piece[p] ^= 1 << rng.below(8);
                }
                3 => {
                    let p = f0 + 5 + rng.below(len - 5);
                    let v = if rng.below(2) == 0 { 0 } else { 0xff };
                    for b in piece.iter_mut().skip(p).take(1 + rng.below(64)) {
                        *b = v;
                    }
                }
                4 => {
                    // shift the frame's data by some bits
                    let p = f0 + 5 + rng.below(len - 6);
                    let s = 1 + rng.below(7);
                    for i in (p..f0 + len - 1).rev() {
                        piece[i] = piece[i] >> s | piece[i - 1] << (8 - s);
                    }
                }
                _ => {
                    for b in piece.iter_mut().skip(f0 + 5) {
                        if rng.below(20) == 0 {
                            *b = rng.next() as u8;
                        }
                    }
                }
            }
            for output in [Output::Native, Output::Stereo] {
                for drc in [false, true] {
                    let mut dec = Decoder::new(output);
                    dec.set_dynamic_range(drc);
                    let mut out = Vec::new();
                    if let Ok(d) = dec.decode(&piece, &mut out) {
                        assert!(out.iter().all(|c| c.len() == d.samples), "{name}: channels of unequal length");
                        assert!(out.iter().flatten().all(|v| v.is_finite()), "{name}: not finite");
                    }
                }
            }
            rounds += 1;
        }
    }
    assert_eq!(rounds, 2000);
}

/// Truncations, insertions and deletions anywhere in a stream, fed in
/// random pieces.
#[test]
fn damaged_streams_do_not_panic() {
    let mut rng = Lcg(3);
    for name in STREAMS {
        let data = read(name);
        for _ in 0..60 {
            let mut d = data.clone();
            match rng.below(4) {
                0 => d.truncate(rng.below(d.len())),
                1 => {
                    let p = rng.below(d.len());
                    let n = rng.below(3000).min(d.len() - p);
                    d.drain(p..p + n);
                }
                2 => {
                    let p = rng.below(d.len());
                    let junk: Vec<u8> = (0..rng.below(2000)).map(|_| rng.next() as u8).collect();
                    d.splice(p..p, junk);
                }
                _ => {
                    for _ in 0..20 {
                        let p = rng.below(d.len());
                        d[p] = rng.next() as u8;
                    }
                }
            }
            let mut dec = Decoder::new(Output::Native);
            let mut out = Vec::new();
            let mut pos = 0;
            while pos < d.len() {
                let n = 1 + rng.below(8000);
                let end = (pos + n).min(d.len());
                let _ = dec.decode(&d[pos..end], &mut out);
                pos = end;
            }
            let len = out.first().map_or(0, |c| c.len());
            assert!(out.iter().all(|c| c.len() == len), "{name}");
            assert!(out.iter().flatten().all(|v| v.is_finite()), "{name}");
        }
    }
}

/// A stream whose layout changes: `out` follows the latest frame's layout,
/// new channels starting with silence, every channel as long as the rest.
#[test]
fn a_layout_change_resizes_the_output() {
    let stereo = read("dts_stereo_44k_384k.dts");
    let five = read("dts_5.1_48k_768k.dts");
    let mono = read("dts_mono_22k_320k.dts");
    let (s, s_out) = decode(&stereo);
    let (f, _) = decode(&five);
    let (s, f) = (s.unwrap().samples, f.unwrap().samples);
    let mut both = stereo.clone();
    both.extend_from_slice(&five);
    let (r, out) = decode(&both);
    assert_eq!(r.unwrap().samples, s + f);
    assert_eq!(out.len(), 6);
    assert!(out.iter().all(|c| c.len() == s + f));
    assert_eq!(&out[0][..s], &s_out[0][..]);
    assert_eq!(&out[1][..s], &s_out[1][..]);
    assert!(out[2..].iter().all(|c| c[..s].iter().all(|&v| v == 0.0)));
    assert!(out[5][s..].iter().any(|&v| v != 0.0));
    // and down to one channel, in a later call
    let mut dec = Decoder::new(Output::Native);
    let mut out = Vec::new();
    dec.decode(&both, &mut out).unwrap();
    let d = dec.decode(&mono, &mut out).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].len(), s + f + d.samples);
    let info = dec.info().unwrap();
    assert_eq!((info.channels, info.sample_rate), (1, 22050));
    // Stereo stays stereo; mono becomes two identical channels
    let mut dec = Decoder::new(Output::Stereo);
    let mut out = Vec::new();
    dec.decode(&both, &mut out).unwrap();
    let d = dec.decode(&mono, &mut out).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].len(), out[1].len());
    let n = out[0].len();
    assert_eq!(&out[0][n - d.samples..], &out[1][n - d.samples..]);
}

/// Decoding frame by frame (as the blocks of a Matroska track or the
/// samples of an MP4 one come) gives what decoding all at once gives, and
/// after `reset` a frame decodes as if it were the first.
#[test]
fn frame_by_frame_and_reset() {
    for name in STREAMS {
        let data = read(name);
        let (_, all) = decode(&data);
        let fr = frames(&data);
        let mut dec = Decoder::new(Output::Native);
        let mut out = Vec::new();
        for f in &fr {
            dec.decode(&data[f.clone()], &mut out).unwrap();
        }
        assert_eq!(out, all, "{name}");
        let k = fr.len() / 2;
        let mut dec = Decoder::new(Output::Native);
        let mut before = Vec::new();
        dec.decode(&data[fr[0].start..fr[k].start], &mut before).unwrap();
        dec.reset();
        let mut after = Vec::new();
        dec.decode(&data[fr[k].clone()], &mut after).unwrap();
        let (_, fresh) = decode(&data[fr[k].clone()]);
        assert_eq!(after, fresh, "{name}");
    }
}

/// A frame of `nch` channels of arrangement `amode`: in each subframe,
/// channel c has 12-bit plain samples in subband c + 1 only (all others
/// silent), `nssc` subsubframes each.
fn tone_frame(rng: &mut Lcg, amode: u8, nch: usize, subframes: usize, nssc: usize) -> Frame {
    let mut f = Frame { amode, ..Default::default() };
    f.channels = vec![Channel::default(); nch];
    for _ in 0..subframes {
        let mut s = Subframe { nssc, ..Default::default() };
        s.bands = (0..nch)
            .map(|c| {
                (0..32)
                    .map(|n| {
                        let on = n == c + 1;
                        Band {
                            abits: if on { 12 } else { 0 },
                            scales: [70, 0],
                            levels: (0..8 * nssc).map(|_| if on { rng.below(400) as i32 - 200 } else { 0 }).collect(),
                            ..Default::default()
                        }
                    })
                    .collect()
            })
            .collect();
        s.down = vec![[5, 9]; nch];
        s.range = rng.below(256) as u8;
        f.subframes.push(s);
    }
    f
}

fn rms(v: &[f32]) -> f64 {
    (v.iter().map(|&x| (x as f64).powi(2)).sum::<f64>() / v.len().max(1) as f64).sqrt()
}

/// With `set_dynamic_range(true)`, each subframe's samples of the primary
/// channels are those without, times its RANGE (D.4); by default the
/// coefficients are ignored, as ffmpeg's decoder ignores them.
#[test]
fn dynamic_range_on_request() {
    let mut rng = Lcg(11);
    let mut data = Vec::new();
    let mut ranges = Vec::new();
    for _ in 0..4 {
        let mut f = tone_frame(&mut rng, 2, 2, 2, 2);
        f.dynf = true;
        ranges.extend(f.subframes.iter().map(|s| s.range));
        data.extend(write_frame(&f));
    }
    let (_, plain) = decode(&data);
    let mut dec = Decoder::new(Output::Native);
    dec.set_dynamic_range(true);
    let mut out = Vec::new();
    dec.decode(&data, &mut out).unwrap();
    assert!(dec.features().0.dynamic_range);
    for (s, &range) in ranges.iter().enumerate() {
        let gain = 10f64.powf((range as f64 - 127.0) / 80.0);
        for c in 0..2 {
            for i in 512 * s..512 * (s + 1) {
                let want = plain[c][i] as f64 * gain;
                assert!((out[c][i] as f64 - want).abs() <= 1e-6 * want.abs().max(1e-3), "subframe {s} channel {c} sample {i}");
            }
        }
    }
    // (without it, frames with and without the coefficients alike)
    let mut no_drc = Vec::new();
    let mut rng = Lcg(11);
    for _ in 0..4 {
        no_drc.extend(write_frame(&tone_frame(&mut rng, 2, 2, 2, 2)));
    }
    assert_eq!(decode(&no_drc).1, plain);
}

/// Encoder revisions above 7 are muted, as Table 5-16 asks (ffmpeg 6.1
/// plays them), and so are arrangements of more than six channels: silence
/// of the frame's length, counted as damaged.
#[test]
fn what_the_standard_mutes_is_silence() {
    let mut rng = Lcg(13);
    for (amode, vernum) in [(2u8, 8u8), (2, 15), (13, 7), (15, 7)] {
        let nch = unflash_dts::testing::AMODE_CHANNELS[amode as usize];
        let mut data = Vec::new();
        for _ in 0..3 {
            let mut f = tone_frame(&mut rng, amode, nch.min(8), 1, 2);
            f.vernum = vernum;
            data.extend(write_frame(&f));
        }
        let (r, out) = decode(&data);
        let r = r.unwrap();
        assert_eq!((r.samples, r.damaged), (3 * 512, 3), "AMODE {amode} VERNUM {vernum}");
        assert!(out.iter().flatten().all(|&v| v == 0.0));
        assert!(matches!(unflash_dts::probe(&data), Err(Error::Unsupported(_))));
    }
}

/// The arrangements of six primary channels (AMODE 10 to 12), which
/// ffmpeg 6.1 does not decode, come out in WAVE order: each channel's
/// own subband ends up in its place.
#[test]
fn six_channel_arrangements() {
    let mut rng = Lcg(17);
    // the coded channel at each WAVE position (the LFE after the fronts)
    for (amode, order) in [(10u8, [2usize, 3, 6, 0, 1, 4, 5]), (11, [1, 2, 0, 6, 3, 4, 5]), (12, [2, 3, 0, 6, 4, 5, 1])] {
        let mut f = tone_frame(&mut rng, amode, 6, 2, 2);
        f.lff = 2;
        for s in f.subframes.iter_mut() {
            s.lfe = vec![0; 8];
            s.lfe[0] = 100;
            s.lfe_scale = 60;
        }
        let data = write_frame(&f);
        let mut dec = Decoder::new(Output::Native);
        let mut out = Vec::new();
        let d = dec.decode(&data, &mut out).unwrap();
        assert_eq!((d.samples, d.damaged, out.len()), (1024, 0, 7), "AMODE {amode}");
        // coded channel c is a tone in subband c + 1: its energy is in
        // the frequencies of that subband
        for (pos, &coded) in order.iter().enumerate() {
            let x = &out[pos];
            assert!(rms(x) > 1e-4, "AMODE {amode} position {pos}");
            if coded < 6 {
                // correlate with a sinusoid at the subband's centre
                let f0 = (coded as f64 + 1.5) / 64.0;
                let (mut a, mut b) = (0.0, 0.0);
                for (i, &v) in x.iter().enumerate() {
                    let ph = 2.0 * std::f64::consts::PI * f0 * i as f64;
                    a += v as f64 * ph.cos();
                    b += v as f64 * ph.sin();
                }
                let band_level = (a * a + b * b).sqrt() / x.len() as f64;
                let others = (0..6).filter(|&o| o != coded).map(|o| {
                    let f1 = (o as f64 + 1.5) / 64.0;
                    let (mut a, mut b) = (0.0, 0.0);
                    for (i, &v) in x.iter().enumerate() {
                        let ph = 2.0 * std::f64::consts::PI * f1 * i as f64;
                        a += v as f64 * ph.cos();
                        b += v as f64 * ph.sin();
                    }
                    (a * a + b * b).sqrt() / x.len() as f64
                });
                let other = others.fold(0f64, f64::max);
                assert!(band_level > 0.0 && other < band_level, "AMODE {amode} position {pos}: coded channel {coded}");
            }
        }
        let mut dec = Decoder::new(Output::Stereo);
        let mut stereo = Vec::new();
        dec.decode(&data, &mut stereo).unwrap();
        assert_eq!(stereo.len(), 2);
        assert!(stereo.iter().flatten().all(|v| v.is_finite()) && rms(&stereo[0]) > 1e-5);
    }
}

/// Termination frames (FTYPE 0, a deficit sample count) decode like
/// normal ones (ffmpeg 6.1 refuses them), and the reserved bit after RATE
/// (V1.2.1's embedded downmix flag) makes the decoder step over the two
/// downmix indexes per channel V1.2.1 put in each subframe (ffmpeg 6.1
/// refuses those frames too).
#[test]
fn termination_frames_and_old_downmix_indexes() {
    let mut rng = Lcg(19);
    let frame = tone_frame(&mut rng, 9, 5, 2, 2);
    let (_, want) = decode(&write_frame(&frame));
    let mut term = frame.clone();
    term.normal = false;
    term.deficit = 11;
    let (r, out) = decode(&write_frame(&term));
    assert_eq!(r.unwrap().damaged, 0);
    assert_eq!(out, want);
    let mut old = frame.clone();
    old.fixed_bit = true;
    let (r, out) = decode(&write_frame(&old));
    assert_eq!(r.unwrap().damaged, 0);
    assert_eq!(out, want);
}
