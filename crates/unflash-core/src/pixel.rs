//! The per-pixel state machine, on the integer clock of [`crate::time`].
//!
//! This is a straight port of the reference's `_ExtremaTracker`,
//! `_FlashCounter` and `_Pool`, restated per pixel so that one function
//! describes exactly what the WGSL `update` pass in `unflash-gpu` does. The
//! two are kept in lock-step by tests that run both over the same frames and
//! compare masks and onsets bit for bit.
//!
//! State is stored structure-of-arrays (one `Vec` per field) so the SIMD
//! kernel in [`crate::pixel_simd`] and the GPU (one `array<u32>` with a
//! stride of `npix` per field) share a layout.

use bytemuck::{Pod, Zeroable};

use crate::config::DetectorConfig;
use crate::grid::{
    GridGeometry, MASK_EXT_GEN, MASK_EXT_RED, MASK_POOL_GEN_DN, MASK_POOL_GEN_UP,
    MASK_POOL_RED_DN, MASK_POOL_RED_UP, MASK_STROBE_GEN, MASK_STROBE_RED,
};
use crate::lut::{lut, pixel_values};
use crate::time::{age, dur_to_us, never, saturate};

/// How long a pixel may go on accumulating one monotonic run before the run
/// is re-anchored to where it has got to (see DETECTION.md, "finite memory").
pub const MAX_RUN_SECONDS: f64 = 2.0;

/// `KernelParams::mode` bits.
pub const MODE_FIRST: u32 = 1;
pub const MODE_HELD: u32 = 2;
pub const MODE_SATURATE: u32 = 4;

// `flags` word layout. dir / pol: 0 = flat / none, 1 = up (+1), 2 = down (-1).
const LUM_DIR_SHIFT: u32 = 0;
const RED_DIR_SHIFT: u32 = 2;
const RED_AUX_BASE: u32 = 1 << 4;
const RED_AUX_EXT: u32 = 1 << 5;
const GEN_PEND_SHIFT: u32 = 6;
const RED_PEND_SHIFT: u32 = 8;
const POOL_GEN_SHIFT: u32 = 10;
const POOL_RED_SHIFT: u32 = 12;
const DIR_MASK: u32 = 3;
const UP: u32 = 1;
const DN: u32 = 2;

/// Everything the kernels need per frame, `repr(C)` so it doubles as the
/// GPU uniform block (80 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct KernelParams {
    /// Internal clock, microseconds (wrapping).
    pub now: u32,
    /// MODE_* bits.
    pub mode: u32,
    pub npix: u32,
    pub width: u32,
    /// Luminance deadband.
    pub eps_l: f32,
    /// Red-scale deadband.
    pub eps_v: f32,
    pub swing: f32,
    pub dark: f32,
    pub red_delta: f32,
    /// Run cap, µs.
    pub max_run: u32,
    /// Max age of a pending opposite transition to pair with, µs (1 s).
    pub pair: u32,
    /// The k-th most recent flash must be younger than this, µs (0.999 s).
    pub rate: u32,
    /// Freshness window for concurrency, µs.
    pub fresh: u32,
    /// Pooling window for the chart areas, µs.
    pub pool: u32,
    /// Ring depth used by the failure test (K).
    pub k_fail: u32,
    /// Ring depth used by the extended test.
    pub k_ext: u32,
    pub held_delta: f32,
    /// Moved-pixel count below which a frame is a re-show.
    pub held_bar: u32,
    pub height: u32,
    pub red_saturation: f32,
}

impl KernelParams {
    /// Frame-independent part of the parameters for a configuration.
    pub fn template(cfg: &DetectorConfig, geom: &GridGeometry) -> Self {
        KernelParams {
            now: 0,
            mode: 0,
            npix: geom.npix() as u32,
            width: geom.aw,
            eps_l: cfg.noise_eps,
            eps_v: cfg.red_noise_eps,
            swing: cfg.swing_threshold,
            dark: cfg.dark_threshold,
            red_delta: cfg.red_delta_threshold,
            max_run: dur_to_us(MAX_RUN_SECONDS),
            pair: dur_to_us(1.0),
            rate: dur_to_us(1.0 - 1e-3),
            fresh: dur_to_us(cfg.area_accum_window),
            pool: dur_to_us(cfg.area_accum_window),
            k_fail: cfg.k_fail(),
            k_ext: cfg.ext_rate().clamp(1, cfg.k_fail()),
            held_delta: geom.held_delta,
            held_bar: geom.held_bar_int(),
            height: geom.ah,
            red_saturation: cfg.red_saturation,
        }
    }

