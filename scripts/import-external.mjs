// One-off importer for sessions captured by another tool running the same
// screener, used to backfill history from before this project started.
//
// Imported snapshots are marked `imported: true` with their provenance, so an
// imported session can never be mistaken for one we captured ourselves. Their
// values are display strings ("12.45 M", "+20.00%"), so they come in at lower
// precision than a native capture -- dates, symbols and sectors are exact,
// prices and percentages land at 2dp, volumes at about 3 significant figures.
//
//   node scripts/import-external.mjs <export.json> [--dry-run]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, fetchTracking, fingerprint, normSector, SNAP_DIR } from './screener.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
if (!file) {
  console.error('usage: node scripts/import-external.mjs <export.json> [--dry-run]');
  process.exit(1);
}

// ---- parsers for their display strings ---------------------------------
const UNITS = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, L: 1e5, CR: 1e7 };

function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/[,\s]/g, '').replace('−', '-');   // note: U+2212
  const m = /^([+-]?\d*\.?\d+)([KMBTL]|CR)?/i.exec(t);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (Number.isNaN(v)) return null;
  return m[2] ? v * UNITS[m[2].toUpperCase()] : v;
}

/**
 * Their scraper sometimes captures TradingView's single-letter logo glyph as
 * the symbol. When it does, the real ticker survives as the leading all-caps
 * token of the name ("TEMBO Tembo Global Industries Ltd."). Genuinely short
 * tickers (DCW, PVP, RML) have clean names, so this cannot misfire on them.
 */
function repair(symbol, name) {
  const m = /^([A-Z0-9&_-]{2,})\s+(.+)$/.exec(String(name || ''));
  if (m && m[1] !== symbol && m[1].length > symbol.length) {
    return { symbol: m[1], name: m[2], repaired: true };
  }
  return { symbol, name, repaired: false };
}

// ---- read + transform ---------------------------------------------------
const src = JSON.parse(readFileSync(file, 'utf8'));
const cfg = loadConfig();

const byDate = new Map();
const repairs = [];

for (const h of src.allHits ?? []) {
  const { symbol, name, repaired } = repair(h.symbol, h.name);
  if (repaired) repairs.push({ date: h.date, was: h.symbol, now: symbol });

  if (!byDate.has(h.date)) byDate.set(h.date, []);
  byDate.get(h.date).push({
    ticker: `NSE:${symbol}`,
    symbol,
    exchange: 'NSE',
    name,
    sector: normSector(h.sector),
    close: num(h.price),
    change_pct: num(h.changePercent),
    volume: num(h.vol),
    rel_vol: num(h.relativeVolume),
    mkt_cap: num(h.marketCap),
    pe: num(h.pe),
    eps: num(h.epsDilutedTtm),
    analyst_rating: h.analystRating ?? null,
    value_traded: null,        // not captured by the source
    volume_change: null,       // not captured by the source
    rank: 0,
  });
}

// ---- verify the repaired tickers actually exist on NSE ------------------
const repairedTickers = [...new Set(repairs.map((r) => `NSE:${r.now}`))];
let verified = new Set();
if (repairedTickers.length) {
  try {
    const live = await fetchTracking(cfg, repairedTickers);
    verified = new Set(live.filter((r) => r.close != null).map((r) => r.ticker));
  } catch (err) {
    console.warn(`could not verify repaired tickers (${err.message})`);
  }
}

console.log(`repaired ${repairs.length} corrupted symbol(s):`);
for (const r of repairs) {
  const ok = verified.has(`NSE:${r.now}`) ? 'verified on NSE' : 'UNVERIFIED';
  console.log(`  ${r.date}  ${JSON.stringify(r.was)} -> ${r.now}   (${ok})`);
}

// ---- write one snapshot per date ---------------------------------------
let written = 0, skipped = 0;
for (const [date, rows] of [...byDate.entries()].sort()) {
  const path = join(SNAP_DIR, `${date}.json`);
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    console.log(`  ${date}  skipped — already have ${existing.imported ? 'an imported' : 'a native'} snapshot (${existing.row_count} rows)`);
    skipped++;
    continue;
  }

  rows.sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0)).forEach((r, i) => { r.rank = i + 1; });

  const snapshot = {
    imported: true,
    source: {
      tool: src.source?.name ?? 'external',
      url: src.source?.url ?? null,
      export: file,
      captured_at: rows.length ? (src.allHits.find((h) => h.date === date)?.capturedAtLocal ?? null) : null,
      note: 'Display-string precision: prices/percentages 2dp, volumes ~3 s.f. Value traded and volume change unavailable.',
    },
    run_date: date,
    captured_at_ist: src.allHits.find((h) => h.date === date)?.capturedAtLocal ?? null,
    screener: { name: cfg.name, sourceUrl: cfg.sourceUrl },
    total_count: rows.length,
    row_count: rows.length,
    fingerprint: fingerprint(rows),
    rows,
  };

  if (dryRun) {
    console.log(`  ${date}  would write ${rows.length} rows (dry run)`);
  } else {
    writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`  ${date}  wrote ${rows.length} rows`);
  }
  written++;
}

console.log(`\n${dryRun ? 'would import' : 'imported'} ${written} session(s), skipped ${skipped}`);
