//! The CABAC arithmetic decoding engine and the binarizations of the
//! syntax elements (9.3). Context index increments that depend on
//! neighbouring macroblocks are computed by the caller and passed in.

use crate::tables::{CABAC_INIT_I, CABAC_INIT_PB, RANGE_LPS, TRANS_LPS, TRANS_MPS};
use crate::{Error, Result};

/// rangeTabLPS indexed by the combined context state (pStateIdx << 1 | valMPS).
const LPS_RANGE: [[u8; 4]; 128] = {
    let mut t = [[0u8; 4]; 128];
    let mut s = 0;
    while s < 128 {
        t[s] = RANGE_LPS[s >> 1];
        s += 1;
    }
    t
};
/// The next combined state after an MPS / an LPS.
const NEXT_MPS: [u8; 128] = {
    let mut t = [0u8; 128];
    let mut s = 0;
    while s < 128 {
        t[s] = (TRANS_MPS[s >> 1] << 1) | (s as u8 & 1);
        s += 1;
    }
    t
};
const NEXT_LPS: [u8; 128] = {
    let mut t = [0u8; 128];
    let mut s = 0;
    while s < 128 {
        let mps = s as u8 & 1;
        t[s] = (TRANS_LPS[s >> 1] << 1) | if s >> 1 == 0 { 1 - mps } else { mps };
        s += 1;
    }
    t
};

/// ctxIdxInc of significant_coeff_flag / last_significant_coeff_flag for
/// the block categories where it is the scan position.
const CTX_IDENTITY: [u8; 63] = {
    let mut t = [0u8; 63];
    let mut i = 0;
    while i < 63 {
        t[i] = i as u8;
        i += 1;
    }
    t
};
/// The same for chroma DC: Min(i, 2).
const CTX_CHROMA_DC: [u8; 3] = [0, 1, 2];

pub struct Cabac<'a> {
    data: &'a [u8],
    /// the next byte to fetch
    pos: usize,
    range: u32,
    /// codIOffset scaled by 2^7, with up to 7 not yet needed bits below it
    value: u32,
    /// shifts until the next byte must be fetched, minus 8 (-8..=-1)
    bits_needed: i32,
    /// (pStateIdx << 1) | valMPS
    ctx: [u8; 1024],
}

impl<'a> Cabac<'a> {
    /// Start decoding slice data at byte `byte_pos` of `data`, with the
    /// context variables initialised for the slice (9.3.1.1, 9.3.1.2).
    pub fn new(data: &'a [u8], byte_pos: usize, is_i_slice: bool, cabac_init_idc: u32, slice_qp: i32) -> Result<Cabac<'a>> {
        let mut c = Cabac { data, pos: byte_pos, range: 510, value: 0, bits_needed: -8, ctx: [0; 1024] };
        let qp = slice_qp.clamp(0, 51);
        let table: &[[i8; 2]; 1024] = if is_i_slice { &CABAC_INIT_I } else { &CABAC_INIT_PB[cabac_init_idc as usize] };
        for i in 0..1024 {
            let (m, n) = (table[i][0] as i32, table[i][1] as i32);
            let pre = (((m * qp) >> 4) + n).clamp(1, 126);
            c.ctx[i] = if pre <= 63 { ((63 - pre) << 1) as u8 } else { (((pre - 64) << 1) | 1) as u8 };
        }
        c.restart(byte_pos)?;
        Ok(c)
    }

    /// (Re-)initialise the arithmetic decoding engine at a byte position
    /// (9.3.1.2; after PCM samples), keeping the context variables.
    pub fn restart(&mut self, byte_pos: usize) -> Result<()> {
        self.pos = byte_pos;
        self.range = 510;
        self.value = (self.next_byte() as u32) << 8;
        self.value |= self.next_byte() as u32;
        self.bits_needed = -8;
        if self.value >> 7 >= 510 {
            return Err(Error::Bitstream("bad CABAC initialisation"));
        }
        Ok(())
    }

    /// The byte at which the PCM samples of an I_PCM macroblock start once
    /// its mb_type has been decoded: the arithmetic decoder has consumed
    /// every bit before it (9.3.1.2).
    pub fn byte_pos(&self) -> usize {
        self.pos
    }

    pub fn data(&self) -> &'a [u8] {
        self.data
    }

    #[inline(always)]
    fn next_byte(&mut self) -> u8 {
        match self.data.get(self.pos) {
            Some(&b) => {
                self.pos += 1;
                b
            }
            None => 0,
        }
    }

