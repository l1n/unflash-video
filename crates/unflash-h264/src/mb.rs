//! Slice data: macroblock parsing (7.3.4, 7.3.5) with both entropy coders,
//! and the reconstruction of each macroblock (8.3 – 8.5).

use std::rc::Rc;

use crate::bitreader::BitReader;
use crate::cabac::Cabac;
use crate::cavlc;
use crate::deblock::MbDeblockInfo;
use crate::inter;
use crate::intra::{self, Edges};
use crate::picture::{Picture, RefPic};
use crate::ps::{Pps, ScalingTables, Sps};
use crate::slice::{SliceHeader, SliceType};
use crate::tables::{CHROMA_QP, GOLOMB_TO_INTER_CBP, GOLOMB_TO_INTRA4X4_CBP, ZIGZAG4X4, ZIGZAG8X8};
use crate::transform;
use crate::{Error, Result};

/// blkIdx (the 4x4 luma block scan of the standard) -> position in the MB.
pub const BLK_X: [usize; 16] = [0, 4, 0, 4, 8, 12, 8, 12, 0, 4, 0, 4, 8, 12, 8, 12];
pub const BLK_Y: [usize; 16] = [0, 0, 4, 4, 0, 0, 4, 4, 8, 8, 12, 12, 8, 8, 12, 12];
/// blkIdx -> raster index (y/4 * 4 + x/4).
pub const BLK_RASTER: [usize; 16] = [0, 1, 4, 5, 2, 3, 6, 7, 8, 9, 12, 13, 10, 11, 14, 15];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum MbKind {
    #[default]
    None,
    I4x4,
    I8x8,
    I16x16,
    IPcm,
    PSkip,
    BSkip,
    BDirect16x16,
    Inter,
}

/// Everything later macroblocks (and the deblocking filter) need to know
/// about a decoded macroblock.
#[derive(Clone, Debug)]
pub struct MbInfo {
    /// 0 = not decoded
    pub slice: u32,
    pub kind: MbKind,
    pub intra: bool,
    pub skip: bool,
    pub transform8x8: bool,
    /// luma bits 0..3, chroma value << 4
    pub cbp: u8,
    pub qp: i8,
    pub qpc: [i8; 2],
    pub chroma_pred_mode: u8,
    /// intra 4x4 / 8x8 modes per 4x4 block (raster), 2 (DC) elsewhere
    pub intra_modes: [u8; 16],
    /// CAVLC coefficient counts per 4x4 luma block (raster) and chroma
    pub total_coeff: [u8; 16],
    pub total_coeff_c: [[u8; 4]; 2],
    /// coded_block_flags: bits 0..16 luma 4x4 (raster), 16..20 Cb AC,
    /// 20..24 Cr AC, 24 luma DC, 25 Cb DC, 26 Cr DC
    pub cbf: u32,
    /// per 4x4 luma block (raster): non-zero coefficients (deblocking)
    pub nonzero: u16,
    /// motion vector differences per list per 4x4 block (raster)
    pub mvd: [[[i16; 2]; 16]; 2],
    pub qp_delta_nonzero: bool,
    /// per list per 8x8: refIdx > 0 in a non-direct partition
    pub ref_ctx: [[bool; 4]; 2],
}

impl Default for MbInfo {
    fn default() -> Self {
        MbInfo {
            slice: 0,
            kind: MbKind::None,
            intra: false,
            skip: false,
            transform8x8: false,
            cbp: 0,
            qp: 0,
            qpc: [0; 2],
            chroma_pred_mode: 0,
            intra_modes: [2; 16],
            total_coeff: [0; 16],
            total_coeff_c: [[0; 4]; 2],
            cbf: 0,
            nonzero: 0,
            mvd: [[[0; 2]; 16]; 2],
            qp_delta_nonzero: false,
            ref_ctx: [[false; 4]; 2],
        }
    }
}

