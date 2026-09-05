# Metric reference

Every number the dashboard shows, what it actually computes, and where to change it.
This is the canonical description — if it disagrees with the code, the code is right
and this file needs updating.

**Every parameter below is editable in the dashboard itself.** Metrics are computed in the
browser by [`docs/metrics.js`](docs/metrics.js) from the raw snapshots that
[`scripts/build-dashboard.mjs`](scripts/build-dashboard.mjs) ships, so changing a number
recomputes all history instantly — no rebuild, no redeploy. Settings persist in
`localStorage` and each panel has its own **Reset to defaults**.

Three things keep a bad value from stranding you: inputs **clamp** to their declared
range, every settings panel renders **before** any empty-state check so it survives a
view with no rows, and a **Reset all to defaults** button appears in the header
whenever settings differ from stock — outside every view, so it is always reachable.

| Panel | Lives on | Controls |
|---|---|---|
| Focus rules | Focus | gates, clustering, staleness |
| Re-emergence bands | Session | BACK badge bands |
| Heat weighting | Leaderboard | heat decay |
| Base scoring parameters | Bases | weights + every band |
| Sector strength parameters | Sectors | window, hot/warm tiers |

---

## The unit: a "session"

Everything is measured in **recorded trading sessions**, never calendar days.

The job runs **every day** and asks the market data which session is latest. The
scanner's `time` column is the last daily bar's open — 09:15 IST on NSE — so on any
closed day it still reports the previous trading date. A snapshot is written only
when that date is new, and it is filed under the **market** date rather than the
calendar date the job happened to run on.

This was chosen after measuring what the scanner actually does on a closed day: it
replays the previous session **byte-identically** — same symbols, same closes, same
volumes — rather than returning nothing. So a blank-result check would never fire,
while a calendar check would need a holiday list *and* would miss special sessions
such as Muhurat trading, which fall on days a weekday test skips.

**Gaps are now detected.** The build cross-references `data/runs.csv` and the holiday
list against the calendar. Any weekday between the first and last session with no
snapshot — and no benign explanation — is recorded as a gap. The Session view shows a
banner listing them, and any streak spanning one is marked `streak n ⚠` with the
caveat in its tooltip. Days explained as `skipped_holiday`, `skipped_stale` or
`skipped_weekend` are not gaps.

---

## Session provenance

Snapshots carry their origin, and the header shows a count of any that were not
captured by this project.

| Kind | Meaning |
|---|---|
| native | Captured by `capture.mjs` from the scanner API, full float precision. |
| `imported: true` | Backfilled from another tool running the same screener. |
| `demo: true` | Synthetic, only ever on the /demo/ page. |

**Imported sessions are lower precision.** The source recorded display strings
("12.45 M", "+20.00%"), so prices and percentages land at 2dp and volumes at about
3 significant figures. Dates, symbols and sectors are exact. `Value.Traded` and
`volume_change` were not captured at all and are null.

Import with `node scripts/import-external.mjs <export.json>`. It refuses to overwrite
an existing snapshot, so a native capture always wins over an imported one.

---

## Recurrence metrics

| Metric | Exactly what it computes | Tune |
|---|---|---|
| **Hits (window)** | Number of appearances within the last *N recorded sessions*. Windows are 10 / 30 / 90 / all. | `windows` |
| **Heat** | `Σ exp(−age / decay)`, decay defaults to 15 over every appearance, where `age` = sessions between that appearance and the latest session. Today's appearance contributes 1.0, one 15 sessions ago 0.37, one 45 ago 0.05. | **Heat weighting** panel, Leaderboard |
| **Streak** | Consecutive sessions appeared. Shown only if the run reaches the latest session, otherwise 0. | — |
| **Best streak** | Longest such run ever, anywhere in history. | — |
| **Sessions ago** | Sessions between the last appearance and the latest session. `0` = appeared today. | — |

