//! Damaged H.264 must never panic the decoder: a panic ends the WebAssembly
//! module of the worker decoding it, and the scan with it. Every stream in
//! tests/media/h264 is decoded with its samples damaged (bits flipped, bytes
//! overwritten, NAL lengths made wrong, samples cut short, dropped,
//! repeated, or swapped for another stream's), with its `avcC` record
//! damaged, and as Annex B cut and overwritten anywhere. Any outcome will
//! do, an error or a picture marked damaged, but a panic; and every picture
//! that does come out must still be one the page can take (its planes hold
//! the part its cropping names).
//!
//! `H264_FUZZ_ROUNDS=n` sets the rounds per stream (24 unless set). A debug
//! build catches arithmetic overflow too.

mod common;

use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

use unflash_h264::yuv::to_i420;
use unflash_h264::{DecodedFrame, Decoder};
use unflash_mp4::demux::parse_bytes;

const STREAMS: [&str; 12] = [
    "cb_cavlc",
    "cb_crop_slices",
    "main_cabac_b",
    "main_cavlc_wp",
    "high_8x8_aq",
    "high_cqm_wp",
    "high_cip_nodeblock",
    "high_opengop_refs",
    "high_crop_cabac",
    "pcm_cabac",
    "pcm_cavlc",
    "high_interlaced",
];

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

/// A stream's `avcC` record and its samples (bytes and time), decode order.
struct Stream {
    name: &'static str,
    record: Vec<u8>,
    samples: Vec<(Vec<u8>, f64)>,
}

fn streams() -> Vec<Stream> {
    STREAMS
        .iter()
        .map(|&name| {
            let data = common::read(name);
            let movie = parse_bytes(&data).unwrap();
            let track = movie.video().unwrap();
            Stream { name, record: track.description.clone().unwrap(), samples: track.samples.iter().map(|s| (common::sample(&data, s).to_vec(), s.pts as f64)).collect() }
        })
        .collect()
}

fn rounds() -> usize {
    std::env::var("H264_FUZZ_ROUNDS").ok().and_then(|s| s.parse().ok()).unwrap_or(24)
}

/// The values a length hurts most with.
const NASTY: [u32; 8] = [0, 1, 2, 0xff, 0xffff, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff];

/// One sample, damaged one way (or, one time in three, left as it is).
fn damage(rng: &mut Rng, sample: &[u8], others: &[Stream]) -> Vec<u8> {
    let mut b = sample.to_vec();
    match rng.below(12) {
        0 if !b.is_empty() => b.truncate(rng.below(b.len())),
        1 | 2 => {
            for _ in 0..1 + rng.below(4) {
                let k = rng.below(b.len());
                if let Some(x) = b.get_mut(k) {
                    *x ^= 1 << rng.below(8);
                }
            }
        }
        3 => {
            let k = rng.below(b.len());
            let n = 1 + rng.below(16);
            for x in b.iter_mut().skip(k).take(n) {
                *x = rng.next() as u8;
            }
        }
        // the length in front of the first NAL unit, or of whatever is at a place further in
        4 => {
            let at = if rng.below(2) == 0 { 0 } else { rng.below(b.len().saturating_sub(4)) };
            if b.len() >= at + 4 {
                let v = if rng.below(2) == 0 { NASTY[rng.below(NASTY.len())] } else { rng.below(b.len() * 2) as u32 };
                b[at..at + 4].copy_from_slice(&v.to_be_bytes());
            }
        }
        // the NAL unit's header: another type of unit, with this one's payload
        5 if b.len() > 4 => b[4] = rng.next() as u8,
        // a sample of another stream (another size, another profile), under this stream's parameter sets
        6 => {
            let other = &others[rng.below(others.len())];
            b = other.samples[rng.below(other.samples.len())].0.clone();
        }
        // bytes put in, bytes cut out
        7 if !b.is_empty() => {
            let k = rng.below(b.len());
            let n = 1 + rng.below(8);
            if rng.below(2) == 0 {
                b.splice(k..k, (0..n).map(|i| (i * 37) as u8));
            } else {
                b.drain(k..(k + n).min(b.len()));
            }
        }
        _ => {}
    }
    b
}

/// What the page does with a picture: packs it (which reads the part of
/// each plane its cropping names).
fn take(frame: &DecodedFrame, buf: &mut Vec<u8>) {
    let (_, _, w, h) = frame.crop;
    to_i420(&frame.pic, frame.crop, buf);
    assert_eq!(buf.len(), w * h + 2 * w.div_ceil(2) * h.div_ceil(2), "a packed picture is its cropped size");
}

thread_local! {
    /// The panics of this thread while it gathers them (see `panics`).
    static CAUGHT: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}

/// The panics of `run`, each as "where: what", gathered instead of ending
/// the test at the first, so that one run names every place. (One hook for
/// the whole test binary, which keeps a thread's panics only while that
/// thread is gathering: the tests run side by side, and a panic of the test
/// itself must still be printed.)
fn panics(run: impl FnOnce()) -> Vec<String> {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
            let what = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_default();
            let kept = CAUGHT.with(|c| c.borrow_mut().as_mut().map(|list| list.push(format!("{at}: {what}"))).is_some());
            if !kept {
                default(info);
            }
        }));
    });
    CAUGHT.with(|c| *c.borrow_mut() = Some(Vec::new()));
    run();
    CAUGHT.with(|c| c.borrow_mut().take().unwrap_or_default())
}

