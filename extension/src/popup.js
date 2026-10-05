import { api, loadSettings, saveSettings } from './settings.js';

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : '';
  } catch (e) {
    return '';
  }
}

async function render() {
  const s = await loadSettings();
  const tab = await activeTab();
  const host = tab ? hostOf(tab.url) : '';
  $('enabled').checked = s.enabled;
  $('host').textContent = host || 'this page';
  $('site').checked = !s.disabledSites.includes(host);
  $('site').disabled = !host || !s.enabled;
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === s.mode;
  $('sensitivity').value = s.sensitivity;
  $('lookahead').value = String(s.lookahead);
  $('profile').value = s.profile;
  $('detector').value = s.detector;
  $('badge').checked = s.badge;
  document.body.classList.toggle('off', !s.enabled);

  let st = {};
  if (tab) {
    try {
      st = (await api.runtime.sendMessage({ type: 'tabStatus', tabId: tab.id })) || {};
    } catch (e) {
      /* no background yet */
    }
  }
  let line;
  let detail = '';
  if (!s.enabled) line = 'Off everywhere.';
  else if (!host) line = 'Unflash guards videos on web pages.';
  else if (s.disabledSites.includes(host)) line = `Off on ${host}.`;
  else if (st.active) line = 'Flashing now: the video is hidden.';
  else if (st.videos) line = `Watching ${st.videos} video${st.videos === 1 ? '' : 's'}${st.events ? `: flashing stopped ${st.events} time${st.events === 1 ? '' : 's'}` : ': no flashing so far'}.`;
  else line = 'No video playing on this page.';
  if (st.videos && s.enabled) detail = `${st.backend === 'webgpu' ? 'On the graphics card' : 'On the processor'} · ${st.msPerFrame.toFixed(1)} ms a picture`;
  if (st.ahead && s.enabled) detail += ` · ${s.lookahead} s ahead`;
  if (st.onTime && s.enabled) detail += `${detail ? ' · ' : ''}${st.onTime} video${st.onTime === 1 ? '' : 's'} shown as ${st.onTime === 1 ? 'it plays' : 'they play'}: click the page to let its sound be delayed`;
  if (st.unreadable) detail += `${detail ? ' · ' : ''}${st.unreadable} video${st.unreadable === 1 ? '' : 's'} from another site cannot be read here`;
  $('statusLine').textContent = line;
  $('statusDetail').textContent = detail;
  $('status').className = `status${st.active ? ' bad' : st.videos ? ' ok' : ''}`;
}

$('enabled').addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));
$('site').addEventListener('change', async (e) => {
  const s = await loadSettings();
  const host = $('host').textContent;
  const set = new Set(s.disabledSites);
  if (e.target.checked) set.delete(host);
  else set.add(host);
  await saveSettings({ disabledSites: [...set] });
});
for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', () => saveSettings({ mode: r.value }));
for (const id of ['sensitivity', 'profile', 'detector']) $(id).addEventListener('change', (e) => saveSettings({ [id]: e.target.value }));
$('lookahead').addEventListener('change', (e) => saveSettings({ lookahead: Number(e.target.value) }));
$('badge').addEventListener('change', (e) => saveSettings({ badge: e.target.checked }));

api.storage.onChanged.addListener(() => render());
render();
setInterval(render, 1000);
