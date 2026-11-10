// The decoders built into the app, for the codecs a browser's WebCodecs may
// lack: H.264 in the main WebAssembly module, the others in the decoders
// module (pkg-dec); each runs in the decode workers (softworker.js), or on
// the page where they cannot run.

const BUILT_IN = [
  { id: 'h264', name: 'H.264', test: /^avc[13]/ },
  { id: 'hevc', name: 'HEVC', test: /^(hev1|hvc1)/ },
  { id: 'vp9', name: 'VP9', test: /^vp09/ },
  { id: 'vp8', name: 'VP8', test: /^vp8/ },
  { id: 'av1', name: 'AV1', test: /^av01/ },
];

/** The built-in decoder for a WebCodecs codec string, or null. */
export function builtInFor(codec) {
  return BUILT_IN.find((b) => b.test.test(codec || '')) || null;
}

/**
 * `load` as something asked for any number of times and run once: its
 * promise is kept and given to everyone who asks. But a load that failed
 * (the network down for a moment) is not kept: the next one who asks sets
 * off another.
 */
export function keptLoad(load) {
  let kept = null;
  return () => {
    if (!kept) {
      const mine = (kept = (async () => load())());
      mine.catch(() => {
        if (kept === mine) kept = null;
      });
    }
    return kept;
  };
}

/** The decoders module (HEVC, VP9, VP8, AV1, and the AC-3 / E-AC-3 and DTS sound decoder), loaded on first use. */
export const loadDecoders = keptLoad(async () => {
  const mod = await import('./pkg-dec/unflash_decoders.js');
  await mod.default();
  return mod;
});
