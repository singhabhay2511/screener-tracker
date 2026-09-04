// Daily price/technical snapshot of EVERY symbol ever seen by the screener,
// whether or not it qualified today.
//
// The screener alone only tells you about surge days. Base formation and
// "return since first appearance" both need the quiet days in between --
// that is what this collects.
//
// Runs straight after capture.mjs.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig, istDate, istWeekday, loadHolidays,
  fetchTracking, loadSnapshots, TRACK_DIR,
} from './screener.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dateArg = args[args.indexOf('--date') + 1];
const runDate = args.includes('--date') && dateArg ? dateArg : istDate();

const dow = istWeekday(runDate);
if ((dow === 0 || dow === 6) && !force) {
  console.log(`[skipped_weekend] ${runDate}`);
  process.exit(0);
}
if (loadHolidays().has(runDate) && !force) {
  console.log(`[skipped_holiday] ${runDate}`);
  process.exit(0);
}

const cfg = loadConfig();
const tickers = [...new Set(loadSnapshots().flatMap((s) => s.rows.map((r) => r.ticker)))];

if (!tickers.length) {
  console.log('[skipped] nothing tracked yet — run capture.mjs first');
  process.exit(0);
}

let rows;
try {
  rows = await fetchTracking(cfg, tickers);
} catch (err) {
  console.error(`[error] ${runDate}: ${err.message}`);
  process.exit(1);
}

mkdirSync(TRACK_DIR, { recursive: true });
writeFileSync(join(TRACK_DIR, `${runDate}.json`), JSON.stringify({
  run_date: runDate,
  tracked: rows.length,
  requested: tickers.length,
  rows,
}, null, 2) + '\n');

console.log(`[ok] ${runDate} tracked ${rows.length}/${tickers.length} symbols`);
