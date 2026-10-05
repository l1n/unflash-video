// Build the extension from extension/ and the web app's detector:
//   node extension/build.mjs          (after ./build.sh, which makes web/pkg)
// makes extension/build/chrome and extension/build/firefox (load either
// unpacked) and a .zip of each in extension/build/, for the stores.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');
const OUT = path.join(HERE, 'build');

// what the guard takes of the web app: the detector's wrapper and what it imports, and the WebAssembly
const FROM_WEB = { 'lib/detector.js': 'detector.js', 'lib/profile.js': 'profile.js', 'lib/frames.js': 'frames.js', 'pkg/unflash.js': 'pkg/unflash.js', 'pkg/unflash_bg.wasm': 'pkg/unflash_bg.wasm' };

for (const from of Object.values(FROM_WEB)) {
  if (!fs.existsSync(path.join(WEB, from))) {
    console.error(`web/${from} is missing: run ./build.sh first`);
    process.exit(1);
  }
}

const base = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
const manifests = {
  chrome: base,
  // Firefox runs background scripts (as a module) rather than a service worker, and wants an id
  firefox: {
    ...base,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: { gecko: { id: 'unflash@l1n.github.io', strict_min_version: '128.0' } },
  },
};

fs.rmSync(OUT, { recursive: true, force: true });
for (const [browser, manifest] of Object.entries(manifests)) {
  const dir = path.join(OUT, browser);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.cpSync(path.join(HERE, 'src'), dir, { recursive: true });
  fs.cpSync(path.join(HERE, 'icons'), path.join(dir, 'icons'), { recursive: true });
  for (const [to, from] of Object.entries(FROM_WEB)) fs.copyFileSync(path.join(WEB, from), path.join(dir, to));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const zip = path.join(OUT, `unflash-${browser}-${base.version}.zip`);
  try {
    execFileSync('zip', ['-qr', zip, '.'], { cwd: dir });
  } catch (e) {
    console.warn(`(no zip made for ${browser}: ${e.message.split('\n')[0]})`);
  }
  console.log(`${browser}: ${path.relative(process.cwd(), dir)}`);
}
