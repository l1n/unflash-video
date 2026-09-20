//! Decoded pictures, the decoded picture buffer, picture order counts,
//! reference picture lists and reference marking (8.2.1, 8.2.4, 8.2.5).

use std::rc::Rc;

use crate::ps::Sps;
use crate::slice::{Mmco, RefListMod, SliceHeader, SliceType};
use crate::{Error, Result};

/// A decoded frame with the motion data later pictures may refer to.
pub struct Picture {
    /// Unique within a decoder instance.
    pub id: u32,
    /// Luma size in samples (multiples of 16).
    pub width: usize,
    pub height: usize,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
    pub poc: i32,
    pub frame_num: u32,
    pub is_idr: bool,
    pub is_ref: bool,
    /// Inserted for a gap in frame_num: no samples of its own.
    pub non_existing: bool,
    /// Per 4x4 block (raster over the picture), per list: motion vector,
    /// reference index (-1 = none) and the referenced picture's id.
    pub mv: [Vec<[i16; 2]>; 2],
    pub ref_idx: [Vec<i8>; 2],
    pub ref_id: [Vec<i32>; 2],
    /// Per macroblock.
    pub mb_intra: Vec<bool>,
    /// The caller's timestamp for this picture.
    pub pts: f64,
}

impl Picture {
    pub fn new(id: u32, width_mbs: usize, height_mbs: usize) -> Picture {
        let (w, h) = (width_mbs * 16, height_mbs * 16);
        let n4 = (w / 4) * (h / 4);
        Picture {
            id,
            width: w,
            height: h,
            y: vec![0; w * h],
            u: vec![128; w * h / 4],
            v: vec![128; w * h / 4],
            poc: 0,
            frame_num: 0,
            is_idr: false,
            is_ref: false,
            non_existing: false,
            mv: [vec![[0; 2]; n4], vec![[0; 2]; n4]],
            ref_idx: [vec![-1; n4], vec![-1; n4]],
            ref_id: [vec![-1; n4], vec![-1; n4]],
            mb_intra: vec![false; width_mbs * height_mbs],
            pts: 0.0,
        }
    }

    /// Make a reused picture buffer a fresh picture (its samples and motion
    /// are left as they were; every decoded macroblock overwrites its own).
    pub fn reset(&mut self, id: u32) {
        self.id = id;
        self.poc = 0;
        self.frame_num = 0;
        self.is_idr = false;
        self.is_ref = false;
        self.non_existing = false;
        self.pts = 0.0;
    }

    pub fn chroma_width(&self) -> usize {
        self.width / 2
    }
    pub fn chroma_height(&self) -> usize {
        self.height / 2
    }
}

/// A reference picture as seen from the current slice.
#[derive(Clone)]
pub struct RefPic {
    pub pic: Rc<Picture>,
    pub long_term: bool,
    pub poc: i32,
    /// PicNum (short-term) or LongTermPicNum.
    pub pic_num: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefKind {
    Short,
    Long,
}

pub struct DpbEntry {
    pub pic: Rc<Picture>,
    pub kind: RefKind,
    pub long_term_frame_idx: u32,
    /// The frame_num and POC the picture is referenced by (a memory
    /// management control operation 5 renumbers a picture after the fact).
    pub frame_num: u32,
    pub poc: i32,
}

/// The reference pictures and the state that carries between pictures.
pub struct Dpb {
    pub entries: Vec<DpbEntry>,
    /// Pictures that left the buffer since the decoder last reclaimed them
    /// (their sample buffers are reused once nobody else holds them).
    pub graveyard: Vec<Rc<Picture>>,
    /// None: "no long-term frame indices".
    pub max_long_term_frame_idx: Option<u32>,
    prev_ref_frame_num: u32,
    prev_poc_msb: i32,
    prev_poc_lsb: i32,
    prev_frame_num_offset: i32,
    prev_frame_num: u32,
    prev_had_mmco5: bool,
    next_id: u32,
    /// A reference picture has been marked (gaps in frame_num are relative
    /// to it; a stream that starts on a non-IDR picture has none to fill).
    started: bool,
}

impl Default for Dpb {
    fn default() -> Self {
        Self::new()
    }
}

/// The picture order count of a picture and the state to carry forward.
#[derive(Clone, Copy, Debug)]
pub struct PocState {
    pub poc: i32,
    poc_msb: i32,
    poc_lsb: i32,
    frame_num_offset: i32,
}

impl Dpb {
    pub fn new() -> Dpb {
        Dpb {
            entries: Vec::new(),
            graveyard: Vec::new(),
            max_long_term_frame_idx: None,
            prev_ref_frame_num: 0,
            prev_poc_msb: 0,
            prev_poc_lsb: 0,
            prev_frame_num_offset: 0,
            prev_frame_num: 0,
            prev_had_mmco5: false,
            next_id: 1,
            started: false,
        }
    }

