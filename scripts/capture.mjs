// Daily capture: snapshot the screener and record it as one immutable file.
//
// The job runs EVERY day. It does not consult a calendar, a weekday check or a
// holiday list -- it asks the market data what the latest trading session is
// and records only when that session is new. See fetchMarketDate() for why
// that is strictly better than a calendar.
//
// Guarantees that matter for a longitudinal dataset:
//   - Idempotent: re-running for the same session overwrites, never doubles.
//   - Fails loudly on truncation rather than recording a partial day.
//   - Distinguishes "job failed" from "zero stocks qualified" from "no new session".
//
// Usage: node scripts/capture.mjs [--force] [--date YYYY-MM-DD]

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig, istDate, fetchScreener, fetchMarketDate,
  fingerprint, loadSnapshots, SNAP_DIR, RUNS_CSV,
} from './screener.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dateArg = args[args.indexOf('--date') + 1];
const dateOverride = args.includes('--date') && dateArg ? dateArg : null;

/** Minutes past midnight, IST. */
function istMinutes() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = +p.find((x) => x.type === 'hour').value;
  const m = +p.find((x) => x.type === 'minute').value;
  return h * 60 + m;
}
const NSE_CLOSE = 15 * 60 + 30;        // 15:30 IST
const SETTLE = 10;                     // minutes of grace after the bell

// `run_date` is the market session; `ran_on` is the calendar day the job
// executed. They differ on every weekend and holiday, and the gap detector
// needs `ran_on` -- otherwise a holiday (whose run logs under the previous
// session) looks like a day the job never ran.
const RUNS_HEADER = 'run_date,ran_on,status,row_count,fingerprint,captured_at_ist,detail\n';

function logRun(row) {
  if (!existsSync(RUNS_CSV)) appendFileSync(RUNS_CSV, RUNS_HEADER);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  appendFileSync(RUNS_CSV, [
    row.run_date, row.ran_on ?? istDate(), row.status, row.row_count ?? '',
    row.fingerprint ?? '', esc(row.captured_at_ist ?? ''), esc(row.detail ?? ''),
  ].join(',') + '\n');
  console.log(`[${row.status}] ${row.run_date} rows=${row.row_count ?? '-'} ${row.detail ?? ''}`);
}

async function main() {
  mkdirSync(SNAP_DIR, { recursive: true });
  const cfg = loadConfig();
  const today = istDate();

  // --- What does the market itself say the latest session is? -----------
  let marketDate, barOpen;
  if (dateOverride) {
    marketDate = dateOverride;
  } else {
    try {
      const md = await fetchMarketDate(cfg);
      marketDate = md.date;
      barOpen = md.barOpen;
    } catch (err) {
      logRun({ run_date: today, status: 'error', detail: `market-date probe failed: ${err.message}` });
      process.exitCode = 1;
      return;
    }
  }

  // --- Gate 1: is this session already recorded? ------------------------
  // Covers weekends, every holiday, unscheduled closures and same-day re-runs,
  // without knowing anything about the calendar.
  const existing = loadSnapshots();
  const already = existing.some((s) => s.run_date === marketDate);
  if (already && !force) {
    logRun({
      run_date: marketDate, status: 'skipped_no_new_session',
      detail: `latest NSE session is still ${marketDate}, already recorded (today is ${today})`,
    });
    return;
  }

  // --- Gate 2: don't capture a session that is still trading ------------
  // The daily bar exists from 09:15, so a mid-session run would record
  // intraday values as if they were the close.
  if (!dateOverride && marketDate === today && istMinutes() < NSE_CLOSE + SETTLE && !force) {
    logRun({
      run_date: marketDate, status: 'skipped_session_open',
      detail: `market still open (before 15:40 IST); rerun after the close or use --force`,
    });
    return;
  }

  // --- Fetch ------------------------------------------------------------
  let result;
  try {
    result = await fetchScreener(cfg);
  } catch (err) {
    logRun({ run_date: marketDate, status: 'error', detail: err.message });
    process.exitCode = 1;
    return;
  }

  const { rows, totalCount } = result;
  const fp = fingerprint(rows);

  // Cross-check: the market date says this is a new session, so the rows
  // should differ from the previous one. If they are identical, something is
  // off -- record it, but flag it rather than failing.
  const prior = existing.filter((s) => s.run_date !== marketDate);
  const last = prior[prior.length - 1];
  const suspectStale = !!last && last.fingerprint === fp;

  const capturedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hour12: false,
  }).format(new Date());

  writeFileSync(join(SNAP_DIR, `${marketDate}.json`), JSON.stringify({
    run_date: marketDate,
    captured_at_ist: capturedAt,
    captured_on: today,               // calendar day the job ran, for auditing
    bar_open: barOpen ?? null,
    screener: { name: cfg.name, sourceUrl: cfg.sourceUrl },
    total_count: totalCount,
    row_count: rows.length,
    fingerprint: fp,
    suspect_stale: suspectStale,
    rows,
  }, null, 2) + '\n');

  logRun({
    run_date: marketDate, status: 'ok', row_count: rows.length,
    fingerprint: fp, captured_at_ist: capturedAt,
    detail: [
      rows.length === 0 ? 'no stocks matched the screener' : '',
      suspectStale ? `WARNING: identical rows to ${last.run_date} despite a new session date` : '',
      today !== marketDate ? `captured on ${today}` : '',
    ].filter(Boolean).join('; '),
  });
}

main();
