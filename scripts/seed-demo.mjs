// Generate plausible history so the dashboard can be reviewed before real
// data has accumulated. Every file it writes carries "demo": true, and
// --clear deletes ONLY those files -- a real capture can never be removed
// by this script.
//
//   node scripts/seed-demo.mjs            seed ~40 sessions
//   node scripts/seed-demo.mjs --sessions 60
//   node scripts/seed-demo.mjs --clear    remove demo data only

import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SNAP_DIR, TRACK_DIR, loadConfig, fetchTracking } from './screener.mjs';

const args = process.argv.slice(2);
const clear = args.includes('--clear');
const nSessions = Number(args[args.indexOf('--sessions') + 1]) || 40;

const listDir = (dir) => (!existsSync(dir) ? [] : readdirSync(dir)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => ({ path: join(dir, f), json: JSON.parse(readFileSync(join(dir, f), 'utf8')) })));

// ---- clear -------------------------------------------------------------
if (clear) {
  const snaps = listDir(SNAP_DIR), track = listDir(TRACK_DIR);
  const ds = snaps.filter((s) => s.json.demo === true);
  const dt = track.filter((s) => s.json.demo === true);
  [...ds, ...dt].forEach((s) => unlinkSync(s.path));
  console.log(`removed ${ds.length} demo session(s) + ${dt.length} demo tracking day(s); `
    + `kept ${snaps.length - ds.length} real capture(s), ${track.length - dt.length} real tracking day(s)`);
  process.exit(0);
}

// ---- seed --------------------------------------------------------------
const real = listDir(SNAP_DIR).filter((s) => s.json.demo !== true);
if (!real.length) {
  console.error('No real capture to model demo data on. Run: node scripts/capture.mjs');
  process.exit(1);
}
const earliestReal = real.map((s) => s.json.run_date).sort()[0];
const template = real[0].json;

const extras = [
  ['TITAGARH', 'Titagarh Rail Systems Limited', 'Producer Manufacturing'],
  ['HBLENGINE', 'HBL Engineering Limited', 'Electronic Technology'],
  ['JYOTICNC', 'Jyoti CNC Automation Limited', 'Producer Manufacturing'],
  ['AZAD', 'Azad Engineering Limited', 'Producer Manufacturing'],
  ['ZENTEC', 'Zen Technologies Limited', 'Electronic Technology'],
  ['DATAPATTNS', 'Data Patterns (India) Limited', 'Electronic Technology'],
  ['APARINDS', 'Apar Industries Limited', 'Producer Manufacturing'],
  ['SHAKTIPUMP', 'Shakti Pumps (India) Limited', 'Producer Manufacturing'],
  ['TARIL', 'Transformers And Rectifiers Limited', 'Producer Manufacturing'],
  ['ELECON', 'Elecon Engineering Company Limited', 'Producer Manufacturing'],
  ['KIRLOSENG', 'Kirloskar Oil Engines Limited', 'Producer Manufacturing'],
  ['POWERINDIA', 'Hitachi Energy India Limited', 'Electronic Technology'],
].map(([symbol, name, sector], i) => ({
  ticker: `NSE:${symbol}`, symbol, exchange: 'NSE', name, sector,
  close: 120 + i * 43, change_pct: 0, volume: 0, rel_vol: 0,
  mkt_cap: 2e10 + i * 4e9, pe: 20 + i, eps: 8 + i, value_traded: 0, volume_change: 0,
}));

const pool = [...template.rows, ...extras];

let seed = 20260904;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const weight = pool.map(() => Math.pow(rnd(), 1.7));
const regime = pool.map(() => {
  const r = rnd();
  return r < 0.32 ? 'base' : r < 0.52 ? 'extended' : r < 0.72 ? 'broken' : 'chop';
});

