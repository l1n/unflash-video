//! The loop filter (8.8): superblocks in raster order, and in each the
//! vertical edges of a plane (left to right) and then its horizontal edges
//! (top to bottom), block and transform edges alike. The filter decisions
//! are the same for 8 consecutive samples along an edge (one 8x8 block of
//! the plane), so they are made once per such run.

use crate::frame::{FrameBuf, Pixel};
use crate::header::{FrameHeader, SEG_LVL_ALT_L};
use crate::tables::{MAX_TX_SIZE, NUM_8X8_HIGH, NUM_8X8_WIDE, UV_BLOCK_SIZE};
use crate::tile::{MiInfo, NEARESTMV, NEWMV};

const BLOCK_16X16: u8 = 6;

/// The filter strength of each segment, reference frame and mode type
/// (LvlLookup, 8.8.1), and the thresholds of each strength (8.8.4).
pub struct Levels {
    lvl: [[[u8; 2]; 4]; 8],
    /// limit, blimit, thresh by level
    limits: [(i32, i32, i32); 64],
}

impl Levels {
    pub fn new(fh: &FrameHeader) -> Levels {
        let lf = &fh.lf;
        let level = lf.level as i32;
        let scale = 1 << (level >> 5);
        let mut lvl = [[[0u8; 2]; 4]; 8];
        for (seg, l) in lvl.iter_mut().enumerate() {
            let mut lvl_seg = level;
            if fh.seg.active(seg as u8, SEG_LVL_ALT_L) {
                let data = fh.seg.data(seg as u8, SEG_LVL_ALT_L);
                lvl_seg = (if fh.seg.abs_delta { data } else { level + data }).clamp(0, 63);
            }
            if !lf.delta_enabled {
                *l = [[lvl_seg as u8; 2]; 4];
            } else {
                l[0][0] = (lvl_seg + lf.ref_deltas[0] as i32 * scale).clamp(0, 63) as u8;
                for rf in 1..4 {
                    for mode in 0..2 {
                        l[rf][mode] = (lvl_seg + lf.ref_deltas[rf] as i32 * scale + lf.mode_deltas[mode] as i32 * scale).clamp(0, 63) as u8;
                    }
                }
            }
        }
        let sharp = lf.sharpness as i32;
        let shift = if sharp > 4 {
            2
        } else if sharp > 0 {
            1
        } else {
            0
        };
        let mut limits = [(0, 0, 0); 64];
        for (l, t) in limits.iter_mut().enumerate() {
            let l = l as i32;
            let limit = if sharp > 0 { (l >> shift).clamp(1, 9 - sharp) } else { (l >> shift).max(1) };
            *t = (limit, 2 * (l + 2) + limit, l >> 4);
        }
        Levels { lvl, limits }
    }

    #[inline]
    fn level(&self, m: &MiInfo) -> usize {
        let mode_type = (m.y_mode >= NEARESTMV && m.y_mode != crate::tile::ZEROMV && m.y_mode <= NEWMV) as usize;
        self.lvl[m.segment_id as usize & 7][m.ref_frame[0] as usize & 3][mode_type] as usize
    }
}

/// Filter the whole frame.
pub fn filter_frame<T: Pixel>(frame: &mut FrameBuf<T>, mi: &[MiInfo], mi_rows: usize, mi_cols: usize, levels: &Levels) {
    let bd = frame.bit_depth as u32;
    for row in (0..mi_rows).step_by(8) {
        for col in (0..mi_cols).step_by(8) {
            for (plane, p) in frame.planes.iter_mut().enumerate() {
                let stride = p.stride;
                for pass in 0..2 {
                    filter_superblock(&mut p.data, stride, mi, mi_rows, mi_cols, levels, plane, pass, row, col, bd);
                }
            }
        }
    }
}