    /// 9.3.3.2.1 DecodeDecision.
    #[inline]
    pub fn decision(&mut self, ctx_idx: usize) -> u32 {
        let s = self.ctx[ctx_idx] as usize;
        let lps = LPS_RANGE[s][((self.range >> 6) & 3) as usize] as u32;
        self.range -= lps;
        let scaled = self.range << 7;
        if self.value < scaled {
            self.ctx[ctx_idx] = NEXT_MPS[s];
            if scaled < (256 << 7) {
                // one renormalisation shift at most on the MPS path
                self.range = scaled >> 6;
                self.value <<= 1;
                self.bits_needed += 1;
                if self.bits_needed == 0 {
                    self.bits_needed = -8;
                    self.value |= self.next_byte() as u32;
                }
            }
            (s & 1) as u32
        } else {
            let n = lps.leading_zeros() - 23;
            self.value = (self.value - scaled) << n;
            self.range = lps << n;
            self.ctx[ctx_idx] = NEXT_LPS[s];
            self.bits_needed += n as i32;
            if self.bits_needed >= 0 {
                self.value |= (self.next_byte() as u32) << self.bits_needed;
                self.bits_needed -= 8;
            }
            (!s & 1) as u32
        }
    }

    /// 9.3.3.2.3 DecodeBypass.
    #[inline]
    pub fn bypass(&mut self) -> u32 {
        self.value <<= 1;
        self.bits_needed += 1;
        if self.bits_needed >= 0 {
            self.bits_needed = -8;
            self.value |= self.next_byte() as u32;
        }
        let scaled = self.range << 7;
        if self.value >= scaled {
            self.value -= scaled;
            1
        } else {
            0
        }
    }

    /// 9.3.3.2.4 DecodeTerminate.
    pub fn terminate(&mut self) -> u32 {
        self.range -= 2;
        let scaled = self.range << 7;
        if self.value >= scaled {
            1
        } else {
            if scaled < (256 << 7) {
                self.range = scaled >> 6;
                self.value <<= 1;
                self.bits_needed += 1;
                if self.bits_needed == 0 {
                    self.bits_needed = -8;
                    self.value |= self.next_byte() as u32;
                }
            }
            0
        }
    }

    // ---- binarizations (9.3.2) with their context assignments (Table 9-34) ----

    /// mb_skip_flag; `inc` = condTermFlagA + condTermFlagB.
    pub fn mb_skip_flag(&mut self, is_b: bool, inc: usize) -> bool {
        self.decision(if is_b { 24 } else { 11 } + inc) != 0
    }

    /// The I-slice macroblock types (0..=25) after the shared prefix. `ctx0`
    /// is the context of the first bin, `rest` the contexts of bins 2..6
    /// (see Table 9-39: [b2, b3, b4 when b3 == 1, next, next]).
    fn mb_type_i_tail(&mut self, ctx0: usize, rest: [usize; 5]) -> u32 {
        if self.decision(ctx0) == 0 {
            return 0; // I_NxN
        }
        if self.terminate() != 0 {
            return 25; // I_PCM
        }
        let luma = self.decision(rest[0]);
        let chroma;
        let pm;
        if self.decision(rest[1]) != 0 {
            chroma = 1 + self.decision(rest[2]);
            pm = (self.decision(rest[3]) << 1) | self.decision(rest[4]);
        } else {
            chroma = 0;
            pm = (self.decision(rest[3]) << 1) | self.decision(rest[4]);
        }
        1 + pm + 4 * chroma + 12 * luma
    }

    /// mb_type in an I slice; `inc` from the neighbours (9.3.3.1.1.3).
    pub fn mb_type_i(&mut self, inc: usize) -> u32 {
        self.mb_type_i_tail(3 + inc, [6, 7, 8, 9, 10])
    }

    /// mb_type in a P slice: 0..=4 are the P types (P_8x8ref0 never
    /// occurs), 5..=30 the intra types offset by 5.
    pub fn mb_type_p(&mut self) -> u32 {
        if self.decision(14) != 0 {
            return 5 + self.mb_type_i_tail(17, [18, 19, 19, 20, 20]);
        }
        if self.decision(15) == 0 {
            if self.decision(16) == 0 {
                0 // P_L0_16x16
            } else {
                3 // P_8x8
            }
        } else if self.decision(17) == 0 {
            2 // P_L0_L0_8x16
        } else {
            1 // P_L0_L0_16x8
        }
    }

    /// mb_type in a B slice: 0..=22 the B types, 23..=48 the intra types
    /// offset by 23.
    pub fn mb_type_b(&mut self, inc: usize) -> u32 {
        if self.decision(27 + inc) == 0 {
            return 0; // B_Direct_16x16
        }
        if self.decision(30) == 0 {
            return 1 + self.decision(32);
        }
        let mut bits = self.decision(31) << 3;
        bits |= self.decision(32) << 2;
        bits |= self.decision(32) << 1;
        bits |= self.decision(32);
        if bits < 8 {
            return bits + 3;
        }
        match bits {
            13 => 23 + self.mb_type_i_tail(32, [33, 34, 34, 35, 35]),
            14 => 11,
            15 => 22,
            _ => ((bits << 1) | self.decision(32)) - 4,
        }
    }

