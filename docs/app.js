'use strict';

let D = null;
const S = {
  view: 'focus',
  session: null,                 // which session the Session view shows
  sub: null,                     // in-place KPI filter: new | repeat | hot
  filters: {},                   // sector | flag | base | session
  win: 'all',
  sortKey: 'heat', sortDir: -1,
  query: '',
  expanded: null,                // sector row expanded inline
  depth: 0,                      // our own history depth, for the Back button
};

const $ = (s) => document.querySelector(s);
const app = $('#app');

// ---------- formatting --------------------------------------------------
const num = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
const cls = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cap = (v) => {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + ' T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + ' B';
  if (a >= 1e7) return (v / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return (v / 1e5).toFixed(2) + ' L';
  return v.toFixed(0);
};
const vol = (v) => {
  if (v == null) return '—';
  if (v >= 1e7) return (v / 1e7).toFixed(2) + ' Cr';
  if (v >= 1e5) return (v / 1e5).toFixed(2) + ' L';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' K';
  return String(v);
};

const BASE_CLASS = {
  'Base building': 'bs-good', Watch: 'bs-warn', Extended: 'bs-ext',
  Broken: 'bs-bad', 'Too soon': 'bs-soon',
};

// ---------- reusable chips ----------------------------------------------

/** Sector chip carrying its strength rank — clickable to filter. */
function sectorChip(sector, rank, tier, of) {
  if (!sector) return '<span class="muted">—</span>';
  const r = rank ? `<i>#${rank}</i>` : '';
  return `<span class="schip t-${tier || 'cool'}" data-filter="sector" data-value="${esc(sector)}"
    title="${esc(sector)} — rank ${rank || '?'} of ${of || '?'} by appearances over ${CFG.sector.window} sessions">${esc(sector)}${r}</span>`;
}

function baseChip(base) {
  if (!base) return '<span class="muted">—</span>';
  return `<span class="bchip ${BASE_CLASS[base.status] || ''}" data-filter="base" data-value="${esc(base.status)}"
    title="base score ${base.score} · ${base.from_surge_pct == null ? '' : base.from_surge_pct + '% from surge'}">
    ${esc(base.status)}${base.score == null ? '' : ` <i>${base.score}</i>`}</span>`;
}

function badges(s) {
  let b = '';
  if (s.is_new) b += '<span class="badge b-new" data-filter="flag" data-value="new">NEW</span>';
  if (s.is_reemerging) {
    // Banded: a name back after 25 sessions is a different signal from one
    // back after 6, so the badge says which band it fell in.
    b += `<span class="badge b-re" data-filter="flag" data-value="reemerging"
      title="returned after ${s.reemerge_gap} sessions away">BACK ${esc(s.reemerge_band)}</span>`;
  }
  const n = (s.counts && s.counts[10]) || 0;
  if (!s.is_new && n > 1) b += `<span class="badge b-rep" data-filter="flag" data-value="repeat">${n}× in 10</span>`;
  if (s.streak > 1) {
    // A streak spanning a missed capture isn't a real streak.
    b += `<span class="badge b-rep ${s.streak_suspect ? 'b-susp' : ''}"
      ${s.streak_suspect ? 'title="This streak spans a day with no recorded snapshot, so it may not be a true consecutive run."' : ''}
      >streak ${s.streak}${s.streak_suspect ? ' ⚠' : ''}</span>`;
  }
  return b;
}

// ---------- tunable settings --------------------------------------------
// Every parameter lives here, is edited from the screen it affects, and is
// applied by recomputing all metrics in the browser -- no rebuild needed.

const CFG_KEY = 'screener-tracker.config.v1';
let CFG = Metrics.withDefaults({});

function loadCfg() {
  try { return Metrics.withDefaults(JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); }
  catch { return Metrics.withDefaults({}); }
}
function saveCfg() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch { /* private mode */ }
}

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => {
  const ks = p.split('.'); const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
};

/**
 * A settings disclosure, rendered inside the view whose numbers it controls.
 * fields: [{ path, label, min, max, step, hint }]
 */
function cfgPanel(title, blurb, fields, opts = {}) {
  const open = S.cfgOpen === title;
  return `
  <details class="cfg" ${open ? 'open' : ''} data-cfg-panel="${esc(title)}">
    <summary><span class="gear">⚙</span> ${esc(title)}</summary>
    ${blurb ? `<p class="cfgblurb">${blurb}</p>` : ''}
    <div class="cfggrid">
      ${fields.map((f) => `
        <label class="cfgfield">
          <span class="cfglab">${esc(f.label)}</span>
          <input type="number" data-cfg="${f.path}" value="${getPath(CFG, f.path)}"
            ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}
            step="${f.step ?? 1}">
          ${f.hint ? `<span class="cfghint">${esc(f.hint)}</span>` : ''}
        </label>`).join('')}
    </div>
    ${opts.footer || ''}
    <button class="cfgreset" data-cfg-reset="${fields.map((f) => f.path).join(',')}">Reset these to defaults</button>
  </details>`;
}

// ---------- dismissals --------------------------------------------------
// Stored per-browser. We record *why* a name qualified when you dismissed it;
// if it later qualifies for a different reason, the dismissal no longer
// matches and it comes back. Dismissing is not permanent blindness.

const DISMISS_KEY = 'screener-tracker.dismissed.v1';
let dismissed = {};

function loadDismissed() {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}'); } catch { return {}; }
}
function saveDismissed() {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed)); } catch { /* private mode */ }
}


/** The signature that has to change for a dismissed name to resurface. */
function signature(s, section, reasons) {
  return [section, s.base ? s.base.status : '-', reasons.slice().sort().join('+')].join('|');
}

