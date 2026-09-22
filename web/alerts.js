// Telling someone who has looked away that a long job is over: a beep, a
// system notification when the browser allows one, and the tab's title
// (which also shows a running job's progress).

const KEY = 'unflash.alerts';
const DEFAULTS = { beep: true, notify: false, after: 60 };

export function loadAlertSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...s };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

export function saveAlertSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    /* private window: the settings last for this visit */
  }
}

/**
 * Two rising notes when a job went well, two falling ones when it did not.
 * The page has been clicked by then (a file was opened), which is what
 * browsers ask before a page may make a sound.
 */
export async function beep(ok = true) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  let ctx;
  try {
    ctx = new AC();
    if (ctx.state === 'suspended') await ctx.resume();
    const t0 = ctx.currentTime + 0.03;
    const notes = ok ? [880, 1318.5] : [659.25, 440];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const s = t0 + i * 0.2;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.3, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.45);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(s);
      o.stop(s + 0.5);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1500);
    return ctx.state === 'running';
  } catch (e) {
    console.warn('[unflash] could not beep:', e);
    if (ctx) ctx.close().catch(() => {});
    return false;
  }
}

/** Ask for leave to show notifications (call from a click). */
export async function askNotifyPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission();
    } catch (e) {
      return 'denied';
    }
  }
  return Notification.permission;
}

export function notifyState() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

/** A system notification, if allowed; clicking it brings the tab forward. */
export function systemNotify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag: 'unflash-job' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch (e) {
    // some browsers only notify through a service worker
    return false;
  }
}

// ---- the tab's title ---------------------------------------------------------

const BASE_TITLE = document.title;
let mark = '';
let running = '';

function applyTitle() {
  document.title = running || (mark ? `${mark} ${BASE_TITLE}` : BASE_TITLE);
}

/** A running job's progress in the title ('' when none runs). */
export function titleProgress(text) {
  running = text;
  if (text) mark = '';
  applyTitle();
}

/** ✓ or ✗ before the title until the tab is looked at again. */
export function titleMark(ok) {
  if (!document.hidden) return;
  mark = ok ? '✓' : '✗';
  applyTitle();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && mark) {
    mark = '';
    applyTitle();
  }
});
