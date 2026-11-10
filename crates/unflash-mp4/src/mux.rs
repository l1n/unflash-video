//! A writer for the files the export produces: `ftyp`, one `mdat` holding
//! every sample in the order they are added, then a `moov` with 64-bit
//! chunk offsets. Video tracks come from WebCodecs encoder output; audio
//! tracks are usually stream-copied with their original sample entry.
//!
//! Usage: `start()` returns the file head (append it); for each sample
//! append the payload yourself and call `add_sample` with its size; finally
//! `finish()` returns the `moov` to append and the 8 bytes to patch into the
//! `mdat` header.

use crate::demux::{span, Sample, TrackKind};
use crate::reader::Writer;
use crate::Error;

/// How to build a track's sample entry.
#[derive(Clone, Debug)]
pub enum TrackDesc {
    /// A video track from encoder output.
    Video {
        /// WebCodecs codec string (`avc1.*`, `hvc1.*`, `av01.*`, `vp09.*`).
        codec: String,
        width: u32,
        height: u32,
        /// Ticks per second for the track's timestamps.
        timescale: u32,
        /// avcC / hvcC / av1C payload from the encoder's `decoderConfig`
        /// (may be empty for VP9 / AV1: a record is synthesised from the
        /// codec string).
        description: Vec<u8>,
    },
    /// Any track whose sample entry box is copied verbatim (stream copy).
    Copy { kind: TrackKind, sample_entry: Vec<u8>, timescale: u32, width: u32, height: u32 },
}

struct MuxTrack {
    desc: TrackDesc,
    samples: Vec<Sample>,
    /// A video track's sample entries after the first (`add_description`).
    more: Vec<Vec<u8>>,
    /// The entry new samples use, from 1, and each sample's.
    current: u32,
    entry: Vec<u32>,
}

/// The 8 bytes to write over the file head at an offset (the `mdat`'s size).
pub type Patch = (u64, [u8; 8]);

pub struct Muxer {
    tracks: Vec<MuxTrack>,
    /// File offset of the `mdat` box header.
    mdat_at: u64,
    /// Bytes written so far (head + payloads).
    pos: u64,
    started: bool,
}

impl Default for Muxer {
    fn default() -> Self {
        Self::new()
    }
}

impl Muxer {
    pub fn new() -> Self {
        Muxer { tracks: Vec::new(), mdat_at: 0, pos: 0, started: false }
    }

    pub fn add_track(&mut self, desc: TrackDesc) -> usize {
        self.tracks.push(MuxTrack { desc, samples: Vec::new(), more: Vec::new(), current: 1, entry: Vec::new() });
        self.tracks.len() - 1
    }

    /// One more sample entry for a video track: the same codec under
    /// another decoder record (`avcC`), for samples from another encoder
    /// spliced in. A player starts its decoder afresh where the entry
    /// changes, which Apple's needs to take a stream with other parameter
    /// sets. Returns the entry's index (from 1; the track's own is 1).
    pub fn add_description(&mut self, track: usize, description: Vec<u8>) -> Result<u32, Error> {
        let t = self.tracks.get_mut(track).ok_or("no such track")?;
        if !matches!(t.desc, TrackDesc::Video { .. }) {
            return Err("only a video track takes more sample entries".into());
        }
        t.more.push(description);
        Ok(t.more.len() as u32 + 1)
    }

    /// The sample entry the samples added from now on use (from 1).
    pub fn use_description(&mut self, track: usize, index: u32) -> Result<(), Error> {
        let t = self.tracks.get_mut(track).ok_or("no such track")?;
        if index < 1 || index as usize > t.more.len() + 1 {
            return Err("no such sample entry".into());
        }
        t.current = index;
        Ok(())
    }

    /// The file head: `ftyp` and the `mdat` header (with a placeholder size).
    pub fn start(&mut self) -> Vec<u8> {
        let mut w = Writer::new();
        let at = w.begin_box(b"ftyp");
        w.bytes(b"isom");
        w.u32(512);
        w.bytes(b"isom");
        w.bytes(b"iso2");
        w.bytes(b"avc1");
        w.bytes(b"mp41");
        w.end_box(at);
        self.mdat_at = w.buf.len() as u64;
        w.u32(1);
        w.bytes(b"mdat");
        w.u64(0); // largesize, patched by finish()
        self.pos = w.buf.len() as u64;
        self.started = true;
        w.buf
    }

