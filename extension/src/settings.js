// The extension's settings, kept in storage.sync: the defaults, and reading
// and watching them (the content script, the popup and the background all
// read them through here).

export const api = globalThis.browser ?? globalThis.chrome;

export const DEFAULTS = {
  enabled: true,
  // what happens when a video starts flashing: hold the last picture from
  // before the flashing over it, dim it, pause it, or only say so
  mode: 'hold',
  // how soon: 'early' at the first flash (two big changes of brightness in
  // a second), 'balanced' at the second swing after it, 'limit' only once
  // the flashing breaks the profile's limit
  sensitivity: 'balanced',
  // the detector's thresholds: the web app's profiles
  profile: 'wcag_ext',
  // 'auto': the GPU where it answers fast (Chrome, Edge, Safari), the CPU
  // in Firefox, whose GPU answers 300 ms late
  detector: 'auto',
  badge: true,
  // hostnames of the pages (the tab's, not an embedded player's) it leaves alone
  disabledSites: [],
};

export async function loadSettings() {
  const got = await api.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...got };
}

export function saveSettings(patch) {
  return api.storage.sync.set(patch);
}

/** Call `fn(settings)` whenever they change. */
export function watchSettings(fn) {
  api.storage.onChanged.addListener(async (_changes, area) => {
    if (area === 'sync') fn(await loadSettings());
  });
}

export function siteDisabled(settings, host) {
  return !!host && settings.disabledSites.includes(host);
}