    pub fn sub_mb_type_p(&mut self) -> u32 {
        if self.decision(21) != 0 {
            return 0;
        }
        if self.decision(22) == 0 {
            return 1;
        }
        if self.decision(23) != 0 {
            2
        } else {
            3
        }
    }

    pub fn sub_mb_type_b(&mut self) -> u32 {
        if self.decision(36) == 0 {
            return 0;
        }
        if self.decision(37) == 0 {
            return 1 + self.decision(39);
        }
        let mut t = 3;
        if self.decision(38) != 0 {
            if self.decision(39) != 0 {
                return 11 + self.decision(39);
            }
            t += 4;
        }
        t += 2 * self.decision(39);
        t += self.decision(39);
        t
    }

    /// prev_intra4x4_pred_mode_flag / prev_intra8x8_pred_mode_flag.
    pub fn prev_intra_pred_mode_flag(&mut self) -> bool {
        self.decision(68) != 0
    }

    /// rem_intra4x4_pred_mode / rem_intra8x8_pred_mode (3 bins, LSB first).
    pub fn rem_intra_pred_mode(&mut self) -> u32 {
        let b0 = self.decision(69);
        let b1 = self.decision(69);
        let b2 = self.decision(69);
        b0 | (b1 << 1) | (b2 << 2)
    }

    /// intra_chroma_pred_mode; `inc` = condTermFlagA + condTermFlagB.
    pub fn intra_chroma_pred_mode(&mut self, inc: usize) -> u32 {
        if self.decision(64 + inc) == 0 {
            return 0;
        }
        if self.decision(67) == 0 {
            return 1;
        }
        if self.decision(67) == 0 {
            2
        } else {
            3
        }
    }

    /// ref_idx_lX; `inc` = condTermFlagA + 2 * condTermFlagB.
    pub fn ref_idx(&mut self, inc: usize) -> Result<u32> {
        if self.decision(54 + inc) == 0 {
            return Ok(0);
        }
        let mut v = 1;
        let mut ctx = 58;
        while self.decision(ctx) != 0 {
            v += 1;
            ctx = 59;
            if v > 32 {
                return Err(Error::Bitstream("ref_idx too large"));
            }
        }
        Ok(v)
    }

    /// One component of mvd_lX; `abs_sum` = absMvdCompA + absMvdCompB.
    pub fn mvd(&mut self, component: usize, abs_sum: u32) -> Result<i32> {
        let base = if component == 0 { 40 } else { 47 };
        let inc = if abs_sum < 3 {
            0
        } else if abs_sum > 32 {
            2
        } else {
            1
        };
        if self.decision(base + inc) == 0 {
            return Ok(0);
        }
        let mut v = 1u32;
        let mut ctx = 3;
        while v < 9 && self.decision(base + ctx) != 0 {
            if ctx < 6 {
                ctx += 1;
            }
            v += 1;
        }
        if v >= 9 {
            let mut k = 3;
            while self.bypass() != 0 {
                v += 1 << k;
                k += 1;
                if k > 24 {
                    return Err(Error::Bitstream("mvd too large"));
                }
            }
            while k > 0 {
                k -= 1;
                v += self.bypass() << k;
            }
        }
        Ok(if self.bypass() != 0 { -(v as i32) } else { v as i32 })
    }

    /// coded_block_pattern: luma bits from the four 8x8 blocks then chroma.
    /// `luma_inc(b8, prior_bits)` gives ctxIdxInc for luma block `b8` given
    /// the bits decoded so far; `chroma_inc` the two chroma increments.
    pub fn coded_block_pattern(&mut self, luma_inc: &dyn Fn(usize, u32) -> usize, chroma_inc: [usize; 2]) -> u32 {
        let mut cbp = 0u32;
        for b8 in 0..4 {
            let inc = luma_inc(b8, cbp);
            cbp |= self.decision(73 + inc) << b8;
        }
        if self.decision(77 + chroma_inc[0]) != 0 {
            cbp |= (1 + self.decision(77 + 4 + chroma_inc[1])) << 4;
        }
        cbp
    }

