// Daily capture: snapshot the screener and record it as one immutable file.
//
// Guarantees that matter for a longitudinal dataset:
//   - Idempotent: re-running for the same date overwrites that day, never double-counts.
//   - Fails loudly on truncation rather than recording a partial day.
//   - Distinguishes "job failed" from "zero stocks qualified" from "market was shut".
//
// Usage: node scripts/capture.mjs [--force] [--date YYYY-MM-DD]

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig, loadHolidays, istDate, istWeekday,
  fetchScreener, fingerprint, loadSnapshots, SNAP_DIR, RUNS_CSV,
} from './screener.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dateArg = args[args.indexOf('--date') + 1];
const runDate = args.includes('--date') && dateArg ? dateArg : istDate();

function logRun(row) {
  if (!existsSync(RUNS_CSV)) {
    appendFileSync(RUNS_CSV, 'run_date,status,row_count,fingerprint,captured_at_ist,detail\n');
  }
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  appendFileSync(RUNS_CSV, [
    row.run_date, row.status, row.row_count ?? '', row.fingerprint ?? '',
    esc(row.captured_at_ist ?? ''), esc(row.detail ?? ''),
  ].join(',') + '\n');
  console.log(`[${row.status}] ${row.run_date} rows=${row.row_count ?? '-'} ${row.detail ?? ''}`);
}

async function main() {
  mkdirSync(SNAP_DIR, { recursive: true });
  const cfg = loadConfig();

  // --- Gate 1: weekends -------------------------------------------------
  const dow = istWeekday(runDate);
  if ((dow === 0 || dow === 6) && !force) {
    logRun({ run_date: runDate, status: 'skipped_weekend', detail: 'not a weekday in IST' });
    return;
  }

  // --- Gate 2: known holidays (optimisation only) -----------------------
  if (loadHolidays().has(runDate) && !force) {
    logRun({ run_date: runDate, status: 'skipped_holiday', detail: 'listed NSE holiday' });
    return;
  }

  // --- Fetch ------------------------------------------------------------
  let result;
  try {
    result = await fetchScreener(cfg);
  } catch (err) {
    logRun({ run_date: runDate, status: 'error', detail: err.message });
    process.exitCode = 1;   // surfaces as a red run in the Actions history
    return;
  }

  const { rows, totalCount } = result;
  const fp = fingerprint(rows);

  // --- Gate 3: stale-data guard (the real holiday detector) -------------
  // On a non-trading day TradingView replays the previous session verbatim.
  // An identical fingerprint therefore means the market almost certainly
  // did not trade -- so we must NOT record it as a distinct session, or
  // every stock in it gets a phantom appearance.
  const prior = loadSnapshots().filter((s) => s.run_date !== runDate);
  const last = prior[prior.length - 1];
  if (last && last.fingerprint === fp && !force) {
    logRun({
      run_date: runDate, status: 'skipped_stale', row_count: rows.length, fingerprint: fp,
      detail: `identical to ${last.run_date} -- market likely closed (override with --force)`,
    });
    return;
  }

  // --- Record -----------------------------------------------------------
  const capturedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hour12: false,
  }).format(new Date());

  const snapshot = {
    run_date: runDate,
    captured_at_ist: capturedAt,
    screener: { name: cfg.name, sourceUrl: cfg.sourceUrl },
    filter_hash: fingerprint(cfg.filter.map((f) => ({ ticker: f.left, close: f.operation, volume: JSON.stringify(f.right) }))),
    total_count: totalCount,
    row_count: rows.length,
    fingerprint: fp,
    rows,
  };

  writeFileSync(join(SNAP_DIR, `${runDate}.json`), JSON.stringify(snapshot, null, 2) + '\n');
  logRun({
    run_date: runDate, status: 'ok', row_count: rows.length,
    fingerprint: fp, captured_at_ist: capturedAt,
    detail: rows.length === 0 ? 'no stocks matched the screener today' : '',
  });
}

main();
