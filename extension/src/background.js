// The toolbar button: what the guard found in each tab (its count on the
// button, and the details for the popup), and the keyboard shortcut.

import { api, loadSettings, saveSettings } from './settings.js';

// (in session storage: a service worker is stopped when idle, and forgets)
const key = (tabId) => `tab:${tabId}`;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

async function tabStatus(tabId) {
  const k = key(tabId);
  const got = await api.storage.session.get(k);
  return got[k] || {};
}

/** The tab's frames' reports, summed. */
export function summary(frames) {
  const all = Object.values(frames);
  return {
    videos: all.reduce((a, s) => a + (s.videos || 0), 0),
    ahead: all.reduce((a, s) => a + (s.ahead || 0), 0),
    onTime: all.reduce((a, s) => a + (s.onTime || 0), 0),
    unreadable: all.reduce((a, s) => a + (s.unreadable || 0), 0),
    events: all.reduce((a, s) => a + (s.events || 0), 0),
    active: all.some((s) => s.active),
    backend: all.map((s) => s.backend).find(Boolean) || '',
    msPerFrame: Math.max(0, ...all.map((s) => s.msPerFrame || 0)),
  };
}

async function setBadge(tabId, s) {
  const text = s.active ? '!' : s.events ? String(s.events) : '';
  await api.action.setBadgeText({ tabId, text });
  await api.action.setBadgeBackgroundColor({ tabId, color: s.active ? '#d92d20' : '#b54708' });
}

let writes = Promise.resolve();

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'hello') {
    sendResponse({ host: hostOf(sender.tab && sender.tab.url) });
    return;
  }
  if (msg.type === 'status' && sender.tab) {
    const tabId = sender.tab.id;
    // (one write at a time: the frames of a tab report at once)
    writes = writes.then(async () => {
      const frames = await tabStatus(tabId);
      const { type, ...s } = msg;
      frames[sender.frameId || 0] = s;
      await api.storage.session.set({ [key(tabId)]: frames });
      await setBadge(tabId, summary(frames));
    }).catch(() => {});
    return;
  }
  if (msg.type === 'tabStatus') {
    tabStatus(msg.tabId).then((frames) => sendResponse(summary(frames)));
    return true;
  }
});

api.tabs.onRemoved.addListener((tabId) => api.storage.session.remove(key(tabId)));
api.tabs.onUpdated.addListener((tabId, change) => {
  // a new page: its guard reports afresh
  if (change.status === 'loading' && change.url) {
    writes = writes.then(() => api.storage.session.remove(key(tabId))).then(() => setBadge(tabId, {})).catch(() => {});
  }
});

api.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-guard') return;
  const s = await loadSettings();
  await saveSettings({ enabled: !s.enabled });
});
