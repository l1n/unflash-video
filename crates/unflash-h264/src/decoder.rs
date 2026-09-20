//! The decoder: NAL units in, pictures out.

use std::rc::Rc;

use crate::bitreader::{unescape, BitReader};
use crate::cabac::Cabac;
use crate::deblock::{self, MbDeblockInfo};
use crate::mb::{Entropy, MbInfo, SliceDecoder};
use crate::picture::{Dpb, Picture, PocState, BOTTOM, FRAME, TOP};
use crate::ps::{parse_pps, parse_sps, Pps, ScalingTables, Sps};
use crate::slice::{parse_slice_header, SliceHeader};
use crate::{Error, Result};

/// A decoded picture, in decoding order; the caller orders by `pts`.
pub struct DecodedFrame {
    pub pic: Rc<Picture>,
    /// Some slice of it could not be decoded (parts are concealed).
    pub damaged: bool,
}

/// The picture (frame or field) being decoded.
struct Current {
    pic: Picture,
    hdr: SliceHeader,
    poc: PocState,
    /// TOP, BOTTOM or FRAME.
    structure: u8,
    /// The second field of a frame whose first field is decoded.
    second_field: bool,
    mbs: Vec<MbInfo>,
    deblock: Vec<MbDeblockInfo>,
    slices: u32,
    damaged: bool,
    decoded_mbs: usize,
}

/// A decoded first field waiting for the second field of its frame.
struct Pending {
    pic: Picture,
    frame_num: u32,
    structure: u8,
    is_ref: bool,
    damaged: bool,
    mbs: Vec<MbInfo>,
    deblock: Vec<MbDeblockInfo>,
}

pub struct Decoder {
    spss: Vec<Option<Sps>>,
    ppss: Vec<Option<Pps>>,
    dpb: Dpb,
    cur: Option<Current>,
    pending: Option<Pending>,
    /// Frames finished but not yet handed out.
    out: Vec<DecodedFrame>,
    nal_length_size: usize,
    /// The active sequence (for size and colour information).
    active_sps: Option<Sps>,
    last_output: Option<Rc<Picture>>,
    /// macroblock kinds of the last finished picture (debugging aid)
    last_kinds: Vec<crate::mb::MbKind>,
    /// Picture buffers free for reuse, and per-picture macroblock tables.
    pool: Vec<Picture>,
    retired: Vec<Rc<Picture>>,
    mbs_buf: Vec<MbInfo>,
    deblock_buf: Vec<MbDeblockInfo>,
    /// leave the deblocking filter out (see `set_skip_deblock`)
    skip_deblock: bool,
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    pub fn new() -> Decoder {
        Decoder {
            spss: vec![None; 32],
            ppss: vec![None; 256],
            dpb: Dpb::new(),
            cur: None,
            pending: None,
            out: Vec::new(),
            nal_length_size: 4,
            active_sps: None,
            last_output: None,
            last_kinds: Vec::new(),
            pool: Vec::new(),
            retired: Vec::new(),
            mbs_buf: Vec::new(),
            deblock_buf: Vec::new(),
            skip_deblock: std::env::var_os("H264_NO_DEBLOCK").is_some(),
        }
    }

    /// Skip the in-loop deblocking filter: about a quarter of the decoding
    /// time. The pictures are no longer bit-exact (block edges keep their
    /// coding artefacts, and later pictures predicted from them drift very
    /// slightly), which is fine for statistics such as flash detection but
    /// not for pictures that are shown or re-encoded.
    pub fn set_skip_deblock(&mut self, skip: bool) {
        self.skip_deblock = skip;
    }

    /// Feed an `AVCDecoderConfigurationRecord` (the `avcC` box payload):
    /// the parameter sets and the NAL length size of the samples.
    pub fn configure_avcc(&mut self, avcc: &[u8]) -> Result<()> {
        if avcc.len() < 7 || avcc[0] != 1 {
            return Err(Error::Bitstream("bad avcC record"));
        }
        self.nal_length_size = (avcc[4] & 3) as usize + 1;
        let mut p = 6;
        let nsps = (avcc[5] & 31) as usize;
        for _ in 0..nsps {
            let len = u16::from_be_bytes([*avcc.get(p).ok_or(Error::Bitstream("short avcC"))?, *avcc.get(p + 1).ok_or(Error::Bitstream("short avcC"))?]) as usize;
            p += 2;
            let nal = avcc.get(p..p + len).ok_or(Error::Bitstream("short avcC"))?;
            self.decode_nal(nal, 0.0)?;
            p += len;
        }
        let npps = *avcc.get(p).ok_or(Error::Bitstream("short avcC"))? as usize;
        p += 1;
        for _ in 0..npps {
            let len = u16::from_be_bytes([*avcc.get(p).ok_or(Error::Bitstream("short avcC"))?, *avcc.get(p + 1).ok_or(Error::Bitstream("short avcC"))?]) as usize;
            p += 2;
            let nal = avcc.get(p..p + len).ok_or(Error::Bitstream("short avcC"))?;
            self.decode_nal(nal, 0.0)?;
            p += len;
        }
        Ok(())
    }

