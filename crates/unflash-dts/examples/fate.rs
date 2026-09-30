//! Decode real DTS streams, such as the samples of ffmpeg's FATE suite
//! (its `dts` directory: DTS-HD High Resolution and Master Audio files
//! with every extension, DTS-ES, a transport stream), and compare each
//! with ffmpeg's decode of the same file's core (`-core_only 1`), which
//! must be on the path:
//!
//!     cargo run --release -p unflash-dts --example fate -- <dir> [name-filter]
//!
//! Files are read as a demuxer would hand them over: `.dts` whole, the
//! DTS-HD files (`.dtshd`) by their STRMDATA chunk, transport streams
//! (`.ts`, `.m2ts`) one PES payload of the first audio stream at a time.
//! Every channel must agree with ffmpeg's to 1e-4 of full scale, but for
//! an LFE channel interpolated 128 times, where ffmpeg 6.1 takes the
//! filter's taps in another order (see `tests/random_frames.rs`): that one
//! is reported and must stay within 5 % (rms). Where the stereo downmix
//! comes from the stream's embedded coefficients, it is compared with
//! ffmpeg's `-downmix stereo` too. Where the directory holds FATE's
//! reference output of dcadec for a file with nothing but a core
//! (`<name>.f32`, and `<name>-dmix_2.f32` for its stereo downmix), the
//! decode is compared with that as well. A stream without a core must
//! give `Error::NoCore`.

#[path = "../tests/common/mod.rs"]
mod common;

use std::path::{Path, PathBuf};

use common::{compare, describe, dtshd_stream, ffmpeg_available, ffmpeg_decode, ts_audio, ChannelStats, TOLERANCE};
use unflash_dts::{Decoder, Error, Features, Output, StreamInfo};

/// Interleaved float samples (a FATE reference) as channels.
fn read_f32(path: &Path, channels: usize) -> Option<Vec<Vec<f32>>> {
    let bytes = std::fs::read(path).ok()?;
    let v: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let n = v.len() / channels;
    Some((0..channels).map(|c| (0..n).map(|i| v[i * channels + c]).collect()).collect())
}

/// One decode of a file's chunks.
struct Run {
    out: Vec<Vec<f32>>,
    samples: usize,
    damaged: u32,
    features: Features,
    skipped: u64,
    info: Option<StreamInfo>,
    error: Option<Error>,
}

fn run(chunks: &[&[u8]], output: Output) -> Run {
    let mut dec = Decoder::new(output);
    let mut out = Vec::new();
    let (mut samples, mut damaged, mut error) = (0, 0, None);
    for chunk in chunks {
        match dec.decode(chunk, &mut out) {
            Ok(d) => {
                samples += d.samples;
                damaged += d.damaged;
            }
            Err(e) => error = Some(e),
        }
    }
    let (features, skipped) = dec.features();
    // (an error counts only when nothing at all was decoded)
    let error = if samples == 0 { error } else { None };
    Run { out, samples, damaged, features, skipped, info: dec.info(), error }
}