    /// Ring depth K = floor(limit) + 1.
    pub fn ring_len(&self) -> usize {
        self.k_fail as usize
    }

    #[inline]
    pub fn first(&self) -> bool {
        self.mode & MODE_FIRST != 0
    }
    #[inline]
    pub fn held(&self) -> bool {
        self.mode & MODE_HELD != 0
    }
    #[inline]
    pub fn saturate(&self) -> bool {
        self.mode & MODE_SATURATE != 0
    }
}

/// Field order inside the GPU's single state buffer (each field is a run of
/// `npix` u32/f32 values). Ring fields occupy K consecutive runs.
#[derive(Clone, Copy, Debug)]
pub struct StateLayout {
    pub k: usize,
}

impl StateLayout {
    pub const LUM_BASE: usize = 0;
    pub const LUM_EXT: usize = 1;
    pub const LUM_T: usize = 2;
    pub const RED_BASE: usize = 3;
    pub const RED_EXT: usize = 4;
    pub const RED_T: usize = 5;
    pub const FLAGS: usize = 6;
    pub const GEN_RING: usize = 7;
    pub fn gen_open(&self) -> usize {
        Self::GEN_RING + self.k
    }
    pub fn gen_last(&self) -> usize {
        Self::GEN_RING + 2 * self.k
    }
    pub fn gen_pend_t(&self) -> usize {
        self.gen_last() + 1
    }
    pub fn red_ring(&self) -> usize {
        self.gen_pend_t() + 1
    }
    pub fn red_open(&self) -> usize {
        self.red_ring() + self.k
    }
    pub fn red_last(&self) -> usize {
        self.red_ring() + 2 * self.k
    }
    pub fn red_pend_t(&self) -> usize {
        self.red_last() + 1
    }
    pub fn pool_gen_t(&self) -> usize {
        self.red_pend_t() + 1
    }
    pub fn pool_red_t(&self) -> usize {
        self.pool_gen_t() + 1
    }
    pub fn prev_l(&self) -> usize {
        self.pool_red_t() + 1
    }
    /// Number of `npix`-sized runs in the state buffer.
    pub fn fields(&self) -> usize {
        self.prev_l() + 1
    }
}

/// Structure-of-arrays per-pixel state.
#[derive(Clone, Debug)]
pub struct PixelState {
    pub n: usize,
    pub k: usize,
    pub lum_base: Vec<f32>,
    pub lum_ext: Vec<f32>,
    pub lum_t: Vec<u32>,
    pub red_base: Vec<f32>,
    pub red_ext: Vec<f32>,
    pub red_t: Vec<u32>,
    pub flags: Vec<u32>,
    /// Slot-major: `ring[s * n + i]` is slot `s` (0 = most recent) of pixel `i`.
    pub gen_ring: Vec<u32>,
    pub gen_open: Vec<u32>,
    pub gen_last: Vec<u32>,
    pub gen_pend_t: Vec<u32>,
    pub red_ring: Vec<u32>,
    pub red_open: Vec<u32>,
    pub red_last: Vec<u32>,
    pub red_pend_t: Vec<u32>,
    pub pool_gen_t: Vec<u32>,
    pub pool_red_t: Vec<u32>,
    pub prev_l: Vec<f32>,
}

impl PixelState {
    pub fn new(n: usize, k: usize) -> Self {
        assert!(k >= 1);
        PixelState {
            n,
            k,
            lum_base: vec![0.0; n],
            lum_ext: vec![0.0; n],
            lum_t: vec![0; n],
            red_base: vec![0.0; n],
            red_ext: vec![0.0; n],
            red_t: vec![0; n],
            flags: vec![0; n],
            gen_ring: vec![0; n * k],
            gen_open: vec![0; n * k],
            gen_last: vec![0; n],
            gen_pend_t: vec![0; n],
            red_ring: vec![0; n * k],
            red_open: vec![0; n * k],
            red_last: vec![0; n],
            red_pend_t: vec![0; n],
            pool_gen_t: vec![0; n],
            pool_red_t: vec![0; n],
            prev_l: vec![0.0; n],
        }
    }

