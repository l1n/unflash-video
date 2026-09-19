//! Section editing: replacement maps, the edited timeline, thinning to a
//! frame rate, the keep-light / keep-dark suggester, and classifying a
//! context-aware check's violations (port of `editing.py`).
//!
//! Anything that needs a detector run is expressed as a step machine
//! ([`Suggester`]) so the caller can simulate on whichever pixel stage it
//! has, synchronously on the CPU or asynchronously on the GPU.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::config::DetectorConfig;
use crate::lut::lut;
use crate::sections::{rate_is_guaranteed, safe_picture_rate, MAX_TARGET_FPS, RATE_SAFETY_MARGIN};
use crate::temporal::{AnalysisResult, Violation, ViolationKind};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fill {
    #[default]
    Prev,
    Next,
}

/// A frame mark. Serialises as `{"removed": bool, "extended": bool,
/// "fill": "prev"|"next"}`, compatible with the reference's project files.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FrameEdit {
    pub removed: bool,
    pub extended: bool,
    pub fill: Fill,
}

impl FrameEdit {
    pub fn removed(fill: Fill) -> Self {
        FrameEdit { removed: true, extended: false, fill }
    }
    pub fn extended() -> Self {
        FrameEdit { removed: false, extended: true, fill: Fill::Prev }
    }
    pub fn is_noop(&self) -> bool {
        !self.removed && !self.extended
    }
}

/// Marks by frame ordinal. JSON keys are strings ("12"), as in the
/// reference's project files.
pub type Edits = BTreeMap<usize, FrameEdit>;

/// Marks without the no-ops.
pub fn compact(edits: &Edits) -> Edits {
    edits.iter().filter(|(_, e)| !e.is_noop()).map(|(k, e)| (*k, *e)).collect()
}

/// For each of a section's `n` frames, the ordinal whose picture it shows.
///
/// A surviving frame shows itself. A removed one shows the nearest survivor
/// in its fill direction, falling back to the other direction where that
/// runs out. A section with nothing left at all holds its first frame.
pub fn replacement_map(edits: &Edits, n: usize) -> Vec<usize> {
    let gone: Vec<bool> = (0..n).map(|i| edits.get(&i).map(|e| e.removed).unwrap_or(false)).collect();
    let mut prev = vec![None; n];
    let mut seen = None;
    for i in 0..n {
        if !gone[i] {
            seen = Some(i);
        }
        prev[i] = seen;
    }
    let mut nxt = vec![None; n];
    seen = None;
    for i in (0..n).rev() {
        if !gone[i] {
            seen = Some(i);
        }
        nxt[i] = seen;
    }
    (0..n)
        .map(|i| {
            if !gone[i] {
                return i;
            }
            let forward = edits.get(&i).map(|e| e.fill == Fill::Next).unwrap_or(false);
            let (first, other) = if forward { (nxt[i], prev[i]) } else { (prev[i], nxt[i]) };
            first.or(other).unwrap_or(0)
        })
        .collect()
}

/// The section's edited timeline as (display_time, source_ordinal).
/// Removed frames stand in for the survivor `replacement_map` picks and
/// extended ones push everything after them later.
pub fn edited_sequence(rel_pts: &[f64], edits: &Edits, extension_seconds: f64) -> Vec<(f64, usize)> {
    let n = rel_pts.len();
    let rep = replacement_map(edits, n);
    let mut offset = 0.0;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let e = edits.get(&i).copied().unwrap_or_default();
        out.push((rel_pts[i] + offset, rep[i]));
        if e.extended && !e.removed {
            offset += extension_seconds;
        }
    }
    out
}

/// When each slot's picture first reaches the screen, per slot. A removal
/// marked "next" shows the survivor that follows it, so that survivor's
/// picture is already up before its own slot comes round.
pub fn picture_times(rel_pts: &[f64], edits: &Edits, extension_seconds: f64) -> Vec<f64> {
    let seq = edited_sequence(rel_pts, edits, extension_seconds);
    let mut first: BTreeMap<usize, f64> = BTreeMap::new();
    for &(t, src) in &seq {
        first.entry(src).or_insert(t);
    }
    seq.iter().map(|&(t, src)| *first.get(&src).unwrap_or(&t)).collect()
}