    /// mb_qp_delta; `inc` from the previous macroblock (9.3.3.1.1.5).
    pub fn mb_qp_delta(&mut self, inc: usize) -> Result<i32> {
        if self.decision(60 + inc) == 0 {
            return Ok(0);
        }
        let mut k = 1u32;
        let mut ctx = 62;
        while self.decision(ctx) != 0 {
            k += 1;
            ctx = 63;
            if k > 52 {
                return Err(Error::Bitstream("mb_qp_delta too large"));
            }
        }
        Ok(if k & 1 == 1 { ((k + 1) / 2) as i32 } else { -((k / 2) as i32) })
    }

    /// transform_size_8x8_flag; `inc` = condTermFlagA + condTermFlagB.
    pub fn transform_size_8x8_flag(&mut self, inc: usize) -> bool {
        self.decision(399 + inc) != 0
    }

    /// coded_block_flag for a block of category `cat` (0..=4);
    /// `inc` = condTermFlagA + 2 * condTermFlagB.
    pub fn coded_block_flag(&mut self, cat: usize, inc: usize) -> bool {
        self.decision(85 + 4 * cat + inc) != 0
    }

    /// The coefficient levels of a block whose coded_block_flag is 1 (or
    /// inferred). `cat` is ctxBlockCat (0 luma DC, 1 luma AC, 2 luma 4x4,
    /// 3 chroma DC, 4 chroma AC, 5 luma 8x8); `max` the number of
    /// coefficients (16, 15, 16, 4, 15, 64). Levels are written to
    /// `coeffs[start + i]` in scan order (`start` = 1 for AC blocks).
    /// Returns the number of non-zero levels.
    pub fn residual_block(&mut self, cat: usize, max: usize, start: usize, coeffs: &mut [i32], field: bool) -> Result<u32> {
        // Table 9-34: field macroblocks use their own significance contexts
        let (sig0, last0) = if field { (277, 338) } else { (105, 166) };
        let (sig_base, last_base, abs_base) = match cat {
            0 => (sig0, last0, 227),
            1 => (sig0 + 15, last0 + 15, 227 + 10),
            2 => (sig0 + 29, last0 + 29, 227 + 20),
            3 => (sig0 + 44, last0 + 44, 227 + 30),
            4 => (sig0 + 47, last0 + 47, 227 + 39),
            _ => (if field { 436 } else { 402 }, if field { 451 } else { 417 }, 426),
        };
        let (sig_tab, last_tab): (&[u8], &[u8]) = match cat {
            3 => (&CTX_CHROMA_DC, &CTX_CHROMA_DC),
            5 => (if field { &crate::tables::SIG_COEFF_8X8_FIELD } else { &crate::tables::SIG_COEFF_8X8 }, &crate::tables::LAST_COEFF_8X8),
            _ => (&CTX_IDENTITY, &CTX_IDENTITY),
        };
        // positions of the significant coefficients, in scan order
        let mut sig = [0u8; 64];
        let mut nsig = 0usize;
        let mut i = 0;
        let mut last_found = false;
        while i < max - 1 {
            if self.decision(sig_base + sig_tab[i] as usize) != 0 {
                sig[nsig] = i as u8;
                nsig += 1;
                if self.decision(last_base + last_tab[i] as usize) != 0 {
                    last_found = true;
                    break;
                }
            }
            i += 1;
        }
        if !last_found {
            sig[nsig] = (max - 1) as u8;
            nsig += 1;
        }
        let mut num_gt1 = 0usize;
        let mut num_eq1 = 0usize;
        let abs_cap = 4 - (cat == 3) as usize;
        for k in (0..nsig).rev() {
            let i = sig[k] as usize;
            // coeff_abs_level_minus1: prefix TU (cMax 14) then EG0 suffix
            let inc0 = if num_gt1 != 0 { 0 } else { (1 + num_eq1).min(4) };
            let mut abs_m1: u32;
            if self.decision(abs_base + inc0) == 0 {
                abs_m1 = 0;
            } else {
                let inc = 5 + num_gt1.min(abs_cap);
                abs_m1 = 1;
                while abs_m1 < 14 && self.decision(abs_base + inc) != 0 {
                    abs_m1 += 1;
                }
                if abs_m1 >= 14 {
                    let mut k = 0;
                    while self.bypass() != 0 {
                        abs_m1 += 1 << k;
                        k += 1;
                        if k > 24 {
                            return Err(Error::Bitstream("coefficient too large"));
                        }
                    }
                    while k > 0 {
                        k -= 1;
                        abs_m1 += self.bypass() << k;
                    }
                }
            }
            if abs_m1 == 0 {
                num_eq1 += 1;
            } else {
                num_gt1 += 1;
            }
            let level = abs_m1 as i32 + 1;
            coeffs[start + i] = if self.bypass() != 0 { -level } else { level };
        }
        Ok(nsig as u32)
    }

    /// end_of_slice_flag.
    pub fn end_of_slice(&mut self) -> bool {
        self.terminate() != 0
    }
}
