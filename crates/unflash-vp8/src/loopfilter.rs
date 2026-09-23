//! The loop filter (RFC 6386 section 15): the normal filter on luma and
//! chroma or the simple filter on luma alone, across macroblock edges and,
//! for macroblocks with coefficients or subblock prediction, the edges
//! between subblocks.
//!
//! A frame is filtered macroblock by macroblock in raster order, each one
//! left edge, inner vertical edges, top edge, inner horizontal edges, one
//! macroblock row behind the decoding (intra prediction reads unfiltered
//! samples, and the row being decoded is never touched by filtering the
//! row above it).

use crate::picture::Picture;

/// How one macroblock is filtered.
#[derive(Clone, Copy, Default, Debug)]
pub struct MbFilter {
    /// 0 leaves the macroblock alone.
    pub level: u8,
    pub interior_limit: u8,
    pub hev_threshold: u8,
    /// Filter the edges between subblocks too.
    pub inner: bool,
}

impl MbFilter {
    /// 15.2 and 15.4: the limits of a level, given the frame's sharpness.
    pub fn new(level: i32, sharpness: i32, key_frame: bool, inner: bool) -> MbFilter {
        let level = level.clamp(0, 63);
        let mut interior = level;
        if sharpness > 0 {
            interior >>= (sharpness + 3) >> 2;
            interior = interior.min(9 - sharpness);
        }
        let interior = interior.max(1);
        let hev = match (key_frame, level) {
            (_, 40..) => 2 + !key_frame as u8,
            (false, 20..) => 2,
            (_, 15..) => 1,
            _ => 0,
        };
        MbFilter { level: level as u8, interior_limit: interior as u8, hev_threshold: hev, inner }
    }
}

/// The filter across one edge, with its limits.
#[derive(Clone, Copy, Debug)]
enum Kind {
    /// 15.3: the normal filter across a macroblock edge (up to three
    /// samples each side change).
    Mb { edge_limit: i32, interior: i32, hev: i32 },
    /// 15.3: the normal filter across a subblock edge (up to two).
    Inner { edge_limit: i32, interior: i32, hev: i32 },
    /// 15.2: the simple filter (one).
    Simple { edge_limit: i32 },
}

#[inline(always)]
fn clamp_s8(v: i32) -> i32 {
    v.clamp(-128, 127)
}

#[inline(always)]
fn clamp_u8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// One position of an edge: `p[i]` is the i-th sample before it (0
/// nearest), `q[i]` the i-th after, `step` apart in `buf` from `at` (the
/// first sample after the edge). Written as ffmpeg writes it, on unsigned
/// samples; the differences are those of the RFC's signed samples.
#[cfg_attr(feature = "simd", allow(dead_code))]
fn filter_position(buf: &mut [u8], at: usize, step: usize, kind: Kind) {
    let s = |k: isize| buf[(at as isize + k * step as isize) as usize] as i32;
    let p = [s(-1), s(-2), s(-3), s(-4)];
    let q = [s(0), s(1), s(2), s(3)];
    let simple_limit = |limit: i32| 2 * (p[0] - q[0]).abs() + ((p[1] - q[1]).abs() >> 1) <= limit;
    let interior_ok = |i: i32| (p[3] - p[2]).abs() <= i && (p[2] - p[1]).abs() <= i && (p[1] - p[0]).abs() <= i && (q[3] - q[2]).abs() <= i && (q[2] - q[1]).abs() <= i && (q[1] - q[0]).abs() <= i;
    let high_variance = |t: i32| (p[1] - p[0]).abs() > t || (q[1] - q[0]).abs() > t;
    // move p0 and q0 towards each other (estimating the step with the outer
    // taps when `outer`), and when not `outer` p1 and q1 by half as much;
    // (a + 4) >> 3 and (a + 3) >> 3 round the halves apart
    let adjust = |buf: &mut [u8], outer: bool| {
        let a = clamp_s8(if outer { clamp_s8(p[1] - q[1]) } else { 0 } + 3 * (q[0] - p[0]));
        let f1 = (a + 4).min(127) >> 3;
        let f2 = (a + 3).min(127) >> 3;
        buf[at - step] = clamp_u8(p[0] + f2);
        buf[at] = clamp_u8(q[0] - f1);
        if !outer {
            let a = (f1 + 1) >> 1;
            buf[at - 2 * step] = clamp_u8(p[1] + a);
            buf[at + step] = clamp_u8(q[1] - a);
        }
    };
    match kind {
        Kind::Simple { edge_limit } => {
            if simple_limit(edge_limit) {
                adjust(buf, true);
            }
        }
        Kind::Inner { edge_limit, interior, hev } => {
            if simple_limit(edge_limit) && interior_ok(interior) {
                adjust(buf, high_variance(hev));
            }
        }
        Kind::Mb { edge_limit, interior, hev } => {
            if !simple_limit(edge_limit) || !interior_ok(interior) {
                return;
            }
            if high_variance(hev) {
                adjust(buf, true);
                return;
            }
            // 27/128, 18/128 and 9/128 of the step: about 3/7, 2/7, 1/7
            let w = clamp_s8(clamp_s8(p[1] - q[1]) + 3 * (q[0] - p[0]));
            let a = [(27 * w + 63) >> 7, (18 * w + 63) >> 7, (9 * w + 63) >> 7];
            for (i, &a) in a.iter().enumerate() {
                buf[at - (i + 1) * step] = clamp_u8(p[i] + a);
                buf[at + i * step] = clamp_u8(q[i] - a);
            }
        }
    }
}

