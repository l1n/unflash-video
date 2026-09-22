//! JavaScript-facing API. Everything structured crosses the boundary as
//! JSON strings (small, and the app keeps the parsed objects); bulk data
//! (frames, sample tables) crosses as typed arrays.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use unflash_core::config::{DetectorConfig, Profile};
use unflash_core::detector::{CpuStage, Detector as CoreDetector, PixelStage};
use unflash_core::editing::{self, Edits, FrameSource, Prefer, SuggestStep};
use unflash_core::grid::FrameInput;
use unflash_core::pixel::MODE_FIRST;
use unflash_core::temporal::{AnalysisResult, FrameRecord, Violation};
use unflash_core::{sections, timeline};
use unflash_gpu::{FrameSource as GpuSource, GpuContext, GpuStage};
use unflash_h264::yuv::to_i420;
use unflash_mp4::demux::TrackKind;
use wasm_bindgen::prelude::*;

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn to_json<T: Serialize>(v: &T) -> Result<String, JsValue> {
    serde_json::to_string(v).map_err(js_err)
}

fn parse_cfg(json: &str) -> Result<DetectorConfig, JsValue> {
    serde_json::from_str(json).map_err(|e| js_err(format!("bad detector config: {e}")))
}

fn parse_edits(json: &str) -> Result<Edits, JsValue> {
    if json.trim().is_empty() {
        return Ok(Edits::new());
    }
    serde_json::from_str(json).map_err(|e| js_err(format!("bad edits: {e}")))
}

fn parse_only(json: Option<String>) -> Result<Option<BTreeSet<usize>>, JsValue> {
    match json {
        None => Ok(None),
        Some(s) if s.trim().is_empty() || s.trim() == "null" => Ok(None),
        Some(s) => {
            let v: Vec<usize> = serde_json::from_str(&s).map_err(|e| js_err(format!("bad selection: {e}")))?;
            Ok(Some(v.into_iter().collect()))
        }
    }
}

fn parse_violations(json: &str) -> Result<Vec<Violation>, JsValue> {
    serde_json::from_str(json).map_err(|e| js_err(format!("bad violations: {e}")))
}

