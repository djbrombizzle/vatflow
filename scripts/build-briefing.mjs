#!/usr/bin/env node
/* Assemble briefing.html — one self-contained file with pdf.js inlined, so it
 * works from https (Add to Home Screen on the iPad) and from file:// on a PC
 * with no sibling assets.
 *
 *   node scripts/build-briefing.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// A 1x1-ish inline icon keeps the home-screen tile from 404ing offline.
const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="12" fill="#080b10"/>' +
      '<text x="32" y="42" font-family="monospace" font-size="26" font-weight="bold" ' +
      'fill="#e8a838" text-anchor="middle">WA</text></svg>'
  );

const parts = {
  CSS: src('briefing/app.css'),
  PDFJS: src('briefing/vendor/pdf.min.js'),
  PDFJS_WORKER: src('briefing/vendor/pdf.worker.min.js'),
  PARSE: src('briefing/parse.js'),
  APP: src('briefing/app.js'),
  SW: src('briefing/sw.js'),
  ICON
};

// Inlined scripts must not contain a literal </script>; both pdf.js builds are
// clean today, but check rather than trust.
for (const [name, body] of Object.entries(parts)) {
  if (name !== 'ICON' && /<\/script/i.test(body)) {
    throw new Error(`${name} contains "</script" and cannot be inlined verbatim`);
  }
}

let html = src('briefing/shell.html');
for (const [name, body] of Object.entries(parts)) {
  const token = `{{${name}}}`;
  if (!html.includes(token)) throw new Error(`shell.html is missing ${token}`);
  html = html.split(token).join(body);
}

const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
if (leftover) throw new Error(`unreplaced tokens: ${leftover.join(', ')}`);

const out = path.join(root, 'briefing.html');
fs.writeFileSync(out, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`briefing.html written — ${kb} KB`);
