//! Damaged files must never panic the readers, nor make them ask for more
//! for ever: a panic aborts the WebAssembly instance and the page with it,
//! and a read that never ends hangs it. The test media (MP4, QuickTime,
//! Matroska, WebM, transport streams) are read with random damage: bits
//! flipped, fields overwritten with the values a size or a count hurts
//! most with, bytes cut out and put in, the file cut short. Any outcome
//! will do, an error or a movie, but those two. A movie that does come out
//! is then read as the page reads it, and its tracks are muxed as an export
//! copies them.
//!
//! MP4_FUZZ_ROUNDS=n runs n rounds per file instead of a few hundred. A
//! debug build catches arithmetic overflow too.

use std::path::PathBuf;

use unflash_mp4::{Demuxer, Movie, Muxer, TrackDesc};

/// xorshift64*: deterministic, so a failure can be replayed from its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// The files to damage: those the repository holds (MP4, and the WebM and
/// Matroska files among the decoders' media), and those tests/media/gen.sh
/// makes, when it has been run (QuickTime with PCM, Matroska with every
/// kind of sound, transport streams).
fn files() -> Vec<(String, Vec<u8>)> {
    let root = unflash_testkit::media("");
    let mut paths: Vec<PathBuf> = Vec::new();
    for dir in ["", "mkv", "pcm", "ts", "hevc", "av1", "vp8", "vp9"] {
        let Ok(rd) = std::fs::read_dir(root.join(dir)) else { continue };
        for p in rd.filter_map(|e| e.ok().map(|e| e.path())) {
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            if matches!(ext, "mp4" | "mov" | "mkv" | "webm" | "ts" | "m2ts") {
                paths.push(p);
            }
        }
    }
    paths.sort();
    paths.into_iter().map(|p| (p.strip_prefix(&root).unwrap().display().to_string(), std::fs::read(&p).unwrap())).collect()
}

/// The values that hurt most where a size, a count or an offset is read.
const NASTY: [u64; 10] = [0, 1, 2, 0x7f, 0xff, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff, 0x7fff_ffff_ffff_ffff, 0xffff_ffff_ffff_ffff];

/// A place in the file, as often as not in its first or last 4 KB, where
/// the index is.
fn place(rng: &mut Rng, len: usize) -> usize {
    match rng.below(4) {
        0 => rng.below(len.min(4096)),
        1 => len - 1 - rng.below(len.min(4096)),
        _ => rng.below(len),
    }
}

/// `data` with one to four pieces of damage, and what they were.
fn damage(rng: &mut Rng, data: &[u8]) -> (Vec<u8>, Vec<String>) {
    let mut d = data.to_vec();
    let mut what = Vec::new();
    for _ in 0..1 + rng.below(4) {
        if d.len() < 16 {
            break;
        }
        let at = place(rng, d.len());
        match rng.below(8) {
            0 => {
                let bit = rng.below(8);
                d[at] ^= 1 << bit;
                what.push(format!("bit {bit} of byte {at} flipped"));
            }
            1 => {
                d[at] = rng.next() as u8;
                what.push(format!("byte {at} changed"));
            }
            2 | 3 => {
                // a field of 1, 2, 3, 4 or 8 bytes, big-endian as MP4 and Matroska hold them
                let n = [1, 2, 3, 4, 8][rng.below(5)].min(d.len() - at);
                let v = NASTY[rng.below(NASTY.len())];
                let bytes = v.to_be_bytes();
                d[at..at + n].copy_from_slice(&bytes[8 - n..]);
                what.push(format!("{n} bytes at {at} set to {v:#x}"));
            }
            4 => {
                d.truncate(at.max(1));
                what.push(format!("cut short at {at}"));
            }
            5 => {
                let n = (1 + rng.below(64)).min(d.len() - at);
                d.drain(at..at + n);
                what.push(format!("{n} bytes at {at} removed"));
            }
            6 => {
                let n = 1 + rng.below(64);
                let more: Vec<u8> = (0..n).map(|_| rng.next() as u8).collect();
                d.splice(at..at, more);
                what.push(format!("{n} bytes put in at {at}"));
            }
            _ => {
                let n = (1 + rng.below(256)).min(d.len() - at);
                let from = rng.below(d.len() - n + 1);
                let piece = d[from..from + n].to_vec();
                d[at..at + n].copy_from_slice(&piece);
                what.push(format!("{n} bytes at {at} overwritten with those at {from}"));
            }
        }
    }
    (d, what)
}

