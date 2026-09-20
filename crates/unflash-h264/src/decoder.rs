//! The decoder: NAL units in, pictures out.

use std::rc::Rc;

use crate::bitreader::{unescape, BitReader};
use crate::cabac::Cabac;
use crate::deblock::{self, MbDeblockInfo};
use crate::mb::{Entropy, MbInfo, SliceDecoder};
use crate::picture::{Dpb, Picture, PocState};
use crate::ps::{parse_pps, parse_sps, Pps, ScalingTables, Sps};
use crate::slice::{parse_slice_header, SliceHeader};
use crate::{Error, Result};

/// A decoded picture, in decoding order; the caller orders by `pts`.
pub struct DecodedFrame {
    pub pic: Rc<Picture>,
    /// Some slice of it could not be decoded (parts are concealed).
    pub damaged: bool,
}

struct Current {
    pic: Picture,
    hdr: SliceHeader,
    poc: PocState,
    mbs: Vec<MbInfo>,
    deblock: Vec<MbDeblockInfo>,
    slices: u32,
    damaged: bool,
    decoded_mbs: usize,
}

pub struct Decoder {
    spss: Vec<Option<Sps>>,
    ppss: Vec<Option<Pps>>,
    dpb: Dpb,
    cur: Option<Current>,
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
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    pub fn new() -> Decoder {
        Decoder { spss: vec![None; 32], ppss: vec![None; 256], dpb: Dpb::new(), cur: None, nal_length_size: 4, active_sps: None, last_output: None, last_kinds: Vec::new(), pool: Vec::new(), retired: Vec::new(), mbs_buf: Vec::new(), deblock_buf: Vec::new() }
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
    /// unit) and return its picture.
    pub fn decode_sample(&mut self, data: &[u8], pts: f64) -> Result<Option<DecodedFrame>> {
        let mut p = 0;
        let n = self.nal_length_size;
        let mut out = None;
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
            if let Some(f) = self.decode_nal(&data[p..p + len], pts)? {
                out = Some(f);
            }
            p += len;
        }
        if let Some(f) = self.finish_picture()? {
            out = Some(f);
        }
        Ok(out)
    }