**Turning heat off.** The Leaderboard has a *Rank by* control: **Heat** (recency-weighted)
or **Hits** (raw count, which also hides the Heat column). Setting a very large decay is
*not* equivalent — heat only approaches a flat count asymptotically. At 41 sessions and
decay 300 the oldest hit still counts 0.875 against 1.00 for today; matching a true count
within 1% needs decay above 100x your history length.

**Why heat is the default sort.** A raw lifetime count rewards names that print 4%
moves routinely for months. Heat rewards *clustering* — four appearances in eight
sessions outranks twelve spread across a year. The 15-session half-life is the single
most arbitrary constant in the project: lower it to react faster and forget sooner,
raise it to value long-run persistence.

### Badges

| Badge | Rule |
|---|---|
| `NEW` | Exactly one appearance ever, and it's the latest session. |
| `BACK n–m` | Appeared in the latest session after an absence, **banded** by how long it was gone: 5–10, 10–20, or 20+ sessions. Bands are configurable; below the first band it is not treated as a re-emergence. |
| `n× in 10` | Appearances in the last 10 sessions, shown when > 1 and not `NEW`. |
| `streak n` | Shown when the current streak > 1. |

---

## Return metrics

These exist only because `track.mjs` records prices on the quiet days too.

| Metric | Computation |
|---|---|
| **Since 1st** | `current close / close on first appearance − 1` |
| **Since last** | `current close / close on most recent appearance − 1` |
| **From surge** | `current close / highest close across all its appearances − 1` |

> **Limitation.** All three use *closing* prices. The scanner columns we pull don't
> include the intraday high of the surge day, so "from surge" measures the pullback
> from the highest **close**, not from the actual high. Real drawdown off the spike is
> therefore somewhat deeper than the number shown.

---

## Sector strength

1. Sum appearances **per sector over a configurable window** (default 30 sessions).
2. Rank sectors by that count, descending.
3. Assign a tier: **hot** = top N ranks (default 3), **warm** = up to the top N% (default 40),
   **cool** = everything else. All three are set in the **Sector strength parameters** panel.

With 12 sectors present that means ranks 1–3 hot, 4–5 warm, 6–12 cool.

Sector strings are normalised to Title Case on ingest (`normSector`), which is what
stopped "Producer Manufacturing" and "Producer manufacturing" counting as two sectors.

**Both knobs are arbitrary.** The 30-session window and the top-3 / 40% split were
chosen to look reasonable, not derived from anything — which is exactly why they are
now editable on the Sectors screen. The tier boundaries also shift
as the number of distinct sectors grows.

---

## Base analysis

Scored only for symbols with tracking data. Five components, each 0–1, combined by a
weighted average. Any component that can't be computed is dropped and the remaining
weights renormalise — so an early score isn't quietly penalised for missing history.

| Component | Weight | Scoring |
|---|---|---|
| **Pullback depth** | 30% | `> +20%` → 0.15 (ran away) · `−2%…+20%` → 1.0 · `−12%…−2%` → 0.9 · `−25%…−12%` → 0.45 · `< −25%` → 0.05 |
| **Range tightness** | 20% | 10-session close range ÷ mean. `≤8%` → 1.0 · `≤15%` → 0.7 · `≤25%` → 0.35 · else 0.1. **Needs ≥5 tracking days**, else excluded. |
| **Position vs MAs** | 20% | above SMA20 → 1.0 · else above SMA50 → 0.55 · else 0.1 · both null → excluded |
| **Volume dry-up** | 15% | relative volume `≤0.7` → 1.0 · `≤1.2` → 0.75 · `≤2` → 0.35 · else 0.1 |
| **Time elapsed** | 15% | `<3` sessions → 0.15 · `3–30` → 1.0 · `31–60` → decays 1.0→0.3 · `>60` → 0.15 |

### Reading "pullback depth"

It asks one question: **where is the price now, compared with the highest close on any
day this stock appeared in the screener?** That surge close is the reference point.