    /// The sequence parameter set in use, once a slice has been seen.
    pub fn sps(&self) -> Option<&Sps> {
        self.active_sps.as_ref()
    }

    /// The first sequence parameter set seen (from `configure_avcc`).
    pub fn first_sps(&self) -> Option<&Sps> {
        self.spss.iter().flatten().next()
    }

    pub fn pps(&self, id: usize) -> Option<&Pps> {
        self.ppss.get(id).and_then(|p| p.as_ref())
    }

    /// The macroblock kinds of the last finished picture, in raster order.
    pub fn last_mb_kinds(&self) -> &[crate::mb::MbKind] {
        &self.last_kinds
    }

    /// Whether the stream's parameter sets describe something this decoder
    /// can decode (after `configure_avcc`).
    pub fn supported(&self) -> Result<()> {
        if self.spss.iter().all(|s| s.is_none()) {
            return Err(Error::Bitstream("no sequence parameter set"));
        }
        Ok(())
    }

    /// Decode one MP4 sample (length-prefixed NAL units of one access
    /// unit) and return its picture. A sample holding the first field of a
    /// frame alone yields nothing; the frame comes with its second field.
    pub fn decode_sample(&mut self, data: &[u8], pts: f64) -> Result<Option<DecodedFrame>> {
        let mut p = 0;
        let n = self.nal_length_size;
        while p + n <= data.len() {
            let mut len = 0usize;
            for i in 0..n {
                len = (len << 8) | data[p + i] as usize;
            }
            p += n;
            if len == 0 {
                continue;
            }
            if p + len > data.len() {
                return Err(Error::Bitstream("NAL unit runs past the sample"));
            }
            self.decode_nal(&data[p..p + len], pts)?;
            p += len;
        }
        self.finish_picture()?;
        let mut frames = std::mem::take(&mut self.out);
        Ok(frames.pop())
    }