    /// Serialise into the GPU buffer layout (for tests and for seeding a GPU
    /// stage from CPU state).
    pub fn to_flat(&self) -> Vec<u32> {
        let lay = StateLayout { k: self.k };
        let n = self.n;
        let mut out = vec![0u32; lay.fields() * n];
        let put_f = |out: &mut Vec<u32>, f: usize, v: &[f32]| {
            for (i, x) in v.iter().enumerate() {
                out[f * n + i] = x.to_bits();
            }
        };
        let put_u = |out: &mut Vec<u32>, f: usize, v: &[u32]| {
            out[f * n..f * n + v.len()].copy_from_slice(v);
        };
        put_f(&mut out, StateLayout::LUM_BASE, &self.lum_base);
        put_f(&mut out, StateLayout::LUM_EXT, &self.lum_ext);
        put_u(&mut out, StateLayout::LUM_T, &self.lum_t);
        put_f(&mut out, StateLayout::RED_BASE, &self.red_base);
        put_f(&mut out, StateLayout::RED_EXT, &self.red_ext);
        put_u(&mut out, StateLayout::RED_T, &self.red_t);
        put_u(&mut out, StateLayout::FLAGS, &self.flags);
        put_u(&mut out, StateLayout::GEN_RING, &self.gen_ring);
        put_u(&mut out, lay.gen_open(), &self.gen_open);
        put_u(&mut out, lay.gen_last(), &self.gen_last);
        put_u(&mut out, lay.gen_pend_t(), &self.gen_pend_t);
        put_u(&mut out, lay.red_ring(), &self.red_ring);
        put_u(&mut out, lay.red_open(), &self.red_open);
        put_u(&mut out, lay.red_last(), &self.red_last);
        put_u(&mut out, lay.red_pend_t(), &self.red_pend_t);
        put_u(&mut out, lay.pool_gen_t(), &self.pool_gen_t);
        put_u(&mut out, lay.pool_red_t(), &self.pool_red_t);
        put_f(&mut out, lay.prev_l(), &self.prev_l);
        out
    }
}

/// Linearised planes of one analysis-resolution frame.
#[derive(Clone, Debug, Default)]
pub struct FramePlanes {
    pub l: Vec<f32>,
    pub v: Vec<f32>,
    /// 1 where the pixel is saturated red.
    pub sat: Vec<u8>,
}

impl FramePlanes {
    pub fn new(n: usize) -> Self {
        FramePlanes { l: vec![0.0; n], v: vec![0.0; n], sat: vec![0; n] }
    }

    /// 8-bit sRGB (3 or 4 bytes per pixel) -> L, V, sat.
    pub fn ingest(&mut self, data: &[u8], bpp: usize, red_saturation: f32) {
        let n = self.l.len();
        assert!(data.len() >= n * bpp, "frame too short: {} < {}", data.len(), n * bpp);
        let t = lut();
        for i in 0..n {
            let p = &data[i * bpp..i * bpp + 3];
            let (r, g, b) = (t[p[0] as usize], t[p[1] as usize], t[p[2] as usize]);
            self.l[i] = 0.2126f32 * r + 0.7152f32 * g + 0.0722f32 * b;
            let total = r + g + b;
            self.sat[i] = (total > 1e-5 && r >= red_saturation * total) as u8;
            self.v[i] = (r - g - b).max(0.0) * 320.0;
        }
        let _ = pixel_values; // same arithmetic, kept as the documented form
    }
}

/// Per-pixel outputs of one frame.
#[derive(Clone, Debug, Default)]
pub struct PixelOutputs {
    pub mask: Vec<u32>,
    /// Age (µs) of the opening transition feeding the failure window, per
    /// pixel strobing at the failure rate; 0 elsewhere.
    pub onset_gen: Vec<u32>,
    pub onset_red: Vec<u32>,
}

impl PixelOutputs {
    pub fn new(n: usize) -> Self {
        PixelOutputs { mask: vec![0; n], onset_gen: vec![0; n], onset_red: vec![0; n] }
    }
}

/// Pixels whose luminance moved more than `delta` since the last new picture.
pub fn held_count(l: &[f32], prev_l: &[f32], delta: f32) -> u32 {
    l.iter().zip(prev_l).filter(|(a, b)| (**a - **b).abs() > delta).count() as u32
}

