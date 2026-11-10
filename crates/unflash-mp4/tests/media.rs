//! Demux the files `tests/media/gen.sh` produced and compare every packet
//! with ffprobe's listing (pts, dts, size, position, keyframe flag); then
//! mux them back and check the result parses and, when ffmpeg is on the
//! PATH, decodes cleanly with the same frame count.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use unflash_mp4::demux::{parse_bytes, TrackKind};
use unflash_mp4::mux::{Muxer, TrackDesc};

#[derive(Deserialize)]
struct Packets {
    packets: Vec<Packet>,
}

#[derive(Deserialize)]
struct Packet {
    pts_time: Option<String>,
    dts_time: Option<String>,
    flags: String,
    size: String,
    pos: String,
}

fn media_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/media")
}

fn media_files() -> Vec<PathBuf> {
    let dir = media_dir();
    let mut v: Vec<PathBuf> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map(|x| x == "mp4").unwrap_or(false)).collect(),
        Err(_) => vec![],
    };
    v.sort();
    v
}

fn check_track(name: &str, track: &unflash_mp4::Track, listing: &Path) {
    let pk: Packets = serde_json::from_str(&std::fs::read_to_string(listing).unwrap()).unwrap();
    assert_eq!(track.samples.len(), pk.packets.len(), "{name}: sample count for {:?}", track.kind);
    for (i, (s, p)) in track.samples.iter().zip(&pk.packets).enumerate() {
        let pts: f64 = p.pts_time.as_deref().unwrap_or("0").parse().unwrap();
        let ours = track.to_secs(s.pts);
        assert!((ours - pts).abs() < 1e-4, "{name} sample {i}: pts {ours} vs {pts}");
        if let Some(d) = &p.dts_time {
            let dts: f64 = d.parse().unwrap();
            let ours = track.to_secs(s.dts + track.edit_shift);
            assert!((ours - dts).abs() < 1e-4, "{name} sample {i}: dts {ours} vs {dts}");
        }
        assert_eq!(s.size as u64, p.size.parse::<u64>().unwrap(), "{name} sample {i}: size");
        assert_eq!(s.offset, p.pos.parse::<u64>().unwrap(), "{name} sample {i}: position");
        assert_eq!(s.sync, p.flags.contains('K'), "{name} sample {i}: keyframe flag {}", p.flags);
    }
}

#[test]
fn demux_matches_ffprobe() {
    let files = media_files();
    if files.is_empty() {
        unflash_testkit::skipped("no MP4 media: tests/media/gen.sh makes it");
        return;
    }
    for f in files {
        let name = f.file_stem().unwrap().to_string_lossy().to_string();
        let data = std::fs::read(&f).unwrap();
        let movie = parse_bytes(&data).unwrap_or_else(|e| panic!("{name}: {e}"));
        let video = movie.video().unwrap_or_else(|| panic!("{name}: no video track"));
        eprintln!("{name}: {}x{} {} ({} samples, fragmented={})", video.width, video.height, video.codec, video.samples.len(), movie.fragmented);
        assert_eq!((video.width, video.height), (64, 48), "{name}: dimensions");
        if name.starts_with("h264") {
            assert!(video.codec.starts_with("avc1."), "{name}: codec {}", video.codec);
            assert_eq!(video.description.as_ref().map(|d| d[0]), Some(1), "{name}: avcC version");
        } else if name.starts_with("vp9") {
            assert!(video.codec.starts_with("vp09."), "{name}: codec {}", video.codec);
        } else if name.starts_with("av1") {
            assert!(video.codec.starts_with("av01."), "{name}: codec {}", video.codec);
        }
        check_track(&name, video, &media_dir().join(format!("{name}.video.json")));
        let audio_listing = media_dir().join(format!("{name}.audio.json"));
        if audio_listing.exists() {
            let audio = movie.audio().unwrap_or_else(|| panic!("{name}: no audio track"));
            assert_eq!(audio.codec, "mp4a.40.2", "{name}: audio codec");
            assert_eq!(audio.sample_rate, 48000);
            check_track(&name, audio, &audio_listing);
        }
        // the demuxer reads only headers and the moov/moof boxes
        let mut d = unflash_mp4::Demuxer::new(data.len() as u64);
        while let Some((off, len)) = d.need() {
            let end = (off + len).min(data.len() as u64);
            d.feed(off, &data[off as usize..end as usize]).unwrap();
        }
        assert!(d.bytes_read() < data.len() as u64, "{name}: read the whole file");
        assert!(!video.keyframe_times().is_empty(), "{name}: keyframes");
        assert!(video.samples[0].sync, "{name}: first sample is a keyframe");
    }
}