    /// Decode an Annex B byte stream chunk (start-code delimited NAL
    /// units); pictures complete when the next picture starts, so call
    /// `flush` at the end.
    pub fn decode_annexb(&mut self, data: &[u8], pts: f64) -> Result<Vec<DecodedFrame>> {
        let mut frames = Vec::new();
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
                if let Some(f) = self.decode_nal(&data[s..e], pts)? {
                    frames.push(f);
                }
            }
        }
        Ok(frames)
    }

    /// Finish the picture in progress, if any.
    pub fn flush(&mut self) -> Result<Option<DecodedFrame>> {
        self.finish_picture()
    }

    /// Decode one NAL unit (with its header byte, emulation prevention
    /// still in place). A completed *previous* picture may be returned.
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
            1 | 5 => self.decode_slice(nal_type, nal_ref_idc, &unescape(&nal[1..]), pts),
            2..=4 => Err(Error::Unsupported("slice data partitioning")),
            _ => Ok(None),
        }
    }

    fn new_picture_starts(&self, hdr: &SliceHeader, sps: &Sps) -> bool {
        let Some(cur) = &self.cur else { return true };
        let prev = &cur.hdr;
        if hdr.first_mb == 0 || hdr.frame_num != prev.frame_num || hdr.pps_id != prev.pps_id || (hdr.nal_ref_idc == 0) != (prev.nal_ref_idc == 0) || hdr.is_idr() != prev.is_idr() {
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

    fn decode_slice(&mut self, nal_type: u8, nal_ref_idc: u8, rbsp: &[u8], pts: f64) -> Result<Option<DecodedFrame>> {
        let mut r = BitReader::new(rbsp);
        let hdr = parse_slice_header(&mut r, nal_type, nal_ref_idc, &self.spss, &self.ppss)?;
        if hdr.redundant_pic_cnt > 0 {
            return Ok(None);
        }
        let pps = self.ppss[hdr.pps_id as usize].clone().unwrap();
        let sps = self.spss[pps.sps_id as usize].clone().unwrap();
        let mut finished = None;
        if self.new_picture_starts(&hdr, &sps) {
            finished = self.finish_picture()?;
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
        if std::env::var_os("H264_TRACE").is_some() {
            let show = |l: &Vec<crate::picture::RefPic>| l.iter().map(|r| format!("{}{}", r.poc, if r.long_term { "L" } else { "" })).collect::<Vec<_>>().join(" ");
            let dpb = self.dpb.entries.iter().map(|e| format!("fn{}/poc{}{}", e.frame_num, e.poc, if e.kind == crate::picture::RefKind::Long { "L" } else { "" })).collect::<Vec<_>>().join(" ");
            eprintln!("slice pts {} type {:?} poc {} frame_num {} ref {} first_mb {} L0 [{}] L1 [{}] mods {:?} mmco {:?} dpb [{}]", pts, hdr.slice_type, poc, hdr.frame_num, hdr.nal_ref_idc, hdr.first_mb, show(&lists[0]), show(&lists[1]), hdr.ref_list_mods, hdr.mmco, dpb);
        }
        let mut sd = SliceDecoder::new(&sps, &pps, &scaling, &hdr, &lists, slice_id, entropy, &mut cur.mbs, &mut cur.deblock, &mut cur.pic, poc);
        match sd.decode() {
            Ok(n) => cur.decoded_mbs += n,
            Err(_) => cur.damaged = true,
        }
        Ok(finished)
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

    fn start_picture(&mut self, sps: &Sps, hdr: &SliceHeader, pts: f64) -> Result<()> {
        if self.active_sps.as_ref().map_or(true, |a| a.id != sps.id || a.width_mbs != sps.width_mbs || a.height_mbs != sps.height_mbs) {
            // a new sequence: references from the old one are useless
            if !hdr.is_idr() {
                self.dpb.clear();
            }
            self.pool.clear();
            self.active_sps = Some(sps.clone());
        }
        let (wm, hm) = (sps.width_mbs as usize, sps.height_mbs as usize);
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
        pic.poc = poc.poc;
        pic.frame_num = hdr.frame_num;
        pic.is_idr = hdr.is_idr();
        pic.is_ref = hdr.is_ref();
        pic.pts = pts;
        let n = wm * hm;
        let mut mbs = std::mem::take(&mut self.mbs_buf);
        mbs.resize(n, MbInfo::default());
        for m in mbs.iter_mut() {
            m.slice = 0;
        }
        let mut deblock = std::mem::take(&mut self.deblock_buf);
        deblock.clear();
        deblock.resize(n, MbDeblockInfo::default());
        self.cur = Some(Current { pic, hdr: hdr.clone(), poc, mbs, deblock, slices: 0, damaged: false, decoded_mbs: 0 });
        Ok(())
    }

    fn finish_picture(&mut self) -> Result<Option<DecodedFrame>> {
        let Some(mut cur) = self.cur.take() else { return Ok(None) };
        let sps = self.active_sps.clone().unwrap();
        let (wm, hm) = (sps.width_mbs as usize, sps.height_mbs as usize);
        if cur.decoded_mbs < wm * hm {
            cur.damaged = true;
            self.conceal(&mut cur, wm, hm);
        }
        deblock::filter_picture(&mut cur.pic, &cur.deblock, wm, hm);
        self.last_kinds = cur.mbs.iter().map(|m| if m.slice != 0 { m.kind } else { crate::mb::MbKind::None }).collect();
        let pic = Rc::new(cur.pic);
        self.dpb.mark(&sps, &cur.hdr, pic.clone(), cur.poc)?;
        if let Some(prev) = self.last_output.replace(pic.clone()) {
            self.retired.push(prev);
        }
        self.mbs_buf = cur.mbs;
        self.deblock_buf = cur.deblock;
        Ok(Some(DecodedFrame { pic, damaged: cur.damaged }))
    }

    /// Fill the macroblocks no slice covered with the co-located samples of
    /// the previous output picture (or mid grey when there is none).
    fn conceal(&self, cur: &mut Current, wm: usize, hm: usize) {
        let w = cur.pic.width;
        let cw = w / 2;
        let last = self.last_output.as_ref().filter(|l| l.width == cur.pic.width && l.height == cur.pic.height);
        for my in 0..hm {
            for mx in 0..wm {
                if cur.deblock[my * wm + mx].decoded {
                    continue;
                }
                for y in 0..16 {
                    let o = (my * 16 + y) * w + mx * 16;
                    match last {
                        Some(l) => cur.pic.y[o..o + 16].copy_from_slice(&l.y[o..o + 16]),
                        None => cur.pic.y[o..o + 16].fill(128),
                    }
                }
                for y in 0..8 {
                    let o = (my * 8 + y) * cw + mx * 8;
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
                let w4 = w / 4;
                for by in 0..4 {
                    let row = (my * 4 + by) * w4 + mx * 4;
                    for l in 0..2 {
                        cur.pic.mv[l][row..row + 4].fill([0, 0]);
                        cur.pic.ref_idx[l][row..row + 4].fill(-1);
                        cur.pic.ref_id[l][row..row + 4].fill(-1);
                    }
                }
            }
        }
    }
}