/// The superblock loop filter process (8.8.2) for one plane and direction.
#[allow(clippy::too_many_arguments)]
fn filter_superblock<T: Pixel>(data: &mut [T], stride: usize, mi: &[MiInfo], mi_rows: usize, mi_cols: usize, levels: &Levels, plane: usize, pass: usize, row: usize, col: usize, bd: u32) {
    let s = (plane > 0) as usize;
    for edge in 0..16 >> s {
        for group in 0..(64 >> s) / 8 {
            // luma position of the run's first sample
            let (x, y) = if pass == 0 { (col * 8 + edge * (4 << s), row * 8 + ((group * 8) << s)) } else { (col * 8 + ((group * 8) << s), row * 8 + edge * (4 << s)) };
            if x >= 8 * mi_cols || y >= 8 * mi_rows || (pass == 0 && x == 0) || (pass == 1 && y == 0) {
                continue;
            }
            // the samples of the run inside the frame
            let count = if pass == 0 { (8 * mi_rows - y).div_ceil(1 << s) } else { (8 * mi_cols - x).div_ceil(1 << s) }.min(8);
            let loop_row = ((y >> 3) >> s) << s;
            let loop_col = ((x >> 3) >> s) << s;
            let m = &mi[loop_row * mi_cols + loop_col];
            let tx_size = if plane > 0 {
                if m.size < 3 {
                    0
                } else {
                    m.tx_size.min(MAX_TX_SIZE[UV_BLOCK_SIZE[m.size as usize] as usize])
                }
            } else {
                m.tx_size
            };
            let sb_size = if s == 0 { m.size } else { m.size.max(BLOCK_16X16) } as usize;
            let is_block_edge = if pass == 0 { x % (8 * NUM_8X8_WIDE[sb_size] as usize) == 0 } else { y % (8 * NUM_8X8_HIGH[sb_size] as usize) == 0 };
            // the chroma of the last (half-outside) column of a frame with
            // an odd number of 8x8 columns has no internal horizontal 4x4 edge
            let is_tx_edge = if pass == 1 && s == 1 && mi_cols & 1 == 1 && edge & 1 == 1 && x + 8 >= mi_cols * 8 { false } else { edge % (1 << tx_size) == 0 };
            let is_32_edge = edge % 8 == 0;
            let is_intra = m.ref_frame[0] == 0;
            if !(is_block_edge || (is_tx_edge && (is_intra || !m.skip))) {
                continue;
            }
            // the filter size process (8.8.3)
            let base_size = if tx_size == 0 && is_32_edge { 1 } else { tx_size.min(2) };
            let filter_size = if base_size == 2 && s == 1 && ((pass == 0 && x >> 3 == mi_cols - 1) || (pass == 1 && y >> 3 == mi_rows - 1)) { 1 } else { base_size };
            let lvl = levels.level(m);
            if lvl == 0 {
                continue;
            }
            let (limit, blimit, thresh) = levels.limits[lvl];
            let (px, py) = (x >> s, y >> s);
            let (start, along, across) = if pass == 0 { (py * stride + px, stride, 1) } else { (py * stride + px, 1, stride) };
            for k in 0..count {
                filter_sample(data, start + k * along, across, filter_size, limit, blimit, thresh, bd);
            }
        }
    }
}