    pub fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn clear(&mut self) {
        self.graveyard.extend(self.entries.drain(..).map(|e| e.pic));
        self.max_long_term_frame_idx = None;
    }

    /// Drop the entries matching `pred`, keeping their pictures for reuse.
    fn remove_where(&mut self, pred: impl Fn(&DpbEntry) -> bool) {
        let mut i = 0;
        while i < self.entries.len() {
            if pred(&self.entries[i]) {
                let e = self.entries.remove(i);
                self.graveyard.push(e.pic);
            } else {
                i += 1;
            }
        }
    }

    pub fn prev_ref_frame_num(&self) -> u32 {
        self.prev_ref_frame_num
    }

    /// 8.2.1: the picture order count of the picture a slice header starts.
    pub fn compute_poc(&self, sps: &Sps, hdr: &SliceHeader) -> PocState {
        let max_frame_num = sps.max_frame_num() as i32;
        match sps.poc_type {
            0 => {
                let max_lsb = 1i32 << sps.log2_max_poc_lsb;
                let (prev_msb, prev_lsb) = if hdr.is_idr() { (0, 0) } else if self.prev_had_mmco5 { (0, 0) } else { (self.prev_poc_msb, self.prev_poc_lsb) };
                let lsb = hdr.poc_lsb as i32;
                let msb = if lsb < prev_lsb && prev_lsb - lsb >= max_lsb / 2 {
                    prev_msb + max_lsb
                } else if lsb > prev_lsb && lsb - prev_lsb > max_lsb / 2 {
                    prev_msb - max_lsb
                } else {
                    prev_msb
                };
                let top = msb + lsb;
                let bottom = top + hdr.delta_poc_bottom;
                PocState { poc: top.min(bottom), poc_msb: msb, poc_lsb: lsb, frame_num_offset: 0 }
            }
            1 => {
                let prev_offset = if self.prev_had_mmco5 { 0 } else { self.prev_frame_num_offset };
                let frame_num_offset = if hdr.is_idr() {
                    0
                } else if self.prev_frame_num > hdr.frame_num {
                    prev_offset + max_frame_num
                } else {
                    prev_offset
                };
                let cycle = sps.offset_for_ref_frame.len() as i32;
                let mut abs_frame_num = if cycle != 0 { frame_num_offset + hdr.frame_num as i32 } else { 0 };
                if hdr.nal_ref_idc == 0 && abs_frame_num > 0 {
                    abs_frame_num -= 1;
                }
                let mut expected = 0i32;
                if abs_frame_num > 0 {
                    let cycle_cnt = (abs_frame_num - 1) / cycle;
                    let in_cycle = (abs_frame_num - 1) % cycle;
                    let delta_per_cycle: i32 = sps.offset_for_ref_frame.iter().sum();
                    expected = cycle_cnt * delta_per_cycle;
                    for k in 0..=in_cycle as usize {
                        expected += sps.offset_for_ref_frame[k];
                    }
                }
                if hdr.nal_ref_idc == 0 {
                    expected += sps.offset_for_non_ref_pic;
                }
                let top = expected + hdr.delta_poc[0];
                let bottom = top + sps.offset_for_top_to_bottom_field + hdr.delta_poc[1];
                PocState { poc: top.min(bottom), poc_msb: 0, poc_lsb: 0, frame_num_offset }
            }
            _ => {
                let prev_offset = if self.prev_had_mmco5 { 0 } else { self.prev_frame_num_offset };
                let frame_num_offset = if hdr.is_idr() {
                    0
                } else if self.prev_frame_num > hdr.frame_num {
                    prev_offset + max_frame_num
                } else {
                    prev_offset
                };
                let poc = if hdr.is_idr() {
                    0
                } else if hdr.nal_ref_idc == 0 {
                    2 * (frame_num_offset + hdr.frame_num as i32) - 1
                } else {
                    2 * (frame_num_offset + hdr.frame_num as i32)
                };
                PocState { poc, poc_msb: 0, poc_lsb: 0, frame_num_offset }
            }
        }
    }