/// Eight positions of an edge at once, in 16-bit lanes (wasm simd128, SSE2
/// or NEON through `wide`), computing exactly what `filter_position` does:
/// every lane takes both branches and the masks pick.
#[cfg(feature = "simd")]
mod simd {
    use super::Kind;
    use wide::{i16x8, u8x16, CmpGt};

    #[inline(always)]
    fn splat(v: i32) -> i16x8 {
        i16x8::splat(v as i16)
    }

    #[inline(always)]
    fn clamp_s8(v: i16x8) -> i16x8 {
        v.max(splat(-128)).min(splat(127))
    }

    #[inline(always)]
    fn clamp_u8(v: i16x8) -> i16x8 {
        v.max(splat(0)).min(splat(255))
    }

    /// Lanes where `v` <= `limit`.
    #[inline(always)]
    fn at_most(v: i16x8, limit: i32) -> i16x8 {
        splat(limit + 1).cmp_gt(v)
    }

    /// Eight samples as 16-bit lanes.
    #[inline(always)]
    pub fn load8(s: &[u8]) -> i16x8 {
        let mut a = [0u8; 16];
        a[..8].copy_from_slice(&s[..8]);
        i16x8::from_u8x16_low(u8x16::from(a))
    }

    /// Eight lanes (already 0..=255) into `d[..8]`.
    #[inline(always)]
    pub fn store8(v: i16x8, d: &mut [u8]) {
        d[..8].copy_from_slice(&u8x16::narrow_i16x8(v, v).as_array_ref()[..8]);
    }

    /// Filter eight positions: `t` holds p3, p2, p1, p0, q0, q1, q2, q3.
    #[inline(always)]
    pub fn filter(t: &mut [i16x8; 8], kind: Kind) {
        let [p3, p2, p1, p0, q0, q1, q2, q3] = *t;
        let (edge_limit, interior, hev) = match kind {
            Kind::Simple { edge_limit } => (edge_limit, 255, 255),
            Kind::Inner { edge_limit, interior, hev } | Kind::Mb { edge_limit, interior, hev } => (edge_limit, interior, hev),
        };
        let mut mask = at_most((p0 - q0).abs() * 2i16 + ((p1 - q1).abs() >> 1), edge_limit);
        if !matches!(kind, Kind::Simple { .. }) {
            let steps = (p3 - p2).abs().max((p2 - p1).abs()).max((p1 - p0).abs()).max((q1 - q0).abs()).max((q2 - q1).abs()).max((q3 - q2).abs());
            mask = mask & at_most(steps, interior);
        }
        if mask.none() {
            return;
        }
        let high = if matches!(kind, Kind::Simple { .. }) { splat(-1) } else { (p1 - p0).abs().max((q1 - q0).abs()).cmp_gt(splat(hev)) };
        let outer = clamp_s8(p1 - q1);
        let step = (q0 - p0) * 3i16;
        // the adjustment of p0 and q0 alone, with the outer taps where the
        // variance is high (and always for the simple filter)
        let a = clamp_s8((outer & high) + step);
        let f1 = (a + 4i16).min(splat(127)) >> 3;
        let f2 = (a + 3i16).min(splat(127)) >> 3;
        let mut np0 = clamp_u8(p0 + f2);
        let mut nq0 = clamp_u8(q0 - f1);
        let (mut np1, mut nq1, mut np2, mut nq2) = (p1, q1, p2, q2);
        match kind {
            Kind::Simple { .. } => {}
            Kind::Inner { .. } => {
                // without high variance p1 and q1 move half as far
                let a = ((f1 + 1i16) >> 1) & !high;
                np1 = clamp_u8(p1 + a);
                nq1 = clamp_u8(q1 - a);
            }
            Kind::Mb { .. } => {
                // without high variance the macroblock filter proper
                let w = clamp_s8(outer + step);
                let a0 = (w * 27i16 + 63i16) >> 7;
                let a1 = (w * 18i16 + 63i16) >> 7;
                let a2 = (w * 9i16 + 63i16) >> 7;
                np0 = high.blend(np0, clamp_u8(p0 + a0));
                nq0 = high.blend(nq0, clamp_u8(q0 - a0));
                np1 = high.blend(p1, clamp_u8(p1 + a1));
                nq1 = high.blend(q1, clamp_u8(q1 - a1));
                np2 = high.blend(p2, clamp_u8(p2 + a2));
                nq2 = high.blend(q2, clamp_u8(q2 - a2));
            }
        }
        t[1] = mask.blend(np2, p2);
        t[2] = mask.blend(np1, p1);
        t[3] = mask.blend(np0, p0);
        t[4] = mask.blend(nq0, q0);
        t[5] = mask.blend(nq1, q1);
        t[6] = mask.blend(nq2, q2);
    }