/// The sample filtering process (8.8.5) across one edge: `pos` is q0 and
/// `step` the distance to the next sample away from the edge.
#[allow(clippy::too_many_arguments)]
#[inline]
fn filter_sample<T: Pixel>(d: &mut [T], pos: usize, step: usize, filter_size: u8, limit: i32, blimit: i32, thresh: i32, bd: u32) {
    let sh = bd - 8;
    let at = |d: &[T], k: isize| d[(pos as isize + k * step as isize) as usize].get();
    let (q0, q1, q2, q3) = (at(d, 0), at(d, 1), at(d, 2), at(d, 3));
    let (p0, p1, p2, p3) = (at(d, -1), at(d, -2), at(d, -3), at(d, -4));
    // the filter mask process (8.8.5.1)
    let limit = limit << sh;
    let blimit = blimit << sh;
    if (p3 - p2).abs() > limit || (p2 - p1).abs() > limit || (p1 - p0).abs() > limit || (q1 - q0).abs() > limit || (q2 - q1).abs() > limit || (q3 - q2).abs() > limit || (p0 - q0).abs() * 2 + (p1 - q1).abs() / 2 > blimit {
        return;
    }
    let thresh = thresh << sh;
    let hev = (p1 - p0).abs() > thresh || (q1 - q0).abs() > thresh;
    let one = 1 << sh;
    let flat = filter_size >= 1 && (p1 - p0).abs() <= one && (q1 - q0).abs() <= one && (p2 - p0).abs() <= one && (q2 - q0).abs() <= one && (p3 - p0).abs() <= one && (q3 - q0).abs() <= one;
    if !flat {
        narrow(d, pos, step, hev, bd, [p1, p0, q0, q1]);
        return;
    }
    if filter_size >= 2 {
        let (q4, q5, q6, q7) = (at(d, 4), at(d, 5), at(d, 6), at(d, 7));
        let (p4, p5, p6, p7) = (at(d, -5), at(d, -6), at(d, -7), at(d, -8));
        let flat2 = (p7 - p0).abs() <= one && (q7 - q0).abs() <= one && (p6 - p0).abs() <= one && (q6 - q0).abs() <= one && (p5 - p0).abs() <= one && (q5 - q0).abs() <= one && (p4 - p0).abs() <= one && (q4 - q0).abs() <= one;
        if flat2 {
            wide(d, pos, step, 4, &[p7, p6, p5, p4, p3, p2, p1, p0, q0, q1, q2, q3, q4, q5, q6, q7]);
            return;
        }
    }
    wide(d, pos, step, 3, &[p3, p3, p3, p3, p3, p2, p1, p0, q0, q1, q2, q3, q3, q3, q3, q3]);
}

/// The narrow filter (8.8.5.2): `s` is p1, p0, q0, q1.
#[inline]
fn narrow<T: Pixel>(d: &mut [T], pos: usize, step: usize, hev: bool, bd: u32, s: [i32; 4]) {
    let lo = -(1 << (bd - 1));
    let hi = (1 << (bd - 1)) - 1;
    let c = |v: i32| v.clamp(lo, hi);
    let off = 0x80 << (bd - 8);
    let (ps1, ps0, qs0, qs1) = (s[0] - off, s[1] - off, s[2] - off, s[3] - off);
    let mut filter = if hev { c(ps1 - qs1) } else { 0 };
    filter = c(filter + 3 * (qs0 - ps0));
    let filter1 = c(filter + 4) >> 3;
    let filter2 = c(filter + 3) >> 3;
    d[pos] = T::new(c(qs0 - filter1) + off);
    d[pos - step] = T::new(c(ps0 + filter2) + off);
    if !hev {
        let f = (filter1 + 1) >> 1;
        d[pos + step] = T::new(c(qs1 - f) + off);
        d[pos - 2 * step] = T::new(c(ps1 + f) + off);
    }
}

/// The wide filter (8.8.5.3) of 2^log2 taps: `s` holds p7..p0, q0..q7
/// (only p3..q3 matter for log2 = 3).
#[inline]
fn wide<T: Pixel>(d: &mut [T], pos: usize, step: usize, log2: u32, s: &[i32; 16]) {
    let n = (1i32 << (log2 - 1)) - 1;
    let at = |k: i32| s[(8 + k) as usize];
    let mut out = [0i32; 16];
    for i in -n..n {
        let mut t = at(i);
        for j in -n..=n {
            t += at((i + j).clamp(-(n + 1), n));
        }
        out[(8 + i) as usize] = (t + (1 << (log2 - 1))) >> log2;
    }
    for i in -n..n {
        d[(pos as isize + i as isize * step as isize) as usize] = T::new(out[(8 + i) as usize]);
    }
}
