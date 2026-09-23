//! The deblocking filter (8.7.2), run over a whole decoded picture: all
//! vertical edges first, then all horizontal ones.
//!
//! Edges lie on the 8x8 grid. An edge belongs to the coding unit on its
//! right (below): that unit's slice decides whether it is filtered at all
//! and with which offsets, and whether it is filtered across a slice
//! boundary.

use crate::meta::{Meta, Motion, RefKey, SliceInfo, BYPASS, CODED, INTRA, NO_SLICE, PCM, PU_LEFT, PU_TOP, TU_LEFT, TU_TOP};
use crate::picture::{Picture, Sample};
use crate::ps::{Layout, Pps, Sps};

/// β′ (Table 8-12) by Q.
const BETA: [u8; 52] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64];
/// tC′ (Table 8-12) by Q.
const TC: [u8; 54] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22, 24];
/// QpC for qPi 30..=43 (Table 8-10).
const QPC: [i32; 14] = [29, 30, 31, 32, 33, 33, 34, 34, 35, 35, 36, 36, 37, 37];

fn qpc(qpi: i32) -> i32 {
    if qpi < 30 {
        qpi
    } else if qpi > 43 {
        qpi - 6
    } else {
        QPC[(qpi - 30) as usize]
    }
}

/// What the filter needs to know about the picture's blocks.
struct Ctx<'a> {
    meta: &'a Meta,
    layout: &'a Layout,
    log2_ctb: u32,
    across_tiles: bool,
    pcm_unfiltered: bool,
}

impl<'a> Ctx<'a> {
    fn slice(&self, b: usize) -> Option<&'a SliceInfo> {
        let (x4, y4) = (b % self.meta.w4, b / self.meta.w4);
        let s = self.meta.ctb_slice[self.ctb(x4, y4)];
        (s != NO_SLICE).then(|| &self.meta.slices[s as usize])
    }

    fn ctb(&self, x4: usize, y4: usize) -> usize {
        let l = self.log2_ctb - 2;
        (y4 >> l) * self.layout.width_ctbs as usize + (x4 >> l)
    }

    /// Whether the samples of block `b` are left as they are.
    fn unfiltered(&self, b: usize) -> bool {
        let f = self.meta.flags[b];
        f & BYPASS != 0 || (self.pcm_unfiltered && f & PCM != 0)
    }

    /// 8.7.2.4: the boundary strength of the edge between block `p` and
    /// block `q` (to its right or below); `tu` / `pu` are q's edge flags
    /// for this direction.
    fn strength(&self, p: usize, q: usize, tu: u8, pu: u8) -> u8 {
        let e = self.meta.edges[q];
        if e & (tu | pu) == 0 {
            return 0;
        }
        let (Some(sq), Some(sp)) = (self.slice(q), self.slice(p)) else { return 0 };
        if sq.deblocking_disabled || (sq.addr != sp.addr && !sq.loop_filter_across_slices) {
            return 0;
        }
        if !self.across_tiles {
            let w4 = self.meta.w4;
            let (cp, cq) = (self.ctb(p % w4, p / w4), self.ctb(q % w4, q / w4));
            if self.layout.tile_id[cp] != self.layout.tile_id[cq] {
                return 0;
            }
        }
        let (fp, fq) = (self.meta.flags[p], self.meta.flags[q]);
        if (fp | fq) & INTRA != 0 {
            return 2;
        }
        if e & tu != 0 && (fp | fq) & CODED != 0 {
            return 1;
        }
        motion_strength(&self.meta.motion[p], &sp.refs, &self.meta.motion[q], &sq.refs)
    }
}

