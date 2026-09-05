// Regenerate docs/demo/index.html from docs/index.html.
//
// The demo page loads the live page's CSS and JS (../style.css, ../app.js) so
// the two can never look different -- but its own index.html was originally a
// one-off copy, and it silently drifted: an element added to the live shell
// (#exportBtn) was missing from the demo, so wiring it threw and aborted the
// script before the data fetch, leaving the page blank.
//
// Deriving it on every demo:publish makes that impossible.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './screener.mjs';

const src = join(ROOT, 'docs', 'index.html');
const dst = join(ROOT, 'docs', 'demo', 'index.html');

let html = readFileSync(src, 'utf8');

const rewrites = [
  [/href="style\.css"/g, 'href="../style.css"'],
  [/src="metrics\.js"/g, 'src="../metrics.js"'],
  [/src="app\.js"/g, 'src="../app.js"'],
  [/<title>Screener Tracker<\/title>/, '<title>Screener Tracker — Demo</title>'],
];
for (const [find, repl] of rewrites) html = html.replace(find, repl);

// Guard against a future asset that the rewrite list does not know about.
const unrewritten = [...html.matchAll(/(?:href|src)="(?!\.\.\/|https?:|#)([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => !p.startsWith('data:'));
if (unrewritten.length) {
  console.warn(`WARNING: demo page has same-directory asset refs that were not rewritten: ${unrewritten.join(', ')}`);
  console.warn('Add them to the rewrites list in scripts/build-demo-page.mjs.');
}

mkdirSync(join(ROOT, 'docs', 'demo'), { recursive: true });
writeFileSync(dst, html);
console.log(`docs/demo/index.html regenerated from docs/index.html (${html.length} bytes)`);