fn has(cmd: &str) -> bool {
    Command::new(cmd).arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
}

/// `data` (an MP4 with picture and sound) written again by the muxer as an
/// export copies it: the video under its record, the sound under its sample
/// entry, every sample at the times the reader gave it.
fn remux(data: &[u8]) -> Vec<u8> {
    let movie = parse_bytes(data).unwrap();
    let video = movie.video().unwrap();
    let audio = movie.audio().unwrap();
    let mut mx = Muxer::new();
    let vt = mx.add_track(TrackDesc::Video {
        codec: video.codec.clone(),
        width: video.width,
        height: video.height,
        timescale: video.timescale,
        description: video.description.clone().unwrap(),
    });
    let at = mx.add_track(TrackDesc::Copy {
        kind: TrackKind::Audio,
        sample_entry: audio.sample_entry.clone(),
        timescale: audio.timescale,
        width: 0,
        height: 0,
    });
    let mut out = mx.start();
    // interleave as the source does: by file position
    let mut order: Vec<(u64, usize, usize)> = Vec::new();
    for (i, s) in video.samples.iter().enumerate() {
        order.push((s.offset, vt, i));
    }
    for (i, s) in audio.samples.iter().enumerate() {
        order.push((s.offset, at, i));
    }
    order.sort();
    for (_, t, i) in order {
        let s = if t == vt { video.samples[i] } else { audio.samples[i] };
        out.extend_from_slice(&data[s.offset as usize..(s.offset + s.size as u64) as usize]);
        mx.add_sample(t, s.dts, s.pts, s.duration, s.sync, s.size).unwrap();
    }
    let (moov, (patch_at, patch)) = mx.finish().unwrap();
    out[patch_at as usize..patch_at as usize + 8].copy_from_slice(&patch);
    out.extend_from_slice(&moov);
    out
}

