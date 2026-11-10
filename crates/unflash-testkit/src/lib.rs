//! What the tests and the comparison tools of the built-in decoders share
//! (a dev-dependency only: nothing here is built into the app): where the
//! test media is, a file's video samples whatever its container, every
//! picture a decoder makes of them, and the MD5 of a picture as ffmpeg's
//! `framemd5` reckons it, beside what ffmpeg wrote down for each stream
//! (`tests/media/*/gen.sh`). Each decoder's tests used to bring their own
//! copy of these.

use std::path::PathBuf;

use unflash_codec::{Frame, VideoDecoder};

/// A file of the test media: `path` under `tests/media`.
pub fn media(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/media").join(path)
}

/// The bytes of a file of the test media. One that is not there says which
/// script makes it.
pub fn read(path: &str) -> Vec<u8> {
    let file = media(path);
    std::fs::read(&file).unwrap_or_else(|e| panic!("{}: {e} (run {})", file.display(), generator(path)))
}

/// The script that makes the file at `path`: its folder's `gen.sh`.
fn generator(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((dir, _)) => format!("tests/media/{dir}/gen.sh"),
        None => "tests/media/gen.sh".to_string(),
    }
}

/// The per-picture MD5s of ffmpeg's `framemd5` output: the last field of
/// each line that is not a comment.
pub fn framemd5(text: &str) -> Vec<String> {
    framemd5_sized(text).into_iter().map(|(_, md5)| md5).collect()
}

/// [`framemd5`] with each picture's size in bytes (the field before the
/// MD5), which tells a picture of another size from one of other samples.
pub fn framemd5_sized(text: &str) -> Vec<(usize, String)> {
    text.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| {
            let mut fields = l.rsplit(',').map(str::trim);
            let md5 = fields.next().unwrap_or("").to_string();
            let size = fields.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            (size, md5)
        })
        .collect()
}

/// ffmpeg's MD5 of every picture of the stream at `path`, in the order
/// they are shown: its `.framemd5` beside it.
pub fn expected(path: &str) -> Vec<String> {
    framemd5(&expected_text(path))
}

/// [`expected`] with each picture's size in bytes.
pub fn expected_sized(path: &str) -> Vec<(usize, String)> {
    framemd5_sized(&expected_text(path))
}

fn expected_text(path: &str) -> String {
    let file = media(path).with_extension("framemd5");
    std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{}: {e} (run {})", file.display(), generator(path)))
}