function focusList() {
  const F = CFG.focus;
  const gate = [], watch = [], hidden = [];

  for (const s of activeSymbols()) {
    if (s.sessions_since > F.staleAfter) continue;              // gone cold
    if (s.base && s.base.status === 'Broken') continue;        // gave the move back

    const strongSector = s.sector_tier === 'hot' || s.sector_tier === 'warm';
    const basingWell = !!s.base && s.base.score >= F.gateMinBase
      && (s.base.status === 'Base building' || s.base.status === 'Watch');

    const reasons = [];
    if (basingWell && strongSector) reasons.push('Basing in strong sector');
    if ((s.counts[10] || 0) >= F.clusterMin) reasons.push('Clustering now');
    if (s.is_new && s.sector_tier === 'hot') reasons.push('New in leading sector');
    if (s.is_reemerging && strongSector) reasons.push('Re-emerging');
    if (!reasons.length) continue;

    // Strict gates: every condition must hold.
    const passesGates = basingWell && strongSector
      && (s.counts[30] || 0) >= F.gateMinHits30
      && s.sessions_since >= F.gateMinAgo && s.sessions_since <= F.gateMaxAgo;

    const section = passesGates ? 'gate' : 'watch';
    const sig = signature(s, section, reasons);
    const d = dismissed[s.ticker];

    if (d && d.sig === sig) { hidden.push({ s, reasons, sig }); continue; }
    if (d) { delete dismissed[s.ticker]; saveDismissed(); }     // re-qualified differently

    (passesGates ? gate : watch).push({ s, reasons, sig });
  }

  gate.sort((a, b) => (b.s.base?.score ?? 0) - (a.s.base?.score ?? 0) || b.s.heat - a.s.heat);
  watch.sort((a, b) => b.s.heat - a.s.heat || (b.s.base?.score ?? 0) - (a.s.base?.score ?? 0));
  return { gate, watch, hidden };
}

// ---------- filtering ---------------------------------------------------

function activeSymbols() {
  const f = S.filters;
  return D.symbols.filter((s) => {
    if (f.sector && s.sector !== f.sector) return false;
    if (f.base && (!s.base || s.base.status !== f.base)) return false;
    if (f.session && !s.hits.some((h) => h.date === f.session)) return false;
    if (f.flag === 'new' && !s.is_new) return false;
    if (f.flag === 'reemerging' && !s.is_reemerging) return false;
    if (f.flag === 'repeat' && ((s.counts && s.counts[10]) || 0) < 2) return false;
    if (S.query) {
      const hay = `${s.symbol} ${s.name || ''} ${s.sector || ''}`.toLowerCase();
      if (!hay.includes(S.query)) return false;
    }
    return true;
  });
}

const FILTER_LABEL = {
  sector: (v) => `Sector: ${v}`,
  base: (v) => `Base: ${v}`,
  session: (v) => `Appeared on ${v}`,
  flag: (v) => ({ new: 'First-timers only', reemerging: 'Re-emerging only', repeat: 'Repeats (10 sess.)' }[v] || v),
};

const SUB_LABEL = { new: 'First-timers', repeat: 'Repeats (10 sess.)', hot: 'Hot sectors only' };

function renderFilterBar() {
  const f = S.filters;
  const keys = Object.keys(f).filter((k) => f[k]);
  const bar = $('#filters');
  const anything = keys.length || S.query || S.sub || S.depth > 0;
  if (!anything) { bar.hidden = true; return; }
  bar.hidden = false;

  const back = S.depth > 0
    ? `<button class="backbtn" data-back title="Back (or use your browser's back button)">← Back</button>` : '';
  const chips = keys.map((k) => `<span class="fchip">${esc(FILTER_LABEL[k](f[k]))}
      <button data-unfilter="${k}" aria-label="Remove">&times;</button></span>`).join('')
    + (S.sub ? `<span class="fchip">${esc(SUB_LABEL[S.sub] || S.sub)}<button data-unfilter="sub">&times;</button></span>` : '')
    + (S.query ? `<span class="fchip">Search: ${esc(S.query)}<button data-unfilter="query">&times;</button></span>` : '');

  bar.innerHTML = back
    + (chips ? `<span class="fl">Filters</span>${chips}<button class="clear-all" data-unfilter="all">Clear all</button>` : '')
    + `<span class="fcount">${activeSymbols().length} of ${D.symbols.length} symbols</span>`;
}

// ---------- views -------------------------------------------------------

