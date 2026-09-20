//! WebGPU pixel stage for the Unflash detector, on wgpu (native backends and
//! the browser's WebGPU alike).
//!
//! Each frame runs four compute passes, five with pattern detection on:
//!
//! 1. **ingest** — area-average the source texture to the analysis size,
//!    linearise through the sRGB table, produce L / V / saturation planes and
//!    count the pixels that moved since the last new picture;
//! 2. **pattern** — the regular-pattern (stripe) detector
//!    (`unflash_core::pattern`, restated in WGSL), one thread per sampling
//!    line, marking the patterned pixels;
//! 3. **update** — the per-pixel state machine
//!    (`unflash_core::pixel::run_frame_scalar`, restated in WGSL);
//! 4. **rows** — per-row window sums and onset maxima, one thread per window
//!    position (no workgroup barriers: cheap on real GPUs and not
//!    pathological on software ones);
//! 5. **gather** — one grid cell per window position.
//!
//! The output is a few kilobytes per frame, copied into a staging buffer and
//! mapped asynchronously; several frames can be in flight. Per-pixel state
//! never leaves the GPU, so the traffic per frame is one read and a partial
//! write of the ~120-byte pixel record plus the input planes: the stage runs
//! at pixel count × memory bandwidth, as it should.

use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use bytemuck::{bytes_of, cast_slice};
use unflash_core::config::DetectorConfig;
use unflash_core::grid::{GridCell, GridGeometry, GridStats};
use unflash_core::lut::lut;
use unflash_core::pixel::{KernelParams, StateLayout, MODE_FIRST};

pub use wgpu;

const PRELUDE: &str = include_str!("shaders/prelude.wgsl");
const INGEST: &str = include_str!("shaders/ingest.wgsl");
const PATTERN: &str = include_str!("shaders/pattern.wgsl");
const UPDATE: &str = include_str!("shaders/update.wgsl");
const ROWS: &str = include_str!("shaders/rows.wgsl");
const GATHER: &str = include_str!("shaders/gather.wgsl");

const OUT_HEADER: usize = 8;
const CELL_WORDS: usize = 12;
const GEO_WORDS: usize = 8 + 64 + 64 + 4;
const GEO_MAX_POS: usize = 64;
const GEO_PAT_R: usize = 136;
const PATTERN_WG: u32 = 64;
/// Frames that may be in flight before `submit` refuses.
pub const DEFAULT_SLOTS: usize = 4;

/// An adapter + device + queue.
pub struct GpuContext {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

impl GpuContext {
    /// Request a high-performance adapter and a device with default limits.
    pub async fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            })
            .await
            .map_err(|e| format!("no WebGPU adapter: {e}"))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("unflash"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                ..Default::default()
            })
            .await
            .map_err(|e| format!("device request failed: {e}"))?;
        Ok(GpuContext { instance, adapter, device, queue })
    }

    pub fn info(&self) -> wgpu::AdapterInfo {
        self.adapter.get_info()
    }
}