    /// Record a sample whose `size` bytes the caller has just appended to
    /// the file. Times are in the track's timescale.
    pub fn add_sample(&mut self, track: usize, dts: i64, pts: i64, duration: u32, sync: bool, size: u32) -> Result<(), Error> {
        if !self.started {
            return Err("call start() first".into());
        }
        let t = self.tracks.get_mut(track).ok_or("no such track")?;
        t.samples.push(Sample { offset: self.pos, size, dts, pts, duration, sync });
        t.entry.push(t.current);
        self.pos += size as u64;
        Ok(())
    }

    /// The `moov` box to append, and the `(offset, bytes)` to overwrite in
    /// the already-written head so the `mdat` size is right.
    pub fn finish(&self) -> Result<(Vec<u8>, Patch), Error> {
        if !self.started {
            return Err("call start() first".into());
        }
        let mdat_size = self.pos - self.mdat_at;
        let patch = (self.mdat_at + 8, mdat_size.to_be_bytes());
        let starts = track_starts(&self.tracks);
        let mut max_dur_ms = 0u64;
        for (t, start) in self.tracks.iter().zip(&starts) {
            max_dur_ms = max_dur_ms.max(start.delay_ms + shown_ms(t, start));
        }
        let mut w = Writer::new();
        let moov = w.begin_box(b"moov");
        // mvhd
        let at = w.begin_full_box(b"mvhd", 1, 0);
        w.u64(0);
        w.u64(0);
        w.u32(1000); // the movie's timescale: its durations are milliseconds
        w.u64(max_dur_ms);
        w.u32(0x00010000); // rate
        w.u16(0x0100); // volume
        w.zeros(2 + 8);
        for v in [0x00010000u32, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000] {
            w.u32(v);
        }
        w.zeros(24);
        w.u32(self.tracks.len() as u32 + 1);
        w.end_box(at);
        for (i, t) in self.tracks.iter().enumerate() {
            write_trak(&mut w, t, i as u32 + 1, starts[i])?;
        }
        w.end_box(moov);
        Ok((w.buf, patch))
    }
}

fn track_timescale(t: &MuxTrack) -> u32 {
    match &t.desc {
        TrackDesc::Video { timescale, .. } | TrackDesc::Copy { timescale, .. } => (*timescale).max(1),
    }
}

fn track_duration_ticks(t: &MuxTrack) -> u64 {
    span(&t.samples).max(0) as u64
}

/// Where a track's presentation starts against the movie's: after
/// `delay_ms` of nothing (the movie's ticks), or with its first `trim` ticks
/// (its own) left out.
#[derive(Clone, Copy, Default)]
struct Start {
    delay_ms: u64,
    trim: i64,
}

/// What of a track is shown, in milliseconds: all of it but what is trimmed.
fn shown_ms(t: &MuxTrack, start: &Start) -> u64 {
    ((track_duration_ticks(t) as i128 - start.trim as i128).max(0) * 1000 / track_timescale(t) as i128) as u64
}