    /// Eight positions of a horizontal edge (columns `at` .. `at + 8`).
    #[inline(always)]
    pub fn horizontal(buf: &mut [u8], at: usize, stride: usize, kind: Kind) {
        let base = at - 4 * stride;
        let mut t: [i16x8; 8] = std::array::from_fn(|r| load8(&buf[base + r * stride..]));
        let before = t;
        filter(&mut t, kind);
        for r in 1..7 {
            if t[r] != before[r] {
                store8(t[r], &mut buf[base + r * stride..]);
            }
        }
    }

    /// Eight positions of a vertical edge (rows `at` down): the rows are
    /// transposed so each lane is a row.
    #[inline(always)]
    pub fn vertical(buf: &mut [u8], at: usize, stride: usize, kind: Kind) {
        let rows: [i16x8; 8] = std::array::from_fn(|r| load8(&buf[at + r * stride - 4..]));
        let mut t = i16x8::transpose(rows);
        let before = t;
        filter(&mut t, kind);
        if t == before {
            return;
        }
        let rows = i16x8::transpose(t);
        for (r, row) in rows.iter().enumerate() {
            store8(*row, &mut buf[at + r * stride - 4..]);
        }
    }
}

/// Filter `count` (8 or 16) positions of an edge: `step` is the distance
/// between samples across the edge (1 for a vertical edge, the stride for
/// a horizontal one), `along` the distance between positions.
#[inline]
fn filter_edge(buf: &mut [u8], at: usize, step: usize, along: usize, count: usize, kind: Kind) {
    #[cfg(feature = "simd")]
    {
        for k in (0..count).step_by(8) {
            if step == 1 {
                simd::vertical(buf, at + k * along, along, kind);
            } else {
                simd::horizontal(buf, at + k, step, kind);
            }
        }
    }
    #[cfg(not(feature = "simd"))]
    for i in 0..count {
        filter_position(buf, at + i * along, step, kind);
    }
}

