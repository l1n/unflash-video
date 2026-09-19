// Find Playwright whether it is installed locally, globally, or in this
// container's Node prefix.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

export async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  try {
    candidates.push(require.resolve('playwright'));
  } catch (e) {
    /* not local */
  }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(`${root}/playwright/index.mjs`);
  } catch (e) {
    /* no npm */
  }
  candidates.push('/opt/node22/lib/node_modules/playwright/index.mjs', '/usr/lib/node_modules/playwright/index.mjs', '/usr/local/lib/node_modules/playwright/index.mjs');
  for (const c of candidates) {
    if (fs.existsSync(c)) return import(c);
  }
  throw new Error('playwright not found; npm install -g playwright && npx playwright install chromium');
}
