//! The deblocking filter (8.7), run over a whole decoded picture.

use crate::picture::{Picture, BOTTOM, FRAME};
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

/// 8.7.2.1: the boundary strength between two inter 4x4 blocks without
/// coefficients (the intra and coefficient cases are decided by the caller).
#[inline]
fn motion_bs(pic: &Picture, pb: usize, qb: usize, mvy_limit: i32) -> u8 {
    let rp = [pic.ref_id[0][pb], pic.ref_id[1][pb]];
    let rq = [pic.ref_id[0][qb], pic.ref_id[1][qb]];
    let mp = [pic.mv[0][pb], pic.mv[1][pb]];
    let mq = [pic.mv[0][qb], pic.mv[1][qb]];
    let np = (rp[0] >= 0) as usize + (rp[1] >= 0) as usize;
    let nq = (rq[0] >= 0) as usize + (rq[1] >= 0) as usize;
    if np != nq {
        return 1;
    }
    let far = |a: [i16; 2], b: [i16; 2]| (a[0] as i32 - b[0] as i32).abs() >= 4 || (a[1] as i32 - b[1] as i32).abs() >= mvy_limit;
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

/// The boundary strength of the edge between blocks `pb` (in MB `p`) and
/// `qb` (in MB `q`); `p_bit` / `q_bit` select their coefficient flags.
/// `strong` says an intra macroblock edge gets bS 4 (a frame macroblock
/// edge, or a vertical one in a field); vertical motion differs at
/// `mvy_limit` quarter samples (2 for field macroblocks).
#[inline]
#[allow(clippy::too_many_arguments)]
fn boundary_strength(pic: &Picture, p: &MbDeblockInfo, q: &MbDeblockInfo, pb: usize, qb: usize, p_bit: u16, q_bit: u16, strong: bool, mvy_limit: i32) -> u8 {
    if p.intra || q.intra {
        return if strong { 4 } else { 3 };
    }
    if p.nonzero & p_bit != 0 || q.nonzero & q_bit != 0 {
        return 2;
    }
    motion_bs(pic, pb, qb, mvy_limit)
}

/// Whether all sixteen 4x4 blocks of the macroblock at (`bx0`, `by0`) (in
/// 4x4 units) carry the same motion, so its internal edges need no filtering
/// when it has no coefficients.
fn uniform_motion(pic: &Picture, bx0: usize, by0: usize, w4: usize) -> bool {
    let b0 = by0 * w4 + bx0;
    let key = |b: usize| (pic.ref_id[0][b], pic.ref_id[1][b], pic.mv[0][b], pic.mv[1][b]);
    let k0 = key(b0);
    for y in 0..4 {
        for x in 0..4 {
            if key((by0 + y) * w4 + bx0 + x) != k0 {
                return false;
            }
        }
    }
    true
}

/// Filter one line of luma samples across a vertical edge: `s` holds
/// p3 p2 p1 p0 q0 q1 q2 q3.
#[inline(always)]
fn luma_line(s: &mut [u8; 8], bs: u8, alpha: i32, beta: i32, tc0: i32) {
    let p0 = s[3] as i32;
    let q0 = s[4] as i32;
    if (p0 - q0).abs() >= alpha {
        return;
    }
    let p1 = s[2] as i32;
    let q1 = s[5] as i32;
    if (p1 - p0).abs() >= beta || (q1 - q0).abs() >= beta {
        return;
    }
    let p2 = s[1] as i32;
    let q2 = s[6] as i32;
    let ap = (p2 - p0).abs();
    let aq = (q2 - q0).abs();
    if bs == 4 {
        let strong = (p0 - q0).abs() < ((alpha >> 2) + 2);
        if ap < beta && strong {
            let p3 = s[0] as i32;
            s[3] = ((p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3) as u8;
            s[2] = ((p2 + p1 + p0 + q0 + 2) >> 2) as u8;
            s[1] = ((2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3) as u8;
        } else {
            s[3] = ((2 * p1 + p0 + q1 + 2) >> 2) as u8;
        }
        if aq < beta && strong {
            let q3 = s[7] as i32;
            s[4] = ((p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3) as u8;
            s[5] = ((p0 + q0 + q1 + q2 + 2) >> 2) as u8;
            s[6] = ((2 * q3 + 3 * q2 + q1 + q0 + p0 + 4) >> 3) as u8;
        } else {
            s[4] = ((2 * q1 + q0 + p1 + 2) >> 2) as u8;
        }
        return;
    }
    let tc = tc0 + (ap < beta) as i32 + (aq < beta) as i32;
    let delta = ((((q0 - p0) << 2) + (p1 - q1) + 4) >> 3).clamp(-tc, tc);
    s[3] = clip(p0 + delta);
    s[4] = clip(q0 - delta);
    if ap < beta {
        s[2] = (p1 + ((p2 + ((p0 + q0 + 1) >> 1) - (p1 << 1)) >> 1).clamp(-tc0, tc0)) as u8;
    }
    if aq < beta {
        s[5] = (q1 + ((q2 + ((p0 + q0 + 1) >> 1) - (q1 << 1)) >> 1).clamp(-tc0, tc0)) as u8;
    }
}

/// Filter `N` columns across a horizontal edge whose first q row starts at
/// `pl[q0]` (rows `stride` apart); `bs` and `tc0` are per column. All the
/// columns of the edge share the strong (bS 4) / normal decision, so each
/// column is computed without branches and the loops vectorise.
#[inline(always)]
fn luma_edge_h<const N: usize>(pl: &mut [u8], q0: usize, stride: usize, bs: &[u8; N], tc0: &[i32; N], strong_edge: bool, alpha: i32, beta: i32) {
    let mut p = [[0i32; N]; 4];
    let mut q = [[0i32; N]; 4];
    for k in 0..4 {
        let rp = &pl[q0 - (k + 1) * stride..q0 - (k + 1) * stride + N];
        let rq = &pl[q0 + k * stride..q0 + k * stride + N];
        for i in 0..N {
            p[k][i] = rp[i] as i32;
            q[k][i] = rq[i] as i32;
        }
    }
    let mut np = [[0u8; N]; 3];
    let mut nq = [[0u8; N]; 3];
    let sel = |c: bool, a: i32, b: i32| -> i32 { (c as i32) * a + (!c as i32) * b };
    if strong_edge {
        for i in 0..N {
            let (p0, p1, p2, p3) = (p[0][i], p[1][i], p[2][i], p[3][i]);
            let (q0v, q1, q2, q3) = (q[0][i], q[1][i], q[2][i], q[3][i]);
            let filt = (bs[i] != 0) & ((p0 - q0v).abs() < alpha) & ((p1 - p0).abs() < beta) & ((q1 - q0v).abs() < beta);
            let strong = (p0 - q0v).abs() < ((alpha >> 2) + 2);
            let sp = ((p2 - p0).abs() < beta) & strong & filt;
            let sq = ((q2 - q0v).abs() < beta) & strong & filt;
            let p0w = sel(sp, (p2 + 2 * p1 + 2 * p0 + 2 * q0v + q1 + 4) >> 3, (2 * p1 + p0 + q1 + 2) >> 2);
            let q0w = sel(sq, (p1 + 2 * p0 + 2 * q0v + 2 * q1 + q2 + 4) >> 3, (2 * q1 + q0v + p1 + 2) >> 2);
            np[0][i] = sel(filt, p0w, p0) as u8;
            np[1][i] = sel(sp, (p2 + p1 + p0 + q0v + 2) >> 2, p1) as u8;
            np[2][i] = sel(sp, (2 * p3 + 3 * p2 + p1 + p0 + q0v + 4) >> 3, p2) as u8;
            nq[0][i] = sel(filt, q0w, q0v) as u8;
            nq[1][i] = sel(sq, (p0 + q0v + q1 + q2 + 2) >> 2, q1) as u8;
            nq[2][i] = sel(sq, (2 * q3 + 3 * q2 + q1 + q0v + p0 + 4) >> 3, q2) as u8;
        }
        for k in 0..3 {
            pl[q0 - (k + 1) * stride..q0 - (k + 1) * stride + N].copy_from_slice(&np[k]);
            pl[q0 + k * stride..q0 + k * stride + N].copy_from_slice(&nq[k]);
        }
    } else {
        for i in 0..N {
            let (p0, p1, p2) = (p[0][i], p[1][i], p[2][i]);
            let (q0v, q1, q2) = (q[0][i], q[1][i], q[2][i]);
            let filt = (bs[i] != 0) & ((p0 - q0v).abs() < alpha) & ((p1 - p0).abs() < beta) & ((q1 - q0v).abs() < beta);
            let ap = (p2 - p0).abs() < beta;
            let aq = (q2 - q0v).abs() < beta;
            let t0 = tc0[i];
            let tc = t0 + ap as i32 + aq as i32;
            let delta = ((((q0v - p0) << 2) + (p1 - q1) + 4) >> 3).clamp(-tc, tc);
            let avg = (p0 + q0v + 1) >> 1;
            let p1f = p1 + ((p2 + avg - (p1 << 1)) >> 1).clamp(-t0, t0);
            let q1f = q1 + ((q2 + avg - (q1 << 1)) >> 1).clamp(-t0, t0);
            np[0][i] = sel(filt, (p0 + delta).clamp(0, 255), p0) as u8;
            nq[0][i] = sel(filt, (q0v - delta).clamp(0, 255), q0v) as u8;
            np[1][i] = sel(filt & ap, p1f, p1) as u8;
            nq[1][i] = sel(filt & aq, q1f, q1) as u8;
        }
        for k in 0..2 {
            pl[q0 - (k + 1) * stride..q0 - (k + 1) * stride + N].copy_from_slice(&np[k]);
            pl[q0 + k * stride..q0 + k * stride + N].copy_from_slice(&nq[k]);
        }
    }
}

/// The chroma counterpart of `luma_edge_h` (one sample changes each side).
#[inline(always)]
fn chroma_edge_h<const N: usize>(pl: &mut [u8], q0: usize, stride: usize, bs: &[u8; N], tc0: &[i32; N], strong_edge: bool, alpha: i32, beta: i32) {
    let mut np = [0u8; N];
    let mut nq = [0u8; N];
    let sel = |c: bool, a: i32, b: i32| -> i32 { (c as i32) * a + (!c as i32) * b };
    {
        let (p1r, p0r, q0r, q1r) = (&pl[q0 - 2 * stride..q0 - 2 * stride + N], &pl[q0 - stride..q0 - stride + N], &pl[q0..q0 + N], &pl[q0 + stride..q0 + stride + N]);
        for i in 0..N {
            let (p1, p0, q0v, q1) = (p1r[i] as i32, p0r[i] as i32, q0r[i] as i32, q1r[i] as i32);
            let filt = (bs[i] != 0) & ((p0 - q0v).abs() < alpha) & ((p1 - p0).abs() < beta) & ((q1 - q0v).abs() < beta);
            let (p0n, q0n) = if strong_edge {
                ((2 * p1 + p0 + q1 + 2) >> 2, (2 * q1 + q0v + p1 + 2) >> 2)
            } else {
                let tc = tc0[i] + 1;
                let delta = ((((q0v - p0) << 2) + (p1 - q1) + 4) >> 3).clamp(-tc, tc);
                ((p0 + delta).clamp(0, 255), (q0v - delta).clamp(0, 255))
            };
            np[i] = sel(filt, p0n, p0) as u8;
            nq[i] = sel(filt, q0n, q0v) as u8;
        }
    }
    pl[q0 - stride..q0 - stride + N].copy_from_slice(&np);
    pl[q0..q0 + N].copy_from_slice(&nq);
}

/// Filter one line of chroma samples across a vertical edge: `s` holds
/// p1 p0 q0 q1.
#[inline(always)]
fn chroma_line(s: &mut [u8; 4], bs: u8, alpha: i32, beta: i32, tc0: i32) {
    let p1 = s[0] as i32;
    let p0 = s[1] as i32;
    let q0 = s[2] as i32;
    let q1 = s[3] as i32;
    if (p0 - q0).abs() >= alpha || (p1 - p0).abs() >= beta || (q1 - q0).abs() >= beta {
        return;
    }
    if bs == 4 {
        s[1] = ((2 * p1 + p0 + q1 + 2) >> 2) as u8;
        s[2] = ((2 * q1 + q0 + p1 + 2) >> 2) as u8;
    } else {
        let tc = tc0 + 1;
        let delta = ((((q0 - p0) << 2) + (p1 - q1) + 4) >> 3).clamp(-tc, tc);
        s[1] = clip(p0 + delta);
        s[2] = clip(q0 - delta);
    }
}

/// alpha, beta and the tc0 row for an edge between macroblocks of QP
/// `qp_p` and `qp_q` with the current MB's filter offsets.
#[inline(always)]
fn thresholds(qp_p: i32, qp_q: i32, cur: &MbDeblockInfo) -> (i32, i32, [u8; 3]) {
    let qpav = (qp_p + qp_q + 1) >> 1;
    let index_a = (qpav + cur.alpha_offset).clamp(0, 51) as usize;
    let index_b = (qpav + cur.beta_offset).clamp(0, 51) as usize;
    (ALPHA[index_a] as i32, BETA[index_b] as i32, TC0[index_a])
}

/// Deblock the picture (a frame, or the field `structure` of it) in
/// macroblock order.
pub fn filter_picture(pic: &mut Picture, mbs: &[MbDeblockInfo], width_mbs: usize, height_mbs: usize, structure: u8) {
    if pic.mbaff && structure == FRAME {
        return filter_picture_mbaff(pic, mbs, width_mbs, height_mbs);
    }
    let w4 = pic.width / 4;
    let field = structure != FRAME;
    let parity = (structure == BOTTOM) as usize;
    let mvy_limit = if field { 2 } else { 4 };
    // strides and macroblock rows of the field / frame being filtered
    let lw = if field { 2 * pic.width } else { pic.width };
    let cw = if field { pic.width } else { pic.width / 2 };
    let rows = if field { height_mbs / 2 } else { height_mbs };
    let row_step = if field { 2 } else { 1 };
    for row in 0..rows {
        let my = if field { 2 * row + parity } else { row };
        for mx in 0..width_mbs {
            let cur = mbs[my * width_mbs + mx];
            if !cur.decoded || cur.filter_idc == 1 {
                continue;
            }
            let left = if mx > 0 { Some(mbs[my * width_mbs + mx - 1]) } else { None };
            let above = if row > 0 { Some(mbs[(my - row_step) * width_mbs + mx]) } else { None };
            let across = |n: &Option<MbDeblockInfo>| n.map_or(false, |n| n.decoded && !(cur.filter_idc == 2 && n.slice != cur.slice));
            let do_left = across(&left);
            let do_above = across(&above);
            // boundary strengths: [edge 0..4][segment 0..4]
            let mut bs_v = [[0u8; 4]; 4];
            let mut bs_h = [[0u8; 4]; 4];
            let bx0 = mx * 4;
            let by0 = my * 4;
            if do_left {
                let l = left.unwrap();
                for k in 0..4 {
                    let qb = (by0 + k) * w4 + bx0;
                    bs_v[0][k] = boundary_strength(pic, &l, &cur, qb - 1, qb, 1 << (k * 4 + 3), 1 << (k * 4), true, mvy_limit);
                }
            }
            if do_above {
                let a = above.unwrap();
                // the last block row of the macroblock above (of the same field)
                let above_off = (4 * row_step - 3) * w4;
                for k in 0..4 {
                    let qb = by0 * w4 + bx0 + k;
                    bs_h[0][k] = boundary_strength(pic, &a, &cur, qb - above_off, qb, 1 << (12 + k), 1 << k, !field, mvy_limit);
                }
            }
            // internal edges
            if cur.intra {
                for e in 1..4 {
                    if cur.transform8x8 && e % 2 == 1 {
                        continue;
                    }
                    bs_v[e] = [3; 4];
                    bs_h[e] = [3; 4];
                }
            } else if cur.nonzero != 0 || !uniform_motion(pic, bx0, by0, w4) {
                for e in 1..4 {
                    if cur.transform8x8 && e % 2 == 1 {
                        continue;
                    }
                    for k in 0..4 {
                        // vertical edge e (x = 4e), segment k (rows 4k..)
                        let pb = (by0 + k) * w4 + bx0 + e - 1;
                        bs_v[e][k] = boundary_strength(pic, &cur, &cur, pb, pb + 1, 1 << (k * 4 + e - 1), 1 << (k * 4 + e), false, mvy_limit);
                        // horizontal edge e (y = 4e), segment k (columns 4k..)
                        let pb = (by0 + e - 1) * w4 + bx0 + k;
                        bs_h[e][k] = boundary_strength(pic, &cur, &cur, pb, pb + w4, 1 << ((e - 1) * 4 + k), 1 << (e * 4 + k), false, mvy_limit);
                    }
                }
            }
            if crate::debug_flag("H264_DBG_MB").map_or(false, |v| v == format!("{mx},{row},{structure}")) {
                eprintln!("deblock mb ({mx},{row}) struct {structure}: intra {} t8 {} qp {} qpc {:?} nz {:#x} slice {} idc {} a/b {}/{} left {:?} above {:?} bs_v {:?} bs_h {:?}", cur.intra, cur.transform8x8, cur.qp, cur.qpc, cur.nonzero, cur.slice, cur.filter_idc, cur.alpha_offset, cur.beta_offset, left.map(|l| (l.qp, l.slice, l.intra)), above.map(|a| (a.qp, a.slice, a.intra)), bs_v, bs_h);
            }
            let x0 = mx * 16;
            // the first luma / chroma line of the macroblock, in lines of the frame
            let y0 = if field { 32 * row + parity } else { 16 * my };
            let ybase = y0 * pic.width + x0;
            let cybase = (if field { 16 * row + parity } else { 8 * my }) * (pic.width / 2) + mx * 8;
            // luma, vertical edges then horizontal edges
            for e in 0..4 {
                if (e == 0 && !do_left) || (cur.transform8x8 && e % 2 == 1) || bs_v[e] == [0; 4] {
                    continue;
                }
                let qp_p = if e == 0 { left.unwrap().qp } else { cur.qp };
                let (alpha, beta, tc0s) = thresholds(qp_p, cur.qp, &cur);
                for k in 0..4 {
                    let bs = bs_v[e][k];
                    if bs == 0 {
                        continue;
                    }
                    let tc0 = if bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 };
                    let base = ybase + k * 4 * lw + e * 4 - 4;
                    for r in 0..4 {
                        let o = base + r * lw;
                        let s: &mut [u8; 8] = (&mut pic.y[o..o + 8]).try_into().unwrap();
                        luma_line(s, bs, alpha, beta, tc0);
                    }
                }
            }
            for e in 0..4 {
                if (e == 0 && !do_above) || (cur.transform8x8 && e % 2 == 1) || bs_h[e] == [0; 4] {
                    continue;
                }
                let qp_p = if e == 0 { above.unwrap().qp } else { cur.qp };
                let (alpha, beta, tc0s) = thresholds(qp_p, cur.qp, &cur);
                let mut bs16 = [0u8; 16];
                let mut tc16 = [0i32; 16];
                for k in 0..4 {
                    let bs = bs_h[e][k];
                    bs16[k * 4..k * 4 + 4].fill(bs);
                    tc16[k * 4..k * 4 + 4].fill(if bs != 0 && bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 });
                }
                luma_edge_h::<16>(&mut pic.y, ybase + e * 4 * lw, lw, &bs16, &tc16, bs_h[e][0] == 4, alpha, beta);
            }
            // chroma: edges 0 and 4 of each 8x8 component, using the luma edges 0 and 2
            for comp in 0..2 {
                for &(e, luma_e) in &[(0usize, 0usize), (4, 2)] {
                    if (e == 0 && !do_left) || bs_v[luma_e] == [0; 4] {
                        continue;
                    }
                    let qp_p = if e == 0 { left.unwrap().qpc[comp] } else { cur.qpc[comp] };
                    let (alpha, beta, tc0s) = thresholds(qp_p, cur.qpc[comp], &cur);
                    let plane = if comp == 0 { &mut pic.u } else { &mut pic.v };
                    for r in 0..8 {
                        let bs = bs_v[luma_e][r / 2];
                        if bs == 0 {
                            continue;
                        }
                        let tc0 = if bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 };
                        let o = cybase + r * cw + e - 2;
                        let s: &mut [u8; 4] = (&mut plane[o..o + 4]).try_into().unwrap();
                        chroma_line(s, bs, alpha, beta, tc0);
                    }
                }
                for &(e, luma_e) in &[(0usize, 0usize), (4, 2)] {
                    if (e == 0 && !do_above) || bs_h[luma_e] == [0; 4] {
                        continue;
                    }
                    let qp_p = if e == 0 { above.unwrap().qpc[comp] } else { cur.qpc[comp] };
                    let (alpha, beta, tc0s) = thresholds(qp_p, cur.qpc[comp], &cur);
                    let plane = if comp == 0 { &mut pic.u } else { &mut pic.v };
                    let mut bs8 = [0u8; 8];
                    let mut tc8 = [0i32; 8];
                    for k in 0..4 {
                        let bs = bs_h[luma_e][k];
                        bs8[k * 2..k * 2 + 2].fill(bs);
                        tc8[k * 2..k * 2 + 2].fill(if bs != 0 && bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 });
                    }
                    chroma_edge_h::<8>(plane, cybase + e * cw, cw, &bs8, &tc8, bs_h[luma_e][0] == 4, alpha, beta);
                }
            }
        }
    }
}

