// What the detector's feeder (detector.js) needs of the rest of the page,
// kept apart from media.js so that the browser extension (extension/),
// which takes detector.js without the demuxing and decoding, can take it.

/**
 * Settles when `promise` does or after `ms`, whichever is first: a safety
 * net for waits on events that should come but might not (a lost device).
 */
export const orTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);

/**
 * The layout words Detector.feed_yuv takes: [format (0 I420, 1 NV12), y_off,
 * y_stride, u_off, u_stride, v_off, v_stride, matrix (0 BT.601, 1 BT.709),
 * full_range], from WebCodecs plane layouts and a VideoColorSpace (the
 * matrix is guessed from the picture height when unknown, as players do).
 */
export function yuvLayoutWords(format, planes, colorSpace, height) {
  const nv12 = format === 'NV12';
  const cs = colorSpace || {};
  let bt709;
  if (cs.matrix === 'bt709' || cs.matrix === 'bt2020-ncl') bt709 = 1;
  else if (cs.matrix === 'smpte170m' || cs.matrix === 'bt470bg' || cs.matrix === 'fcc') bt709 = 0;
  else bt709 = height > 576 ? 1 : 0;
  const u = planes[1];
  const v = nv12 ? planes[1] : planes[2];
  return Uint32Array.from([nv12 ? 1 : 0, planes[0].offset, planes[0].stride, u.offset, u.stride, v.offset, v.stride, bt709, cs.fullRange ? 1 : 0]);
}
