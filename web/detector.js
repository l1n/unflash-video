// The detector, wrapped so the rest of the app does not care whether it runs
// on the GPU or the CPU.

import { tick } from './media.js';

export async function createDetector(wasm, configJson, width, height, { preferGpu = true } = {}) {
  let det = null;
  let backend = 'cpu';
  let note = '';
  if (preferGpu && navigator.gpu) {
    try {
      det = await wasm.Detector.createGpu(configJson, width, height);
      backend = 'webgpu';
    } catch (e) {
      note = `WebGPU unavailable (${e && e.message ? e.message : e}); using the CPU detector`;
      console.warn(note);
    }
  } else if (preferGpu) {
    note = 'This browser has no WebGPU; using the CPU detector';
  }
  if (!det) det = new wasm.Detector(configJson, width, height);
  return new Feeder(wasm, det, backend, note);
}

/** Feeds pictures of any kind into a Detector with back-pressure. */
export class Feeder {
  constructor(wasm, det, backend, note) {
    this.wasm = wasm;
    this.det = det;
    this.backend = backend;
    this.note = note;
    this.aw = det.analysis_width();
    this.ah = det.analysis_height();
    this.fed = 0;
    this.busyNs = 0;
    if (backend === 'cpu') {
      this.canvas = new OffscreenCanvas(this.aw, this.ah);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  get gpu() {
    return this.backend === 'webgpu';
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
        this.det.feed_video_frame(frame, t, capture);
      } else {
        this.ctx.drawImage(frame, 0, 0, this.aw, this.ah);
        const img = this.ctx.getImageData(0, 0, this.aw, this.ah);
        this.det.feed_rgba(img.data, this.aw, this.ah, t, capture);
      }
    } finally {
      frame.close();
    }
    this.busyNs += (performance.now() - t0) * 1e6;
    this.fed++;
    this.det.poll();
  }

  async videoElement(video, t, capture = false) {
    await this.waitSlot();
    const t0 = performance.now();
    if (this.gpu) {
      this.det.feed_video_element(video, t, capture);
    } else {
      this.ctx.drawImage(video, 0, 0, this.aw, this.ah);
      const img = this.ctx.getImageData(0, 0, this.aw, this.ah);
      this.det.feed_rgba(img.data, this.aw, this.ah, t, capture);
    }
    this.busyNs += (performance.now() - t0) * 1e6;
    this.fed++;
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
