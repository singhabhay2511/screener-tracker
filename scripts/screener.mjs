// Shared TradingView scanner client + small helpers.
// No dependencies: uses Node 18+ native fetch.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const SNAP_DIR = join(ROOT, 'data', 'snapshots');
export const RUNS_CSV = join(ROOT, 'data', 'runs.csv');

export function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'config', 'screener.json'), 'utf8'));
}

export function loadHolidays() {
  const p = join(ROOT, 'config', 'nse-holidays.json');
  if (!existsSync(p)) return new Set();
  return new Set(JSON.parse(readFileSync(p, 'utf8')).holidays || []);
}

/** Current date in IST as YYYY-MM-DD, regardless of where the runner lives. */
export function istDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export function istWeekday(dateStr) {
  // dateStr is already an IST calendar date; parse as UTC noon to dodge TZ edges.
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=Sun .. 6=Sat
}

/** POST the screener definition to TradingView's scanner. Returns normalised rows. */
export async function fetchScreener(cfg) {
  const body = {
    filter: cfg.filter.map(({ left, operation, right }) => ({ left, operation, right })),
    options: { lang: 'en' },
    markets: cfg.markets,
    symbols: { query: { types: [] }, tickers: [] },
    columns: cfg.columns,
    sort: cfg.sort,
    range: [0, cfg.maxRows ?? 300],
  };

  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`scanner returned HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new Error('scanner response missing "data" array');

  // If totalCount exceeds what we asked for, we are silently truncating. Fail loudly.
  if (typeof json.totalCount === 'number' && json.totalCount > body.range[1]) {
    throw new Error(
      `screener returned ${json.totalCount} rows but maxRows is ${body.range[1]} -- ` +
      `raise maxRows in config/screener.json rather than recording a truncated day`
    );
  }

  const rows = json.data.map((r) => {
    const o = {};
    cfg.columns.forEach((c, i) => { o[c] = r.d[i]; });
    return {
      ticker: r.s,                       // e.g. "NSE:XTRANET"
      symbol: o.name,
      exchange: r.s.split(':')[0],
      name: o.description ?? null,
      sector: o.sector ?? null,
      close: o.close ?? null,
      change_pct: o.change ?? null,
      volume: o.volume ?? null,
      rel_vol: o.relative_volume_10d_calc ?? null,
      mkt_cap: o.market_cap_basic ?? null,
      pe: o.price_earnings_ttm ?? null,
      eps: o.earnings_per_share_diluted_ttm ?? null,
      value_traded: o['Value.Traded'] ?? null,
      volume_change: o.volume_change ?? null,
      analyst_rating: ratingLabel(o['Recommend.All']),
    };
  });

  rows.forEach((r, i) => { r.rank = i + 1; });
  return { rows, totalCount: json.totalCount ?? rows.length };
}

/**
 * Fingerprint of a session's result: symbols + their closes.
 * On a non-trading day the screener replays the previous session verbatim,
 * so an identical fingerprint is strong evidence the market did not trade.
 */
export function fingerprint(rows) {
  const basis = rows
    .map((r) => `${r.ticker}@${r.close}@${r.volume}`)
    .sort()
    .join('|');
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/** All recorded snapshots, oldest first. */
export function loadSnapshots() {
  if (!existsSync(SNAP_DIR)) return [];
  return readdirSync(SNAP_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(SNAP_DIR, f), 'utf8')));
}

/** Sector strings arrive inconsistently cased; fold them to one canonical form. */
export function normSector(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const TRACK_DIR = join(ROOT, 'data', 'tracking');

export const TRACK_COLUMNS = [
  'name', 'close', 'change', 'volume', 'relative_volume_10d_calc',
  'SMA20', 'SMA50', 'ATR', 'High.3M', 'Low.3M', 'price_52_week_high',
  'Perf.W', 'Perf.1M', 'sector',
];

/**
 * Price/technical snapshot for an explicit ticker list, regardless of whether
 * they pass the screener today. This is what gives us the days *between*
 * appearances -- required for base detection and since-first-appearance return.
 */
export async function fetchTracking(cfg, tickers) {
  if (!tickers.length) return [];
  const out = [];
  // chunk to keep request bodies sane as the tracked universe grows
  for (let i = 0; i < tickers.length; i += 200) {
    const chunk = tickers.slice(i, i + 200);
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        symbols: { tickers: chunk, query: { types: [] } },
        columns: TRACK_COLUMNS,
      }),
    });
    if (!res.ok) throw new Error(`tracking scan returned HTTP ${res.status}`);
    const json = await res.json();
    for (const r of json.data ?? []) {
      const o = {};
      TRACK_COLUMNS.forEach((c, k) => { o[c] = r.d[k]; });
      out.push({
        ticker: r.s,
        close: o.close ?? null,
        change_pct: o.change ?? null,
        volume: o.volume ?? null,
        rel_vol: o.relative_volume_10d_calc ?? null,
        sma20: o.SMA20 ?? null,
        sma50: o.SMA50 ?? null,
        atr: o.ATR ?? null,
        high_3m: o['High.3M'] ?? null,
        low_3m: o['Low.3M'] ?? null,
        high_52w: o.price_52_week_high ?? null,
        perf_w: o['Perf.W'] ?? null,
        perf_m: o['Perf.1M'] ?? null,
        sector: normSector(o.sector),
      });
    }
  }
  return out;
}

/** All tracking snapshots, oldest first. */
export function loadTracking() {
  if (!existsSync(TRACK_DIR)) return [];
  return readdirSync(TRACK_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(TRACK_DIR, f), 'utf8')));
}

/**
 * The market's own idea of the latest trading date.
 *
 * The scanner's `time` column is the last DAILY BAR's open timestamp -- on NSE
 * that is 09:15 IST of the most recent session. So on a Saturday, a holiday, or
 * any unscheduled closure it still reports the previous trading day, which is
 * exactly what we need: the data itself says whether a new session exists.
 *
 * This is authoritative in a way a calendar never is. It needs no holiday list,
 * it survives unscheduled closures, and it correctly picks up special sessions
 * (Muhurat trading falls on days a weekday check would skip).
 *
 * Several liquid references are queried and the newest bar wins, so one
 * suspended or halted symbol cannot drag the answer backwards.
 */
const MARKET_DATE_REFS = [
  'NSE:RELIANCE', 'NSE:TCS', 'NSE:HDFCBANK', 'NSE:INFY', 'NSE:ICICIBANK', 'NSE:SBIN',
];

export async function fetchMarketDate(cfg) {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      symbols: { tickers: MARKET_DATE_REFS, query: { types: [] } },
      columns: ['name', 'time'],
    }),
  });
  if (!res.ok) throw new Error(`market-date probe returned HTTP ${res.status}`);

  const json = await res.json();
  const times = (json.data ?? []).map((r) => r.d[1]).filter((t) => typeof t === 'number');
  if (!times.length) throw new Error('market-date probe returned no usable bar timestamps');

  const latest = Math.max(...times);
  return {
    date: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(latest * 1000)),
    barOpen: latest,
    refs: times.length,
  };
}

/**
 * TradingView returns the analyst consensus as a number in [-1, 1]
 * (`Recommend.All`). These are its own display bands.
 */
export function ratingLabel(v) {
  if (v == null || Number.isNaN(v)) return null;
  if (v >= 0.5) return 'Strong buy';
  if (v >= 0.1) return 'Buy';
  if (v > -0.1) return 'Neutral';
  if (v > -0.5) return 'Sell';
  return 'Strong sell';
}
