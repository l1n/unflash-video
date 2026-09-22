//! The demuxer: a byte-range state machine that finds the `moov` (and any
//! `moof`) boxes, then expands the sample tables.

use serde::{Deserialize, Serialize};

use crate::codec::{from_sample_entry, CodecInfo};
use crate::reader::{box_header, for_each_box, fourcc_str, Reader};
use crate::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
    Other,
}

/// One sample (an encoded frame or audio packet).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sample {
    /// Absolute byte offset in the file.
    pub offset: u64,
    pub size: u32,
    /// Decode time, track timescale ticks.
    pub dts: i64,
    /// Presentation time, track timescale ticks (edit list applied).
    pub pts: i64,
    /// Duration in ticks.
    pub duration: u32,
    pub sync: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: u32,
    pub kind: TrackKind,
    /// The sample entry's fourcc, e.g. `avc1`.
    pub fourcc: String,
    /// WebCodecs codec string.
    pub codec: String,
    /// WebCodecs decoder `description`, if the codec needs one.
    pub description: Option<Vec<u8>>,
    pub timescale: u32,
    pub width: u32,
    pub height: u32,
    pub sample_rate: u32,
    pub channels: u32,
    /// The whole sample entry box (header included), for stream copying.
    pub sample_entry: Vec<u8>,
    /// Ticks subtracted from composition times by the edit list (positive
    /// media_time) or added (leading empty edit).
    pub edit_shift: i64,
    pub samples: Vec<Sample>,
    /// Nominal ticks per sample (a video frame, an audio packet), 0 when
    /// the file does not say.
    #[serde(default)]
    pub frame_duration: u32,
    /// Bytes every sample starts with that the file leaves out (Matroska
    /// header stripping): put them back in front of each sample read.
    #[serde(default)]
    pub prefix: Vec<u8>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub language: String,
    /// Why the track cannot be used, when it cannot.
    #[serde(default)]
    pub note: String,
}