/// Print a channel's comparison; whether it passes.
fn check(label: &str, s: &ChannelStats, lfe_128: bool) -> bool {
    if lfe_128 {
        let ok = s.rms_diff <= 0.05 * s.rms.max(1e-6);
        println!(
            "  {label:>6}: {}  (LFE 128 times, ffmpeg's tap order: rms diff {:.1} % of its rms){}",
            describe(s),
            100.0 * s.rms_diff / s.rms.max(1e-12),
            if ok { "" } else { "  <-- over 5 %" }
        );
        return ok;
    }
    println!("  {label:>6}: {}", describe(s));
    s.max_diff <= TOLERANCE
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("a directory of DTS files"));
    let filter = std::env::args().nth(2).unwrap_or_default().to_ascii_lowercase();
    if !ffmpeg_available() {
        eprintln!("ffmpeg and ffprobe must be on the path");
        std::process::exit(2);
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("read the directory")
        .flatten()
        .map(|e| e.path())
        .filter(|p| matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("dts" | "dtshd" | "cpt" | "ts" | "m2ts")))
        .filter(|p| p.file_name().unwrap().to_string_lossy().to_ascii_lowercase().contains(&filter))
        .collect();
    files.sort();
    let (mut passed, mut failed) = (0, 0);
    let (mut total_audio, mut total_time) = (0.0, 0.0);
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let ext = path.extension().unwrap().to_string_lossy().to_ascii_lowercase();
        println!("{name}");
        let data = std::fs::read(&path).expect("read");
        // the chunks a demuxer would hand over, and the stream ffmpeg is
        // to decode
        let payloads;
        let (chunks, map): (Vec<&[u8]>, Vec<String>) = match ext.as_str() {
            "dtshd" => (vec![dtshd_stream(&data).expect("a STRMDATA chunk")], vec![]),
            "ts" | "m2ts" => {
                let pid;
                (pid, payloads) = ts_audio(&data);
                (payloads.iter().map(|p| p.as_slice()).collect(), vec!["-map".into(), format!("0:i:{pid}")])
            }
            _ => (vec![&data[..]], vec![]),
        };
        let map_opts: Vec<&str> = map.iter().map(|s| s.as_str()).collect();
        let t0 = std::time::Instant::now();
        let native = run(&chunks, Output::Native);
        let secs = t0.elapsed().as_secs_f64();
        let mut core_only = vec!["-core_only", "1"];
        if let Some(e) = &native.error {
            let theirs = ffmpeg_decode(&path, &core_only, &map_opts);
            let ok = *e == Error::NoCore && theirs.is_none_or(|t| t.first().is_none_or(|c| c.is_empty()));
            println!("  {e}: {}", if ok { "as expected, and ffmpeg finds no core either" } else { "unexpected" });
            if ok {
                passed += 1;
                println!("  ok");
            } else {
                failed += 1;
                println!("  FAIL");
            }
            continue;
        }
        let info = native.info.expect("stream info");
        let seconds = native.samples as f64 / info.sample_rate as f64;
        total_audio += seconds;
        total_time += secs;
        let f = &native.features;
        let mut used = Vec::new();
        for (on, what) in [
            (f.subframes, "several subframes"),
            (f.subsubframes, "several subsubframes"),
            (f.adpcm, "ADPCM"),
            (f.history_reset, "predictor history reset"),
            (f.high_frequency_vq, "high frequency VQ"),
            (f.joint_intensity, "joint intensity"),
            (f.transients, "transients"),
            (f.huffman_samples, "Huffman samples"),
            (f.block_codes, "block codes"),
            (f.plain_samples, "plain samples"),
            (f.huffman_scales, "Huffman scale factors"),
            (f.huffman_bit_allocation, "Huffman bit allocation"),
            (f.scales_7bit, "7-bit scale factors"),
            (f.adjustments, "scale factor adjustments"),
            (f.perfect_filter, "perfect reconstruction filter"),
            (f.nonperfect_filter, "non-perfect filter"),
            (f.lfe_64, "LFE 64x"),
            (f.lfe_128, "LFE 128x"),
            (f.sum_difference, "sum/difference"),
            (f.dynamic_range, "dynamic range"),
            (f.dsync_every_subsubframe, "DSYNC per subsubframe"),
            (f.crc_words, "CRC words"),
            (f.lossless_steps, "lossless steps"),
            (f.embedded_downmix, "embedded downmix"),
            (f.core_extension, "core extension (stepped over)"),
            (native.skipped > 0, "extension substreams (stepped over)"),
        ] {
            if on {
                used.push(what);
            }
        }
        println!(
            "  {} Hz, AMODE {}{}, {} samples a frame, {:.2} s, {} damaged frames, {} extension substream frames skipped; decoded in {:.1} ms ({:.0}x real time)",
            info.sample_rate,
            info.amode,
            if info.lfe { " + LFE" } else { "" },
            info.frame_samples,
            seconds,
            native.damaged,
            native.skipped,
            secs * 1e3,
            seconds / secs
        );
        println!("  uses: {}", used.join(", "));
        let mut ok = native.damaged == 0;
        let lfe = info.lfe.then(|| common::lfe_index(info.amode));
        // ffmpeg's core
        match ffmpeg_decode(&path, &core_only, &map_opts) {
            None => {
                println!("  ffmpeg could not decode it");
                ok = false;
            }
            Some(theirs) => {
                let len = |v: &Vec<Vec<f32>>| v.first().map_or(0, |c| c.len());
                if theirs.len() != native.out.len() || len(&theirs) != len(&native.out) {
                    println!("  ffmpeg: {} channels of {} samples, ours {} of {}", theirs.len(), len(&theirs), native.out.len(), len(&native.out));
                    ok = false;
                }
                let map: Vec<Option<usize>> = (0..native.out.len()).map(|c| (c < theirs.len()).then_some(c)).collect();
                println!("  against ffmpeg -core_only 1:");
                for (c, s) in compare(&native.out, &theirs, &map).iter().enumerate() {
                    ok &= check(&format!("ch {c}"), s, Some(c) == lfe && f.lfe_128);
                }
            }
        }
        // the stereo downmix, where the stream has its own coefficients
        let stereo = run(&chunks, Output::Stereo);
        if f.embedded_downmix && info.channels > 2 {
            core_only.extend(["-downmix", "stereo"]);
            if let Some(theirs) = ffmpeg_decode(&path, &core_only, &map_opts) {
                println!("  stereo (embedded coefficients) against ffmpeg -downmix stereo:");
                for (c, s) in compare(&stereo.out, &theirs, &[Some(0), Some(1)]).iter().enumerate() {
                    // (the LFE channel takes part in the downmix)
                    ok &= check(["Lo", "Ro"][c], s, f.lfe_128 && info.lfe);
                }
            }
        }
        // FATE's references (dcadec's output) of streams that are a core
        let stem = path.with_extension("");
        let only_core = native.skipped == 0 && !f.core_extension;
        if only_core {
            let reference = PathBuf::from(format!("{}.f32", stem.display()));
            if let Some(r) = read_f32(&reference, native.out.len()) {
                println!("  against {}:", reference.file_name().unwrap().to_string_lossy());
                let map: Vec<Option<usize>> = (0..native.out.len()).map(Some).collect();
                for (c, s) in compare(&native.out, &r, &map).iter().enumerate() {
                    ok &= check(&format!("ch {c}"), s, Some(c) == lfe && f.lfe_128);
                }
            }
            let reference = PathBuf::from(format!("{}-dmix_2.f32", stem.display()));
            if let Some(r) = read_f32(&reference, 2) {
                println!("  stereo against {}:", reference.file_name().unwrap().to_string_lossy());
                for (c, s) in compare(&stereo.out, &r, &[Some(0), Some(1)]).iter().enumerate() {
                    ok &= check(["Lo", "Ro"][c], s, f.lfe_128 && info.lfe);
                }
            }
        }
        if ok {
            passed += 1;
            println!("  ok");
        } else {
            failed += 1;
            println!("  FAIL");
        }
    }
    println!(
        "\n{passed} passed, {failed} failed; {total_audio:.1} s of audio decoded in {:.3} s ({:.0}x real time)",
        total_time,
        total_audio / total_time.max(1e-9)
    );
    if failed > 0 {
        std::process::exit(1);
    }
}
