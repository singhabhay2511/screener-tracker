// Daily price/technical snapshot of EVERY symbol ever seen by the screener,
// whether or not it qualified that day.
//
// The screener alone only tells you about surge days. Base formation and
// "return since first appearance" both need the quiet days in between --
// that is what this collects.
//
// Like capture.mjs it runs every day and uses the market's own session date,
// so weekends and holidays need no special handling.

import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig, fetchTracking, fetchMarketDate, loadSnapshots, TRACK_DIR,
} from './screener.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dateArg = args[args.indexOf('--date') + 1];
const dateOverride = args.includes('--date') && dateArg ? dateArg : null;

const cfg = loadConfig();

let runDate = dateOverride;
if (!runDate) {
  try {
    runDate = (await fetchMarketDate(cfg)).date;
  } catch (err) {
    console.error(`[error] market-date probe failed: ${err.message}`);
    process.exit(1);
  }
}

const already = existsSync(TRACK_DIR)
  && readdirSync(TRACK_DIR).includes(`${runDate}.json`);
if (already && !force) {
  console.log(`[skipped_no_new_session] ${runDate} already tracked`);
  process.exit(0);
}

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