/// One monotonic-run tracker step. Returns (reversed_up, reversed_down,
/// base_snapshot, ext_snapshot, aux_base_snapshot, aux_ext_snapshot).
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn tracker_feed(
    dir: &mut u32,
    base: &mut f32,
    ext: &mut f32,
    base_t: &mut u32,
    aux_base: &mut bool,
    aux_ext: &mut bool,
    x: f32,
    aux: bool,
    now: u32,
    eps: f32,
    max_run: u32,
) -> (bool, bool, f32, f32, bool, bool) {
    let mut rev_up = false;
    let mut rev_dn = false;
    if *dir == UP {
        if x >= *ext {
            *ext = x;
            *aux_ext = aux;
        } else if x < *ext - eps {
            rev_up = true;
        }
    } else if *dir == DN {
        if x <= *ext {
            *ext = x;
            *aux_ext = aux;
        } else if x > *ext + eps {
            rev_dn = true;
        }
    }
    let snap = (*base, *ext, *aux_base, *aux_ext);
    if rev_up || rev_dn {
        *base = *ext;
        *ext = x;
        *base_t = now;
        *dir = if rev_up { DN } else { UP };
        *aux_base = *aux_ext;
        *aux_ext = aux;
    } else if *dir == 0 {
        if x > *base + eps {
            *dir = UP;
            *ext = x;
            *aux_ext = aux;
        } else if x < *base - eps {
            *dir = DN;
            *ext = x;
            *aux_ext = aux;
        }
    }
    // a pixel with no run has no extremum to fall back on: its reference is
    // simply where it is now
    let stale = age(now, *base_t) > max_run;
    if *dir == 0 && stale {
        *ext = x;
        *aux_ext = aux;
    }
    // settle: re-anchor runs older than the cap
    if stale {
        *base = *ext;
        *base_t = now;
        *aux_base = *aux_ext;
    }
    (rev_up, rev_dn, snap.0, snap.1, snap.2, snap.3)
}

/// Flash pairing + rate ring for one pixel of one kind. `pol` is UP or DN.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn counter_transition(
    ring: &mut [u32],
    open: &mut [u32],
    n: usize,
    i: usize,
    k: usize,
    last: &mut u32,
    pend_t: &mut u32,
    pend_pol: &mut u32,
    pol: u32,
    now: u32,
    pair: u32,
) {
    let opposite = if pol == UP { DN } else { UP };
    if *pend_pol == opposite && age(now, *pend_t) <= pair {
        // a flash completes: shift the rings
        let mut s = k - 1;
        while s > 0 {
            ring[s * n + i] = ring[(s - 1) * n + i];
            open[s * n + i] = open[(s - 1) * n + i];
            s -= 1;
        }
        ring[i] = now;
        open[i] = *pend_t;
        *last = now;
        *pend_pol = 0;
        *pend_t = never(now);
    } else {
        *pend_pol = pol;
        *pend_t = now;
    }
}