/// Filter macroblock row `mb_y` of `pic` with the normal (`simple` false)
/// or simple filter; `row` holds the row's macroblock parameters.
pub fn filter_row(pic: &mut Picture, mb_y: usize, row: &[MbFilter], simple: bool) {
    let stride = pic.width;
    let uv_stride = pic.width / 2;
    for (mb_x, f) in row.iter().enumerate() {
        if f.level == 0 {
            continue;
        }
        let level = f.level as i32;
        let interior = f.interior_limit as i32;
        let hev = f.hev_threshold as i32;
        let mb_limit = (level + 2) * 2 + interior;
        let sub_limit = level * 2 + interior;
        let y0 = mb_y * 16 * stride + mb_x * 16;
        let c0 = mb_y * 8 * uv_stride + mb_x * 8;
        let (mb_kind, inner_kind) = if simple {
            (Kind::Simple { edge_limit: mb_limit }, Kind::Simple { edge_limit: sub_limit })
        } else {
            (Kind::Mb { edge_limit: mb_limit, interior, hev }, Kind::Inner { edge_limit: sub_limit, interior, hev })
        };
        // the simple filter leaves chroma alone
        let planes = if simple { 0 } else { 2 };
        if mb_x > 0 {
            filter_edge(&mut pic.y, y0, 1, stride, 16, mb_kind);
            for plane in [&mut pic.u, &mut pic.v].into_iter().take(planes) {
                filter_edge(plane, c0, 1, uv_stride, 8, mb_kind);
            }
        }
        if f.inner {
            for x in [4, 8, 12] {
                filter_edge(&mut pic.y, y0 + x, 1, stride, 16, inner_kind);
            }
            for plane in [&mut pic.u, &mut pic.v].into_iter().take(planes) {
                filter_edge(plane, c0 + 4, 1, uv_stride, 8, inner_kind);
            }
        }
        if mb_y > 0 {
            filter_edge(&mut pic.y, y0, stride, 1, 16, mb_kind);
            for plane in [&mut pic.u, &mut pic.v].into_iter().take(planes) {
                filter_edge(plane, c0, uv_stride, 1, 8, mb_kind);
            }
        }
        if f.inner {
            for y in [4, 8, 12] {
                filter_edge(&mut pic.y, y0 + y * stride, stride, 1, 16, inner_kind);
            }
            for plane in [&mut pic.u, &mut pic.v].into_iter().take(planes) {
                filter_edge(plane, c0 + 4 * uv_stride, uv_stride, 1, 8, inner_kind);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_follow_sharpness_and_level() {
        let f = MbFilter::new(32, 0, true, true);
        assert_eq!((f.level, f.interior_limit, f.hev_threshold), (32, 32, 1));
        let f = MbFilter::new(32, 4, false, true);
        assert_eq!((f.interior_limit, f.hev_threshold), (5, 2));
        let f = MbFilter::new(63, 7, false, true);
        assert_eq!((f.interior_limit, f.hev_threshold), (2, 3));
        let f = MbFilter::new(70, 0, true, false);
        assert_eq!((f.level, f.hev_threshold), (63, 2));
        let f = MbFilter::new(-3, 0, true, false);
        assert_eq!((f.level, f.interior_limit), (0, 1));
    }

    #[test]
    fn a_small_step_is_smoothed() {
        // a vertical edge between columns 3 and 4 of a flat 8x16 block
        let mut buf = vec![0u8; 8 * 16];
        for row in buf.chunks_mut(8) {
            row[..4].fill(100);
            row[4..].fill(106);
        }
        let kind = Kind::Mb { edge_limit: 30, interior: 10, hev: 3 };
        filter_edge(&mut buf, 4, 1, 8, 16, kind);
        let row = &buf[..8];
        assert!(row.windows(2).all(|w| w[0] <= w[1]), "{row:?}");
        assert!(row[3] > 100 && row[4] < 106, "{row:?}");
        // an edge beyond the limit is left alone
        let mut hard = vec![0u8; 8 * 16];
        for row in hard.chunks_mut(8) {
            row[4..].fill(200);
        }
        let before = hard.clone();
        filter_edge(&mut hard, 4, 1, 8, 16, kind);
        assert_eq!(hard, before);
    }

    /// Every way of filtering an edge gives what `filter_position` gives,
    /// on edges of every character (noise, gentle and sharp steps).
    #[test]
    fn edges_match_the_per_position_filter() {
        let mut seed = 9u32;
        let mut rand = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            seed >> 8
        };
        let stride = 24;
        for round in 0..3000 {
            let spread = [4, 12, 40, 255][round % 4];
            let base = rand() % 256;
            let jump = rand() % 60;
            let buf: Vec<u8> = (0..stride * 24)
                .map(|i| {
                    let side = if (round / 4) % 2 == 0 { (i % stride >= 12) as u32 } else { (i / stride >= 12) as u32 };
                    (base + side * jump + rand() % spread).min(255) as u8
                })
                .collect();
            let level = (rand() % 64) as i32;
            let interior = 1 + (rand() % 20) as i32;
            let hev = (rand() % 4) as i32;
            let kinds = [Kind::Mb { edge_limit: (level + 2) * 2 + interior, interior, hev }, Kind::Inner { edge_limit: level * 2 + interior, interior, hev }, Kind::Simple { edge_limit: level * 2 + interior }];
            for kind in kinds {
                for (step, along, at) in [(1, stride, 4 * stride + 12), (stride, 1, 12 * stride + 4)] {
                    for count in [8, 16] {
                        let mut a = buf.clone();
                        let mut b = buf.clone();
                        filter_edge(&mut a, at, step, along, count, kind);
                        for i in 0..count {
                            filter_position(&mut b, at + i * along, step, kind);
                        }
                        assert_eq!(a, b, "{kind:?} step {step} count {count}");
                    }
                }
            }
        }
    }
}