/// Each track's start. The caller's times are on one clock for all the
/// tracks, but a track's tables hold only durations, so that written as
/// they are every track would start at once, and picture and sound that
/// began apart would begin together. The movie's time 0 is the clock's own
/// 0 when anything starts at or before it (what is before it is trimmed, as
/// it was in the file the times come from: an AAC track's priming, say),
/// and else the start of the earliest track (a clock taken from a transport
/// stream starts anywhere). A track that starts after that says by how much
/// with an empty edit (see `write_trak`). A track with no samples starts
/// nowhere.
fn track_starts(tracks: &[MuxTrack]) -> Vec<Start> {
    // each track's first presentation time and its ticks a second
    let firsts: Vec<Option<(i128, i128)>> = tracks.iter().map(|t| t.samples.iter().map(|s| s.pts).min().map(|first| (first as i128, track_timescale(t) as i128))).collect();
    // (a/b < c/d as a·d < c·b: the scales are positive)
    let Some(&(first0, scale0)) = firsts.iter().flatten().min_by(|a, b| (a.0 * b.1).cmp(&(b.0 * a.1))) else { return vec![Start::default(); tracks.len()] };
    // the moment that becomes the movie's time 0, as a fraction of a second
    let (origin, origin_scale) = if first0 <= 0 { (0, 1) } else { (first0, scale0) };
    firsts
        .iter()
        .map(|first| {
            let Some((first, scale)) = *first else { return Start::default() };
            // how long after the origin it starts, in 1/(scale·origin_scale) s
            let lead = first * origin_scale - origin * scale;
            let den = scale * origin_scale;
            if lead > 0 {
                Start { delay_ms: ((lead * 1000 + den / 2) / den).min(u64::MAX as i128) as u64, trim: 0 }
            } else {
                // (before the clock's 0, whose scale is 1: its own ticks)
                Start { delay_ms: 0, trim: (-lead / origin_scale).min(i64::MAX as i128) as i64 }
            }
        })
        .collect()
}

/// What is taken off every composition offset of a track so that none is
/// negative: the least of them, when that is below zero (else nothing). A
/// track whose samples are shown before they are decoded has times that an
/// edit list moved: an AAC track read from an MP4 has every presentation
/// time 1024 ticks before its decode time, the priming its edit skips. The
/// file says the same the same way, with offsets from zero up (none at all
/// for such a sound track) and the difference in the edit's media time,
/// which every reader understands; offsets below zero are read by some.
fn composition_lift(t: &MuxTrack) -> i64 {
    t.samples.iter().map(|s| s.pts.wrapping_sub(s.dts)).min().unwrap_or(0).min(0)
}

