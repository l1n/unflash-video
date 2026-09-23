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

#[inline(always)]
fn clamp_s8(v: i32) -> i32 {
    v.clamp(-128, 127)
}

#[inline(always)]
fn clamp_u8(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// The samples across an edge: `p[i]` is the i-th sample before it (0
/// nearest) and `q[i]` the i-th after, `step` apart in `buf` from `at` (the
/// first sample after the edge).
#[inline(always)]
fn load(buf: &[u8], at: usize, step: usize) -> ([i32; 4], [i32; 4]) {
    let p = [buf[at - step] as i32, buf[at - 2 * step] as i32, buf[at - 3 * step] as i32, buf[at - 4 * step] as i32];
    let q = [buf[at] as i32, buf[at + step] as i32, buf[at + 2 * step] as i32, buf[at + 3 * step] as i32];
    (p, q)
}

/// 15.2: whether the edge difference is small enough to be an artefact.
#[inline(always)]
fn simple_limit(p: &[i32; 4], q: &[i32; 4], edge_limit: i32) -> bool {
    2 * (p[0] - q[0]).abs() + ((p[1] - q[1]).abs() >> 1) <= edge_limit
}

/// 15.3: the simple limit, and every step on each side within the
/// interior limit.
#[inline(always)]
fn normal_limit(p: &[i32; 4], q: &[i32; 4], edge_limit: i32, interior: i32) -> bool {
    simple_limit(p, q, edge_limit) && (p[3] - p[2]).abs() <= interior && (p[2] - p[1]).abs() <= interior && (p[1] - p[0]).abs() <= interior && (q[3] - q[2]).abs() <= interior && (q[2] - q[1]).abs() <= interior && (q[1] - q[0]).abs() <= interior
}

#[inline(always)]
fn high_edge_variance(p: &[i32; 4], q: &[i32; 4], threshold: i32) -> bool {
    (p[1] - p[0]).abs() > threshold || (q[1] - q[0]).abs() > threshold
}

/// 15.2: move p0 and q0 towards each other (with the outer taps p1 - q1 in
/// the estimate when `outer`), and when not `outer` p1 and q1 by half as
/// much. Returns nothing: the samples are written back.
#[inline(always)]
fn common_adjust(buf: &mut [u8], at: usize, step: usize, p: &[i32; 4], q: &[i32; 4], outer: bool) {
    let mut a = 3 * (q[0] - p[0]);
    if outer {
        a += clamp_s8(p[1] - q[1]);
    }
    let a = clamp_s8(a);
    // (a + 4) >> 3 for q0 and (a + 3) >> 3 for p0 round the halves apart
    let f1 = (a + 4).min(127) >> 3;
    let f2 = (a + 3).min(127) >> 3;
    buf[at - step] = clamp_u8(p[0] + f2);
    buf[at] = clamp_u8(q[0] - f1);
    if !outer {
        let a = (f1 + 1) >> 1;
        buf[at - 2 * step] = clamp_u8(p[1] + a);
        buf[at + step] = clamp_u8(q[1] - a);
    }
}

/// 15.3: the macroblock edge filter of the normal loop filter over `count`
/// positions (`along` apart).
#[allow(clippy::too_many_arguments)]
fn mb_edge(buf: &mut [u8], at: usize, step: usize, along: usize, count: usize, edge_limit: i32, interior: i32, hev: i32) {
    for i in 0..count {
        let at = at + i * along;
        let (p, q) = load(buf, at, step);
        if !normal_limit(&p, &q, edge_limit, interior) {
            continue;
        }
        if high_edge_variance(&p, &q, hev) {
            common_adjust(buf, at, step, &p, &q, true);
            continue;
        }
        let w = clamp_s8(clamp_s8(p[1] - q[1]) + 3 * (q[0] - p[0]));
        let a0 = (27 * w + 63) >> 7;
        let a1 = (18 * w + 63) >> 7;
        let a2 = (9 * w + 63) >> 7;
        buf[at - 3 * step] = clamp_u8(p[2] + a2);
        buf[at - 2 * step] = clamp_u8(p[1] + a1);
        buf[at - step] = clamp_u8(p[0] + a0);
        buf[at] = clamp_u8(q[0] - a0);
        buf[at + step] = clamp_u8(q[1] - a1);
        buf[at + 2 * step] = clamp_u8(q[2] - a2);
    }
}

/// 15.3: the subblock edge filter of the normal loop filter.
#[allow(clippy::too_many_arguments)]
fn inner_edge(buf: &mut [u8], at: usize, step: usize, along: usize, count: usize, edge_limit: i32, interior: i32, hev: i32) {
    for i in 0..count {
        let at = at + i * along;
        let (p, q) = load(buf, at, step);
        if normal_limit(&p, &q, edge_limit, interior) {
            let hv = high_edge_variance(&p, &q, hev);
            common_adjust(buf, at, step, &p, &q, hv);
        }
    }
}

/// 15.2: the simple filter on 16 luma positions.
fn simple_edge(buf: &mut [u8], at: usize, step: usize, along: usize, edge_limit: i32) {
    for i in 0..16 {
        let at = at + i * along;
        let p = [buf[at - step] as i32, buf[at - 2 * step] as i32, 0, 0];
        let q = [buf[at] as i32, buf[at + step] as i32, 0, 0];
        if simple_limit(&p, &q, edge_limit) {
            common_adjust(buf, at, step, &p, &q, true);
        }
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
        if simple {
            if mb_x > 0 {
                simple_edge(&mut pic.y, y0, 1, stride, mb_limit);
            }
            if f.inner {
                for x in [4, 8, 12] {
                    simple_edge(&mut pic.y, y0 + x, 1, stride, sub_limit);
                }
            }
            if mb_y > 0 {
                simple_edge(&mut pic.y, y0, stride, 1, mb_limit);
            }
            if f.inner {
                for y in [4, 8, 12] {
                    simple_edge(&mut pic.y, y0 + y * stride, stride, 1, sub_limit);
                }
            }
            continue;
        }
        if mb_x > 0 {
            mb_edge(&mut pic.y, y0, 1, stride, 16, mb_limit, interior, hev);
            mb_edge(&mut pic.u, c0, 1, uv_stride, 8, mb_limit, interior, hev);
            mb_edge(&mut pic.v, c0, 1, uv_stride, 8, mb_limit, interior, hev);
        }
        if f.inner {
            for x in [4, 8, 12] {
                inner_edge(&mut pic.y, y0 + x, 1, stride, 16, sub_limit, interior, hev);
            }
            inner_edge(&mut pic.u, c0 + 4, 1, uv_stride, 8, sub_limit, interior, hev);
            inner_edge(&mut pic.v, c0 + 4, 1, uv_stride, 8, sub_limit, interior, hev);
        }
        if mb_y > 0 {
            mb_edge(&mut pic.y, y0, stride, 1, 16, mb_limit, interior, hev);
            mb_edge(&mut pic.u, c0, uv_stride, 1, 8, mb_limit, interior, hev);
            mb_edge(&mut pic.v, c0, uv_stride, 1, 8, mb_limit, interior, hev);
        }
        if f.inner {
            for y in [4, 8, 12] {
                inner_edge(&mut pic.y, y0 + y * stride, stride, 1, 16, sub_limit, interior, hev);
            }
            inner_edge(&mut pic.u, c0 + 4 * uv_stride, uv_stride, 1, 8, sub_limit, interior, hev);
            inner_edge(&mut pic.v, c0 + 4 * uv_stride, uv_stride, 1, 8, sub_limit, interior, hev);
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
        mb_edge(&mut buf, 4, 1, 8, 16, 30, 10, 3);
        let row = &buf[..8];
        assert!(row.windows(2).all(|w| w[0] <= w[1]), "{row:?}");
        assert!(row[3] > 100 && row[4] < 106, "{row:?}");
        // an edge beyond the limit is left alone
        let mut hard = vec![0u8; 8 * 16];
        for row in hard.chunks_mut(8) {
            row[4..].fill(200);
        }
        let before = hard.clone();
        mb_edge(&mut hard, 4, 1, 8, 16, 30, 10, 3);
        assert_eq!(hard, before);
    }
}