/// Where a frame comes from.
pub enum FrameSource<'a> {
    /// 8-bit sRGB pixels, tightly packed, any size (area-averaged down).
    Rgb8 { data: &'a [u8], width: u32, height: u32 },
    /// 8-bit sRGB pixels with an ignored fourth byte.
    Rgba8 { data: &'a [u8], width: u32, height: u32 },
    /// The stage's own source texture, which the caller has already filled
    /// (see [`GpuStage::source_texture`]) — the browser path.
    SourceTexture,
}

enum SlotState {
    Idle,
    /// Maps still outstanding, and the first error seen.
    Pending { remaining: u32, err: Option<String> },
}

struct Slot {
    staging: wgpu::Buffer,
    rgba_staging: Option<wgpu::Buffer>,
    captured: bool,
    state: Arc<Mutex<SlotState>>,
    params: KernelParams,
}

/// One completed frame.
#[derive(Clone, Debug)]
pub struct GpuFrame {
    pub stats: GridStats,
    /// The analysis-resolution picture as RGBA8, when capture was requested.
    pub rgba: Option<Vec<u8>>,
}

/// The GPU pixel stage. Create one per (config, analysis size).
pub struct GpuStage {
    device: wgpu::Device,
    queue: wgpu::Queue,
    cfg: DetectorConfig,
    geom: GridGeometry,
    layout: StateLayout,
    // buffers
    params_buf: wgpu::Buffer,
    geo_buf: wgpu::Buffer,
    lut_buf: wgpu::Buffer,
    inputs_buf: wgpu::Buffer,
    state_buf: wgpu::Buffer,
    /// Read back only by the native debug helpers.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pixout_buf: wgpu::Buffer,
    rgba_buf: wgpu::Buffer,
    globals_buf: wgpu::Buffer,
    rowwin_buf: wgpu::Buffer,
    rowtot_buf: wgpu::Buffer,
    /// Read back only by the native debug helpers (the per-row pattern
    /// counts live in the rows / gather bind groups alone).
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    patmask_buf: wgpu::Buffer,
    out_buf: wgpu::Buffer,
    out_words: usize,
    /// threads of the pattern pass: orientations × sampling lines
    pat_threads: u32,
    // source texture
    src: Option<(wgpu::Texture, wgpu::TextureView, u32, u32)>,
    rgba_scratch: Vec<u8>,
    // pipelines
    ingest_bgl: wgpu::BindGroupLayout,
    ingest_pipe: wgpu::ComputePipeline,
    ingest_bg: Option<wgpu::BindGroup>,
    pattern_pipe: wgpu::ComputePipeline,
    pattern_bg: wgpu::BindGroup,
    update_pipe: wgpu::ComputePipeline,
    update_bg: wgpu::BindGroup,
    rows_pipe: wgpu::ComputePipeline,
    rows_bg: wgpu::BindGroup,
    gather_pipe: wgpu::ComputePipeline,
    gather_bg: wgpu::BindGroup,
    // readback ring
    slots: Vec<Slot>,
    in_flight: VecDeque<usize>,
    free: Vec<usize>,
    frames_submitted: u64,
}

fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn texture_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn buf_entry(binding: u32, buf: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: buf.as_entire_binding() }
}

impl GpuStage {
    pub fn new(ctx: &GpuContext, cfg: &DetectorConfig, geom: GridGeometry) -> Result<Self, String> {
        Self::with_slots(ctx, cfg, geom, DEFAULT_SLOTS)
    }

