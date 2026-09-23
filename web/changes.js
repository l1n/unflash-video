// What's new: the changelog (CHANGELOG.md, copied beside the page by
// build.sh) as days of changes, each change with the time it went live, and
// which of them a visitor coming back has not seen yet.

const SEEN_KEY = 'unflash:changesSeen';
/** Settings earlier versions kept: a browser that has them has been here before. */
const OLD_KEYS = ['unflash:auto', 'unflash:playerSize', 'unflash:thumbSize', 'unflash.alerts'];

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The changelog's inline markdown (bold, italics, code, links) as HTML. */
function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/**
 * The changelog as `{ days: [{ date, label, items: [{ at, timed, tour, html }] }] }`,
 * newest first as the file has them: a day per `## YYYY-MM-DD` heading, a
 * change per `- ` line (lines indented under it continue it), `at` the time
 * it went live in ms, from the `<!-- HH:MM -->` (UTC) it starts with, or the
 * day's noon when it has none (`timed` false). `<!-- HH:MM tour:id -->`
 * names the tour (tours.js) that shows the change. Comments on lines of
 * their own are notes to the file's editors.
 */
export function parseChangelog(md) {
  const days = [];
  let day = null;
  let item = null;
  const flush = () => {
    if (item && day) day.items.push({ at: item.at, timed: item.timed, tour: item.tour, html: inline(item.text.trim()) });
    item = null;
  };
  for (const line of md.replace(/^\s*<!--[\s\S]*?-->[ \t]*$/gm, '').split(/\r?\n/)) {
    const head = /^##\s+(\d{4})-(\d{2})-(\d{2})\b\s*(.*)$/.exec(line);
    if (head) {
      flush();
      const [, y, m, d, rest] = head;
      const noon = Date.UTC(+y, +m - 1, +d, 12);
      const date = new Date(noon).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      const note = rest.replace(/^[—–-]\s*/, '').trim();
      day = { date: `${y}-${m}-${d}`, label: note ? `${date}: ${note}` : date, items: [], y: +y, m: +m, d: +d };
      days.push(day);
      continue;
    }
    const bullet = /^[-*]\s+(?:<!--\s*(\d{1,2}):(\d{2})(?:\s+tour:([\w-]+))?\s*-->\s*)?(.*)$/.exec(line);
    if (bullet && day) {
      flush();
      const timed = bullet[1] !== undefined;
      item = { at: timed ? Date.UTC(day.y, day.m - 1, day.d, +bullet[1], +bullet[2]) : Date.UTC(day.y, day.m - 1, day.d, 12), timed, tour: bullet[3] || null, text: bullet[4] };
      continue;
    }
    if (item && /^\s+\S/.test(line)) item.text += ' ' + line.trim();
    else flush();
  }
  flush();
  return { days: days.map(({ date, label, items }) => ({ date, label, items })).filter((d) => d.items.length) };
}

/** The time of the newest change in a changelog (0 when it has none). */
export function newestChange(log) {
  let at = 0;
  for (const d of log.days) for (const it of d.items) at = Math.max(at, it.at);
  return at;
}

/** The changes that went live after `since` (ms), by day, newest first. */
export function changesSince(log, since) {
  return log.days.map((d) => ({ ...d, items: d.items.filter((it) => it.at > since) })).filter((d) => d.items.length);
}

export async function loadChangelog(url = 'CHANGELOG.md') {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return parseChangelog(await res.text());
}

/** The newest change this browser has been shown (ms), or null. */
export function changesSeen() {
  try {
    const v = Number(localStorage.getItem(SEEN_KEY));
    return v > 0 ? v : null;
  } catch (e) {
    return null;
  }
}

export function markChangesSeen(at) {
  try {
    localStorage.setItem(SEEN_KEY, String(at));
  } catch (e) {
    /* storage blocked: the notice comes back next time */
  }
}

/** Whether the settings of an earlier visit are here (read it before this visit writes its own). */
export function hadEarlierSettings() {
  try {
    return OLD_KEYS.some((k) => localStorage.getItem(k) !== null);
  } catch (e) {
    return false;
  }
}

/**
 * A day of changes as HTML (`isNew` marks the changes to highlight; a
 * change with a tour gets a "show me" button, `data-tour` its id).
 */
export function renderDay(day, isNew = () => false, brief = false) {
  const items = day.items
    .map((it) => `<li${isNew(it) ? ' class="new"' : ''}>${brief ? briefly(it.html) : it.html}${it.tour ? ` <button class="small show-me" data-tour="${escapeHtml(it.tour)}" title="A short tour of this">show me</button>` : ''}</li>`)
    .join('');
  return `<h3>${escapeHtml(day.label)}</h3><ul>${items}</ul>`;
}

/**
 * A change as its headline, which opens to the rest: its opening bold words
 * (the whole of it when there are none). Where the headline is not a
 * sentence of its own, the rest is the whole change again.
 */
export function briefly(html) {
  const m = /^<b>([\s\S]*?)<\/b>([\s\S]*)$/.exec(html);
  if (!m || !m[2].trim()) return html;
  const head = m[1];
  const own = /[.!?]\s*$/.test(head) || /^\s*:/.test(m[2]);
  const rest = own ? m[2].replace(/^\s*:?\s*/, '') : html;
  return `<details class="brief"><summary>${head.replace(/[.:]\s*$/, '')}</summary>${rest}</details>`;
}
