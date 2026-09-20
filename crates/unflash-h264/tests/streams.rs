//! Bit-exactness against ffmpeg: every stream in tests/media/h264 decodes
//! to the per-frame MD5s ffmpeg's decoder produced (`gen.sh`).

use std::path::PathBuf;

use unflash_h264::yuv::to_i420;
use unflash_h264::{Decoder, Error};
use unflash_mp4::demux::parse_bytes;

fn media(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/media/h264").join(name)
}

/// Decode a file; returns the MD5 of every frame in presentation order.
fn decode(name: &str) -> Result<Vec<String>, Error> {
    let data = std::fs::read(media(&format!("{name}.mp4"))).expect("run tests/media/h264/gen.sh");
    let movie = parse_bytes(&data).unwrap();
    let track = movie.video().unwrap();
    let mut dec = Decoder::new();
    dec.configure_avcc(track.description.as_ref().unwrap())?;
    let mut frames: Vec<(i64, String)> = Vec::new();
    let mut buf = Vec::new();
    for s in &track.samples {
        let bytes = &data[s.offset as usize..(s.offset + s.size as u64) as usize];
        if let Some(f) = dec.decode_sample(bytes, s.pts as f64)? {
            assert!(!f.damaged, "{name}: damaged frame at pts {}", s.pts);
            let sps = dec.sps().unwrap();
            let (w, h) = sps.cropped_size();
            to_i420(&f.pic, (sps.crop.0 as usize, sps.crop.2 as usize, w as usize, h as usize), &mut buf);
            frames.push((s.pts, format!("{:x}", md5::compute(&buf))));
        }
    }
    frames.sort_by_key(|f| f.0);
    Ok(frames.into_iter().map(|f| f.1).collect())
}

fn expected(name: &str) -> Vec<String> {
    let text = std::fs::read_to_string(media(&format!("{name}.framemd5"))).unwrap();
    text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).map(|l| l.rsplit(',').next().unwrap().trim().to_string()).collect()
}

fn check(name: &str) {
    let got = decode(name).unwrap_or_else(|e| panic!("{name}: {e}"));
    let want = expected(name);
    assert_eq!(got.len(), want.len(), "{name}: frame count");
    for (i, (g, w)) in got.iter().zip(&want).enumerate() {
        assert_eq!(g, w, "{name}: frame {i} differs from ffmpeg");
    }
}

#[test]
fn constrained_baseline_cavlc() {
    check("cb_cavlc");
}
#[test]
fn baseline_cropped_two_slices() {
    check("cb_crop_slices");
}
#[test]
fn main_cabac_bframes_temporal_direct() {
    check("main_cabac_b");
}
#[test]
fn main_cavlc_bframes_weighted() {
    check("main_cavlc_wp");
}
#[test]
fn high_8x8_transform_aq_slices() {
    check("high_8x8_aq");
}
#[test]
fn high_scaling_matrices_weighted() {
    check("high_cqm_wp");
}
#[test]
fn high_constrained_intra_no_deblock() {
    check("high_cip_nodeblock");
}
#[test]
fn high_open_gop_many_refs() {
    check("high_opengop_refs");
}
#[test]
fn high_cropped_cabac() {
    check("high_crop_cabac");
}
#[test]
fn pcm_macroblocks_cabac() {
    check("pcm_cabac");
}
#[test]
fn pcm_macroblocks_cavlc() {
    check("pcm_cavlc");
}
#[test]
fn interlaced_is_reported_unsupported() {
    match decode("high_interlaced") {
        Err(Error::Unsupported(_)) => {}
        other => panic!("expected an unsupported error, got {:?}", other.map(|v| v.len())),
    }
}