    pub fn with_slots(ctx: &GpuContext, cfg: &DetectorConfig, geom: GridGeometry, nslots: usize) -> Result<Self, String> {
        let device = ctx.device.clone();
        let queue = ctx.queue.clone();
        if geom.aw > 1024 {
            return Err(format!("analysis width {} exceeds the 1024 the row scan supports", geom.aw));
        }
        if geom.gxs.len() > GEO_MAX_POS || geom.gys.len() > GEO_MAX_POS {
            return Err("too many window positions".into());
        }
        let k = cfg.k_fail() as usize;
        let layout = StateLayout { k };
        let npix = geom.npix();
        let ncells = geom.ncells();
        let out_words = OUT_HEADER + ncells * CELL_WORDS;

        let mk = |label: &str, size: usize, usage: wgpu::BufferUsages| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: (size.max(4)) as u64,
                usage,
                mapped_at_creation: false,
            })
        };
        let st = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC;
        let params_buf = mk("params", std::mem::size_of::<KernelParams>(), wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST);
        let geo_buf = mk("geo", GEO_WORDS * 4, st);
        let lut_buf = mk("lut", 256 * 4, st);
        let inputs_buf = mk("inputs", 3 * npix * 4, st);
        let state_buf = mk("state", layout.fields() * npix * 4, st);
        let pixout_buf = mk("pixout", 3 * npix * 4, st);
        let rgba_buf = mk("rgba", npix * 4, st);
        let globals_buf = mk("globals", 16, st);
        let rowwin_buf = mk("rowwin", geom.ah as usize * geom.gxs.len() * CELL_WORDS * 4, st);
        let rowtot_buf = mk("rowtot", geom.ah as usize * 4, st);
        let patmask_buf = mk("patmask", npix * 4, st);
        let rowpat_buf = mk("rowpat", geom.ah as usize * 4, st);
        let out_buf = mk("out", out_words * 4, st);
        let pat_r = unflash_core::pattern::line_radius(geom.aw, geom.ah);
        let pat_threads = unflash_core::pattern::ORIENTATIONS as u32 * (2 * pat_r as u32 + 1);

        // static uploads
        let mut geo_words = vec![0u32; GEO_WORDS];
        geo_words[2] = geom.aw;
        geo_words[3] = geom.ah;
        geo_words[4] = geom.ww;
        geo_words[5] = geom.wh;
        geo_words[6] = geom.gxs.len() as u32;
        geo_words[7] = geom.gys.len() as u32;
        for (i, &g) in geom.gxs.iter().enumerate() {
            geo_words[8 + i] = g;
        }
        for (i, &g) in geom.gys.iter().enumerate() {
            geo_words[8 + 64 + i] = g;
        }
        geo_words[GEO_PAT_R] = pat_r as u32;
        queue.write_buffer(&geo_buf, 0, cast_slice(&geo_words));
        queue.write_buffer(&lut_buf, 0, cast_slice(lut()));
        queue.write_buffer(&globals_buf, 0, &[0u8; 16]);

        // shaders
        let assemble = |src: &str| -> String {
            let mut s = String::from(PRELUDE);
            s.push_str(src);
            s.replace("{{K}}", &format!("{k}u"))
        };
        let module = |label: &str, src: String| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(Cow::Owned(src)) })
        };
        let ingest_mod = module("ingest", assemble(INGEST));
        let pattern_mod = module("pattern", assemble(PATTERN));
        let update_mod = module("update", assemble(UPDATE));
        let rows_mod = module("rows", assemble(ROWS));
        let gather_mod = module("gather", assemble(GATHER));

        let bgl = |label: &str, entries: &[wgpu::BindGroupLayoutEntry]| {
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries })
        };
        let ingest_bgl = bgl(
            "ingest",
            &[
                uniform_entry(0),
                storage_entry(1, true),
                storage_entry(2, true),
                texture_entry(3),
                storage_entry(4, false),
                storage_entry(5, true),
                storage_entry(6, false),
                storage_entry(7, false),
                storage_entry(8, false),
            ],
        );
        let pattern_bgl = bgl("pattern", &[uniform_entry(0), storage_entry(1, true), storage_entry(2, true), storage_entry(3, false), storage_entry(4, false)]);
        let update_bgl = bgl("update", &[uniform_entry(0), storage_entry(1, true), storage_entry(2, false), storage_entry(3, false), storage_entry(4, true)]);
        let rows_bgl = bgl(
            "rows",
            &[uniform_entry(0), storage_entry(1, true), storage_entry(2, true), storage_entry(3, true), storage_entry(4, false), storage_entry(5, false), storage_entry(6, true), storage_entry(7, false)],
        );
        let gather_bgl = bgl(
            "gather",
            &[uniform_entry(0), storage_entry(1, true), storage_entry(2, true), storage_entry(3, true), storage_entry(4, false), storage_entry(5, false), storage_entry(6, true)],
        );

        let pipe = |label: &str, l: &wgpu::BindGroupLayout, m: &wgpu::ShaderModule| {
            let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(label), bind_group_layouts: &[Some(l)], immediate_size: 0 });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: Some(&pl),
                module: m,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let ingest_pipe = pipe("ingest", &ingest_bgl, &ingest_mod);
        let pattern_pipe = pipe("pattern", &pattern_bgl, &pattern_mod);
        let update_pipe = pipe("update", &update_bgl, &update_mod);
        let rows_pipe = pipe("rows", &rows_bgl, &rows_mod);
        let gather_pipe = pipe("gather", &gather_bgl, &gather_mod);

        let pattern_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pattern"),
            layout: &pattern_bgl,
            entries: &[buf_entry(0, &params_buf), buf_entry(1, &geo_buf), buf_entry(2, &inputs_buf), buf_entry(3, &patmask_buf), buf_entry(4, &globals_buf)],
        });
        let update_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("update"),
            layout: &update_bgl,
            entries: &[buf_entry(0, &params_buf), buf_entry(1, &inputs_buf), buf_entry(2, &state_buf), buf_entry(3, &pixout_buf), buf_entry(4, &globals_buf)],
        });
        let rows_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("rows"),
            layout: &rows_bgl,
            entries: &[
                buf_entry(0, &params_buf),
                buf_entry(1, &geo_buf),
                buf_entry(2, &inputs_buf),
                buf_entry(3, &pixout_buf),
                buf_entry(4, &rowwin_buf),
                buf_entry(5, &rowtot_buf),
                buf_entry(6, &patmask_buf),
                buf_entry(7, &rowpat_buf),
            ],
        });
        let gather_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gather"),
            layout: &gather_bgl,
            entries: &[
                buf_entry(0, &params_buf),
                buf_entry(1, &geo_buf),
                buf_entry(2, &rowwin_buf),
                buf_entry(3, &rowtot_buf),
                buf_entry(4, &globals_buf),
                buf_entry(5, &out_buf),
                buf_entry(6, &rowpat_buf),
            ],
        });

        let slots = (0..nslots.max(1))
            .map(|i| Slot {
                staging: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("staging{i}")),
                    size: (out_words * 4) as u64,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
                rgba_staging: None,
                captured: false,
                state: Arc::new(Mutex::new(SlotState::Idle)),
                params: KernelParams::default(),
            })
            .collect::<Vec<_>>();
        let free = (0..slots.len()).rev().collect();

        Ok(GpuStage {
            device,
            queue,
            cfg: cfg.clone(),
            geom,
            layout,
            params_buf,
            geo_buf,
            lut_buf,
            inputs_buf,
            state_buf,
            pixout_buf,
            rgba_buf,
            globals_buf,
            rowwin_buf,
            rowtot_buf,
            patmask_buf,
            out_buf,
            out_words,
            pat_threads,
            src: None,
            rgba_scratch: Vec::new(),
            ingest_bgl,
            ingest_pipe,
            ingest_bg: None,
            pattern_pipe,
            pattern_bg,
            update_pipe,
            update_bg,
            rows_pipe,
            rows_bg,
            gather_pipe,
            gather_bg,
            slots,
            in_flight: VecDeque::new(),
            free,
            frames_submitted: 0,
        })
    }

    pub fn geometry(&self) -> &GridGeometry {
        &self.geom
    }
    pub fn config(&self) -> &DetectorConfig {
        &self.cfg
    }
    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }
    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }
    pub fn in_flight(&self) -> usize {
        self.in_flight.len()
    }
    pub fn capacity(&self) -> usize {
        self.slots.len()
    }
    pub fn can_submit(&self) -> bool {
        !self.free.is_empty()
    }
    /// Bytes of per-pixel state touched by one full-update frame: the record
    /// read plus the partial write plus the input planes (for bandwidth
    /// accounting in benchmarks).
    pub fn bytes_per_frame(&self) -> u64 {
        let n = self.geom.npix() as u64;
        // inputs (l, v, sat) written by ingest and read by update + rows;
        // state fields read (≈20) and written (≈8); pixout written and read;
        // the pattern pass reads L once per orientation and clears / marks /
        // counts the mask
        let pattern = if self.cfg.flag_patterns() { unflash_core::pattern::ORIENTATIONS as u64 + 3 } else { 0 };
        n * 4 * (3 * 3 + 20 + 8 + 3 * 2 + pattern)
    }

    /// The source texture at the given size, (re)created as needed. Fill it
    /// (e.g. with `queue.copy_external_image_to_texture` in a browser) and
    /// then submit with [`FrameSource::SourceTexture`].
    pub fn source_texture(&mut self, width: u32, height: u32) -> &wgpu::Texture {
        let needs = match &self.src {
            Some((_, _, w, h)) => *w != width || *h != height,
            None => true,
        };
        if needs {
            let tex = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("source"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            self.ingest_bg = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("ingest"),
                layout: &self.ingest_bgl,
                entries: &[
                    buf_entry(0, &self.params_buf),
                    buf_entry(1, &self.geo_buf),
                    buf_entry(2, &self.lut_buf),
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&view) },
                    buf_entry(4, &self.inputs_buf),
                    buf_entry(5, &self.state_buf),
                    buf_entry(6, &self.globals_buf),
                    buf_entry(7, &self.rgba_buf),
                    buf_entry(8, &self.patmask_buf),
                ],
            }));
            let mut geo = [0u32; 2];
            geo[0] = width;
            geo[1] = height;
            self.queue.write_buffer(&self.geo_buf, 0, cast_slice(&geo));
            self.src = Some((tex, view, width, height));
        }
        &self.src.as_ref().unwrap().0
    }

    /// Submit one frame. Fails (without side effects) when every readback
    /// slot is in flight; call [`poll`](Self::poll) first. With `capture`,
    /// the analysis-resolution RGBA picture comes back with the result.
    pub fn submit(&mut self, params: KernelParams, source: FrameSource<'_>, capture: bool) -> Result<(), String> {
        let Some(slot_idx) = self.free.pop() else {
            return Err("all readback slots are in flight".into());
        };
        // 1. source
        match source {
            FrameSource::Rgb8 { data, width, height } => {
                let n = (width * height) as usize;
                if data.len() < n * 3 {
                    self.free.push(slot_idx);
                    return Err("frame data too short".into());
                }
                self.rgba_scratch.resize(n * 4, 255);
                for i in 0..n {
                    self.rgba_scratch[i * 4..i * 4 + 3].copy_from_slice(&data[i * 3..i * 3 + 3]);
                }
                let tex = self.source_texture(width, height);
                let tex = tex.clone();
                self.write_source(&tex, &self.rgba_scratch.clone(), width, height);
            }
            FrameSource::Rgba8 { data, width, height } => {
                let n = (width * height) as usize;
                if data.len() < n * 4 {
                    self.free.push(slot_idx);
                    return Err("frame data too short".into());
                }
                let tex = self.source_texture(width, height).clone();
                self.write_source(&tex, data, width, height);
            }
            FrameSource::SourceTexture => {
                if self.src.is_none() {
                    self.free.push(slot_idx);
                    return Err("no source texture has been created".into());
                }
            }
        }
        // 2. params
        self.queue.write_buffer(&self.params_buf, 0, bytes_of(&params));
        // 3. passes
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("unflash frame") });
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("detector"), timestamp_writes: None });
            pass.set_pipeline(&self.ingest_pipe);
            pass.set_bind_group(0, self.ingest_bg.as_ref().unwrap(), &[]);
            pass.dispatch_workgroups(self.geom.aw.div_ceil(16), self.geom.ah.div_ceil(16), 1);
            if params.pat_enabled != 0 {
                pass.set_pipeline(&self.pattern_pipe);
                pass.set_bind_group(0, &self.pattern_bg, &[]);
                pass.dispatch_workgroups(self.pat_threads.div_ceil(PATTERN_WG), 1, 1);
            }
            pass.set_pipeline(&self.update_pipe);
            pass.set_bind_group(0, &self.update_bg, &[]);
            pass.dispatch_workgroups((self.geom.npix() as u32).div_ceil(256), 1, 1);
            pass.set_pipeline(&self.rows_pipe);
            pass.set_bind_group(0, &self.rows_bg, &[]);
            pass.dispatch_workgroups(self.geom.ah, 1, 1);
            pass.set_pipeline(&self.gather_pipe);
            pass.set_bind_group(0, &self.gather_bg, &[]);
            pass.dispatch_workgroups((self.geom.ncells() as u32).div_ceil(64), 1, 1);
        }
        let npix = self.geom.npix();
        let slot = &mut self.slots[slot_idx];
        enc.copy_buffer_to_buffer(&self.out_buf, 0, &slot.staging, 0, (self.out_words * 4) as u64);
        if capture {
            let rs = slot.rgba_staging.get_or_insert_with(|| {
                self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("rgba staging"),
                    size: (npix * 4) as u64,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            });
            enc.copy_buffer_to_buffer(&self.rgba_buf, 0, rs, 0, (npix * 4) as u64);
        }
        self.queue.submit(Some(enc.finish()));
        // 4. async readback
        slot.params = params;
        slot.captured = capture;
        *slot.state.lock().unwrap() = SlotState::Pending { remaining: if capture { 2 } else { 1 }, err: None };
        let done = |st: &Arc<Mutex<SlotState>>, r: Result<(), wgpu::BufferAsyncError>| {
            let mut g = st.lock().unwrap();
            if let SlotState::Pending { remaining, err } = &mut *g {
                *remaining = remaining.saturating_sub(1);
                if let Err(e) = r {
                    err.get_or_insert(e.to_string());
                }
            }
        };
        let st = slot.state.clone();
        slot.staging.slice(..).map_async(wgpu::MapMode::Read, move |r| done(&st, r));
        if capture {
            let st = slot.state.clone();
            slot.rgba_staging.as_ref().unwrap().slice(..).map_async(wgpu::MapMode::Read, move |r| done(&st, r));
        }
        self.in_flight.push_back(slot_idx);
        self.frames_submitted += 1;
        Ok(())
    }

    fn write_source(&self, tex: &wgpu::Texture, rgba: &[u8], width: u32, height: u32) {
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: None },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
    }

    /// The oldest in-flight frame's result, if it has arrived. Call
    /// repeatedly (each browser animation frame, or after `device.poll` on
    /// native).
    pub fn poll(&mut self) -> Option<Result<GpuFrame, String>> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = self.device.poll(wgpu::PollType::Poll);
        }
        let &slot_idx = self.in_flight.front()?;
        let ready: Option<Result<(), String>> = {
            let st = self.slots[slot_idx].state.lock().unwrap();
            match &*st {
                SlotState::Pending { remaining: 0, err } => Some(match err {
                    Some(e) => Err(e.clone()),
                    None => Ok(()),
                }),
                _ => None,
            }
        };
        let r = ready?;
        self.in_flight.pop_front();
        let params = self.slots[slot_idx].params;
        let captured = self.slots[slot_idx].captured;
        let out = match r {
            Ok(()) => {
                let words: Vec<u32> = {
                    let slot = &self.slots[slot_idx];
                    let view = slot.staging.slice(..).get_mapped_range().expect("mapped range");
                    cast_slice::<u8, u32>(&view).to_vec()
                };
                self.slots[slot_idx].staging.unmap();
                let rgba = if captured {
                    let rs = self.slots[slot_idx].rgba_staging.as_ref().unwrap();
                    let bytes = rs.slice(..).get_mapped_range().expect("mapped rgba").to_vec();
                    rs.unmap();
                    Some(bytes)
                } else {
                    None
                };
                Ok(GpuFrame { stats: self.parse(&words, params), rgba })
            }
            Err(e) => {
                // leave the buffers unmapped for reuse
                let slot = &self.slots[slot_idx];
                slot.staging.unmap();
                if captured {
                    if let Some(rs) = &slot.rgba_staging {
                        rs.unmap();
                    }
                }
                Err(e)
            }
        };
        *self.slots[slot_idx].state.lock().unwrap() = SlotState::Idle;
        self.free.push(slot_idx);
        Some(out)
    }

    fn parse(&self, words: &[u32], params: KernelParams) -> GridStats {
        let sum_l = f32::from_bits(words[0]) as f64;
        let held_count = words[1];
        let first = params.mode & MODE_FIRST != 0;
        let held = !first && held_count < params.held_bar;
        let cells = if held {
            Vec::new()
        } else {
            cast_slice::<u32, GridCell>(&words[OUT_HEADER..OUT_HEADER + self.geom.ncells() * CELL_WORDS]).to_vec()
        };
        GridStats { held, held_count, sum_l, cells, pattern_count: words[4], pattern_spacing_sum: words[5], pattern_spacing_n: words[6] }
    }

    /// Block until every in-flight frame is done (native only; a no-op on
    /// the web, where results arrive through the event loop).
    pub fn wait_idle(&mut self) {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        }
    }

    /// Native debug readback of a whole buffer.
    #[cfg(not(target_arch = "wasm32"))]
    fn read_buffer_words(&self, buf: &wgpu::Buffer) -> Vec<u32> {
        let size = buf.size();
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("debug staging"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(buf, 0, &staging, 0, size);
        self.queue.submit(Some(enc.finish()));
        let (tx, rx) = std::sync::mpsc::channel();
        staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        rx.recv().unwrap().expect("map failed");
        let words = cast_slice::<u8, u32>(&staging.slice(..).get_mapped_range().expect("mapped range")).to_vec();
        staging.unmap();
        words
    }

    /// The whole per-pixel state in `StateLayout` order (native, for tests).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn debug_state(&self) -> Vec<u32> {
        self.read_buffer_words(&self.state_buf)
    }

    /// The L / V / sat planes of the last frame (native, for tests).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn debug_inputs(&self) -> (Vec<f32>, Vec<f32>, Vec<u8>) {
        let w = self.read_buffer_words(&self.inputs_buf);
        let n = self.geom.npix();
        (
            w[..n].iter().map(|&b| f32::from_bits(b)).collect(),
            w[n..2 * n].iter().map(|&b| f32::from_bits(b)).collect(),
            w[2 * n..3 * n].iter().map(|&b| b as u8).collect(),
        )
    }

    /// The mask / onset planes of the last frame (native, for tests).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn debug_pixout(&self) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
        let w = self.read_buffer_words(&self.pixout_buf);
        let n = self.geom.npix();
        (w[..n].to_vec(), w[n..2 * n].to_vec(), w[2 * n..3 * n].to_vec())
    }

    /// The pattern mask of the last frame, bit k = orientation k (native,
    /// for tests).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn debug_patmask(&self) -> Vec<u32> {
        self.read_buffer_words(&self.patmask_buf)
    }

    pub fn state_layout(&self) -> StateLayout {
        self.layout
    }
    /// Sizes of the intermediate buffers (bytes): (row windows, row totals).
    pub fn intermediate_bytes(&self) -> (u64, u64) {
        (self.rowwin_buf.size(), self.rowtot_buf.size())
    }
    pub fn frames_submitted(&self) -> u64 {
        self.frames_submitted
    }
}
