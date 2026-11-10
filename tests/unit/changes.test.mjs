// What's new (web/changes.js): CHANGELOG.md read as days of changes, each
// with the time it went live, its tour and its film; which of them a
// returning visitor has not seen; and a day as the HTML the page shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { changesSince, escapeHtml, newestChange, parseChangelog, renderDay } from '../../web/changes.js';
import { TOURS } from '../../web/tours.js';

const SAMPLE = `# What's new

Some words for the reader.

<!-- A note for whoever edits the file,
over two lines. -->

## 2026-03-02

- <!-- 16:05 tour:findings shot:close-calls --> **A headline.** And the rest of it,
  carried on under it.
- <!-- 9:30 --> A change with a time and nothing else.
- A change with no time at all.

## 2026-03-01 — the first day

* <!-- 23:59 shot:start-page --> Written with a star, \`code\`, *slanted* and [a link](https://example.org/a?b=1).

## 2026-02-28

Words under a day that are no change.
`;

test('a changelog is days of changes, newest first, each with when it went live', () => {
  const log = parseChangelog(SAMPLE);
  // (the day with no change in it is left out)
  assert.deepEqual(log.days.map((d) => d.date), ['2026-03-02', '2026-03-01']);
  const [a, b, c] = log.days[0].items;
  assert.equal(a.at, Date.UTC(2026, 2, 2, 16, 5));
  assert.equal(a.timed, true);
  assert.equal(a.tour, 'findings');
  assert.equal(a.shot, 'close-calls');
  assert.equal(a.html, '<b>A headline.</b> And the rest of it, carried on under it.');
  assert.equal(b.at, Date.UTC(2026, 2, 2, 9, 30));
  assert.deepEqual([b.tour, b.shot], [null, null]);
  // without a time, a change counts from its day's noon (UTC)
  assert.equal(c.at, Date.UTC(2026, 2, 2, 12));
  assert.equal(c.timed, false);
  assert.equal(c.html, 'A change with no time at all.');
});

test("a day's heading may carry a note, and the editors' comments are no part of it", () => {
  const log = parseChangelog(SAMPLE);
  assert.match(log.days[0].label, /2026/);
  assert.doesNotMatch(log.days[0].label, /:/);
  assert.match(log.days[1].label, /2026.*: the first day$/);
  assert.ok(!JSON.stringify(log).includes('whoever edits'));
});

test("a change's markdown becomes HTML, and its own angle brackets do not", () => {
  const item = parseChangelog(SAMPLE).days[1].items[0];
  assert.equal(item.html, 'Written with a star, <code>code</code>, <i>slanted</i> and <a href="https://example.org/a?b=1" target="_blank" rel="noopener">a link</a>.');
  const hostile = parseChangelog('## 2026-01-01\n\n- <!-- 10:00 --> <img src=x onerror=alert(1)> & [x](javascript:alert(1))\n').days[0].items[0];
  assert.equal(hostile.html, '&lt;img src=x onerror=alert(1)&gt; &amp; [x](javascript:alert(1))');
  assert.equal(escapeHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
});

test('changes before any day, and files with none, give an empty log', () => {
  assert.deepEqual(parseChangelog('- <!-- 10:00 --> nowhere\n'), { days: [] });
  assert.deepEqual(parseChangelog(''), { days: [] });
  assert.equal(newestChange(parseChangelog('')), 0);
});

test('a visitor coming back is shown what went live since', () => {
  const log = parseChangelog(SAMPLE);
  assert.equal(newestChange(log), Date.UTC(2026, 2, 2, 16, 5));
  const since = changesSince(log, Date.UTC(2026, 2, 2, 10));
  assert.deepEqual(since.map((d) => [d.date, d.items.length]), [['2026-03-02', 2]]);
  // a change is new only after the moment it went live
  assert.deepEqual(changesSince(log, Date.UTC(2026, 2, 2, 16, 5)), []);
  assert.equal(changesSince(log, Date.UTC(2026, 2, 2, 16, 4)).length, 1);
  assert.equal(changesSince(log, 0).reduce((n, d) => n + d.items.length, 0), 4);
});

test('a day is drawn with its new changes marked, a tour button and the film', () => {
  const log = parseChangelog(SAMPLE);
  const shots = { 'close-calls': { w: 640, h: 360, alt: 'What "it" shows', sound: true } };
  const html = renderDay(log.days[0], (it) => it.shot === 'close-calls', false, shots);
  assert.match(html, /^<h3>[^<]*2026[^<]*<\/h3><ul><li class="new">/);
  assert.equal(html.match(/<li/g).length, 3);
  assert.equal(html.match(/class="new"/g).length, 1);
  assert.match(html, /<button class="small show-me" data-tour="findings"/);
  assert.match(html, /<video muted loop playsinline preload="none" poster="whatsnew\/close-calls\.webp" width="640" height="360">/);
  assert.match(html, /<source src="whatsnew\/close-calls\.webm" type="video\/webm">/);
  // the description is an attribute: its quotes must not end it
  assert.match(html, /title="What &quot;it&quot; shows"/);
  assert.match(html, /class="small shot-sound"/);
  // a film nobody has made is left out, not linked to
  assert.doesNotMatch(renderDay(log.days[1]), /<video/);
});

test('in brief, a change is its headline, which opens to the rest', () => {
  const day = parseChangelog('## 2026-01-01\n\n- <!-- 10:00 --> **Headline here.** The rest.\n- <!-- 11:00 --> **Only a headline.**\n- <!-- 12:00 --> No headline at all.\n- <!-- 13:00 --> **Not a sentence** of its own.\n').days[0];
  const html = renderDay(day, () => false, true);
  assert.match(html, /<details class="brief"><summary>Headline here<\/summary>The rest\.<\/details>/);
  assert.match(html, /<li><b>Only a headline\.<\/b><\/li>/);
  assert.match(html, /<li>No headline at all\.<\/li>/);
  // a headline that runs on into the sentence: the whole change again under it
  assert.match(html, /<summary>Not a sentence<\/summary><b>Not a sentence<\/b> of its own\.<\/details>/);
});

test("the project's own changelog reads whole: every change timed, with a film and a tour that exists", () => {
  const log = parseChangelog(fs.readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'));
  const shots = JSON.parse(fs.readFileSync(new URL('../../web/whatsnew/shots.json', import.meta.url), 'utf8'));
  const lines = fs.readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
  const items = log.days.flatMap((d) => d.items);
  // every bullet line of the file became a change, and every day a day
  assert.equal(items.length, lines.filter((l) => /^- /.test(l)).length);
  assert.equal(log.days.length, lines.filter((l) => /^## \d{4}-\d{2}-\d{2}/.test(l)).length);
  const tours = new Set(Object.keys(TOURS));
  for (const day of log.days) {
    for (const it of day.items) {
      const what = `${day.date}: ${it.html.slice(0, 60)}`;
      assert.ok(it.timed, `no time: ${what}`);
      assert.ok(it.shot && shots[it.shot], `no film: ${what}`);
      if (it.tour) assert.ok(tours.has(it.tour), `tour:${it.tour} is not in tours.js: ${what}`);
      assert.ok(it.html.length > 20, `nothing said: ${what}`);
    }
  }
  // newest first, as the file is to be kept
  for (let i = 1; i < log.days.length; i++) assert.ok(log.days[i].date < log.days[i - 1].date, `${log.days[i].date} after ${log.days[i - 1].date}`);
});