fn write_trak(w: &mut Writer, t: &MuxTrack, id: u32, start: Start) -> Result<(), Error> {
    let ts = track_timescale(t);
    let (kind, width, height) = match &t.desc {
        TrackDesc::Video { width, height, .. } => (TrackKind::Video, *width, *height),
        TrackDesc::Copy { kind, width, height, .. } => (*kind, *width, *height),
    };
    let dur_ticks = track_duration_ticks(t);
    let dur_ms = shown_ms(t, &start);
    let delay_ms = start.delay_ms;
    let first_pts = t.samples.iter().map(|s| s.pts).min().unwrap_or(0);
    let first_dts = t.samples.first().map(|s| s.dts).unwrap_or(0);

    let trak = w.begin_box(b"trak");
    // tkhd
    let at = w.begin_full_box(b"tkhd", 1, 3);
    w.u64(0);
    w.u64(0);
    w.u32(id);
    w.u32(0);
    w.u64(delay_ms + dur_ms);
    w.zeros(8);
    w.u16(0); // layer
    w.u16(0); // alternate group
    w.u16(if kind == TrackKind::Audio { 0x0100 } else { 0 });
    w.u16(0);
    for v in [0x00010000u32, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000] {
        w.u32(v);
    }
    w.u32(width << 16);
    w.u32(height << 16);
    w.end_box(at);
    // edts: the file's decode times start at 0 (stts holds durations only),
    // so its composition times are the caller's less the first decode time
    // (and less `lift`, see `composition_lift`); the presentation starts at
    // the earliest of them that is not trimmed (which skips the reordering
    // delay too), after an empty edit as long as the track starts later
    // than the movie (`track_starts`)
    // (in 128 bits: the times are the caller's, and need not be ones a file has)
    let media_start = (first_pts as i128 + start.trim as i128 - first_dts as i128 - composition_lift(t) as i128).clamp(0, i64::MAX as i128) as i64;
    if media_start > 0 || delay_ms > 0 {
        let edts = w.begin_box(b"edts");
        let at = w.begin_full_box(b"elst", 1, 0);
        w.u32(1 + (delay_ms > 0) as u32);
        if delay_ms > 0 {
            w.u64(delay_ms);
            w.u64(u64::MAX); // media_time -1: nothing of the track yet
            w.i16(1);
            w.i16(0);
        }
        w.u64(dur_ms);
        w.u64(media_start as u64);
        w.i16(1);
        w.i16(0);
        w.end_box(at);
        w.end_box(edts);
    }
    // mdia
    let mdia = w.begin_box(b"mdia");
    let at = w.begin_full_box(b"mdhd", 1, 0);
    w.u64(0);
    w.u64(0);
    w.u32(ts);
    w.u64(dur_ticks);
    w.u16(0x55c4); // 'und'
    w.u16(0);
    w.end_box(at);
    let at = w.begin_full_box(b"hdlr", 0, 0);
    w.u32(0);
    match kind {
        TrackKind::Video => {
            w.bytes(b"vide");
            w.zeros(12);
            w.bytes(b"VideoHandler\0");
        }
        TrackKind::Audio => {
            w.bytes(b"soun");
            w.zeros(12);
            w.bytes(b"SoundHandler\0");
        }
        TrackKind::Other => {
            w.bytes(b"meta");
            w.zeros(12);
            w.bytes(b"Handler\0");
        }
    }
    w.end_box(at);
    let minf = w.begin_box(b"minf");
    match kind {
        TrackKind::Video => {
            let at = w.begin_full_box(b"vmhd", 0, 1);
            w.zeros(8);
            w.end_box(at);
        }
        TrackKind::Audio => {
            let at = w.begin_full_box(b"smhd", 0, 0);
            w.zeros(4);
            w.end_box(at);
        }
        TrackKind::Other => {
            let at = w.begin_full_box(b"nmhd", 0, 0);
            w.end_box(at);
        }
    }
    let dinf = w.begin_box(b"dinf");
    let at = w.begin_full_box(b"dref", 0, 0);
    w.u32(1);
    let url = w.begin_full_box(b"url ", 0, 1);
    w.end_box(url);
    w.end_box(at);
    w.end_box(dinf);
    // stbl
    let stbl = w.begin_box(b"stbl");
    let at = w.begin_full_box(b"stsd", 0, 0);
    w.u32(1 + t.more.len() as u32);
    match &t.desc {
        TrackDesc::Video { codec, width, height, description, .. } => {
            write_video_entry(w, codec, *width, *height, description)?;
            for d in &t.more {
                write_video_entry(w, codec, *width, *height, d)?;
            }
        }
        TrackDesc::Copy { sample_entry, .. } => w.bytes(sample_entry),
    }
    w.end_box(at);
    // stts
    let at = w.begin_full_box(b"stts", 0, 0);
    let runs = run_length(t.samples.iter().map(|s| s.duration as i64));
    w.u32(runs.len() as u32);
    for (count, d) in &runs {
        w.u32(*count);
        w.u32(*d as u32);
    }
    w.end_box(at);
    // ctts
    let lift = composition_lift(t);
    if t.samples.iter().any(|s| s.pts.wrapping_sub(s.dts) != lift) {
        let at = w.begin_full_box(b"ctts", 1, 0);
        let runs = run_length(t.samples.iter().map(|s| s.pts.wrapping_sub(s.dts).wrapping_sub(lift)));
        w.u32(runs.len() as u32);
        for (count, o) in &runs {
            w.u32(*count);
            w.i32(*o as i32);
        }
        w.end_box(at);
    }
    // stss
    if t.samples.iter().any(|s| !s.sync) {
        let at = w.begin_full_box(b"stss", 0, 0);
        let syncs: Vec<u32> = t.samples.iter().enumerate().filter(|(_, s)| s.sync).map(|(i, _)| i as u32 + 1).collect();
        w.u32(syncs.len() as u32);
        for s in syncs {
            w.u32(s);
        }
        w.end_box(at);
    }
    // stsc: one sample per chunk, a run of chunks for each stretch of
    // samples under one sample entry
    let at = w.begin_full_box(b"stsc", 0, 0);
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for (i, &e) in t.entry.iter().enumerate() {
        if runs.last().map(|r| r.1) != Some(e) {
            runs.push((i as u32 + 1, e));
        }
    }
    if runs.is_empty() {
        runs.push((1, 1));
    }
    w.u32(runs.len() as u32);
    for (first, e) in runs {
        w.u32(first);
        w.u32(1);
        w.u32(e);
    }
    w.end_box(at);
    // stsz
    let at = w.begin_full_box(b"stsz", 0, 0);
    w.u32(0);
    w.u32(t.samples.len() as u32);
    for s in &t.samples {
        w.u32(s.size);
    }
    w.end_box(at);
    // co64
    let at = w.begin_full_box(b"co64", 0, 0);
    w.u32(t.samples.len() as u32);
    for s in &t.samples {
        w.u64(s.offset);
    }
    w.end_box(at);
    w.end_box(stbl);
    w.end_box(minf);
    w.end_box(mdia);
    w.end_box(trak);
    Ok(())
}