function renderFocus() {
  const { gate, watch, hidden } = focusList();

  const row = (e, showDismiss = true) => `
    <tr data-ticker="${esc(e.s.ticker)}">
      <td class="sym"><b>${esc(e.s.symbol)}</b><span class="desc">${esc(e.s.name)}</span></td>
      <td class="sym reasons">${e.reasons.map((r) => `<span class="rchip">${esc(r)}</span>`).join('')}</td>
      <td class="sym">${baseChip(e.s.base)}</td>
      <td class="hits"><b>${e.s.counts[10] || 0}</b><span class="unit">/10</span>
        <span class="sep">·</span><b>${e.s.counts[30] || 0}</b><span class="unit">/30</span></td>
      <td>${e.s.sessions_since}</td>
      <td class="${cls(e.s.base?.from_surge_pct)}">${pct(e.s.base?.from_surge_pct)}</td>
      <td class="${cls(e.s.since_first_pct)}">${pct(e.s.since_first_pct)}</td>
      <td class="sym">${sectorChip(e.s.sector, e.s.sector_rank, e.s.sector_tier, e.s.sector_of)}</td>
      <td class="sym">${showDismiss
        ? `<button class="dmiss" data-dismiss="${esc(e.s.ticker)}" data-sig="${esc(e.sig)}" title="Hide until it qualifies for a different reason">Dismiss</button>`
        : `<button class="dmiss undo" data-restore="${esc(e.s.ticker)}">Restore</button>`}</td>
    </tr>`;

  const head = `<thead><tr>
    <th class="sym">Symbol</th><th class="sym">Why</th><th class="sym">Base</th>
    <th>Hits 10 · 30</th><th>Sess. ago</th><th>From surge</th><th>Since 1st</th>
    <th class="sym">Sector</th><th class="sym"></th>
  </tr></thead>`;

  const F = CFG.focus;
  return `
  ${cfgPanel('Focus rules', 'Change any number and the two lists below rebuild immediately.', [
    { path: 'focus.gateMinBase', label: 'Gate: min base score', min: 0, max: 100, hint: 'high-conviction cutoff' },
    { path: 'focus.gateMinHits30', label: 'Gate: min hits in 30', min: 1, max: 30 },
    { path: 'focus.gateMinAgo', label: 'Gate: min sessions ago', min: 0, max: 60, hint: 'time to build a base' },
    { path: 'focus.gateMaxAgo', label: 'Gate: max sessions ago', min: 1, max: 200, hint: 'beyond this it is stale' },
    { path: 'focus.clusterMin', label: '"Clustering now" hits in 10', min: 2, max: 10 },
    { path: 'focus.staleAfter', label: 'Drop after N sessions unseen', min: 5, max: 300 },
  ])}

  <section class="fsec">
    <div class="fhead">
      <h2><span class="dot g"></span>High conviction</h2>
      <p>Every gate passes: basing well (score ≥ ${F.gateMinBase}), ${F.gateMinHits30}+ hits in 30 sessions,
         hot or warm sector, and ${F.gateMinAgo}–${F.gateMaxAgo} sessions since the surge.</p>
    </div>
    ${gate.length
      ? `<div class="scroll"><table>${head}<tbody>${gate.map((e) => row(e)).join('')}</tbody></table></div>`
      : `<p class="empty tight">Nothing clears every gate right now. That's a normal outcome — check the section below.</p>`}
  </section>

  <section class="fsec">
    <div class="fhead">
      <h2><span class="dot a"></span>Worth a look</h2>
      <p>Trips at least one rule but not all of them. Each row shows which rule fired.</p>
    </div>
    ${watch.length
      ? `<div class="scroll"><table>${head}<tbody>${watch.map((e) => row(e)).join('')}</tbody></table></div>`
      : `<p class="empty tight">Nothing qualifying.</p>`}
  </section>

  <p class="sub excl">Excluded everywhere: last seen more than ${F.staleAfter} sessions ago, or a
  <b>Broken</b> base (gave back more than 25% of the surge).</p>

  ${!hidden.length ? '' : `
  <details class="dismissed">
    <summary>${hidden.length} dismissed</summary>
    <p class="sub">These return automatically if they qualify for a different reason later.</p>
    <div class="scroll"><table>${head}<tbody>${hidden.map((e) => row(e, false)).join('')}</tbody></table></div>
  </details>`}`;
}

function renderSession() {
  const date = S.session || D.latest_session;
  const snapIdx = D.sessions.indexOf(date);
  const rows = date === D.latest_session
    ? D.today
    : D.symbols.filter((s) => s.hits.some((h) => h.date === date)).map((s) => {
      const h = s.hits.find((x) => x.date === date);
      return {
        ...h, ticker: s.ticker, symbol: s.symbol, name: s.name, sector: s.sector,
        counts: s.counts, streak: s.streak, is_new: s.first_seen === date,
        is_reemerging: false, since_first_pct: s.since_first_pct,
        sector_rank: s.sector_rank, sector_tier: s.sector_tier, sector_of: s.sector_of,
        base: s.base,
      };
    }).sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0));

  const isRepeat = (r) => ((r.counts && r.counts[10]) || 0) > 1;
  const isHot = (r) => r.sector_tier === 'hot';
  const fresh = rows.filter((r) => r.is_new).length;
  const rep = rows.filter(isRepeat).length;
  const hot = rows.filter(isHot).length;

  // KPI cards filter the table already on screen. No tab change, no trip back.
  const SUB = { new: (r) => r.is_new, repeat: isRepeat, hot: isHot };
  const shown = S.sub ? rows.filter(SUB[S.sub]) : rows;

  const options = D.sessions.slice().reverse()
    .map((d) => `<option value="${d}" ${d === date ? 'selected' : ''}>${d}${d === D.latest_session ? ' (latest)' : ''}</option>`)
    .join('');
  const card = (key, label, value, hint) => `
    <div class="card clickable ${S.sub === key ? 'sel' : ''}" data-sub="${key}">
      <div class="k">${label}</div><div class="v">${value}</div>
      <div class="hint">${S.sub === key ? 'showing these — click to clear' : hint}</div>
    </div>`;

  const R = CFG.reemerge;
  const gapsBefore = (D.gaps || []).filter((g) => g.date < date && (snapIdx === 0 || g.date > D.sessions[snapIdx - 1]));

  return `
  ${!(D.gaps || []).length ? '' : `
  <div class="gapnote">
    <b>⚠ ${D.gaps.length} weekday${D.gaps.length === 1 ? '' : 's'} with no recorded snapshot.</b>
    Streaks spanning a gap are marked <span class="badge b-rep b-susp">streak n ⚠</span> because they
    may not be true consecutive runs.
    <span class="gapdates">${D.gaps.slice(0, 8).map((g) => `<span class="dt" title="${esc(g.status)}">${g.date}</span>`).join('')}${D.gaps.length > 8 ? ` +${D.gaps.length - 8} more` : ''}</span>
  </div>`}
  ${gapsBefore.length ? `<p class="sub gapinline">⚠ ${gapsBefore.length} unrecorded weekday immediately before this session.</p>` : ''}

  ${cfgPanel('Re-emergence bands',
    `A stock returning after a long absence is a different signal from one back after a week, `
    + `so the <span class="badge b-re">BACK</span> badge is banded: `
    + `<b>${R.band1}–${R.band2}</b>, <b>${R.band2}–${R.band3}</b>, <b>${R.band3}+</b> sessions away. `
    + `Below ${R.band1} sessions it isn't treated as a re-emergence at all.`,
    [
      { path: 'reemerge.band1', label: 'Band 1 starts at', min: 1, max: 100, hint: 'minimum gap to count' },
      { path: 'reemerge.band2', label: 'Band 2 starts at', min: 2, max: 200 },
      { path: 'reemerge.band3', label: 'Band 3 starts at', min: 3, max: 300 },
    ])}

  <div class="cards">
    <div class="card">
      <div class="k">Session <span class="hint">${snapIdx + 1} of ${D.session_count}</span></div>
      <select id="sessionPick" class="card-select">${options}</select>
    </div>
    <div class="card clickable ${!S.sub ? 'sel' : ''}" data-sub="">
      <div class="k">Matches</div><div class="v">${rows.length}</div>
      <div class="hint">${S.sub ? 'show all →' : 'all matches'}</div>
    </div>
    ${card('new', 'First-timers', fresh, 'never seen before')}
    ${card('repeat', 'Repeats (10 sess.)', rep, 'recurring names')}
    ${card('hot', 'In hot sectors', hot, 'top-3 sectors by strength')}
  </div>
  ${!shown.length ? `<p class="empty">${rows.length ? 'No stocks in this session match that filter.' : 'No stocks matched on this session.'}</p>` : `
  <div class="scroll"><table><thead><tr>
    <th class="sym">Symbol</th><th>Price</th><th>Chg %</th><th>Since 1st</th>
    <th>Rel vol</th><th>Volume</th><th class="sym">Sector</th><th class="sym">Base</th>
  </tr></thead><tbody>
  ${shown.map((r) => `
    <tr data-ticker="${esc(r.ticker)}">
      <td class="sym"><b>${esc(r.symbol)}</b>${badges(r)}<span class="desc">${esc(r.name)}</span></td>
      <td>${num(r.close)}</td>
      <td class="${cls(r.change_pct)}">${pct(r.change_pct)}</td>
      <td class="${cls(r.since_first_pct)}">${pct(r.since_first_pct)}</td>
      <td>${num(r.rel_vol)}</td>
      <td>${vol(r.volume)}</td>
      <td class="sym">${sectorChip(r.sector, r.sector_rank, r.sector_tier, r.sector_of)}</td>
      <td class="sym">${baseChip(r.base)}</td>
    </tr>`).join('')}
  </tbody></table></div>`}`;
}

function renderLeaderboard() {
  const cols = [
    ['symbol', 'Symbol', 'sym'], ['count', `Hits (${S.win})`, ''], ['heat', 'Heat', ''],
    ['streak', 'Streak', ''], ['sessions_since', 'Sessions ago', ''],
    ['since_first_pct', 'Since 1st', ''], ['since_last_pct', 'Since last', ''],
    ['avg_change', 'Avg chg %', ''], ['sector_rank', 'Sector', 'sym'], ['base_score', 'Base', 'sym'],
  ];

  const rows = activeSymbols()
    .map((s) => ({
      ...s,
      count: s.counts[S.win] != null ? s.counts[S.win] : s.counts.all,
      base_score: s.base ? s.base.score : null,
    }))
    .filter((s) => s.count > 0);

  rows.sort((a, b) => {
    const x = a[S.sortKey], y = b[S.sortKey];
    if (typeof x === 'string') return S.sortDir * x.localeCompare(y);
    return S.sortDir * ((x == null ? -Infinity : x) - (y == null ? -Infinity : y));
  });

  const opts = ['10', '30', '90', 'all'].map((w) =>
    `<option value="${w}" ${w === String(S.win) ? 'selected' : ''}>${w === 'all' ? `All ${D.session_count} sessions` : `Last ${w} sessions`}</option>`).join('');

  return `
  <div class="toolbar">
    <label>Window</label><select id="win">${opts}</select>
    <input type="search" id="q" placeholder="Filter symbol / sector…" value="${esc(S.query)}">
  </div>
  ${cfgPanel('Heat weighting',
    `Heat is <code>Σ exp(−age ÷ decay)</code> across every appearance, where age is sessions ago. `
    + `At the current decay of <b>${CFG.heat.decay}</b>, an appearance today counts 1.00, `
    + `one ${CFG.heat.decay} sessions ago counts 0.37, and one ${CFG.heat.decay * 3} ago counts 0.05. `
    + `Lower it to react faster and forget sooner; raise it to reward long-run persistence.`,
    [{ path: 'heat.decay', label: 'Decay (sessions)', min: 1, max: 200, hint: 'lower = more recency-biased' }])}
  ${!rows.length ? '<p class="empty">No symbols match these filters.</p>' : `
  <div class="scroll"><table><thead><tr>
    ${cols.map(([k, label, c]) => `<th class="${c}" data-k="${k}">${label}${S.sortKey === k ? (S.sortDir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}
  </tr></thead><tbody>
  ${rows.map((s) => `
    <tr data-ticker="${esc(s.ticker)}">
      <td class="sym"><b>${esc(s.symbol)}</b>${badges(s)}<span class="desc">${esc(s.name)}</span></td>
      <td><b>${s.count}</b></td>
      <td>${num(s.heat, 2)}</td>
      <td>${s.streak || '—'}</td>
      <td>${s.sessions_since}</td>
      <td class="${cls(s.since_first_pct)}">${pct(s.since_first_pct)}</td>
      <td class="${cls(s.since_last_pct)}">${pct(s.since_last_pct)}</td>
      <td class="${cls(s.avg_change)}">${pct(s.avg_change)}</td>
      <td class="sym">${sectorChip(s.sector, s.sector_rank, s.sector_tier, s.sector_of)}</td>
      <td class="sym">${baseChip(s.base)}</td>
    </tr>`).join('')}
  </tbody></table></div>`}`;
}

function renderBases() {
  const rows = activeSymbols()
    .filter((s) => s.base && s.sessions_since >= 3)
    .sort((a, b) => (b.base.score ?? -1) - (a.base.score ?? -1));

  const part = (v) => (v == null ? '<i class="na">n/a</i>' : `<i class="pb" style="--w:${Math.round(v * 100)}%"></i>`);

  const B = CFG.base;
  const wsum = Object.values(B.weights).reduce((a, b) => a + b, 0);

  return `
  <p class="sub" style="margin:0 0 12px">
    Stocks that surged, then went quiet — ranked by how constructively they're consolidating.
    <b>A shortlisting heuristic, not a signal.</b>
  </p>

  <details class="cfg explain" ${S.cfgOpen === 'How pullback depth works' ? 'open' : ''} data-cfg-panel="How pullback depth works">
    <summary><span class="gear">?</span> How pullback depth works</summary>
    <p class="cfgblurb">It asks one question: <b>where is the price now, compared with the highest
    close on any day this stock appeared in the screener?</b> That surge close is the reference point.</p>
    <div class="ladder">
      <div class="lrung"><span class="lval">above +${B.pullback.runaway}%</span>
        <span class="lbar bad"></span><span class="ltxt"><b>It kept running.</b> There is no base to buy — it's extended, and labelled <em>Extended</em>.</span></div>
      <div class="lrung"><span class="lval">${B.pullback.hold}% to +${B.pullback.runaway}%</span>
        <span class="lbar best"></span><span class="ltxt"><b>Holding the entire move.</b> Scores highest — it surged and never gave any back.</span></div>
      <div class="lrung"><span class="lval">${B.pullback.healthy}% to ${B.pullback.hold}%</span>
        <span class="lbar good"></span><span class="ltxt"><b>Healthy digestion.</b> A shallow pullback while it consolidates. This is the classic base.</span></div>
      <div class="lrung"><span class="lval">${B.pullback.deep}% to ${B.pullback.healthy}%</span>
        <span class="lbar mid"></span><span class="ltxt"><b>Deep but alive.</b> Getting uncomfortable; scores less than half.</span></div>
      <div class="lrung"><span class="lval">below ${B.pullback.deep}%</span>
        <span class="lbar bad"></span><span class="ltxt"><b>Gave the move back.</b> Treated as failed and labelled <em>Broken</em> — excluded from Focus entirely.</span></div>
    </div>
    <p class="cfgblurb"><b>Caveat:</b> this uses the highest <em>close</em>, not the intraday high of
    the surge day — that column isn't in the data we pull. Real drawdown off the spike is deeper
    than the number shown.</p>
  </details>

  ${cfgPanel('Base scoring parameters',
    `Weights are relative — they currently total <b>${wsum}</b> and are normalised, so you can use any numbers. `
    + `Components that can't be computed yet are dropped and the rest renormalise.`,
    [
      { path: 'base.weights.pullback', label: 'Weight: pullback', min: 0, max: 100 },
      { path: 'base.weights.tightness', label: 'Weight: tightness', min: 0, max: 100 },
      { path: 'base.weights.aboveMa', label: 'Weight: vs MAs', min: 0, max: 100 },
      { path: 'base.weights.volDryup', label: 'Weight: volume dry-up', min: 0, max: 100 },
      { path: 'base.weights.maturity', label: 'Weight: time elapsed', min: 0, max: 100 },

      { path: 'base.pullback.runaway', label: 'Pullback: runaway above %', hint: 'also the Extended cutoff' },
      { path: 'base.pullback.hold', label: 'Pullback: still holding %' },
      { path: 'base.pullback.healthy', label: 'Pullback: healthy floor %' },
      { path: 'base.pullback.deep', label: 'Pullback: broken below %', hint: 'also the Broken cutoff' },

      { path: 'base.tightness.lookback', label: 'Tightness: sessions', min: 5, max: 60 },
      { path: 'base.tightness.tight', label: 'Tightness: tight under %', min: 1 },
      { path: 'base.tightness.ok', label: 'Tightness: ok under %', min: 1 },
      { path: 'base.tightness.loose', label: 'Tightness: loose under %', min: 1 },

      { path: 'base.volDryup.dry', label: 'Rel vol: dry under', step: 0.1, min: 0 },
      { path: 'base.volDryup.normal', label: 'Rel vol: normal under', step: 0.1, min: 0 },
      { path: 'base.volDryup.active', label: 'Rel vol: active under', step: 0.1, min: 0 },

      { path: 'base.maturity.min', label: 'Time: min sessions', min: 0, hint: 'below this = Too soon' },
      { path: 'base.maturity.peakEnd', label: 'Time: sweet spot ends', min: 1 },
      { path: 'base.maturity.decayEnd', label: 'Time: decays to', min: 1 },

      { path: 'base.status.building', label: 'Label: Base building ≥', min: 0, max: 100 },
      { path: 'base.status.watch', label: 'Label: Watch ≥', min: 0, max: 100 },
    ])}
  ${!rows.length ? `<p class="empty">Nothing basing yet — needs symbols whose last appearance was 3+ sessions ago.</p>` : `
  <div class="scroll"><table><thead><tr>
    <th class="sym">Symbol</th><th>Score</th><th class="sym">Status</th>
    <th>Sessions ago</th><th>From surge</th><th>Since 1st</th><th>Rel vol</th>
    <th class="sym">Pullback</th><th class="sym">vs MA</th><th class="sym">Vol dry</th><th class="sym">Tight</th>
    <th class="sym">Sector</th>
  </tr></thead><tbody>
  ${rows.map((s) => {
    const p = s.base.parts;
    return `<tr data-ticker="${esc(s.ticker)}">
      <td class="sym"><b>${esc(s.symbol)}</b><span class="desc">${esc(s.name)}</span></td>
      <td><b class="score">${s.base.score ?? '—'}</b></td>
      <td class="sym">${baseChip(s.base)}</td>
      <td>${s.sessions_since}</td>
      <td class="${cls(s.base.from_surge_pct)}">${pct(s.base.from_surge_pct)}</td>
      <td class="${cls(s.since_first_pct)}">${pct(s.since_first_pct)}</td>
      <td>${num(s.rel_vol_now)}</td>
      <td class="sym">${part(p.pullback)}</td>
      <td class="sym">${part(p.above_ma)}</td>
      <td class="sym">${part(p.vol_dryup)}</td>
      <td class="sym">${part(p.tightness)}</td>
      <td class="sym">${sectorChip(s.sector, s.sector_rank, s.sector_tier, s.sector_of)}</td>
    </tr>`;
  }).join('')}
  </tbody></table></div>`}`;
}

function renderGrid() {
  const pool = activeSymbols().slice(0, 30);
  const days = D.sessions.slice(-45);
  if (!pool.length) return '<p class="empty">No symbols match these filters.</p>';
  return `
  <p class="sub" style="margin:0 0 12px">Top ${pool.length} by heat, last ${days.length} sessions. Click a filled cell to open that session.</p>
  <div class="grid-wrap"><table class="hgrid"><thead><tr><th class="s"></th>
    ${days.map((d) => `<th class="d">${d.slice(5)}</th>`).join('')}
  </tr></thead><tbody>
  ${pool.map((s) => {
    const set = new Set(s.hits.map((h) => h.date));
    return `<tr><th class="s" data-ticker="${esc(s.ticker)}">${esc(s.symbol)}</th>
      ${days.map((d) => set.has(d)
        ? `<td><div class="cell on" data-session="${d}" title="${esc(s.symbol)} · ${d}"></div></td>`
        : `<td><div class="cell"></div></td>`).join('')}
    </tr>`;
  }).join('')}
  </tbody></table></div>`;
}

function renderSectors() {
  // The settings panel must render BEFORE any empty check -- otherwise a
  // parameter that empties this view also removes the control that fixes it.
  const panel = cfgPanel('Sector strength parameters',
    'Ranks are by appearance count in the window. Tiers set which sectors count as strong for the Focus rules.',
    [
      { path: 'sector.window', label: 'Window (sessions)', min: 5, max: 300 },
      { path: 'sector.hotRanks', label: 'Hot = top N ranks', min: 1, max: 20 },
      { path: 'sector.warmPct', label: 'Warm = top N%', min: 1, max: 100, hint: 'of all sectors present' },
    ]);

  if (!D.sectors.length) {
    return panel + `<p class="empty">
      No sector has any appearance inside a ${CFG.sector.window}-session window.
      ${CFG.sector.window > D.session_count
        ? `Only ${D.session_count} sessions have been recorded so far.`
        : 'Try widening the window above, or use Reset.'}
    </p>`;
  }
  const max = D.sectors[0].count;

  return `
  <p class="sub" style="margin:0 0 12px">Appearances by sector over the last ${CFG.sector.window} sessions. Click a row to expand its stocks.</p>
  ${panel}
  <div class="scroll"><table><thead><tr>
    <th class="sym">Sector</th><th>Rank</th><th>Appearances</th><th>Symbols</th><th class="sym" style="width:45%">Share</th>
  </tr></thead><tbody>
  ${D.sectors.map((sec) => {
    const open = S.expanded === sec.sector;
    const members = D.symbols
      .filter((s) => s.sector === sec.sector)
      .sort((a, b) => b.counts.all - a.counts.all);
    return `
    <tr class="secrow ${open ? 'open' : ''}" data-sector-expand="${esc(sec.sector)}">
      <td class="sym"><span class="caret">${open ? '▾' : '▸'}</span> <b>${esc(sec.sector)}</b>
        <span class="tier t-${sec.tier}">${sec.tier}</span></td>
      <td>#${sec.rank}</td><td><b>${sec.count}</b></td><td>${sec.symbols}</td>
      <td class="sym"><div class="barwrap"><div class="bar t-${sec.tier}" style="width:${(sec.count / max) * 100}%"></div></div></td>
    </tr>
    ${!open ? '' : `<tr class="subrow"><td colspan="5">
      <div class="subwrap">
        <div class="subhead">
          <b>${members.length} stocks in ${esc(sec.sector)}</b>
          <button class="linkbtn" data-filter="sector" data-value="${esc(sec.sector)}" data-goto="leaderboard">Filter everything to this sector →</button>
        </div>
        <table class="subtable"><thead><tr>
          <th class="sym">Symbol</th><th>Hits</th><th>Last seen</th><th>Since 1st</th><th class="sym">Base</th><th class="sym">Dates</th>
        </tr></thead><tbody>
        ${members.map((s) => `<tr data-ticker="${esc(s.ticker)}">
          <td class="sym"><b>${esc(s.symbol)}</b></td>
          <td><b>${s.counts.all}</b></td>
          <td>${s.last_seen}</td>
          <td class="${cls(s.since_first_pct)}">${pct(s.since_first_pct)}</td>
          <td class="sym">${baseChip(s.base)}</td>
          <td class="sym dates">${s.hits.slice(-8).map((h) => `<span class="dt">${h.date.slice(5)}</span>`).join('')}${s.hits.length > 8 ? ` <i>+${s.hits.length - 8} more</i>` : ''}</td>
        </tr>`).join('')}
        </tbody></table>
      </div>
    </td></tr>`}`;
  }).join('')}
  </tbody></table></div>`;
}

// ---------- detail drawer ----------------------------------------------

function openDrawer(ticker) {
  const s = D.symbols.find((x) => x.ticker === ticker);
  if (!s) return;
  const set = new Set(s.hits.map((h) => h.date));
  const b = s.base;
  const partRow = (label, v, note) => `<tr><td class="sym">${label}</td>
    <td class="sym">${v == null ? '<i class="na">not enough data</i>' : `<i class="pb" style="--w:${Math.round(v * 100)}%"></i>`}</td>
    <td class="sym muted">${note}</td></tr>`;

  $('#drawer-body').innerHTML = `
    <h2>${esc(s.symbol)} ${badges(s)}</h2>
    <p class="sub">${esc(s.name || '')} · ${sectorChip(s.sector, s.sector_rank, s.sector_tier, s.sector_of)}</p>
    <div class="cards">
      <div class="card"><div class="k">Appearances</div><div class="v">${s.counts.all}<span class="hint">of ${D.session_count}</span></div></div>
      <div class="card"><div class="k">Since 1st appearance</div><div class="v ${cls(s.since_first_pct)}">${pct(s.since_first_pct)}</div></div>
      <div class="card"><div class="k">Since last</div><div class="v ${cls(s.since_last_pct)}">${pct(s.since_last_pct)}</div></div>
      <div class="card"><div class="k">Sessions ago</div><div class="v">${s.sessions_since}</div></div>
      <div class="card"><div class="k">Best streak</div>
        <div class="v">${s.longest_streak}${s.longest_suspect
          ? '<span class="warn" title="This run spans a weekday with no recorded snapshot, so it may not be truly consecutive.">⚠</span>' : ''}</div></div>
    </div>

    ${!b ? '' : `
    <h3>Base analysis ${baseChip(b)}</h3>
    <p class="sub">Score <b>${b.score ?? '—'}</b>/100 · ${b.from_surge_pct == null ? '' : `${pct(b.from_surge_pct)} from its best surge close of ${num(b.surge_close)}`}
      ${b.tightness_pct == null ? '' : ` · 10-session range ${num(b.tightness_pct)}%`}</p>
    <table class="parts"><tbody>
      ${partRow('Pullback depth', b.parts.pullback, 'shallow pullback scores high; a runaway or a break scores low')}
      ${partRow('Above moving avgs', b.parts.above_ma, 'above SMA20 best, above SMA50 partial')}
      ${partRow('Volume dry-up', b.parts.vol_dryup, 'quiet volume separates a base from distribution')}
      ${partRow('Range tightness', b.parts.tightness, 'needs 5+ tracking days to compute')}
      ${partRow('Time elapsed', b.parts.maturity, '3–30 sessions is the sweet spot')}
    </tbody></table>`}

    <h3>Every tracked session</h3>
    <p class="sub">Oldest first — filled where it appeared.</p>
    <div class="timeline">${D.sessions.map((d) =>
      `<div class="tick ${set.has(d) ? 'on' : ''}" data-session="${d}" title="${d}"></div>`).join('')}</div>
    <div class="scroll"><table><thead><tr>
      <th class="sym">Date</th><th>Rank</th><th>Close</th><th>Chg %</th><th>Rel vol</th><th>Volume</th>
    </tr></thead><tbody>
    ${s.hits.slice().reverse().map((h) => `<tr>
      <td class="sym">${h.date}</td><td>${h.rank}</td><td>${num(h.close)}</td>
      <td class="${cls(h.change_pct)}">${pct(h.change_pct)}</td>
      <td>${num(h.rel_vol)}</td><td>${vol(h.volume)}</td>
    </tr>`).join('')}
    </tbody></table></div>`;

  $('#drawer').hidden = false;
}

// ---------- wiring ------------------------------------------------------

const VIEWS = {
  focus: renderFocus,
  session: renderSession, leaderboard: renderLeaderboard,
  bases: renderBases, grid: renderGrid, sectors: renderSectors,
};

// ---------- URL state, so Back/Forward and refresh all behave -----------

function encodeState() {
  const p = new URLSearchParams();
  if (S.view !== 'focus') p.set('v', S.view);
  if (S.session && S.session !== D.latest_session) p.set('d', S.session);
  if (S.sub) p.set('sub', S.sub);
  if (S.win !== 'all') p.set('w', S.win);
  if (S.query) p.set('q', S.query);
  if (S.expanded) p.set('x', S.expanded);
  for (const k of ['sector', 'base', 'flag', 'session']) {
    if (S.filters[k]) p.set(`f.${k}`, S.filters[k]);
  }
  return p.toString();
}

function decodeState(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  S.view = VIEWS[p.get('v')] ? p.get('v') : 'focus';
  S.session = p.get('d') || D.latest_session;
  S.sub = p.get('sub') || null;
  S.win = p.get('w') || 'all';
  S.query = p.get('q') || '';
  S.expanded = p.get('x') || null;
  S.filters = {};
  for (const k of ['sector', 'base', 'flag', 'session']) {
    const v = p.get(`f.${k}`);
    if (v) S.filters[k] = v;
  }
}

/** Commit a state change. push=false for incidental edits (sort, typing). */
function commit(push = true) {
  const url = `${location.pathname}#${encodeState()}`;
  if (push) {
    S.depth++;
    history.pushState({ depth: S.depth }, '', url);
  } else {
    history.replaceState({ depth: S.depth }, '', url);
  }
  render();
}