/// The MD5 of a picture as ffmpeg's `framemd5` hashes it: its planes one
/// after the other, the 8-bit ones or, where the decoder kept a deeper
/// stream's at full precision, those as 16-bit little-endian samples.
pub fn frame_md5(f: &Frame) -> String {
    let mut ctx = md5::Context::new();
    match (&f.y16, &f.u16, &f.v16) {
        (Some(y), Some(u), Some(v)) => {
            for plane in [y, u, v] {
                ctx.consume(plane.iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<u8>>());
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

/// The MD5 of bytes, as hexadecimal text.
pub fn md5_hex(bytes: &[u8]) -> String {
    format!("{:x}", md5::compute(bytes))
}

/// One sample of a video stream.
#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    pub data: Vec<u8>,
    /// When it is shown, in the container's own ticks (an IVF frame's
    /// timestamp, an MP4 sample's composition time).
    pub pts: f64,
    /// The same in seconds (ticks again for an IVF file, whose time base
    /// the tests do not read).
    pub seconds: f64,
    /// A decoder can start at it.
    pub sync: bool,
}

/// A file's video: what kind it is, its configuration record and its
/// samples in decoding order.
#[derive(Clone, Debug, PartialEq)]
pub struct Stream {
    /// The codec string the demuxer gives the track (empty for an IVF file).
    pub codec: String,
    /// The track's configuration record (avcC, hvcC, av1C, ...), empty when
    /// it has none.
    pub config: Vec<u8>,
    pub samples: Vec<Sample>,
}

/// The video of a file's bytes: the frames of an IVF file, or the video
/// track of an MP4, Matroska or WebM file as the demuxer reads it (what
/// Matroska's header stripping took off each sample put back).
pub fn stream(data: &[u8]) -> Stream {
    if let Some(frames) = unflash_mp4::ivf::frames(data) {
        let samples = frames.into_iter().map(|(ts, f)| Sample { data: f.to_vec(), pts: ts as f64, seconds: ts as f64, sync: true }).collect();
        return Stream { codec: String::new(), config: Vec::new(), samples };
    }
    let movie = unflash_mp4::demux::parse_bytes(data).expect("the test file is one the demuxer reads");
    let track = movie.video().expect("the test file has a video track");
    let samples = track
        .samples
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let mut bytes = track.prefix.clone();
            bytes.extend_from_slice(&data[s.offset as usize..][..s.size as usize]);
            Sample { data: bytes, pts: s.pts as f64, seconds: track.pts_secs(i), sync: s.sync }
        })
        .collect();
    Stream { codec: track.codec.clone(), config: track.description.clone().unwrap_or_default(), samples }
}

/// [`stream`] of a file of the test media.
pub fn load(path: &str) -> Stream {
    stream(&read(path))
}

/// Every picture `dec` makes of `samples` (each given its `pts`), those it
/// holds at the end among them, in the order they are shown.
pub fn decode_all<D: VideoDecoder>(dec: &mut D, samples: &[Sample]) -> Result<Vec<Frame>, D::Error> {
    let mut frames = Vec::new();
    for s in samples {
        frames.extend(dec.decode(&s.data, s.pts)?);
    }
    frames.extend(dec.flush()?);
    frames.sort_by(|a, b| a.pts.total_cmp(&b.pts));
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framemd5_lines() {
        let text = "#format: frame checksums\n#stream#, dts,        pts, duration,     size, hash\n0,          0,          0,        1,     4608, 9a2c1e\n\n0,          1,          1,        1,     4608,  0f3b77 \n";
        assert_eq!(framemd5(text), vec!["9a2c1e", "0f3b77"]);
        assert_eq!(framemd5_sized(text), vec![(4608, "9a2c1e".to_string()), (4608, "0f3b77".to_string())]);
        assert_eq!(framemd5(""), Vec::<String>::new());
    }

    #[test]
    fn a_picture_is_hashed_as_its_planes_one_after_the_other() {
        let mut f = Frame { width: 2, height: 2, y: vec![1, 2, 3, 4], u: vec![5], v: vec![6], bit_depth: 8, y16: None, u16: None, v16: None, pts: 0.0, damaged: false, bt709: false, full_range: false };
        assert_eq!(frame_md5(&f), md5_hex(&[1, 2, 3, 4, 5, 6]));
        // a deeper picture kept at full precision: its 16-bit samples, low byte first
        f.bit_depth = 10;
        f.y16 = Some(vec![0x0102, 0x0304, 0, 0]);
        f.u16 = Some(vec![0x0005]);
        f.v16 = Some(vec![0x0306]);
        assert_eq!(frame_md5(&f), md5_hex(&[2, 1, 4, 3, 0, 0, 0, 0, 5, 0, 6, 3]));
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
    }

    #[test]
    fn the_media_is_found_from_the_workspace_and_says_how_it_is_made() {
        assert!(media("hevc/intra.mp4").exists(), "{}", media("hevc/intra.mp4").display());
        assert_eq!(generator("vp9/altref.ivf"), "tests/media/vp9/gen.sh");
        assert_eq!(generator("h264_10s.mp4"), "tests/media/gen.sh");
    }

    #[test]
    fn a_file_s_video_is_read_whatever_holds_it() {
        // an IVF file: frames with their own timestamps, no configuration
        let ivf = load("vp9/altref.ivf");
        assert!(ivf.codec.is_empty() && ivf.config.is_empty() && !ivf.samples.is_empty());
        assert!(ivf.samples.windows(2).all(|w| w[1].pts > w[0].pts));
        // an MP4: the track's codec and configuration record, a keyframe first
        let mp4 = load("hevc/intra.mp4");
        assert!(mp4.codec.starts_with("hvc1") || mp4.codec.starts_with("hev1"), "{}", mp4.codec);
        assert!(!mp4.config.is_empty() && mp4.samples[0].sync);
        assert_eq!(expected("hevc/intra.mp4").len(), mp4.samples.len());
        // a WebM: the same film as the IVF beside it, sample for sample
        let webm = load("vp9/altref.webm");
        assert_eq!(webm.samples.iter().map(|s| &s.data).collect::<Vec<_>>(), load("vp9/altref.ivf").samples.iter().map(|s| &s.data).collect::<Vec<_>>());
    }
}