| Where price sits | What it means |
|---|---|
| above +20% | It kept running. There is no base — it is *Extended*. |
| −2% to +20% | Holding the entire move. Scores highest. |
| −12% to −2% | Healthy digestion — a shallow pullback while it consolidates. The classic base. |
| −25% to −12% | Deep but alive. Scores less than half. |
| below −25% | Gave the move back. Treated as failed, labelled *Broken*, excluded from Focus. |

The same two outer bands double as the *Extended* and *Broken* labels, so moving them
moves both. The dashboard shows this ladder inline on the Bases screen.

### Status label

Checked **in this order** — the first two override the score entirely:

1. `sessions ago < 3` → **Too soon**
2. `from surge > +20%` → **Extended**
3. `from surge < −25%` → **Broken**
4. `score ≥ 70` → **Base building**
5. `score ≥ 45` → **Watch**
6. else → **Weak**

This ordering is why a stock can show "Extended" with a decent numeric score: the
structural verdict wins.

**What it is.** A shortlisting heuristic that ranks what to look at. It has no view on
whether a base resolves up or down, and none of the thresholds are backtested — they
encode a fairly conventional idea of constructive consolidation and nothing more.

---

## The screener filter itself

Unchanged from your saved screener, in [`config/screener.json`](config/screener.json):

| Chip | Field |
|---|---|
| Price > 10 INR | `close > 10` |
| Chg > 4% | `change > 4` |
| Mkt cap 5B–100B | `market_cap_basic in_range` |
| NSE | `exchange = NSE` |
| Vol chg > 300% | `volume_change > 300` — TradingView's **day-over-day** volume change, not relative volume |
| Price × vol > 100M | `Value.Traded > 1e8` |

---

## Focus list

The answer to "the list keeps growing". Two sections on one tab, both drawn from the
same qualifying pass.

**Excluded before anything else is considered:**

- last appearance more than **60 sessions** ago (configurable)
- base status **Broken** (gave back more than 25% of the surge)

**Qualifying reasons** — a stock needs at least one:

| Reason | Rule |
|---|---|
| Basing in strong sector | base score ≥ 60, status *Base building* or *Watch*, sector hot or warm |
| Clustering now | ≥ 3 hits in the last 10 sessions |
| New in leading sector | first-ever appearance, in a top-3 sector |
| Re-emerging | back after any re-emergence band (default 5+ sessions), in a hot or warm sector |

**High conviction** (top section) requires **every** gate to pass:

- basing well (score ≥ 60, *Base building* or *Watch*)
- ≥ 2 hits in the last 30 sessions
- hot or warm sector
- 3–30 sessions since the last appearance

Everything else that tripped at least one reason falls to **Worth a look**, tagged with
whichever rules fired. High conviction sorts by base score; Worth a look sorts by heat.

An empty High-conviction section is a normal outcome, not a bug.

### Dismissals

Dismissing records the **signature** of why a name qualified:

```
section | base status | sorted reasons
gate|Base building|Basing in strong sector
```

It stays hidden only while that signature holds. If it later qualifies differently —
say it moves from *Watch* to *Base building*, or starts clustering — the signature no
longer matches and it returns to the list automatically.

Stored in `localStorage`, so it is per-browser, never leaves your machine, and is not
part of the committed data. Restore any of them from the "n dismissed" panel.

---

## Ranked by how arbitrary

If you tune anything, start at the top.

1. **Heat decay (15)** — drives the default ordering of the whole leaderboard.
2. **Base thresholds** — five bands of judgement; the pullback bands matter most.
3. **Sector tiers (top 3 / 40%)** — sensitive to how many sectors exist.
4. **`BACK` gap (20 sessions)** — pure convention.
5. **Sector window (30 sessions)** — reasonable, rarely decisive.
6. **Status cutoffs (70 / 45)** — cosmetic; they only rename what the score already says.