    /// The PicNum of a short-term entry relative to the current frame_num.
    fn frame_num_wrap(&self, sps: &Sps, entry_frame_num: u32, cur_frame_num: u32) -> i32 {
        if entry_frame_num > cur_frame_num {
            entry_frame_num as i32 - sps.max_frame_num() as i32
        } else {
            entry_frame_num as i32
        }
    }

    fn ref_pics(&self, sps: &Sps, cur_frame_num: u32) -> Vec<RefPic> {
        self.entries
            .iter()
            .map(|e| RefPic {
                pic: e.pic.clone(),
                long_term: e.kind == RefKind::Long,
                poc: e.poc,
                pic_num: if e.kind == RefKind::Long { e.long_term_frame_idx as i32 } else { self.frame_num_wrap(sps, e.frame_num, cur_frame_num) },
            })
            .collect()
    }

    /// 8.2.4.2 + 8.2.4.3: the reference picture lists of a slice.
    pub fn ref_lists(&self, sps: &Sps, hdr: &SliceHeader, cur_poc: i32) -> Result<[Vec<RefPic>; 2]> {
        let all = self.ref_pics(sps, hdr.frame_num);
        let mut lists: [Vec<RefPic>; 2] = [Vec::new(), Vec::new()];
        match hdr.slice_type {
            SliceType::I => return Ok(lists),
            SliceType::P => {
                let mut short: Vec<RefPic> = all.iter().filter(|r| !r.long_term).cloned().collect();
                short.sort_by(|a, b| b.pic_num.cmp(&a.pic_num));
                let mut long: Vec<RefPic> = all.iter().filter(|r| r.long_term).cloned().collect();
                long.sort_by(|a, b| a.pic_num.cmp(&b.pic_num));
                lists[0] = short;
                lists[0].extend(long);
            }
            SliceType::B => {
                let mut before: Vec<RefPic> = all.iter().filter(|r| !r.long_term && r.poc <= cur_poc).cloned().collect();
                before.sort_by(|a, b| b.poc.cmp(&a.poc));
                let mut after: Vec<RefPic> = all.iter().filter(|r| !r.long_term && r.poc > cur_poc).cloned().collect();
                after.sort_by(|a, b| a.poc.cmp(&b.poc));
                let mut long: Vec<RefPic> = all.iter().filter(|r| r.long_term).cloned().collect();
                long.sort_by(|a, b| a.pic_num.cmp(&b.pic_num));
                let mut l0 = before.clone();
                l0.extend(after.iter().cloned());
                l0.extend(long.iter().cloned());
                let mut l1 = after;
                l1.extend(before);
                l1.extend(long);
                if l1.len() > 1 && l1.len() == l0.len() && l1.iter().zip(&l0).all(|(a, b)| a.pic.id == b.pic.id) {
                    l1.swap(0, 1);
                }
                lists[0] = l0;
                lists[1] = l1;
            }
        }
        let max_pic_num = sps.max_frame_num() as i32;
        let cur_pic_num = hdr.frame_num as i32;
        for l in 0..2 {
            let n = hdr.num_ref_idx_active[l] as usize;
            if n == 0 {
                lists[l].clear();
                continue;
            }
            lists[l].truncate(n);
            if !hdr.ref_list_mods[l].is_empty() {
                let mut pred = cur_pic_num;
                let mut list = lists[l].clone();
                for (idx, op) in hdr.ref_list_mods[l].iter().enumerate() {
                    if idx >= n {
                        return Err(Error::Bitstream("too many reference list modifications"));
                    }
                    let entry = match *op {
                        RefListMod::ShortTermSub(d) | RefListMod::ShortTermAdd(d) => {
                            let mut no_wrap = if matches!(op, RefListMod::ShortTermSub(_)) { pred - d as i32 } else { pred + d as i32 };
                            if no_wrap < 0 {
                                no_wrap += max_pic_num;
                            } else if no_wrap >= max_pic_num {
                                no_wrap -= max_pic_num;
                            }
                            pred = no_wrap;
                            let pic_num = if no_wrap > cur_pic_num { no_wrap - max_pic_num } else { no_wrap };
                            all.iter().find(|r| !r.long_term && r.pic_num == pic_num).cloned()
                        }
                        RefListMod::LongTerm(num) => all.iter().find(|r| r.long_term && r.pic_num == num as i32).cloned(),
                    };
                    let Some(entry) = entry else {
                        return Err(Error::Bitstream("reference list modification names a missing picture"));
                    };
                    // insert at idx, drop the later duplicate
                    list.insert(idx.min(list.len()), entry.clone());
                    let mut k = idx + 1;
                    while k < list.len() {
                        if list[k].pic.id == entry.pic.id && list[k].long_term == entry.long_term {
                            list.remove(k);
                        } else {
                            k += 1;
                        }
                    }
                    list.truncate(n);
                }
                lists[l] = list;
            }
            if lists[l].is_empty() {
                return Err(Error::Bitstream("no reference pictures for an inter slice"));
            }
            // entries past the initial list are "no reference picture"; repeat
            // the last one so a broken stream is concealed rather than a panic
            while lists[l].len() < n {
                let last = lists[l].last().unwrap().clone();
                lists[l].push(last);
            }
        }
        Ok(lists)
    }