/// Decode times for samples in decode order, from their composition times:
/// the k-th decode time is the k-th smallest composition time, all moved
/// earlier by the largest reordering delay, so no sample decodes after it
/// is shown and the decode times rise by the presentation intervals.
/// Returns (dts, duration) per sample; the last sample gets `last_duration`.
/// Works for any splice of streams whose pictures are all shown, whatever
/// each stream's own reordering.
pub fn dts_from_cts(cts: &[i64], last_duration: u32) -> Vec<(i64, u32)> {
    let mut sorted = cts.to_vec();
    sorted.sort_unstable();
    let shift = cts.iter().enumerate().map(|(i, &c)| sorted[i] - c).max().unwrap_or(0).max(0);
    (0..cts.len())
        .map(|i| {
            let dur = if i + 1 < cts.len() { (sorted[i + 1] - sorted[i]).max(1) as u32 } else { last_duration };
            (sorted[i] - shift, dur)
        })
        .collect()
}

fn run_length(vals: impl Iterator<Item = i64>) -> Vec<(u32, i64)> {
    let mut out: Vec<(u32, i64)> = Vec::new();
    for v in vals {
        match out.last_mut() {
            Some((c, last)) if *last == v => *c += 1,
            _ => out.push((1, v)),
        }
    }
    out
}

pub(crate) fn write_video_entry(w: &mut Writer, codec: &str, width: u32, height: u32, description: &[u8]) -> Result<(), Error> {
    let fourcc: &[u8; 4] = if codec.starts_with("avc1") || codec.starts_with("avc3") {
        b"avc1"
    } else if codec.starts_with("hvc1") || codec.starts_with("hev1") {
        b"hvc1"
    } else if codec.starts_with("av01") {
        b"av01"
    } else if codec.starts_with("vp09") {
        b"vp09"
    } else if codec.starts_with("vp8") {
        b"vp08"
    } else {
        return Err(format!("unsupported video codec for muxing: {codec}"));
    };
    let entry = w.begin_box(fourcc);
    w.zeros(6);
    w.u16(1); // data reference index
    w.zeros(2 + 2 + 12);
    w.u16(width as u16);
    w.u16(height as u16);
    w.u32(0x00480000);
    w.u32(0x00480000);
    w.u32(0);
    w.u16(1);
    w.zeros(32);
    w.u16(0x0018);
    w.i16(-1);
    match fourcc {
        b"avc1" => {
            if description.is_empty() {
                return Err("avc1 needs an avcC description from the encoder".into());
            }
            let at = w.begin_box(b"avcC");
            w.bytes(description);
            w.end_box(at);
        }
        b"hvc1" => {
            if description.is_empty() {
                return Err("hvc1 needs an hvcC description from the encoder".into());
            }
            let at = w.begin_box(b"hvcC");
            w.bytes(description);
            w.end_box(at);
        }
        b"av01" => {
            let at = w.begin_box(b"av1C");
            if description.is_empty() {
                w.bytes(&synth_av1c(codec));
            } else {
                w.bytes(description);
            }
            w.end_box(at);
        }
        b"vp09" => {
            let at = w.begin_full_box(b"vpcC", 1, 0);
            w.bytes(&synth_vpcc(codec));
            w.end_box(at);
        }
        _ => {}
    }
    w.end_box(entry);
    Ok(())
}

