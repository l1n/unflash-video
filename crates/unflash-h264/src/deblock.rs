//! The deblocking filter (8.7), run over a whole decoded picture.

use crate::picture::Picture;
use crate::tables::{ALPHA, BETA, TC0};

/// What the filter needs to know about each macroblock.
#[derive(Clone, Copy, Debug, Default)]
pub struct MbDeblockInfo {
    pub decoded: bool,
    pub intra: bool,
    pub transform8x8: bool,
    /// QPY (0 for I_PCM).
    pub qp: i32,
    /// QPc of Cb and Cr.
    pub qpc: [i32; 2],
    /// Bit per 4x4 luma block (raster order in the macroblock): has
    /// non-zero coefficients (an 8x8 transform block sets all four bits).
    pub nonzero: u16,
    pub slice: u32,
    pub filter_idc: u8,
    pub alpha_offset: i32,
    pub beta_offset: i32,
}

#[inline(always)]
fn clip(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// 8.7.2.1: the boundary strength between two 4x4 blocks. `mb_edge` says
/// whether they lie in different macroblocks.
fn boundary_strength(pic: &Picture, p: &MbDeblockInfo, q: &MbDeblockInfo, pb: usize, qb: usize, p_bit: u16, q_bit: u16, mb_edge: bool) -> u8 {
    if p.intra || q.intra {
        return if mb_edge { 4 } else { 3 };
    }
    if p.nonzero & p_bit != 0 || q.nonzero & q_bit != 0 {
        return 2;
    }
    let refs = |b: usize| -> ([i32; 2], [[i16; 2]; 2], usize) {
        let r0 = pic.ref_id[0][b];
        let r1 = pic.ref_id[1][b];
        let n = (r0 >= 0) as usize + (r1 >= 0) as usize;
        ([r0, r1], [pic.mv[0][b], pic.mv[1][b]], n)
    };
    let (rp, mp, np) = refs(pb);
    let (rq, mq, nq) = refs(qb);
    if np != nq {
        return 1;
    }
    let far = |a: [i16; 2], b: [i16; 2]| (a[0] as i32 - b[0] as i32).abs() >= 4 || (a[1] as i32 - b[1] as i32).abs() >= 4;
    if np == 1 {
        let (ip, vp) = if rp[0] >= 0 { (rp[0], mp[0]) } else { (rp[1], mp[1]) };
        let (iq, vq) = if rq[0] >= 0 { (rq[0], mq[0]) } else { (rq[1], mq[1]) };
        if ip != iq {
            return 1;
        }
        return far(vp, vq) as u8;
    }
    // two motion vectors each: the same two pictures, and the vectors paired by picture
    let same_set = (rp[0] == rq[0] && rp[1] == rq[1]) || (rp[0] == rq[1] && rp[1] == rq[0]);
    if !same_set {
        return 1;
    }
    if rp[0] != rp[1] {
        let (q0, q1) = if rp[0] == rq[0] { (mq[0], mq[1]) } else { (mq[1], mq[0]) };
        return (far(mp[0], q0) || far(mp[1], q1)) as u8;
    }
    // both vectors refer to the same picture: either pairing may pass
    let straight = far(mp[0], mq[0]) || far(mp[1], mq[1]);
    let crossed = far(mp[0], mq[1]) || far(mp[1], mq[0]);
    (straight && crossed) as u8
}

/// Filter one line of samples across an edge. `at(k)` addresses sample k
/// where k < 0 is the p side (p0 = -1) and k >= 0 the q side.
#[inline(always)]
fn filter_line(plane: &mut [u8], idx: &dyn Fn(i32) -> usize, bs: u8, alpha: i32, beta: i32, tc0: i32, chroma: bool) {
    let p0 = plane[idx(-1)] as i32;
    let p1 = plane[idx(-2)] as i32;
    let q0 = plane[idx(0)] as i32;
    let q1 = plane[idx(1)] as i32;
    if (p0 - q0).abs() >= alpha || (p1 - p0).abs() >= beta || (q1 - q0).abs() >= beta {
        return;
    }
    if chroma {
        if bs == 4 {
            plane[idx(-1)] = ((2 * p1 + p0 + q1 + 2) >> 2) as u8;
            plane[idx(0)] = ((2 * q1 + q0 + p1 + 2) >> 2) as u8;
        } else {
            let tc = tc0 + 1;
            let delta = ((((q0 - p0) << 2) + (p1 - q1) + 4) >> 3).clamp(-tc, tc);
            plane[idx(-1)] = clip(p0 + delta);
            plane[idx(0)] = clip(q0 - delta);
        }
        return;
    }
    let p2 = plane[idx(-3)] as i32;
    let q2 = plane[idx(2)] as i32;
    let ap = (p2 - p0).abs();
    let aq = (q2 - q0).abs();
    if bs == 4 {
        if ap < beta && (p0 - q0).abs() < ((alpha >> 2) + 2) {
            let p3 = plane[idx(-4)] as i32;
            plane[idx(-1)] = ((p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3) as u8;
            plane[idx(-2)] = ((p2 + p1 + p0 + q0 + 2) >> 2) as u8;
            plane[idx(-3)] = ((2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3) as u8;
        } else {
            plane[idx(-1)] = ((2 * p1 + p0 + q1 + 2) >> 2) as u8;
        }
        if aq < beta && (p0 - q0).abs() < ((alpha >> 2) + 2) {
            let q3 = plane[idx(3)] as i32;
            plane[idx(0)] = ((p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3) as u8;
            plane[idx(1)] = ((p0 + q0 + q1 + q2 + 2) >> 2) as u8;
            plane[idx(2)] = ((2 * q3 + 3 * q2 + q1 + q0 + p0 + 4) >> 3) as u8;
        } else {
            plane[idx(0)] = ((2 * q1 + q0 + p1 + 2) >> 2) as u8;
        }
        return;
    }
    let tc = tc0 + (ap < beta) as i32 + (aq < beta) as i32;
    let delta = ((((q0 - p0) << 2) + (p1 - q1) + 4) >> 3).clamp(-tc, tc);
    plane[idx(-1)] = clip(p0 + delta);
    plane[idx(0)] = clip(q0 - delta);
    if ap < beta {
        plane[idx(-2)] = (p1 + ((p2 + ((p0 + q0 + 1) >> 1) - (p1 << 1)) >> 1).clamp(-tc0, tc0)) as u8;
    }
    if aq < beta {
        plane[idx(1)] = (q1 + ((q2 + ((p0 + q0 + 1) >> 1) - (q1 << 1)) >> 1).clamp(-tc0, tc0)) as u8;
    }
}

/// Deblock the whole picture in macroblock order.
pub fn filter_picture(pic: &mut Picture, mbs: &[MbDeblockInfo], width_mbs: usize, height_mbs: usize) {
    let w4 = pic.width / 4;
    let lw = pic.width;
    let cw = pic.width / 2;
    for my in 0..height_mbs {
        for mx in 0..width_mbs {
            let cur = mbs[my * width_mbs + mx];
            if !cur.decoded || cur.filter_idc == 1 {
                continue;
            }
            let left = if mx > 0 { Some(mbs[my * width_mbs + mx - 1]) } else { None };
            let above = if my > 0 { Some(mbs[(my - 1) * width_mbs + mx]) } else { None };
            let across = |n: &Option<MbDeblockInfo>| n.map_or(false, |n| n.decoded && !(cur.filter_idc == 2 && n.slice != cur.slice));
            let do_left = across(&left);
            let do_above = across(&above);
            // boundary strengths: [edge 0..4][segment 0..4]
            let mut bs_v = [[0u8; 4]; 4];
            let mut bs_h = [[0u8; 4]; 4];
            let bx0 = mx * 4;
            let by0 = my * 4;
            for e in 0..4 {
                for k in 0..4 {
                    // vertical edge e (x = 4e), segment k (rows 4k..)
                    if e == 0 {
                        if do_left {
                            let l = left.unwrap();
                            let pb = (by0 + k) * w4 + bx0 - 1;
                            let qb = (by0 + k) * w4 + bx0;
                            bs_v[0][k] = boundary_strength(pic, &l, &cur, pb, qb, 1 << (k * 4 + 3), 1 << (k * 4), true);
                        }
                    } else if !(cur.transform8x8 && e % 2 == 1) {
                        let pb = (by0 + k) * w4 + bx0 + e - 1;
                        let qb = pb + 1;
                        bs_v[e][k] = boundary_strength(pic, &cur, &cur, pb, qb, 1 << (k * 4 + e - 1), 1 << (k * 4 + e), false);
                    }
                    // horizontal edge e (y = 4e), segment k (columns 4k..)
                    if e == 0 {
                        if do_above {
                            let a = above.unwrap();
                            let pb = (by0 - 1) * w4 + bx0 + k;
                            let qb = by0 * w4 + bx0 + k;
                            bs_h[0][k] = boundary_strength(pic, &a, &cur, pb, qb, 1 << (12 + k), 1 << k, true);
                        }
                    } else if !(cur.transform8x8 && e % 2 == 1) {
                        let pb = (by0 + e - 1) * w4 + bx0 + k;
                        let qb = pb + w4;
                        bs_h[e][k] = boundary_strength(pic, &cur, &cur, pb, qb, 1 << ((e - 1) * 4 + k), 1 << (e * 4 + k), false);
                    }
                }
            }
            let x0 = mx * 16;
            let y0 = my * 16;
            // luma, vertical edges then horizontal edges
            for e in 0..4 {
                if e == 0 && !do_left {
                    continue;
                }
                if cur.transform8x8 && e % 2 == 1 {
                    continue;
                }
                let qp_p = if e == 0 { left.unwrap().qp } else { cur.qp };
                let qpav = (qp_p + cur.qp + 1) >> 1;
                let index_a = (qpav + cur.alpha_offset).clamp(0, 51) as usize;
                let index_b = (qpav + cur.beta_offset).clamp(0, 51) as usize;
                let (alpha, beta) = (ALPHA[index_a] as i32, BETA[index_b] as i32);
                for k in 0..4 {
                    let bs = bs_v[e][k];
                    if bs == 0 {
                        continue;
                    }
                    let tc0 = if bs < 4 { TC0[index_a][bs as usize - 1] as i32 } else { 0 };
                    for r in 0..4 {
                        let y = y0 + k * 4 + r;
                        let x = x0 + e * 4;
                        let idx = |i: i32| (y * lw) as i32 as usize + (x as i32 + i) as usize;
                        filter_line(&mut pic.y, &idx, bs, alpha, beta, tc0, false);
                    }
                }
            }
            for e in 0..4 {
                if e == 0 && !do_above {
                    continue;
                }
                if cur.transform8x8 && e % 2 == 1 {
                    continue;
                }
                let qp_p = if e == 0 { above.unwrap().qp } else { cur.qp };
                let qpav = (qp_p + cur.qp + 1) >> 1;
                let index_a = (qpav + cur.alpha_offset).clamp(0, 51) as usize;
                let index_b = (qpav + cur.beta_offset).clamp(0, 51) as usize;
                let (alpha, beta) = (ALPHA[index_a] as i32, BETA[index_b] as i32);
                for k in 0..4 {
                    let bs = bs_h[e][k];
                    if bs == 0 {
                        continue;
                    }
                    let tc0 = if bs < 4 { TC0[index_a][bs as usize - 1] as i32 } else { 0 };
                    for c in 0..4 {
                        let x = x0 + k * 4 + c;
                        let y = y0 + e * 4;
                        let idx = |i: i32| ((y as i32 + i) as usize) * lw + x;
                        filter_line(&mut pic.y, &idx, bs, alpha, beta, tc0, false);
                    }
                }
            }
            // chroma: edges 0 and 4 of each 8x8 component, using the luma edges 0 and 8
            let cx0 = mx * 8;
            let cy0 = my * 8;
            for comp in 0..2 {
                for &(e, luma_e) in &[(0usize, 0usize), (4, 2)] {
                    if e == 0 && !do_left {
                        continue;
                    }
                    let qp_p = if e == 0 { left.unwrap().qpc[comp] } else { cur.qpc[comp] };
                    let qpav = (qp_p + cur.qpc[comp] + 1) >> 1;
                    let index_a = (qpav + cur.alpha_offset).clamp(0, 51) as usize;
                    let index_b = (qpav + cur.beta_offset).clamp(0, 51) as usize;
                    let (alpha, beta) = (ALPHA[index_a] as i32, BETA[index_b] as i32);
                    for r in 0..8 {
                        let bs = bs_v[luma_e][r / 2];
                        if bs == 0 {
                            continue;
                        }
                        let tc0 = if bs < 4 { TC0[index_a][bs as usize - 1] as i32 } else { 0 };
                        let y = cy0 + r;
                        let x = cx0 + e;
                        let idx = |i: i32| y * cw + (x as i32 + i) as usize;
                        let plane = if comp == 0 { &mut pic.u } else { &mut pic.v };
                        filter_line(plane, &idx, bs, alpha, beta, tc0, true);
                    }
                }
                for &(e, luma_e) in &[(0usize, 0usize), (4, 2)] {
                    if e == 0 && !do_above {
                        continue;
                    }
                    let qp_p = if e == 0 { above.unwrap().qpc[comp] } else { cur.qpc[comp] };
                    let qpav = (qp_p + cur.qpc[comp] + 1) >> 1;
                    let index_a = (qpav + cur.alpha_offset).clamp(0, 51) as usize;
                    let index_b = (qpav + cur.beta_offset).clamp(0, 51) as usize;
                    let (alpha, beta) = (ALPHA[index_a] as i32, BETA[index_b] as i32);
                    for c in 0..8 {
                        let bs = bs_h[luma_e][c / 2];
                        if bs == 0 {
                            continue;
                        }
                        let tc0 = if bs < 4 { TC0[index_a][bs as usize - 1] as i32 } else { 0 };
                        let x = cx0 + c;
                        let y = cy0 + e;
                        let idx = |i: i32| ((y as i32 + i) as usize) * cw + x;
                        let plane = if comp == 0 { &mut pic.u } else { &mut pic.v };
                        filter_line(plane, &idx, bs, alpha, beta, tc0, true);
                    }
                }
            }
        }
    }
}