fn parse_result(json: &str) -> Result<AnalysisResult, JsValue> {
    serde_json::from_str(json).map_err(|e| js_err(format!("bad analysis result: {e}")))
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ---- configuration --------------------------------------------------------

#[wasm_bindgen]
pub fn profile_names() -> String {
    let names: Vec<&str> = Profile::ALL.iter().map(|p| p.name()).collect();
    serde_json::to_string(&names).unwrap()
}

#[wasm_bindgen]
pub fn profile_config(name: &str) -> Result<String, JsValue> {
    let p = Profile::from_name(name).ok_or_else(|| js_err(format!("unknown profile {name}")))?;
    to_json(&p.config())
}

#[wasm_bindgen]
pub fn profile_name(config_json: &str) -> Result<String, JsValue> {
    Ok(parse_cfg(config_json)?.profile_name().to_string())
}

#[wasm_bindgen]
pub fn config_signature(config_json: &str) -> Result<String, JsValue> {
    Ok(parse_cfg(config_json)?.signature())
}

#[wasm_bindgen]
pub fn analysis_dims(config_json: &str, width: u32, height: u32) -> Result<Vec<u32>, JsValue> {
    let (aw, ah) = parse_cfg(config_json)?.analysis_dims(width, height);
    Ok(vec![aw, ah])
}

#[wasm_bindgen]
pub fn context_seconds(config_json: &str) -> Result<f64, JsValue> {
    Ok(sections::context_seconds(&parse_cfg(config_json)?))
}

#[wasm_bindgen]
pub fn safe_picture_rate(config_json: &str) -> Result<f64, JsValue> {
    Ok(sections::safe_picture_rate(&parse_cfg(config_json)?, sections::RATE_SAFETY_MARGIN).0)
}

#[wasm_bindgen]
pub fn rate_is_guaranteed(config_json: &str, fps: f64) -> Result<bool, JsValue> {
    Ok(sections::rate_is_guaranteed(&parse_cfg(config_json)?, fps))
}

// ---- sections and timelines ----------------------------------------------

#[wasm_bindgen]
pub fn violations_to_sections(violations_json: &str, config_json: &str, ts_min: f64, ts_max: f64, keyframes: &[f64]) -> Result<String, JsValue> {
    let v = parse_violations(violations_json)?;
    let cfg = parse_cfg(config_json)?;
    to_json(&sections::violations_to_sections(&v, &cfg, (ts_min, ts_max), keyframes))
}

/// Join the results of segments scanned in parallel (JSON `[{from, result}]`,
/// in order, each result with its per-frame statistics) into the result one
/// run over the whole file gives.
#[wasm_bindgen]
pub fn merge_scan_segments(config_json: &str, src_width: u32, src_height: u32, segments_json: &str) -> Result<String, JsValue> {
    let cfg = parse_cfg(config_json)?;
    let segs: Vec<unflash_core::temporal::Segment> = serde_json::from_str(segments_json).map_err(|e| js_err(format!("bad segments: {e}")))?;
    let det = CoreDetector::for_source(cfg.clone(), src_width, src_height);
    to_json(&unflash_core::temporal::merge_segments(&cfg, det.geometry(), &segs))
}

#[wasm_bindgen]
pub fn timeline_summary(result_json: &str, ts_min: f64, ts_max: f64, bin_seconds: f64) -> Result<String, JsValue> {
    let r = parse_result(result_json)?;
    to_json(&sections::timeline_summary(&r, (ts_min, ts_max), bin_seconds))
}

#[wasm_bindgen]
pub fn sanitize_deltas(times: &[f64], max_gap: f64) -> String {
    let (out, fixed) = timeline::sanitize_deltas(times, max_gap, 1.0 / 30.0);
    serde_json::json!({ "times": out, "fixed": fixed }).to_string()
}

#[wasm_bindgen]
pub fn shown_pts(pts: &[f64], start: f64, end: f64) -> Vec<f64> {
    timeline::shown_pts(pts, start, end)
}

#[wasm_bindgen]
pub fn section_timeline(pts: &[f64], start: f64, end: f64) -> String {
    let tl = timeline::section_timeline(pts, start, end);
    serde_json::json!({ "rel": tl.rel, "n_out": tl.n_out, "total": tl.total, "base": tl.base, "med": tl.med }).to_string()
}

#[wasm_bindgen]
pub fn median_dt(pts: &[f64]) -> f64 {
    timeline::median_dt(pts, 1.0 / 30.0)
}

#[wasm_bindgen]
pub fn format_time(t: f64) -> String {
    timeline::format_time(t)
}

#[wasm_bindgen]
pub fn parse_time(s: &str) -> Option<f64> {
    timeline::parse_time(s)
}

// ---- editing ---------------------------------------------------------------

#[wasm_bindgen]
pub fn replacement_map(edits_json: &str, n: u32) -> Result<Vec<u32>, JsValue> {
    let e = parse_edits(edits_json)?;
    Ok(editing::replacement_map(&e, n as usize).into_iter().map(|v| v as u32).collect())
}

#[wasm_bindgen]
pub fn edited_sequence(rel_pts: &[f64], edits_json: &str, extension_seconds: f64) -> Result<String, JsValue> {
    let e = parse_edits(edits_json)?;
    let seq = editing::edited_sequence(rel_pts, &e, extension_seconds);
    let t: Vec<f64> = seq.iter().map(|s| s.0).collect();
    let src: Vec<usize> = seq.iter().map(|s| s.1).collect();
    Ok(serde_json::json!({ "t": t, "src": src }).to_string())
}

#[wasm_bindgen]
pub fn picture_times(rel_pts: &[f64], edits_json: &str, extension_seconds: f64) -> Result<Vec<f64>, JsValue> {
    let e = parse_edits(edits_json)?;
    Ok(editing::picture_times(rel_pts, &e, extension_seconds))
}

#[wasm_bindgen]
pub fn flagged_frames(seq_times: &[f64], violations_json: &str) -> Result<Vec<u32>, JsValue> {
    let v = parse_violations(violations_json)?;
    let seq: Vec<(f64, usize)> = seq_times.iter().enumerate().map(|(i, &t)| (t, i)).collect();
    Ok(editing::flagged_frames(&seq, &v).into_iter().map(|x| x as u32).collect())
}

#[wasm_bindgen]
pub fn classify(result_json: &str, end_disp: f64, next_at: Option<f64>) -> Result<String, JsValue> {
    let r = parse_result(result_json)?;
    let c = editing::classify(&r, end_disp, next_at);
    Ok(serde_json::json!({ "inside": c.inside, "after": c.after, "elsewhere": c.elsewhere, "before": c.before }).to_string())
}

#[wasm_bindgen]
pub fn rate_proposal(
    config_json: &str,
    rel_pts: &[f64],
    edits_json: &str,
    only_json: Option<String>,
    fps: Option<f64>,
    extension_seconds: f64,
) -> Result<String, JsValue> {
    let cfg = parse_cfg(config_json)?;
    let e = parse_edits(edits_json)?;
    let only = parse_only(only_json)?;
    let p = editing::rate_proposal(&cfg, rel_pts, &e, only.as_ref(), fps, extension_seconds).map_err(js_err)?;
    Ok(serde_json::json!({
        "edits": p.edits,
        "removals": p.removals,
        "fps": p.fps,
        "safe_fps": p.safe_fps,
        "guaranteed": p.guaranteed,
        "pool": p.pool,
        "n_removed": p.n_removed,
        "only": p.only,
    })
    .to_string())
}

#[wasm_bindgen]
pub fn rate_note(proposal_json: &str, safe: bool) -> Result<String, JsValue> {
    let v: serde_json::Value = serde_json::from_str(proposal_json).map_err(js_err)?;
    let p = editing::RateProposal {
        edits: Edits::new(),
        removals: Edits::new(),
        fps: v["fps"].as_f64().unwrap_or(0.0),
        safe_fps: v["safe_fps"].as_f64().unwrap_or(0.0),
        guaranteed: v["guaranteed"].as_bool().unwrap_or(false),
        pool: v["pool"].as_u64().unwrap_or(0) as usize,
        n_removed: v["n_removed"].as_u64().unwrap_or(0) as usize,
        only: v["only"].as_bool().unwrap_or(false),
    };
    Ok(editing::rate_note(&p, safe))
}

#[wasm_bindgen]
pub fn apply_suggestion(existing_json: &str, suggested_json: &str, only_json: Option<String>) -> Result<String, JsValue> {
    let ex = parse_edits(existing_json)?;
    let su = parse_edits(suggested_json)?;
    let only = parse_only(only_json)?;
    to_json(&editing::apply_suggestion(&ex, &su, only.as_ref()))
}

#[wasm_bindgen]
pub fn area_downsample(rgba: &[u8], src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Vec<u8> {
    unflash_core::resample::area_downsample(rgba, 4, src_w, src_h, dst_w, dst_h)
}

// ---- frame cache -----------------------------------------------------------

/// Analysis-resolution RGBA frames of a section, in WASM memory.
#[wasm_bindgen]
pub struct FrameCache {
    width: u32,
    height: u32,
    /// RGB8, three bytes per pixel: a quarter less memory than the RGBA the
    /// captures arrive as, and all the detector reads.
    data: Vec<u8>,
    n: usize,
}

#[wasm_bindgen]
impl FrameCache {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> FrameCache {
        FrameCache { width, height, data: Vec::new(), n: 0 }
    }

    /// Add a frame, given as RGBA8 (as captures come) or RGB8.
    pub fn push(&mut self, pixels: &[u8]) -> Result<u32, JsValue> {
        let px = (self.width * self.height) as usize;
        if pixels.len() == px * 4 {
            self.data.reserve(px * 3);
            for p in pixels.chunks_exact(4) {
                self.data.extend_from_slice(&p[..3]);
            }
        } else if pixels.len() == px * 3 {
            self.data.extend_from_slice(pixels);
        } else {
            return Err(js_err(format!("frame has {} bytes, expected {} (RGBA) or {} (RGB)", pixels.len(), px * 4, px * 3)));
        }
        self.n += 1;
        Ok(self.n as u32 - 1)
    }

    pub fn len(&self) -> u32 {
        self.n as u32
    }
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn byte_length(&self) -> f64 {
        self.data.len() as f64
    }

    /// A copy of frame `i` as RGBA8 (opaque), ready for an ImageData.
    pub fn frame(&self, i: u32) -> Result<Vec<u8>, JsValue> {
        let f = self.frame_ref(i as usize).ok_or_else(|| js_err("no such frame"))?;
        let mut out = Vec::with_capacity(f.len() / 3 * 4);
        for p in f.chunks_exact(3) {
            out.extend_from_slice(p);
            out.push(255);
        }
        Ok(out)
    }

    /// Byte offset of frame `i` (RGB8) in WASM memory (for zero-copy views).
    pub fn frame_ptr(&self, i: u32) -> Result<usize, JsValue> {
        let f = self.frame_ref(i as usize).ok_or_else(|| js_err("no such frame"))?;
        Ok(f.as_ptr() as usize)
    }

    pub fn clear(&mut self) {
        self.data.clear();
        self.n = 0;
    }

    pub fn truncate(&mut self, n: u32) {
        let n = (n as usize).min(self.n);
        self.data.truncate(n * (self.width * self.height * 3) as usize);
        self.n = n;
    }

    /// A copy of this cache with the frames whose `mask` entry is non-zero
    /// blurred (three box passes of `radius`); the others are copied as
    /// they are. A short or empty mask blurs every frame.
    pub fn blurred(&self, radius: u32, mask: &[u8]) -> FrameCache {
        let fs = (self.width * self.height * 3) as usize;
        let mut out = FrameCache { width: self.width, height: self.height, data: Vec::with_capacity(self.data.len()), n: self.n };
        let mut tmp = Vec::new();
        for i in 0..self.n {
            let f = &self.data[i * fs..(i + 1) * fs];
            if mask.is_empty() || i >= mask.len() || mask[i] != 0 {
                unflash_core::resample::blur_rgb(f, self.width, self.height, radius, &mut tmp);
                out.data.extend_from_slice(&tmp);
            } else {
                out.data.extend_from_slice(f);
            }
        }
        out
    }
}

impl FrameCache {
    fn frame_ref(&self, i: usize) -> Option<&[u8]> {
        let fs = (self.width * self.height * 3) as usize;
        if i >= self.n {
            return None;
        }
        Some(&self.data[i * fs..(i + 1) * fs])
    }
}

impl FrameSource for FrameCache {
    fn frame(&self, i: usize) -> &[u8] {
        self.frame_ref(i).expect("frame index out of range")
    }
    fn bpp(&self) -> usize {
        3
    }
    fn width(&self) -> u32 {
        self.width
    }
    fn height(&self) -> u32 {
        self.height
    }
}

// ---- suggester -------------------------------------------------------------

#[wasm_bindgen]
pub struct Suggester {
    inner: editing::Suggester,
}

#[wasm_bindgen]
impl Suggester {
    #[wasm_bindgen(constructor)]
    pub fn new(rel_pts: &[f64], edits_json: &str, prefer: &str, only_json: Option<String>) -> Result<Suggester, JsValue> {
        let e = parse_edits(edits_json)?;
        let prefer = match prefer {
            "light" => Prefer::Light,
            "dark" => Prefer::Dark,
            other => return Err(js_err(format!("prefer must be light or dark, not {other}"))),
        };
        let only = parse_only(only_json)?;
        Ok(Suggester { inner: editing::Suggester::new(rel_pts.to_vec(), &e, prefer, only) })
    }

    /// Returns `{"simulate": edits}` (run the check on these and call again
    /// with the classified result) or `{"done": suggestion}`.
    pub fn step(&mut self, frames: &FrameCache, result_json: Option<String>) -> Result<String, JsValue> {
        let result = match result_json {
            Some(s) => Some(parse_result(&s)?),
            None => None,
        };
        match self.inner.step(frames, result.as_ref()) {
            SuggestStep::Simulate(edits) => Ok(serde_json::json!({ "simulate": edits }).to_string()),
            SuggestStep::Done(s) => Ok(serde_json::json!({ "done": s }).to_string()),
        }
    }
}

// ---- demuxer ---------------------------------------------------------------

#[wasm_bindgen]
pub struct Demuxer {
    inner: unflash_mp4::Demuxer,
}

#[derive(Serialize)]
struct TrackSummary {
    index: usize,
    id: u32,
    kind: TrackKind,
    fourcc: String,
    codec: String,
    description: Option<Vec<u8>>,
    timescale: u32,
    width: u32,
    height: u32,
    sample_rate: u32,
    channels: u32,
    samples: usize,
    keyframes: usize,
    duration_secs: f64,
    first_pts_secs: f64,
    last_pts_secs: f64,
}

#[wasm_bindgen]
impl Demuxer {
    #[wasm_bindgen(constructor)]
    pub fn new(file_size: f64) -> Demuxer {
        Demuxer { inner: unflash_mp4::Demuxer::new(file_size as u64) }
    }

    /// `[offset, length]` of the next range to feed, or an empty array when
    /// done.
    pub fn need(&self) -> Vec<f64> {
        match self.inner.need() {
            Some((o, l)) => vec![o as f64, l as f64],
            None => vec![],
        }
    }

    pub fn feed(&mut self, offset: f64, data: &[u8]) -> Result<(), JsValue> {
        self.inner.feed(offset as u64, data).map_err(js_err)
    }

    pub fn is_done(&self) -> bool {
        self.inner.is_done()
    }

    pub fn bytes_read(&self) -> f64 {
        self.inner.bytes_read() as f64
    }

    /// Movie summary as JSON (tracks without their sample tables).
    pub fn movie_json(&self) -> Result<String, JsValue> {
        let m = self.inner.movie().ok_or_else(|| js_err("not parsed yet"))?;
        let tracks: Vec<TrackSummary> = m
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| TrackSummary {
                index: i,
                id: t.id,
                kind: t.kind,
                fourcc: t.fourcc.clone(),
                codec: t.codec.clone(),
                description: t.description.clone(),
                timescale: t.timescale,
                width: t.width,
                height: t.height,
                sample_rate: t.sample_rate,
                channels: t.channels,
                samples: t.samples.len(),
                keyframes: t.samples.iter().filter(|s| s.sync).count(),
                duration_secs: t.duration_secs(),
                first_pts_secs: t.samples.iter().map(|s| s.pts).min().map(|p| t.to_secs(p)).unwrap_or(0.0),
                last_pts_secs: t.samples.iter().map(|s| s.pts).max().map(|p| t.to_secs(p)).unwrap_or(0.0),
            })
            .collect();
        Ok(serde_json::json!({
            "timescale": m.timescale,
            "duration_secs": m.duration_secs,
            "fragmented": m.fragmented,
            "brands": m.brands,
            "tracks": tracks,
        })
        .to_string())
    }

    fn track(&self, index: u32) -> Result<&unflash_mp4::Track, JsValue> {
        let m = self.inner.movie().ok_or_else(|| js_err("not parsed yet"))?;
        m.tracks.get(index as usize).ok_or_else(|| js_err("no such track"))
    }

    pub fn track_description(&self, index: u32) -> Result<Vec<u8>, JsValue> {
        Ok(self.track(index)?.description.clone().unwrap_or_default())
    }

    pub fn track_sample_entry(&self, index: u32) -> Result<Vec<u8>, JsValue> {
        Ok(self.track(index)?.sample_entry.clone())
    }

    /// One column of a track's sample table: `offset`, `size`, `pts_us`,
    /// `dts_us`, `duration_us`, `pts_secs` or `sync` (0/1).
    pub fn sample_table(&self, index: u32, field: &str) -> Result<Vec<f64>, JsValue> {
        let t = self.track(index)?;
        let v: Vec<f64> = match field {
            "offset" => t.samples.iter().map(|s| s.offset as f64).collect(),
            "size" => t.samples.iter().map(|s| s.size as f64).collect(),
            "pts_us" => t.samples.iter().map(|s| t.to_us(s.pts) as f64).collect(),
            "dts_us" => t.samples.iter().map(|s| t.to_us(s.dts) as f64).collect(),
            "duration_us" => t.samples.iter().map(|s| t.to_us(s.duration as i64) as f64).collect(),
            "pts_secs" => t.samples.iter().map(|s| t.to_secs(s.pts)).collect(),
            "pts_ticks" => t.samples.iter().map(|s| s.pts as f64).collect(),
            "dts_ticks" => t.samples.iter().map(|s| s.dts as f64).collect(),
            "duration_ticks" => t.samples.iter().map(|s| s.duration as f64).collect(),
            "sync" => t.samples.iter().map(|s| if s.sync { 1.0 } else { 0.0 }).collect(),
            other => return Err(js_err(format!("unknown sample field {other}"))),
        };
        Ok(v)
    }

    pub fn keyframe_times(&self, index: u32) -> Result<Vec<f64>, JsValue> {
        Ok(self.track(index)?.keyframe_times())
    }

    /// Decode-order index of the last keyframe at or before `t` seconds.
    pub fn sync_before(&self, index: u32, t: f64) -> Result<u32, JsValue> {
        Ok(self.track(index)?.sync_before(t) as u32)
    }
}

// ---- muxer -----------------------------------------------------------------

#[wasm_bindgen]
pub struct Muxer {
    inner: unflash_mp4::Muxer,
    patch: Option<(u64, [u8; 8])>,
}

#[wasm_bindgen]
impl Muxer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Muxer {
        Muxer { inner: unflash_mp4::Muxer::new(), patch: None }
    }

    pub fn add_video_track(&mut self, codec: &str, width: u32, height: u32, timescale: u32, description: &[u8]) -> u32 {
        self.inner.add_track(unflash_mp4::TrackDesc::Video {
            codec: codec.to_string(),
            width,
            height,
            timescale,
            description: description.to_vec(),
        }) as u32
    }

    /// `kind` is "video" or "audio"; `sample_entry` is the source track's
    /// sample entry box (see `Demuxer.track_sample_entry`).
    pub fn add_copy_track(&mut self, kind: &str, sample_entry: &[u8], timescale: u32, width: u32, height: u32) -> u32 {
        let kind = match kind {
            "video" => TrackKind::Video,
            "audio" => TrackKind::Audio,
            _ => TrackKind::Other,
        };
        self.inner.add_track(unflash_mp4::TrackDesc::Copy { kind, sample_entry: sample_entry.to_vec(), timescale, width, height }) as u32
    }

    /// The file head to write first.
    pub fn start(&mut self) -> Vec<u8> {
        self.inner.start()
    }

    /// Record a sample whose `size` bytes the caller appended to the file.
    pub fn add_sample(&mut self, track: u32, dts: f64, pts: f64, duration: f64, sync: bool, size: f64) -> Result<(), JsValue> {
        self.inner.add_sample(track as usize, dts as i64, pts as i64, duration as u32, sync, size as u32).map_err(js_err)
    }

    pub fn position(&self) -> f64 {
        self.inner.position() as f64
    }

    /// The `moov` box to append. Afterwards `patch_offset()` / `patch_bytes()`
    /// say which 8 bytes of the head to overwrite.
    pub fn finish(&mut self) -> Result<Vec<u8>, JsValue> {
        let (moov, patch) = self.inner.finish().map_err(js_err)?;
        self.patch = Some(patch);
        Ok(moov)
    }

    pub fn patch_offset(&self) -> f64 {
        self.patch.map(|p| p.0 as f64).unwrap_or(-1.0)
    }

    pub fn patch_bytes(&self) -> Vec<u8> {
        self.patch.map(|p| p.1.to_vec()).unwrap_or_default()
    }
}