/// av1C from `av01.P.LLT.DD`.
fn synth_av1c(codec: &str) -> Vec<u8> {
    let parts: Vec<&str> = codec.split('.').collect();
    let profile: u8 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(0);
    let (level, tier) = parts
        .get(2)
        .map(|s| {
            // (all but its last character, which need not be one byte long)
            let mut level = s.chars();
            level.next_back();
            let lvl: u8 = level.as_str().parse().unwrap_or(0);
            let tier = if s.ends_with('H') { 1u8 } else { 0 };
            (lvl, tier)
        })
        .unwrap_or((0, 0));
    let depth: u8 = parts.get(3).and_then(|p| p.parse().ok()).unwrap_or(8);
    let high = (depth > 8) as u8;
    let twelve = (depth == 12) as u8;
    // marker|version, profile|level, tier|high|twelve|mono|subx|suby|pos, reserved|initial_presentation_delay
    vec![0x81, (profile << 5) | (level & 0x1f), (tier << 7) | (high << 6) | (twelve << 5) | (1 << 3) | (1 << 2), 0]
}

/// vpcC payload (after the full-box header) from `vp09.PP.LL.DD`.
fn synth_vpcc(codec: &str) -> Vec<u8> {
    let parts: Vec<&str> = codec.split('.').collect();
    let profile: u8 = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(0);
    let level: u8 = parts.get(2).and_then(|p| p.parse().ok()).unwrap_or(10);
    let depth: u8 = parts.get(3).and_then(|p| p.parse().ok()).unwrap_or(8);
    // profile, level, bitDepth(4)|chromaSubsampling(3)|fullRange(1), primaries, transfer, matrix, codecInitializationDataSize(2)
    vec![profile, level, (depth << 4) | (1 << 1), 1, 1, 1, 0, 0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_times_from_composition_times() {
        // I0 P3 B1 B2 | I4 (no reordering) spliced after a stream with two B-frames
        let cts = [0i64, 3, 1, 2, 4, 5, 6];
        let out = dts_from_cts(&cts, 1);
        let dts: Vec<i64> = out.iter().map(|o| o.0).collect();
        assert_eq!(dts, vec![-1, 0, 1, 2, 3, 4, 5]);
        for (i, &c) in cts.iter().enumerate() {
            assert!(dts[i] <= c);
        }
        assert!(dts.windows(2).all(|w| w[1] > w[0]));
        assert_eq!(out.iter().map(|o| o.1).collect::<Vec<_>>(), vec![1, 1, 1, 1, 1, 1, 1]);
        assert_eq!(dts_from_cts(&[0, 2, 4], 7), vec![(0, 2), (2, 2), (4, 7)]);
        assert!(dts_from_cts(&[], 1).is_empty());
    }

    /// A file of two VP9 tracks, each with three samples a tick of 1/30 s
    /// (the first at 1000 Hz, the second at 90 kHz), the first sample of
    /// each shown at `starts` (in its track's ticks).
    fn two_tracks(starts: [i64; 2]) -> Vec<u8> {
        let mut mx = Muxer::new();
        let scales = [1000u32, 90000];
        let tracks: Vec<usize> = scales.iter().map(|&timescale| mx.add_track(TrackDesc::Video { codec: "vp09.00.10.08".into(), width: 64, height: 48, timescale, description: vec![] })).collect();
        let mut file = mx.start();
        for k in 0..3 {
            for (i, &t) in tracks.iter().enumerate() {
                let step = scales[i] as i64 / 30;
                let at = starts[i] + k * step;
                file.push(0);
                mx.add_sample(t, at, at, step as u32, true, 1).unwrap();
            }
        }
        let (moov, (at, patch)) = mx.finish().unwrap();
        file[at as usize..at as usize + 8].copy_from_slice(&patch);
        file.extend_from_slice(&moov);
        file
    }

    /// Where each track of `file` starts, in microseconds, as this crate's
    /// reader sees it (its edit list applied).
    fn starts_us(file: &[u8]) -> Vec<i64> {
        let movie = crate::demux::parse_bytes(file).unwrap();
        movie.tracks.iter().map(|t| t.to_us(t.samples.iter().map(|s| s.pts).min().unwrap())).collect()
    }

    /// The caller's times are on one clock for every track, and a file's
    /// tables hold only durations: where a track starts later than the
    /// earliest, the file has to say so (an empty edit), or picture and
    /// sound that began apart begin together.
    #[test]
    fn tracks_that_start_apart_stay_apart() {
        // the second track 200 ms after the first; then the first 66 ms after the second
        assert_eq!(starts_us(&two_tracks([0, 18000])), [0, 200_000]);
        assert_eq!(starts_us(&two_tracks([66, 0])), [66_000, 0]);
        // a clock that does not start at zero: the earliest track does, the other as far after it
        assert_eq!(starts_us(&two_tracks([5000, 5000 * 90 + 2700])), [0, 30_000]);
        // a clock with something before its zero keeps its zero: what is before it is trimmed, not shown
        assert_eq!(starts_us(&two_tracks([-40, 1800])), [-40_000, 20_000]);
        assert_eq!(starts_us(&two_tracks([-40, -900])), [-40_000, -10_000]);
        assert_eq!(starts_us(&two_tracks([0, -900])), [0, -10_000]);
        // together: no edit is needed, and none is written
        let together = two_tracks([700, 63000]);
        assert_eq!(starts_us(&together), [0, 0]);
        assert!(!together.windows(4).any(|w| w == b"edts"));
        // the file is as long as its last track runs: three samples of 1/30 s after 200 ms
        let movie = crate::demux::parse_bytes(&two_tracks([0, 18000])).unwrap();
        assert_eq!(movie.tracks[1].samples.len(), 3);
        let moov_durations = |file: &[u8]| -> (u64, Vec<u64>) {
            // mvhd and tkhd (version 1): the duration is the 8 bytes after two dates, a timescale or id, and (tkhd) 4 reserved
            let find = |name: &[u8; 4]| -> Vec<usize> { (0..file.len() - 4).filter(|&i| &file[i..i + 4] == name).collect() };
            let u64_at = |i: usize| u64::from_be_bytes(file[i..i + 8].try_into().unwrap());
            (u64_at(find(b"mvhd")[0] + 4 + 4 + 16 + 4), find(b"tkhd").iter().map(|&i| u64_at(i + 4 + 4 + 16 + 4 + 4)).collect())
        };
        // (the first track's three samples are 33 ms each; the second's 100 ms begin after 200)
        assert_eq!(moov_durations(&two_tracks([0, 18000])), (300, vec![99, 300]));
        // (trimmed: 40 ms of the first track's 99 are before the clock's zero; the second begins 20 ms after it)
        assert_eq!(moov_durations(&two_tracks([-40, 1800])), (120, vec![59, 120]));
    }

    /// A track read from an MP4 whose edit list skips into it (an AAC
    /// track's priming) has every presentation time before its decode time.
    /// It is written the way it was read: no offset below zero in the file
    /// (here none at all), and an edit that skips as far.
    #[test]
    fn times_an_edit_moved_are_written_as_an_edit() {
        let mut mx = Muxer::new();
        let t = mx.add_track(TrackDesc::Video { codec: "vp09.00.10.08".into(), width: 64, height: 48, timescale: 48000, description: vec![] });
        let mut file = mx.start();
        for k in 0..4i64 {
            file.push(0);
            mx.add_sample(t, k * 1024, k * 1024 - 1024, 1024, true, 1).unwrap();
        }
        let (moov, (at, patch)) = mx.finish().unwrap();
        file[at as usize..at as usize + 8].copy_from_slice(&patch);
        file.extend_from_slice(&moov);
        let find = |name: &[u8; 4]| (0..file.len() - 4).find(|&i| &file[i..i + 4] == name);
        assert_eq!(find(b"ctts"), None);
        // elst (version 1): one edit, of what is shown (3 of the 4 packets: 64 ms), from media time 1024
        let elst = find(b"elst").expect("an edit list");
        let u64_at = |i: usize| u64::from_be_bytes(file[i..i + 8].try_into().unwrap());
        assert_eq!((u32::from_be_bytes(file[elst + 8..elst + 12].try_into().unwrap()), u64_at(elst + 12), u64_at(elst + 20)), (1, 64, 1024));
        // and read back, every packet is where it was: the first before the clock's zero
        let movie = crate::demux::parse_bytes(&file).unwrap();
        assert_eq!(movie.tracks[0].samples.iter().map(|s| s.pts).collect::<Vec<_>>(), [-1024, 0, 1024, 2048]);

        // pictures shown out of the order they are decoded in keep their offsets, from zero up
        let mut mx = Muxer::new();
        let t = mx.add_track(TrackDesc::Video { codec: "vp09.00.10.08".into(), width: 64, height: 48, timescale: 30, description: vec![] });
        let mut file = mx.start();
        // (decode times -1 to 2, shown at 0, 2, 1, 3: the first is decoded a tick early to make room)
        for (dts, pts) in [(-1i64, 0i64), (0, 2), (1, 1), (2, 3)] {
            file.push(0);
            mx.add_sample(t, dts, pts, 1, true, 1).unwrap();
        }
        let (moov, (at, patch)) = mx.finish().unwrap();
        file[at as usize..at as usize + 8].copy_from_slice(&patch);
        file.extend_from_slice(&moov);
        let movie = crate::demux::parse_bytes(&file).unwrap();
        assert_eq!(movie.tracks[0].samples.iter().map(|s| s.pts).collect::<Vec<_>>(), [0, 2, 1, 3]);
        assert_eq!(movie.tracks[0].edit_shift, -1);

        // times no file has are no panic
        let mut mx = Muxer::new();
        let t = mx.add_track(TrackDesc::Video { codec: "vp09.00.10.08".into(), width: 64, height: 48, timescale: 1, description: vec![] });
        let _ = mx.start();
        for (dts, pts) in [(i64::MIN, i64::MAX), (i64::MAX, i64::MIN), (0, i64::MIN), (i64::MIN, 0)] {
            let _ = mx.add_sample(t, dts, pts, u32::MAX, true, 1);
        }
        let _ = mx.finish();
    }

    /// An encoder that gives no record of its own gets one made from its
    /// codec string: the profile, level, tier and depth the string names.
    #[test]
    fn records_made_from_codec_strings() {
        // av1C: marker and version, profile|level, tier|high|twelve|mono|subsampling, no delay
        assert_eq!(synth_av1c("av01.0.08M.08"), [0x81, 0x08, 0x0c, 0]);
        assert_eq!(synth_av1c("av01.1.13H.10"), [0x81, 0x2d, 0xcc, 0]);
        assert_eq!(synth_av1c("av01.2.19H.12"), [0x81, 0x53, 0xec, 0]);
        // what a string leaves out: the main profile, level 0, the main tier, eight bits
        assert_eq!(synth_av1c("av01"), [0x81, 0x00, 0x0c, 0]);
        assert_eq!(synth_av1c("av01.0"), [0x81, 0x00, 0x0c, 0]);
        // a string that is none is no panic (its level used to be cut out by bytes)
        for odd in ["av01.0.", "av01.0.M", "av01.0.é", "av01.0.08é.08", "av01.x.y.z", "av01.9.99H.99", "é"] {
            assert_eq!(synth_av1c(odd).len(), 4, "{odd}");
        }
        assert_eq!(synth_av1c("av01.0.é"), [0x81, 0x00, 0x0c, 0]);
        // vpcC: profile, level, depth|4:2:0|limited range, BT.709 three times, no data
        assert_eq!(synth_vpcc("vp09.00.10.08"), [0, 10, 0x82, 1, 1, 1, 0, 0]);
        assert_eq!(synth_vpcc("vp09.02.41.10"), [2, 41, 0xa2, 1, 1, 1, 0, 0]);
        assert_eq!(synth_vpcc("vp09"), [0, 10, 0x82, 1, 1, 1, 0, 0]);
        assert_eq!(synth_vpcc("vp09.é.é.é"), [0, 10, 0x82, 1, 1, 1, 0, 0]);
    }
}
