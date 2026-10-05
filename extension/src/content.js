// Runs in every page and frame; the guard itself is a module, imported from
// the extension (content scripts cannot be modules). It loads the detector
// only once a video plays.
(() => {
  if (window.__unflashGuard) return;
  window.__unflashGuard = true;
  const api = globalThis.browser ?? globalThis.chrome;
  import(api.runtime.getURL('guard.js'))
    .then((m) => m.start())
    .catch((e) => console.warn('[unflash] the video guard could not start', e));
})();
