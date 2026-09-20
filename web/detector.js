// The detector, wrapped so the rest of the app does not care whether it runs
// on the GPU or the CPU.

import { tick } from './media.js';

export async function createDetector(wasm, configJson, width, height, { preferGpu = true, externalSources = null } = {}) {
  let det = null;
  let backend = 'cpu';
  let note = '';
  let probe = null;
  if (preferGpu && navigator.gpu) {
    try {
      det = await wasm.Detector.createGpu(configJson, width, height);
      backend = 'webgpu';
      probe = await SourceProbe.create(externalSources);
    } catch (e) {
      note = `WebGPU unavailable (${e && e.message ? e.message : e}); using the CPU detector`;
      console.warn(note);
    }
  } else if (preferGpu) {
    note = 'This browser has no WebGPU; using the CPU detector';
  }
  if (!det) det = new wasm.Detector(configJson, width, height);
  return new Feeder(wasm, det, backend, note, probe);
}

/**
 * Which kinds of picture the browser's WebGPU accepts as a
 * copyExternalImageToTexture source. Firefox takes only ImageBitmap,
 * HTMLImageElement, HTMLCanvasElement and OffscreenCanvas; a VideoFrame or a
 * <video> makes it throw a TypeError, which wgpu unwraps, and that aborts the
 * whole WASM instance. So every kind of source is tried once on a throwaway
 * device before it is allowed through to WASM; rejected kinds are blitted
 * through an OffscreenCanvas instead (and if even that is rejected, copied
 * out as RGBA).
 */
export class SourceProbe {
  /** `allowed`: an optional list of kinds to treat as accepted without asking (tests: `?extsrc=canvas`). */
  static async create(allowed = null) {
    const p = new SourceProbe();
    if (allowed) {
      for (const k of ['videoframe', 'video', 'canvas', 'bitmap']) p.support[k] = allowed.includes(k);
      return p;
    }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('no adapter');
      p.device = await adapter.requestDevice();
      p.texture = p.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      p.device.lost.then(() => p.release());
    } catch (e) {
      console.warn('cannot probe WebGPU picture sources; copying frames as RGBA', e);
      p.release();
    }
    return p;
  }

  constructor() {
    this.device = null;
    this.texture = null;
    this.support = {}; // kind -> true (WASM may take it) / false (never)
  }

  release() {
    if (this.device) {
      try {
        this.device.destroy();
      } catch (e) {
        /* already lost */
      }
    }
    this.device = null;
    this.texture = null;
  }

  /**
   * May `source` (of `kind`) go to WASM? Unknown kinds are tried with this
   * very picture: a TypeError is the browser rejecting the kind for good,
   * any other failure only skips this picture.
   */
  accepts(kind, source) {
    const known = this.support[kind];
    if (known !== undefined) return known;
    if (!this.device) return false;
    let ok;
    try {
      this.device.queue.copyExternalImageToTexture({ source }, { texture: this.texture }, [1, 1]);
      ok = true;
    } catch (e) {
      ok = false;
      if (!(e instanceof TypeError)) return false;
      console.warn(`WebGPU does not take a ${kind} as a copy source here (${e.message}); blitting through a canvas`);
    }
    this.support[kind] = ok;
    if (['videoframe', 'video', 'canvas'].every((k) => this.support[k] !== undefined)) this.release();
    return ok;
  }
}