    /// 8.2.5.2: insert the frames a gap in frame_num skipped (or that were
    /// lost), so the reference picture numbering stays consistent. `fill`
    /// makes the picture used to stand in for them.
    pub fn fill_frame_num_gap(&mut self, sps: &Sps, hdr: &SliceHeader, fill: &dyn Fn(u32, u32) -> Picture) {
        if hdr.is_idr() || !self.started {
            return;
        }
        let max = sps.max_frame_num();
        let prev = self.prev_ref_frame_num;
        if hdr.frame_num == prev || hdr.frame_num == (prev + 1) % max {
            return;
        }
        let mut num = (prev + 1) % max;
        let mut guard = 0;
        while num != hdr.frame_num && guard < 64 {
            let id = self.alloc_id();
            let mut pic = fill(id, num);
            pic.frame_num = num;
            pic.non_existing = true;
            pic.is_ref = true;
            self.sliding_window(sps);
            self.entries.push(DpbEntry { frame_num: pic.frame_num, poc: pic.poc, pic: Rc::new(pic), kind: RefKind::Short, long_term_frame_idx: 0 });
            self.prev_ref_frame_num = num;
            num = (num + 1) % max;
            guard += 1;
        }
    }

    fn sliding_window(&mut self, sps: &Sps) {
        let num_ref = self.entries.len();
        if num_ref >= sps.max_num_ref_frames.max(1) as usize {
            // remove the short-term reference with the smallest FrameNumWrap
            let cur = self.prev_ref_frame_num;
            let mut worst: Option<(usize, i32)> = None;
            for (i, e) in self.entries.iter().enumerate() {
                if e.kind != RefKind::Short {
                    continue;
                }
                let fnw = self.frame_num_wrap(sps, e.frame_num, cur);
                if worst.map_or(true, |(_, w)| fnw < w) {
                    worst = Some((i, fnw));
                }
            }
            if let Some((i, _)) = worst {
                let e = self.entries.remove(i);
                self.graveyard.push(e.pic);
            }
        }
    }