impl Default for Muxer {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub fn codec_of_entry(entry: &[u8]) -> Result<String, JsValue> {
    let c = unflash_mp4::mux::codec_of_entry(entry).map_err(js_err)?;
    Ok(serde_json::json!({ "codec": c.codec, "description": c.description }).to_string())
}

// ---- detector --------------------------------------------------------------

enum Stage {
    Cpu(CpuStage),
    Gpu(Box<GpuStage>),
}

/// The flash detector, fed frame by frame.
#[wasm_bindgen]
pub struct Detector {
    det: CoreDetector,
    stage: Stage,
    records: Vec<FrameRecord>,
    captures: BTreeMap<usize, Vec<u8>>,
    /// capture flags of frames submitted to the GPU, in order
    pending_capture: std::collections::VecDeque<bool>,
    /// RGBA conversion buffer of the CPU detector's YUV input
    yuv_scratch: Vec<u8>,
}

#[wasm_bindgen]
impl Detector {
    /// CPU detector for a source of the given size.
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str, src_width: u32, src_height: u32) -> Result<Detector, JsValue> {
        let cfg = parse_cfg(config_json)?;
        let det = CoreDetector::for_source(cfg.clone(), src_width, src_height);
        let stage = CpuStage::new(&cfg, det.geometry().clone());
        Ok(Detector { det, stage: Stage::Cpu(stage), records: Vec::new(), captures: BTreeMap::new(), pending_capture: Default::default(), yuv_scratch: Vec::new() })
    }

