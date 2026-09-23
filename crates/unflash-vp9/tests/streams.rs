//! Bit-exactness against ffmpeg: every stream in tests/media/vp9 decodes to
//! the per-frame MD5s ffmpeg's decoder produced (`gen.sh`), over the 8-bit
//! planes or, for deeper streams, the 16-bit ones.

use std::path::PathBuf;

use unflash_vp9::{Decoder, Frame};

fn media(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/media/vp9").join(name)
}

/// The samples of an IVF file (a 32-byte header, then frames with 12-byte
/// headers: size and timestamp, little-endian), or of a WebM / MP4 file
/// through the demuxer.
fn samples(data: &[u8]) -> Vec<(&[u8], f64)> {
    if data.starts_with(b"DKIF") {
        let mut p = u16::from_le_bytes([data[6], data[7]]) as usize;
        let mut out = Vec::new();
        while p + 12 <= data.len() {
            let size = u32::from_le_bytes(data[p..p + 4].try_into().unwrap()) as usize;
            let pts = u64::from_le_bytes(data[p + 4..p + 12].try_into().unwrap());
            out.push((&data[p + 12..p + 12 + size], pts as f64));
            p += 12 + size;
        }
        return out;
    }
    let movie = unflash_mp4::demux::parse_bytes(data).unwrap();
    let track = movie.video().unwrap();
    track.samples.iter().map(|s| (&data[s.offset as usize..(s.offset + s.size as u64) as usize], s.pts as f64)).collect()
}

/// The MD5 of a frame as ffmpeg's framemd5 computes it: the planes packed
/// one after the other, 16-bit samples little-endian.
fn frame_md5(f: &Frame) -> String {
    let bytes = match (&f.y16, &f.u16, &f.v16) {
        (Some(y), Some(u), Some(v)) => y.iter().chain(u).chain(v).flat_map(|s| s.to_le_bytes()).collect(),
        _ => [&f.y[..], &f.u[..], &f.v[..]].concat(),
    };
    format!("{:x}", md5::compute(bytes))
}

fn check(file: &str) {
    let data = std::fs::read(media(file)).expect("run tests/media/vp9/gen.sh");
    let mut dec = Decoder::new(&[]).unwrap();
    let mut got = Vec::new();
    for (sample, pts) in samples(&data) {
        let frames = dec.decode(sample, pts).unwrap_or_else(|e| panic!("{file}: {e} at pts {pts}"));
        for f in frames {
            assert!(!f.damaged, "{file}: damaged frame at pts {pts}");
            assert_eq!(f.y.len(), (f.width * f.height) as usize);
            assert_eq!(f.u.len(), (f.width.div_ceil(2) * f.height.div_ceil(2)) as usize);
            got.push(frame_md5(&f));
        }
    }
    let stem = file.rsplit_once('.').unwrap().0;
    let text = std::fs::read_to_string(media(&format!("{stem}.framemd5"))).unwrap();
    let want: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).map(|l| l.rsplit(',').next().unwrap().trim()).collect();
    assert_eq!(got.len(), want.len(), "{file}: frame count");
    for (i, (g, w)) in got.iter().zip(&want).enumerate() {
        assert_eq!(g, w, "{file}: frame {i} differs from ffmpeg");
    }
}

#[test]
fn altref_superframes_compound() {
    check("altref.ivf");
    check("altref_mb.ivf");
}
#[test]
fn webm_through_the_demuxer() {
    check("altref.webm");
}
#[test]
fn realtime_modes() {
    check("realtime.ivf");
}
#[test]
fn profile2_10_bit() {
    check("p2_10bit.ivf");
}
#[test]
fn profile2_12_bit() {
    check("p2_12bit.ivf");
}
#[test]
fn error_resilient() {
    check("errres.ivf");
}
#[test]
fn frame_parallel_no_adaptation() {
    check("parallel.ivf");
}
#[test]
fn tile_columns_and_rows() {
    check("tiles.ivf");
}
#[test]
fn lossless_walsh_hadamard() {
    check("lossless.ivf");
    check("lossless_10.ivf");
}
#[test]
fn segmentation_adaptive_quantisation() {
    check("aq_variance.ivf");
    check("aq_cyclic.ivf");
}
#[test]
fn loop_filter_sharpness() {
    check("sharpness.ivf");
}
#[test]
fn quantiser_extremes() {
    check("q_fine.ivf");
    check("q_coarse.ivf");
}
#[test]
fn odd_sizes() {
    check("odd.ivf");
    check("odd_small.ivf");
}
#[test]
fn scaled_references() {
    check("resize.ivf");
    check("resize_odd.ivf");
}