/// The motion part of 8.7.2.4: whether the two blocks predict from
/// different pictures, a different number of vectors, or vectors 4 or
/// more quarter samples apart.
fn motion_strength(mp: &Motion, rp: &[Vec<RefKey>; 2], mq: &Motion, rq: &[Vec<RefKey>; 2]) -> u8 {
    let id = |m: &Motion, r: &[Vec<RefKey>; 2], l: usize| -> Option<u32> { m.uses(l).then(|| r[l].get(m.ref_idx[l] as usize).map_or(u32::MAX, |k| k.id)) };
    let far = |a: [i16; 2], b: [i16; 2]| (a[0] as i32 - b[0] as i32).abs() >= 4 || (a[1] as i32 - b[1] as i32).abs() >= 4;
    let (p0, p1, q0, q1) = (id(mp, rp, 0), id(mp, rp, 1), id(mq, rq, 0), id(mq, rq, 1));
    let np = p0.is_some() as u8 + p1.is_some() as u8;
    let nq = q0.is_some() as u8 + q1.is_some() as u8;
    if np != nq {
        return 1;
    }
    if np == 1 {
        let (pa, mva) = if let Some(a) = p0 { (a, mp.mv[0]) } else { (p1.unwrap_or(0), mp.mv[1]) };
        let (qa, mvb) = if let Some(a) = q0 { (a, mq.mv[0]) } else { (q1.unwrap_or(0), mq.mv[1]) };
        return (pa != qa || far(mva, mvb)) as u8;
    }
    let (p0, p1, q0, q1) = (p0.unwrap_or(0), p1.unwrap_or(0), q0.unwrap_or(0), q1.unwrap_or(0));
    if !((p0 == q0 && p1 == q1) || (p0 == q1 && p1 == q0)) {
        return 1;
    }
    if p0 != p1 {
        // two different pictures: compare the vectors to the same picture
        if p0 == q0 {
            (far(mp.mv[0], mq.mv[0]) || far(mp.mv[1], mq.mv[1])) as u8
        } else {
            (far(mp.mv[0], mq.mv[1]) || far(mp.mv[1], mq.mv[0])) as u8
        }
    } else {
        // the same picture twice: either pairing may match
        ((far(mp.mv[0], mq.mv[0]) || far(mp.mv[1], mq.mv[1])) && (far(mp.mv[0], mq.mv[1]) || far(mp.mv[1], mq.mv[0]))) as u8
    }
}