/// Where ffprobe says the video and the audio stream of a file start, in seconds.
fn ffprobe_starts(path: &Path) -> (f64, f64) {
    let out = Command::new("ffprobe").args(["-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "csv=p=0"]).arg(path).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let start = |kind: &str| -> f64 { text.lines().find_map(|l| l.strip_prefix(kind)).and_then(|t| t.trim_start_matches(',').trim().parse().ok()).unwrap_or_else(|| panic!("no {kind} stream in ffprobe's listing of {}: {text}", path.display())) };
    (start("video"), start("audio"))
}

/// Picture and sound that start apart in a file start as far apart in a
/// copy of it: the muxer used to start every track at once, so that a
/// picture that began 67 ms after the sound (h264_frag.mp4) began with it.
#[test]
fn a_copy_starts_its_picture_and_sound_where_the_file_does() {
    let mut seen = 0;
    for path in media_files() {
        let data = std::fs::read(&path).unwrap();
        let movie = parse_bytes(&data).unwrap();
        let (Some(video), Some(audio)) = (movie.video(), movie.audio()) else { continue };
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let first_us = |t: &unflash_mp4::Track| t.to_us(t.samples.iter().map(|s| s.pts).min().unwrap());
        let out = remux(&data);
        let back = parse_bytes(&out).unwrap_or_else(|e| panic!("{name}: our own output does not parse: {e}"));
        // (these files' clocks start at or before zero, so each track keeps its own time, to the millisecond an edit is written in)
        assert!(first_us(video).min(first_us(audio)) <= 0, "{name}: a clock that starts after zero is rebased; this test is of ones that are kept");
        for (kind, was, is) in [("picture", first_us(video), first_us(back.video().unwrap())), ("sound", first_us(audio), first_us(back.audio().unwrap()))] {
            assert!((was - is).abs() <= 1000, "{name}: the {kind} started at {was} µs and starts at {is} µs in the copy");
        }
        if has("ffprobe") {
            let tmp = std::env::temp_dir().join(format!("unflash_starts_{name}"));
            std::fs::write(&tmp, &out).unwrap();
            let (was, is) = (ffprobe_starts(&path), ffprobe_starts(&tmp));
            eprintln!("{name}: ffprobe has picture and sound start at {was:?}, and in the copy at {is:?}");
            assert!((was.0 - is.0).abs() < 0.0015 && (was.1 - is.1).abs() < 0.0015, "{name}: ffprobe has picture and sound start at {was:?}, and in the copy at {is:?}");
            let _ = std::fs::remove_file(&tmp);
        }
        seen += 1;
    }
    if seen == 0 {
        unflash_testkit::skipped("no MP4 media with picture and sound: tests/media/gen.sh makes it");
    } else if !has("ffprobe") {
        unflash_testkit::skipped("ffprobe is not installed: the copies' starts are read by this crate's reader alone");
    }
}

#[test]
fn mux_round_trip() {
    let src = media_dir().join("h264_bframes.mp4");
    if !src.exists() {
        unflash_testkit::skipped("no MP4 media: tests/media/gen.sh makes it");
        return;
    }
    let data = std::fs::read(&src).unwrap();
    let movie = parse_bytes(&data).unwrap();
    let video = movie.video().unwrap();
    let audio = movie.audio().unwrap();
    let out = remux(&data);

    let back = parse_bytes(&out).expect("our own output parses");
    let bv = back.video().unwrap();
    assert_eq!(bv.samples.len(), video.samples.len());
    assert_eq!(bv.codec, video.codec);
    for (a, b) in bv.samples.iter().zip(&video.samples) {
        // presentation order and times must survive; decode times may be
        // re-based (we write no edit list when the first pts is 0)
        assert_eq!(a.pts, b.pts);
        assert_eq!(a.size, b.size);
        assert_eq!(a.sync, b.sync);
        assert_eq!(&out[a.offset as usize..a.offset as usize + a.size as usize], &data[b.offset as usize..b.offset as usize + b.size as usize]);
    }
    let ba = back.audio().unwrap();
    assert_eq!(ba.samples.len(), audio.samples.len());
    assert_eq!(ba.codec, "mp4a.40.2");

    let tmp = std::env::temp_dir().join("unflash_roundtrip.mp4");
    std::fs::write(&tmp, &out).unwrap();
    if has("ffmpeg") && has("ffprobe") {
        let probe = Command::new("ffprobe")
            .args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,codec_name", "-of", "csv=p=0"])
            .arg(&tmp)
            .output()
            .unwrap();
        let s = String::from_utf8_lossy(&probe.stdout).trim().to_string();
        eprintln!("ffprobe on the muxed file: {s}");
        assert!(s.starts_with("h264,"), "{s}");
        let frames: usize = s.split(',').nth(1).unwrap().parse().unwrap();
        assert_eq!(frames, video.samples.len());
        let dec = Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&tmp).args(["-f", "null", "-"]).output().unwrap();
        let err = String::from_utf8_lossy(&dec.stderr);
        assert!(dec.status.success() && err.trim().is_empty(), "ffmpeg complained: {err}");
    } else {
        unflash_testkit::skipped("ffmpeg is not installed: the muxed file is not decoded by it");
    }
}