pub enum Entropy<'a> {
    Cavlc(BitReader<'a>),
    Cabac(Cabac<'a>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Shape {
    P16x16,
    P16x8,
    P8x16,
    P8x8,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SubShape {
    S8x8,
    S8x4,
    S4x8,
    S4x4,
}

/// The parsed prediction data of an inter macroblock.
#[derive(Clone, Copy, Debug)]
struct InterParse {
    shape: Shape,
    /// per partition (up to 4): uses list 0 / list 1
    pred: [[bool; 2]; 4],
    /// per 8x8 (only for P8x8): sub-partition shape, direct
    sub_shape: [SubShape; 4],
    sub_direct: [bool; 4],
    ref_idx: [[i8; 4]; 2],
    /// per list, per partition, per sub-partition (up to 4)
    mvd: [[[[i32; 2]; 4]; 4]; 2],
}

/// The state of one slice being decoded.
pub struct SliceDecoder<'a> {
    pub sps: &'a Sps,
    pub pps: &'a Pps,
    pub scaling: &'a ScalingTables,
    pub hdr: &'a SliceHeader,
    pub lists: &'a [Vec<RefPic>; 2],
    pub slice_id: u32,
    pub entropy: Entropy<'a>,
    pub qp: i32,
    /// picture-wide per-macroblock info
    pub mbs: &'a mut [MbInfo],
    pub deblock: &'a mut [MbDeblockInfo],
    pub pic: &'a mut Picture,
    pub poc: i32,
    /// the co-located picture for direct prediction (RefPicList1[0])
    col: Option<Rc<Picture>>,
    /// implicit bipred weights [ref0][ref1] -> (w0, w1)
    implicit: Vec<Vec<(i32, i32)>>,
    prev_qp_delta_nonzero: bool,
    /// per list: 4x4 blocks of the current MB whose motion is decided
    /// 4x4 blocks of the current MB whose partition is decoded (its motion
    /// for both lists is final): available neighbours for prediction
    done: u16,
    width_mbs: usize,
    height_mbs: usize,
    // current MB
    mb_addr: usize,
    mx: usize,
    my: usize,
    cur: MbInfo,
}

fn chroma_qp(qp: i32, offset: i32) -> i32 {
    CHROMA_QP[(qp + offset).clamp(0, 51) as usize] as i32
}

impl<'a> SliceDecoder<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sps: &'a Sps,
        pps: &'a Pps,
        scaling: &'a ScalingTables,
        hdr: &'a SliceHeader,
        lists: &'a [Vec<RefPic>; 2],
        slice_id: u32,
        entropy: Entropy<'a>,
        mbs: &'a mut [MbInfo],
        deblock: &'a mut [MbDeblockInfo],
        pic: &'a mut Picture,
        poc: i32,
    ) -> SliceDecoder<'a> {
        let col = if hdr.slice_type == SliceType::B { lists[1].first().map(|r| r.pic.clone()) } else { None };
        let mut implicit = Vec::new();
        if hdr.slice_type == SliceType::B && pps.weighted_bipred_idc == 2 {
            for r0 in &lists[0] {
                let mut row = Vec::new();
                for r1 in &lists[1] {
                    let w = match inter::dist_scale_factor(poc, r0.poc, r1.poc) {
                        Some(dsf) if !r0.long_term && !r1.long_term && (-64..=128).contains(&(dsf >> 2)) => (64 - (dsf >> 2), dsf >> 2),
                        _ => (32, 32),
                    };
                    row.push(w);
                }
                implicit.push(row);
            }
        }
        SliceDecoder {
            sps,
            pps,
            scaling,
            hdr,
            lists,
            slice_id,
            entropy,
            qp: hdr.slice_qp,
            mbs,
            deblock,
            pic,
            poc,
            col,
            implicit,
            prev_qp_delta_nonzero: false,
            done: 0,
            width_mbs: sps.width_mbs as usize,
            height_mbs: sps.height_mbs as usize,
            mb_addr: 0,
            mx: 0,
            my: 0,
            cur: MbInfo::default(),
        }
    }

    fn is_cabac(&self) -> bool {
        matches!(self.entropy, Entropy::Cabac(_))
    }

    /// 7.3.4: decode the slice's macroblocks. Returns the number decoded.
    pub fn decode(&mut self) -> Result<usize> {
        let total = self.width_mbs * self.height_mbs;
        let mut addr = self.hdr.first_mb as usize;
        let mut count = 0;
        let slice_type = self.hdr.slice_type;
        let mut skip_run: i32 = -1;
        loop {
            if addr >= total {
                return Err(Error::Bitstream("slice runs past the end of the picture"));
            }
            if self.mbs[addr].slice != 0 {
                return Err(Error::Bitstream("macroblock coded twice"));
            }
            self.begin_mb(addr);
            let mut skip = false;
            if slice_type != SliceType::I {
                match &mut self.entropy {
                    Entropy::Cavlc(r) => {
                        // mb_skip_run precedes every coded macroblock; after
                        // the run (skip_run reaches 0) the next MB is coded
                        if skip_run < 0 {
                            skip_run = r.ue()? as i32;
                        }
                        if skip_run > 0 {
                            skip = true;
                            skip_run -= 1;
                        } else {
                            skip_run = -1;
                        }
                    }
                    Entropy::Cabac(_) => {
                        let inc = self.skip_ctx_inc();
                        if let Entropy::Cabac(c) = &mut self.entropy {
                            skip = c.mb_skip_flag(slice_type == SliceType::B, inc);
                        }
                    }
                }
            }
            if skip {
                self.decode_skip()?;
            } else {
                self.macroblock_layer()?;
            }
            self.finish_mb();
            count += 1;
            addr += 1;
            // more data?
            let more = match &mut self.entropy {
                Entropy::Cavlc(r) => {
                    if skip_run > 0 {
                        true
                    } else {
                        // after a run (skip_run == 0, the next MB is coded) or a
                        // coded MB (skip_run == -1, a new run is read next)
                        r.more_rbsp_data()
                    }
                }
                Entropy::Cabac(c) => !c.end_of_slice(),
            };
            if !more {
                break;
            }
        }
        Ok(count)
    }

    fn begin_mb(&mut self, addr: usize) {
        self.mb_addr = addr;
        self.mx = addr % self.width_mbs;
        self.my = addr / self.width_mbs;
        self.cur = MbInfo { slice: self.slice_id, ..Default::default() };
        self.done = 0;
        // clear the motion field of this MB
        let w4 = self.pic.width / 4;
        for by in 0..4 {
            for bx in 0..4 {
                let b = (self.my * 4 + by) * w4 + self.mx * 4 + bx;
                for l in 0..2 {
                    self.pic.mv[l][b] = [0, 0];
                    self.pic.ref_idx[l][b] = -1;
                    self.pic.ref_id[l][b] = -1;
                    self.pic.ref_poc[l][b] = 0;
                    self.pic.ref_long[l][b] = false;
                }
            }
        }
    }

    fn finish_mb(&mut self) {
        let cur = &self.cur;
        let addr = self.mb_addr;
        self.pic.mb_intra[addr] = cur.intra;
        self.deblock[addr] = MbDeblockInfo {
            decoded: true,
            intra: cur.intra,
            transform8x8: cur.transform8x8,
            qp: if cur.kind == MbKind::IPcm { 0 } else { cur.qp as i32 },
            qpc: if cur.kind == MbKind::IPcm { [chroma_qp(0, self.pps.chroma_qp_index_offset[0]), chroma_qp(0, self.pps.chroma_qp_index_offset[1])] } else { [cur.qpc[0] as i32, cur.qpc[1] as i32] },
            nonzero: cur.nonzero,
            slice: self.slice_id,
            filter_idc: self.hdr.disable_deblocking_filter_idc as u8,
            alpha_offset: self.hdr.alpha_offset,
            beta_offset: self.hdr.beta_offset,
        };
        self.prev_qp_delta_nonzero = cur.qp_delta_nonzero;
        self.mbs[addr] = self.cur.clone();
    }

    // ---- neighbours -----------------------------------------------------------

    fn mb_avail(&self, dx: i32, dy: i32) -> Option<usize> {
        let x = self.mx as i32 + dx;
        let y = self.my as i32 + dy;
        if x < 0 || y < 0 || x >= self.width_mbs as i32 || y >= self.height_mbs as i32 {
            return None;
        }
        let addr = y as usize * self.width_mbs + x as usize;
        if self.mbs[addr].slice == self.slice_id && addr != self.mb_addr {
            Some(addr)
        } else {
            None
        }
    }

    fn left(&self) -> Option<&MbInfo> {
        self.mb_avail(-1, 0).map(|a| &self.mbs[a])
    }
    fn above(&self) -> Option<&MbInfo> {
        self.mb_avail(0, -1).map(|a| &self.mbs[a])
    }

    fn skip_ctx_inc(&self) -> usize {
        let a = self.left().map_or(0, |m| (!m.skip) as usize);
        let b = self.above().map_or(0, |m| (!m.skip) as usize);
        a + b
    }

    /// The MB info of the neighbouring 4x4 luma block at (x, y) relative
    /// to the current MB, plus its raster index there, when available.
    fn nb_block(&self, x: i32, y: i32) -> Option<(&MbInfo, usize)> {
        let (dx, xx) = if x < 0 { (-1, x + 16) } else { (0, x) };
        let (dy, yy) = if y < 0 { (-1, y + 16) } else { (0, y) };
        if dx == 0 && dy == 0 {
            return Some((&self.cur, (yy as usize / 4) * 4 + xx as usize / 4));
        }
        let addr = self.mb_avail(dx, dy)?;
        Some((&self.mbs[addr], (yy as usize / 4) * 4 + xx as usize / 4))
    }

    /// The same for a 4x4 chroma block (x, y in chroma samples, 8x8 MB).
    fn nb_chroma_block(&self, x: i32, y: i32) -> Option<(&MbInfo, usize)> {
        let (dx, xx) = if x < 0 { (-1, x + 8) } else { (0, x) };
        let (dy, yy) = if y < 0 { (-1, y + 8) } else { (0, y) };
        if dx == 0 && dy == 0 {
            return Some((&self.cur, (yy as usize / 4) * 2 + xx as usize / 4));
        }
        let addr = self.mb_avail(dx, dy)?;
        Some((&self.mbs[addr], (yy as usize / 4) * 2 + xx as usize / 4))
    }

    // ---- skipped macroblocks ------------------------------------------------------

    fn decode_skip(&mut self) -> Result<()> {
        self.cur.skip = true;
        self.cur.qp = self.qp as i8;
        self.set_chroma_qp();
        if self.hdr.slice_type == SliceType::P {
            self.cur.kind = MbKind::PSkip;
            let mv = self.p_skip_mv();
            self.set_motion(0, 0, 0, 16, 16, 0, mv);
            self.mark_done(0, 0, 16, 16);
            self.predict_inter_block(0, 0, 16, 16, [Some(0), None], [mv, [0, 0]]);
        } else {
            self.cur.kind = MbKind::BSkip;
            self.direct_all()?;
        }
        Ok(())
    }

    // ---- macroblock_layer -----------------------------------------------------------

    fn macroblock_layer(&mut self) -> Result<()> {
        let slice_type = self.hdr.slice_type;
        // mb_type
        let raw = match &mut self.entropy {
            Entropy::Cavlc(r) => r.ue()?,
            Entropy::Cabac(_) => {
                let v = match slice_type {
                    SliceType::I => {
                        let inc = self.left().map_or(0, |m| (m.kind != MbKind::I4x4 && m.kind != MbKind::I8x8) as usize) + self.above().map_or(0, |m| (m.kind != MbKind::I4x4 && m.kind != MbKind::I8x8) as usize);
                        if let Entropy::Cabac(c) = &mut self.entropy {
                            c.mb_type_i(inc)
                        } else {
                            unreachable!()
                        }
                    }
                    SliceType::P => {
                        if let Entropy::Cabac(c) = &mut self.entropy {
                            c.mb_type_p()
                        } else {
                            unreachable!()
                        }
                    }
                    SliceType::B => {
                        let inc = self.left().map_or(0, |m| (m.kind != MbKind::BSkip && m.kind != MbKind::BDirect16x16) as usize) + self.above().map_or(0, |m| (m.kind != MbKind::BSkip && m.kind != MbKind::BDirect16x16) as usize);
                        if let Entropy::Cabac(c) = &mut self.entropy {
                            c.mb_type_b(inc)
                        } else {
                            unreachable!()
                        }
                    }
                };
                v
            }
        };
        // split into intra / inter types
        let intra_offset = match slice_type {
            SliceType::I => 0,
            SliceType::P => 5,
            SliceType::B => 23,
        };
        if raw >= intra_offset {
            let itype = raw - intra_offset;
            if itype > 25 {
                return Err(Error::Bitstream("bad intra mb_type"));
            }
            return self.intra_mb(itype);
        }
        if slice_type == SliceType::P {
            if raw > 4 {
                return Err(Error::Bitstream("bad P mb_type"));
            }
            self.inter_mb_p(raw)
        } else {
            self.inter_mb_b(raw)
        }
    }

    fn set_chroma_qp(&mut self) {
        let qp = self.cur.qp as i32;
        self.cur.qpc = [chroma_qp(qp, self.pps.chroma_qp_index_offset[0]) as i8, chroma_qp(qp, self.pps.chroma_qp_index_offset[1]) as i8];
    }

    // ---- intra macroblocks ----------------------------------------------------------

    fn intra_mb(&mut self, itype: u32) -> Result<()> {
        self.cur.intra = true;
        if itype == 25 {
            return self.pcm_mb();
        }
        if itype == 0 {
            // I_NxN
            let mut t8 = false;
            if self.pps.transform_8x8_mode {
                t8 = match &mut self.entropy {
                    Entropy::Cavlc(r) => r.flag()?,
                    Entropy::Cabac(_) => {
                        let inc = self.left().map_or(0, |m| m.transform8x8 as usize) + self.above().map_or(0, |m| m.transform8x8 as usize);
                        if let Entropy::Cabac(c) = &mut self.entropy {
                            c.transform_size_8x8_flag(inc)
                        } else {
                            unreachable!()
                        }
                    }
                };
            }
            self.cur.transform8x8 = t8;
            self.cur.kind = if t8 { MbKind::I8x8 } else { MbKind::I4x4 };
            // prediction modes
            let n = if t8 { 4 } else { 16 };
            let mut modes = [0u8; 16];
            for i in 0..n {
                let (prev, rem) = match &mut self.entropy {
                    Entropy::Cavlc(r) => {
                        let prev = r.flag()?;
                        let rem = if prev { 0 } else { r.u(3)? };
                        (prev, rem)
                    }
                    Entropy::Cabac(c) => {
                        let prev = c.prev_intra_pred_mode_flag();
                        let rem = if prev { 0 } else { c.rem_intra_pred_mode() };
                        (prev, rem)
                    }
                };
                // predicted mode from the neighbouring blocks (8.3.1.1 / 8.3.2.1)
                let (bx, by) = if t8 { ((i % 2) * 8, (i / 2) * 8) } else { (BLK_X[i], BLK_Y[i]) };
                let pred = {
                    let mode_of = |nb: Option<(&MbInfo, usize)>| -> Option<u32> {
                        match nb {
                            None => None,
                            Some((m, blk)) => {
                                if !m.intra && self.pps.constrained_intra_pred {
                                    None
                                } else if m.kind == MbKind::I4x4 || m.kind == MbKind::I8x8 {
                                    Some(m.intra_modes[blk] as u32)
                                } else {
                                    Some(2)
                                }
                            }
                        }
                    };
                    let a = mode_of(self.nb_block(bx as i32 - 1, by as i32));
                    let b = mode_of(self.nb_block(bx as i32, by as i32 - 1));
                    match (a, b) {
                        (Some(a), Some(b)) => a.min(b),
                        _ => 2,
                    }
                };
                let mode = if prev {
                    pred
                } else if rem < pred {
                    rem
                } else {
                    rem + 1
                };
                if t8 {
                    for dy in 0..2 {
                        for dx in 0..2 {
                            modes[(by / 4 + dy) * 4 + bx / 4 + dx] = mode as u8;
                        }
                    }
                } else {
                    modes[BLK_RASTER[i]] = mode as u8;
                }
                // the current MB's modes must be visible to the next block's prediction
                self.cur.intra_modes = modes;
            }
            self.cur.intra_modes = modes;
        } else {
            self.cur.kind = MbKind::I16x16;
            self.cur.intra_modes = [2; 16];
        }
        // intra_chroma_pred_mode
        let cpm = match &mut self.entropy {
            Entropy::Cavlc(r) => r.ue_max(3, "intra_chroma_pred_mode")?,
            Entropy::Cabac(_) => {
                let inc = self.left().map_or(0, |m| (m.intra && m.kind != MbKind::IPcm && m.chroma_pred_mode != 0) as usize) + self.above().map_or(0, |m| (m.intra && m.kind != MbKind::IPcm && m.chroma_pred_mode != 0) as usize);
                if let Entropy::Cabac(c) = &mut self.entropy {
                    c.intra_chroma_pred_mode(inc)
                } else {
                    unreachable!()
                }
            }
        };
        self.cur.chroma_pred_mode = cpm as u8;
        // coded_block_pattern
        let i16_mode;
        if itype == 0 {
            i16_mode = 0;
            let cbp = self.parse_cbp(true)?;
            self.cur.cbp = cbp;
        } else {
            i16_mode = (itype - 1) % 4;
            let chroma = ((itype - 1) / 4) % 3;
            let luma = if itype >= 13 { 15 } else { 0 };
            self.cur.cbp = luma | (chroma << 4) as u8;
        }
        // mb_qp_delta and residual
        let has_residual = self.cur.cbp != 0 || itype != 0;
        self.qp_delta(has_residual)?;
        let mut coeffs = Coeffs::default();
        if has_residual {
            self.residual(&mut coeffs)?;
        }
        // reconstruction
        if itype == 0 {
            if self.cur.transform8x8 {
                self.recon_intra8x8(&coeffs);
            } else {
                self.recon_intra4x4(&coeffs);
            }
        } else {
            self.recon_intra16x16(i16_mode, &coeffs);
        }
        self.recon_chroma_intra(cpm, &coeffs);
        Ok(())
    }

    fn pcm_mb(&mut self) -> Result<()> {
        self.cur.kind = MbKind::IPcm;
        self.cur.cbp = 0x2f;
        self.cur.qp = self.qp as i8;
        self.set_chroma_qp();
        self.cur.total_coeff = [16; 16];
        self.cur.total_coeff_c = [[16; 4]; 2];
        self.cur.cbf = 0x7ff_ffff;
        self.cur.nonzero = 0xffff;
        self.cur.intra_modes = [2; 16];
        let mut samples = [0u8; 384];
        match &mut self.entropy {
            Entropy::Cavlc(r) => {
                r.byte_align();
                for s in samples.iter_mut() {
                    *s = r.u(8)? as u8;
                }
            }
            Entropy::Cabac(c) => {
                let pos = (c.bit_pos() + 7) / 8;
                let data = c.data();
                if pos + 384 > data.len() {
                    return Err(Error::Bitstream("truncated PCM samples"));
                }
                samples.copy_from_slice(&data[pos..pos + 384]);
                c.restart(pos + 384)?;
            }
        }
        let (x0, y0) = (self.mx * 16, self.my * 16);
        let w = self.pic.width;
        for y in 0..16 {
            self.pic.y[(y0 + y) * w + x0..(y0 + y) * w + x0 + 16].copy_from_slice(&samples[y * 16..y * 16 + 16]);
        }
        let cw = w / 2;
        let (cx0, cy0) = (self.mx * 8, self.my * 8);
        for y in 0..8 {
            self.pic.u[(cy0 + y) * cw + cx0..(cy0 + y) * cw + cx0 + 8].copy_from_slice(&samples[256 + y * 8..256 + y * 8 + 8]);
            self.pic.v[(cy0 + y) * cw + cx0..(cy0 + y) * cw + cx0 + 8].copy_from_slice(&samples[320 + y * 8..320 + y * 8 + 8]);
        }
        Ok(())
    }

    // ---- coded_block_pattern and mb_qp_delta ----------------------------------------------

    fn parse_cbp(&mut self, intra: bool) -> Result<u8> {
        match &mut self.entropy {
            Entropy::Cavlc(r) => {
                let code = r.ue_max(47, "coded_block_pattern")? as usize;
                Ok(if intra { GOLOMB_TO_INTRA4X4_CBP[code] } else { GOLOMB_TO_INTER_CBP[code] })
            }
            Entropy::Cabac(_) => {
                // luma: condTermFlagN = 0 when the neighbouring 8x8 block is coded (or the MB is unavailable / PCM)
                let left = self.left().map(|m| (m.kind, m.cbp));
                let above = self.above().map(|m| (m.kind, m.cbp));
                let cond = |nb: Option<(MbKind, u8)>, bit: u32| -> usize {
                    match nb {
                        None => 0,
                        Some((MbKind::IPcm, _)) => 0,
                        Some((kind, cbp)) => {
                            if kind == MbKind::PSkip || kind == MbKind::BSkip {
                                1
                            } else if (cbp >> bit) & 1 != 0 {
                                0
                            } else {
                                1
                            }
                        }
                    }
                };
                let luma_inc = move |b8: usize, prior: u32| -> usize {
                    let a = match b8 {
                        0 => cond(left, 1),
                        2 => cond(left, 3),
                        1 => ((prior & 1) == 0) as usize,
                        _ => ((prior >> 2) & 1 == 0) as usize,
                    };
                    let b = match b8 {
                        0 => cond(above, 2),
                        1 => cond(above, 3),
                        2 => ((prior & 1) == 0) as usize,
                        _ => ((prior >> 1) & 1 == 0) as usize,
                    };
                    a + 2 * b
                };
                let chroma_cond = |nb: Option<(MbKind, u8)>, want2: bool| -> usize {
                    match nb {
                        None => 0,
                        Some((MbKind::PSkip, _)) | Some((MbKind::BSkip, _)) => 0,
                        Some((MbKind::IPcm, _)) => 1,
                        Some((_, cbp)) => {
                            let c = (cbp >> 4) & 3;
                            if want2 {
                                (c == 2) as usize
                            } else {
                                (c != 0) as usize
                            }
                        }
                    }
                };
                let chroma_inc = [chroma_cond(left, false) + 2 * chroma_cond(above, false), chroma_cond(left, true) + 2 * chroma_cond(above, true)];
                if let Entropy::Cabac(c) = &mut self.entropy {
                    Ok(c.coded_block_pattern(&luma_inc, chroma_inc) as u8)
                } else {
                    unreachable!()
                }
            }
        }
    }

    fn qp_delta(&mut self, present: bool) -> Result<()> {
        if present {
            let delta = match &mut self.entropy {
                Entropy::Cavlc(r) => r.se()?,
                Entropy::Cabac(c) => c.mb_qp_delta(self.prev_qp_delta_nonzero as usize)?,
            };
            if !(-26..=25).contains(&delta) {
                return Err(Error::Bitstream("mb_qp_delta out of range"));
            }
            self.qp = (self.qp + delta + 52) % 52;
            self.cur.qp_delta_nonzero = delta != 0;
        } else {
            self.cur.qp_delta_nonzero = false;
        }
        self.cur.qp = self.qp as i8;
        self.set_chroma_qp();
        Ok(())
    }

    // ---- residual parsing ----------------------------------------------------------------

    /// CAVLC nC for a luma 4x4 block at (x, y) in the MB (9.2.1).
    fn nc_luma(&self, x: usize, y: usize) -> i32 {
        let count = |nb: Option<(&MbInfo, usize)>| -> Option<i32> {
            nb.map(|(m, blk)| match m.kind {
                MbKind::PSkip | MbKind::BSkip => 0,
                MbKind::IPcm => 16,
                _ => m.total_coeff[blk] as i32,
            })
        };
        let a = count(self.nb_block(x as i32 - 1, y as i32));
        let b = count(self.nb_block(x as i32, y as i32 - 1));
        match (a, b) {
            (Some(a), Some(b)) => (a + b + 1) >> 1,
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => 0,
        }
    }

    fn nc_chroma(&self, comp: usize, x: usize, y: usize) -> i32 {
        let count = |nb: Option<(&MbInfo, usize)>| -> Option<i32> {
            nb.map(|(m, blk)| match m.kind {
                MbKind::PSkip | MbKind::BSkip => 0,
                MbKind::IPcm => 16,
                _ => m.total_coeff_c[comp][blk] as i32,
            })
        };
        let a = count(self.nb_chroma_block(x as i32 - 1, y as i32));
        let b = count(self.nb_chroma_block(x as i32, y as i32 - 1));
        match (a, b) {
            (Some(a), Some(b)) => (a + b + 1) >> 1,
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => 0,
        }
    }

    /// CABAC coded_block_flag ctxIdxInc for a block (9.3.3.1.1.9). `kind`:
    /// 0 luma DC, 1 luma 4x4 at (x, y), 2 chroma DC comp, 3 chroma AC comp at (x, y).
    fn cbf_inc(&self, kind: u32, comp: usize, x: usize, y: usize) -> usize {
        let cur_intra = self.cur.intra;
        let term = |nb: Option<(&MbInfo, usize)>| -> usize {
            match nb {
                None => cur_intra as usize,
                Some((m, blk)) => {
                    if m.kind == MbKind::IPcm {
                        return 1;
                    }
                    if m.kind == MbKind::PSkip || m.kind == MbKind::BSkip {
                        return 0;
                    }
                    match kind {
                        0 => {
                            if m.kind == MbKind::I16x16 {
                                ((m.cbf >> 24) & 1) as usize
                            } else {
                                0
                            }
                        }
                        1 => {
                            let b8 = (blk / 8) * 2 + (blk % 4) / 2;
                            if (m.cbp >> b8) & 1 == 0 {
                                0
                            } else if m.transform8x8 {
                                1
                            } else {
                                ((m.cbf >> blk) & 1) as usize
                            }
                        }
                        2 => {
                            if (m.cbp >> 4) & 3 != 0 {
                                ((m.cbf >> (25 + comp)) & 1) as usize
                            } else {
                                0
                            }
                        }
                        _ => {
                            if (m.cbp >> 4) & 3 == 2 {
                                ((m.cbf >> (16 + comp * 4 + blk)) & 1) as usize
                            } else {
                                0
                            }
                        }
                    }
                }
            }
        };
        let (a, b) = match kind {
            0 | 2 => (self.left().map(|m| (m, 0usize)), self.above().map(|m| (m, 0usize))),
            1 => (self.nb_block(x as i32 - 1, y as i32), self.nb_block(x as i32, y as i32 - 1)),
            _ => (self.nb_chroma_block(x as i32 - 1, y as i32), self.nb_chroma_block(x as i32, y as i32 - 1)),
        };
        term(a) + 2 * term(b)
    }

    /// One luma block through whichever entropy coder: returns TotalCoeff /
    /// the number of non-zero levels, filling `out` in scan order.
    fn luma_block(&mut self, x: usize, y: usize, cat: usize, start: usize, out: &mut [i32; 16]) -> Result<u8> {
        let raster = (y / 4) * 4 + x / 4;
        match &mut self.entropy {
            Entropy::Cavlc(_) => {
                let nc = self.nc_luma(x, y);
                let n = if let Entropy::Cavlc(r) = &mut self.entropy { cavlc::residual_block(r, nc, start, 15, out)? } else { unreachable!() };
                self.cur.total_coeff[raster] = n;
                if n != 0 {
                    self.cur.cbf |= 1 << raster;
                }
                Ok(n)
            }
            Entropy::Cabac(_) => {
                let inc = self.cbf_inc(1, 0, x, y);
                let c = if let Entropy::Cabac(c) = &mut self.entropy { c } else { unreachable!() };
                if !c.coded_block_flag(cat, inc) {
                    return Ok(0);
                }
                self.cur.cbf |= 1 << raster;
                let n = c.residual_block(cat, 16 - start, start, out)? as u8;
                self.cur.total_coeff[raster] = n;
                Ok(n)
            }
        }
    }

    /// 7.3.5.3: all residual blocks of the macroblock.
    fn residual(&mut self, co: &mut Coeffs) -> Result<()> {
        let cbp_luma = self.cur.cbp & 15;
        let cbp_chroma = (self.cur.cbp >> 4) & 3;
        let i16 = self.cur.kind == MbKind::I16x16;
        let t8 = self.cur.transform8x8;
        // luma DC of Intra16x16
        if i16 {
            let mut dc = [0i32; 16];
            match &mut self.entropy {
                Entropy::Cavlc(_) => {
                    let nc = self.nc_luma(0, 0);
                    if let Entropy::Cavlc(r) = &mut self.entropy {
                        cavlc::residual_block(r, nc, 0, 15, &mut dc)?;
                    }
                }
                Entropy::Cabac(_) => {
                    let inc = self.cbf_inc(0, 0, 0, 0);
                    if let Entropy::Cabac(c) = &mut self.entropy {
                        if c.coded_block_flag(0, inc) {
                            c.residual_block(0, 16, 0, &mut dc)?;
                            self.cur.cbf |= 1 << 24;
                        }
                    }
                }
            }
            for k in 0..16 {
                co.luma_dc[ZIGZAG4X4[k] as usize] = dc[k];
            }
        }
        // luma 4x4 / 8x8 blocks
        for b8 in 0..4 {
            let coded = (cbp_luma >> b8) & 1 != 0;
            if t8 && self.is_cabac() {
                if coded {
                    let x = (b8 % 2) * 8;
                    let y = (b8 / 2) * 8;
                    let mut blk = [0i32; 64];
                    let n = if let Entropy::Cabac(c) = &mut self.entropy { c.residual_block(5, 64, 0, &mut blk)? } else { unreachable!() };
                    for k in 0..64 {
                        co.luma8[b8][ZIGZAG8X8[k] as usize] = blk[k];
                    }
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let r = (y / 4 + dy) * 4 + x / 4 + dx;
                            self.cur.cbf |= 1 << r;
                            self.cur.total_coeff[r] = n.min(16) as u8;
                            if n > 0 {
                                self.cur.nonzero |= 1 << r;
                            }
                        }
                    }
                }
                continue;
            }
            for b4 in 0..4 {
                let blk_idx = b8 * 4 + b4;
                let (x, y) = (BLK_X[blk_idx], BLK_Y[blk_idx]);
                let raster = BLK_RASTER[blk_idx];
                if !coded {
                    continue;
                }
                let mut blk = [0i32; 16];
                let n = if i16 { self.luma_block(x, y, 1, 1, &mut blk)? } else { self.luma_block(x, y, 2, 0, &mut blk)? };
                if t8 {
                    // CAVLC 8x8: the four 4x4 blocks interleave into the 8x8 scan
                    for k in 0..16 {
                        co.luma8[b8][ZIGZAG8X8[4 * k + b4] as usize] = blk[k];
                    }
                    if n > 0 {
                        let bx = (b8 % 2) * 2;
                        let by = (b8 / 2) * 2;
                        for dy in 0..2 {
                            for dx in 0..2 {
                                self.cur.nonzero |= 1 << ((by + dy) * 4 + bx + dx);
                            }
                        }
                    }
                } else {
                    for k in 0..16 {
                        co.luma4[raster][ZIGZAG4X4[k] as usize] = blk[k];
                    }
                    if n > 0 {
                        self.cur.nonzero |= 1 << raster;
                    }
                }
            }
        }
        // chroma DC
        if cbp_chroma != 0 {
            for comp in 0..2 {
                let mut dc = [0i32; 16];
                match &mut self.entropy {
                    Entropy::Cavlc(r) => {
                        cavlc::residual_block(r, -1, 0, 3, &mut dc)?;
                    }
                    Entropy::Cabac(_) => {
                        let inc = self.cbf_inc(2, comp, 0, 0);
                        if let Entropy::Cabac(c) = &mut self.entropy {
                            if c.coded_block_flag(3, inc) {
                                c.residual_block(3, 4, 0, &mut dc)?;
                                self.cur.cbf |= 1 << (25 + comp);
                            }
                        }
                    }
                }
                co.chroma_dc[comp] = [dc[0], dc[1], dc[2], dc[3]];
            }
        }
        // chroma AC
        if cbp_chroma == 2 {
            for comp in 0..2 {
                for blk in 0..4 {
                    let (x, y) = ((blk % 2) * 4, (blk / 2) * 4);
                    let mut ac = [0i32; 16];
                    match &mut self.entropy {
                        Entropy::Cavlc(_) => {
                            let nc = self.nc_chroma(comp, x, y);
                            let n = if let Entropy::Cavlc(r) = &mut self.entropy { cavlc::residual_block(r, nc, 1, 15, &mut ac)? } else { unreachable!() };
                            self.cur.total_coeff_c[comp][blk] = n;
                            if n != 0 {
                                self.cur.cbf |= 1 << (16 + comp * 4 + blk);
                            }
                        }
                        Entropy::Cabac(_) => {
                            let inc = self.cbf_inc(3, comp, x, y);
                            if let Entropy::Cabac(c) = &mut self.entropy {
                                if c.coded_block_flag(4, inc) {
                                    self.cur.cbf |= 1 << (16 + comp * 4 + blk);
                                    let n = c.residual_block(4, 15, 1, &mut ac)? as u8;
                                    self.cur.total_coeff_c[comp][blk] = n;
                                }
                            }
                        }
                    }
                    for k in 1..16 {
                        co.chroma_ac[comp][blk][ZIGZAG4X4[k] as usize] = ac[k];
                    }
                }
            }
        }
        Ok(())
    }

    // ---- intra reconstruction ------------------------------------------------------------

    /// Whether the neighbouring MB's samples may be used for intra prediction.
    fn intra_avail(&self, dx: i32, dy: i32) -> bool {
        match self.mb_avail(dx, dy) {
            None => false,
            Some(addr) => !self.pps.constrained_intra_pred || self.mbs[addr].intra,
        }
    }

    fn luma_at(&self, x: i32, y: i32) -> u8 {
        let px = (self.mx as i32 * 16 + x) as usize;
        let py = (self.my as i32 * 16 + y) as usize;
        self.pic.y[py * self.pic.width + px]
    }

    fn chroma_at(&self, comp: usize, x: i32, y: i32) -> u8 {
        let px = (self.mx as i32 * 8 + x) as usize;
        let py = (self.my as i32 * 8 + y) as usize;
        let plane = if comp == 0 { &self.pic.u } else { &self.pic.v };
        plane[py * (self.pic.width / 2) + px]
    }

    /// Availability of the luma sample at (x, y) relative to the MB for
    /// intra prediction of a block whose 4x4 blocks decoded so far are in
    /// `done_blocks` (a raster bit mask).
    fn luma_sample_avail(&self, x: i32, y: i32, done_blocks: u16) -> bool {
        if x >= 0 && y >= 0 && x < 16 && y < 16 {
            return done_blocks & (1 << ((y / 4) * 4 + x / 4)) != 0;
        }
        if x >= 16 && y >= 0 {
            return false;
        }
        let dx = if x < 0 { -1 } else if x >= 16 { 1 } else { 0 };
        let dy = if y < 0 { -1 } else { 0 };
        self.intra_avail(dx, dy)
    }

    fn recon_intra4x4(&mut self, co: &Coeffs) {
        let w = self.pic.width;
        let mut done: u16 = 0;
        let qp = self.cur.qp as i32;
        let ls = &self.scaling.level4[(qp % 6) as usize][0];
        for blk_idx in 0..16 {
            let (bx, by) = (BLK_X[blk_idx] as i32, BLK_Y[blk_idx] as i32);
            let raster = BLK_RASTER[blk_idx];
            let mode = self.cur.intra_modes[raster] as u32;
            let mut above = [128u8; 8];
            let mut left = [128u8; 4];
            let avail_above = self.luma_sample_avail(bx, by - 1, done);
            let avail_left = self.luma_sample_avail(bx - 1, by, done);
            let avail_corner = self.luma_sample_avail(bx - 1, by - 1, done);
            let avail_ar = self.luma_sample_avail(bx + 4, by - 1, done);
            if avail_above {
                for i in 0..4 {
                    above[i] = self.luma_at(bx + i as i32, by - 1);
                }
                for i in 4..8 {
                    above[i] = if avail_ar { self.luma_at(bx + i as i32, by - 1) } else { above[3] };
                }
            }
            if avail_left {
                for i in 0..4 {
                    left[i] = self.luma_at(bx - 1, by + i as i32);
                }
            }
            let corner = if avail_corner { self.luma_at(bx - 1, by - 1) } else { 128 };
            let mut pred = [0u8; 16];
            intra::pred4x4(mode, &Edges { above: &above, left: &left, corner, avail_above, avail_left, avail_corner }, &mut pred);
            let x0 = self.mx * 16 + bx as usize;
            let y0 = self.my * 16 + by as usize;
            for y in 0..4 {
                self.pic.y[(y0 + y) * w + x0..(y0 + y) * w + x0 + 4].copy_from_slice(&pred[y * 4..y * 4 + 4]);
            }
            if self.cur.nonzero & (1 << raster) != 0 {
                let mut d = co.luma4[raster];
                transform::dequant4x4(&mut d, ls, qp, false);
                transform::idct4x4_add(&d, &mut self.pic.y[y0 * w + x0..], w);
            }
            done |= 1 << raster;
        }
    }

    fn recon_intra8x8(&mut self, co: &Coeffs) {
        let w = self.pic.width;
        let mut done: u16 = 0;
        let qp = self.cur.qp as i32;
        let ls = &self.scaling.level8[(qp % 6) as usize][0];
        for b8 in 0..4 {
            let (bx, by) = (((b8 % 2) * 8) as i32, ((b8 / 2) * 8) as i32);
            let mode = self.cur.intra_modes[(by as usize / 4) * 4 + bx as usize / 4] as u32;
            let mut above = [128u8; 16];
            let mut left = [128u8; 8];
            let avail_above = self.luma_sample_avail(bx, by - 1, done);
            let avail_left = self.luma_sample_avail(bx - 1, by, done);
            let avail_corner = self.luma_sample_avail(bx - 1, by - 1, done);
            let avail_ar = self.luma_sample_avail(bx + 8, by - 1, done);
            if avail_above {
                for i in 0..8 {
                    above[i] = self.luma_at(bx + i as i32, by - 1);
                }
                for i in 8..16 {
                    above[i] = if avail_ar { self.luma_at(bx + i as i32, by - 1) } else { above[7] };
                }
            }
            if avail_left {
                for i in 0..8 {
                    left[i] = self.luma_at(bx - 1, by + i as i32);
                }
            }
            let corner = if avail_corner { self.luma_at(bx - 1, by - 1) } else { 128 };
            let mut pred = [0u8; 64];
            intra::pred8x8(mode, &Edges { above: &above, left: &left, corner, avail_above, avail_left, avail_corner }, &mut pred);
            let x0 = self.mx * 16 + bx as usize;
            let y0 = self.my * 16 + by as usize;
            for y in 0..8 {
                self.pic.y[(y0 + y) * w + x0..(y0 + y) * w + x0 + 8].copy_from_slice(&pred[y * 8..y * 8 + 8]);
            }
            let r0 = (by as usize / 4) * 4 + bx as usize / 4;
            if self.cur.nonzero & (1 << r0) != 0 {
                let mut d = co.luma8[b8];
                transform::dequant8x8(&mut d, ls, qp);
                transform::idct8x8_add(&d, &mut self.pic.y[y0 * w + x0..], w);
            }
            done |= (3 << r0) | (3 << (r0 + 4));
        }
    }

    fn recon_intra16x16(&mut self, mode: u32, co: &Coeffs) {
        let w = self.pic.width;
        let avail_above = self.intra_avail(0, -1);
        let avail_left = self.intra_avail(-1, 0);
        let avail_corner = self.intra_avail(-1, -1);
        let mut above = [128u8; 16];
        let mut left = [128u8; 16];
        if avail_above {
            for i in 0..16 {
                above[i] = self.luma_at(i as i32, -1);
            }
        }
        if avail_left {
            for i in 0..16 {
                left[i] = self.luma_at(-1, i as i32);
            }
        }
        let corner = if avail_corner { self.luma_at(-1, -1) } else { 128 };
        let mut pred = [0u8; 256];
        intra::pred16x16(mode, &Edges { above: &above, left: &left, corner, avail_above, avail_left, avail_corner }, &mut pred);
        let x0 = self.mx * 16;
        let y0 = self.my * 16;
        for y in 0..16 {
            self.pic.y[(y0 + y) * w + x0..(y0 + y) * w + x0 + 16].copy_from_slice(&pred[y * 16..y * 16 + 16]);
        }
        self.add_luma_residual_i16(co);
    }

    fn add_luma_residual_i16(&mut self, co: &Coeffs) {
        let w = self.pic.width;
        let qp = self.cur.qp as i32;
        let ls = &self.scaling.level4[(qp % 6) as usize][0];
        let dc = transform::luma_dc(&co.luma_dc, ls[0], qp);
        let x0 = self.mx * 16;
        let y0 = self.my * 16;
        for raster in 0..16 {
            let (bx, by) = ((raster % 4) * 4, (raster / 4) * 4);
            let mut d = co.luma4[raster];
            let has_ac = self.cur.nonzero & (1 << raster) != 0;
            if has_ac {
                transform::dequant4x4(&mut d, ls, qp, true);
                d[0] = dc[raster];
                transform::idct4x4_add(&d, &mut self.pic.y[(y0 + by) * w + x0 + bx..], w);
            } else if dc[raster] != 0 {
                transform::idct4x4_dc_add(dc[raster], &mut self.pic.y[(y0 + by) * w + x0 + bx..], w);
            }
        }
    }

    fn recon_chroma_intra(&mut self, mode: u32, co: &Coeffs) {
        let avail_above = self.intra_avail(0, -1);
        let avail_left = self.intra_avail(-1, 0);
        let avail_corner = self.intra_avail(-1, -1);
        let cw = self.pic.width / 2;
        for comp in 0..2 {
            let mut above = [128u8; 8];
            let mut left = [128u8; 8];
            if avail_above {
                for i in 0..8 {
                    above[i] = self.chroma_at(comp, i as i32, -1);
                }
            }
            if avail_left {
                for i in 0..8 {
                    left[i] = self.chroma_at(comp, -1, i as i32);
                }
            }
            let corner = if avail_corner { self.chroma_at(comp, -1, -1) } else { 128 };
            let mut pred = [0u8; 64];
            intra::pred_chroma(mode, &Edges { above: &above, left: &left, corner, avail_above, avail_left, avail_corner }, &mut pred);
            let x0 = self.mx * 8;
            let y0 = self.my * 8;
            let plane = if comp == 0 { &mut self.pic.u } else { &mut self.pic.v };
            for y in 0..8 {
                plane[(y0 + y) * cw + x0..(y0 + y) * cw + x0 + 8].copy_from_slice(&pred[y * 8..y * 8 + 8]);
            }
        }
        self.add_chroma_residual(co);
    }

    fn add_chroma_residual(&mut self, co: &Coeffs) {
        let cw = self.pic.width / 2;
        let intra = self.cur.intra;
        let cbp_chroma = (self.cur.cbp >> 4) & 3;
        if cbp_chroma == 0 {
            return;
        }
        for comp in 0..2 {
            let qpc = self.cur.qpc[comp] as i32;
            let list = if intra { 1 + comp } else { 4 + comp };
            let ls = &self.scaling.level4[(qpc % 6) as usize][list];
            let dc = transform::chroma_dc(&co.chroma_dc[comp], ls[0], qpc);
            let x0 = self.mx * 8;
            let y0 = self.my * 8;
            let plane = if comp == 0 { &mut self.pic.u } else { &mut self.pic.v };
            for blk in 0..4 {
                let (bx, by) = ((blk % 2) * 4, (blk / 2) * 4);
                let has_ac = cbp_chroma == 2 && (self.cur.cbf >> (16 + comp * 4 + blk)) & 1 != 0;
                if has_ac {
                    let mut d = co.chroma_ac[comp][blk];
                    transform::dequant4x4(&mut d, ls, qpc, true);
                    d[0] = dc[blk];
                    transform::idct4x4_add(&d, &mut plane[(y0 + by) * cw + x0 + bx..], cw);
                } else if dc[blk] != 0 {
                    transform::idct4x4_dc_add(dc[blk], &mut plane[(y0 + by) * cw + x0 + bx..], cw);
                }
            }
        }
    }

    /// Inter luma residual (4x4 or 8x8 transform) added to the prediction.
    fn add_luma_residual_inter(&mut self, co: &Coeffs) {
        let w = self.pic.width;
        let qp = self.cur.qp as i32;
        let x0 = self.mx * 16;
        let y0 = self.my * 16;
        if self.cur.transform8x8 {
            let ls = &self.scaling.level8[(qp % 6) as usize][1];
            for b8 in 0..4 {
                let (bx, by) = ((b8 % 2) * 8, (b8 / 2) * 8);
                let r0 = (by / 4) * 4 + bx / 4;
                if self.cur.nonzero & (1 << r0) != 0 {
                    let mut d = co.luma8[b8];
                    transform::dequant8x8(&mut d, ls, qp);
                    transform::idct8x8_add(&d, &mut self.pic.y[(y0 + by) * w + x0 + bx..], w);
                }
            }
        } else {
            let ls = &self.scaling.level4[(qp % 6) as usize][3];
            for raster in 0..16 {
                if self.cur.nonzero & (1 << raster) != 0 {
                    let (bx, by) = ((raster % 4) * 4, (raster / 4) * 4);
                    let mut d = co.luma4[raster];
                    transform::dequant4x4(&mut d, ls, qp, false);
                    transform::idct4x4_add(&d, &mut self.pic.y[(y0 + by) * w + x0 + bx..], w);
                }
            }
        }
    }

    // ---- inter macroblocks ----------------------------------------------------------------

    fn inter_mb_p(&mut self, mb_type: u32) -> Result<()> {
        self.cur.kind = MbKind::Inter;
        let mut ip = InterParse {
            shape: match mb_type {
                0 => Shape::P16x16,
                1 => Shape::P16x8,
                2 => Shape::P8x16,
                _ => Shape::P8x8,
            },
            pred: [[true, false]; 4],
            sub_shape: [SubShape::S8x8; 4],
            sub_direct: [false; 4],
            ref_idx: [[0; 4]; 2],
            mvd: [[[[0; 2]; 4]; 4]; 2],
        };
        let ref0_only = mb_type == 4;
        if ip.shape == Shape::P8x8 {
            for b8 in 0..4 {
                let st = match &mut self.entropy {
                    Entropy::Cavlc(r) => r.ue_max(3, "sub_mb_type")?,
                    Entropy::Cabac(c) => c.sub_mb_type_p(),
                };
                ip.sub_shape[b8] = [SubShape::S8x8, SubShape::S8x4, SubShape::S4x8, SubShape::S4x4][st as usize];
            }
        }
        self.parse_refs_and_mvds(&mut ip, ref0_only)?;
        self.inter_predict(&ip)?;
        self.inter_residual(&ip)
    }

    fn inter_mb_b(&mut self, mb_type: u32) -> Result<()> {
        if mb_type == 0 {
            self.cur.kind = MbKind::BDirect16x16;
            self.direct_all()?;
            // B_Direct_16x16 still carries residual
            let cbp = self.parse_cbp(false)?;
            self.cur.cbp = cbp;
            if (cbp & 15) != 0 && self.pps.transform_8x8_mode && self.sps.direct_8x8_inference {
                self.cur.transform8x8 = self.parse_transform8x8()?;
            }
            self.qp_delta(cbp != 0)?;
            let mut co = Coeffs::default();
            if cbp != 0 {
                self.residual(&mut co)?;
            }
            self.add_luma_residual_inter(&co);
            self.add_chroma_residual(&co);
            return Ok(());
        }
        self.cur.kind = MbKind::Inter;
        let (shape, p0, p1): (Shape, [bool; 2], [bool; 2]) = match mb_type {
            1 => (Shape::P16x16, [true, false], [false, false]),
            2 => (Shape::P16x16, [false, true], [false, false]),
            3 => (Shape::P16x16, [true, true], [false, false]),
            4 => (Shape::P16x8, [true, false], [true, false]),
            5 => (Shape::P8x16, [true, false], [true, false]),
            6 => (Shape::P16x8, [false, true], [false, true]),
            7 => (Shape::P8x16, [false, true], [false, true]),
            8 => (Shape::P16x8, [true, false], [false, true]),
            9 => (Shape::P8x16, [true, false], [false, true]),
            10 => (Shape::P16x8, [false, true], [true, false]),
            11 => (Shape::P8x16, [false, true], [true, false]),
            12 => (Shape::P16x8, [true, false], [true, true]),
            13 => (Shape::P8x16, [true, false], [true, true]),
            14 => (Shape::P16x8, [false, true], [true, true]),
            15 => (Shape::P8x16, [false, true], [true, true]),
            16 => (Shape::P16x8, [true, true], [true, false]),
            17 => (Shape::P8x16, [true, true], [true, false]),
            18 => (Shape::P16x8, [true, true], [false, true]),
            19 => (Shape::P8x16, [true, true], [false, true]),
            20 => (Shape::P16x8, [true, true], [true, true]),
            21 => (Shape::P8x16, [true, true], [true, true]),
            22 => (Shape::P8x8, [false, false], [false, false]),
            _ => return Err(Error::Bitstream("bad B mb_type")),
        };
        let mut ip = InterParse { shape, pred: [p0, p1, [false; 2], [false; 2]], sub_shape: [SubShape::S8x8; 4], sub_direct: [false; 4], ref_idx: [[0; 4]; 2], mvd: [[[[0; 2]; 4]; 4]; 2] };
        if shape == Shape::P8x8 {
            for b8 in 0..4 {
                let st = match &mut self.entropy {
                    Entropy::Cavlc(r) => r.ue_max(12, "sub_mb_type")?,
                    Entropy::Cabac(c) => c.sub_mb_type_b(),
                };
                let (sh, pr, direct) = match st {
                    0 => (SubShape::S8x8, [false, false], true),
                    1 => (SubShape::S8x8, [true, false], false),
                    2 => (SubShape::S8x8, [false, true], false),
                    3 => (SubShape::S8x8, [true, true], false),
                    4 => (SubShape::S8x4, [true, false], false),
                    5 => (SubShape::S4x8, [true, false], false),
                    6 => (SubShape::S8x4, [false, true], false),
                    7 => (SubShape::S4x8, [false, true], false),
                    8 => (SubShape::S8x4, [true, true], false),
                    9 => (SubShape::S4x8, [true, true], false),
                    10 => (SubShape::S4x4, [true, false], false),
                    11 => (SubShape::S4x4, [false, true], false),
                    _ => (SubShape::S4x4, [true, true], false),
                };
                ip.sub_shape[b8] = sh;
                ip.pred[b8] = pr;
                ip.sub_direct[b8] = direct;
            }
        }
        self.parse_refs_and_mvds(&mut ip, false)?;
        self.inter_predict(&ip)?;
        self.inter_residual(&ip)
    }

    fn parse_transform8x8(&mut self) -> Result<bool> {
        match &mut self.entropy {
            Entropy::Cavlc(r) => r.flag(),
            Entropy::Cabac(_) => {
                let inc = self.left().map_or(0, |m| m.transform8x8 as usize) + self.above().map_or(0, |m| m.transform8x8 as usize);
                if let Entropy::Cabac(c) = &mut self.entropy {
                    Ok(c.transform_size_8x8_flag(inc))
                } else {
                    unreachable!()
                }
            }
        }
    }

    /// Partition geometry: (x, y, w, h) of partition `p` and sub-partition `s`.
    fn part_rect(ip: &InterParse, p: usize, s: usize) -> (usize, usize, usize, usize) {
        match ip.shape {
            Shape::P16x16 => (0, 0, 16, 16),
            Shape::P16x8 => (0, p * 8, 16, 8),
            Shape::P8x16 => (p * 8, 0, 8, 16),
            Shape::P8x8 => {
                let (x8, y8) = ((p % 2) * 8, (p / 2) * 8);
                match ip.sub_shape[p] {
                    SubShape::S8x8 => (x8, y8, 8, 8),
                    SubShape::S8x4 => (x8, y8 + s * 4, 8, 4),
                    SubShape::S4x8 => (x8 + s * 4, y8, 4, 8),
                    SubShape::S4x4 => (x8 + (s % 2) * 4, y8 + (s / 2) * 4, 4, 4),
                }
            }
        }
    }

    fn num_parts(ip: &InterParse) -> usize {
        match ip.shape {
            Shape::P16x16 => 1,
            Shape::P16x8 | Shape::P8x16 => 2,
            Shape::P8x8 => 4,
        }
    }

    fn num_sub(ip: &InterParse, p: usize) -> usize {
        if ip.shape != Shape::P8x8 {
            return 1;
        }
        match ip.sub_shape[p] {
            SubShape::S8x8 => 1,
            SubShape::S8x4 | SubShape::S4x8 => 2,
            SubShape::S4x4 => 4,
        }
    }

    /// 7.3.5.1 / 7.3.5.2: ref_idx_l0, ref_idx_l1, mvd_l0, mvd_l1.
    fn parse_refs_and_mvds(&mut self, ip: &mut InterParse, ref0_only: bool) -> Result<()> {
        let nparts = Self::num_parts(ip);
        for list in 0..2 {
            let n_active = self.hdr.num_ref_idx_active[list];
            for p in 0..nparts {
                if !ip.pred[p][list] || (ip.shape == Shape::P8x8 && ip.sub_direct[p]) {
                    continue;
                }
                if n_active <= 1 || ref0_only {
                    ip.ref_idx[list][p] = 0;
                    continue;
                }
                let r = match &mut self.entropy {
                    Entropy::Cavlc(r) => r.te(n_active - 1)?,
                    Entropy::Cabac(_) => {
                        let inc = self.ref_idx_ctx_inc(ip, list, p);
                        if let Entropy::Cabac(c) = &mut self.entropy {
                            c.ref_idx(inc)?
                        } else {
                            unreachable!()
                        }
                    }
                };
                if r >= n_active {
                    return Err(Error::Bitstream("ref_idx out of range"));
                }
                ip.ref_idx[list][p] = r as i8;
                // make the value visible to later contexts in this MB
                let b8 = match ip.shape {
                    Shape::P16x16 => [0, 1, 2, 3].to_vec(),
                    Shape::P16x8 => vec![p * 2, p * 2 + 1],
                    Shape::P8x16 => vec![p, p + 2],
                    Shape::P8x8 => vec![p],
                };
                for b in b8 {
                    self.cur.ref_ctx[list][b] = r > 0;
                }
            }
        }
        for list in 0..2 {
            for p in 0..nparts {
                if !ip.pred[p][list] || (ip.shape == Shape::P8x8 && ip.sub_direct[p]) {
                    continue;
                }
                for s in 0..Self::num_sub(ip, p) {
                    let (x, y, w, h) = Self::part_rect(ip, p, s);
                    for comp in 0..2 {
                        let v = match &mut self.entropy {
                            Entropy::Cavlc(r) => r.se()?,
                            Entropy::Cabac(_) => {
                                let sum = self.mvd_ctx_sum(list, comp, x, y);
                                if let Entropy::Cabac(c) = &mut self.entropy {
                                    c.mvd(comp, sum)?
                                } else {
                                    unreachable!()
                                }
                            }
                        };
                        if !(-8192..=8191).contains(&v) {
                            return Err(Error::Bitstream("mvd out of range"));
                        }
                        ip.mvd[list][p][s][comp] = v;
                        // record the mvd for the neighbouring contexts
                        for by in y / 4..(y + h) / 4 {
                            for bx in x / 4..(x + w) / 4 {
                                self.cur.mvd[list][by * 4 + bx][comp] = v as i16;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn ref_idx_ctx_inc(&self, ip: &InterParse, list: usize, p: usize) -> usize {
        let (x, y, _, _) = Self::part_rect(ip, p, 0);
        let term = |nb: Option<(&MbInfo, usize)>| -> usize {
            match nb {
                None => 0,
                Some((m, blk)) => {
                    if m.skip || m.intra {
                        0
                    } else {
                        let b8 = (blk / 8) * 2 + (blk % 4) / 2;
                        m.ref_ctx[list][b8] as usize
                    }
                }
            }
        };
        term(self.nb_block(x as i32 - 1, y as i32)) + 2 * term(self.nb_block(x as i32, y as i32 - 1))
    }

    fn mvd_ctx_sum(&self, list: usize, comp: usize, x: usize, y: usize) -> u32 {
        let abs = |nb: Option<(&MbInfo, usize)>| -> u32 {
            match nb {
                None => 0,
                Some((m, blk)) => {
                    if m.skip || m.intra {
                        0
                    } else {
                        m.mvd[list][blk][comp].unsigned_abs() as u32
                    }
                }
            }
        };
        abs(self.nb_block(x as i32 - 1, y as i32)) + abs(self.nb_block(x as i32, y as i32 - 1))
    }

    // ---- motion vector prediction ---------------------------------------------------------

    /// The motion data of the neighbouring 4x4 block at (x, y) relative to
    /// the current MB for list `list`: None when not available (as a
    /// partition), Some((-1, [0, 0])) when available but not predicted from
    /// that list. `w` is the width of the current partition, for the
    /// above-right test.
    fn nb_motion(&self, list: usize, x: i32, y: i32) -> Option<(i32, [i32; 2])> {
        let w4 = self.pic.width / 4;
        if x >= 0 && y >= 0 && x < 16 && y < 16 {
            let raster = (y as usize / 4) * 4 + x as usize / 4;
            if self.done & (1 << raster) == 0 {
                return None;
            }
            let b = (self.my * 4 + y as usize / 4) * w4 + self.mx * 4 + x as usize / 4;
            let r = self.pic.ref_idx[list][b] as i32;
            let mv = self.pic.mv[list][b];
            return Some((r, [mv[0] as i32, mv[1] as i32]));
        }
        if x >= 16 && y >= 0 {
            return None;
        }
        let dx = if x < 0 { -1 } else if x >= 16 { 1 } else { 0 };
        let dy = if y < 0 { -1 } else { 0 };
        let addr = self.mb_avail(dx, dy)?;
        if self.mbs[addr].intra {
            return Some((-1, [0, 0]));
        }
        let xx = (x + 16 * (dx == -1) as i32 - 16 * (dx == 1) as i32) as usize;
        let yy = (y + 16 * (dy == -1) as i32) as usize;
        let ay = addr / self.width_mbs;
        let ax = addr % self.width_mbs;
        let b = (ay * 4 + yy / 4) * w4 + ax * 4 + xx / 4;
        let r = self.pic.ref_idx[list][b] as i32;
        let mv = self.pic.mv[list][b];
        Some((r, [mv[0] as i32, mv[1] as i32]))
    }

    /// 8.4.1.3: the motion vector predictor of a partition at (x, y) of
    /// size w×h with reference index `ref_idx`. `dir` is the directional
    /// hint: 1 = 16x8 top, 2 = 16x8 bottom, 3 = 8x16 left, 4 = 8x16 right.
    fn mv_pred(&self, list: usize, ref_idx: i32, x: usize, y: usize, w: usize, h: usize, dir: u32) -> [i32; 2] {
        let (x, y, w, _h) = (x as i32, y as i32, w as i32, h as i32);
        let a = self.nb_motion(list, x - 1, y);
        let b = self.nb_motion(list, x, y - 1);
        let mut c = self.nb_motion(list, x + w, y - 1);
        if c.is_none() {
            c = self.nb_motion(list, x - 1, y - 1);
        }
        let unwrap = |n: Option<(i32, [i32; 2])>| n.unwrap_or((-1, [0, 0]));
        let (ra, mva) = unwrap(a);
        let (mut rb, mut mvb) = unwrap(b);
        let (mut rc, mut mvc) = unwrap(c);
        match dir {
            1 if rb == ref_idx => return mvb,
            2 if ra == ref_idx => return mva,
            3 if ra == ref_idx => return mva,
            4 if rc == ref_idx => return mvc,
            _ => {}
        }
        if b.is_none() && c.is_none() && a.is_some() {
            rb = ra;
            mvb = mva;
            rc = ra;
            mvc = mva;
        }
        let m = [ra == ref_idx, rb == ref_idx, rc == ref_idx];
        match (m[0], m[1], m[2]) {
            (true, false, false) => mva,
            (false, true, false) => mvb,
            (false, false, true) => mvc,
            _ => [median(mva[0], mvb[0], mvc[0]), median(mva[1], mvb[1], mvc[1])],
        }
    }

    /// 8.4.1.1: P_Skip motion.
    fn p_skip_mv(&self) -> [i32; 2] {
        let a = self.nb_motion(0, -1, 0);
        let b = self.nb_motion(0, 0, -1);
        match (a, b) {
            (None, _) | (_, None) => [0, 0],
            (Some((ra, mva)), Some((rb, mvb))) => {
                if (ra == 0 && mva == [0, 0]) || (rb == 0 && mvb == [0, 0]) {
                    [0, 0]
                } else {
                    self.mv_pred(0, 0, 0, 0, 16, 16, 0)
                }
            }
        }
    }

    /// Store the motion of a (sub)partition into the picture and the done mask.
    fn set_motion(&mut self, list: usize, x: usize, y: usize, w: usize, h: usize, ref_idx: i32, mv: [i32; 2]) {
        let w4 = self.pic.width / 4;
        let (id, poc, long) = if ref_idx >= 0 {
            let r = &self.lists[list][ref_idx as usize];
            (r.pic.id as i32, r.poc, r.long_term)
        } else {
            (-1, 0, false)
        };
        for by in y / 4..(y + h) / 4 {
            for bx in x / 4..(x + w) / 4 {
                let b = (self.my * 4 + by) * w4 + self.mx * 4 + bx;
                self.pic.ref_idx[list][b] = ref_idx as i8;
                self.pic.mv[list][b] = [mv[0].clamp(-32768, 32767) as i16, mv[1].clamp(-32768, 32767) as i16];
                self.pic.ref_id[list][b] = id;
                self.pic.ref_poc[list][b] = poc;
                self.pic.ref_long[list][b] = long;
            }
        }
    }

    /// The partition covering (x, y, w, h) is decoded: its blocks become
    /// available neighbours.
    fn mark_done(&mut self, x: usize, y: usize, w: usize, h: usize) {
        for by in y / 4..(y + h) / 4 {
            for bx in x / 4..(x + w) / 4 {
                self.done |= 1 << (by * 4 + bx);
            }
        }
    }

    /// Motion of the co-located block for direct prediction: (ref_idx in
    /// the col picture's list, mv, referenced picture id, list used) or
    /// None for an intra co-located block.
    fn col_motion(&self, x: usize, y: usize) -> Option<(i32, [i32; 2], i32, bool)> {
        let col = self.col.as_ref()?;
        let addr = self.my * self.width_mbs + self.mx;
        if col.mb_intra[addr] {
            return None;
        }
        // with direct_8x8_inference the corner 4x4 of the 8x8 stands for it
        let (bx, by) = if self.sps.direct_8x8_inference { ((x / 8) * 3, (y / 8) * 3) } else { (x / 4, y / 4) };
        let w4 = col.width / 4;
        let b = (self.my * 4 + by) * w4 + self.mx * 4 + bx;
        if col.ref_idx[0][b] >= 0 {
            let mv = col.mv[0][b];
            Some((col.ref_idx[0][b] as i32, [mv[0] as i32, mv[1] as i32], col.ref_id[0][b], col.ref_long[0][b]))
        } else if col.ref_idx[1][b] >= 0 {
            let mv = col.mv[1][b];
            Some((col.ref_idx[1][b] as i32, [mv[0] as i32, mv[1] as i32], col.ref_id[1][b], col.ref_long[1][b]))
        } else {
            None
        }
    }

    /// 8.4.1.2: direct prediction of the 8x8 block `b8` (all four for
    /// B_Skip / B_Direct_16x16). Sets the motion and predicts the samples.
    fn direct_8x8(&mut self, b8: usize) -> Result<()> {
        let (x8, y8) = ((b8 % 2) * 8, (b8 / 2) * 8);
        if self.col.is_none() {
            return Err(Error::Bitstream("B slice without a list 1 reference"));
        }
        if self.hdr.direct_spatial_mv_pred {
            // 8.4.1.2.2: the MB-level reference indices and predictors
            let min_pos = |a: i32, b: i32| if a >= 0 && b >= 0 { a.min(b) } else { a.max(b) };
            let mut ref_idx = [0i32; 2];
            let mut mvp = [[0i32; 2]; 2];
            for list in 0..2 {
                let a = self.nb_motion(list, -1, 0).map_or(-1, |v| v.0);
                let b = self.nb_motion(list, 0, -1).map_or(-1, |v| v.0);
                let c = self.nb_motion(list, 16, -1).or_else(|| self.nb_motion(list, -1, -1)).map_or(-1, |v| v.0);
                ref_idx[list] = min_pos(a, min_pos(b, c));
            }
            let zero = ref_idx[0] < 0 && ref_idx[1] < 0;
            if zero {
                ref_idx = [0, 0];
            } else {
                for list in 0..2 {
                    if ref_idx[list] >= 0 {
                        mvp[list] = self.mv_pred(list, ref_idx[list], 0, 0, 16, 16, 0);
                    }
                }
            }
            let l1_short = !self.lists[1][0].long_term;
            let blocks: Vec<(usize, usize, usize)> = if self.sps.direct_8x8_inference { vec![(x8, y8, 8)] } else { vec![(x8, y8, 4), (x8 + 4, y8, 4), (x8, y8 + 4, 4), (x8 + 4, y8 + 4, 4)] };
            for (bx, by, sz) in blocks {
                let col = self.col_motion(bx, by);
                let col_zero = match col {
                    Some((ridx, mv, _, _)) => l1_short && ridx == 0 && (-1..=1).contains(&mv[0]) && (-1..=1).contains(&mv[1]),
                    None => false,
                };
                let mut mvs = [[0i32; 2]; 2];
                let mut refs = [-1i32; 2];
                for list in 0..2 {
                    if zero {
                        refs[list] = 0;
                        mvs[list] = [0, 0];
                    } else if ref_idx[list] >= 0 {
                        refs[list] = ref_idx[list];
                        mvs[list] = if ref_idx[list] == 0 && col_zero { [0, 0] } else { mvp[list] };
                    }
                }
                for list in 0..2 {
                    self.set_motion(list, bx, by, sz, sz, refs[list], mvs[list]);
                }
                self.mark_done(bx, by, sz, sz);
                let r = [if refs[0] >= 0 { Some(refs[0] as usize) } else { None }, if refs[1] >= 0 { Some(refs[1] as usize) } else { None }];
                self.predict_inter_block(bx, by, sz, sz, r, mvs);
            }
        } else {
            // 8.4.1.2.3 temporal
            let blocks: Vec<(usize, usize, usize)> = if self.sps.direct_8x8_inference { vec![(x8, y8, 8)] } else { vec![(x8, y8, 4), (x8 + 4, y8, 4), (x8, y8 + 4, 4), (x8 + 4, y8 + 4, 4)] };
            for (bx, by, sz) in blocks {
                let col = self.col_motion(bx, by);
                let (mv_col, ref_id_col) = match col {
                    Some((_, mv, id, _)) => (mv, id),
                    None => ([0, 0], -1),
                };
                let ref0 = if ref_id_col < 0 { 0 } else { self.lists[0].iter().position(|r| r.pic.id as i32 == ref_id_col).unwrap_or(0) };
                if std::env::var_os("H264_TRACE").is_some() && ref_id_col >= 0 && !self.lists[0].iter().any(|r| r.pic.id as i32 == ref_id_col) {
                    eprintln!("  temporal direct: col ref id {} not in L0 (mb {},{})", ref_id_col, self.mx, self.my);
                }
                let r0 = &self.lists[0][ref0];
                let r1 = &self.lists[1][0];
                let (mv0, mv1) = if r0.long_term {
                    (mv_col, [0, 0])
                } else {
                    match inter::dist_scale_factor(self.poc, r0.poc, r1.poc) {
                        None => (mv_col, [0, 0]),
                        Some(dsf) => {
                            let m0 = [(dsf * mv_col[0] + 128) >> 8, (dsf * mv_col[1] + 128) >> 8];
                            (m0, [m0[0] - mv_col[0], m0[1] - mv_col[1]])
                        }
                    }
                };
                if std::env::var_os("H264_TRACE_MB").map_or(false, |v| v == format!("{},{},{}", self.poc, self.mx, self.my).as_str()) {
                    eprintln!("  temporal direct poc {} mb ({},{}) blk ({bx},{by}) col {:?} -> ref0 {} (poc {}) l1 poc {} mv0 {:?} mv1 {:?}", self.poc, self.mx, self.my, col, ref0, r0.poc, r1.poc, mv0, mv1);
                }
                self.set_motion(0, bx, by, sz, sz, ref0 as i32, mv0);
                self.set_motion(1, bx, by, sz, sz, 0, mv1);
                self.mark_done(bx, by, sz, sz);
                self.predict_inter_block(bx, by, sz, sz, [Some(ref0), Some(0)], [mv0, mv1]);
            }
        }
        Ok(())
    }

    fn direct_all(&mut self) -> Result<()> {
        for b8 in 0..4 {
            self.direct_8x8(b8)?;
        }
        Ok(())
    }

    /// Predict the samples of one block from its motion (both lists) with
    /// the slice's weighting.
    fn predict_inter_block(&mut self, x: usize, y: usize, w: usize, h: usize, refs: [Option<usize>; 2], mvs: [[i32; 2]; 2]) {
        let mut pl = [[0u8; 256]; 2];
        let mut pc = [[[0u8; 64]; 2]; 2];
        let px = (self.mx * 16 + x) as i32;
        let py = (self.my * 16 + y) as i32;
        for list in 0..2 {
            let Some(r) = refs[list] else { continue };
            let rp = &self.lists[list][r].pic;
            inter::mc_luma(&rp.y, rp.width, rp.height, px, py, mvs[list][0], mvs[list][1], w, h, &mut pl[list]);
            inter::mc_chroma(&rp.u, rp.width / 2, rp.height / 2, px / 2, py / 2, mvs[list][0], mvs[list][1], w / 2, h / 2, &mut pc[list][0]);
            inter::mc_chroma(&rp.v, rp.width / 2, rp.height / 2, px / 2, py / 2, mvs[list][0], mvs[list][1], w / 2, h / 2, &mut pc[list][1]);
        }
        // weights
        let n = w * h;
        let nc = (w / 2) * (h / 2);
        let bi = refs[0].is_some() && refs[1].is_some();
        let single = if refs[0].is_some() { 0 } else { 1 };
        let mut wl: Option<(i32, i32, i32, i32, i32)> = None;
        let mut wc: [Option<(i32, i32, i32, i32, i32)>; 2] = [None, None];
        if let Some(t) = &self.hdr.pred_weight {
            let ent = |list: usize| -> (i32, i32, [i32; 2], [i32; 2]) {
                let r = refs[list].unwrap();
                let e = t.lists[list].get(r).copied().unwrap_or_default();
                let (lw, lo) = e.luma.unwrap_or((1 << t.luma_log2_denom, 0));
                let mut cw = [0; 2];
                let mut co = [0; 2];
                for c in 0..2 {
                    let (w_, o_) = e.chroma[c].unwrap_or((1 << t.chroma_log2_denom, 0));
                    cw[c] = w_;
                    co[c] = o_;
                }
                (lw, lo, cw, co)
            };
            if bi {
                let (w0, o0, cw0, co0) = ent(0);
                let (w1, o1, cw1, co1) = ent(1);
                wl = Some((w0, o0, w1, o1, t.luma_log2_denom as i32));
                for c in 0..2 {
                    wc[c] = Some((cw0[c], co0[c], cw1[c], co1[c], t.chroma_log2_denom as i32));
                }
            } else {
                let (w0, o0, cw0, co0) = ent(single);
                wl = Some((w0, o0, 0, 0, t.luma_log2_denom as i32));
                for c in 0..2 {
                    wc[c] = Some((cw0[c], co0[c], 0, 0, t.chroma_log2_denom as i32));
                }
            }
        } else if bi && self.pps.weighted_bipred_idc == 2 && self.hdr.slice_type == SliceType::B {
            let (w0, w1) = self.implicit[refs[0].unwrap()][refs[1].unwrap()];
            wl = Some((w0, 0, w1, 0, 5));
            wc = [Some((w0, 0, w1, 0, 5)); 2];
        }
        let mut outl = [0u8; 256];
        let mut outc = [[0u8; 64]; 2];
        if bi {
            inter::weight(&pl[0][..n], Some(&pl[1][..n]), wl, &mut outl);
            for c in 0..2 {
                inter::weight(&pc[0][c][..nc], Some(&pc[1][c][..nc]), wc[c], &mut outc[c]);
            }
        } else {
            inter::weight(&pl[single][..n], None, wl, &mut outl);
            for c in 0..2 {
                inter::weight(&pc[single][c][..nc], None, wc[c], &mut outc[c]);
            }
        }
        // write into the picture
        let pw = self.pic.width;
        let x0 = self.mx * 16 + x;
        let y0 = self.my * 16 + y;
        for j in 0..h {
            self.pic.y[(y0 + j) * pw + x0..(y0 + j) * pw + x0 + w].copy_from_slice(&outl[j * w..j * w + w]);
        }
        let cw = pw / 2;
        let (cx0, cy0, cwid, chei) = (x0 / 2, y0 / 2, w / 2, h / 2);
        for j in 0..chei {
            self.pic.u[(cy0 + j) * cw + cx0..(cy0 + j) * cw + cx0 + cwid].copy_from_slice(&outc[0][j * cwid..j * cwid + cwid]);
            self.pic.v[(cy0 + j) * cw + cx0..(cy0 + j) * cw + cx0 + cwid].copy_from_slice(&outc[1][j * cwid..j * cwid + cwid]);
        }
    }

    /// Derive the motion of every partition (8.4.1) in order and predict.
    fn inter_predict(&mut self, ip: &InterParse) -> Result<()> {
        let nparts = Self::num_parts(ip);
        for p in 0..nparts {
            if ip.shape == Shape::P8x8 && ip.sub_direct[p] {
                self.direct_8x8(p)?;
                continue;
            }
            let nsub = Self::num_sub(ip, p);
            for s in 0..nsub {
                let (x, y, w, h) = Self::part_rect(ip, p, s);
                let mut mvs = [[0i32; 2]; 2];
                let mut refs = [None; 2];
                for list in 0..2 {
                    if !ip.pred[p][list] {
                        continue;
                    }
                    let r = ip.ref_idx[list][p] as i32;
                    let dir = match ip.shape {
                        Shape::P16x8 => 1 + p as u32,
                        Shape::P8x16 => 3 + p as u32,
                        _ => 0,
                    };
                    let pred = self.mv_pred(list, r, x, y, w, h, dir);
                    let mv = [pred[0] + ip.mvd[list][p][s][0], pred[1] + ip.mvd[list][p][s][1]];
                    self.set_motion(list, x, y, w, h, r, mv);
                    mvs[list] = mv;
                    refs[list] = Some(r as usize);
                }
                self.mark_done(x, y, w, h);
                self.predict_inter_block(x, y, w, h, refs, mvs);
            }
        }
        Ok(())
    }

    fn inter_residual(&mut self, ip: &InterParse) -> Result<()> {
        let cbp = self.parse_cbp(false)?;
        self.cur.cbp = cbp;
        if (cbp & 15) != 0 && self.pps.transform_8x8_mode {
            // no sub-partition smaller than 8x8 (a direct 8x8 needs direct_8x8_inference)
            let mut ok = true;
            if ip.shape == Shape::P8x8 {
                for b8 in 0..4 {
                    if ip.sub_direct[b8] {
                        if !self.sps.direct_8x8_inference {
                            ok = false;
                        }
                    } else if ip.sub_shape[b8] != SubShape::S8x8 {
                        ok = false;
                    }
                }
            }
            if ok {
                self.cur.transform8x8 = self.parse_transform8x8()?;
            }
        }
        self.qp_delta(cbp != 0)?;
        let mut co = Coeffs::default();
        if cbp != 0 {
            self.residual(&mut co)?;
        }
        self.add_luma_residual_inter(&co);
        self.add_chroma_residual(&co);
        Ok(())
    }
}

#[inline(always)]
fn median(a: i32, b: i32, c: i32) -> i32 {
    a.max(b).min(a.min(b).max(c))
}

/// The coefficient levels of one macroblock, in raster order per block.
#[derive(Clone)]
pub struct Coeffs {
    pub luma_dc: [i32; 16],
    pub luma4: [[i32; 16]; 16],
    pub luma8: [[i32; 64]; 4],
    pub chroma_dc: [[i32; 4]; 2],
    pub chroma_ac: [[[i32; 16]; 4]; 2],
}

impl Default for Coeffs {
    fn default() -> Self {
        Coeffs { luma_dc: [0; 16], luma4: [[0; 16]; 16], luma8: [[0; 64]; 4], chroma_dc: [[0; 4]; 2], chroma_ac: [[[0; 16]; 4]; 2] }
    }
}