/// Filter one 4-sample luma edge segment (8.7.2.5.3, 8.7.2.5.4,
/// 8.7.2.5.6, 8.7.2.5.7). `pos` is q0 of the first line; `n` steps across
/// the edge (towards q), `along` along it.
#[allow(clippy::too_many_arguments)]
fn luma_edge<P: Sample>(d: &mut [P], pos: usize, n: isize, along: isize, beta: i32, tc: i32, no_p: bool, no_q: bool, max: i32) {
    let at = |d: &[P], line: isize, i: isize| d[(pos as isize + line * along + i * n) as usize].get();
    // p_i is at offset -(i + 1), q_i at i
    let dp0 = (at(d, 0, -3) - 2 * at(d, 0, -2) + at(d, 0, -1)).abs();
    let dp3 = (at(d, 3, -3) - 2 * at(d, 3, -2) + at(d, 3, -1)).abs();
    let dq0 = (at(d, 0, 2) - 2 * at(d, 0, 1) + at(d, 0, 0)).abs();
    let dq3 = (at(d, 3, 2) - 2 * at(d, 3, 1) + at(d, 3, 0)).abs();
    let (dpq0, dpq3) = (dp0 + dq0, dp3 + dq3);
    let (dp, dq) = (dp0 + dp3, dq0 + dq3);
    if dpq0 + dpq3 >= beta {
        return;
    }
    let sam = |d: &[P], line: isize, dpq: i32| -> bool {
        let (p0, p3, q0, q3) = (at(d, line, -1), at(d, line, -4), at(d, line, 0), at(d, line, 3));
        dpq < (beta >> 2) && (p3 - p0).abs() + (q0 - q3).abs() < (beta >> 3) && (p0 - q0).abs() < ((5 * tc + 1) >> 1)
    };
    let strong = sam(d, 0, 2 * dpq0) && sam(d, 3, 2 * dpq3);
    let dep = dp < ((beta + (beta >> 1)) >> 3);
    let deq = dq < ((beta + (beta >> 1)) >> 3);
    for line in 0..4 {
        let base = pos as isize + line * along;
        let idx = |i: isize| (base + i * n) as usize;
        let (p0, p1, p2, p3) = (d[idx(-1)].get(), d[idx(-2)].get(), d[idx(-3)].get(), d[idx(-4)].get());
        let (q0, q1, q2, q3) = (d[idx(0)].get(), d[idx(1)].get(), d[idx(2)].get(), d[idx(3)].get());
        if strong {
            let tc2 = 2 * tc;
            if !no_p {
                d[idx(-1)] = P::new(((p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3).clamp(p0 - tc2, p0 + tc2));
                d[idx(-2)] = P::new(((p2 + p1 + p0 + q0 + 2) >> 2).clamp(p1 - tc2, p1 + tc2));
                d[idx(-3)] = P::new(((2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3).clamp(p2 - tc2, p2 + tc2));
            }
            if !no_q {
                d[idx(0)] = P::new(((p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3).clamp(q0 - tc2, q0 + tc2));
                d[idx(1)] = P::new(((p0 + q0 + q1 + q2 + 2) >> 2).clamp(q1 - tc2, q1 + tc2));
                d[idx(2)] = P::new(((p0 + q0 + q1 + 3 * q2 + 2 * q3 + 4) >> 3).clamp(q2 - tc2, q2 + tc2));
            }
        } else {
            let delta = (9 * (q0 - p0) - 3 * (q1 - p1) + 8) >> 4;
            if delta.abs() >= tc * 10 {
                continue;
            }
            let delta = delta.clamp(-tc, tc);
            if !no_p {
                d[idx(-1)] = P::new((p0 + delta).clamp(0, max));
                if dep {
                    let dp = ((((p2 + p0 + 1) >> 1) - p1 + delta) >> 1).clamp(-(tc >> 1), tc >> 1);
                    d[idx(-2)] = P::new((p1 + dp).clamp(0, max));
                }
            }
            if !no_q {
                d[idx(0)] = P::new((q0 - delta).clamp(0, max));
                if deq {
                    let dq = ((((q2 + q0 + 1) >> 1) - q1 - delta) >> 1).clamp(-(tc >> 1), tc >> 1);
                    d[idx(1)] = P::new((q1 + dq).clamp(0, max));
                }
            }
        }
    }
}

/// Filter one chroma sample line across an edge (8.7.2.5.8).
#[inline]
fn chroma_sample<P: Sample>(d: &mut [P], q: usize, n: isize, tc: i32, no_p: bool, no_q: bool, max: i32) {
    let at = |i: isize| (q as isize + i * n) as usize;
    let (p0, p1, q0, q1) = (d[at(-1)].get(), d[at(-2)].get(), d[at(0)].get(), d[at(1)].get());
    let delta = ((((q0 - p0) << 2) + p1 - q1 + 4) >> 3).clamp(-tc, tc);
    if !no_p {
        d[at(-1)] = P::new((p0 + delta).clamp(0, max));
    }
    if !no_q {
        d[at(0)] = P::new((q0 - delta).clamp(0, max));
    }
}

/// Run the deblocking filter over a decoded picture.
pub fn deblock<P: Sample>(pic: &mut Picture<P>, meta: &Meta, sps: &Sps, pps: &Pps, layout: &Layout) {
    let cx = Ctx { meta, layout, log2_ctb: sps.log2_ctb, across_tiles: pps.loop_filter_across_tiles, pcm_unfiltered: sps.pcm_loop_filter_disabled };
    let (w4, h4) = (meta.w4, meta.h4);
    let chroma = sps.chroma_format_idc != 0;
    let bd = sps.bit_depth;
    let bdc = sps.bit_depth_chroma;
    let mut bs = vec![0u8; w4 * h4];
    for vertical in [true, false] {
        // boundary strengths of this direction's edges, at their q block
        let (tu, pu) = if vertical { (TU_LEFT, PU_LEFT) } else { (TU_TOP, PU_TOP) };
        for y4 in 0..h4 {
            for x4 in 0..w4 {
                let q = y4 * w4 + x4;
                bs[q] = if vertical && x4 % 2 == 0 && x4 > 0 {
                    cx.strength(q - 1, q, tu, pu)
                } else if !vertical && y4 % 2 == 0 && y4 > 0 {
                    cx.strength(q - w4, q, tu, pu)
                } else {
                    0
                };
            }
        }
        // luma
        {
            let plane = &mut pic.planes[0];
            let stride = plane.stride as isize;
            let (n, along) = if vertical { (1, stride) } else { (stride, 1) };
            let max = (1 << bd) - 1;
            for y4 in 0..h4 {
                for x4 in 0..w4 {
                    let q = y4 * w4 + x4;
                    let s = bs[q] as i32;
                    if s == 0 {
                        continue;
                    }
                    let p = if vertical { q - 1 } else { q - w4 };
                    let Some(sq) = cx.slice(q) else { continue };
                    let qpl = (meta.qp[p] as i32 + meta.qp[q] as i32 + 1) >> 1;
                    let beta = BETA[(qpl + (sq.beta_offset_div2 << 1)).clamp(0, 51) as usize] as i32 * (1 << (bd - 8));
                    let tc = TC[(qpl + 2 * (s - 1) + (sq.tc_offset_div2 << 1)).clamp(0, 53) as usize] as i32 * (1 << (bd - 8));
                    let pos = (y4 * 4) * plane.stride + x4 * 4;
                    luma_edge(&mut plane.data, pos, n, along, beta, tc, cx.unfiltered(p), cx.unfiltered(q), max);
                }
            }
        }
        if !chroma {
            continue;
        }
        // chroma: edges on the 8x8 chroma grid, strength 2 only; each
        // 4-sample chroma segment takes the first of its two luma segments
        let max = (1 << bdc) - 1;
        for c in 1..3 {
            let offset = if c == 1 { pps.cb_qp_offset } else { pps.cr_qp_offset };
            let plane = &mut pic.planes[c];
            let stride = plane.stride;
            let n: isize = if vertical { 1 } else { stride as isize };
            for y4 in (0..h4).step_by(2) {
                for x4 in (0..w4).step_by(2) {
                    let on_grid = if vertical { x4 % 4 == 0 } else { y4 % 4 == 0 };
                    let q = y4 * w4 + x4;
                    if !on_grid || bs[q] != 2 {
                        continue;
                    }
                    let p = if vertical { q - 1 } else { q - w4 };
                    let Some(sq) = cx.slice(q) else { continue };
                    let qpi = ((meta.qp[p] as i32 + meta.qp[q] as i32 + 1) >> 1) + offset;
                    let tc = TC[(qpc(qpi) + 2 + (sq.tc_offset_div2 << 1)).clamp(0, 53) as usize] as i32 * (1 << (bdc - 8));
                    let (xc, yc) = (x4 * 2, y4 * 2);
                    for k in 0..4 {
                        // the luma blocks of this chroma sample line
                        let (qb, pb) = if vertical {
                            let row = ((yc + k) * 2 / 4) * w4;
                            (row + x4, row + x4 - 1)
                        } else {
                            let col = (xc + k) * 2 / 4;
                            (y4 * w4 + col, (y4 - 1) * w4 + col)
                        };
                        let pos = if vertical { (yc + k) * stride + xc } else { yc * stride + xc + k };
                        chroma_sample(&mut plane.data, pos, n, tc, cx.unfiltered(pb), cx.unfiltered(qb), max);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motion_strengths() {
        let refs = [vec![RefKey { poc: 0, long_term: false, id: 1 }, RefKey { poc: 8, long_term: false, id: 2 }], vec![RefKey { poc: 8, long_term: false, id: 2 }, RefKey { poc: 0, long_term: false, id: 1 }]];
        let a = Motion { mv: [[4, 0], [0, 0]], ref_idx: [0, -1] };
        // the same picture through the other list, vectors 3 apart: no edge
        let b = Motion { mv: [[0, 0], [7, 0]], ref_idx: [-1, 1] };
        assert_eq!(motion_strength(&a, &refs, &b, &refs), 0);
        // 4 apart: an edge
        let c = Motion { mv: [[0, 0], [8, 0]], ref_idx: [-1, 1] };
        assert_eq!(motion_strength(&a, &refs, &c, &refs), 1);
        // bi-prediction from the same two pictures in swapped lists
        let d = Motion { mv: [[1, 1], [2, 2]], ref_idx: [0, 0] };
        let e = Motion { mv: [[2, 2], [1, 1]], ref_idx: [1, 1] };
        assert_eq!(motion_strength(&d, &refs, &e, &refs), 0);
        assert_eq!(motion_strength(&a, &refs, &d, &refs), 1);
    }
}
