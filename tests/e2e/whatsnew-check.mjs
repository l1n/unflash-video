// What's new has a film for every change, and every film is one that was
// checked (no browser needed): each change in CHANGELOG.md names a film
// (`shot:NAME`) that whatsnew-scenes.mjs has a scene for; shots.json
// describes it; its files are in web/whatsnew/ and are the very files
// Unflash scanned under its strictest profile and found nothing in (their
// checksums are the ones whatsnew.mjs wrote down after the scan); and
// nothing else is there.
//   node tests/e2e/whatsnew-check.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseChangelog } from '../../web/changes.js';
import { SCENES } from './whatsnew-scenes.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DIR = path.join(ROOT, 'web/whatsnew');
const problems = [];
const log = parseChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'));
const shots = JSON.parse(fs.readFileSync(path.join(DIR, 'shots.json'), 'utf8'));
const scenes = new Set(SCENES.map((s) => s.name));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const named = [];
for (const day of log.days) {
  for (const it of day.items) {
    const what = `${day.date} ${new Date(it.at).toISOString().slice(11, 16)} "${it.html.replace(/<[^>]+>/g, '').slice(0, 50)}…"`;
    if (!it.shot) {
      problems.push(`${what} names no film (shot:NAME)`);
      continue;
    }
    if (named.includes(it.shot)) problems.push(`${what}: the film ${it.shot} is named twice`);
    named.push(it.shot);
    if (!scenes.has(it.shot)) problems.push(`${what}: no scene films ${it.shot} (whatsnew-scenes.mjs)`);
    const s = shots[it.shot];
    if (!s) {
      problems.push(`${what}: ${it.shot} is not in shots.json (film it: node tests/e2e/whatsnew.mjs ${it.shot})`);
      continue;
    }
    if (!(s.w > 0 && s.h > 0 && s.seconds > 0 && s.alt && s.alt.length > 20)) problems.push(`${it.shot}: shots.json lacks its size, length or description`);
    if (!(s.checked && s.checked.profile === 'strict' && s.checked.violations === 0 && s.checked.frames > 0)) problems.push(`${it.shot}: not checked under the strict profile, or not clean: ${JSON.stringify(s.checked)}`);
    for (const ext of ['webm', 'webp']) {
      const f = path.join(DIR, `${it.shot}.${ext}`);
      if (!fs.existsSync(f)) problems.push(`${it.shot}.${ext} is missing`);
      else if (ext === 'webm' && sha(f) !== s.sha256) problems.push(`${it.shot}.webm is not the film that was checked (its checksum differs): film it again`);
    }
  }
}
// nothing left over: every film is named by a change, every file belongs to one
for (const name of Object.keys(shots)) if (!named.includes(name)) problems.push(`shots.json has ${name}, which no change names`);
for (const f of fs.readdirSync(DIR)) {
  const m = /^(.+)\.(webm|webp)$/.exec(f);
  if (f !== 'shots.json' && !(m && named.includes(m[1]))) problems.push(`web/whatsnew/${f} belongs to no change`);
}
const bytes = fs.readdirSync(DIR).reduce((a, f) => a + fs.statSync(path.join(DIR, f)).size, 0);
console.log(`what's new: ${named.length} changes, ${Object.keys(shots).length} films, ${(bytes / 1048576).toFixed(1)} MB in web/whatsnew`);
if (problems.length) {
  console.error(problems.map((p) => '  ' + p).join('\n'));
  process.exitCode = 1;
} else console.log("WHAT'S NEW FILMS OK");