/// Read `data` as the page does: the ranges the reader asks for, from a
/// file that gives what it has of each. A reader that asks more often than
/// any file of this size needs never ends.
fn read(data: &[u8]) -> Result<Movie, String> {
    let len = data.len() as u64;
    let mut d = Demuxer::new(len);
    let mut asked = 0usize;
    while let Some((offset, length)) = d.need() {
        asked += 1;
        assert!(asked <= 100_000 + data.len(), "the reader keeps asking: {length} bytes at {offset} after {asked} reads");
        let from = offset.min(len) as usize;
        let to = offset.saturating_add(length).min(len) as usize;
        d.feed(offset, &data[from..to])?;
    }
    let _ = (d.progress(), d.container(), d.bytes_read(), d.is_done());
    d.into_movie().ok_or_else(|| "no movie".to_string())
}

/// Everything the page and an export read of a movie.
fn use_movie(movie: &Movie) {
    let mut mx = Muxer::new();
    for t in &movie.tracks {
        let mut sum = 0i64;
        for (i, s) in t.samples.iter().enumerate() {
            sum = sum.wrapping_add(t.to_us(s.pts)).wrapping_add(t.to_us(s.dts)).wrapping_add(t.to_us(s.duration as i64));
            if i < 4 {
                let _ = (t.pts_secs(i), t.to_secs(s.dts));
            }
        }
        let keys = t.keyframe_times();
        for at in [f64::NEG_INFINITY, -1.0, 0.0, t.duration_secs() / 2.0, t.duration_secs(), 1e18, f64::INFINITY, f64::NAN] {
            let i = t.sync_before(at);
            assert!(i == 0 || i < t.samples.len(), "sync_before({at}) is sample {i} of {}", t.samples.len());
        }
        let _ = (sum, keys.len(), t.copyable(), t.duration_secs());
        // an export copies the track under its own sample entry
        let id = mx.add_track(TrackDesc::Copy { kind: t.kind, sample_entry: t.sample_entry.clone(), timescale: t.timescale, width: t.width, height: t.height });
        for s in t.samples.iter().take(64) {
            let _ = mx.add_sample(id, s.dts, s.pts, s.duration, s.sync, s.size);
        }
    }
    let _ = (movie.video().is_some(), movie.audio().is_some());
    if !movie.tracks.is_empty() {
        let _ = mx.start();
        let _ = mx.finish();
    }
}

#[test]
fn damaged_files_never_panic_or_hang_the_readers() {
    let files = files();
    assert!(files.len() >= 8, "the repository's own MP4, WebM and Matroska files are there: {} found", files.len());
    if !files.iter().any(|(name, _)| name.ends_with(".ts") || name.ends_with(".m2ts")) {
        unflash_testkit::skipped("no transport streams to damage: tests/media/gen.sh makes them");
    }
    let rounds: usize = std::env::var("MP4_FUZZ_ROUNDS").ok().and_then(|s| s.parse().ok()).unwrap_or(250);
    let (mut movies, mut errors) = (0usize, 0usize);
    for (k, (name, data)) in files.iter().enumerate() {
        // the file as it is reads, and is a movie
        let whole = read(data).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(!whole.tracks.is_empty(), "{name}: no tracks");
        use_movie(&whole);
        for round in 0..rounds {
            let seed = 0x9e37_79b9_7f4a_7c15u64 ^ ((k as u64) << 32) ^ round as u64;
            let mut rng = Rng(seed | 1);
            let (damaged, what) = damage(&mut rng, data);
            let outcome = std::panic::catch_unwind(|| match read(&damaged) {
                Ok(movie) => {
                    use_movie(&movie);
                    true
                }
                Err(_) => false,
            });
            match outcome {
                Ok(true) => movies += 1,
                Ok(false) => errors += 1,
                Err(panic) => {
                    eprintln!("{name}, round {round} (seed {seed:#x}): {}", what.join("; "));
                    std::panic::resume_unwind(panic);
                }
            }
        }
    }
    eprintln!("{} files, {rounds} rounds each: {movies} still read as movies, {errors} were turned down", files.len());
    // (damage that leaves a file readable and damage that does not are both met)
    assert!(movies > 0 && errors > 0, "{movies} movies, {errors} errors");
}