    /// WebGPU detector; resolves to a `Detector` or rejects when there is no
    /// adapter. `batch` frames share one command buffer and one readback
    /// (results arrive when a batch is full or after `flush`); 1 gives a
    /// result after every frame, for the live monitor.
    #[wasm_bindgen(js_name = createGpu)]
    pub fn create_gpu(config_json: String, src_width: u32, src_height: u32, batch: Option<u32>) -> js_sys::Promise {
        wasm_bindgen_futures::future_to_promise(async move {
            let cfg = parse_cfg(&config_json)?;
            let ctx = GpuContext::new().await.map_err(js_err)?;
            let det = CoreDetector::for_source(cfg.clone(), src_width, src_height);
            let batch = batch.map(|b| b.max(1) as usize).unwrap_or(unflash_gpu::DEFAULT_BATCH);
            let stage = GpuStage::with_options(&ctx, &cfg, det.geometry().clone(), unflash_gpu::DEFAULT_SLOTS, batch).map_err(js_err)?;
            let d = Detector { det, stage: Stage::Gpu(Box::new(stage)), records: Vec::new(), captures: BTreeMap::new(), pending_capture: Default::default(), yuv_scratch: Vec::new() };
            Ok(JsValue::from(d))
        })
    }

    pub fn is_gpu(&self) -> bool {
        matches!(self.stage, Stage::Gpu(_))
    }
    pub fn analysis_width(&self) -> u32 {
        self.det.geometry().aw
    }
    pub fn analysis_height(&self) -> u32 {
        self.det.geometry().ah
    }
    pub fn window_width(&self) -> u32 {
        self.det.geometry().ww
    }
    pub fn window_height(&self) -> u32 {
        self.det.geometry().wh
    }
    pub fn area_thresh(&self) -> u32 {
        self.det.geometry().area_thresh
    }
    /// Pixels a regular pattern has to cover to count.
    pub fn pattern_thresh(&self) -> u32 {
        self.det.temporal().pattern_thresh()
    }
    pub fn config_json(&self) -> String {
        serde_json::to_string(self.det.config()).unwrap()
    }
    /// Frames whose results have been processed.
    pub fn frames(&self) -> u32 {
        self.det.frames() as u32
    }
    pub fn submitted(&self) -> u32 {
        self.det.submitted()
    }
    /// Frames submitted but not yet completed (GPU in flight).
    pub fn pending(&self) -> u32 {
        self.det.pending() as u32
    }
    pub fn can_submit(&self) -> bool {
        match &self.stage {
            Stage::Cpu(_) => true,
            Stage::Gpu(g) => g.can_submit(),
        }
    }
    pub fn capacity(&self) -> u32 {
        match &self.stage {
            Stage::Cpu(_) => 1,
            Stage::Gpu(g) => g.capacity() as u32,
        }
    }
    /// Approximate bytes of GPU memory traffic per frame (bandwidth model).
    pub fn bytes_per_frame(&self) -> f64 {
        match &self.stage {
            Stage::Cpu(_) => (self.det.geometry().npix() * 130) as f64,
            Stage::Gpu(g) => g.bytes_per_frame() as f64,
        }
    }

