//! Turning violations into work sections, and the arithmetic bounds a
//! section edit can rely on (port of the section/rate parts of
//! `analysis.py`).

use serde::{Deserialize, Serialize};

use crate::config::DetectorConfig;
use crate::pixel::MAX_RUN_SECONDS;
use crate::temporal::{AnalysisResult, EventKind, Violation, ViolationKind};

/// Extra span asked of every flash window on top of the second the detector
/// measures against, so a rate-reduced section keeps its margin through the
/// render (a picture can land up to a whole grid slot early).
const RATE_SAFETY_MARGIN: f64 = 0.05;

/// Ceiling on a hand-typed target rate for "reduce FPS".
pub(crate) const MAX_TARGET_FPS: f64 = 1000.0;

/// The most parts one over-long stretch of flashing is split into. A video's
/// bounds and a violation's times are its file's timestamps, and a damaged
/// file's can span years: the list a span like that would be cut into is one
/// no page can hold (and making it killed the page). Past this the parts are
/// longer than `section_max_len` instead. (A whole day of unbroken flashing
/// is under two thousand.)
pub const MAX_SECTION_PARTS: usize = 1 << 12;

/// The most bins a [`TimelineSummary`] has, for the same reason: past it the
/// bins are wider than asked for. (A second each, this is three days; the
/// heatmap they are drawn into is a thousand or so pixels wide.)
pub const MAX_SUMMARY_BINS: usize = 1 << 18;

/// How much of the run-up a detector has to have seen before its verdict at
/// a given moment matches the verdict a pass over the whole video gives at
/// that same moment.
pub fn context_seconds(cfg: &DetectorConfig) -> f64 {
    // pairing + failure window + run cap + margin
    let mut base = 1.0 + 1.0 + MAX_RUN_SECONDS + 0.5;
    if cfg.flag_extended() {
        base = base.max(cfg.extended_window + cfg.extended_hold + 0.5);
    }
    base
}

/// How many frame intervals a burst of flashing needs to trip `cfg`.
/// Returns 0 when no frame rate can be safe.
fn flash_window_frames(cfg: &DetectorConfig) -> u32 {
    let k_fail = cfg.k_fail() as i64;
    let mut m = 2 * (k_fail - 1);
    if cfg.flag_extended() {
        let k_ext = cfg.ext_rate() as i64;
        m = m.min(2 * (k_ext - 1));
    }
    m.max(0) as u32
}

/// (pictures per second, seconds between them) that `cfg` cannot fail,
/// with `RATE_SAFETY_MARGIN` to spare, rounded *down* to two decimals.
/// `(0.0, inf)` when no rate can satisfy it.
pub fn safe_picture_rate(cfg: &DetectorConfig) -> (f64, f64) {
    let m = flash_window_frames(cfg);
    if m < 1 {
        return (0.0, f64::INFINITY);
    }
    let fps = (m as f64 / (1.0 + RATE_SAFETY_MARGIN) * 100.0).floor() / 100.0;
    (fps, 1.0 / fps)
}

/// Is thinning to `fps` pictures a second safe by arithmetic alone?
pub fn rate_is_guaranteed(cfg: &DetectorConfig, fps: f64) -> bool {
    let (safe, _) = safe_picture_rate(cfg);
    safe > 0.0 && fps <= safe + 1e-9
}

/// Snap [start, end] outward to keyframes, clamped into the video's real
/// timeline bounds.
fn snap_to_keyframes(keyframes: &[f64], start: f64, end: f64, bounds: (f64, f64)) -> (f64, f64) {
    let (ts_min, ts_max) = bounds;
    let clamp = |x: f64| x.min(ts_max).max(ts_min);
    let mut start = clamp(start);
    let mut end = clamp(end);
    if !keyframes.is_empty() {
        // bisect_right(keyframes, start + 1e-6) - 1
        let i = keyframes.partition_point(|&k| k <= start + 1e-6);
        if i >= 1 {
            start = keyframes[i - 1];
        }
        // bisect_left(keyframes, end - 1e-6)
        let j = keyframes.partition_point(|&k| k < end - 1e-6);
        end = if j < keyframes.len() { keyframes[j] } else { ts_max };
    }
    start = clamp(start);
    end = clamp(end);
    if end <= start {
        end = ts_max;
    }
    (start, end)
}

/// A work section proposed by a scan.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SectionSpan {
    pub start: f64,
    pub end: f64,
    /// Sorted by name ("extended" < "flash" < "red"), like the reference.
    pub kinds: Vec<ViolationKind>,
}