/// Which frames to remove so no two surviving pictures reach the screen
/// closer than `min_gap` seconds apart. Timestamps only.
///
/// `gone` are slots already removed (they neither space nor consume the
/// gap); `scope` restricts which slots may be removed (None = all). Frames
/// outside the scope are kept and still set the pace.
pub fn rate_limited_removals(
    times: &[f64],
    min_gap: f64,
    scope: Option<&BTreeSet<usize>>,
    gone: &BTreeSet<usize>,
) -> BTreeSet<usize> {
    let mut removed = BTreeSet::new();
    let mut last: Option<f64> = None;
    for (i, &t) in times.iter().enumerate() {
        if gone.contains(&i) {
            continue;
        }
        if let Some(l) = last {
            if t - l < min_gap - 1e-9 && scope.map(|s| s.contains(&i)).unwrap_or(true) {
                removed.insert(i);
                continue;
            }
        }
        last = Some(t);
    }
    removed
}

/// The ordinals of the frames inside failing windows (from each
/// violation's onset to its end, with a small tolerance).
pub fn flagged_frames(seq: &[(f64, usize)], violations: &[Violation]) -> Vec<usize> {
    let mut out = BTreeSet::new();
    for v in violations {
        let lo = v.onset.min(v.start);
        let hi = v.end;
        for (i, &(t, _)) in seq.iter().enumerate() {
            if lo - 0.05 <= t && t <= hi + 0.05 {
                out.insert(i);
            }
        }
    }
    out.into_iter().collect()
}

/// A context-aware simulation's violations split by where they land.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Classified {
    /// Overlapping the section: the ones its edits can act on.
    pub inside: Vec<Violation>,
    /// Starting after its last frame, in untouched footage.
    pub after: Vec<Violation>,
    /// Starting inside the *next* section: that section's to fix.
    pub elsewhere: Vec<Violation>,
    /// Finished before the section's first frame: the warm-up's own.
    pub before: Vec<Violation>,
}

/// Which side of the boundary a violation falls on is decided by `start`
/// and `end` -- where the flashing actually is -- never by `onset`.
pub fn classify(result: &AnalysisResult, end_disp: f64, next_at: Option<f64>) -> Classified {
    let mut c = Classified::default();
    for v in &result.violations {
        if v.kind == ViolationKind::Extended && !result.flag_extended {
            continue;
        }
        if v.end < -1e-6 {
            c.before.push(v.clone());
        } else if v.start > end_disp + 1e-6 {
            match next_at {
                Some(na) if v.start >= end_disp + na - 1e-6 => c.elsewhere.push(v.clone()),
                _ => c.after.push(v.clone()),
            }
        } else {
            c.inside.push(v.clone());
        }
    }
    c
}

/// Time spans the suggester should work on, from each violation's onset.
pub fn violation_spans(result: &AnalysisResult, pad: f64) -> Vec<(f64, f64)> {
    let mut spans: Vec<(f64, f64)> = result
        .violations
        .iter()
        .filter(|v| !(v.kind == ViolationKind::Extended && !result.flag_extended))
        .map(|v| (v.onset.min(v.start) - pad, v.end + pad))
        .collect();
    spans.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (s, e) in spans {
        match merged.last_mut() {
            Some(m) if s <= m.1 => m.1 = m.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    merged
}

/// Union of the event windows inside a span (whole frame if none).
pub fn span_bbox(result: &AnalysisResult, s: f64, e: f64, aw: u32, ah: u32) -> [u32; 4] {
    let mut bb = [aw, ah, 0, 0];
    let mut found = false;
    for ev in &result.events {
        if s - 0.5 <= ev.t && ev.t <= e + 0.5 {
            found = true;
            bb[0] = bb[0].min(ev.bbox[0]);
            bb[1] = bb[1].min(ev.bbox[1]);
            bb[2] = bb[2].max(ev.bbox[2]);
            bb[3] = bb[3].max(ev.bbox[3]);
        }
    }
    if found {
        bb
    } else {
        [0, 0, aw, ah]
    }
}

/// Access to a section's cached analysis-resolution frames.
pub trait FrameSource {
    /// 8-bit sRGB pixels of frame `i`, row-major, `bpp()` bytes per pixel.
    fn frame(&self, i: usize) -> &[u8];
    fn bpp(&self) -> usize;
    fn width(&self) -> u32;
    fn height(&self) -> u32;
}

/// Mean relative luminance of the bbox region for each of the given frames.
pub fn region_metric(frames: &dyn FrameSource, idxs: &[usize], bbox: [u32; 4]) -> Vec<f32> {
    let t = lut();
    let w = frames.width() as usize;
    let bpp = frames.bpp();
    let [x0, y0, x1, y1] = bbox.map(|v| v as usize);
    let count = ((x1 - x0) * (y1 - y0)).max(1) as f64;
    idxs.iter()
        .map(|&i| {
            let f = frames.frame(i);
            let mut sum = 0f64;
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = &f[(y * w + x) * bpp..];
                    let l = 0.2126f32 * t[p[0] as usize] + 0.7152f32 * t[p[1] as usize] + 0.0722f32 * t[p[2] as usize];
                    sum += l as f64;
                }
            }
            (sum / count) as f32
        })
        .collect()
}