    /// 8.2.5: reference marking after decoding a picture, and the state
    /// updates for the next one. Returns the (possibly reset) POC.
    pub fn mark(&mut self, sps: &Sps, hdr: &SliceHeader, pic: Rc<Picture>, poc: PocState) -> Result<()> {
        let mut had_mmco5 = false;
        if hdr.is_ref() {
            if hdr.is_idr() {
                self.clear();
                if hdr.long_term_reference {
                    self.entries.push(DpbEntry { pic: pic.clone(), kind: RefKind::Long, long_term_frame_idx: 0, frame_num: pic.frame_num, poc: pic.poc });
                    self.max_long_term_frame_idx = Some(0);
                } else {
                    self.entries.push(DpbEntry { pic: pic.clone(), kind: RefKind::Short, long_term_frame_idx: 0, frame_num: pic.frame_num, poc: pic.poc });
                    self.max_long_term_frame_idx = None;
                }
            } else {
                let mut current_long: Option<u32> = None;
                match &hdr.mmco {
                    None => self.sliding_window(sps),
                    Some(ops) => {
                        let cur_pic_num = hdr.frame_num as i32;
                        for op in ops {
                            match *op {
                                Mmco::UnmarkShortTerm(d) => {
                                    let pic_num = cur_pic_num - d as i32;
                                    let cur = hdr.frame_num;
                                    self.remove_where(|e| e.kind == RefKind::Short && frame_num_wrap_static(sps, e.frame_num, cur) == pic_num);
                                }
                                Mmco::UnmarkLongTerm(num) => {
                                    self.remove_where(|e| e.kind == RefKind::Long && e.long_term_frame_idx == num);
                                }
                                Mmco::ShortToLong(d, idx) => {
                                    let pic_num = cur_pic_num - d as i32;
                                    let cur = hdr.frame_num;
                                    // a long-term picture already holding this index is unmarked
                                    self.remove_where(|e| e.kind == RefKind::Long && e.long_term_frame_idx == idx);
                                    for e in self.entries.iter_mut() {
                                        if e.kind == RefKind::Short && frame_num_wrap_static(sps, e.frame_num, cur) == pic_num {
                                            e.kind = RefKind::Long;
                                            e.long_term_frame_idx = idx;
                                        }
                                    }
                                }
                                Mmco::MaxLongTermIdx(plus1) => {
                                    self.max_long_term_frame_idx = if plus1 == 0 { None } else { Some(plus1 - 1) };
                                    let max = self.max_long_term_frame_idx;
                                    self.remove_where(|e| e.kind == RefKind::Long && max.map_or(true, |m| e.long_term_frame_idx > m));
                                }
                                Mmco::UnmarkAll => {
                                    self.clear();
                                    had_mmco5 = true;
                                }
                                Mmco::CurrentToLong(idx) => {
                                    self.remove_where(|e| e.kind == RefKind::Long && e.long_term_frame_idx == idx);
                                    current_long = Some(idx);
                                }
                            }
                        }
                        if current_long.is_none() && self.entries.len() >= sps.max_num_ref_frames.max(1) as usize {
                            // a stream that forgot to make room: behave like the sliding window
                            self.sliding_window(sps);
                        }
                    }
                }
                // after a memory_management_control_operation 5 the picture counts as frame_num 0 with POC 0
                let (frame_num, poc_after) = if had_mmco5 { (0, 0) } else { (pic.frame_num, pic.poc) };
                match current_long {
                    Some(idx) => self.entries.push(DpbEntry { pic: pic.clone(), kind: RefKind::Long, long_term_frame_idx: idx, frame_num, poc: poc_after }),
                    None => self.entries.push(DpbEntry { pic: pic.clone(), kind: RefKind::Short, long_term_frame_idx: 0, frame_num, poc: poc_after }),
                }
            }
        }
        // state for the next picture
        let frame_num_after = if had_mmco5 { 0 } else { hdr.frame_num };
        if hdr.is_ref() {
            self.started = true;
            self.prev_ref_frame_num = frame_num_after;
            if had_mmco5 {
                // 8.2.1: after mmco 5 the picture's POC counts from zero
                self.prev_poc_msb = 0;
                self.prev_poc_lsb = 0;
            } else {
                self.prev_poc_msb = poc.poc_msb;
                self.prev_poc_lsb = poc.poc_lsb;
            }
        }
        self.prev_frame_num = frame_num_after;
        self.prev_frame_num_offset = if had_mmco5 { 0 } else { poc.frame_num_offset };
        self.prev_had_mmco5 = had_mmco5;
        Ok(())
    }

}

fn frame_num_wrap_static(sps: &Sps, entry_frame_num: u32, cur: u32) -> i32 {
    if entry_frame_num > cur {
        entry_frame_num as i32 - sps.max_frame_num() as i32
    } else {
        entry_frame_num as i32
    }
}