window.addEventListener('popstate', (e) => {
  S.depth = (e.state && e.state.depth) || 0;
  decodeState(location.hash);
  $('#drawer').hidden = true;
  render();
});

function render() {
  document.querySelectorAll('#tabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === S.view));
  renderFilterBar();
  renderCfgState();
  app.innerHTML = VIEWS[S.view]();

  const w = $('#win');
  if (w) w.onchange = (e) => { S.win = e.target.value; commit(false); };

  const sp = $('#sessionPick');
  if (sp) sp.onchange = (e) => { S.session = e.target.value; commit(); };

  const q = $('#q');
  if (q) q.oninput = (e) => {
    S.query = e.target.value.toLowerCase();
    commit(false);
    const n = $('#q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length);
  };
}

/** Re-derive every metric from the raw data under the current settings. */
function applyCfg() {
  Metrics.recompute(D, CFG);
}

/**
 * A permanent escape hatch. It lives in the header, outside every view, so it
 * stays reachable even if a parameter empties the screen you are on.
 */
function renderCfgState() {
  const el = $('#cfgstate');
  const custom = JSON.stringify(CFG) !== JSON.stringify(Metrics.DEFAULTS);
  if (!custom) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span class="cfgdot"></span>Custom settings
    <button data-cfg-reset-all>Reset all to defaults</button>`;
}

// Editing a parameter recomputes everything and re-renders in place.
//
// Two rules make typing behave. First, NEVER clamp while typing: on the way to
// "30" the value passes through "3", and clamping that to a minimum of 5 makes
// a multi-digit number impossible to enter. Clamping happens on commit instead.
// Second, debounce, so the re-render lands after a pause rather than between
// keystrokes -- re-rendering replaces the input node, and doing that mid-word
// fights the caret.
let cfgTimer = null;

document.addEventListener('input', (ev) => {
  const el = ev.target.closest('[data-cfg]');
  if (!el) return;
  if (el.value === '' || el.value === '-') return;        // mid-edit
  const v = Number(el.value);
  if (Number.isNaN(v)) return;

  const path = el.dataset.cfg;
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => {
    setPath(CFG, path, v);
    saveCfg();
    applyCfg();
    render();
    const again = document.querySelector(`[data-cfg="${path}"]`);
    if (again) again.focus();                             // caret lands at the end
  }, 350);
});

// Commit: clamp to the declared range on blur or Enter, never before.
document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-cfg]');
  if (!el) return;
  clearTimeout(cfgTimer);

  const path = el.dataset.cfg;
  const lo = el.hasAttribute('min') ? Number(el.min) : -Infinity;
  const hi = el.hasAttribute('max') ? Number(el.max) : Infinity;
  let v = Number(el.value);
  if (el.value === '' || Number.isNaN(v)) v = getPath(Metrics.DEFAULTS, path);
  v = Math.min(hi, Math.max(lo, v));

  setPath(CFG, path, v);
  saveCfg();
  applyCfg();
  render();
});

// Remember which panel is open so a re-render doesn't collapse it.
document.addEventListener('toggle', (ev) => {
  const d = ev.target.closest('[data-cfg-panel]');
  if (!d) return;
  S.cfgOpen = d.open ? d.dataset.cfgPanel : null;
}, true);

// One delegated handler for every interactive element.
document.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-back]')) return history.back();

  if (ev.target.closest("[data-cfg-reset-all]")) {
    CFG = Metrics.withDefaults({});
    saveCfg();
    applyCfg();
    return render();
  }

  const reset = ev.target.closest("[data-cfg-reset]:not([data-cfg-reset-all])");
  if (reset) {
    for (const p of reset.dataset.cfgReset.split(',')) {
      setPath(CFG, p, getPath(Metrics.DEFAULTS, p));
    }
    saveCfg();
    applyCfg();
    return render();
  }

  const un = ev.target.closest('[data-unfilter]');
  if (un) {
    const k = un.dataset.unfilter;
    if (k === 'all') { S.filters = {}; S.query = ''; S.sub = null; }
    else if (k === 'query') S.query = '';
    else if (k === 'sub') S.sub = null;
    else delete S.filters[k];
    return commit();
  }

  // KPI cards filter the table in place -- they never switch tabs.
  const sub = ev.target.closest('[data-sub]');
  if (sub) {
    const v = sub.dataset.sub || null;
    S.sub = S.sub === v ? null : v;
    return commit();
  }

  const dm = ev.target.closest('[data-dismiss]');
  if (dm) {
    ev.stopPropagation();
    dismissed[dm.dataset.dismiss] = { sig: dm.dataset.sig, at: new Date().toISOString() };
    saveDismissed();
    return render();
  }
  const rs = ev.target.closest('[data-restore]');
  if (rs) {
    ev.stopPropagation();
    delete dismissed[rs.dataset.restore];
    saveDismissed();
    return render();
  }

  const sortTh = ev.target.closest('th[data-k]');
  if (sortTh) {
    const k = sortTh.dataset.k;
    S.sortDir = S.sortKey === k ? -S.sortDir : -1;
    S.sortKey = k;
    return commit(false);
  }

  const expand = ev.target.closest('[data-sector-expand]');
  if (expand && !ev.target.closest('[data-filter]') && !ev.target.closest('[data-ticker]')) {
    const sec = expand.dataset.sectorExpand;
    S.expanded = S.expanded === sec ? null : sec;
    return commit(false);
  }

  const cell = ev.target.closest('[data-session]');
  if (cell) {
    S.session = cell.dataset.session;
    S.view = 'session';
    S.sub = null;
    $('#drawer').hidden = true;
    return commit();
  }

  const filt = ev.target.closest('[data-filter]');
  if (filt) {
    ev.stopPropagation();
    S.filters[filt.dataset.filter] = filt.dataset.value;
    if (filt.dataset.setSession) S.filters.session = filt.dataset.setSession;
    if (filt.dataset.goto) S.view = filt.dataset.goto;
    $('#drawer').hidden = true;
    return commit();
  }

  const goto = ev.target.closest('[data-goto]');
  if (goto) {
    if (goto.dataset.setSession) S.filters.session = goto.dataset.setSession;
    S.view = goto.dataset.goto;
    return commit();
  }

  const row = ev.target.closest('[data-ticker]');
  if (row) return openDrawer(row.dataset.ticker);
});

document.querySelectorAll('#tabs button').forEach((b) => {
  b.onclick = () => { S.view = b.dataset.view; commit(); };
});
$('#drawer-close').onclick = () => { $('#drawer').hidden = true; };
$('#drawer').onclick = (e) => { if (e.target.id === 'drawer') $('#drawer').hidden = true; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#drawer').hidden = true; });

fetch('dashboard.json?' + Date.now())
  .then((r) => r.json())
  .then((d) => {
    D = d;
    S.session = d.latest_session;
    $('#screener-name').textContent = (d.screener && d.screener.name) || 'Screener Tracker';
    const src = d.screener && d.screener.sourceUrl;
    $('#meta').innerHTML =
      `${d.session_count} sessions · ${d.symbols.length} symbols · ${d.tracking_sessions} price-tracking days · latest ${d.latest_session || '—'}`
      + (src ? ` · <a href="${src}" target="_blank" rel="noopener">source</a>` : '');

    // The published demo lives at /demo/ and reuses these same assets with its
    // own frozen dataset, so the two pages never drift apart visually.
    const isDemo = location.pathname.replace(/\/+$/, '').endsWith('/demo');
    $('#meta').innerHTML += isDemo
      ? ' · <a href="../">← live dashboard</a>'
      : ' · <a href="demo/">demo with full history →</a>';

    if (d.demo_sessions > 0) {
      const b = $('#banner');
      b.innerHTML = isDemo
        ? `<span>⚠</span><span><b>Demo data — not real screener history.</b>`
          + ` ${d.demo_sessions} synthetic sessions, generated once so the dashboard can be`
          + ` explored with a full dataset. Prices are anchored to real quotes but the`
          + ` history is fabricated. <a href="../">The live dashboard is here</a>.</span>`
        : `<span>⚠</span><span><b>${d.demo_sessions} of ${d.session_count} sessions are synthetic demo data</b>`
          + ` — for layout review only. ${d.real_sessions} real capture${d.real_sessions === 1 ? '' : 's'}.`
          + ` Remove with <code>npm run demo:clear</code>.</span>`;
      b.hidden = false;
    }

    CFG = loadCfg();
    dismissed = loadDismissed();
    applyCfg();
    decodeState(location.hash);              // restore a bookmarked/refreshed state
    history.replaceState({ depth: 0 }, '', `${location.pathname}#${encodeState()}`);
    render();
  })
  .catch(() => {
    app.innerHTML = '<p class="empty">No data yet — run <code>npm run capture</code>.</p>';
  });