/// Deblock an MBAFF frame (8.7 with MbaffFrameFlag = 1): pair by pair, top
/// then bottom macroblock, each along its own kind of rows. An edge between
/// a frame macroblock and a field pair is "mixed": the left one is filtered
/// row by row against whichever macroblock of the left pair owns the row
/// (eight strengths, two quantiser averages), the top edge of a frame
/// macroblock under a field pair is filtered twice in field mode (once per
/// field macroblock above), and the top edge of a field macroblock over a
/// frame pair in field mode against the frame macroblock's interleaved rows;
/// mixed edges get bS 1 (2 with coefficients) instead of a motion test.
fn filter_picture_mbaff(pic: &mut Picture, mbs: &[MbDeblockInfo], wm: usize, hm: usize) {
    let width = pic.width;
    let cwidth = width / 2;
    let w4 = width / 4;
    for pr in 0..hm / 2 {
        for mx in 0..wm {
            for b in 0..2 {
                let my = 2 * pr + b;
                let addr = my * wm + mx;
                let cur = mbs[addr];
                if !cur.decoded || cur.filter_idc == 1 {
                    continue;
                }
                let field = pic.mb_field[addr];
                let mvy_limit = if field { 2 } else { 4 };
                let (lw, cw) = if field { (2 * width, 2 * cwidth) } else { (width, cwidth) };
                let ybase = if field { (32 * pr + b) * width } else { 16 * my * width } + 16 * mx;
                let cybase = if field { (16 * pr + b) * cwidth } else { 8 * my * cwidth } + 8 * mx;
                let (bx0, by0) = (mx * 4, my * 4);
                let avail = |n: &MbDeblockInfo| n.decoded && !(cur.filter_idc == 2 && n.slice != cur.slice);
                let mut bs_v = [[0u8; 4]; 4];
                let mut bs_h = [[0u8; 4]; 4];
                // ---- the left edge: the left pair's macroblock of this row, or both of them
                let left_top = (2 * pr * wm + mx).wrapping_sub(1);
                let do_left = mx > 0 && avail(&mbs[left_top]);
                let mixed_left = do_left && pic.mb_field[left_top] != field;
                let mut bs_left8 = [0u8; 8];
                if do_left && !mixed_left {
                    let l = mbs[addr - 1];
                    for k in 0..4 {
                        let qb = (by0 + k) * w4 + bx0;
                        bs_v[0][k] = boundary_strength(pic, &l, &cur, qb - 1, qb, 1 << (k * 4 + 3), 1 << (k * 4), true, mvy_limit);
                    }
                } else if mixed_left {
                    let lt = mbs[left_top];
                    let lb = mbs[left_top + wm];
                    for (i, bs) in bs_left8.iter_mut().enumerate() {
                        // segment i is two rows of this macroblock (block row i / 2); the
                        // left macroblock owning them and its block row there:
                        let (nb, nb_row) = if field {
                            // a field macroblock's rows 0..7 lie in the left pair's top frame
                            // macroblock, 8..15 in its bottom one
                            (if i < 4 { lt } else { lb }, i & 3)
                        } else {
                            // a frame macroblock's even rows belong to the left top field
                            // macroblock, its odd rows to the bottom one
                            (if i & 1 == 0 { lt } else { lb }, 2 * b + (i >> 2))
                        };
                        *bs = if cur.intra || nb.intra {
                            4
                        } else {
                            let cur_nz = cur.nonzero & (1 << ((i >> 1) * 4)) != 0;
                            let nb_nz = nb.nonzero & (1 << (nb_row * 4 + 3)) != 0;
                            1 + (cur_nz || nb_nz) as u8
                        };
                    }
                }
                // ---- the top edge: the macroblock above in this macroblock's kind of rows
                let above_field_pair = pr > 0 && pic.mb_field[(2 * pr - 2) * wm + mx];
                // a frame macroblock under a field pair: filtered once per field
                let double_top = !field && b == 0 && above_field_pair && avail(&mbs[(2 * pr - 1) * wm + mx]);
                let above_addr: Option<usize> = if !field {
                    if my > 0 {
                        Some(addr - wm)
                    } else {
                        None
                    }
                } else if pr == 0 {
                    None
                } else if b == 0 {
                    Some(if above_field_pair { (2 * pr - 2) * wm + mx } else { (2 * pr - 1) * wm + mx })
                } else {
                    Some((2 * pr - 1) * wm + mx)
                };
                let above_addr = above_addr.filter(|&a| avail(&mbs[a]) && !double_top);
                if let Some(a_addr) = above_addr {
                    let a = mbs[a_addr];
                    let a_field = pic.mb_field[a_addr];
                    let mixed = a_field != field;
                    let strong = !field && !a_field;
                    let a_row3 = ((a_addr / wm) * 4 + 3) * w4 + bx0;
                    for k in 0..4 {
                        let qb = by0 * w4 + bx0 + k;
                        bs_h[0][k] = if mixed {
                            if cur.intra || a.intra {
                                3
                            } else {
                                1 + ((cur.nonzero >> k) & 1 != 0 || (a.nonzero >> (12 + k)) & 1 != 0) as u8
                            }
                        } else {
                            boundary_strength(pic, &a, &cur, a_row3 + k, qb, 1 << (12 + k), 1 << k, strong, mvy_limit)
                        };
                    }
                }
                // ---- internal edges
                if cur.intra {
                    for e in 1..4 {
                        if cur.transform8x8 && e % 2 == 1 {
                            continue;
                        }
                        bs_v[e] = [3; 4];
                        bs_h[e] = [3; 4];
                    }
                } else if cur.nonzero != 0 || !uniform_motion(pic, bx0, by0, w4) {
                    for e in 1..4 {
                        if cur.transform8x8 && e % 2 == 1 {
                            continue;
                        }
                        for k in 0..4 {
                            let pb = (by0 + k) * w4 + bx0 + e - 1;
                            bs_v[e][k] = boundary_strength(pic, &cur, &cur, pb, pb + 1, 1 << (k * 4 + e - 1), 1 << (k * 4 + e), false, mvy_limit);
                            let pb = (by0 + e - 1) * w4 + bx0 + k;
                            bs_h[e][k] = boundary_strength(pic, &cur, &cur, pb, pb + w4, 1 << ((e - 1) * 4 + k), 1 << (e * 4 + k), false, mvy_limit);
                        }
                    }
                }
                if crate::debug_flag("H264_DBG_MB").map_or(false, |v| v == format!("{mx},{my},4")) {
                    eprintln!("deblock mbaff mb ({mx},{my}) field {field}: intra {} t8 {} qp {} nz {:#x} mixed_left {mixed_left} double_top {double_top} above {:?} bs_left8 {:?} bs_v {:?} bs_h {:?}", cur.intra, cur.transform8x8, cur.qp, cur.nonzero, above_addr, bs_left8, bs_v, bs_h);
                }
                // ---- luma, vertical edges
                if mixed_left {
                    let lt = mbs[left_top];
                    let lb = mbs[left_top + wm];
                    let th = [thresholds(lt.qp, cur.qp, &cur), thresholds(lb.qp, cur.qp, &cur)];
                    for r in 0..16 {
                        let (bs, half) = if field { (bs_left8[r / 2], (r >= 8) as usize) } else { (bs_left8[2 * (r / 4) + (r & 1)], r & 1) };
                        if bs == 0 {
                            continue;
                        }
                        let (alpha, beta, tc0s) = th[half];
                        let tc0 = if bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 };
                        let o = ybase + r * lw - 4;
                        let s: &mut [u8; 8] = (&mut pic.y[o..o + 8]).try_into().unwrap();
                        luma_line(s, bs, alpha, beta, tc0);
                    }
                }
                for e in 0..4 {
                    if (e == 0 && (!do_left || mixed_left)) || (cur.transform8x8 && e % 2 == 1) || bs_v[e] == [0; 4] {
                        continue;
                    }
                    let qp_p = if e == 0 { mbs[addr - 1].qp } else { cur.qp };
                    let (alpha, beta, tc0s) = thresholds(qp_p, cur.qp, &cur);
                    for k in 0..4 {
                        let bs = bs_v[e][k];
                        if bs == 0 {
                            continue;
                        }
                        let tc0 = if bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 };
                        let base = ybase + k * 4 * lw + e * 4 - 4;
                        for r in 0..4 {
                            let o = base + r * lw;
                            let s: &mut [u8; 8] = (&mut pic.y[o..o + 8]).try_into().unwrap();
                            luma_line(s, bs, alpha, beta, tc0);
                        }
                    }
                }
                // ---- luma, horizontal edges
                let mut double_bs = [[0u8; 4]; 2];
                if double_top {
                    for j in 0..2 {
                        let nb = mbs[(2 * pr - 2 + j) * wm + mx];
                        for i in 0..4 {
                            double_bs[j][i] = if cur.intra || nb.intra { 3 } else { 1 + ((cur.nonzero >> i) & 1 != 0 || (nb.nonzero >> (12 + i)) & 1 != 0) as u8 };
                        }
                        let (alpha, beta, tc0s) = thresholds(nb.qp, cur.qp, &cur);
                        let mut bs16 = [0u8; 16];
                        let mut tc16 = [0i32; 16];
                        for k in 0..4 {
                            let bs = double_bs[j][k];
                            bs16[k * 4..k * 4 + 4].fill(bs);
                            tc16[k * 4..k * 4 + 4].fill(tc0s[bs as usize - 1] as i32);
                        }
                        // the field's rows of this frame macroblock (j, j + 2, ...) against
                        // the field macroblock above (rows -2, -4, ... from row j)
                        luma_edge_h::<16>(&mut pic.y, ybase + j * width, 2 * width, &bs16, &tc16, false, alpha, beta);
                    }
                }
                for e in 0..4 {
                    if (e == 0 && above_addr.is_none()) || (cur.transform8x8 && e % 2 == 1) || bs_h[e] == [0; 4] {
                        continue;
                    }
                    let qp_p = if e == 0 { mbs[above_addr.unwrap()].qp } else { cur.qp };
                    let (alpha, beta, tc0s) = thresholds(qp_p, cur.qp, &cur);
                    let mut bs16 = [0u8; 16];
                    let mut tc16 = [0i32; 16];
                    for k in 0..4 {
                        let bs = bs_h[e][k];
                        bs16[k * 4..k * 4 + 4].fill(bs);
                        tc16[k * 4..k * 4 + 4].fill(if bs != 0 && bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 });
                    }
                    luma_edge_h::<16>(&mut pic.y, ybase + e * 4 * lw, lw, &bs16, &tc16, bs_h[e][0] == 4, alpha, beta);
                }
                // ---- chroma
                for comp in 0..2 {
                    if mixed_left {
                        let lt = mbs[left_top];
                        let lb = mbs[left_top + wm];
                        let th = [thresholds(lt.qpc[comp], cur.qpc[comp], &cur), thresholds(lb.qpc[comp], cur.qpc[comp], &cur)];
                        let plane = if comp == 0 { &mut pic.u } else { &mut pic.v };
                        for r in 0..8 {
                            let bs = bs_left8[r];
                            let half = if field { (r >= 4) as usize } else { r & 1 };
                            if bs == 0 {
                                continue;
                            }
                            let (alpha, beta, tc0s) = th[half];
                            let tc0 = if bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 };
                            let o = cybase + r * cw - 2;
                            let s: &mut [u8; 4] = (&mut plane[o..o + 4]).try_into().unwrap();
                            chroma_line(s, bs, alpha, beta, tc0);
                        }
                    }
                    for &(e, luma_e) in &[(0usize, 0usize), (4, 2)] {
                        if (e == 0 && (!do_left || mixed_left)) || bs_v[luma_e] == [0; 4] {
                            continue;
                        }
                        let qp_p = if e == 0 { mbs[addr - 1].qpc[comp] } else { cur.qpc[comp] };
                        let (alpha, beta, tc0s) = thresholds(qp_p, cur.qpc[comp], &cur);
                        let plane = if comp == 0 { &mut pic.u } else { &mut pic.v };
                        for r in 0..8 {
                            let bs = bs_v[luma_e][r / 2];
                            if bs == 0 {
                                continue;
                            }
                            let tc0 = if bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 };
                            let o = cybase + r * cw + e - 2;
                            let s: &mut [u8; 4] = (&mut plane[o..o + 4]).try_into().unwrap();
                            chroma_line(s, bs, alpha, beta, tc0);
                        }
                    }
                    if double_top {
                        for j in 0..2 {
                            let nb = mbs[(2 * pr - 2 + j) * wm + mx];
                            let (alpha, beta, tc0s) = thresholds(nb.qpc[comp], cur.qpc[comp], &cur);
                            let plane = if comp == 0 { &mut pic.u } else { &mut pic.v };
                            let mut bs8 = [0u8; 8];
                            let mut tc8 = [0i32; 8];
                            for k in 0..4 {
                                let bs = double_bs[j][k];
                                bs8[k * 2..k * 2 + 2].fill(bs);
                                tc8[k * 2..k * 2 + 2].fill(tc0s[bs as usize - 1] as i32);
                            }
                            chroma_edge_h::<8>(plane, cybase + j * cwidth, 2 * cwidth, &bs8, &tc8, false, alpha, beta);
                        }
                    }
                    for &(e, luma_e) in &[(0usize, 0usize), (4, 2)] {
                        if (e == 0 && above_addr.is_none()) || bs_h[luma_e] == [0; 4] {
                            continue;
                        }
                        let qp_p = if e == 0 { mbs[above_addr.unwrap()].qpc[comp] } else { cur.qpc[comp] };
                        let (alpha, beta, tc0s) = thresholds(qp_p, cur.qpc[comp], &cur);
                        let plane = if comp == 0 { &mut pic.u } else { &mut pic.v };
                        let mut bs8 = [0u8; 8];
                        let mut tc8 = [0i32; 8];
                        for k in 0..4 {
                            let bs = bs_h[luma_e][k];
                            bs8[k * 2..k * 2 + 2].fill(bs);
                            tc8[k * 2..k * 2 + 2].fill(if bs != 0 && bs < 4 { tc0s[bs as usize - 1] as i32 } else { 0 });
                        }
                        chroma_edge_h::<8>(plane, cybase + e * cw, cw, &bs8, &tc8, bs_h[luma_e][0] == 4, alpha, beta);
                    }
                }
            }
        }
    }
}