/// Run `body` for every stream and round, each under its own seed, and
/// fail with every distinct panic and a seed that reaches it.
fn sweep(what: &str, salt: u64, body: impl Fn(&Stream, &[Stream], &mut Rng)) {
    let all = streams();
    let mut runs = 0;
    let mut first: Vec<(String, String)> = Vec::new(); // a place, and the first run that reached it
    let seen = panics(|| {
        for (k, stream) in all.iter().enumerate() {
            for round in 0..rounds() {
                let seed = salt ^ ((k as u64) << 32) ^ round as u64 ^ 0x9e37_79b9_7f4a_7c15;
                let before = CAUGHT.with(|c| c.borrow().as_ref().map_or(0, |list| list.len()));
                if catch_unwind(AssertUnwindSafe(|| body(stream, &all, &mut Rng(seed)))).is_err() {
                    runs += 1;
                    let place = CAUGHT.with(|c| c.borrow().as_ref().and_then(|list| list.get(before).cloned())).unwrap_or_default();
                    if !first.iter().any(|(p, _)| *p == place) {
                        first.push((place, format!("{} round {round}", stream.name)));
                    }
                }
            }
        }
    });
    let places: Vec<String> = first.iter().map(|(place, run)| format!("{place}   ({} times; first in {run})", seen.iter().filter(|p| *p == place).count())).collect();
    assert!(runs == 0, "{what}: {runs} of the runs panicked, at:\n  {}", places.join("\n  "));
}

#[test]
fn damaged_samples_never_panic_the_decoder() {
    sweep("damaged samples", 1, |stream, all, rng| {
        let mut dec = Decoder::new();
        // (as a scan decodes, half the time: without the deblocking filter)
        dec.set_skip_deblock(rng.below(2) == 0);
        dec.configure_avcc(&stream.record).unwrap();
        let mut buf = Vec::new();
        let mut i = 0;
        while i < stream.samples.len() {
            let (bytes, pts) = &stream.samples[i];
            let b = damage(rng, bytes, all);
            if let Ok(Some(f)) = dec.decode_sample(&b, *pts) {
                take(&f, &mut buf);
            }
            // a sample dropped, or given twice
            i += match rng.below(16) {
                0 => 0,
                1 => 2,
                _ => 1,
            };
            if rng.below(64) == 0 {
                i = rng.below(stream.samples.len());
            }
        }
        if let Ok(Some(f)) = dec.flush() {
            take(&f, &mut buf);
        }
    });
}

#[test]
fn a_damaged_record_never_panics_the_decoder() {
    sweep("a damaged avcC record", 2, |stream, all, rng| {
        for _ in 0..8 {
            let mut record = stream.record.clone();
            for _ in 0..1 + rng.below(3) {
                let k = rng.below(record.len());
                match rng.below(4) {
                    0 => record[k] = rng.next() as u8,
                    1 => record.truncate(k),
                    // another stream's sets under this record's counts and lengths
                    2 => {
                        let other = &all[rng.below(all.len())].record;
                        let n = rng.below(other.len());
                        record.splice(k.., other[n..].iter().copied());
                    }
                    _ => record[k] ^= 1 << rng.below(8),
                }
                if record.is_empty() {
                    break;
                }
            }
            let mut dec = Decoder::new();
            if dec.configure_avcc(&record).is_err() {
                continue;
            }
            // what the page asks of a record it could read
            if let Some(sps) = dec.first_sps() {
                let _ = sps.cropped_size();
            }
            let mut buf = Vec::new();
            for (bytes, pts) in stream.samples.iter().take(12) {
                if let Ok(Some(f)) = dec.decode_sample(bytes, *pts) {
                    take(&f, &mut buf);
                }
            }
            if let Ok(Some(f)) = dec.flush() {
                take(&f, &mut buf);
            }
        }
    });
}

/// The NAL units of an `avcC` record's parameter sets.
fn record_units(record: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut i = 5;
    for mask in [0x1f, 0xff] {
        let n = record[i] & mask;
        i += 1;
        for _ in 0..n {
            let len = u16::from_be_bytes([record[i], record[i + 1]]) as usize;
            out.push(&record[i + 2..i + 2 + len]);
            i += 2 + len;
        }
    }
    out
}

#[test]
fn damaged_annex_b_never_panics_the_decoder() {
    sweep("damaged Annex B", 3, |stream, _, rng| {
        // the stream as a transport stream carries it: start codes, the parameter sets in front
        let mut annexb = Vec::new();
        for unit in record_units(&stream.record) {
            annexb.extend_from_slice(&[0, 0, 0, 1]);
            annexb.extend_from_slice(unit);
        }
        let mut starts = Vec::new();
        for (bytes, _) in &stream.samples {
            starts.push(annexb.len());
            let mut i = 0;
            while i + 4 <= bytes.len() {
                let n = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
                let end = (i + 4 + n).min(bytes.len());
                annexb.extend_from_slice(&[0, 0, 0, 1]);
                annexb.extend_from_slice(&bytes[i + 4..end]);
                i = end;
            }
        }
        for _ in 0..1 + rng.below(8) {
            let k = rng.below(annexb.len());
            annexb[k] = rng.next() as u8;
        }
        if rng.below(3) == 0 {
            annexb.truncate(rng.below(annexb.len()));
        }
        // in pieces cut at the samples, or anywhere
        let mut dec = Decoder::new();
        let mut buf = Vec::new();
        let mut at = 0;
        let mut t = 0.0;
        while at < annexb.len() {
            let end = if rng.below(2) == 0 { starts.iter().copied().find(|&s| s > at).unwrap_or(annexb.len()).min(annexb.len()) } else { (at + 1 + rng.below(2000)).min(annexb.len()) };
            if let Ok(frames) = dec.decode_annexb(&annexb[at..end], t) {
                for f in &frames {
                    take(f, &mut buf);
                }
            }
            at = end;
            t += 1.0;
        }
        if let Ok(Some(f)) = dec.flush() {
            take(&f, &mut buf);
        }
    });
}
