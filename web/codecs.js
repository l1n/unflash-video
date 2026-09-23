// The decoders built into the app, for the codecs a browser's WebCodecs may
// lack: H.264 in the main WebAssembly module (h264worker.js), the others in
// the decoders module (pkg-dec, softworker.js).

/**
 * Whether this build has the decoders module (web/pkg-dec). Until it does,
 * only H.264 has a built-in decoder and everything else is left to WebCodecs.
 */
export const DECODERS_MODULE = true;

export const BUILT_IN = [
  { id: 'h264', name: 'H.264', test: /^avc[13]/, module: 'main' },
  { id: 'hevc', name: 'HEVC', test: /^(hev1|hvc1)/, module: 'decoders' },
  { id: 'vp9', name: 'VP9', test: /^vp09/, module: 'decoders' },
  { id: 'vp8', name: 'VP8', test: /^vp8/, module: 'decoders' },
  { id: 'av1', name: 'AV1', test: /^av01/, module: 'decoders' },
].filter((b) => b.module === 'main' || DECODERS_MODULE);

/** The built-in decoder for a WebCodecs codec string, or null. */
export function builtInFor(codec) {
  return BUILT_IN.find((b) => b.test.test(codec || '')) || null;
}

let decoders = null;

/** The decoders module (HEVC, VP9, VP8, AV1), loaded on first use. */
export function loadDecoders() {
  if (!decoders)
    decoders = (async () => {
      const mod = await import('./pkg-dec/unflash_decoders.js');
      await mod.default();
      return mod;
    })();
  return decoders;
}