/// Merge violations into padded work sections. `bounds` is the video's
/// real native-pts range. Sections are padded out from each violation's
/// `onset`, so a section always contains the frames responsible for its own
/// violation.
pub fn violations_to_sections(
    violations: &[Violation],
    cfg: &DetectorConfig,
    bounds: (f64, f64),
    keyframes: &[f64],
) -> Vec<SectionSpan> {
    let (ts_min, ts_max) = bounds;
    let mut intervals: Vec<(f64, f64, Vec<ViolationKind>)> = Vec::new();
    for v in violations {
        if v.kind == ViolationKind::Extended && !cfg.flag_extended() {
            continue;
        }
        if v.kind == ViolationKind::Pattern && !cfg.flag_patterns() {
            continue;
        }
        let mut s = (v.onset.min(v.start) - cfg.section_pad).max(ts_min);
        let mut e = (v.end + cfg.section_pad).min(ts_max);
        if e - s < cfg.section_min_len {
            let mid = (s + e) / 2.0;
            s = (mid - cfg.section_min_len / 2.0).max(ts_min);
            e = (s + cfg.section_min_len).min(ts_max);
        }
        if e > s {
            intervals.push((s, e, vec![v.kind]));
        }
    }
    intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged: Vec<(f64, f64, Vec<ViolationKind>)> = Vec::new();
    for (s, e, kinds) in intervals {
        match merged.last_mut() {
            Some(m) if s <= m.1 + cfg.section_merge_gap => {
                m.1 = m.1.max(e);
                for k in kinds {
                    if !m.2.contains(&k) {
                        m.2.push(k);
                    }
                }
            }
            _ => merged.push((s, e, kinds)),
        }
    }

    // split over-long sections
    let mut split: Vec<(f64, f64, Vec<ViolationKind>)> = Vec::new();
    for (s, e, kinds) in merged {
        let length = e - s;
        if length <= cfg.section_max_len {
            split.push((s, e, kinds));
        } else {
            let parts = ((length / cfg.section_max_len).ceil() as usize).min(MAX_SECTION_PARTS);
            let step = length / parts as f64;
            for k in 0..parts {
                split.push((s + k as f64 * step, e.min(s + (k + 1) as f64 * step), kinds.clone()));
            }
        }
    }

    let mut out: Vec<SectionSpan> = Vec::new();
    for (s, e, mut kinds) in split {
        let (ks, ke) = snap_to_keyframes(keyframes, s, e, bounds);
        kinds.sort();
        kinds.dedup();
        let sec = SectionSpan { start: round6(ks), end: round6(ke), kinds };
        // snapping can make neighbours touch/overlap; merge those
        match out.last_mut() {
            Some(last) if sec.start < last.end - 1e-6 => {
                last.end = last.end.max(sec.end);
                for k in sec.kinds {
                    if !last.kinds.contains(&k) {
                        last.kinds.push(k);
                    }
                }
                last.kinds.sort();
            }
            _ => out.push(sec),
        }
    }
    out
}

fn round6(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

/// Per-second flash counts for the whole-video heatmap (native time).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TimelineSummary {
    pub bin: f64,
    pub t0: f64,
    pub general: Vec<f32>,
    pub red: Vec<f32>,
    /// Bins inside a reported regular-pattern violation (its severity).
    #[serde(default)]
    pub pattern: Vec<f32>,
}

