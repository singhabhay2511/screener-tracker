'use strict';
/**
 * All tunable metrics, computed in the browser from raw snapshots so the
 * parameters below can be changed live. `recompute(D, CFG)` mutates D in
 * place, so every render function keeps reading s.heat / s.base / s.counts
 * exactly as before.
 */
(function (global) {

  const DEFAULTS = {
    heat: { decay: 15 },

    windows: [10, 30, 90],

    leaderboard: { rankBy: 'heat' },   // 'heat' = recency-weighted, 'hits' = raw count

    sector: { window: 30, hotRanks: 3, warmPct: 40 },

    // Gap since the previous appearance, in sessions. A stock returning after
    // a long absence is a different signal from one returning after a week.
    reemerge: { band1: 5, band2: 10, band3: 20 },

    base: {
      weights: { pullback: 30, tightness: 20, aboveMa: 20, volDryup: 15, maturity: 15 },
      // Percent moves from the highest close on any day it appeared.
      pullback: { runaway: 20, hold: -2, healthy: -12, deep: -25 },
      tightness: { lookback: 10, tight: 8, ok: 15, loose: 25 },
      volDryup: { dry: 0.7, normal: 1.2, active: 2 },
      maturity: { min: 3, peakEnd: 30, decayEnd: 60 },
      status: { building: 70, watch: 45 },
    },

    focus: {
      staleAfter: 60, gateMinBase: 60, gateMinHits30: 2,
      gateMinAgo: 3, gateMaxAgo: 30, clusterMin: 3,
    },
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  /** Deep-merge stored settings over defaults, so new keys appear on upgrade. */
  function withDefaults(stored) {
    const out = clone(DEFAULTS);
    const merge = (dst, src) => {
      for (const k of Object.keys(src || {})) {
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
          if (dst[k]) merge(dst[k], src[k]);
        } else if (src[k] != null) dst[k] = src[k];
      }
    };
    merge(out, stored);
    return out;
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // ---- base analysis ----------------------------------------------------
  function baseAnalysis(hits, track, closes, sessionsSince, cfg) {
    if (!track || track.close == null) return null;
    const B = cfg.base;

    const surgeClose = Math.max(...hits.map((h) => h.close ?? 0));
    const cur = track.close;
    const fromSurge = surgeClose ? (cur / surgeClose - 1) * 100 : null;   // percent

    const parts = {};

    // 1. Time elapsed
    const M = B.maturity;
    if (sessionsSince < M.min) parts.maturity = 0.15;
    else if (sessionsSince <= M.peakEnd) parts.maturity = 1;
    else if (sessionsSince <= M.decayEnd) {
      const span = Math.max(1, M.decayEnd - M.peakEnd);
      parts.maturity = 1 - ((sessionsSince - M.peakEnd) / span) * 0.7;
    } else parts.maturity = 0.15;

    // 2. Pullback depth -- where price sits now vs the best surge close
    const P = B.pullback;
    if (fromSurge == null) parts.pullback = null;
    else if (fromSurge > P.runaway) parts.pullback = 0.15;
    else if (fromSurge >= P.hold) parts.pullback = 1;
    else if (fromSurge >= P.healthy) parts.pullback = 0.9;
    else if (fromSurge >= P.deep) parts.pullback = 0.45;
    else parts.pullback = 0.05;

    // 3. Structure vs moving averages
    if (track.sma20 != null && cur > track.sma20) parts.aboveMa = 1;
    else if (track.sma50 != null && cur > track.sma50) parts.aboveMa = 0.55;
    else if (track.sma20 == null && track.sma50 == null) parts.aboveMa = null;
    else parts.aboveMa = 0.1;

    // 4. Volume dry-up
    const V = B.volDryup, rv = track.rel_vol;
    if (rv == null) parts.volDryup = null;
    else if (rv <= V.dry) parts.volDryup = 1;
    else if (rv <= V.normal) parts.volDryup = 0.75;
    else if (rv <= V.active) parts.volDryup = 0.35;
    else parts.volDryup = 0.1;

    // 5. Range contraction
    const T = B.tightness;
    const win = (closes || []).slice(-T.lookback);
    let tightness = null;
    if (win.length >= 5) {
      const hi = Math.max(...win), lo = Math.min(...win), m = mean(win);
      tightness = m ? ((hi - lo) / m) * 100 : null;
    }
    if (tightness == null) parts.tightness = null;
    else if (tightness <= T.tight) parts.tightness = 1;
    else if (tightness <= T.ok) parts.tightness = 0.7;
    else if (tightness <= T.loose) parts.tightness = 0.35;
    else parts.tightness = 0.1;

    // Weighted average over whatever could be computed.
    const W = B.weights;
    let num = 0, den = 0;
    for (const k of Object.keys(W)) {
      if (parts[k] == null) continue;
      num += parts[k] * W[k];
      den += W[k];
    }
    const score = den ? Math.round((num / den) * 100) : null;

    // Structural verdicts override the blend. Extended/Broken reuse the
    // pullback bands -- they are the same idea expressed as a label.
    let status;
    if (sessionsSince < B.maturity.min) status = 'Too soon';
    else if (fromSurge != null && fromSurge > P.runaway) status = 'Extended';
    else if (fromSurge != null && fromSurge < P.deep) status = 'Broken';
    else if (score >= B.status.building) status = 'Base building';
    else if (score >= B.status.watch) status = 'Watch';
    else status = 'Weak';

    return {
      score, status, parts,
      from_surge_pct: fromSurge == null ? null : +fromSurge.toFixed(2),
      surge_close: surgeClose || null,
      tightness_pct: tightness == null ? null : +tightness.toFixed(2),
    };
  }

  // ---- main -------------------------------------------------------------
  function recompute(D, cfg) {
    const sessions = D.sessions;
    const idxOf = new Map(sessions.map((d, i) => [d, i]));
    const latest = sessions.at(-1) ?? null;
    const n = sessions.length;

    // Which sessions are preceded by a hole in the recording?
    const gapDates = (D.gaps || []).map((g) => g.date);
    const gapBefore = sessions.map((d, i) => {
      if (i === 0) return false;
      return gapDates.some((g) => g > sessions[i - 1] && g < d);
    });

    for (const s of D.symbols) {
      const dates = s.hits.map((h) => h.date);
      const ix = dates.map((d) => idxOf.get(d)).sort((a, b) => a - b);
      const lastIdx = ix.at(-1);
      const sessionsSince = n - 1 - lastIdx;

      s.counts = { all: dates.length };
      for (const w of cfg.windows) {
        const cutoff = n - w;
        s.counts[w] = ix.filter((i) => i >= cutoff).length;
      }

      // Streaks, flagged when they span a recording gap.
      let best = 0, cur = 0, runEnd = -2, curSuspect = false, bestSuspect = false;
      let suspect = false;
      for (const i of ix) {
        if (i === runEnd + 1) { cur += 1; if (gapBefore[i]) suspect = true; }
        else { cur = 1; suspect = false; }
        runEnd = i;
        if (cur > best) { best = cur; bestSuspect = suspect; }
        curSuspect = suspect;
      }
      s.streak = runEnd === n - 1 ? cur : 0;
      s.streak_suspect = s.streak > 1 && curSuspect;
      s.longest_streak = best;
      s.longest_suspect = bestSuspect;

      s.first_seen = dates[0];
      s.last_seen = dates.at(-1);
      s.sessions_since = sessionsSince;

      s.heat = +s.hits.reduce(
        (acc, h) => acc + Math.exp(-(n - 1 - idxOf.get(h.date)) / Math.max(1, cfg.heat.decay)), 0
      ).toFixed(3);

      // The move on its most recent appearance, as opposed to the average across all of them.
      s.latest_change = s.hits.at(-1).change_pct ?? null;
      s.best_change = Math.max(...s.hits.map((h) => h.change_pct ?? -Infinity));
      s.avg_rel_vol = mean(s.hits.map((h) => h.rel_vol).filter((v) => v != null));

      const firstClose = s.hits[0].close, lastClose = s.hits.at(-1).close;
      const nowClose = s.track?.close ?? null;
      s.current_close = nowClose;
      s.last_close = lastClose;
      s.since_first_pct = nowClose && firstClose ? +((nowClose / firstClose - 1) * 100).toFixed(2) : null;
      s.since_last_pct = nowClose && lastClose ? +((nowClose / lastClose - 1) * 100).toFixed(2) : null;

      // Average return if you had bought at the close of every appearance and
      // held to today. Uses only hit days, and answers whether the surges paid
      // -- a different question from how large they were on the day.
      s.avg_return = nowClose
        ? mean(s.hits.map((h) => (h.close ? (nowClose / h.close - 1) * 100 : null))
            .filter((v) => v != null))
        : null;
      s.rel_vol_now = s.track?.rel_vol ?? null;
      s.pe = s.hits.at(-1).pe ?? null;
      s.analyst_rating = s.hits.at(-1).analyst_rating ?? null;

      s.base = baseAnalysis(s.hits, s.track, s.closes, sessionsSince, cfg);

      // Banded re-emergence: how long was it gone before coming back?
      const priorGap = ix.length > 1 ? ix.at(-1) - ix.at(-2) : null;
      const R = cfg.reemerge;
      s.is_new = dates.length === 1 && dates[0] === latest;
      s.reemerge_gap = priorGap;
      s.reemerge_band = null;
      if (dates.at(-1) === latest && priorGap != null) {
        if (priorGap >= R.band3) s.reemerge_band = `${R.band3}+`;
        else if (priorGap >= R.band2) s.reemerge_band = `${R.band2}–${R.band3}`;
        else if (priorGap >= R.band1) s.reemerge_band = `${R.band1}–${R.band2}`;
      }
      s.is_reemerging = s.reemerge_band != null;
    }

    // ---- sector strength ----
    const cutoff = n - cfg.sector.window;
    const count = {}, members = {};
    for (const s of D.symbols) {
      if (!s.sector) continue;
      const c = s.hits.filter((h) => idxOf.get(h.date) >= cutoff).length;
      if (!c) continue;
      count[s.sector] = (count[s.sector] || 0) + c;
      (members[s.sector] ||= []).push(s.ticker);
    }
    const warmCut = Math.ceil(Object.keys(count).length * (cfg.sector.warmPct / 100));
    D.sectors = Object.entries(count)
      .sort((a, b) => b[1] - a[1])
      .map(([sector, c], i, arr) => ({
        sector, count: c, rank: i + 1, of: arr.length,
        symbols: members[sector].length,
        tier: i < cfg.sector.hotRanks ? 'hot' : i < warmCut ? 'warm' : 'cool',
      }));

    const byName = new Map(D.sectors.map((x) => [x.sector, x]));
    for (const s of D.symbols) {
      const sr = s.sector ? byName.get(s.sector) : null;
      s.sector_rank = sr ? sr.rank : null;
      s.sector_tier = sr ? sr.tier : null;
      s.sector_of = sr ? sr.of : null;
    }

    D.symbols.sort((a, b) => b.heat - a.heat || b.counts.all - a.counts.all);

    // ---- latest session rows ----
    D.today = D.symbols
      .filter((s) => s.last_seen === latest)
      .map((s) => {
        const h = s.hits.at(-1);
        return {
          ...h, ticker: s.ticker, symbol: s.symbol, name: s.name, sector: s.sector,
          counts: s.counts, streak: s.streak, streak_suspect: s.streak_suspect,
          is_new: s.is_new, is_reemerging: s.is_reemerging, reemerge_band: s.reemerge_band,
          first_seen: s.first_seen, since_first_pct: s.since_first_pct,
          sector_rank: s.sector_rank, sector_tier: s.sector_tier, sector_of: s.sector_of,
          base: s.base,
        };
      })
      .sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0));

    return D;
  }

  global.Metrics = { DEFAULTS, withDefaults, recompute, clone };
})(window);
