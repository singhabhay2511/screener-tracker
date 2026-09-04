// Ship the RAW material for the dashboard. Every tunable metric -- heat,
// counts, sector tiers, base scores, focus reasons -- is computed in the
// browser from docs/metrics.js so the parameters can be changed live.
//
// This file's only jobs: pivot snapshots into per-symbol history, attach the
// trailing price series each base calculation needs, and work out where the
// recording has gaps.

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSnapshots, loadTracking, loadHolidays, normSector, ROOT, RUNS_CSV } from './screener.mjs';

const CLOSE_HISTORY = 60;      // trailing closes shipped per symbol, for tightness

const snapshots = loadSnapshots();
const tracking = loadTracking();
const sessions = snapshots.map((s) => s.run_date);

// --- Latest technicals + trailing closes per ticker ----------------------
const latestTrack = new Map();
const closeSeries = new Map();
for (const t of tracking) {
  for (const r of t.rows) {
    latestTrack.set(r.ticker, r);
    if (!closeSeries.has(r.ticker)) closeSeries.set(r.ticker, []);
    if (r.close != null) closeSeries.get(r.ticker).push(r.close);
  }
}

// --- Pivot into per-symbol appearance history ---------------------------
const bySymbol = new Map();
for (const snap of snapshots) {
  for (const r of snap.rows) {
    if (!bySymbol.has(r.ticker)) {
      bySymbol.set(r.ticker, { ticker: r.ticker, symbol: r.symbol, name: r.name, sector: null, hits: [] });
    }
    const e = bySymbol.get(r.ticker);
    e.name = r.name ?? e.name;
    e.sector = normSector(r.sector) ?? e.sector;
    e.hits.push({
      date: snap.run_date, rank: r.rank, close: r.close,
      change_pct: r.change_pct, rel_vol: r.rel_vol,
      volume: r.volume, mkt_cap: r.mkt_cap,
    });
  }
}

const symbols = [...bySymbol.values()].map((e) => {
  const t = latestTrack.get(e.ticker) ?? null;
  return {
    ticker: e.ticker, symbol: e.symbol, name: e.name, sector: e.sector,
    hits: e.hits,
    track: t && {
      close: t.close, rel_vol: t.rel_vol, sma20: t.sma20, sma50: t.sma50,
      perf_w: t.perf_w, perf_m: t.perf_m,
    },
    closes: (closeSeries.get(e.ticker) ?? []).slice(-CLOSE_HISTORY),
  };
});

// ---------------------------------------------------------------------------
// Recording gaps.
//
// A streak counts consecutive *recorded* sessions. If a capture failed, that
// day is absent from `sessions` and two appearances either side of it look
// consecutive. So work out which weekdays between the first and last session
// have no snapshot, and whether runs.csv explains them.
// ---------------------------------------------------------------------------
function runStatuses() {
  if (!existsSync(RUNS_CSV)) return new Map();
  const out = new Map();
  const lines = readFileSync(RUNS_CSV, 'utf8').trim().split('\n').slice(1);
  for (const line of lines) {
    const [date, status] = line.split(',');
    if (date) out.set(date, status);          // last entry for a date wins
  }
  return out;
}

function findGaps() {
  if (sessions.length < 2) return [];
  const recorded = new Set(sessions);
  const statuses = runStatuses();
  const holidays = loadHolidays();
  const benign = new Set(['skipped_holiday', 'skipped_stale', 'skipped_weekend']);

  const gaps = [];
  const cur = new Date(`${sessions[0]}T12:00:00Z`);
  const end = new Date(`${sessions.at(-1)}T12:00:00Z`);

  while (cur < end) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const d = cur.toISOString().slice(0, 10);
    const dow = cur.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (recorded.has(d)) continue;
    if (holidays.has(d)) continue;

    const status = statuses.get(d);
    if (status && benign.has(status)) continue;   // explained, not a data loss

    gaps.push({ date: d, status: status ?? 'never_ran' });
  }
  return gaps;
}

const gaps = findGaps();

const out = {
  generated_at: new Date().toISOString(),
  demo_sessions: snapshots.filter((s) => s.demo === true).length,
  real_sessions: snapshots.filter((s) => s.demo !== true).length,
  tracking_sessions: tracking.length,
  screener: snapshots.at(-1)?.screener ?? null,
  sessions,
  session_count: sessions.length,
  latest_session: sessions.at(-1) ?? null,
  gaps,
  symbols,
};

writeFileSync(join(ROOT, 'docs', 'dashboard.json'), JSON.stringify(out));
console.log(
  `dashboard.json: ${sessions.length} sessions, ${symbols.length} symbols, `
  + `${tracking.length} tracking days, ${gaps.length} recording gap(s)`
);