/** Feeds pictures of any kind into a Detector with back-pressure. */
export class Feeder {
  constructor(wasm, det, backend, note, probe = null) {
    this.wasm = wasm;
    this.det = det;
    this.backend = backend;
    this.note = note;
    this.probe = probe;
    this.aw = det.analysis_width();
    this.ah = det.analysis_height();
    this.fed = 0;
    this.busyNs = 0;
    this.route = ''; // how the last picture reached the GPU detector (diagnostics)
    if (backend === 'cpu') {
      this.canvas = new OffscreenCanvas(this.aw, this.ah);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  get gpu() {
    return this.backend === 'webgpu';
  }

  /** Draw a picture at its own size into the blit canvas (the GPU detector downsamples). */
  blit(source, w, h) {
    if (!this.blitCanvas) {
      this.blitCanvas = new OffscreenCanvas(w, h);
      this.blitCtx = this.blitCanvas.getContext('2d');
    } else if (this.blitCanvas.width !== w || this.blitCanvas.height !== h) {
      this.blitCanvas.width = w;
      this.blitCanvas.height = h;
    }
    this.blitCtx.drawImage(source, 0, 0, w, h);
    return this.blitCanvas;
  }

  /**
   * Feed a picture to the GPU detector by whichever route this browser's
   * WebGPU accepts: the picture itself, a canvas it is drawn into, or its
   * pixels. `kind` is 'videoframe' or 'video'; `w`×`h` its visible size.
   */
  feedGpuSource(kind, source, w, h, t, capture) {
    const probe = this.probe;
    if (probe && probe.accepts(kind, source)) {
      this.route = kind;
      if (kind === 'videoframe') this.det.feed_video_frame(source, t, capture);
      else this.det.feed_video_element(source, t, capture);
      return;
    }
    let canvas = null;
    try {
      canvas = this.blit(source, w, h);
    } catch (e) {
      canvas = null;
    }
    if (canvas && probe && probe.accepts('canvas', canvas)) {
      this.route = 'canvas';
      this.det.feed_canvas(canvas, t, capture);
      return;
    }
    // no external source at all: the pixels through WASM memory
    if (!this.readCtx) {
      this.readCanvas = new OffscreenCanvas(w, h);
      this.readCtx = this.readCanvas.getContext('2d', { willReadFrequently: true });
    } else if (this.readCanvas.width !== w || this.readCanvas.height !== h) {
      this.readCanvas.width = w;
      this.readCanvas.height = h;
    }
    this.readCtx.drawImage(source, 0, 0, w, h);
    const img = this.readCtx.getImageData(0, 0, w, h);
    this.route = 'rgba';
    this.det.feed_rgba(img.data, w, h, t, capture);
  }

  async waitSlot() {
    while (!this.det.can_submit()) {
      this.det.poll();
      if (!this.det.can_submit()) await tick();
    }
  }

  async videoFrame(frame, t, capture = false) {
    await this.waitSlot();
    const t0 = performance.now();
    try {
      if (this.gpu) {
        const w = frame.visibleRect ? frame.visibleRect.width : frame.codedWidth;
        const h = frame.visibleRect ? frame.visibleRect.height : frame.codedHeight;
        this.feedGpuSource('videoframe', frame, w, h, t, capture);
      } else {
        // WebCodecs' own RGBA conversion plus the same box filter the GPU
        // applies (in WASM); the canvas is the fallback for browsers whose
        // copyTo cannot convert
        let fed = false;
        if (this.rgbaCopy !== false && typeof frame.allocationSize === 'function') {
          try {
            const opts = { format: 'RGBA' };
            const size = frame.allocationSize(opts);
            if (!this.rgbaBuf || this.rgbaBuf.byteLength < size) this.rgbaBuf = new Uint8Array(size);
            const layout = await frame.copyTo(this.rgbaBuf, opts);
            const w = frame.visibleRect ? frame.visibleRect.width : frame.codedWidth;
            const h = frame.visibleRect ? frame.visibleRect.height : frame.codedHeight;
            if (layout && layout[0] && layout[0].stride === w * 4) {
              this.det.feed_rgba(this.rgbaBuf.subarray(0, w * h * 4), w, h, t, capture);
              fed = true;
              this.rgbaCopy = true;
            }
          } catch (e) {
            this.rgbaCopy = false;
          }
        }
        if (!fed) {
          this.ctx.drawImage(frame, 0, 0, this.aw, this.ah);
          const img = this.ctx.getImageData(0, 0, this.aw, this.ah);
          this.det.feed_rgba(img.data, this.aw, this.ah, t, capture);
        }
      }
    } finally {
      frame.close();
    }
    this.busyNs += (performance.now() - t0) * 1e6;
    this.fed++;
    this.det.poll();
  }

  /** Feed the current picture of a <video> without waiting (the live monitor: the caller checked can_submit). */
  videoElementNow(video, t, capture = false) {
    const t0 = performance.now();
    if (this.gpu) {
      this.feedGpuSource('video', video, video.videoWidth, video.videoHeight, t, capture);
    } else {
      this.ctx.drawImage(video, 0, 0, this.aw, this.ah);
      const img = this.ctx.getImageData(0, 0, this.aw, this.ah);
      this.det.feed_rgba(img.data, this.aw, this.ah, t, capture);
    }
    this.busyNs += (performance.now() - t0) * 1e6;
    this.fed++;
  }

  async videoElement(video, t, capture = false) {
    await this.waitSlot();
    this.videoElementNow(video, t, capture);
    this.det.poll();
  }

  async cached(cache, index, t) {
    await this.waitSlot();
    this.det.feed_cached(cache, index, t);
    this.fed++;
    this.det.poll();
  }

  /** Wait until every submitted frame has been processed. */
  async drain() {
    while (this.det.pending() > 0) {
      this.det.poll();
      if (this.det.pending() > 0) await tick();
    }
  }

  records() {
    return JSON.parse(this.det.drain_records());
  }

  reset() {
    this.det.reset();
    this.fed = 0;
    this.busyNs = 0;
  }

  finish(includeStats = false) {
    return JSON.parse(this.det.finish(includeStats));
  }
}
