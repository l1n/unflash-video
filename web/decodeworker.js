// A Web Worker that decodes one span of the video with WebCodecs and hands
// each picture over as plain bytes: its own YUV planes, or its pixels when
// the decoder gives RGB (BGRX on a Mac), copied here rather than on the
// page. For browsers whose WebGPU takes no VideoFrame (Firefox), where
// that copy is otherwise the page's biggest cost per frame; several
// workers copy at once.
//
// Protocol (page -> worker): {type:'decode', id, file, config, offset,
// size, pts, dur, sync, startUs, endUs, window}: decode those samples (in
// decode order) and send back the pictures with startUs <= timestamp <
// endUs, at most `window` of them unconsumed; {type:'credit', n, buffer?}
// after consuming a picture (its buffer comes back to be filled again);
// {type:'cancel'}.
// Worker -> page: {type:'frame', id, pic} (a transferred record: kind
// 'yuv' | 'rgba' | 'bgra', data, width, height, timestamp, layout,
// colorSpace, format) or {type:'frame', id, frame} (a VideoFrame that can't
// be copied, transferred as it is); {type:'done', id, frames} |
// {type:'error', id, message}.
import { ChunkReader, yuvLayoutWords } from './media.js';

let credits = 0;
let cancelled = false;
let waiter = null;
const spare = []; // buffers the page gave back
const wake = () => {
  if (waiter) {
    const w = waiter;
    waiter = null;
    w();
  }
};
// woken by the decoder, a credit or a cancel; the timer is a safety net only
const wait = () =>
  new Promise((r) => {
    waiter = r;
    setTimeout(wake, 100);
  });

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'decode') {
    run(m).catch((err) => self.postMessage({ type: 'error', id: m.id, message: err && err.message ? err.message : String(err) }));
  } else if (m.type === 'credit') {
    credits += m.n;
    if (m.buffer) spare.push(m.buffer);
    wake();
  } else if (m.type === 'cancel') {
    cancelled = true;
    wake();
  }
};

function bufferOf(size) {
  for (let i = 0; i < spare.length; i++) {
    if (spare[i].byteLength >= size) return spare.splice(i, 1)[0];
  }
  if (spare.length > 8) spare.length = 0;
  return new ArrayBuffer(size);
}

const COPYABLE = ['I420', 'I420A', 'NV12', 'RGBA', 'RGBX', 'BGRA', 'BGRX'];

/** One decoded picture to the page, copied out when its format allows. */
async function send(f, id) {
  const fmt = f.format;
  const w = f.visibleRect ? f.visibleRect.width : f.codedWidth;
  const h = f.visibleRect ? f.visibleRect.height : f.codedHeight;
  if (COPYABLE.includes(fmt)) {
    const size = f.allocationSize();
    const buf = bufferOf(size);
    const planes = await f.copyTo(buf);
    const packed = fmt[0] === 'R' || fmt[0] === 'B';
    if (!packed || (planes[0].offset === 0 && planes[0].stride === w * 4)) {
      const colorSpace = f.colorSpace && f.colorSpace.toJSON ? f.colorSpace.toJSON() : null;
      const pic = { kind: packed ? (fmt[0] === 'B' ? 'bgra' : 'rgba') : 'yuv', data: buf, bytes: size, width: w, height: h, timestamp: f.timestamp, layout: packed ? null : yuvLayoutWords(fmt, planes, f.colorSpace, h), colorSpace, format: fmt };
      f.close();
      self.postMessage({ type: 'frame', id, pic }, [buf]);
      return;
    }
    spare.push(buf);
  }
  // opaque (or oddly laid out): the frame itself
  self.postMessage({ type: 'frame', id, frame: f }, [f]);
}

async function run(job) {
  const { id, file, config, offset, size, pts, dur, sync, startUs, endUs, window } = job;
  cancelled = false;
  credits = window;
  // a window of its own over the file; a small file read whole
  const reader = new ChunkReader(file, 8 * 1024 * 1024, 16 * 1024 * 1024);
  const queue = [];
  let error = null;
  const decoder = new VideoDecoder({
    output: (f) => {
      queue.push(f);
      wake();
    },
    error: (e) => {
      error = e;
      wake();
    },
  });
  if ('ondequeue' in decoder) decoder.addEventListener('dequeue', wake);
  decoder.configure(config);
  let frames = 0;
  // pictures out while there are credits for them
  const pump = async () => {
    while (queue.length && !cancelled && !error) {
      const t = queue[0].timestamp;
      if (t < startUs - 1 || t >= endUs - 0.001) {
        queue.shift().close();
        continue;
      }
      if (credits <= 0) return;
      credits--;
      await send(queue.shift(), id);
      frames++;
    }
  };
  try {
    const n = offset.length;
    for (let i = 0; i < n && !error && !cancelled; i++) {
      while ((decoder.decodeQueueSize > 8 || queue.length > 4) && !error && !cancelled) {
        await pump();
        if (!(decoder.decodeQueueSize > 8 || queue.length > 4) || error || cancelled) break;
        await wait();
      }
      if (error || cancelled) break;
      const data = await reader.read(offset[i], size[i]);
      decoder.decode(new EncodedVideoChunk({ type: sync[i] ? 'key' : 'delta', timestamp: pts[i], duration: dur[i], data }));
      await pump();
    }
    if (!error && !cancelled) {
      let flushed = false;
      decoder.flush().then(
        () => {
          flushed = true;
          wake();
        },
        (e) => {
          error = error || e;
          flushed = true;
          wake();
        }
      );
      while (!flushed && !cancelled) {
        await pump();
        if (!flushed) await wait();
      }
    }
    // the last pictures, as the page makes room for them
    while (queue.length && !cancelled && !error) {
      await pump();
      if (queue.length) await wait();
    }
    if (error) throw error;
    self.postMessage({ type: 'done', id, frames });
  } finally {
    while (queue.length) queue.shift().close();
    try {
      decoder.close();
    } catch (e) {
      /* already closed */
    }
    reader.release();
  }
}