const dates = [];
const cursor = new Date(`${earliestReal}T12:00:00Z`);
while (dates.length < nSessions) {
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  const dow = cursor.getUTCDay();
  if (dow !== 0 && dow !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
}

// --- Pass 1: relative price paths ---------------------------------------
// Surges compound, so the path needs mean reversion or it runs away to
// absurd multiples over 40 sessions. Each day pulls partway back toward a
// slow-moving anchor, which is what actually keeps the series realistic.
const relPath = pool.map(() => []);
const appearsAt = pool.map(() => []);
const chgAt = pool.map(() => []);
const relVolAt = pool.map(() => []);

const p = pool.map(() => 1);
const anchor = pool.map(() => 1);

for (let di = 0; di < dates.length; di++) {
  pool.forEach((r, i) => {
    const appears = rnd() < weight[i] * 0.45;
    let chg;
    if (appears) {
      chg = 4 + rnd() * 15;
    } else {
      const drift = regime[i] === 'base' ? 0.0004 : regime[i] === 'extended' ? 0.004
        : regime[i] === 'broken' ? -0.006 : 0;
      const noise = regime[i] === 'base' ? 0.007 : 0.02;
      const revert = -0.18 * Math.log(p[i] / anchor[i]);
      chg = (drift + revert + (rnd() - 0.5) * 2 * noise) * 100;
    }
    p[i] = Math.max(0.05, p[i] * (1 + chg / 100));
    anchor[i] = anchor[i] * 0.92 + p[i] * 0.08;

    relPath[i].push(p[i]);
    appearsAt[i].push(appears);
    chgAt[i].push(+chg.toFixed(2));
    relVolAt[i].push(appears ? +(2 + rnd() * 18).toFixed(2)
      : regime[i] === 'base' ? +(0.35 + rnd() * 0.5).toFixed(2)
        : +(0.8 + rnd() * 1.8).toFixed(2));
  });
}

// --- Pass 2: anchor each path to the symbol's real current price ---------
// Without this, a fabricated demo close gets compared against the real price
// that track.mjs fetches, and "% since first appearance" becomes nonsense.
let realClose = new Map();
try {
  const cfg = loadConfig();
  const live = await fetchTracking(cfg, pool.map((r) => r.ticker));
  realClose = new Map(live.filter((r) => r.close != null).map((r) => [r.ticker, r.close]));
  console.log(`anchored ${realClose.size}/${pool.length} demo paths to live prices`);
} catch (err) {
  console.warn(`could not fetch live prices (${err.message}); falling back to snapshot closes`);
}
const scale = pool.map((r, i) => (realClose.get(r.ticker) ?? r.close) / relPath[i].at(-1));

// --- Write ---------------------------------------------------------------
mkdirSync(SNAP_DIR, { recursive: true });
mkdirSync(TRACK_DIR, { recursive: true });

const closesSoFar = pool.map(() => []);

dates.forEach((date, di) => {
  const snapRows = [];
  const trackRows = [];

  pool.forEach((r, i) => {
    const close = +(relPath[i][di] * scale[i]).toFixed(2);
    closesSoFar[i].push(close);
    const hist = closesSoFar[i];
    const ma = (n) => {
      const w = hist.slice(-n);
      return w.length < Math.min(n, 5) ? null : +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(2);
    };
    const win = hist.slice(-60);

    trackRows.push({
      ticker: r.ticker, close, change_pct: chgAt[i][di],
      volume: Math.round(2e5 + rnd() * 8e6), rel_vol: relVolAt[i][di],
      sma20: ma(20), sma50: ma(50), atr: +(close * 0.03).toFixed(2),
      high_3m: +Math.max(...win).toFixed(2), low_3m: +Math.min(...win).toFixed(2),
      high_52w: +(Math.max(...win) * 1.05).toFixed(2),
      perf_w: +((rnd() - 0.4) * 8).toFixed(2), perf_m: +((rnd() - 0.35) * 20).toFixed(2),
      sector: r.sector,
    });

    if (appearsAt[i][di]) {
      snapRows.push({
        ...r, close, change_pct: chgAt[i][di], rel_vol: relVolAt[i][di],
        volume: Math.round(3e5 + rnd() * 2.4e7),
        volume_change: Math.round(300 + rnd() * 900), rank: 0,
      });
    }
  });

  snapRows.sort((a, b) => b.change_pct - a.change_pct).forEach((r, i) => { r.rank = i + 1; });

  writeFileSync(join(SNAP_DIR, `${date}.json`), JSON.stringify({
    demo: true, run_date: date, captured_at_ist: `${date} 17:00:00`,
    screener: template.screener, total_count: snapRows.length,
    row_count: snapRows.length, fingerprint: `demo-${date}`, rows: snapRows,
  }, null, 2) + '\n');

  writeFileSync(join(TRACK_DIR, `${date}.json`), JSON.stringify({
    demo: true, run_date: date, tracked: trackRows.length,
    requested: trackRows.length, rows: trackRows,
  }, null, 2) + '\n');
});

console.log(`seeded ${dates.length} demo sessions + tracking days (${dates[0]} … ${dates.at(-1)}),`
  + ` all before the real ${earliestReal}`);
console.log('remove with: node scripts/seed-demo.mjs --clear');
