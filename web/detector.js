// The detector, wrapped so the rest of the app does not care whether it runs
// on the GPU or the CPU, nor by which route a picture reaches it.

import { orTimeout, yuvLayoutWords } from './media.js';
import { profile } from './profile.js';

/**
 * `route`: force one way of feeding VideoFrames (tests / diagnostics):
 * videoframe, yuv, rgba, canvas or pixels. `externalSources`: pretend the
 * browser's WebGPU accepts only these kinds of copy source.
 */
export async function createDetector(wasm, configJson, width, height, { preferGpu = true, externalSources = null, route = null, batch = null } = {}) {
  let det = null;
  let backend = 'cpu';
  let note = '';
  let probe = null;
  if (preferGpu && navigator.gpu) {
    try {
      // frames per command buffer and readback: many for throughput, one
      // where a result is wanted after every frame (the live monitor)
      det = await wasm.Detector.createGpu(configJson, width, height, batch || undefined);
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
  return new Feeder(wasm, det, backend, note, probe, route);
}

/**
 * Which kinds of picture the browser's WebGPU accepts as a
 * copyExternalImageToTexture source. Firefox takes only ImageBitmap,
 * HTMLImageElement, HTMLCanvasElement and OffscreenCanvas; a VideoFrame or a
 * <video> makes it throw a TypeError, which wgpu unwraps, and that aborts the
 * whole WASM instance. So every kind of source is tried once on a throwaway
 * device before it is allowed through to WASM.
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
      console.warn('cannot probe WebGPU picture sources; pictures will not be handed to WebGPU directly', e);
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
      console.debug(`[unflash] WebGPU does not take a ${kind} as a copy source here (${e.message})`);
    }
    this.support[kind] = ok;
    if (['videoframe', 'video', 'canvas'].every((k) => this.support[k] !== undefined)) this.release();
    return ok;
  }
}

/** The routes a VideoFrame can take to the detector, best first. */
const FRAME_ROUTES = ['videoframe', 'yuv', 'rgba', 'canvas', 'pixels'];
/** The routes the live monitor's <video> element can take. */
const VIDEO_ROUTES = ['video', 'canvas', 'pixels'];

/** Feeds pictures of any kind into a Detector with back-pressure. */
export class Feeder {
  constructor(wasm, det, backend, note, probe = null, route = null) {
    this.wasm = wasm;
    this.det = det;
    this.backend = backend;
    this.note = note;
    this.probe = probe;
    this.aw = det.analysis_width();
    this.ah = det.analysis_height();
    this.fed = 0;
    this.busyNs = 0;
    this.route = ''; // how the last picture reached the detector
    this.reported = '';
    this.frameRoutes = route ? [route] : FRAME_ROUTES.slice();
    this.videoRoutes = route && VIDEO_ROUTES.includes(route) ? [route] : VIDEO_ROUTES.slice();
    this.submitted = []; // submit times of the GPU frames in flight (latency accounting)
    if (backend === 'cpu') {
      this.canvas = new OffscreenCanvas(this.aw, this.ah);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  get gpu() {
    return this.backend === 'webgpu';
  }

  /** Collect finished GPU frames; returns how many completed. */
  poll() {
    const t0 = performance.now();
    const n = this.det.poll();
    const now = performance.now();
    profile.add('poll', now - t0);
    for (let i = 0; i < n && this.submitted.length; i++) profile.add('gpu.latency', now - this.submitted.shift());
    return n;
  }

  /**
   * Until the GPU has results to hand back: woken by the readback itself
   * (a timer would crawl in a hidden tab); the timeout only guards against
   * a readback that never ends (a lost device).
   */
  gpuWait() {
    return orTimeout(this.det.gpu_wait(), 250);
  }

  async waitSlot() {
    if (this.det.can_submit()) return;
    const t0 = performance.now();
    while (!this.det.can_submit()) {
      this.poll();
      if (!this.det.can_submit()) await this.gpuWait();
    }
    profile.add('feed.wait', performance.now() - t0);
  }

  setRoute(route, detail = '') {
    this.route = route;
    if (route !== this.reported) {
      this.reported = route;
      profile.note('route', route + (detail ? ` (${detail})` : ''));
      console.debug(`[unflash] pictures reach the ${this.backend} detector as: ${route}${detail ? ' (' + detail + ')' : ''}`);
    }
  }

  dropRoute(list, route, why) {
    const i = list.indexOf(route);
    if (i >= 0) list.splice(i, 1);
    console.warn(`[unflash] picture route ${route} does not work here (${why}); ${list.length ? 'trying ' + list[0] : 'no route left'}`);
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
    const t0 = performance.now();
    this.blitCtx.drawImage(source, 0, 0, w, h);
    profile.add('feed.blit', performance.now() - t0);
    return this.blitCanvas;
  }

  /** The picture's pixels through a canvas: at full size for the GPU (it downsamples), at analysis size for the CPU. */
  feedPixels(source, w, h, t, capture) {
    const t0 = performance.now();
    let img;
    if (this.gpu) {
      if (!this.readCtx) {
        this.readCanvas = new OffscreenCanvas(w, h);
        this.readCtx = this.readCanvas.getContext('2d', { willReadFrequently: true });
      } else if (this.readCanvas.width !== w || this.readCanvas.height !== h) {
        this.readCanvas.width = w;
        this.readCanvas.height = h;
      }
      this.readCtx.drawImage(source, 0, 0, w, h);
      img = this.readCtx.getImageData(0, 0, w, h);
    } else {
      this.ctx.drawImage(source, 0, 0, this.aw, this.ah);
      img = this.ctx.getImageData(0, 0, this.aw, this.ah);
    }
    profile.add('feed.pixels', performance.now() - t0);
    const t1 = performance.now();
    this.det.feed_rgba(img.data, img.width, img.height, t, capture);
    profile.add('feed.upload', performance.now() - t1);
  }

  /** The frame's own 4:2:0 planes (I420 / NV12), converted by the detector. False when the frame cannot give them. */
  async feedYuv(frame, w, h, t, capture) {
    const fmt = frame.format;
    if (fmt !== 'I420' && fmt !== 'I420A' && fmt !== 'NV12') return false;
    const size = frame.allocationSize();
    if (!this.yuvBuf || this.yuvBuf.byteLength < size) this.yuvBuf = new Uint8Array(size);
    const t0 = performance.now();
    const planes = await frame.copyTo(this.yuvBuf);
    profile.add('feed.copyTo', performance.now() - t0);
    if (!planes || planes.length < (fmt === 'NV12' ? 2 : 3)) return false;
    const layout = yuvLayoutWords(fmt, planes, frame.colorSpace, h);
    const t1 = performance.now();
    this.det.feed_yuv(this.yuvBuf.subarray(0, size), w, h, layout, t, capture);
    profile.add('feed.upload', performance.now() - t1);
    this.yuvDetail = `${fmt}, ${layout[7] ? 'BT.709' : 'BT.601'} ${layout[8] ? 'full' : 'limited'} range`;
    return true;
  }

  /**
   * A picture that is already 8-bit RGB of some order (Firefox on a Mac
   * decodes to BGRX) copied as it is, the GPU putting the channels back in
   * order: a plain copy rather than WebCodecs converting every pixel. False
   * when the frame is not like that or the copy does not come out packed.
   */
  async feedPacked(frame, w, h, t, capture) {
    const fmt = frame.format;
    if (this.packedCopy === false || !['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(fmt)) return false;
    const size = frame.allocationSize();
    if (!this.rgbaBuf || this.rgbaBuf.byteLength < size) this.rgbaBuf = new Uint8Array(size);
    let layout;
    const t0 = performance.now();
    try {
      layout = await frame.copyTo(this.rgbaBuf);
    } catch (e) {
      this.packedCopy = false;
      return false;
    }
    profile.add('feed.copyTo', performance.now() - t0);
    if (!layout || !layout[0] || layout[0].offset !== 0 || layout[0].stride !== w * 4) {
      this.packedCopy = false;
      return false;
    }
    const t1 = performance.now();
    if (fmt[0] === 'B') this.det.feed_bgra(this.rgbaBuf.subarray(0, w * h * 4), w, h, t, capture);
    else this.det.feed_rgba(this.rgbaBuf.subarray(0, w * h * 4), w, h, t, capture);
    profile.add('feed.upload', performance.now() - t1);
    this.rgbaDetail = `${fmt} as decoded`;
    return true;
  }

  /** WebCodecs' own RGBA conversion. False when this browser's copyTo cannot convert. */
  async feedRgba(frame, w, h, t, capture) {
    if (await this.feedPacked(frame, w, h, t, capture)) return true;
    this.rgbaDetail = '';
    if (this.rgbaCopy === false || typeof frame.allocationSize !== 'function') return false;
    let layout;
    const opts = { format: 'RGBA' };
    try {
      const size = frame.allocationSize(opts);
      if (!this.rgbaBuf || this.rgbaBuf.byteLength < size) this.rgbaBuf = new Uint8Array(size);
      const t0 = performance.now();
      layout = await frame.copyTo(this.rgbaBuf, opts);
      profile.add('feed.copyTo', performance.now() - t0);
    } catch (e) {
      this.rgbaCopy = false;
      return false;
    }
    if (!layout || !layout[0] || layout[0].stride !== w * 4) {
      this.rgbaCopy = false;
      return false;
    }
    this.rgbaCopy = true;
    const t1 = performance.now();
    this.det.feed_rgba(this.rgbaBuf.subarray(0, w * h * 4), w, h, t, capture);
    profile.add('feed.upload', performance.now() - t1);
    return true;
  }

  /** A picture from the built-in decoder: I420 planes already in memory. */
  feedRaw(pic, t, capture) {
    const t0 = performance.now();
    this.det.feed_yuv(pic.data, pic.codedWidth, pic.codedHeight, pic.layout, t, capture);
    profile.add('feed.upload', performance.now() - t0);
    this.setRoute('raw', 'I420 from the built-in decoder');
  }

  /** Feed a VideoFrame by the first route that works here. */
  async feedFrame(frame, t, capture) {
    if (frame.raw) {
      this.feedRaw(frame, t, capture);
      return;
    }
    const w = frame.visibleRect ? frame.visibleRect.width : frame.codedWidth;
    const h = frame.visibleRect ? frame.visibleRect.height : frame.codedHeight;
    const routes = this.frameRoutes;
    while (routes.length) {
      const route = routes[0];
      let detail = '';
      try {
        switch (route) {
          case 'videoframe': {
            if (!this.gpu || !this.probe || !this.probe.accepts('videoframe', frame)) {
              this.dropRoute(routes, route, this.gpu ? 'not accepted by WebGPU' : 'CPU detector');
              continue;
            }
            const t0 = performance.now();
            this.det.feed_video_frame(frame, t, capture);
            profile.add('feed.upload', performance.now() - t0);
            break;
          }
          case 'yuv':
            if (!(await this.feedYuv(frame, w, h, t, capture))) {
              this.dropRoute(routes, route, `frames are ${frame.format || 'opaque'}`);
              continue;
            }
            detail = this.yuvDetail;
            break;
          case 'rgba':
            if (!(await this.feedRgba(frame, w, h, t, capture))) {
              this.dropRoute(routes, route, 'copyTo cannot convert to RGBA');
              continue;
            }
            detail = this.rgbaDetail;
            break;
          case 'canvas': {
            if (!this.gpu) {
              this.dropRoute(routes, route, 'CPU detector');
              continue;
            }
            const canvas = this.blit(frame, w, h);
            if (!this.probe || !this.probe.accepts('canvas', canvas)) {
              this.dropRoute(routes, route, 'not accepted by WebGPU');
              continue;
            }
            const t0 = performance.now();
            this.det.feed_canvas(canvas, t, capture);
            profile.add('feed.upload', performance.now() - t0);
            break;
          }
          case 'pixels':
            this.feedPixels(frame, w, h, t, capture);
            break;
          default:
            this.dropRoute(routes, route, 'unknown route');
            continue;
        }
      } catch (e) {
        this.dropRoute(routes, route, e && e.message ? e.message : e);
        continue;
      }
      this.setRoute(route, detail);
      return;
    }
    throw new Error('no way to feed pictures to the detector in this browser');
  }

  async videoFrame(frame, t, capture = false) {
    await this.waitSlot();
    const t0 = performance.now();
    try {
      await this.feedFrame(frame, t, capture);
    } finally {
      frame.close();
    }
    const now = performance.now();
    profile.add('feed', now - t0);
    this.busyNs += (now - t0) * 1e6;
    this.fed++;
    if (this.gpu) this.submitted.push(now);
    this.poll();
  }

  /** Feed the current picture of a <video> without waiting (the live monitor: the caller checked can_submit). */
  videoElementNow(video, t, capture = false) {
    const t0 = performance.now();
    const w = video.videoWidth;
    const h = video.videoHeight;
    const routes = this.videoRoutes;
    let done = false;
    while (routes.length && !done) {
      const route = routes[0];
      try {
        switch (route) {
          case 'video':
            if (!this.gpu || !this.probe || !this.probe.accepts('video', video)) {
              this.dropRoute(routes, route, this.gpu ? 'not accepted by WebGPU' : 'CPU detector');
              continue;
            }
            this.det.feed_video_element(video, t, capture);
            break;
          case 'canvas': {
            if (!this.gpu) {
              this.dropRoute(routes, route, 'CPU detector');
              continue;
            }
            const canvas = this.blit(video, w, h);
            if (!this.probe || !this.probe.accepts('canvas', canvas)) {
              this.dropRoute(routes, route, 'not accepted by WebGPU');
              continue;
            }
            this.det.feed_canvas(canvas, t, capture);
            break;
          }
          default:
            this.feedPixels(video, w, h, t, capture);
            break;
        }
      } catch (e) {
        this.dropRoute(routes, route, e && e.message ? e.message : e);
        continue;
      }
      this.setRoute(route);
      done = true;
    }
    if (!done) throw new Error('no way to feed the video to the detector in this browser');
    const now = performance.now();
    profile.add('feed', now - t0);
    this.busyNs += (now - t0) * 1e6;
    this.fed++;
    if (this.gpu) this.submitted.push(now);
  }

  async videoElement(video, t, capture = false) {
    await this.waitSlot();
    this.videoElementNow(video, t, capture);
    this.poll();
  }

  async cached(cache, index, t) {
    await this.waitSlot();
    const t0 = performance.now();
    this.det.feed_cached(cache, index, t);
    profile.add('feed', performance.now() - t0);
    this.fed++;
    if (this.gpu) this.submitted.push(performance.now());
    this.poll();
  }

  /** Wait until every submitted frame has been processed. */
  async drain() {
    const t0 = performance.now();
    // the frames of a half-full batch would otherwise wait for more
    this.det.flush();
    while (this.det.pending() > 0) {
      this.poll();
      if (this.det.pending() > 0) await this.gpuWait();
    }
    profile.add('drain', performance.now() - t0);
  }

  records() {
    return JSON.parse(this.det.drain_records());
  }

  reset() {
    this.det.reset();
    this.fed = 0;
    this.busyNs = 0;
    this.submitted.length = 0;
  }

  finish(includeStats = false) {
    return JSON.parse(this.det.finish(includeStats));
  }
}