pub fn timeline_summary(result: &AnalysisResult, bounds: (f64, f64), bin_seconds: f64) -> TimelineSummary {
    let (ts_min, ts_max) = bounds;
    let span = (ts_max - ts_min).max(1e-6);
    let wanted = (span / bin_seconds).ceil();
    // more bins than a summary has (a bin of no width asks for them too): wider ones
    let (bin_seconds, nbins) = if wanted > MAX_SUMMARY_BINS as f64 { (span / MAX_SUMMARY_BINS as f64, MAX_SUMMARY_BINS) } else { (bin_seconds, (wanted as usize).max(1)) };
    let mut general = vec![0f32; nbins];
    let mut red = vec![0f32; nbins];
    let mut pattern = vec![0f32; nbins];
    for e in &result.events {
        let b = (((e.t - ts_min) / bin_seconds) as i64).clamp(0, nbins as i64 - 1) as usize;
        match e.kind {
            EventKind::General => general[b] += 1.0,
            EventKind::Red => red[b] += 1.0,
        }
    }
    for v in result.violations.iter().filter(|v| v.kind == ViolationKind::Pattern && result.reports(v.kind)) {
        let b0 = (((v.start - ts_min) / bin_seconds) as i64).clamp(0, nbins as i64 - 1) as usize;
        let b1 = (((v.end - ts_min) / bin_seconds) as i64).clamp(0, nbins as i64 - 1) as usize;
        for b in b0..=b1 {
            pattern[b] = pattern[b].max(v.count as f32);
        }
    }
    TimelineSummary { bin: bin_seconds, t0: ts_min, general, red, pattern }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Profile;

    #[test]
    fn safe_rates_match_documentation() {
        let ext = Profile::WcagExt.config();
        let wcag = Profile::Wcag.config();
        let strict = Profile::Strict.config();
        assert_eq!(flash_window_frames(&ext), 4);
        assert_eq!(flash_window_frames(&wcag), 6);
        assert_eq!(flash_window_frames(&strict), 4);
        assert_eq!(safe_picture_rate(&ext).0, 3.80);
        assert_eq!(safe_picture_rate(&wcag).0, 5.71);
        assert_eq!(safe_picture_rate(&strict).0, 3.80);
        assert!(rate_is_guaranteed(&ext, 3.8));
        assert!(!rate_is_guaranteed(&ext, 3.81));
        assert_eq!(context_seconds(&ext), 6.5);
        assert_eq!(context_seconds(&wcag), 4.5);
    }

    #[test]
    fn keyframe_snapping() {
        let kf = [0.0, 2.0, 4.0, 6.0];
        assert_eq!(snap_to_keyframes(&kf, 2.5, 3.5, (0.0, 10.0)), (2.0, 4.0));
        assert_eq!(snap_to_keyframes(&kf, 5.0, 9.0, (0.0, 10.0)), (4.0, 10.0));
        assert_eq!(snap_to_keyframes(&[], 5.0, 9.0, (0.0, 10.0)), (5.0, 9.0));
        assert_eq!(snap_to_keyframes(&[], 9.0, 5.0, (0.0, 10.0)), (9.0, 10.0));
    }

    #[test]
    fn sections_pad_merge_and_split() {
        let cfg = DetectorConfig::default();
        let v = |s: f64, e: f64, onset: f64, kind| Violation { start: s, end: e, kind, count: 1.0, onset, peak: s };
        let vs = vec![
            v(10.0, 10.5, 9.2, ViolationKind::Flash),
            v(12.0, 12.2, 12.0, ViolationKind::Red),
            v(30.0, 30.1, 30.0, ViolationKind::Extended),
        ];
        let secs = violations_to_sections(&vs, &cfg, (0.0, 100.0), &[]);
        assert_eq!(secs.len(), 2);
        assert!((secs[0].start - 7.7).abs() < 1e-6);
        assert!((secs[0].end - 13.7).abs() < 1e-6);
        assert_eq!(secs[0].kinds, vec![ViolationKind::Flash, ViolationKind::Red]);
        assert_eq!(secs[1].kinds, vec![ViolationKind::Extended]);
        // extended flashes are dropped when the profile does not flag them
        let wcag = Profile::Wcag.config();
        assert_eq!(violations_to_sections(&vs, &wcag, (0.0, 100.0), &[]).len(), 1);
        // a 100 s violation splits into three
        let long = vec![v(0.0, 100.0, 0.0, ViolationKind::Flash)];
        assert_eq!(violations_to_sections(&long, &cfg, (0.0, 200.0), &[]).len(), 3);
    }

    fn flash(start: f64, end: f64) -> Violation {
        Violation { start, end, kind: ViolationKind::Flash, count: 1.0, onset: start, peak: start }
    }

    fn spans(secs: &[SectionSpan]) -> Vec<(f64, f64)> {
        secs.iter().map(|s| (s.start, s.end)).collect()
    }

    #[test]
    fn a_section_is_no_shorter_than_the_least_and_stays_inside_the_video() {
        let cfg = DetectorConfig { section_pad: 0.25, ..Default::default() };
        // 0.5 s with its padding: widened about its middle to the least length
        assert_eq!(spans(&violations_to_sections(&[flash(10.0, 10.0)], &cfg, (0.0, 100.0), &[])), [(9.0, 11.0)]);
        // at the video's start it cannot widen backwards: the least length from there
        assert_eq!(spans(&violations_to_sections(&[flash(0.1, 0.2)], &cfg, (0.0, 100.0), &[])), [(0.0, 2.0)]);
        // nor past its end: widened about its middle, and cut where the video ends
        assert_eq!(spans(&violations_to_sections(&[flash(99.9, 100.0)], &cfg, (0.0, 100.0), &[])), [(98.825, 100.0)]);
        // a video shorter than the least length: all of it
        assert_eq!(spans(&violations_to_sections(&[flash(0.5, 0.6)], &cfg, (0.0, 1.0), &[])), [(0.0, 1.0)]);
        // flashing outside the bounds altogether has no section
        assert_eq!(violations_to_sections(&[flash(200.0, 201.0)], &cfg, (0.0, 100.0), &[]), []);
        assert_eq!(violations_to_sections(&[], &cfg, (0.0, 100.0), &[]), []);
    }

    #[test]
    fn a_pattern_has_a_section_only_under_a_profile_that_reports_patterns() {
        let pattern = Violation { kind: ViolationKind::Pattern, ..flash(10.0, 14.0) };
        let on = Profile::WcagExt.config();
        assert!(on.flag_patterns());
        let secs = violations_to_sections(&[pattern.clone(), flash(11.0, 12.0)], &on, (0.0, 100.0), &[]);
        assert_eq!(secs.len(), 1);
        // (by name, as the reference has them)
        assert_eq!(secs[0].kinds, [ViolationKind::Flash, ViolationKind::Pattern]);
        let off = DetectorConfig { pattern_mode: crate::config::ExtendedMode::Off, ..on };
        let secs = violations_to_sections(&[pattern, flash(11.0, 12.0)], &off, (0.0, 100.0), &[]);
        assert_eq!((spans(&secs), &secs[0].kinds[..]), (vec![(9.5, 13.5)], &[ViolationKind::Flash][..]));
    }

    #[test]
    fn sections_snapped_to_keyframes_that_meet_become_one() {
        let cfg = DetectorConfig::default();
        let keyframes: Vec<f64> = (0..10).map(|k| k as f64 * 10.0).collect();
        // 5 s apart once padded (more than the merge gap): two sections...
        let vs = [flash(12.0, 13.0), flash(21.0, 22.0)];
        assert_eq!(spans(&violations_to_sections(&vs, &cfg, (0.0, 100.0), &[])), [(10.5, 14.5), (19.5, 23.5)]);
        // ...that grow to the keyframes around them, 10-20 and 10-30: one
        let red = Violation { kind: ViolationKind::Red, ..flash(21.0, 22.0) };
        let snapped = violations_to_sections(&[flash(12.0, 13.0), red], &cfg, (0.0, 100.0), &keyframes);
        assert_eq!(spans(&snapped), [(10.0, 30.0)]);
        assert_eq!(snapped[0].kinds, [ViolationKind::Flash, ViolationKind::Red]);
        // sections that only touch stay two
        let vs = [flash(12.0, 13.0), flash(32.0, 33.0)];
        assert_eq!(spans(&violations_to_sections(&vs, &cfg, (0.0, 100.0), &keyframes)), [(10.0, 20.0), (30.0, 40.0)]);
    }

    /// A damaged file's timestamps can span years (a 32-bit sample duration
    /// at a timescale of one is 4.3e9 s), and what is made from the video's
    /// bounds was sized by them: a list or a table of a size that killed the
    /// page it was made for.
    #[test]
    fn a_span_no_video_has_makes_nothing_a_page_cannot_hold() {
        let cfg = DetectorConfig::default();
        let far = 4.3e9;
        let secs = violations_to_sections(&[flash(10.0, far - 10.0)], &cfg, (0.0, far), &[]);
        assert_eq!(secs.len(), MAX_SECTION_PARTS);
        // still all of it, in order, each part beginning where the last ended
        assert_eq!(secs[0].start, 8.5);
        assert!((secs.last().unwrap().end - (far - 8.5)).abs() < 1e-3);
        assert!(secs.windows(2).all(|w| w[0].end == w[1].start && w[0].start < w[0].end));
        // a day of unbroken flashing is cut as it ever was: 45 s at most each
        let day = violations_to_sections(&[flash(10.0, 86_390.0)], &cfg, (0.0, 86_400.0), &[]);
        assert_eq!(day.len(), 1920);
        assert!(day.iter().all(|s| s.end - s.start <= cfg.section_max_len + 1e-6));

        let event = |t: f64, kind| crate::temporal::TransitionEvent { t, tc: t, kind, area: 1, bbox: [0, 0, 2, 2] };
        let r = AnalysisResult { events: vec![event(5.5, EventKind::General), event(far - 0.5, EventKind::General), event(far / 2.0, EventKind::Red)], ..Default::default() };
        let sum = timeline_summary(&r, (0.0, far), 1.0);
        assert_eq!((sum.general.len(), sum.red.len(), sum.pattern.len()), (MAX_SUMMARY_BINS, MAX_SUMMARY_BINS, MAX_SUMMARY_BINS));
        // the bins are as wide as it takes to cover the span, and each flash is in its own
        assert_eq!(sum.bin, far / MAX_SUMMARY_BINS as f64);
        assert_eq!((sum.general[0], sum.general[MAX_SUMMARY_BINS - 1], sum.red[MAX_SUMMARY_BINS / 2]), (1.0, 1.0, 1.0));
        assert_eq!(sum.general.iter().chain(&sum.red).sum::<f32>(), 3.0);
        // three days at a bin a second is the most that keeps its second
        let most = MAX_SUMMARY_BINS as f64;
        assert_eq!(timeline_summary(&r, (0.0, most), 1.0).bin, 1.0);
        assert_eq!(timeline_summary(&r, (0.0, most + 1.0), 1.0).general.len(), MAX_SUMMARY_BINS);
        // a bin of no width asks for more than any: the widened ones
        let sum = timeline_summary(&r, (0.0, 100.0), 0.0);
        assert_eq!((sum.general.len(), sum.bin), (MAX_SUMMARY_BINS, 100.0 / most));
        // and no numbers at all are still no panic
        for bounds in [(f64::NAN, 1.0), (0.0, f64::NAN), (0.0, f64::INFINITY), (f64::NEG_INFINITY, 0.0), (5.0, -5.0)] {
            for bin in [1.0, 0.0, -1.0, f64::NAN, f64::INFINITY] {
                assert!(timeline_summary(&r, bounds, bin).general.len() <= MAX_SUMMARY_BINS);
                assert!(violations_to_sections(&[flash(1.0, 2.0)], &cfg, bounds, &[]).len() <= MAX_SECTION_PARTS);
            }
        }
    }

    #[test]
    fn the_summary_counts_each_second_s_flashes_and_marks_where_a_pattern_is() {
        let event = |t: f64, kind| crate::temporal::TransitionEvent { t, tc: t, kind, area: 1, bbox: [0, 0, 2, 2] };
        let pattern = |start: f64, end: f64, count: f64| Violation { kind: ViolationKind::Pattern, count, ..flash(start, end) };
        let r = AnalysisResult {
            events: vec![
                event(2.0, EventKind::General),
                event(2.99, EventKind::General),
                event(3.0, EventKind::Red),
                event(3.5, EventKind::General),
                // outside the bounds: counted in the bin at that end
                event(0.5, EventKind::Red),
                event(99.0, EventKind::General),
            ],
            violations: vec![pattern(4.2, 6.9, 1.5), pattern(6.0, 7.1, 2.5), flash(8.0, 9.0)],
            flag_patterns: true,
            ..Default::default()
        };
        // 2.0 to 12.5: eleven bins, the last one half a second
        let sum = timeline_summary(&r, (2.0, 12.5), 1.0);
        assert_eq!((sum.bin, sum.t0), (1.0, 2.0));
        assert_eq!(sum.general, [2.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(sum.red, [1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        // a pattern's severity over every bin it is in, the worst where two are
        assert_eq!(sum.pattern, [0.0, 0.0, 1.5, 1.5, 2.5, 2.5, 0.0, 0.0, 0.0, 0.0, 0.0]);
        // (only what the profile reports)
        let quiet = AnalysisResult { flag_patterns: false, ..r.clone() };
        assert!(timeline_summary(&quiet, (2.0, 12.5), 1.0).pattern.iter().all(|&p| p == 0.0));
        // a video of no length still has a bin
        let none = timeline_summary(&AnalysisResult::default(), (0.0, 0.0), 1.0);
        assert_eq!((none.general, none.red, none.pattern), (vec![0.0], vec![0.0], vec![0.0]));
        // wider bins
        assert_eq!(timeline_summary(&r, (2.0, 12.5), 5.0).general, [3.0, 0.0, 1.0]);
    }
}
