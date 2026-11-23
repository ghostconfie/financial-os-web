// Renders public/logo.svg into the favicon and PWA icons. Run: node scripts/make-icons.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';

// playwright is not a project dependency: use the one installed on this machine
const { chromium } = createRequire(import.meta.url)('playwright');

const svg = fs.readFileSync(new URL('../public/logo.svg', import.meta.url), 'utf8');
const out = [
  ['public/favicon.png', 32], ['public/icons/icon-192.png', 192], ['public/icons/icon-512.png', 512],
  ['public/icons/maskable-512.png', 512], ['public/icons/apple-touch-icon.png', 180],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size] of out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(`../${file}`, import.meta.url).pathname, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', file, size);
}
await browser.close();
