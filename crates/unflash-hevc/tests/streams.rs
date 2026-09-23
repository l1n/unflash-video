//! Bit-exactness against ffmpeg: every stream in tests/media/hevc decodes
//! to the per-frame MD5s ffmpeg's decoder produced (`gen.sh`), and the
//! decoder survives damaged copies of them.

use std::path::PathBuf;

use unflash_hevc::{Decoder, Error, Frame};
use unflash_mp4::demux::parse_bytes;

fn media(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/media/hevc").join(name)
}

/// The MP4 file's parameter sets and samples.
fn samples(name: &str) -> (Vec<u8>, Vec<(Vec<u8>, f64)>) {
    let data = std::fs::read(media(&format!("{name}.mp4"))).expect("run tests/media/hevc/gen.sh");
    let movie = parse_bytes(&data).unwrap();
    let track = movie.video().unwrap();
    let samples = track.samples.iter().map(|s| (data[s.offset as usize..(s.offset + s.size as u64) as usize].to_vec(), s.pts as f64)).collect();
    (track.description.clone().unwrap(), samples)
}

/// The MD5 of a picture as ffmpeg's framemd5 hashes it: the 8-bit planes,
/// or the 16-bit little-endian ones above 8 bits.
fn md5(f: &Frame) -> String {
    let mut ctx = md5::Context::new();
    match (&f.y16, &f.u16, &f.v16) {
        (Some(y), Some(u), Some(v)) => {
            for p in [y, u, v] {
                let bytes: Vec<u8> = p.iter().flat_map(|s| s.to_le_bytes()).collect();
                ctx.consume(&bytes);
            }
        }
        _ => {
            ctx.consume(&f.y);
            ctx.consume(&f.u);
            ctx.consume(&f.v);
        }
    }
    format!("{:x}", ctx.compute())
}

/// Decode a file; every picture in presentation order.
fn decode(name: &str, fast: bool) -> Result<Vec<Frame>, Error> {
    let (config, samples) = samples(name);
    let mut dec = Decoder::new(&config)?;
    dec.set_fast(fast);
    let mut frames = Vec::new();
    for (bytes, pts) in &samples {
        let got = dec.decode(bytes, *pts)?;
        assert!(got.iter().all(|f| f.pts == *pts), "{name}: a picture without its sample's timestamp");
        frames.extend(got);
    }
    frames.extend(dec.flush()?);
    frames.sort_by(|a, b| a.pts.total_cmp(&b.pts));
    Ok(frames)
}

fn expected(name: &str) -> Vec<String> {
    let text = std::fs::read_to_string(media(&format!("{name}.framemd5"))).unwrap();
    text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).map(|l| l.rsplit(',').next().unwrap().trim().to_string()).collect()
}

fn check(name: &str) {
    let got = decode(name, false).unwrap_or_else(|e| panic!("{name}: {e}"));
    let want = expected(name);
    assert_eq!(got.len(), want.len(), "{name}: frame count");
    for (i, (g, w)) in got.iter().zip(&want).enumerate() {
        assert!(!g.damaged, "{name}: damaged frame {i}");
        assert_eq!(&md5(g), w, "{name}: frame {i} differs from ffmpeg");
    }
}

#[test]
fn intra_no_loop_filters() {
    check("intra");
}
#[test]
fn intra_deblocking_sao_strong_smoothing() {
    check("intra_filters");
}
#[test]
fn p_pictures_deep_transform_trees() {
    check("p_frames");
}
#[test]
fn b_pyramid_merge_candidates() {
    check("b_pyramid");
}
#[test]
fn explicit_weighted_prediction() {
    check("weighted");
}
#[test]
fn asymmetric_and_rectangular_partitions() {
    check("amp_rect");
}
#[test]
fn transform_skip_scaling_lists() {
    check("tskip_scaling");
}
#[test]
fn several_slices_deblocking_offsets() {
    check("slices");
}
#[test]
fn wavefronts() {
    check("wpp");
}
#[test]
fn lossless() {
    check("lossless");
}
#[test]
fn lossless_coding_units_qp_deltas() {
    check("cu_lossless");
}
#[test]
fn constrained_intra_prediction() {
    check("cip");
}
#[test]
fn open_gops() {
    check("open_gop");
}
#[test]
fn conformance_window_chroma_qp_offsets() {
    check("odd_size");
}
#[test]
fn main10() {
    check("main10");
}
#[test]
fn main10_weighted_lossless() {
    check("main10_wp_lossless");
}

#[test]
fn ten_bit_frames_carry_rounded_eight_bit_planes() {
    for f in decode("main10", false).unwrap() {
        assert_eq!(f.bit_depth, 10);
        let y16 = f.y16.as_ref().unwrap();
        assert_eq!(y16.len(), f.y.len());
        assert!(y16.iter().zip(&f.y).all(|(&h, &l)| ((h + 2) >> 2).min(255) as u8 == l));
    }
}