impl Track {
    pub fn pts_secs(&self, i: usize) -> f64 {
        self.samples[i].pts as f64 / self.timescale as f64
    }
    pub fn to_secs(&self, ticks: i64) -> f64 {
        ticks as f64 / self.timescale as f64
    }
    pub fn to_us(&self, ticks: i64) -> i64 {
        // exact where the timescale divides 1e6, correctly rounded otherwise
        let ts = self.timescale as i128;
        let v = ticks as i128 * 1_000_000;
        ((v + if v >= 0 { ts / 2 } else { -(ts / 2) }) / ts) as i64
    }
    /// Duration from the first pts to the end of the last sample, seconds.
    pub fn duration_secs(&self) -> f64 {
        let mut lo = i64::MAX;
        let mut hi = i64::MIN;
        for s in &self.samples {
            lo = lo.min(s.pts);
            hi = hi.max(s.pts + s.duration as i64);
        }
        if lo == i64::MAX {
            0.0
        } else {
            (hi - lo) as f64 / self.timescale as f64
        }
    }
    /// Presentation times of sync samples, seconds, ascending.
    pub fn keyframe_times(&self) -> Vec<f64> {
        let mut v: Vec<f64> = self.samples.iter().filter(|s| s.sync).map(|s| s.pts as f64 / self.timescale as f64).collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v
    }
    /// Index (decode order) of the last sync sample whose pts is at or
    /// before `t` seconds, or 0.
    pub fn sync_before(&self, t: f64) -> usize {
        let ticks = (t * self.timescale as f64).floor() as i64;
        let mut best = 0;
        for (i, s) in self.samples.iter().enumerate() {
            if s.sync && s.pts <= ticks {
                best = i;
            }
        }
        best
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Movie {
    pub timescale: u32,
    pub duration_secs: f64,
    pub fragmented: bool,
    pub brands: Vec<String>,
    /// The container: `mp4`, `matroska` or `webm`.
    #[serde(default)]
    pub format: String,
    pub tracks: Vec<Track>,
}

impl Movie {
    pub fn video(&self) -> Option<&Track> {
        self.tracks.iter().find(|t| t.kind == TrackKind::Video && !t.samples.is_empty())
    }
    pub fn audio(&self) -> Option<&Track> {
        self.tracks.iter().find(|t| t.kind == TrackKind::Audio && !t.samples.is_empty())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Header,
    Body { size: u64, kind: [u8; 4] },
    Done,
}

/// Byte-range driven parser for any container Unflash reads (MP4 and
/// QuickTime, Matroska and WebM), told apart by their first bytes. Loop:
/// `need()` -> read that range -> `feed()` until `movie()` is `Some`.
pub struct Demuxer {
    file_size: u64,
    inner: Inner,
    sniffed: u64,
}

enum Inner {
    /// Waiting for the first bytes.
    Sniff,
    Mp4(Mp4Demuxer),
    Mkv(crate::mkv::MkvDemuxer),
}

const SNIFF_LEN: u64 = 1024;

/// What a file's first bytes say it is, when it is not something Unflash
/// reads: a name for it and what to do about it.
fn foreign(b: &[u8]) -> Option<(&'static str, &'static str)> {
    let at = |o: usize, sig: &[u8]| b.len() >= o + sig.len() && &b[o..o + sig.len()] == sig;
    const REMUX: &str = "If its video is H.264 (most are), remux it without re-encoding, for example with `ffmpeg -i input -c copy output.mkv`, and open that.";
    const CONVERT: &str = "Convert it first, for example with HandBrake or `ffmpeg -i input -c:v libx264 -c:a aac output.mp4`.";
    if at(0, b"RIFF") && at(8, b"AVI ") {
        return Some(("an AVI file", CONVERT));
    }
    if at(0, b"RIFF") && at(8, b"WAVE") {
        return Some(("a WAV audio file", "It has no video to check."));
    }
    if at(0, b"FLV") {
        return Some(("a Flash video (FLV) file", REMUX));
    }
    if at(0, b"OggS") {
        return Some(("an Ogg file", CONVERT));
    }
    if at(0, &[0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11]) {
        return Some(("a Windows Media (WMV/ASF) file", CONVERT));
    }
    if at(0, &[0x00, 0x00, 0x01, 0xBA]) {
        return Some(("an MPEG program stream (.mpg / .vob)", CONVERT));
    }
    // transport streams: a sync byte every 188 bytes (every 192 with a timecode)
    for (start, step) in [(0usize, 188usize), (4, 192)] {
        if b.len() > start + 3 * step && (0..4).all(|k| b[start + k * step] == 0x47) {
            return Some(("an MPEG transport stream (.ts / .m2ts)", REMUX));
        }
    }
    None
}

impl Demuxer {
    pub fn new(file_size: u64) -> Self {
        Demuxer { file_size, inner: Inner::Sniff, sniffed: 0 }
    }

    /// The (offset, length) the parser needs next, or `None` when done.
    pub fn need(&self) -> Option<(u64, u64)> {
        match &self.inner {
            Inner::Sniff => (self.file_size > 0).then(|| (0, SNIFF_LEN.min(self.file_size))),
            Inner::Mp4(d) => d.need(),
            Inner::Mkv(d) => d.need(),
        }
    }

    pub fn is_done(&self) -> bool {
        match &self.inner {
            Inner::Sniff => self.file_size == 0,
            Inner::Mp4(d) => d.is_done(),
            Inner::Mkv(d) => d.is_done(),
        }
    }

    /// Bytes requested so far.
    pub fn bytes_read(&self) -> u64 {
        self.sniffed
            + match &self.inner {
                Inner::Sniff => 0,
                Inner::Mp4(d) => d.bytes_read(),
                Inner::Mkv(d) => d.bytes_read(),
            }
    }

    /// How far through the work of reading the index the parser is, 0 to
    /// 1 (a Matroska file has to be read through; an MP4's index is one
    /// box or a few).
    pub fn progress(&self) -> f64 {
        match &self.inner {
            Inner::Sniff => 0.0,
            Inner::Mp4(d) => {
                if d.is_done() {
                    1.0
                } else {
                    0.5
                }
            }
            Inner::Mkv(d) => d.progress(),
        }
    }

    /// `mp4`, `matroska`, or `` before the first bytes are seen.
    pub fn container(&self) -> &'static str {
        match &self.inner {
            Inner::Sniff => "",
            Inner::Mp4(_) => "mp4",
            Inner::Mkv(_) => "matroska",
        }
    }

    pub fn feed(&mut self, offset: u64, data: &[u8]) -> Result<(), Error> {
        match &mut self.inner {
            Inner::Sniff => {
                self.sniffed += data.len() as u64;
                if data.len() >= 4 && data[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
                    self.inner = Inner::Mkv(crate::mkv::MkvDemuxer::new(self.file_size));
                } else if let Some((what, advice)) = foreign(data) {
                    return Err(format!("This is {what}. Unflash reads MP4, MOV, M4V, MKV and WebM files. {advice}"));
                } else {
                    self.inner = Inner::Mp4(Mp4Demuxer::new(self.file_size));
                }
                let _ = offset;
                Ok(())
            }
            Inner::Mp4(d) => d.feed(offset, data),
            Inner::Mkv(d) => d.feed(offset, data),
        }
    }

    pub fn movie(&self) -> Option<&Movie> {
        match &self.inner {
            Inner::Sniff => None,
            Inner::Mp4(d) => d.movie(),
            Inner::Mkv(d) => d.movie(),
        }
    }

    pub fn into_movie(self) -> Option<Movie> {
        match self.inner {
            Inner::Sniff => None,
            Inner::Mp4(d) => d.into_movie(),
            Inner::Mkv(d) => d.into_movie(),
        }
    }
}

/// The MP4 / QuickTime parser behind [`Demuxer`].
#[derive(Clone, Debug)]
pub struct Mp4Demuxer {
    file_size: u64,
    at: u64,
    stage: Stage,
    want: Option<(u64, u64)>,
    ftyp: Option<Vec<u8>>,
    moov: Option<Vec<u8>>,
    moofs: Vec<(u64, Vec<u8>)>,
    movie: Option<Movie>,
    bytes_read: u64,
}

const HEADER_PEEK: u64 = 32;

impl Mp4Demuxer {
    pub fn new(file_size: u64) -> Self {
        let mut d = Mp4Demuxer {
            file_size,
            at: 0,
            stage: Stage::Header,
            want: None,
            ftyp: None,
            moov: None,
            moofs: Vec::new(),
            movie: None,
            bytes_read: 0,
        };
        d.request_header();
        d
    }

    fn request_header(&mut self) {
        if self.at + 8 > self.file_size {
            self.stage = Stage::Done;
            self.want = None;
        } else {
            self.stage = Stage::Header;
            self.want = Some((self.at, HEADER_PEEK.min(self.file_size - self.at)));
        }
    }

    /// The (offset, length) the parser needs next, or `None` when done.
    pub fn need(&self) -> Option<(u64, u64)> {
        self.want
    }

    pub fn is_done(&self) -> bool {
        self.stage == Stage::Done
    }

    /// Bytes requested so far (to show how little of the file was read).
    pub fn bytes_read(&self) -> u64 {
        self.bytes_read
    }

    /// Serve the bytes of the last `need()` range. `data` must start at the
    /// requested offset and cover the requested length (extra is fine).
    pub fn feed(&mut self, offset: u64, data: &[u8]) -> Result<(), Error> {
        let Some((want_off, want_len)) = self.want else {
            return Err("demuxer is not waiting for data".into());
        };
        if offset != want_off || (data.len() as u64) < want_len {
            return Err(format!("expected {want_len} bytes at {want_off}, got {} at {offset}", data.len()));
        }
        self.bytes_read += want_len;
        match self.stage {
            Stage::Header => {
                let h = box_header(data)?;
                let size = h.size.unwrap_or(self.file_size - self.at);
                if size < h.header_len || self.at + size > self.file_size {
                    return Err(format!("box {} at {} has an impossible size {size}", fourcc_str(&h.kind), self.at));
                }
                match &h.kind {
                    b"moov" | b"moof" | b"ftyp" => {
                        if (data.len() as u64) >= size {
                            self.take_body(h.kind, &data[..size as usize]);
                            self.advance(size);
                        } else {
                            self.stage = Stage::Body { size, kind: h.kind };
                            self.want = Some((self.at, size));
                        }
                    }
                    _ => self.advance(size),
                }
            }
            Stage::Body { size, kind } => {
                self.take_body(kind, &data[..size as usize]);
                self.advance(size);
            }
            Stage::Done => return Err("demuxer is done".into()),
        }
        if self.stage == Stage::Done && self.movie.is_none() {
            self.finish()?;
        }
        Ok(())
    }

    fn take_body(&mut self, kind: [u8; 4], whole: &[u8]) {
        match &kind {
            b"moov" => self.moov = Some(whole.to_vec()),
            b"moof" => self.moofs.push((self.at, whole.to_vec())),
            b"ftyp" => self.ftyp = Some(whole.to_vec()),
            _ => {}
        }
    }

    fn advance(&mut self, size: u64) {
        self.at += size;
        self.request_header();
    }

    pub fn movie(&self) -> Option<&Movie> {
        self.movie.as_ref()
    }

    pub fn into_movie(self) -> Option<Movie> {
        self.movie
    }

    fn finish(&mut self) -> Result<(), Error> {
        let moov = self.moov.as_ref().ok_or("no moov box found (not an MP4 file?)")?;
        let mut movie = parse_moov(moov)?;
        if let Some(ftyp) = &self.ftyp {
            let mut r = Reader::new(&ftyp[8..]);
            if let Ok(major) = r.fourcc() {
                movie.brands.push(fourcc_str(&major));
            }
            let _ = r.u32();
            while let Ok(b) = r.fourcc() {
                movie.brands.push(fourcc_str(&b));
            }
        }
        if !self.moofs.is_empty() {
            movie.fragmented = true;
            let mut next_dts: Vec<i64> = movie.tracks.iter().map(|t| t.samples.last().map(|s| s.dts + s.duration as i64).unwrap_or(0)).collect();
            for (off, moof) in &self.moofs {
                apply_moof(&mut movie, *off, moof, &mut next_dts)?;
            }
        }
        for t in &mut movie.tracks {
            finish_track(t);
        }
        movie.duration_secs = movie.tracks.iter().map(|t| t.duration_secs()).fold(movie.duration_secs, f64::max);
        self.movie = Some(movie);
        Ok(())
    }
}

/// Parse a whole file already in memory (tests, small files).
pub fn parse_bytes(data: &[u8]) -> Result<Movie, Error> {
    let mut d = Demuxer::new(data.len() as u64);
    while let Some((off, len)) = d.need() {
        let end = (off + len).min(data.len() as u64);
        d.feed(off, &data[off as usize..end as usize])?;
    }
    d.into_movie().ok_or_else(|| "no movie".to_string())
}

// ---- moov ------------------------------------------------------------------

#[derive(Default)]
struct Stbl {
    stts: Vec<(u32, u32)>,
    ctts: Vec<(u32, i64)>,
    stsc: Vec<(u32, u32, u32)>,
    sizes: Vec<u32>,
    fixed_size: u32,
    sample_count: u32,
    chunk_offsets: Vec<u64>,
    stss: Option<Vec<u32>>,
}

#[derive(Default, Clone)]
struct Trex {
    default_duration: u32,
    default_size: u32,
    default_flags: u32,
}

struct TrakParts {
    id: u32,
    kind: TrackKind,
    width: u32,
    height: u32,
    timescale: u32,
    elst: Vec<(i64, i64)>, // (segment_duration in movie ts, media_time in track ts)
    fourcc: [u8; 4],
    entry: Vec<u8>,
    codec: CodecInfo,
    sample_rate: u32,
    channels: u32,
    stbl: Stbl,
}

fn parse_moov(moov: &[u8]) -> Result<Movie, Error> {
    let body = &moov[box_header(moov)?.header_len as usize..];
    let mut movie = Movie { timescale: 1000, duration_secs: 0.0, fragmented: false, brands: vec![], format: "mp4".into(), tracks: vec![] };
    let mut traks: Vec<TrakParts> = Vec::new();
    let mut trex: Vec<(u32, Trex)> = Vec::new();
    for_each_box(body, |kind, b, _| {
        match &kind {
            b"mvhd" => {
                let mut r = Reader::new(b);
                let (v, _) = r.version_flags()?;
                if v == 1 {
                    r.skip(16)?;
                    movie.timescale = r.u32()?;
                    let d = r.u64()?;
                    movie.duration_secs = d as f64 / movie.timescale.max(1) as f64;
                } else {
                    r.skip(8)?;
                    movie.timescale = r.u32()?;
                    let d = r.u32()?;
                    movie.duration_secs = if d == u32::MAX { 0.0 } else { d as f64 / movie.timescale.max(1) as f64 };
                }
            }
            b"trak" => traks.push(parse_trak(b)?),
            b"mvex" => {
                for_each_box(b, |k, tb, _| {
                    if &k == b"trex" {
                        let mut r = Reader::new(tb);
                        r.version_flags()?;
                        let id = r.u32()?;
                        r.u32()?; // default sample description index
                        let t = Trex { default_duration: r.u32()?, default_size: r.u32()?, default_flags: r.u32()? };
                        trex.push((id, t));
                    }
                    Ok(())
                })?;
            }
            _ => {}
        }
        Ok(())
    })?;
    if traks.is_empty() {
        return Err("moov has no tracks".into());
    }
    for tp in traks {
        let mut track = Track {
            id: tp.id,
            kind: tp.kind,
            fourcc: fourcc_str(&tp.fourcc),
            codec: tp.codec.codec,
            description: tp.codec.description,
            timescale: tp.timescale.max(1),
            width: tp.width,
            height: tp.height,
            sample_rate: tp.sample_rate,
            channels: tp.channels,
            sample_entry: tp.entry,
            edit_shift: 0,
            samples: Vec::new(),
            frame_duration: 0,
            prefix: Vec::new(),
            name: String::new(),
            language: String::new(),
            note: String::new(),
        };
        track.edit_shift = edit_shift(&tp.elst, movie.timescale, track.timescale);
        track.samples = expand_samples(&tp.stbl)?;
        movie.tracks.push(track);
    }
    // stash trex defaults for fragments on the track (by id) via a side table
    TREX.with(|t| *t.borrow_mut() = trex);
    Ok(movie)
}

thread_local! {
    static TREX: std::cell::RefCell<Vec<(u32, Trex)>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn edit_shift(elst: &[(i64, i64)], movie_ts: u32, track_ts: u32) -> i64 {
    // A leading empty edit (media_time -1) delays the track: add its
    // duration. A normal first edit with media_time > 0 skips into the
    // media: subtract it. Anything more elaborate is ignored.
    let mut shift = 0i64;
    let mut it = elst.iter().copied().peekable();
    if let Some((dur, mt)) = it.peek().copied() {
        if mt == -1 {
            shift += (dur as i128 * track_ts as i128 / movie_ts.max(1) as i128) as i64;
            it.next();
        }
    }
    if let Some((_, mt)) = it.next() {
        if mt > 0 {
            shift -= mt;
        }
    }
    shift
}

fn parse_trak(trak: &[u8]) -> Result<TrakParts, Error> {
    let mut tp = TrakParts {
        id: 0,
        kind: TrackKind::Other,
        width: 0,
        height: 0,
        timescale: 1000,
        elst: vec![],
        fourcc: *b"????",
        entry: vec![],
        codec: CodecInfo::default(),
        sample_rate: 0,
        channels: 0,
        stbl: Stbl::default(),
    };
    for_each_box(trak, |kind, b, _| {
        match &kind {
            b"tkhd" => {
                let mut r = Reader::new(b);
                let (v, _) = r.version_flags()?;
                if v == 1 {
                    r.skip(16)?;
                    tp.id = r.u32()?;
                    r.skip(4 + 8)?;
                } else {
                    r.skip(8)?;
                    tp.id = r.u32()?;
                    r.skip(4 + 4)?;
                }
                r.skip(8 + 2 + 2 + 2 + 2 + 36)?;
                tp.width = r.u32()? >> 16;
                tp.height = r.u32()? >> 16;
            }
            b"edts" => {
                if let Some(e) = crate::reader::find_box(b, b"elst") {
                    let mut r = Reader::new(e);
                    let (v, _) = r.version_flags()?;
                    let n = r.u32()?;
                    for _ in 0..n {
                        let (dur, mt) = if v == 1 { (r.u64()? as i64, r.i64()?) } else { (r.u32()? as i64, r.i32()? as i64) };
                        r.skip(4)?; // rate
                        tp.elst.push((dur, mt));
                    }
                }
            }
            b"mdia" => parse_mdia(b, &mut tp)?,
            _ => {}
        }
        Ok(())
    })?;
    Ok(tp)
}

fn parse_mdia(mdia: &[u8], tp: &mut TrakParts) -> Result<(), Error> {
    for_each_box(mdia, |kind, b, _| {
        match &kind {
            b"mdhd" => {
                let mut r = Reader::new(b);
                let (v, _) = r.version_flags()?;
                if v == 1 {
                    r.skip(16)?;
                } else {
                    r.skip(8)?;
                }
                tp.timescale = r.u32()?;
            }
            b"hdlr" => {
                let mut r = Reader::new(b);
                r.version_flags()?;
                r.u32()?;
                let h = r.fourcc()?;
                tp.kind = match &h {
                    b"vide" => TrackKind::Video,
                    b"soun" => TrackKind::Audio,
                    _ => TrackKind::Other,
                };
            }
            b"minf" => {
                if let Some(stbl) = crate::reader::find_box(b, b"stbl") {
                    parse_stbl(stbl, tp)?;
                }
            }
            _ => {}
        }
        Ok(())
    })
}

fn parse_stbl(stbl: &[u8], tp: &mut TrakParts) -> Result<(), Error> {
    for_each_box(stbl, |kind, b, _| {
        let mut r = Reader::new(b);
        match &kind {
            b"stsd" => {
                r.version_flags()?;
                let n = r.u32()?;
                if n == 0 {
                    return Err("empty stsd".into());
                }
                let entries = r.rest();
                let mut first = true;
                for_each_box(entries, |fourcc, body, whole| {
                    if !first {
                        return Ok(());
                    }
                    first = false;
                    tp.fourcc = fourcc;
                    tp.entry = whole.to_vec();
                    let mut er = Reader::new(body);
                    match tp.kind {
                        TrackKind::Video => {
                            er.skip(6 + 2 + 2 + 2 + 12)?;
                            let w = er.u16()? as u32;
                            let h = er.u16()? as u32;
                            if tp.width == 0 {
                                tp.width = w;
                            }
                            if tp.height == 0 {
                                tp.height = h;
                            }
                            er.skip(4 + 4 + 4 + 2 + 32 + 2 + 2)?;
                        }
                        TrackKind::Audio => {
                            er.skip(6 + 2)?;
                            let version = er.u16()?;
                            er.skip(2 + 4)?;
                            tp.channels = er.u16()? as u32;
                            er.skip(2 + 2 + 2)?;
                            tp.sample_rate = er.u32()? >> 16;
                            if version == 1 {
                                er.skip(16)?;
                            } else if version == 2 {
                                er.skip(36)?;
                            }
                        }
                        TrackKind::Other => {}
                    }
                    let children = er.rest();
                    tp.codec = from_sample_entry(&fourcc, children).unwrap_or_else(|_| CodecInfo { codec: fourcc_str(&fourcc), description: None });
                    Ok(())
                })?;
            }
            b"stts" => {
                r.version_flags()?;
                let n = r.u32()?;
                for _ in 0..n {
                    tp.stbl.stts.push((r.u32()?, r.u32()?));
                }
            }
            b"ctts" => {
                let (v, _) = r.version_flags()?;
                let n = r.u32()?;
                for _ in 0..n {
                    let c = r.u32()?;
                    let o = if v == 1 { r.i32()? as i64 } else { r.u32()? as i64 };
                    tp.stbl.ctts.push((c, o));
                }
            }
            b"stsc" => {
                r.version_flags()?;
                let n = r.u32()?;
                for _ in 0..n {
                    tp.stbl.stsc.push((r.u32()?, r.u32()?, r.u32()?));
                }
            }
            b"stsz" => {
                r.version_flags()?;
                tp.stbl.fixed_size = r.u32()?;
                tp.stbl.sample_count = r.u32()?;
                if tp.stbl.fixed_size == 0 {
                    for _ in 0..tp.stbl.sample_count {
                        tp.stbl.sizes.push(r.u32()?);
                    }
                }
            }
            b"stz2" => {
                r.version_flags()?;
                r.u24()?;
                let field = r.u8()?;
                tp.stbl.sample_count = r.u32()?;
                match field {
                    16 => {
                        for _ in 0..tp.stbl.sample_count {
                            tp.stbl.sizes.push(r.u16()? as u32);
                        }
                    }
                    8 => {
                        for _ in 0..tp.stbl.sample_count {
                            tp.stbl.sizes.push(r.u8()? as u32);
                        }
                    }
                    4 => {
                        let mut i = 0;
                        while i < tp.stbl.sample_count {
                            let b = r.u8()?;
                            tp.stbl.sizes.push((b >> 4) as u32);
                            if i + 1 < tp.stbl.sample_count {
                                tp.stbl.sizes.push((b & 15) as u32);
                            }
                            i += 2;
                        }
                    }
                    _ => return Err("bad stz2 field size".into()),
                }
            }
            b"stco" => {
                r.version_flags()?;
                let n = r.u32()?;
                for _ in 0..n {
                    tp.stbl.chunk_offsets.push(r.u32()? as u64);
                }
            }
            b"co64" => {
                r.version_flags()?;
                let n = r.u32()?;
                for _ in 0..n {
                    tp.stbl.chunk_offsets.push(r.u64()?);
                }
            }
            b"stss" => {
                r.version_flags()?;
                let n = r.u32()?;
                let mut v = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    v.push(r.u32()?);
                }
                tp.stbl.stss = Some(v);
            }
            _ => {}
        }
        Ok(())
    })
}

fn expand_samples(s: &Stbl) -> Result<Vec<Sample>, Error> {
    let n = s.sample_count as usize;
    if n == 0 {
        return Ok(vec![]);
    }
    let size = |i: usize| -> u32 {
        if s.fixed_size != 0 {
            s.fixed_size
        } else {
            s.sizes.get(i).copied().unwrap_or(0)
        }
    };
    // durations / dts
    let mut dur = Vec::with_capacity(n);
    for &(count, delta) in &s.stts {
        for _ in 0..count {
            if dur.len() < n {
                dur.push(delta);
            }
        }
    }
    while dur.len() < n {
        dur.push(dur.last().copied().unwrap_or(1));
    }
    // composition offsets
    let mut cts = Vec::with_capacity(n);
    for &(count, off) in &s.ctts {
        for _ in 0..count {
            if cts.len() < n {
                cts.push(off);
            }
        }
    }
    while cts.len() < n {
        cts.push(0);
    }
    // chunk layout
    let mut offsets = Vec::with_capacity(n);
    if s.chunk_offsets.is_empty() || s.stsc.is_empty() {
        return Err("stbl without chunk offsets".into());
    }
    let nchunks = s.chunk_offsets.len();
    let mut sample = 0usize;
    for (ci, &coff) in s.chunk_offsets.iter().enumerate() {
        let chunk_no = (ci + 1) as u32;
        // samples per chunk for this chunk: the last stsc entry with first_chunk <= chunk_no
        let mut spc = s.stsc[0].1;
        for &(first, count, _) in &s.stsc {
            if first <= chunk_no {
                spc = count;
            } else {
                break;
            }
        }
        let mut pos = coff;
        for _ in 0..spc {
            if sample >= n {
                break;
            }
            offsets.push(pos);
            pos += size(sample) as u64;
            sample += 1;
        }
        if sample >= n {
            break;
        }
        let _ = nchunks;
    }
    while offsets.len() < n {
        // more samples than the chunk table accounts for: clamp
        let last = *offsets.last().unwrap_or(&0);
        offsets.push(last);
    }
    let sync: Vec<bool> = match &s.stss {
        None => vec![true; n],
        Some(list) => {
            let mut v = vec![false; n];
            for &k in list {
                if k >= 1 && (k as usize) <= n {
                    v[k as usize - 1] = true;
                }
            }
            v
        }
    };
    let mut out = Vec::with_capacity(n);
    let mut dts = 0i64;
    for i in 0..n {
        out.push(Sample { offset: offsets[i], size: size(i), dts, pts: dts + cts[i], duration: dur[i], sync: sync[i] });
        dts += dur[i] as i64;
    }
    Ok(out)
}

fn finish_track(t: &mut Track) {
    if t.edit_shift != 0 {
        for s in &mut t.samples {
            s.pts += t.edit_shift;
        }
    }
}

// ---- fragments ---------------------------------------------------------------

fn apply_moof(movie: &mut Movie, moof_offset: u64, moof: &[u8], next_dts: &mut [i64]) -> Result<(), Error> {
    let body = &moof[box_header(moof)?.header_len as usize..];
    let trex_all = TREX.with(|t| t.borrow().clone());
    let mut prev_traf_end: Option<u64> = None;
    for_each_box(body, |kind, traf, _| {
        if &kind != b"traf" {
            return Ok(());
        }
        // tfhd
        let tfhd = crate::reader::find_box(traf, b"tfhd").ok_or("traf without tfhd")?;
        let mut r = Reader::new(tfhd);
        let (_, flags) = r.version_flags()?;
        let track_id = r.u32()?;
        let ti = movie.tracks.iter().position(|t| t.id == track_id).ok_or("traf for unknown track")?;
        let trex = trex_all.iter().find(|(id, _)| *id == track_id).map(|(_, t)| t.clone()).unwrap_or_default();
        let mut base: Option<u64> = None;
        if flags & 0x1 != 0 {
            base = Some(r.u64()?);
        }
        if flags & 0x2 != 0 {
            r.u32()?;
        }
        let def_dur = if flags & 0x8 != 0 { r.u32()? } else { trex.default_duration };
        let def_size = if flags & 0x10 != 0 { r.u32()? } else { trex.default_size };
        let def_flags = if flags & 0x20 != 0 { r.u32()? } else { trex.default_flags };
        let default_base_is_moof = flags & 0x20000 != 0;
        let base = base.unwrap_or(if default_base_is_moof { moof_offset } else { prev_traf_end.unwrap_or(moof_offset) });
        // tfdt
        let mut dts = next_dts[ti];
        if let Some(tfdt) = crate::reader::find_box(traf, b"tfdt") {
            let mut r = Reader::new(tfdt);
            let (v, _) = r.version_flags()?;
            dts = if v == 1 { r.u64()? as i64 } else { r.u32()? as i64 };
        }
        // truns
        let mut data_pos = base;
        let mut end = base;
        let track = &mut movie.tracks[ti];
        for_each_box(traf, |k, trun, _| {
            if &k != b"trun" {
                return Ok(());
            }
            let mut r = Reader::new(trun);
            let (v, tf) = r.version_flags()?;
            let count = r.u32()?;
            if tf & 0x1 != 0 {
                data_pos = (base as i64 + r.i32()? as i64) as u64;
            }
            let first_flags = if tf & 0x4 != 0 { Some(r.u32()?) } else { None };
            for i in 0..count {
                let d = if tf & 0x100 != 0 { r.u32()? } else { def_dur };
                let sz = if tf & 0x200 != 0 { r.u32()? } else { def_size };
                let fl = if tf & 0x400 != 0 {
                    r.u32()?
                } else if i == 0 {
                    first_flags.unwrap_or(def_flags)
                } else {
                    def_flags
                };
                let cto = if tf & 0x800 != 0 {
                    if v == 0 {
                        r.u32()? as i64
                    } else {
                        r.i32()? as i64
                    }
                } else {
                    0
                };
                let sync = fl & 0x10000 == 0;
                track.samples.push(Sample { offset: data_pos, size: sz, dts, pts: dts + cto, duration: d, sync });
                data_pos += sz as u64;
                dts += d as i64;
            }
            end = end.max(data_pos);
            Ok(())
        })?;
        next_dts[ti] = dts;
        prev_traf_end = Some(end);
        Ok(())
    })
}