/// numpy.percentile with linear interpolation.
pub fn percentile(vals: &[f32], p: f64) -> f32 {
    if vals.is_empty() {
        return 0.0;
    }
    let mut v = vals.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let rank = p / 100.0 * (v.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    let frac = (rank - lo as f64) as f32;
    v[lo] + (v[hi] - v[lo]) * frac
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Prefer {
    Light,
    Dark,
}

/// What a suggester run produced.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Suggestion {
    /// The removals proposed (inside the scope only).
    pub edits: Edits,
    pub safe: bool,
    pub rounds: usize,
    pub note: String,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub safe_fps: Option<f64>,
    #[serde(default)]
    pub guaranteed: Option<bool>,
}

/// What the suggester wants next.
#[derive(Clone, Debug, PartialEq)]
pub enum SuggestStep {
    /// Simulate these edits (base edits plus proposal) and call `step` again
    /// with the classified result (`inside + after`).
    Simulate(Edits),
    Done(Suggestion),
}

/// Keep-light / keep-dark: propose removals so the section passes.
/// Iterates propose -> simulate -> escalate, up to 5 rounds.
pub struct Suggester {
    rel_pts: Vec<f64>,
    prefer: Prefer,
    only: Option<BTreeSet<usize>>,
    base_edits: Edits,
    removed: BTreeSet<usize>,
    attempt: usize,
    last_proposal: Edits,
}

impl Suggester {
    /// `existing` are the section's current marks; with `only` set, marks
    /// outside the selection stay in force and are included in every
    /// simulation.
    pub fn new(rel_pts: Vec<f64>, existing: &Edits, prefer: Prefer, only: Option<BTreeSet<usize>>) -> Self {
        let base_edits: Edits = match &only {
            Some(o) => existing.iter().filter(|(k, _)| !o.contains(k)).map(|(k, v)| (*k, *v)).collect(),
            None => Edits::new(),
        };
        Suggester {
            rel_pts,
            prefer,
            only,
            base_edits: base_edits.clone(),
            removed: BTreeSet::new(),
            attempt: 0,
            last_proposal: base_edits,
        }
    }

    pub fn max_rounds() -> usize {
        5
    }

    fn allowed(&self, i: usize) -> bool {
        i != 0 && self.only.as_ref().map(|o| o.contains(&i)).unwrap_or(true)
    }

    fn indices_in(&self, s: f64, e: f64) -> Vec<usize> {
        self.rel_pts.iter().enumerate().filter(|(_, &t)| t >= s && t <= e).map(|(i, _)| i).collect()
    }

    fn apply_percentile_pass(&mut self, frames: &dyn FrameSource, result: &AnalysisResult, tight: bool) {
        let (aw, ah) = (frames.width(), frames.height());
        for (s, e) in violation_spans(result, 0.3) {
            let idxs = self.indices_in(s, e);
            if idxs.len() < 2 {
                continue;
            }
            let bbox = span_bbox(result, s, e, aw, ah);
            let m = region_metric(frames, &idxs, bbox);
            let hi = percentile(&m, 85.0);
            let lo = percentile(&m, 15.0);
            if hi - lo < 1e-4 {
                continue;
            }
            let cut = if tight {
                if self.prefer == Prefer::Light { hi - 0.15 * (hi - lo) } else { lo + 0.15 * (hi - lo) }
            } else {
                (hi + lo) / 2.0
            };
            for (k, &i) in idxs.iter().enumerate() {
                if !self.allowed(i) {
                    continue;
                }
                let bad = if self.prefer == Prefer::Light { m[k] < cut } else { m[k] > cut };
                if bad {
                    self.removed.insert(i);
                }
            }
        }
    }

    fn apply_hold_all(&mut self, frames: &dyn FrameSource, result: &AnalysisResult) {
        let (aw, ah) = (frames.width(), frames.height());
        for (s, e) in violation_spans(result, 0.3) {
            let idxs = self.indices_in(s, e);
            if idxs.is_empty() {
                continue;
            }
            let bbox = span_bbox(result, s, e, aw, ah);
            let kept: Vec<usize> = idxs.iter().copied().filter(|i| !self.removed.contains(i)).collect();
            if kept.is_empty() {
                continue;
            }
            let m = region_metric(frames, &kept, bbox);
            let anchor = {
                let mut best = 0;
                for k in 1..m.len() {
                    let better = if self.prefer == Prefer::Light { m[k] > m[best] } else { m[k] < m[best] };
                    if better {
                        best = k;
                    }
                }
                kept[best]
            };
            for &i in &idxs {
                if i != anchor && self.allowed(i) {
                    self.removed.insert(i);
                }
            }
        }
    }

    fn proposal(&self) -> Edits {
        let mut edits = self.base_edits.clone();
        for &i in &self.removed {
            edits.insert(i, FrameEdit::removed(Fill::Prev));
        }
        edits
    }

    fn removals(&self) -> Edits {
        self.removed.iter().map(|&i| (i, FrameEdit::removed(Fill::Prev))).collect()
    }

    /// Drive the suggester. Call first with `None`, then with the simulated
    /// result of the last [`SuggestStep::Simulate`]. `frames` is the
    /// section's frame cache.
    pub fn step(&mut self, frames: &dyn FrameSource, result: Option<&AnalysisResult>) -> SuggestStep {
        let Some(result) = result else {
            // round 0: does the section already pass with the base edits?
            self.last_proposal = self.base_edits.clone();
            return SuggestStep::Simulate(self.last_proposal.clone());
        };
        if result.safe() {
            let note = if self.attempt == 0 {
                "Already passes, nothing to remove.".to_string()
            } else {
                format!("Passes after removing {} frames.", self.removed.len())
            };
            return SuggestStep::Done(Suggestion {
                edits: if self.attempt == 0 { Edits::new() } else { self.removals() },
                safe: true,
                rounds: self.attempt,
                note,
                fps: None,
                safe_fps: None,
                guaranteed: None,
            });
        }
        if self.attempt >= Self::max_rounds() {
            let note = format!(
                "Still failing after {} removals. {}",
                self.removed.len(),
                if self.only.is_some() {
                    "Try widening the selection, or edit by hand."
                } else {
                    "Edit this one by hand."
                }
            );
            return SuggestStep::Done(Suggestion {
                edits: self.removals(),
                safe: false,
                rounds: self.attempt,
                note,
                fps: None,
                safe_fps: None,
                guaranteed: None,
            });
        }
        match self.attempt {
            0 => self.apply_percentile_pass(frames, result, false),
            1 => self.apply_percentile_pass(frames, result, true),
            _ => self.apply_hold_all(frames, result),
        }
        self.attempt += 1;
        self.last_proposal = self.proposal();
        SuggestStep::Simulate(self.last_proposal.clone())
    }
}

/// A "reduce FPS" proposal: removals that thin the section down to `fps`
/// pictures a second, from timestamps alone.
#[derive(Clone, Debug, PartialEq)]
pub struct RateProposal {
    /// Base edits (outside the scope) plus the thinning removals: what to
    /// simulate.
    pub edits: Edits,
    /// The thinning removals alone.
    pub removals: Edits,
    pub fps: f64,
    pub safe_fps: f64,
    pub guaranteed: bool,
    pub pool: usize,
    pub n_removed: usize,
    pub only: bool,
}

/// Build the thinning proposal. `fps = None` uses the profile's safe rate.
pub fn rate_proposal(
    cfg: &DetectorConfig,
    rel_pts: &[f64],
    existing: &Edits,
    only: Option<&BTreeSet<usize>>,
    fps: Option<f64>,
    extension_seconds: f64,
) -> Result<RateProposal, String> {
    let n = rel_pts.len();
    if n == 0 {
        return Err("Section has no frames".into());
    }
    let (safe_fps, safe_gap) = safe_picture_rate(cfg, RATE_SAFETY_MARGIN);
    let (fps, min_gap) = match fps {
        None => {
            if safe_fps <= 0.0 {
                return Err("This profile treats a single flash as a violation, so no frame rate is safe by timing alone. Choose a rate yourself and let the check judge it.".into());
            }
            (safe_fps, safe_gap)
        }
        Some(f) => {
            if !(f > 0.0 && f <= MAX_TARGET_FPS) {
                return Err(format!("A target rate has to be between 0 and {MAX_TARGET_FPS} pictures a second."));
            }
            (f, 1.0 / f)
        }
    };
    let guaranteed = rate_is_guaranteed(cfg, fps);
    let base_edits: Edits = match only {
        Some(o) => existing.iter().filter(|(k, _)| !o.contains(k)).map(|(k, v)| (*k, *v)).collect(),
        None => Edits::new(),
    };
    let times = picture_times(rel_pts, &base_edits, extension_seconds);
    let gone: BTreeSet<usize> = base_edits.iter().filter(|(_, e)| e.removed).map(|(k, _)| *k).collect();
    let removed = rate_limited_removals(&times, min_gap, only, &gone);
    let removals: Edits = removed.iter().map(|&i| (i, FrameEdit::removed(Fill::Prev))).collect();
    let mut edits = base_edits;
    edits.extend(removals.iter().map(|(k, v)| (*k, *v)));
    let pool = (0..n).filter(|i| !gone.contains(i) && only.map(|o| o.contains(i)).unwrap_or(true)).count();
    Ok(RateProposal {
        edits,
        removals,
        fps,
        safe_fps,
        guaranteed,
        pool,
        n_removed: removed.len(),
        only: only.is_some(),
    })
}

/// The note for a rate proposal once its simulation is in.
pub fn rate_note(p: &RateProposal, safe: bool) -> String {
    let where_ = if p.only { " in the selection" } else { "" };
    let mut note = format!(
        "Thinned to {}/s: {} of {} frames{} kept, {} removed.",
        fmt_g(p.fps),
        p.pool - p.n_removed,
        p.pool,
        where_,
        p.n_removed
    );
    if safe && !p.guaranteed {
        note += &format!(
            " That is above the guaranteed-safe {}/s, so it passes on what these frames actually do rather than by arithmetic. Re-check it if you edit anywhere near it.",
            fmt_g(p.safe_fps)
        );
    } else if !safe {
        if !p.guaranteed {
            note += &format!(
                " Still failing above the guaranteed-safe {}/s. Drop to that and it cannot fail on the frames this was allowed to touch.",
                fmt_g(p.safe_fps)
            );
        } else if p.only {
            note += " Still failing. The flashing that is left runs outside the selection. Widen it, or run this on the whole section.";
        } else {
            note += " Still failing. The flashing that is left runs into the footage either side of this section, which nothing in here can reach.";
        }
    }
    note
}

/// Python's `{:g}`-ish formatting for rates.
pub fn fmt_g(x: f64) -> String {
    if (x - x.round()).abs() < 1e-9 {
        format!("{}", x.round() as i64)
    } else {
        let s = format!("{:.6}", x);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Merge suggested removals into a section's marks, replacing any previous
/// suggestion inside the scope (the reference's behaviour: whichever
/// suggestion ran last wins).
pub fn apply_suggestion(existing: &Edits, suggested: &Edits, only: Option<&BTreeSet<usize>>) -> Edits {
    let mut out: Edits = match only {
        Some(o) => existing.iter().filter(|(k, _)| !o.contains(k)).map(|(k, v)| (*k, *v)).collect(),
        None => Edits::new(),
    };
    out.extend(suggested.iter().map(|(k, v)| (*k, *v)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn removed(i: usize) -> (usize, FrameEdit) {
        (i, FrameEdit::removed(Fill::Prev))
    }

    #[test]
    fn replacement_map_directions() {
        let mut e = Edits::new();
        e.insert(1, FrameEdit::removed(Fill::Prev));
        e.insert(2, FrameEdit::removed(Fill::Next));
        e.insert(0, FrameEdit::removed(Fill::Prev)); // nothing before: falls forward
        e.insert(4, FrameEdit::removed(Fill::Next)); // nothing after: falls back
        assert_eq!(replacement_map(&e, 5), vec![3, 3, 3, 3, 3]);
        let mut e = Edits::new();
        e.insert(1, FrameEdit::removed(Fill::Prev));
        e.insert(2, FrameEdit::removed(Fill::Next));
        assert_eq!(replacement_map(&e, 4), vec![0, 0, 3, 3]);
        let all: Edits = (0..3).map(removed).collect();
        assert_eq!(replacement_map(&all, 3), vec![0, 0, 0]);
    }

    #[test]
    fn sequence_and_picture_times() {
        let pts = [0.0, 0.1, 0.2, 0.3];
        let mut e = Edits::new();
        e.insert(1, FrameEdit::extended());
        e.insert(2, FrameEdit::removed(Fill::Next));
        let seq = edited_sequence(&pts, &e, 1.0);
        assert_eq!(seq, vec![(0.0, 0), (0.1, 1), (1.2, 3), (1.3, 3)]);
        let pt = picture_times(&pts, &e, 1.0);
        assert_eq!(pt, vec![0.0, 0.1, 1.2, 1.2]);
    }

    #[test]
    fn thinning_by_time() {
        let times: Vec<f64> = (0..10).map(|i| i as f64 * 0.1).collect();
        let r = rate_limited_removals(&times, 0.25, None, &BTreeSet::new());
        // keep 0.0, 0.3, 0.6, 0.9 -> remove the rest
        assert_eq!(r, [1, 2, 4, 5, 7, 8].into_iter().collect());
        let scope: BTreeSet<usize> = (3..7).collect();
        let r = rate_limited_removals(&times, 0.25, Some(&scope), &BTreeSet::new());
        // frames outside the scope pace it: 0.2 is kept, so 0.3 and 0.4 go,
        // 0.5 survives, 0.6 goes, 0.7 is outside
        assert_eq!(r, [3, 4, 6].into_iter().collect());
    }

    #[test]
    fn classification() {
        let v = |s: f64, e: f64| Violation { start: s, end: e, kind: ViolationKind::Flash, count: 1.0, onset: s - 0.5, peak: s };
        let res = AnalysisResult {
            violations: vec![v(-2.0, -1.0), v(0.5, 1.0), v(3.0, 3.5), v(5.0, 6.0)],
            flag_extended: true,
            ..Default::default()
        };
        // next section starts 2.5 s after the section's last frame
        let c = classify(&res, 2.0, Some(2.5));
        assert_eq!(c.before.len(), 1);
        assert_eq!(c.inside.len(), 1);
        assert_eq!(c.after.len(), 1);
        assert_eq!(c.elsewhere.len(), 1);
        let c = classify(&res, 2.0, None);
        assert_eq!(c.after.len(), 2);
    }

    #[test]
    fn flagged() {
        let seq = vec![(0.0, 0), (0.1, 1), (0.2, 2), (0.3, 3)];
        let v = Violation { start: 0.2, end: 0.2, kind: ViolationKind::Flash, count: 1.0, onset: 0.1, peak: 0.2 };
        assert_eq!(flagged_frames(&seq, &[v]), vec![1, 2]);
    }

    #[test]
    fn percentiles() {
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 50.0), 2.5);
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 85.0), 3.55);
    }

    #[test]
    fn rate_proposal_defaults_to_safe_rate() {
        let cfg = DetectorConfig::default();
        let pts: Vec<f64> = (0..48).map(|i| i as f64 / 24.0).collect();
        let p = rate_proposal(&cfg, &pts, &Edits::new(), None, None, 1.0).unwrap();
        assert_eq!(p.fps, 3.80);
        assert!(p.guaranteed);
        // 2 s at 3.8/s keeps ~8 pictures
        assert!(p.pool - p.n_removed <= 9 && p.pool - p.n_removed >= 7);
        assert!(rate_note(&p, true).starts_with("Thinned to 3.8/s"));
        assert!(rate_proposal(&cfg, &pts, &Edits::new(), None, Some(0.0), 1.0).is_err());
    }

    #[test]
    fn edits_json_round_trip() {
        let mut e = Edits::new();
        e.insert(3, FrameEdit::removed(Fill::Next));
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(s, r#"{"3":{"removed":true,"extended":false,"fill":"next"}}"#);
        let back: Edits = serde_json::from_str(r#"{"3":{"removed":true}}"#).unwrap();
        assert_eq!(back[&3], FrameEdit::removed(Fill::Prev));
    }
}