    /// Feed an RGBA8 picture of any size, stamped `t` seconds (native pts).
    pub fn feed_rgba(&mut self, rgba: &[u8], width: u32, height: u32, t: f64, capture: bool) -> Result<(), JsValue> {
        let (aw, ah) = (self.det.geometry().aw, self.det.geometry().ah);
        if rgba.len() < (width * height * 4) as usize {
            return Err(js_err("frame data too short"));
        }
        match &mut self.stage {
            Stage::Cpu(stage) => {
                let params = self.det.begin_frame(t);
                let small;
                let data: &[u8] = if (width, height) == (aw, ah) {
                    rgba
                } else {
                    small = unflash_core::resample::area_downsample(rgba, 4, width, height, aw, ah);
                    &small
                };
                let stats = stage.run(params, FrameInput::rgba(data));
                let rec = self.det.complete_frame(&stats);
                if capture {
                    self.captures.insert(rec.index, data[..(aw * ah * 4) as usize].to_vec());
                }
                self.records.push(rec);
                Ok(())
            }
            Stage::Gpu(stage) => {
                if !stage.can_submit() {
                    return Err(js_err("detector busy: poll() before submitting more frames"));
                }
                let params = self.det.begin_frame(t);
                stage.submit(params, GpuSource::Rgba8 { data: rgba, width, height }, capture).map_err(js_err)?;
                self.pending_capture.push_back(capture);
                Ok(())
            }
        }
    }