#[test]
fn fast_mode_decodes_every_picture() {
    for name in ["b_pyramid", "slices", "main10"] {
        let fast = decode(name, true).unwrap();
        let exact = decode(name, false).unwrap();
        assert_eq!(fast.len(), exact.len(), "{name}");
        assert!(fast.iter().zip(&exact).all(|(a, b)| a.width == b.width && a.height == b.height && !a.damaged), "{name}");
    }
}

/// A small deterministic generator for the damage the tests below do.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

/// Damaged input must never panic (a panic aborts the WebAssembly
/// instance): truncated samples, flipped bits, overwritten bytes, dropped
/// and repeated samples; errors and damaged pictures are fine.
#[test]
fn damaged_streams_do_not_panic() {
    let names = ["intra_filters", "b_pyramid", "weighted", "amp_rect", "tskip_scaling", "slices", "wpp", "cu_lossless", "open_gop", "odd_size", "main10_wp_lossless"];
    let mut rng = Lcg(1);
    for name in names {
        let (config, samples) = samples(name);
        for round in 0..24 {
            let mut dec = Decoder::new(&config).unwrap();
            dec.set_fast(round % 5 == 4);
            for (i, (bytes, pts)) in samples.iter().enumerate() {
                let mut b = bytes.clone();
                match rng.next() % 8 {
                    0 if !b.is_empty() => b.truncate(rng.next() as usize % b.len()),
                    1 | 2 => {
                        for _ in 0..1 + rng.next() % 4 {
                            let k = rng.next() as usize % b.len().max(1);
                            if let Some(x) = b.get_mut(k) {
                                *x ^= 1 << (rng.next() % 8);
                            }
                        }
                    }
                    3 => {
                        let k = rng.next() as usize % b.len().max(1);
                        for x in b.iter_mut().skip(k).take(1 + rng.next() as usize % 16) {
                            *x = rng.next() as u8;
                        }
                    }
                    4 if i % 3 == 0 => continue,
                    _ => {}
                }
                let _ = dec.decode(&b, *pts);
                if rng.next().is_multiple_of(16) {
                    let _ = dec.decode(&b, *pts);
                }
            }
            let _ = dec.flush();
        }
    }
}

/// The parameter sets an hvcC box carries.
fn config_nal_units(config: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 23;
    for _ in 0..config[22] {
        let n = u16::from_be_bytes([config[i + 1], config[i + 2]]);
        i += 3;
        for _ in 0..n {
            let len = u16::from_be_bytes([config[i], config[i + 1]]) as usize;
            out.push(config[i + 2..i + 2 + len].to_vec());
            i += 2 + len;
        }
    }
    out
}

#[test]
fn damaged_configuration_and_annexb_do_not_panic() {
    let (config, samples) = samples("b_pyramid");
    let mut rng = Lcg(7);
    for _ in 0..200 {
        let mut c = config.clone();
        let k = rng.next() as usize % c.len();
        c[k] ^= 1 << (rng.next() % 8);
        c.truncate(c.len() - rng.next() as usize % 8);
        if let Ok(mut dec) = Decoder::new(&c) {
            for (bytes, pts) in samples.iter().take(6) {
                let _ = dec.decode(bytes, *pts);
            }
            let _ = dec.flush();
        }
    }
    // the same stream as Annex B, parameter sets included, cut and corrupted
    let mut annexb = Vec::new();
    for nal in config_nal_units(&config) {
        annexb.extend_from_slice(&[0, 0, 0, 1]);
        annexb.extend_from_slice(&nal);
    }
    for (bytes, _) in &samples {
        let mut i = 0;
        while i + 4 <= bytes.len() {
            let n = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
            let end = (i + 4 + n).min(bytes.len());
            annexb.extend_from_slice(&[0, 0, 0, 1]);
            annexb.extend_from_slice(&bytes[i + 4..end]);
            i = end;
        }
    }
    let mut dec = Decoder::new(&[]).unwrap();
    let clean = dec.decode_annexb(&annexb, 0.0).unwrap().len() + dec.flush().unwrap().len();
    assert_eq!(clean, expected("b_pyramid").len());
    for round in 0..60 {
        let mut a = annexb.clone();
        for _ in 0..1 + round % 8 {
            let k = rng.next() as usize % a.len();
            a[k] = rng.next() as u8;
        }
        let cut = rng.next() as usize % a.len();
        let mut dec = Decoder::new(&[]).unwrap();
        let _ = dec.decode_annexb(&a[..cut], 0.0);
        let _ = dec.decode_annexb(&a[cut..], 1.0);
        let _ = dec.flush();
    }
}