/// Run the scalar kernel over a whole frame. `params.mode` decides between
/// initialisation (first frame), a held frame (runs only age) and a full
/// update.
pub fn run_frame_scalar(
    st: &mut PixelState,
    planes: &FramePlanes,
    p: &KernelParams,
    out: &mut PixelOutputs,
) {
    let n = st.n;
    let k = st.k;
    debug_assert_eq!(k, p.ring_len());
    let now = p.now;

    if p.first() {
        let nv = never(now);
        for i in 0..n {
            let l = planes.l[i];
            let v = planes.v[i];
            let sat = planes.sat[i] != 0;
            st.lum_base[i] = l;
            st.lum_ext[i] = l;
            st.lum_t[i] = now;
            st.red_base[i] = v;
            st.red_ext[i] = v;
            st.red_t[i] = now;
            st.flags[i] = if sat { RED_AUX_BASE | RED_AUX_EXT } else { 0 };
            for s in 0..k {
                st.gen_ring[s * n + i] = nv;
                st.gen_open[s * n + i] = nv;
                st.red_ring[s * n + i] = nv;
                st.red_open[s * n + i] = nv;
            }
            st.gen_last[i] = nv;
            st.gen_pend_t[i] = nv;
            st.red_last[i] = nv;
            st.red_pend_t[i] = nv;
            st.pool_gen_t[i] = nv;
            st.pool_red_t[i] = nv;
            st.prev_l[i] = l;
            out.mask[i] = 0;
            out.onset_gen[i] = 0;
            out.onset_red[i] = 0;
        }
        return;
    }

    if p.saturate() {
        for i in 0..n {
            st.lum_t[i] = saturate(now, st.lum_t[i]);
            st.red_t[i] = saturate(now, st.red_t[i]);
            for s in 0..k {
                st.gen_ring[s * n + i] = saturate(now, st.gen_ring[s * n + i]);
                st.gen_open[s * n + i] = saturate(now, st.gen_open[s * n + i]);
                st.red_ring[s * n + i] = saturate(now, st.red_ring[s * n + i]);
                st.red_open[s * n + i] = saturate(now, st.red_open[s * n + i]);
            }
            st.gen_last[i] = saturate(now, st.gen_last[i]);
            st.gen_pend_t[i] = saturate(now, st.gen_pend_t[i]);
            st.red_last[i] = saturate(now, st.red_last[i]);
            st.red_pend_t[i] = saturate(now, st.red_pend_t[i]);
            st.pool_gen_t[i] = saturate(now, st.pool_gen_t[i]);
            st.pool_red_t[i] = saturate(now, st.pool_red_t[i]);
        }
    }

    if p.held() {
        // nothing moved, so there is nothing to track -- but time passed,
        // and the cap is measured in time
        for i in 0..n {
            if age(now, st.lum_t[i]) > p.max_run {
                st.lum_base[i] = st.lum_ext[i];
                st.lum_t[i] = now;
            }
            if age(now, st.red_t[i]) > p.max_run {
                st.red_base[i] = st.red_ext[i];
                st.red_t[i] = now;
                let f = st.flags[i];
                let aux_ext = f & RED_AUX_EXT != 0;
                st.flags[i] = (f & !RED_AUX_BASE) | if aux_ext { RED_AUX_BASE } else { 0 };
            }
            out.mask[i] = 0;
            out.onset_gen[i] = 0;
            out.onset_red[i] = 0;
        }
        return;
    }

    let kf = p.k_fail as usize - 1;
    let ke = p.k_ext as usize - 1;
    for i in 0..n {
        let l = planes.l[i];
        let v = planes.v[i];
        let sat = planes.sat[i] != 0;
        st.prev_l[i] = l;
        let mut flags = st.flags[i];

        // --- luminance run tracker ------------------------------------
        let mut dir = (flags >> LUM_DIR_SHIFT) & DIR_MASK;
        let (mut aux_b, mut aux_e) = (false, false);
        let (rev_up, rev_dn, base, ext, _, _) = tracker_feed(
            &mut dir,
            &mut st.lum_base[i],
            &mut st.lum_ext[i],
            &mut st.lum_t[i],
            &mut aux_b,
            &mut aux_e,
            l,
            false,
            now,
            p.eps_l,
            p.max_run,
        );
        flags = (flags & !(DIR_MASK << LUM_DIR_SHIFT)) | (dir << LUM_DIR_SHIFT);
        // upward run: base is the darker end; downward run: ext is
        let q_up = rev_up && (ext - base) >= p.swing && base < p.dark;
        let q_dn = rev_dn && (base - ext) >= p.swing && ext < p.dark;

        // --- red run tracker ------------------------------------------
        let mut rdir = (flags >> RED_DIR_SHIFT) & DIR_MASK;
        let mut raux_b = flags & RED_AUX_BASE != 0;
        let mut raux_e = flags & RED_AUX_EXT != 0;
        let (r_up, r_dn, rbase, rext, rab, rae) = tracker_feed(
            &mut rdir,
            &mut st.red_base[i],
            &mut st.red_ext[i],
            &mut st.red_t[i],
            &mut raux_b,
            &mut raux_e,
            v,
            sat,
            now,
            p.eps_v,
            p.max_run,
        );
        flags = (flags & !((DIR_MASK << RED_DIR_SHIFT) | RED_AUX_BASE | RED_AUX_EXT))
            | (rdir << RED_DIR_SHIFT)
            | if raux_b { RED_AUX_BASE } else { 0 }
            | if raux_e { RED_AUX_EXT } else { 0 };
        // the transition must go INTO or OUT OF saturated red
        let sat_changed = rab != rae;
        let rq_up = r_up && (rext - rbase) > p.red_delta && sat_changed;
        let rq_dn = r_dn && (rbase - rext) > p.red_delta && sat_changed;

        let mut mask = 0u32;

        // --- general flashes -------------------------------------------
        {
            let mut pend_pol = (flags >> GEN_PEND_SHIFT) & DIR_MASK;
            if q_up || q_dn {
                counter_transition(
                    &mut st.gen_ring,
                    &mut st.gen_open,
                    n,
                    i,
                    k,
                    &mut st.gen_last[i],
                    &mut st.gen_pend_t[i],
                    &mut pend_pol,
                    if q_up { UP } else { DN },
                    now,
                    p.pair,
                );
            }
            flags = (flags & !(DIR_MASK << GEN_PEND_SHIFT)) | (pend_pol << GEN_PEND_SHIFT);
            let fresh = age(now, st.gen_last[i]) <= p.fresh;
            let strobe = fresh && age(now, st.gen_ring[kf * n + i]) < p.rate;
            let ext_s = fresh && age(now, st.gen_ring[ke * n + i]) < p.rate;
            if strobe {
                mask |= MASK_STROBE_GEN;
                out.onset_gen[i] = age(now, st.gen_open[kf * n + i]);
            } else {
                out.onset_gen[i] = 0;
            }
            if ext_s {
                mask |= MASK_EXT_GEN;
            }
        }

        // --- red flashes -----------------------------------------------
        {
            let mut pend_pol = (flags >> RED_PEND_SHIFT) & DIR_MASK;
            if rq_up || rq_dn {
                counter_transition(
                    &mut st.red_ring,
                    &mut st.red_open,
                    n,
                    i,
                    k,
                    &mut st.red_last[i],
                    &mut st.red_pend_t[i],
                    &mut pend_pol,
                    if rq_up { UP } else { DN },
                    now,
                    p.pair,
                );
            }
            flags = (flags & !(DIR_MASK << RED_PEND_SHIFT)) | (pend_pol << RED_PEND_SHIFT);
            let fresh = age(now, st.red_last[i]) <= p.fresh;
            let strobe = fresh && age(now, st.red_ring[kf * n + i]) < p.rate;
            let ext_s = fresh && age(now, st.red_ring[ke * n + i]) < p.rate;
            if strobe {
                mask |= MASK_STROBE_RED;
                out.onset_red[i] = age(now, st.red_open[kf * n + i]);
            } else {
                out.onset_red[i] = 0;
            }
            if ext_s {
                mask |= MASK_EXT_RED;
            }
        }

        // --- pooled transition areas (chart statistics only) -----------
        {
            let mut pol = (flags >> POOL_GEN_SHIFT) & DIR_MASK;
            if q_up {
                pol = UP;
                st.pool_gen_t[i] = now;
            } else if q_dn {
                pol = DN;
                st.pool_gen_t[i] = now;
            }
            flags = (flags & !(DIR_MASK << POOL_GEN_SHIFT)) | (pol << POOL_GEN_SHIFT);
            let active = age(now, st.pool_gen_t[i]) <= p.pool;
            if active && pol == UP {
                mask |= MASK_POOL_GEN_UP;
            }
            if active && pol == DN {
                mask |= MASK_POOL_GEN_DN;
            }
            let mut rpol = (flags >> POOL_RED_SHIFT) & DIR_MASK;
            if rq_up {
                rpol = UP;
                st.pool_red_t[i] = now;
            } else if rq_dn {
                rpol = DN;
                st.pool_red_t[i] = now;
            }
            flags = (flags & !(DIR_MASK << POOL_RED_SHIFT)) | (rpol << POOL_RED_SHIFT);
            let ractive = age(now, st.pool_red_t[i]) <= p.pool;
            if ractive && rpol == UP {
                mask |= MASK_POOL_RED_UP;
            }
            if ractive && rpol == DN {
                mask |= MASK_POOL_RED_DN;
            }
        }

        st.flags[i] = flags;
        out.mask[i] = mask;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(now_us: u32, mode: u32) -> KernelParams {
        let cfg = DetectorConfig::default();
        let geom = GridGeometry::new(&cfg, 4, 4);
        let mut p = KernelParams::template(&cfg, &geom);
        p.now = now_us;
        p.mode = mode;
        p
    }

    /// Feed a single-pixel luminance sequence at a fixed frame interval and
    /// return the frames on which the pixel strobes at the failure rate.
    fn strobe_frames(lum: &[f32], dt_us: u32) -> Vec<usize> {
        let n = 16;
        let mut st = PixelState::new(n, 4);
        let mut planes = FramePlanes::new(n);
        let mut out = PixelOutputs::new(n);
        let mut hits = vec![];
        for (f, &x) in lum.iter().enumerate() {
            planes.l.iter_mut().for_each(|p| *p = x);
            let mode = if f == 0 { MODE_FIRST } else { 0 };
            let p = params((f as u32) * dt_us, mode);
            run_frame_scalar(&mut st, &planes, &p, &mut out);
            if out.mask[0] & MASK_STROBE_GEN != 0 {
                hits.push(f);
            }
        }
        hits
    }

    #[test]
    fn four_flashes_a_second_strobe_three_do_not() {
        // 24 fps: a 4 Hz square wave has a transition every 3 frames
        let mut seq = vec![];
        for f in 0..72 {
            seq.push(if (f / 3) % 2 == 0 { 0.05f32 } else { 0.6 });
        }
        let hits = strobe_frames(&seq, 41_667);
        assert!(!hits.is_empty(), "4 Hz must exceed the limit");
        // 3 Hz: transition every 4 frames -> never more than 3 flashes/s
        let mut seq3 = vec![];
        for f in 0..96 {
            seq3.push(if (f / 4) % 2 == 0 { 0.05f32 } else { 0.6 });
        }
        assert!(strobe_frames(&seq3, 41_667).is_empty(), "3 Hz is at the limit, not over it");
    }

    #[test]
    fn bright_only_flicker_is_not_a_flash() {
        let mut seq = vec![];
        for f in 0..72 {
            seq.push(if (f / 3) % 2 == 0 { 0.85f32 } else { 1.0 });
        }
        assert!(strobe_frames(&seq, 41_667).is_empty());
    }

    #[test]
    fn ramps_accumulate_into_one_transition() {
        // each half cycle ramps over 3 frames in steps of 0.05 (under the
        // 0.1 swing on their own), reaching a 0.15 swing overall
        let mut seq = vec![];
        for _ in 0..12 {
            seq.extend_from_slice(&[0.10f32, 0.15, 0.20, 0.25, 0.20, 0.15]);
        }
        assert!(!strobe_frames(&seq, 41_667).is_empty());
    }

    #[test]
    fn held_frames_only_age() {
        let n = 4;
        let mut st = PixelState::new(n, 4);
        let planes = FramePlanes { l: vec![0.3; n], v: vec![0.0; n], sat: vec![0; n] };
        let mut out = PixelOutputs::new(n);
        run_frame_scalar(&mut st, &planes, &params(0, MODE_FIRST), &mut out);
        // start an upward run
        let up = FramePlanes { l: vec![0.5; n], v: vec![0.0; n], sat: vec![0; n] };
        run_frame_scalar(&mut st, &up, &params(40_000, 0), &mut out);
        assert_eq!(st.lum_ext[0], 0.5);
        assert_eq!(st.lum_base[0], 0.3);
        // hold for longer than the run cap: the run is re-anchored
        run_frame_scalar(&mut st, &up, &params(2_100_000, MODE_HELD), &mut out);
        assert_eq!(st.lum_base[0], 0.5);
        assert_eq!(st.lum_t[0], 2_100_000);
        assert_eq!(out.mask[0], 0);
    }

    #[test]
    fn saturation_keeps_ages_bounded() {
        let n = 2;
        let mut st = PixelState::new(n, 4);
        let planes = FramePlanes::new(n);
        let mut out = PixelOutputs::new(n);
        run_frame_scalar(&mut st, &planes, &params(0, MODE_FIRST), &mut out);
        let far = 3_000_000_000u32; // 50 minutes later
        run_frame_scalar(&mut st, &planes, &params(far, MODE_SATURATE), &mut out);
        assert_eq!(age(far, st.gen_ring[0]), crate::time::AGE_MAX);
        assert_eq!(age(far, st.pool_red_t[1]), crate::time::AGE_MAX);
        // the run trackers re-anchor to "now" once their run is stale
        assert_eq!(st.lum_t[0], far);
    }

    #[test]
    fn layout_is_consistent() {
        let lay = StateLayout { k: 4 };
        assert_eq!(lay.fields(), 30);
        let st = PixelState::new(3, 4);
        assert_eq!(st.to_flat().len(), 90);
    }
}
