# Screener Tracker

**Live dashboard → https://singhabhay2511.github.io/screener-tracker/**
**Demo with full history → https://singhabhay2511.github.io/screener-tracker/demo/**

Both are public pages: anyone with the link can view them, no GitHub account needed.
The demo carries a frozen synthetic dataset so the dashboard can be explored before
real history accumulates. It reuses the live page assets, so the two never drift apart.

Settings are per-viewer (`localStorage`), so anyone can retune every parameter without
affecting the page or any other viewer.



Snapshots the TradingView screener [**4% Scan**](https://www.tradingview.com/screener/0mdQWH3o/)
after every NSE session and tracks **which stocks keep reappearing, and on which dates**.

Runs entirely on GitHub Actions + GitHub Pages. No server, no database, no cost.

---

## How it works

```
push to main           deploys docs/ to Pages immediately
16:07 + 20:07 IST      capture.mjs   → data/snapshots/YYYY-MM-DD.json   (raw, immutable)
  (every day)
                       build-dashboard.mjs → docs/dashboard.json        (derived)
                       git commit + Pages deploy

Saturdays 11:43 IST    drift-check.mjs → opens an issue if the screener was edited
```

The daily job posts the screener definition to TradingView's public scanner endpoint
(`scanner.tradingview.com/india/scan`). No login, no browser, ~200 ms.

### Design rule: store snapshots, never aggregates

Each trading day is one immutable JSON file. Appearance counts, streaks, first/last
seen and heat scores are **recomputed from scratch** on every build. Nothing is kept
as a running counter.

This is what makes the dataset trustworthy. Change the window from 30 to 90 sessions,
backfill a missed day, or fix a bad run, and every figure stays correct. A stored
counter would be a number you could never audit or unwind.

---

## The three guards

A dataset like this is only as good as its worst day. Three things are enforced:

| Guard | Protects against |
|---|---|
| **Truncation check** | `capture.mjs` throws if `totalCount` exceeds `maxRows`. A partial day is never recorded as a complete one. |
| **Market-date gate** | The scanner replays the previous session byte-identically on any closed day — measured, not assumed. So the job reads the last daily bar's timestamp and records only when that session is new. |
| **Open-session gate** | The daily bar exists from 09:15, so a run before 15:40 IST would store intraday values as a close. It refuses unless forced. |
| **Status log** | `data/runs.csv` records `ok` / `error` / `skipped_*` separately, so "the job broke" is never mistaken for "nothing qualified today". |

**No holiday list is needed.** `config/nse-holidays.json` is now only an optional aid
for gap reporting; capture ignores it entirely.

---

## Drift detection

The daily job runs a **replica** of the screener defined in `config/screener.json`.
If you edit the screener in TradingView, that replica silently diverges and your
history quietly becomes two incompatible datasets.

So once a week, `drift-check.mjs` loads the real saved screener in Playwright,
scrolls the virtualised table to the bottom, and compares its symbol set against
the API replica. On any mismatch it opens a GitHub issue listing exactly which
symbols differ.

**When that issue appears:** open the screener, read the filter chips, and update
`config/screener.json` to match.

---

## Current screener definition

| Screener chip | `config/screener.json` |
|---|---|
| Price > 10 INR | `close > 10` |
| Chg > 4% | `change > 4` |
| Mkt cap 5B–100B INR | `market_cap_basic in_range [5e9, 1e11]` |
| NSE | `exchange = NSE` |
| Vol chg > 300% | `volume_change > 300` |
| Price × vol > 100M INR | `Value.Traded > 1e8` |

Verified: this replica returns the identical 24 symbols the saved screener displays.

---

## Dashboard

| View | What it answers |
|---|---|
| **Session** | Any session's matches, badged `NEW` / `BACK` / `4× in 10` / `streak 3`. Date is a dropdown. |
| **Leaderboard** | Who recurs most, over a selectable window, with sector rank and base status per row. |
| **Bases** | Stocks that surged then went quiet, ranked by how constructively they are consolidating. |
| **Heat grid** | Top 30 symbols × sessions. Click a filled cell to jump to that session. |
| **Sectors** | Sector strength over 30 sessions. Click a row to expand its stocks, counts and dates. |

Every symbol carries a chart icon linking straight to its TradingView chart, in a new tab.
**Export CSV** in the header downloads exactly what is on screen — the active view, with the
current filters, window and sort applied. Leaderboard rows expand inline to show their
appearance dates, and *Rank by* switches between heat and raw hit count.

Every KPI card, sector chip, badge and grid cell is a filter. Active filters show as
removable chips and apply across all views.

### Navigation

Two different interactions, deliberately kept distinct:

- **KPI cards filter in place.** Clicking *First-timers*, *Repeats* or *In hot sectors*
  narrows the table already on screen and highlights the card. It never switches tabs,
  so there is no trip back. Click again to clear.
- **Real jumps push history.** The few actions that genuinely change view — a heat-grid
  cell opening its session, "filter everything to this sector" — push a history entry,
  and a `← Back` button appears.

All state lives in the URL hash (`#v=leaderboard&f.sector=Finance`), so the browser's
own Back and Forward work, a refresh keeps you where you were, and any view you reach
can be bookmarked or shared.

### Base detection

The screener only fires on surge days, so on its own it can never tell you what
happened afterwards. `track.mjs` fixes that: every day it pulls close, SMA20,
SMA50, ATR and relative volume for **every symbol ever seen**, whether or not it
qualified. Those quiet days are what make base detection and
"% since first appearance" possible.

The base score is a weighted blend of five components, each shown in the UI so
you can see *why* something scored as it did:

| Component | Weight | Reads well when |
|---|---|---|
| Pullback depth | 30% | shallow off the surge; a runaway or a >25% break scores low |
| Range tightness | 20% | 10-session range under ~8% |
| Position vs MAs | 20% | above SMA20, partially above SMA50 |
| Volume dry-up | 15% | relative volume under ~0.7 |
| Time elapsed | 15% | 3–30 sessions since the surge |

Components that cannot be computed yet (tightness needs 5+ tracking days) are
excluded and the remaining weights renormalise, so early scores stay honest
rather than being quietly penalised.

**This is a shortlisting heuristic, not a signal.** It ranks what to look at, and
nothing more — it has no view on whether a base resolves up or down.

### On ranking

The default sort is **heat**, not lifetime count — a recency-weighted score
(15-session decay). Raw appearance totals get dominated by names in long grinding
uptrends that print 4% moves routinely. Four appearances in eight sessions is a
much stronger signal than twelve spread across a year. Sort by `Hits` if you want
the plain count.

---

## Setup

Already live. The only repo setting that must be right:

**Settings → Actions → General → Workflow permissions → Read and write permissions.**
The daily job commits its snapshot, so without this the capture runs but cannot save.

**Settings → Pages → Source: GitHub Actions.**
This one is a genuine manual step — `GITHUB_TOKEN` is not allowed to create a Pages
site, so `enablement: true` fails with "Resource not accessible by integration".

The daily commit also keeps the scheduled workflows alive — GitHub disables cron
on repos with 60 days of no activity, which this repo can never hit.

## Local use

```bash
npm run serve                      # live at :8080, demo at :8080/demo/
npm run demo:publish               # regenerate docs/demo/dashboard.json
node scripts/capture.mjs           # snapshot today
node scripts/capture.mjs --force   # ignore weekend/holiday/stale guards
node scripts/capture.mjs --date 2026-09-04
node scripts/build-dashboard.mjs   # regenerate docs/dashboard.json
```

Then open `docs/index.html` through any static server.

---

## Known limits

- **No backfill.** TradingView exposes no screener history. Tracking starts the day
  the job first runs.
- **GitHub cron drifts badly.** Scheduled runs are queued best-effort and can be
  delayed by *hours* or dropped entirely — measured at 145 and 166 minutes late on
  consecutive days, then skipped altogether. Two mitigations: the crons sit on odd
  minutes (:37) because :00 and :30 are the most contended slots, and capture runs
  **twice daily** (16:07 and 20:07 IST). The job only records a session it does not
  already have, so the second run costs nothing when the first worked and rescues
  the day when it did not.

  The delay cannot corrupt anything: snapshots are filed under the **market** date
  from the last daily bar, not the runner's calendar date, so even a run crossing
  midnight IST still lands on the right trading day.
- **Unofficial endpoint.** The scanner API is undocumented and could change without
  notice. The daily job fails loudly rather than silently if it does.