    /// Decode an Annex B byte stream chunk (start-code delimited NAL
    /// units); pictures complete when the next picture starts, so call
    /// `flush` at the end.
    pub fn decode_annexb(&mut self, data: &[u8], pts: f64) -> Result<Vec<DecodedFrame>> {
        let mut i = 0;
        let mut starts = Vec::new();
        while i + 3 <= data.len() {
            if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
                starts.push(i + 3);
                i += 3;
            } else {
                i += 1;
            }
        }
        for (k, &s) in starts.iter().enumerate() {
            let mut e = if k + 1 < starts.len() { starts[k + 1] - 3 } else { data.len() };
            while e > s && data[e - 1] == 0 {
                e -= 1;
            }
            if e > s {
                self.decode_nal(&data[s..e], pts)?;
            }
        }
        Ok(std::mem::take(&mut self.out))
    }

    /// Finish the picture in progress, if any (and an unpaired field).
    pub fn flush(&mut self) -> Result<Option<DecodedFrame>> {
        self.finish_picture()?;
        if let Some(p) = self.pending.take() {
            self.output_unpaired(p);
        }
        let mut frames = std::mem::take(&mut self.out);
        Ok(frames.pop())
    }

    /// Decode one NAL unit (with its header byte, emulation prevention
    /// still in place). Completed pictures are queued for the caller.
    pub fn decode_nal(&mut self, nal: &[u8], pts: f64) -> Result<Option<DecodedFrame>> {
        if nal.is_empty() {
            return Ok(None);
        }
        let nal_type = nal[0] & 0x1f;
        let nal_ref_idc = (nal[0] >> 5) & 3;
        match nal_type {
            7 => {
                let sps = parse_sps(&unescape(&nal[1..]))?;
                let id = sps.id as usize;
                self.spss[id] = Some(sps);
                Ok(None)
            }
            8 => {
                let pps = parse_pps(&unescape(&nal[1..]))?;
                let id = pps.id as usize;
                self.ppss[id] = Some(pps);
                Ok(None)
            }
            1 | 5 => {
                self.decode_slice(nal_type, nal_ref_idc, &unescape(&nal[1..]), pts)?;
                Ok(None)
            }
            2..=4 => Err(Error::Unsupported("slice data partitioning")),
            _ => Ok(None),
        }
    }

    fn new_picture_starts(&self, hdr: &SliceHeader, sps: &Sps) -> bool {
        let Some(cur) = &self.cur else { return true };
        let prev = &cur.hdr;
        if hdr.first_mb == 0 || hdr.frame_num != prev.frame_num || hdr.pps_id != prev.pps_id || (hdr.nal_ref_idc == 0) != (prev.nal_ref_idc == 0) || hdr.is_idr() != prev.is_idr() || hdr.field_pic != prev.field_pic || hdr.bottom_field != prev.bottom_field {
            return true;
        }
        if hdr.is_idr() && hdr.idr_pic_id != prev.idr_pic_id {
            return true;
        }
        match sps.poc_type {
            0 => hdr.poc_lsb != prev.poc_lsb || hdr.delta_poc_bottom != prev.delta_poc_bottom,
            1 => hdr.delta_poc != prev.delta_poc,
            _ => false,
        }
    }

    fn decode_slice(&mut self, nal_type: u8, nal_ref_idc: u8, rbsp: &[u8], pts: f64) -> Result<()> {
        let mut r = BitReader::new(rbsp);
        let hdr = parse_slice_header(&mut r, nal_type, nal_ref_idc, &self.spss, &self.ppss)?;
        if hdr.redundant_pic_cnt > 0 {
            return Ok(());
        }
        let pps = self.ppss[hdr.pps_id as usize].clone().unwrap();
        let sps = self.spss[pps.sps_id as usize].clone().unwrap();
        if self.new_picture_starts(&hdr, &sps) {
            self.finish_picture()?;
            self.start_picture(&sps, &hdr, pts)?;
        }
        let scaling = ScalingTables::new(&sps, &pps);
        let cur = self.cur.as_mut().unwrap();
        cur.slices += 1;
        let slice_id = cur.slices;
        let lists = match self.dpb.ref_lists(&sps, &hdr, cur.poc.poc) {
            Ok(l) => l,
            Err(e) => {
                cur.damaged = true;
                return Err(e);
            }
        };
        let entropy = if pps.entropy_coding_mode {
            r.byte_align();
            Entropy::Cabac(Cabac::new(rbsp, r.byte_pos(), hdr.slice_type == crate::slice::SliceType::I, hdr.cabac_init_idc, hdr.slice_qp)?)
        } else {
            Entropy::Cavlc(r)
        };
        let poc = cur.poc.poc;
        if crate::debug_flag("H264_TRACE").is_some() {
            let show = |l: &Vec<crate::picture::RefPic>| l.iter().map(|r| format!("{}{}{}", r.poc, match r.structure { TOP => "t", BOTTOM => "b", _ => "" }, if r.long_term { "L" } else { "" })).collect::<Vec<_>>().join(" ");
            let dpb = self.dpb.entries.iter().map(|e| format!("fn{}/poc{}/r{}{}", e.frame_num, e.poc, e.reference, if e.kind == crate::picture::RefKind::Long { "L" } else { "" })).collect::<Vec<_>>().join(" ");
            eprintln!("slice pts {} type {:?} struct {} poc {} frame_num {} ref {} first_mb {} L0 [{}] L1 [{}] mods {:?} mmco {:?} dpb [{}] dbf {}/{}/{} cabac {} direct_spatial {} wp {}/{} nref {:?}", pts, hdr.slice_type, cur.structure, poc, hdr.frame_num, hdr.nal_ref_idc, hdr.first_mb, show(&lists[0]), show(&lists[1]), hdr.ref_list_mods, hdr.mmco, dpb, hdr.disable_deblocking_filter_idc, hdr.alpha_offset, hdr.beta_offset, pps.entropy_coding_mode, hdr.direct_spatial_mv_pred, pps.weighted_pred, pps.weighted_bipred_idc, hdr.num_ref_idx_active);
        }
        let structure = cur.structure;
        let mut sd = SliceDecoder::new(&sps, &pps, &scaling, &hdr, &lists, slice_id, entropy, &mut cur.mbs, &mut cur.deblock, &mut cur.pic, poc, structure);
        match sd.decode() {
            Ok(n) => cur.decoded_mbs += n,
            Err(_) => cur.damaged = true,
        }
        Ok(())
    }

    /// A picture buffer of the right size: one nobody uses any more, or a
    /// new one.
    fn take_picture(&mut self, id: u32, wm: usize, hm: usize) -> Picture {
        for rc in self.dpb.graveyard.drain(..).chain(self.retired.drain(..)) {
            if let Ok(p) = Rc::try_unwrap(rc) {
                if p.width == wm * 16 && p.height == hm * 16 {
                    self.pool.push(p);
                }
            }
        }
        match self.pool.pop() {
            Some(mut p) => {
                p.reset(id);
                p
            }
            None => Picture::new(id, wm, hm),
        }
    }

    fn reset_tables(mbs: &mut Vec<MbInfo>, deblock: &mut Vec<MbDeblockInfo>, n: usize) {
        mbs.resize(n, MbInfo::default());
        for m in mbs.iter_mut() {
            m.slice = 0;
        }
        deblock.clear();
        deblock.resize(n, MbDeblockInfo::default());
    }

    fn start_picture(&mut self, sps: &Sps, hdr: &SliceHeader, pts: f64) -> Result<()> {
        if self.active_sps.as_ref().map_or(true, |a| a.id != sps.id || a.width_mbs != sps.width_mbs || a.height_mbs != sps.height_mbs) {
            // a new sequence: references from the old one are useless
            if !hdr.is_idr() {
                self.dpb.clear();
            }
            if let Some(p) = self.pending.take() {
                self.output_unpaired(p);
            }
            self.pool.clear();
            self.active_sps = Some(sps.clone());
        }
        let (wm, hm) = (sps.width_mbs as usize, sps.height_mbs as usize);
        let structure = hdr.structure();
        let n = wm * hm;
        // the second field of the frame whose first field is waiting?
        if let Some(p) = self.pending.take() {
            if hdr.field_pic && structure != p.structure && hdr.frame_num == p.frame_num && hdr.is_ref() == p.is_ref && !hdr.is_idr() {
                let poc = self.dpb.compute_poc(sps, hdr);
                let mut pic = p.pic;
                pic.set_poc(structure, poc.top, poc.bottom);
                let mut mbs = p.mbs;
                let mut deblock = p.deblock;
                Self::reset_tables(&mut mbs, &mut deblock, n);
                self.cur = Some(Current { pic, hdr: hdr.clone(), poc, structure, second_field: true, mbs, deblock, slices: 0, damaged: p.damaged, decoded_mbs: 0 });
                return Ok(());
            }
            self.output_unpaired(p);
        }
        if hdr.is_idr() {
            self.dpb.clear();
        } else {
            let last = self.last_output.clone();
            self.dpb.fill_frame_num_gap(sps, hdr, &|id, _fn| {
                let mut p = Picture::new(id, wm, hm);
                if let Some(l) = &last {
                    if l.width == p.width && l.height == p.height {
                        p.y.copy_from_slice(&l.y);
                        p.u.copy_from_slice(&l.u);
                        p.v.copy_from_slice(&l.v);
                    }
                }
                p
            });
        }
        let poc = self.dpb.compute_poc(sps, hdr);
        let id = self.dpb.alloc_id();
        let mut pic = self.take_picture(id, wm, hm);
        pic.set_poc(structure, poc.top, poc.bottom);
        pic.frame_num = hdr.frame_num;
        pic.is_idr = hdr.is_idr();
        pic.is_ref = hdr.is_ref();
        pic.coded_fields = hdr.field_pic;
        pic.mbaff = sps.mbaff && !hdr.field_pic;
        pic.pts = pts;
        let mut mbs = std::mem::take(&mut self.mbs_buf);
        let mut deblock = std::mem::take(&mut self.deblock_buf);
        Self::reset_tables(&mut mbs, &mut deblock, n);
        self.cur = Some(Current { pic, hdr: hdr.clone(), poc, structure, second_field: false, mbs, deblock, slices: 0, damaged: false, decoded_mbs: 0 });
        Ok(())
    }

    /// Finish the field or frame being decoded: deblock it, mark the
    /// references, and queue the frame for output once it is complete.
    fn finish_picture(&mut self) -> Result<()> {
        let Some(mut cur) = self.cur.take() else { return Ok(()) };
        let sps = self.active_sps.clone().unwrap();
        let (wm, hm) = (sps.width_mbs as usize, sps.height_mbs as usize);
        let total = if cur.structure == FRAME { wm * hm } else { wm * hm / 2 };
        if cur.decoded_mbs < total {
            cur.damaged = true;
            self.conceal(&mut cur, wm, hm);
        }
        if !self.skip_deblock {
            deblock::filter_picture(&mut cur.pic, &cur.deblock, wm, hm, cur.structure);
        }
        self.last_kinds = cur.mbs.iter().map(|m| if m.slice != 0 { m.kind } else { crate::mb::MbKind::None }).collect();
        if cur.structure != FRAME && !cur.second_field {
            // the first field: later pictures (its own second field included)
            // reference a copy while the frame buffer waits for the other field
            let snapshot = Rc::new(cur.pic.clone());
            self.dpb.mark(&sps, &cur.hdr, snapshot, cur.poc, cur.structure)?;
            self.pending = Some(Pending { pic: cur.pic, frame_num: cur.hdr.frame_num, structure: cur.structure, is_ref: cur.hdr.is_ref(), damaged: cur.damaged, mbs: cur.mbs, deblock: cur.deblock });
            return Ok(());
        }
        let pic = Rc::new(cur.pic);
        self.dpb.mark(&sps, &cur.hdr, pic.clone(), cur.poc, cur.structure)?;
        self.emit(pic, cur.damaged);
        self.mbs_buf = cur.mbs;
        self.deblock_buf = cur.deblock;
        Ok(())
    }

    fn emit(&mut self, pic: Rc<Picture>, damaged: bool) {
        if let Some(prev) = self.last_output.replace(pic.clone()) {
            self.retired.push(prev);
        }
        self.out.push(DecodedFrame { pic, damaged });
    }

    /// A first field whose second field never came: show it with its lines
    /// doubled into the missing field.
    fn output_unpaired(&mut self, p: Pending) {
        let mut pic = p.pic;
        let w = pic.width;
        let cw = w / 2;
        let (from, to) = if p.structure == TOP { (0, 1) } else { (1, 0) };
        for r in (0..pic.height).step_by(2) {
            let (src, dst) = ((r + from) * w, (r + to) * w);
            pic.y.copy_within(src..src + w, dst);
        }
        for r in (0..pic.height / 2).step_by(2) {
            let (src, dst) = ((r + from) * cw, (r + to) * cw);
            pic.u.copy_within(src..src + cw, dst);
            pic.v.copy_within(src..src + cw, dst);
        }
        self.mbs_buf = p.mbs;
        self.deblock_buf = p.deblock;
        self.emit(Rc::new(pic), true);
    }

    /// Fill the macroblocks no slice covered with the co-located samples of
    /// the previous output picture (or mid grey when there is none).
    fn conceal(&self, cur: &mut Current, wm: usize, hm: usize) {
        let w = cur.pic.width;
        let cw = w / 2;
        let last = self.last_output.as_ref().filter(|l| l.width == cur.pic.width && l.height == cur.pic.height);
        let field = cur.structure != FRAME;
        let parity = (cur.structure == BOTTOM) as usize;
        let rows = if field { hm / 2 } else { hm };
        for row in 0..rows {
            let my = if field { 2 * row + parity } else { row };
            for mx in 0..wm {
                if cur.deblock[my * wm + mx].decoded {
                    continue;
                }
                for j in 0..16 {
                    let line = if field { 32 * row + parity + 2 * j } else { 16 * my + j };
                    let o = line * w + mx * 16;
                    match last {
                        Some(l) => cur.pic.y[o..o + 16].copy_from_slice(&l.y[o..o + 16]),
                        None => cur.pic.y[o..o + 16].fill(128),
                    }
                }
                for j in 0..8 {
                    let line = if field { 16 * row + parity + 2 * j } else { 8 * my + j };
                    let o = line * cw + mx * 8;
                    match last {
                        Some(l) => {
                            cur.pic.u[o..o + 8].copy_from_slice(&l.u[o..o + 8]);
                            cur.pic.v[o..o + 8].copy_from_slice(&l.v[o..o + 8]);
                        }
                        None => {
                            cur.pic.u[o..o + 8].fill(128);
                            cur.pic.v[o..o + 8].fill(128);
                        }
                    }
                }
                // a concealed macroblock predicts like an intra one with no motion
                cur.pic.mb_intra[my * wm + mx] = true;
                cur.pic.mb_field[my * wm + mx] = field;
                let w4 = w / 4;
                for by in 0..4 {
                    let b = (my * 4 + by) * w4 + mx * 4;
                    for l in 0..2 {
                        cur.pic.mv[l][b..b + 4].fill([0, 0]);
                        cur.pic.ref_idx[l][b..b + 4].fill(-1);
                        cur.pic.ref_id[l][b..b + 4].fill(-1);
                    }
                }
            }
        }
    }
}
