// Run web/bench.html in headless Chromium and print the numbers.
import { loadPlaywright } from './playwright.mjs';
import path from 'node:path';
import { serve } from './server.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { chromium } = await loadPlaywright();
const { srv, port } = await serve(path.join(ROOT, 'web'));
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[browser error]', m.text()); });
const n = process.argv[2] || '120';
const src = process.argv[3] || '1920x1080';
const batch = process.argv[4]; // frames per GPU batch (default 16)
await page.goto(`http://127.0.0.1:${port}/bench.html${batch ? `?batch=${batch}` : ''}`);
await page.waitForFunction(() => typeof window.runBench === 'function', null, { timeout: 60000 });
await page.fill('#n', n);
await page.fill('#src', src);
const r = await page.evaluate(() => window.runBench());
console.log(await page.textContent('#out'));
await browser.close();
srv.close();
