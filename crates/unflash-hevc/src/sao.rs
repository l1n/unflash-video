//! Sample adaptive offset (8.7.3), applied per coding tree block to the
//! deblocked picture.

use crate::meta::{Meta, BYPASS, NO_SLICE, PCM};
use crate::picture::{Picture, Sample};
use crate::ps::{Layout, Pps, Sps};

/// hPos / vPos of the two neighbours per SaoEoClass (Table 8-13).
const EO: [[(i32, i32); 2]; 4] = [[(-1, 0), (1, 0)], [(0, -1), (0, 1)], [(-1, -1), (1, 1)], [(1, -1), (-1, 1)]];

/// Apply SAO to a deblocked picture; `src` is scratch space for a copy of
/// each plane (SAO reads the deblocked samples, not its own output).
pub fn sao<P: Sample>(pic: &mut Picture<P>, meta: &Meta, sps: &Sps, pps: &Pps, layout: &Layout, src: &mut Vec<P>) {
    let (wc, hc) = (layout.width_ctbs as i32, layout.height_ctbs as i32);
    let comps = if sps.chroma_format_idc != 0 { 3 } else { 1 };
    let excluded_flags = BYPASS | if sps.pcm_loop_filter_disabled { PCM } else { 0 };
    for c in 0..comps {
        if meta.sao.iter().all(|p| p.kind[c] == 0) {
            continue;
        }
        let sub = (c > 0) as u32;
        let bd = if c == 0 { sps.bit_depth } else { sps.bit_depth_chroma };
        let max = (1 << bd) - 1;
        let plane = &mut pic.planes[c];
        let (pw, ph, stride) = (plane.width as i32, plane.height as i32, plane.stride);
        src.clear();
        src.extend_from_slice(&plane.data);
        let ctb = (1i32 << sps.log2_ctb) >> sub;
        for ry in 0..hc {
            for rx in 0..wc {
                let rs = (ry * wc + rx) as usize;
                let p = &meta.sao[rs];
                if p.kind[c] == 0 {
                    continue;
                }
                let (x0, y0) = (rx * ctb, ry * ctb);
                let (w, h) = (ctb.min(pw - x0), ctb.min(ph - y0));
                // samples of lossless or unfiltered PCM blocks keep their values
                let excluded = |x: i32, y: i32| meta.flags[meta.at((x << sub) as usize, (y << sub) as usize)] & excluded_flags != 0;
                let any_excluded = excluded_flags != 0 && (0..h).step_by((4 >> sub) as usize).any(|j| (0..w).step_by((4 >> sub) as usize).any(|i| excluded(x0 + i, y0 + j)));
                let off = &p.offsets[c];
                if p.kind[c] == 1 {
                    let shift = bd - 5;
                    let band = p.class[c] as i32;
                    for j in 0..h {
                        for i in 0..w {
                            if any_excluded && excluded(x0 + i, y0 + j) {
                                continue;
                            }
                            let at = ((y0 + j) as usize) * stride + (x0 + i) as usize;
                            let v = src[at].get();
                            let k = ((v >> shift) - band) & 31;
                            if k < 4 {
                                plane.data[at] = P::new((v + off[k as usize] as i32).clamp(0, max));
                            }
                        }
                    }
                    continue;
                }
                // which of the eight neighbouring CTBs edge offsets may read
                let mut usable = [[false; 3]; 3];
                let cur_slice = meta.ctb_slice[rs];
                for (dy, row) in usable.iter_mut().enumerate() {
                    for (dx, u) in row.iter_mut().enumerate() {
                        let (nx, ny) = (rx + dx as i32 - 1, ry + dy as i32 - 1);
                        if nx < 0 || ny < 0 || nx >= wc || ny >= hc {
                            continue;
                        }
                        let nrs = (ny * wc + nx) as usize;
                        let ns = meta.ctb_slice[nrs];
                        if ns == NO_SLICE || cur_slice == NO_SLICE {
                            continue;
                        }
                        let (a, b) = (&meta.slices[cur_slice as usize], &meta.slices[ns as usize]);
                        if a.addr != b.addr {
                            // across a slice boundary: the later slice's flag decides
                            let later = if layout.rs_to_ts[nrs] < layout.rs_to_ts[rs] { a } else { b };
                            if !later.loop_filter_across_slices {
                                continue;
                            }
                        }
                        if !pps.loop_filter_across_tiles && layout.tile_id[nrs] != layout.tile_id[rs] {
                            continue;
                        }
                        *u = true;
                    }
                }
                let [(ax, ay), (bx, by)] = EO[p.class[c] as usize];
                let neighbour_ok = |x: i32, y: i32| -> bool {
                    if x < 0 || y < 0 || x >= pw || y >= ph {
                        return false;
                    }
                    let dx = if x < x0 { 0 } else if x >= x0 + ctb { 2 } else { 1 };
                    let dy = if y < y0 { 0 } else if y >= y0 + ctb { 2 } else { 1 };
                    usable[dy][dx]
                };
                for j in 0..h {
                    let y = y0 + j;
                    for i in 0..w {
                        let x = x0 + i;
                        if any_excluded && excluded(x, y) {
                            continue;
                        }
                        let (nax, nay, nbx, nby) = (x + ax, y + ay, x + bx, y + by);
                        let border = i == 0 || j == 0 || i == w - 1 || j == h - 1;
                        if border && !(neighbour_ok(nax, nay) && neighbour_ok(nbx, nby)) {
                            continue;
                        }
                        let at = y as usize * stride + x as usize;
                        let v = src[at].get();
                        let a = src[nay as usize * stride + nax as usize].get();
                        let b = src[nby as usize * stride + nbx as usize].get();
                        let edge = 2 + (v - a).signum() + (v - b).signum();
                        let k = match edge {
                            0 => 0,
                            1 => 1,
                            3 => 2,
                            4 => 3,
                            _ => continue,
                        };
                        plane.data[at] = P::new((v + off[k] as i32).clamp(0, max));
                    }
                }
            }
        }
    }
}