    /// Feed 8-bit 4:2:0 planes (I420 or NV12) of any size, as WebCodecs'
    /// `VideoFrame.copyTo` and the built-in decoder lay them out. `layout`
    /// is [format (0 I420, 1 NV12), y_off, y_stride, u_off, u_stride, v_off,
    /// v_stride, matrix (0 BT.601, 1 BT.709), full_range]. The GPU converts
    /// to RGB in a shader; the CPU detector converts in WASM.
    pub fn feed_yuv(&mut self, data: &[u8], width: u32, height: u32, layout: &[u32], t: f64, capture: bool) -> Result<(), JsValue> {
        let layout = unflash_core::yuv::YuvLayout::from_words(layout).ok_or_else(|| js_err("bad picture layout"))?;
        if width == 0 || height == 0 || !layout.fits(data.len(), width as usize, height as usize) {
            return Err(js_err("picture data too short for its layout"));
        }
        if matches!(self.stage, Stage::Cpu(_)) {
            let mut rgba = std::mem::take(&mut self.yuv_scratch);
            unflash_core::yuv::to_rgba(data, width as usize, height as usize, &layout, &mut rgba);
            let r = self.feed_rgba(&rgba, width, height, t, capture);
            self.yuv_scratch = rgba;
            return r;
        }
        let Stage::Gpu(stage) = &mut self.stage else { unreachable!() };
        if !stage.can_submit() {
            return Err(js_err("detector busy: poll() before submitting more frames"));
        }
        let params = self.det.begin_frame(t);
        stage.submit(params, GpuSource::Yuv420 { data, width, height, layout }, capture).map_err(js_err)?;
        self.pending_capture.push_back(capture);
        Ok(())
    }

    /// Feed frame `index` of a [`FrameCache`] (already at analysis
    /// resolution) without copying it out of WASM memory.
    pub fn feed_cached(&mut self, cache: &FrameCache, index: u32, t: f64) -> Result<(), JsValue> {
        let f = cache.frame_ref(index as usize).ok_or_else(|| js_err("no such cached frame"))?;
        let (aw, ah) = (self.det.geometry().aw, self.det.geometry().ah);
        if (cache.width, cache.height) != (aw, ah) {
            return Err(js_err(format!("cache is {}x{} but the detector analyses at {aw}x{ah}", cache.width, cache.height)));
        }
        match &mut self.stage {
            Stage::Cpu(stage) => {
                let params = self.det.begin_frame(t);
                let stats = stage.run(params, FrameInput::rgb(f));
                let rec = self.det.complete_frame(&stats);
                self.records.push(rec);
                Ok(())
            }
            Stage::Gpu(stage) => {
                if !stage.can_submit() {
                    return Err(js_err("detector busy: poll() before submitting more frames"));
                }
                let params = self.det.begin_frame(t);
                stage.submit(params, GpuSource::Rgb8 { data: f, width: aw, height: ah }, false).map_err(js_err)?;
                self.pending_capture.push_back(false);
                Ok(())
            }
        }
    }

    /// Feed the current picture of a `<video>` element (GPU detector only).
    #[cfg(target_arch = "wasm32")]
    pub fn feed_video_element(&mut self, video: &web_sys::HtmlVideoElement, t: f64, capture: bool) -> Result<(), JsValue> {
        let (w, h) = (video.video_width(), video.video_height());
        if w == 0 || h == 0 {
            return Err(js_err("video has no frame yet"));
        }
        self.feed_external(unflash_gpu::wgpu::ExternalImageSource::HTMLVideoElement(video.clone()), w, h, t, capture)
    }

    /// Feed a WebCodecs `VideoFrame` (GPU detector only). The caller closes
    /// the frame afterwards.
    #[cfg(target_arch = "wasm32")]
    pub fn feed_video_frame(&mut self, frame: &web_sys::VideoFrame, t: f64, capture: bool) -> Result<(), JsValue> {
        let (w, h) = match frame.visible_rect() {
            Some(r) => (r.width() as u32, r.height() as u32),
            None => (frame.coded_width(), frame.coded_height()),
        };
        if w == 0 || h == 0 {
            return Err(js_err("empty video frame"));
        }
        // a second JS handle to the same frame, not a WebCodecs clone (which
        // would need its own close())
        let handle: web_sys::VideoFrame = wasm_bindgen::JsCast::unchecked_into(wasm_bindgen::JsValue::from(frame));
        self.feed_external(unflash_gpu::wgpu::ExternalImageSource::VideoFrame(handle), w, h, t, capture)
    }

