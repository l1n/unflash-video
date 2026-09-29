//! Damaged and unusual input, and the API's promises: damaged frames are
//! silence of their length and are counted, the decoder carries on, and
//! nothing in any input makes it panic (a panic aborts the WebAssembly
//! instance). Also: substreams it does not play are skipped, a layout
//! change resizes the output, `reset` forgets the overlap, the reduced
//! sample rates, and the Matroska files the app's tests use.

mod common;

use std::path::PathBuf;

use common::{fix_crcs, frames};
use unflash_ac3::{Decoded, Decoder, Error, Output};

fn media(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/media").join(name)
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(media(&format!("ac3/{name}"))).unwrap_or_else(|e| panic!("{name}: {e} (run tests/media/ac3/gen.sh)"))
}

fn decode(data: &[u8], noise: bool) -> (Result<Decoded, Error>, Vec<Vec<f32>>) {
    let mut dec = Decoder::new(Output::Native);
    dec.set_noise(noise);
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

const STREAMS: [&str; 8] = [
    "ac3_stereo_44k.ac3",
    "ac3_3f2r_lfe_48k.ac3",
    "ac3_1f_lfe_32k.ac3",
    "ac3_2f1r_lfe_44k.ac3",
    "ac3_3f2r_annex_d_48k.ac3",
    "eac3_stereo_44k_48kbps.eac3",
    "eac3_3f2r_lfe_32k_mix.eac3",
    "eac3_mono_48k.eac3",
];

#[test]
fn a_frame_with_a_flipped_bit_is_silence_of_its_length() {
    for name in STREAMS {
        let data = read(name);
        let (clean, clean_out) = decode(&data, false);
        let clean = clean.unwrap();
        let fr = frames(&data);
        let k = fr.len() / 2;
        let mut bad = data.clone();
        // a bit in the middle of frame k (its audio, not its sync word)
        let pos = (fr[k].start + fr[k].end) / 2;
        bad[pos] ^= 0x10;
        let (r, out) = decode(&bad, false);
        let r = r.unwrap();
        assert_eq!(r.damaged, 1, "{name}");
        assert_eq!(r.samples, clean.samples, "{name}: the damaged frame keeps its length");
        let spf = clean.samples / fr.len();
        for (c, (o, co)) in out.iter().zip(&clean_out).enumerate() {
            assert!(o[k * spf..(k + 1) * spf].iter().all(|&v| v == 0.0), "{name} channel {c}: not silent");
            assert_eq!(&o[..k * spf], &co[..k * spf], "{name} channel {c}: the frames before changed");
            // the next frame starts from silence (no overlap from the
            // damaged frame), its second block on is as before
            assert_eq!(&o[(k + 1) * spf + 256..], &co[(k + 1) * spf + 256..], "{name} channel {c}: the frames after changed");
        }
    }
}

#[test]
fn a_stream_cut_mid_frame_ends_with_a_damaged_frame() {
    for name in STREAMS {
        let data = read(name);
        let fr = frames(&data);
        let (clean, clean_out) = decode(&data, false);
        let spf = clean.unwrap().samples / fr.len();
        for cut in [fr[3].start + 7, fr[3].end - 1, (fr[3].start + fr[3].end) / 2] {
            let (r, out) = decode(&data[..cut], false);
            let r = r.unwrap();
            assert_eq!(r.damaged, 1, "{name} cut at {cut}");
            assert_eq!(r.samples, 4 * spf, "{name} cut at {cut}");
            for (o, co) in out.iter().zip(&clean_out) {
                assert_eq!(&o[..3 * spf], &co[..3 * spf]);
                assert!(o[3 * spf..].iter().all(|&v| v == 0.0));
            }
        }
        // cut before a whole frame's end, within its first bytes
        let (r, _) = decode(&data[..fr[2].start + 3], false);
        assert_eq!(r.unwrap().samples, 2 * spf, "{name}: three bytes are not a frame");
    }
}

#[test]
fn nothing_to_decode() {
    assert_eq!(decode(&[], true).0, Err(Error::NoSync));
    assert_eq!(decode(&[0x0b, 0x77], true).0, Err(Error::NoSync));
    let mut rng = Lcg(7);
    for size in [1, 5, 6, 100, 1000, 5000, 100_000] {
        let data: Vec<u8> = (0..size).map(|_| rng.next() as u8).collect();
        // random bytes may happen to hold a sync word and a plausible
        // header: that is a damaged frame, not an error
        match decode(&data, true) {
            (Ok(d), out) => assert!(out.iter().all(|c| c.len() == d.samples)),
            (Err(e), _) => assert_eq!(e, Error::NoSync),
        }
    }
    // a frame of a substream this decoder does not play is not enough
    let data = read("eac3_mono_48k.eac3");
    let mut other = data[frames(&data)[0].clone()].to_vec();
    other[2] = (other[2] & 0xc7) | (1 << 3); // substreamid 1
    fix_crcs(&mut other);
    assert_eq!(decode(&other, true).0, Err(Error::NoSync));
}

/// Mutations of frames whose CRCs are then made to check again, so that
/// the parser sees the damage: no panics, and a frame either decodes or
/// is silence of its length.
#[test]
fn mutated_frames_do_not_panic() {
    let mut rng = Lcg(1);
    let mut rounds = 0;
    for name in STREAMS {
        let data = read(name);
        let fr = frames(&data);
        for _ in 0..500 {
            let k = rng.below(fr.len());
            // the frame before it too, so that reused state is in play
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
                    // the header: bsid, acmod, sample rate, stream type, ...
                    let p = f0 + 2 + rng.below(8);
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
            // keep the frame's length as its header now says
            if let Some(size) = common::frame_size(&piece[f0..]) {
                if f0 + size <= piece.len() && size >= 8 {
                    piece.truncate(f0 + size);
                    fix_crcs(&mut piece[f0..]);
                }
            }
            for noise in [true, false] {
                for output in [Output::Native, Output::Stereo] {
                    let mut dec = Decoder::new(output);
                    dec.set_noise(noise);
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
    assert_eq!(rounds, 4000);
}

/// Truncations, insertions and deletions anywhere in a stream.
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
            // feed it in random pieces, as a demuxer might
            let mut pos = 0;
            while pos < d.len() {
                let n = 1 + rng.below(8000);
                let end = (pos + n).min(d.len());
                if let Ok(r) = dec.decode(&d[pos..end], &mut out) {
                    let _ = r.samples;
                }
                pos = end;
            }
            let len = out.first().map_or(0, |c| c.len());
            assert!(out.iter().all(|c| c.len() == len), "{name}");
        }
    }
}

/// Frames of dependent substreams, and of independent substreams other
/// than 0, are skipped: the output is that of substream 0 alone.
#[test]
fn other_substreams_are_skipped() {
    let main = read("eac3_stereo_48k.eac3");
    let other = read("eac3_3f2r_lfe_48k.eac3");
    let (want, want_out) = decode(&main, false);
    let mf = frames(&main);
    let of = frames(&other);
    let mut mixed = Vec::new();
    let mut extra = 0;
    for (i, m) in mf.iter().enumerate() {
        mixed.extend_from_slice(&main[m.clone()]);
        let o = &of[i % of.len()];
        // an independent substream 1 (same syntax), and a dependent one
        // (strmtyp 1: its syntax differs, but it is only skipped)
        for header in [0b00_001u8, 0b01_000] {
            let mut f = other[o.clone()].to_vec();
            f[2] = (f[2] & 0x07) | header << 3;
            fix_crcs(&mut f);
            mixed.extend_from_slice(&f);
            extra += 1;
        }
    }
    let mut dec = Decoder::new(Output::Native);
    dec.set_noise(false);
    let mut out = Vec::new();
    let got = dec.decode(&mixed, &mut out).unwrap();
    assert_eq!(got, want.unwrap());
    assert_eq!(out, want_out);
    assert_eq!(dec.features().1, extra);
}

/// A stream whose layout changes: `out` follows the latest frame's layout,
/// new channels starting with silence, every channel as long as the rest.
#[test]
fn a_layout_change_resizes_the_output() {
    let stereo = read("eac3_stereo_48k.eac3");
    let five = read("ac3_3f2r_lfe_48k.ac3");
    let mono = read("ac3_mono_48k.ac3");
    let (s, s_out) = decode(&stereo, false);
    let (f, _) = decode(&five, false);
    let (s, f) = (s.unwrap().samples, f.unwrap().samples);
    let mut both = stereo.clone();
    both.extend_from_slice(&five);
    let (r, out) = decode(&both, false);
    assert_eq!(r.unwrap().samples, s + f);
    assert_eq!(out.len(), 6);
    assert!(out.iter().all(|c| c.len() == s + f));
    assert_eq!(&out[0][..s], &s_out[0][..]);
    assert_eq!(&out[1][..s], &s_out[1][..]);
    assert!(out[2..].iter().all(|c| c[..s].iter().all(|&v| v == 0.0)));
    assert!(out[5][s..].iter().any(|&v| v != 0.0));
    // and back down to one channel, in a later call
    let mut dec = Decoder::new(Output::Native);
    let mut out = Vec::new();
    dec.decode(&both, &mut out).unwrap();
    let d = dec.decode(&mono, &mut out).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].len(), s + f + d.samples);
    assert_eq!(dec.info().unwrap().channels, 1);
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

/// Decoding frame by frame gives what decoding all at once gives, and
/// `reset` starts the next frame from silence.
#[test]
fn frame_by_frame_and_reset() {
    for name in STREAMS {
        let data = read(name);
        let (_, all) = decode(&data, false);
        let fr = frames(&data);
        let mut dec = Decoder::new(Output::Native);
        dec.set_noise(false);
        let mut out = Vec::new();
        for f in &fr {
            dec.decode(&data[f.clone()], &mut out).unwrap();
        }
        assert_eq!(out, all, "{name}");
        // after reset, frame k decodes as if it were the first
        let k = fr.len() / 2;
        let mut dec = Decoder::new(Output::Native);
        dec.set_noise(false);
        let mut before = Vec::new();
        dec.decode(&data[fr[0].start..fr[k].start], &mut before).unwrap();
        dec.reset();
        let mut after = Vec::new();
        dec.decode(&data[fr[k].clone()], &mut after).unwrap();
        let (_, fresh) = decode(&data[fr[k].clone()], false);
        assert_eq!(after, fresh, "{name}");
    }
}

/// E-AC-3's reduced sample rates (fscod 3 with fscod2: 24, 22.05, 16
/// kHz) are the full rates' syntax at half the rate. Rewriting the rate
/// codes of streams at 48, 44.1 and 32 kHz gives streams of the reduced
/// rates that decode to the same samples, at half the rate. (No reference
/// decodes these: ffmpeg 6.1 says "Reduced sampling rate is not
/// implemented". That the bit allocation's hearing threshold is fscod2's
/// table is this decoder's reading; the standard does not say.)
#[test]
fn reduced_sample_rates() {
    for (name, fscod2, rate) in [("eac3_stereo_48k.eac3", 0u8, 24000), ("eac3_stereo_44k_48kbps.eac3", 1, 22050), ("eac3_3f2r_lfe_32k_mix.eac3", 2, 16000)] {
        let data = read(name);
        let mut half = data.clone();
        for f in frames(&data) {
            let frame = &mut half[f];
            assert_eq!(frame[4] >> 4 & 3, 3, "six blocks per frame");
            // fscod 3, then fscod2 where numblkscod was
            frame[4] = (frame[4] & 0x0f) | 0xc0 | fscod2 << 4;
            fix_crcs(frame);
        }
        let (full, full_out) = decode(&data, false);
        let mut dec = Decoder::new(Output::Native);
        dec.set_noise(false);
        let mut out = Vec::new();
        let r = dec.decode(&half, &mut out).unwrap();
        assert_eq!(r, full.unwrap(), "{name}");
        assert_eq!(dec.info().unwrap().sample_rate, rate);
        assert_eq!(unflash_ac3::probe(&half).unwrap().sample_rate, rate);
        assert_eq!(out, full_out, "{name}");
    }
}

/// The app's Matroska test files: blocks as the demuxer hands them over
/// (with the bytes header stripping left out put back), against ffmpeg's
/// decode of the file.
#[test]
fn matroska_blocks() {
    for (file, eac3) in [("mkv/h264_ac3.mkv", false), ("mkv/h264_eac3.mkv", true)] {
        let Ok(data) = std::fs::read(media(file)) else {
            eprintln!("SKIPPED matroska_blocks for {file}: not there (tests/media/gen.sh makes it)");
            continue;
        };
        let movie = unflash_mp4::demux::parse_bytes(&data).unwrap();
        let track = movie.audio().expect("an audio track");
        let mut dec = Decoder::new(Output::Native);
        dec.set_noise(false);
        dec.set_trace(true);
        let mut quiet = Vec::new();
        let mut noisy_dec = Decoder::new(Output::Native);
        noisy_dec.set_trace(true);
        let mut noisy = Vec::new();
        for s in &track.samples {
            let mut block = track.prefix.clone();
            block.extend_from_slice(&data[s.offset as usize..s.offset as usize + s.size as usize]);
            let d = dec.decode(&block, &mut quiet).unwrap();
            assert_eq!(d.damaged, 0, "{file}");
            noisy_dec.decode(&block, &mut noisy).unwrap();
        }
        let info = dec.info().unwrap();
        assert_eq!((info.eac3, info.sample_rate, info.channels), (eac3, track.sample_rate, track.channels as usize), "{file}");
        if !common::ffmpeg_available() {
            eprintln!("SKIPPED the comparison with ffmpeg for {file}: ffmpeg is not installed");
            continue;
        }
        let reference = common::ffmpeg_decode(&media(file), &["-map", "0:a"]).expect("ffmpeg decodes the file");
        assert_eq!(reference[0].len(), quiet[0].len(), "{file}: length");
        let trace = noisy_dec.take_trace();
        let map: Vec<Option<usize>> = (0..reference.len()).map(Some).collect();
        for (c, s) in common::compare(&quiet, &noisy, &trace, &reference, &map).iter().enumerate() {
            eprintln!("{file} channel {c}: {}", common::describe(s));
            assert!(s.bins > 1000 && s.over == 0, "{file} channel {c}");
        }
    }
}

fn rms(v: &[f32]) -> f64 {
    (v.iter().map(|&x| (x as f64).powi(2)).sum::<f64>() / v.len().max(1) as f64).sqrt()
}

/// 1+1 dual mono, which ffmpeg's encoder does not make: frames built
/// here, with dither in Ch1 only and a dynamic range word for Ch2.
#[test]
fn dual_mono() {
    let data = common::dual_mono_frames(20, 10, 0x40);
    assert_eq!(unflash_ac3::probe(&data).unwrap(), unflash_ac3::StreamInfo { sample_rate: 48000, channels: 2, eac3: false, acmod: 0, lfe: false });
    let (r, out) = decode(&data, true);
    let r = r.unwrap();
    assert_eq!((r.samples, r.damaged), (20 * 1536, 0));
    assert_eq!(out.len(), 2);
    assert!(out[1].iter().all(|&v| v == 0.0), "Ch2 is not dithered");
    let level = rms(&out[0]);
    assert!(level > 1e-5, "Ch1 is dithered: {level}");
    // Stereo output: Ch1 left, Ch2 right
    let mut dec = Decoder::new(Output::Stereo);
    let mut stereo = Vec::new();
    dec.decode(&data, &mut stereo).unwrap();
    assert_eq!(stereo, out);
    let mut dec = Decoder::new(Output::Native);
    dec.set_noise(false);
    let mut quiet = Vec::new();
    dec.decode(&data, &mut quiet).unwrap();
    assert!(quiet.iter().flatten().all(|&v| v == 0.0));
    if common::ffmpeg_available() {
        let path = std::env::temp_dir().join(format!("unflash-ac3-dual-{}.ac3", std::process::id()));
        std::fs::write(&path, &data).unwrap();
        let reference = common::ffmpeg_decode(&path, &[]).expect("ffmpeg decodes dual mono");
        let _ = std::fs::remove_file(&path);
        assert_eq!(reference.len(), 2);
        assert_eq!(reference[0].len(), out[0].len());
        assert!(reference[1].iter().all(|&v| v == 0.0), "ffmpeg's Ch2");
        let ratio = rms(&reference[0]) / level;
        eprintln!("dual mono Ch1 dither: ffmpeg's is {ratio:.3} times ours ({level:.2e})");
        assert!((0.9..=1.1).contains(&ratio), "{ratio}");
    }
}

/// E-AC-3 frames of one, two and three blocks, which ffmpeg's encoder does
/// not make: 256 samples a block, and noise as loud as ffmpeg's.
#[test]
fn eac3_frames_of_one_two_and_three_blocks() {
    for blocks in [1, 2, 3, 6] {
        let data = common::eac3_frames(40, blocks, 9);
        let (r, out) = decode(&data, true);
        let r = r.unwrap();
        assert_eq!((r.samples, r.damaged), (40 * 256 * blocks, 0), "{blocks} blocks");
        let level = rms(&out[0]);
        assert!(level > 1e-5, "{blocks} blocks: dithered");
        if common::ffmpeg_available() {
            let path = std::env::temp_dir().join(format!("unflash-ac3-{blocks}-{}.eac3", std::process::id()));
            std::fs::write(&path, &data).unwrap();
            let reference = common::ffmpeg_decode(&path, &[]).expect("ffmpeg decodes it");
            let _ = std::fs::remove_file(&path);
            assert_eq!(reference[0].len(), out[0].len(), "{blocks} blocks");
            for c in 0..2 {
                let ratio = rms(&reference[c]) / rms(&out[c]);
                eprintln!("{blocks} blocks, channel {c}: ffmpeg's dither is {ratio:.3} times ours");
                assert!((0.9..=1.1).contains(&ratio), "{blocks} blocks: {ratio}");
            }
        }
    }
}