    /// Feed the picture of an `OffscreenCanvas` (GPU detector only). This is
    /// the route for browsers whose WebGPU does not take `VideoFrame` or
    /// `<video>` as a copy source (Firefox): the caller draws the frame into
    /// the canvas first.
    #[cfg(target_arch = "wasm32")]
    pub fn feed_canvas(&mut self, canvas: &web_sys::OffscreenCanvas, t: f64, capture: bool) -> Result<(), JsValue> {
        let (w, h) = (canvas.width(), canvas.height());
        if w == 0 || h == 0 {
            return Err(js_err("empty canvas"));
        }
        self.feed_external(unflash_gpu::wgpu::ExternalImageSource::OffscreenCanvas(canvas.clone()), w, h, t, capture)
    }

    /// Feed an `ImageBitmap` (GPU detector only). The caller closes it afterwards.
    #[cfg(target_arch = "wasm32")]
    pub fn feed_image_bitmap(&mut self, bitmap: &web_sys::ImageBitmap, t: f64, capture: bool) -> Result<(), JsValue> {
        let (w, h) = (bitmap.width(), bitmap.height());
        if w == 0 || h == 0 {
            return Err(js_err("empty image bitmap"));
        }
        self.feed_external(unflash_gpu::wgpu::ExternalImageSource::ImageBitmap(bitmap.clone()), w, h, t, capture)
    }

    /// Note: `wgpu` unwraps the result of `copyExternalImageToTexture`, so a
    /// source the browser's WebGPU rejects (Firefox takes neither
    /// `VideoFrame` nor `<video>`) would abort the whole WASM instance. The
    /// JS side (`web/detector.js`) probes every kind of source on a throwaway
    /// device before it lets one through here.
    #[cfg(target_arch = "wasm32")]
    fn feed_external(&mut self, source: unflash_gpu::wgpu::ExternalImageSource, w: u32, h: u32, t: f64, capture: bool) -> Result<(), JsValue> {
        use unflash_gpu::wgpu;
        let Stage::Gpu(stage) = &mut self.stage else {
            return Err(js_err("external sources need the GPU detector; use feed_rgba"));
        };
        if !stage.can_submit() {
            return Err(js_err("detector busy: poll() before submitting more frames"));
        }
        let tex = stage.source_texture(w, h).clone();
        stage.queue().copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo { source, origin: wgpu::Origin2d::ZERO, flip_y: false },
            wgpu::CopyExternalImageDestInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        let params = self.det.begin_frame(t);
        stage.submit(params, GpuSource::SourceTexture, capture).map_err(js_err)?;
        self.pending_capture.push_back(capture);
        Ok(())
    }

    /// Collect finished GPU frames. Returns how many completed.
    pub fn poll(&mut self) -> Result<u32, JsValue> {
        let Stage::Gpu(stage) = &mut self.stage else { return Ok(0) };
        let mut n = 0;
        while let Some(r) = stage.poll() {
            let frame = r.map_err(js_err)?;
            let capture = self.pending_capture.pop_front().unwrap_or(false);
            let rec = self.det.complete_frame(&frame.stats);
            if capture {
                if let Some(rgba) = frame.rgba {
                    self.captures.insert(rec.index, rgba);
                }
            }
            self.records.push(rec);
            n += 1;
        }
        Ok(n)
    }

    /// Records completed since the last drain, as a JSON array.
    pub fn drain_records(&mut self) -> Result<String, JsValue> {
        let out = to_json(&self.records)?;
        self.records.clear();
        Ok(out)
    }

    /// The captured analysis-resolution picture of frame `index`, once.
    pub fn take_capture(&mut self, index: u32) -> Option<Vec<u8>> {
        self.captures.remove(&(index as usize))
    }

    pub fn has_capture(&self, index: u32) -> bool {
        self.captures.contains_key(&(index as usize))
    }

    /// Events (strobing moments) so far, as JSON.
    pub fn events_json(&self) -> Result<String, JsValue> {
        to_json(&self.det.temporal().events())
    }

    /// The verdict over everything fed so far.
    pub fn finish(&self, include_stats: bool) -> Result<String, JsValue> {
        let mut r = self.det.finish();
        if !include_stats {
            r.frame_stats = Default::default();
        }
        to_json(&r)
    }

    pub fn reset(&mut self) {
        self.det.reset();
        self.records.clear();
        self.captures.clear();
        self.pending_capture.clear();
        if let Stage::Gpu(stage) = &mut self.stage {
            // frames still on the GPU belong to the old run
            stage.abandon();
        }
    }

    /// Run the detector over the frames fed since the last batch went out
    /// (a no-op on the CPU, whose frames are done as they are fed). Call
    /// before waiting for `pending()` to reach zero.
    pub fn flush(&mut self) {
        if let Stage::Gpu(stage) = &mut self.stage {
            stage.flush();
        }
    }

    /// Frames of the batch being filled: fed, but not yet run.
    pub fn queued(&self) -> u32 {
        match &self.stage {
            Stage::Gpu(stage) => stage.queued() as u32,
            Stage::Cpu(_) => 0,
        }
    }

    pub fn is_first_pending(&self) -> bool {
        self.det.submitted() == 0 || (self.det.params_template().mode & MODE_FIRST) != 0
    }
}

// ---- built-in H.264 decoder --------------------------------------------------

/// What the built-in decoder makes of an `avcC` record: JSON with the
/// profile, level and cropped size, or an error saying why the stream
/// cannot be decoded (4:2:2, high bit depth, slice groups, ...).
#[wasm_bindgen]
pub fn h264_probe(avcc: &[u8]) -> Result<String, JsValue> {
    let mut d = unflash_h264::Decoder::new();
    d.configure_avcc(avcc).map_err(js_err)?;
    let sps = d.first_sps().ok_or_else(|| js_err("no sequence parameter set in the file"))?;
    let (w, h) = sps.cropped_size();
    Ok(serde_json::json!({
        "profile_idc": sps.profile_idc,
        "level_idc": sps.level_idc,
        "width": w,
        "height": h,
        "cabac": true,
    })
    .to_string())
}

/// The WebAssembly linear memory, so JavaScript can read decoded pictures
/// in place (`H264Decoder::frame_ptr`).
#[wasm_bindgen]
pub fn wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}

/// A software H.264 decoder for one track: samples in decode order in,
/// I420 pictures (at the cropped size) out, one per sample. The picture
/// stays in WebAssembly memory; `frame_ptr` / `frame_len` locate it for a
/// `VideoFrame` of format I420 (which copies it).
#[wasm_bindgen]
pub struct H264Decoder {
    inner: unflash_h264::Decoder,
    frame: Vec<u8>,
    pts: f64,
    damaged: bool,
    width: u32,
    height: u32,
    color: String,
}

#[wasm_bindgen]
impl H264Decoder {
    /// `fast` leaves the deblocking filter out (about a quarter of the
    /// decoding time): pictures good for statistics, not for showing or
    /// re-encoding.
    #[wasm_bindgen(constructor)]
    pub fn new(avcc: &[u8], fast: bool) -> Result<H264Decoder, JsValue> {
        let mut inner = unflash_h264::Decoder::new();
        inner.set_skip_deblock(fast);
        inner.configure_avcc(avcc).map_err(js_err)?;
        let (width, height) = inner.first_sps().map(|s| s.cropped_size()).ok_or_else(|| js_err("no sequence parameter set in the file"))?;
        let color = color_space_json(inner.first_sps().unwrap());
        Ok(H264Decoder { inner, frame: Vec::new(), pts: 0.0, damaged: false, width, height, color })
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Decode one sample; returns true when its picture is ready.
    pub fn decode(&mut self, sample: &[u8], pts: f64) -> Result<bool, JsValue> {
        match self.inner.decode_sample(sample, pts).map_err(js_err)? {
            None => Ok(false),
            Some(f) => {
                let sps = self.inner.sps().ok_or_else(|| js_err("no active sequence"))?;
                let (w, h) = sps.cropped_size();
                to_i420(&f.pic, (sps.crop.0 as usize, sps.crop.2 as usize, w as usize, h as usize), &mut self.frame);
                if self.width != w || self.height != h {
                    self.color = color_space_json(sps);
                }
                self.width = w;
                self.height = h;
                self.pts = f.pic.pts;
                self.damaged = f.damaged;
                Ok(true)
            }
        }
    }

    /// Flush the picture in progress at the end of the stream (Annex B
    /// input only; MP4 samples always complete their picture).
    pub fn flush(&mut self) -> Result<bool, JsValue> {
        match self.inner.flush().map_err(js_err)? {
            None => Ok(false),
            Some(f) => {
                let sps = self.inner.sps().ok_or_else(|| js_err("no active sequence"))?;
                let (w, h) = sps.cropped_size();
                to_i420(&f.pic, (sps.crop.0 as usize, sps.crop.2 as usize, w as usize, h as usize), &mut self.frame);
                self.width = w;
                self.height = h;
                self.pts = f.pic.pts;
                self.damaged = f.damaged;
                Ok(true)
            }
        }
    }

    /// The last decoded picture as packed I420 (Y then Cb then Cr, no
    /// padding) in WebAssembly memory: its address and length in bytes.
    pub fn frame_ptr(&self) -> *const u8 {
        self.frame.as_ptr()
    }
    pub fn frame_len(&self) -> u32 {
        self.frame.len() as u32
    }
    /// A copy of the last picture (for callers that cannot read memory).
    pub fn frame_i420(&self) -> Vec<u8> {
        self.frame.clone()
    }
    pub fn frame_pts(&self) -> f64 {
        self.pts
    }
    pub fn frame_damaged(&self) -> bool {
        self.damaged
    }
    /// The picture's colour space as a `VideoColorSpaceInit` JSON object.
    pub fn color_json(&self) -> String {
        self.color.clone()
    }
}

/// The VideoColorSpace of a sequence, from its VUI or the usual defaults
/// by picture size.
fn color_space_json(sps: &unflash_h264::Sps) -> String {
    let (_, h) = sps.cropped_size();
    let hd = h > 576;
    let (mut primaries, mut transfer, mut matrix, mut full) = (if hd { "bt709" } else { "smpte170m" }, if hd { "bt709" } else { "smpte170m" }, if hd { "bt709" } else { "smpte170m" }, false);
    if let Some(v) = &sps.vui {
        full = v.video_full_range;
        primaries = match v.colour_primaries {
            1 => "bt709",
            5 => "bt470bg",
            6 => "smpte170m",
            9 => "bt2020",
            _ => primaries,
        };
        transfer = match v.transfer_characteristics {
            1 => "bt709",
            6 => "smpte170m",
            8 => "linear",
            13 => "iec61966-2-1",
            16 => "pq",
            18 => "hlg",
            _ => transfer,
        };
        matrix = match v.matrix_coefficients {
            0 => "rgb",
            1 => "bt709",
            5 => "bt470bg",
            6 => "smpte170m",
            9 => "bt2020-ncl",
            _ => matrix,
        };
    }
    serde_json::json!({ "primaries": primaries, "transfer": transfer, "matrix": matrix, "fullRange": full }).to_string()
}
