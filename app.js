// ==================== Constants ====================
const EPOCH_MS = Date.UTC(2022, 0, 1);
const QUARTER_MS = 91.3125 * 86400000;

const COMPANY_META = {
  MU:   { name: 'Micron Technology', role: 'High-bandwidth memory (HBM) manufacturer', colorVar: '--c-mu',   primary: 'revenue', secondary: null },
  NVDA: { name: 'Nvidia',            role: 'GPU / AI accelerator manufacturer',        colorVar: '--c-nvda', primary: 'revenue', secondary: null },
  GOOG: { name: 'Alphabet',          role: 'AI cloud services (Google Cloud)',         colorVar: '--c-goog', primary: 'cloud_revenue', primaryLabel: 'Google Cloud revenue', secondary: null },
  ETN:  { name: 'Eaton',             role: 'Electrical distribution component manufacturer', colorVar: '--c-etn', primary: 'revenue', secondary: { field: 'ea_orders_growth_yoy', label: 'Electrical Americas orders (YoY)', isRate: true } },
  GEV:  { name: 'GE Vernova',        role: 'Grid & power components manufacturer',     colorVar: '--c-gev', primary: 'total_orders', primaryLabel: 'Total orders', secondary: null },
};

const ORDER = ['MU', 'NVDA', 'GOOG', 'ETN', 'GEV'];

let DATA = null;
let ACTIVE_MODEL = 's_curve';
let LAST_REFRESHED = null; // ISO string, set on boot from data + updated on manual refresh
const CHART_REGISTRY = {}; // canvasId -> {create: fn}
const CHART_INSTANCES = {}; // canvasId -> Chart instance

// Destroys any chart bound to this canvas id, however it got there (our own
// bookkeeping in CHART_INSTANCES, or a stray instance Chart.js still tracks
// internally). Always safe to call even if nothing is currently bound.
// This is the key guard that prevents Chart.js's "Canvas is already in use"
// exception, which previously aborted the model-toggle handler partway
// through and left some charts stuck showing the old model.
function destroyChart(id) {
  const tracked = CHART_INSTANCES[id];
  if (tracked) {
    try { tracked.destroy(); } catch (e) { /* already destroyed */ }
    delete CHART_INSTANCES[id];
  }
  if (typeof Chart !== 'undefined' && typeof Chart.getChart === 'function') {
    const stray = Chart.getChart(id);
    if (stray) { try { stray.destroy(); } catch (e) { /* noop */ } }
  }
}
function destroyAllCharts() {
  Object.keys(CHART_INSTANCES).forEach((id) => destroyChart(id));
}

// ==================== Utilities ====================
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function hsl(varName, alpha) {
  const v = cssVar(varName);
  return alpha != null ? `hsl(${v} / ${alpha})` : `hsl(${v})`;
}
function toT(dateStr) {
  const ms = Date.parse(dateStr + 'T00:00:00Z');
  return (ms - EPOCH_MS) / QUARTER_MS;
}
function tToMs(t) {
  return EPOCH_MS + t * QUARTER_MS;
}
function tToDateStr(t) {
  const ms = tToMs(t);
  return new Date(ms).toISOString().slice(0, 10);
}
function dateMs(dateStr) {
  return Date.parse(dateStr + 'T00:00:00Z');
}
function fmtUSD(v) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  return v.toLocaleString();
}
function fmtUSDFull(v) {
  if (v == null || isNaN(v)) return '—';
  return '$' + fmtUSD(v);
}
function fmtPct(v, decimals = 1) {
  if (v == null || isNaN(v)) return '—';
  const s = v.toFixed(decimals);
  return (v > 0 ? '+' : '') + s + '%';
}
function fmtDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} '${String(d.getUTCFullYear()).slice(2)}`;
}
function fmtDateLong(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${d.getUTCFullYear()}`;
}
function qualityLabel(q) {
  if (q === 'good') return 'Good fit';
  if (q === 'fair') return 'Fair fit';
  if (q === 'weak') return 'Weak fit';
  return 'Fit n/a';
}
function tickDateFormatter(ms) {
  const d = new Date(ms);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} '${String(d.getUTCFullYear()).slice(2)}`;
}

// ==================== Bootstrap ====================
// Resolves to the deployed backend proxy path in production, or localhost
// while testing locally. deploy_website rewrites the port/8000 token at
// deploy time — see shared/19-backend.md.
const API_BASE = 'port/8000'.startsWith('__') ? 'http://localhost:8000' : 'port/8000';

async function boot() {
  const res = await fetch('data.json');
  DATA = await res.json();
  LAST_REFRESHED = DATA.meta.last_refreshed || null;

  initTheme();
  wireModelToggle();
  wireRefreshButton();
  renderKPIRow();
  renderOverviewNarrative();
  renderTimelineChart();
  renderCompanySections();
  renderSources();
  renderFooterMeta();
  renderFreshnessNote();
}
document.addEventListener('DOMContentLoaded', boot);

// ==================== Data refresh ====================
function formatTimestamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function renderFreshnessNote() {
  const metaEl = document.getElementById('refresh-meta');
  const noteEl = document.getElementById('data-freshness-note');
  const formatted = formatTimestamp(LAST_REFRESHED);
  metaEl.textContent = formatted ? `Last refreshed ${formatted}` : `Data compiled ${DATA.meta.generated} · not yet refreshed`;
  metaEl.classList.remove('is-error', 'is-success');

  const asOf = DATA.meta.orders_backlog_manual_asof || DATA.meta.generated;
  noteEl.innerHTML = `<span class="flag-dot"></span><span>Revenue auto-checks against SEC EDGAR on refresh. Orders, backlog, and Cloud RPO figures are <strong>manually verified as of ${asOf}</strong> and are not part of the automatic refresh.</span>`;
}

function wireRefreshButton() {
  const btn = document.getElementById('refresh-data-btn');
  const metaEl = document.getElementById('refresh-meta');
  const label = btn.querySelector('span:last-child');

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-loading');
    metaEl.classList.remove('is-error', 'is-success');
    metaEl.textContent = 'Checking SEC EDGAR for new quarterly data…';
    const originalLabel = label.textContent;
    label.textContent = 'Checking…';

    try {
      const res = await fetch(`${API_BASE}/api/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Refresh failed (HTTP ${res.status})`);
      }
      const result = await res.json();
      DATA = result.data;
      LAST_REFRESHED = result.lastRefreshed;
      ACTIVE_MODEL = document.querySelector('.model-btn.active')?.dataset.model || ACTIVE_MODEL;

      rerenderDashboard();
      renderSources();
      renderFooterMeta();
      renderFreshnessNote();

      if (result.updated && result.newQuarters.length) {
        const names = result.newQuarters.map((q) => `${q.ticker} ${q.period}`).join(', ');
        metaEl.textContent = `Updated — added ${names}`;
        metaEl.classList.add('is-success');
      } else {
        const formatted = formatTimestamp(LAST_REFRESHED);
        metaEl.textContent = `No new quarterly revenue yet · checked ${formatted}`;
      }
      if (result.errors && result.errors.length) {
        console.warn('Refresh completed with per-ticker errors:', result.errors);
      }
    } catch (err) {
      console.error('Refresh failed:', err);
      metaEl.textContent = `Refresh failed: ${err.message}`;
      metaEl.classList.add('is-error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      label.textContent = originalLabel;
    }
  });
}

// ==================== Theme ====================
function initTheme() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'dark'); // default dark for monitoring aesthetic
  const btn = document.getElementById('theme-toggle');
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    btn.setAttribute('aria-label', next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    rerenderAllCharts();
  });
}

// ==================== Model toggle ====================
function wireModelToggle() {
  document.querySelectorAll('.model-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return; // no-op if already selected
      document.querySelectorAll('.model-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ACTIVE_MODEL = btn.dataset.model;
      rerenderDashboard();
    });
  });
}

// Full re-render used whenever the underlying model or dataset changes
// (model toggle, data refresh). Rebuilds company sections from scratch
// (fresh canvases, so no "already in use" collisions) and refreshes every
// panel so notes/badges/diagnostics stay in sync with ACTIVE_MODEL — not
// just the chart overlays.
function rerenderDashboard() {
  destroyAllCharts();
  renderKPIRow();
  renderOverviewNarrative();
  renderTimelineChart();
  renderCompanySections();
}

// Used only for theme toggle: colors baked into existing charts need a
// fresh read of the CSS variables, but the underlying model/data/notes are
// unchanged so a full dashboard rebuild isn't necessary. Guards each
// recreation individually so one failure can't block the rest.
function rerenderAllCharts() {
  Object.entries(CHART_REGISTRY).forEach(([id, entry]) => {
    try {
      destroyChart(id);
      entry.create();
    } catch (err) {
      console.error('Chart re-render failed for', id, err);
    }
  });
}

// ==================== Peak resolution helper ====================
function resolvePeak(series) {
  // Returns {hasPeak, dateStr, label, quality, statusNote}
  if (ACTIVE_MODEL === 's_curve') {
    const sc = series.model.s_curve;
    if (!sc || sc.status === 'no_fit') return { hasPeak: false, statusNote: 'No stable S-curve fit' };
    return {
      hasPeak: true,
      dateStr: sc.peak_date,
      quality: sc.quality || 'unknown',
      r2: sc.r2 ?? sc.r2_flow,
      confidence: sc.confidence,
      modelVsActual: sc.model_vs_actual_latest_pct,
    };
  } else {
    const lr = series.model.local_regression;
    if (!lr || lr.status !== 'peak_forecast') {
      return { hasPeak: false, statusNote: 'Still accelerating — no local peak in trailing 8 quarters' };
    }
    return { hasPeak: true, dateStr: lr.vertex_t != null ? tToDateStr(lr.vertex_t) : null };
  }
}

// ==================== KPI Row ====================
function renderKPIRow() {
  const row = document.getElementById('kpi-row');
  row.innerHTML = '';
  ORDER.forEach((tkr) => {
    const meta = COMPANY_META[tkr];
    const comp = DATA.companies[tkr];
    const revSeries = comp.series.revenue;
    const lastIdx = revSeries.values.length - 1;
    const latestVal = revSeries.values[lastIdx];
    const latestYoy = revSeries.yoy_pct[lastIdx];
    const period = revSeries.periods[lastIdx];
    const peak = resolvePeak(revSeries);

    let secondaryHtml = '';
    if (meta.secondary) {
      const s = comp.series[meta.secondary.field];
      const idx = s.values.length - 1;
      const v = s.values[idx];
      const disp = meta.secondary.isRate ? fmtPct(v, 0) : fmtUSDFull(v);
      secondaryHtml = `<div class="kpi-value-label">${meta.secondary.label}: <b class="num">${disp}</b></div>`;
    }

    const yoyClass = latestYoy == null ? '' : latestYoy >= 0 ? 'pos' : 'neg';
    const peakHtml = peak.hasPeak
      ? `Peak (${ACTIVE_MODEL === 's_curve' ? 'S-curve' : 'local reg.'}): <b>${fmtDateLong(peak.dateStr)}</b> ${peak.quality ? `<span class="badge ${peak.quality}">${qualityLabel(peak.quality)}</span>` : ''}`
      : `<span class="badge low">${peak.statusNote || 'No peak'}</span>`;

    const card = document.createElement('div');
    card.className = 'kpi-card';
    card.style.setProperty('--kpi-color', `var(${meta.colorVar})`);
    card.dataset.testid = `card-kpi-${tkr}`;
    card.innerHTML = `
      <div class="kpi-ticker-row">
        <span class="kpi-ticker">${tkr}</span>
        <span class="kpi-role">${meta.name}</span>
      </div>
      <div class="kpi-value num" data-testid="text-kpi-value-${tkr}">${fmtUSDFull(latestVal)}</div>
      <div class="kpi-value-label">Revenue · ${period}</div>
      <span class="kpi-growth ${yoyClass} num">${fmtPct(latestYoy)} YoY</span>
      ${secondaryHtml}
      <div class="kpi-peak">${peakHtml}</div>
    `;
    row.appendChild(card);
  });
}

// ==================== Overview narrative ====================
function renderOverviewNarrative() {
  const el = document.getElementById('overview-narrative');
  const flowFields = [
    ['MU', 'revenue'], ['NVDA', 'revenue'], ['GOOG', 'revenue'], ['GOOG', 'cloud_revenue'],
    ['ETN', 'revenue'], ['GEV', 'revenue'], ['GEV', 'total_orders'],
  ];
  const divergences = [];
  let localPeaksFound = 0;
  flowFields.forEach(([tkr, field]) => {
    const s = DATA.companies[tkr].series[field];
    const sc = s.model.s_curve;
    if (sc && sc.model_vs_actual_latest_pct != null && sc.quality !== 'weak') {
      divergences.push(sc.model_vs_actual_latest_pct);
    }
    const lr = s.model.local_regression;
    if (lr && lr.status === 'peak_forecast') localPeaksFound++;
  });
  const avgDiv = divergences.length ? divergences.reduce((a, b) => a + b, 0) / divergences.length : null;

  let text;
  if (ACTIVE_MODEL === 's_curve') {
    text = `Across the metrics where the S-curve fit is reliable, the <strong>latest reported quarter is running ${avgDiv != null ? fmtPct(avgDiv, 0) : 'well'} above</strong> what a smooth logistic growth curve would predict. That is the more informative "bubble" signal than any single peak date: it shows real demand is still compounding faster than a saturating trend, not slower. Individual S-curve peak dates below should be read as where growth would level off <em>if</em> the current pace decelerates smoothly — most cluster in 2025–2026 for revenue/orders, and much further out for backlog/RPO stocks, which are still in their early build phase.`;
  } else {
    text = `Switching to local regression — a short-window, recency-weighted quadratic fit on just the trailing 8 quarters — <strong>${localPeaksFound === 0 ? 'no company shows a local peak yet' : `${localPeaksFound} of ${flowFields.length} tracked metrics show a local peak`}</strong>. Every one of the five companies' orders and revenue trends is still accelerating (convex, not concave) in its most recent two years of data. That is a meaningfully different — and more real-time — read than the S-curve view: it says the deceleration implied by some long-horizon logistic fits has not shown up in the actual numbers yet.`;
  }
  el.innerHTML = text;
}

// ==================== Timeline chart ====================
function renderTimelineChart() {
  const canvas = document.getElementById('chart-timeline');
  const wrap = canvas.parentElement;
  const key = 'chart-timeline';
  // Always tear down any existing chart bound to this canvas first — this
  // canvas is a persistent DOM node (not rebuilt per render like company
  // charts), so without this guard, switching models back and forth throws
  // "Canvas is already in use" and silently aborts the rest of the re-render.
  destroyChart(key);
  delete CHART_REGISTRY[key];
  // remove any prior empty-state message
  const prevMsg = wrap.querySelector('.empty-state');
  if (prevMsg) prevMsg.remove();
  canvas.style.display = '';

  // Always plot the 'revenue' series here so the timeline stays consistent with the
  // revenue-based headline value and peak shown on each KPI card above (apples-to-apples).
  // Segment-specific peaks (cloud revenue, backlog, orders) are shown in each company's
  // own detail section further down, clearly labeled per chart.
  const points = [];
  ORDER.forEach((tkr) => {
    const meta = COMPANY_META[tkr];
    const s = DATA.companies[tkr].series.revenue;
    const peak = resolvePeak(s);
    if (peak.hasPeak && peak.dateStr) {
      points.push({ x: dateMs(peak.dateStr), y: tkr, color: hsl(meta.colorVar), quality: peak.quality, label: 'Revenue' });
    }
  });

  if (!points.length) {
    canvas.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = 'No local-regression peaks yet — every tracked series is still accelerating over its trailing 8 quarters, so there is nothing to plot on this timeline under this model.';
    div.dataset.testid = 'text-timeline-empty';
    wrap.appendChild(div);
    return; // deliberately leave CHART_REGISTRY[key] unset — nothing to recreate while hidden
  }

  const todayMs = Date.now();
  CHART_REGISTRY[key] = {
    create: () => {
      const ctx = canvas.getContext('2d');
      CHART_INSTANCES[key] = new Chart(ctx, {
        type: 'scatter',
        data: {
          datasets: [{
            data: points,
            backgroundColor: points.map((p) => p.color),
            borderColor: points.map((p) => p.color),
            pointRadius: 8,
            pointHoverRadius: 10,
          }],
        },
        options: {
          maintainAspectRatio: false,
          layout: { padding: { left: 8, right: 8 } },
          scales: {
            x: {
              type: 'linear',
              ticks: { color: hsl('--text-faint'), callback: tickDateFormatter, font: { family: getMonoFont(), size: 10 } },
              grid: { color: hsl('--border-soft') },
            },
            y: {
              type: 'category',
              labels: ORDER,
              ticks: { color: hsl('--text-muted'), font: { family: getMonoFont(), size: 11, weight: '600' } },
              grid: { color: hsl('--border-soft') },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (c) => `${c.raw.y} — ${c.raw.label} peak: ${new Date(c.raw.x).toISOString().slice(0, 10)}`,
              },
            },
            annotation: {
              annotations: {
                today: {
                  type: 'line',
                  xMin: todayMs, xMax: todayMs,
                  borderColor: hsl('--text-faint'),
                  borderWidth: 1,
                  borderDash: [4, 4],
                  label: { display: true, content: 'Today', position: 'end', color: hsl('--text-faint'), font: { size: 10 } },
                },
              },
            },
          },
        },
      });
    },
  };
  CHART_REGISTRY[key].create();
}
function getMonoFont() { return "'JetBrains Mono', monospace"; }
function getDisplayFont() { return "'General Sans', 'Inter', sans-serif"; }

// ==================== Company sections ====================
function renderCompanySections() {
  const container = document.getElementById('company-sections');
  container.innerHTML = '';
  ORDER.forEach((tkr) => container.appendChild(buildCompanySection(tkr)));
}

function buildCompanySection(tkr) {
  const meta = COMPANY_META[tkr];
  const comp = DATA.companies[tkr];
  const section = document.createElement('section');
  section.className = 'company-section';
  section.id = `co-${tkr}`;
  section.dataset.testid = `section-company-${tkr}`;

  const primarySeries = comp.series[meta.primary];
  const peak = resolvePeak(primarySeries);
  const sc = primarySeries.model.s_curve;

  const diagLines = [];
  if (ACTIVE_MODEL === 's_curve' && sc && sc.status !== 'no_fit') {
    diagLines.push(`<div class="diag-line">S-curve fit quality: <span class="badge ${sc.quality}">${qualityLabel(sc.quality)}</span></div>`);
    if (sc.model_vs_actual_latest_pct != null) {
      diagLines.push(`<div class="diag-line">Latest quarter vs. model: <b>${fmtPct(sc.model_vs_actual_latest_pct, 0)}</b></div>`);
    }
    if (sc.confidence === 'low') {
      diagLines.push(`<div class="diag-line"><span class="badge low">Low confidence — ${sc.n_points} data points</span></div>`);
    }
  } else if (ACTIVE_MODEL === 'local_regression') {
    diagLines.push(`<div class="diag-line">${peak.hasPeak ? `Local peak: <b>${fmtDateLong(peak.dateStr)}</b>` : 'Still accelerating — no local peak'}</div>`);
  }

  // chart cards depend on company
  const chartCards = getChartConfigsForCompany(tkr);
  const chartGridHtml = chartCards.map((c) => `
    <div class="chart-card">
      <div class="chart-card-head">
        <span class="chart-card-title">${c.title}</span>
        <span class="chart-card-note">${c.note || ''}</span>
      </div>
      <div class="chart-wrap"><canvas id="${c.id}" data-testid="chart-${c.id}"></canvas></div>
    </div>
  `).join('');

  section.innerHTML = `
    <div class="company-header">
      <div class="company-heading">
        <span class="company-swatch" style="background: var(${meta.colorVar})"></span>
        <div>
          <h3 class="company-title">${tkr} — ${meta.name}</h3>
          <p class="company-role">${meta.role}</p>
        </div>
      </div>
      <div class="company-diag" data-testid="text-diagnostics-${tkr}">${diagLines.join('')}</div>
    </div>
    <div class="chart-grid">${chartGridHtml}</div>
    ${buildDetailTable(tkr, comp)}
  `;

  // register + create charts after DOM insertion (deferred)
  queueMicrotask(() => {
    chartCards.forEach((c) => {
      CHART_REGISTRY[c.id] = { create: c.render };
      c.render();
    });
  });

  return section;
}

function getChartConfigsForCompany(tkr) {
  const comp = DATA.companies[tkr];
  const meta = COMPANY_META[tkr];
  const cfgs = [];

  if (tkr === 'MU' || tkr === 'NVDA') {
    cfgs.push({
      id: `chart-${tkr}-revenue`, title: 'Quarterly revenue',
      note: fitNoteFor(comp.series.revenue),
      render: () => renderFlowStockChart(`chart-${tkr}-revenue`, comp.series.revenue, meta.colorVar, '$'),
    });
    cfgs.push({
      id: `chart-${tkr}-growth`, title: 'YoY growth & acceleration', note: '',
      render: () => renderGrowthPanel(`chart-${tkr}-growth`, comp.series.revenue, meta.colorVar),
    });
  }

  if (tkr === 'GOOG') {
    cfgs.push({
      id: 'chart-GOOG-revenue', title: 'Total revenue', note: fitNoteFor(comp.series.revenue),
      render: () => renderFlowStockChart('chart-GOOG-revenue', comp.series.revenue, meta.colorVar, '$'),
    });
    cfgs.push({
      id: 'chart-GOOG-cloud', title: 'Google Cloud revenue', note: fitNoteFor(comp.series.cloud_revenue),
      render: () => renderFlowStockChart('chart-GOOG-cloud', comp.series.cloud_revenue, meta.colorVar, '$'),
    });
    cfgs.push({
      id: 'chart-GOOG-backlog', title: 'Backlog / RPO (stock)', note: fitNoteFor(comp.series.backlog_rpo),
      render: () => renderFlowStockChart('chart-GOOG-backlog', comp.series.backlog_rpo, meta.colorVar, '$'),
    });
    cfgs.push({
      id: 'chart-GOOG-growth', title: 'Cloud &amp; backlog YoY growth', note: '',
      render: () => renderGrowthPanel('chart-GOOG-growth', comp.series.cloud_revenue, meta.colorVar, comp.series.backlog_rpo, '--text-muted'),
    });
  }

  if (tkr === 'ETN') {
    cfgs.push({
      id: 'chart-ETN-revenue', title: 'Total revenue', note: fitNoteFor(comp.series.revenue),
      render: () => renderFlowStockChart('chart-ETN-revenue', comp.series.revenue, meta.colorVar, '$'),
    });
    cfgs.push({
      id: 'chart-ETN-orders', title: 'Segment orders growth (YoY, rolling 12mo)', note: 'Eaton discloses orders only as % growth, not $',
      render: () => renderRateChart('chart-ETN-orders', comp.series.ea_orders_growth_yoy, comp.series.eg_orders_growth_yoy, 'Electrical Americas', 'Electrical Global'),
    });
    cfgs.push({
      id: 'chart-ETN-backlog', title: 'Total backlog ($, sparse disclosure)', note: fitNoteFor(comp.series.total_backlog_usd),
      render: () => renderFlowStockChart('chart-ETN-backlog', comp.series.total_backlog_usd, meta.colorVar, '$', true),
    });
  }

  if (tkr === 'GEV') {
    cfgs.push({
      id: 'chart-GEV-revenue', title: 'Total revenue', note: fitNoteFor(comp.series.revenue),
      render: () => renderFlowStockChart('chart-GEV-revenue', comp.series.revenue, meta.colorVar, '$'),
    });
    cfgs.push({
      id: 'chart-GEV-orders', title: 'Total orders', note: fitNoteFor(comp.series.total_orders),
      render: () => renderFlowStockChart('chart-GEV-orders', comp.series.total_orders, meta.colorVar, '$'),
    });
    cfgs.push({
      id: 'chart-GEV-rpo', title: 'Total RPO / backlog (stock)', note: fitNoteFor(comp.series.total_rpo),
      render: () => renderFlowStockChart('chart-GEV-rpo', comp.series.total_rpo, meta.colorVar, '$'),
    });
  }

  return cfgs;
}

function fitNoteFor(series) {
  if (ACTIVE_MODEL !== 's_curve') return 'Local regression overlay';
  const sc = series.model.s_curve;
  if (!sc || sc.status === 'no_fit') return 'No stable fit';
  return `${qualityLabel(sc.quality)} · S-curve peak ${fmtDateShort(sc.peak_date)}`;
}

// ==================== Chart renderers ====================
function renderFlowStockChart(canvasId, series, colorVar, unit, sparse) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const color = hsl(colorVar);
  const colorFaint = hsl(colorVar, 0.55);

  const actualPoints = series.dates.map((d, i) => ({ x: dateMs(d), y: series.values[i], period: series.periods[i] })).filter((p) => p.y != null);

  const datasets = [{
    type: 'bar',
    label: series.label,
    data: actualPoints,
    backgroundColor: colorFaint,
    borderColor: color,
    borderWidth: 1,
    borderRadius: 3,
    barThickness: sparse ? 14 : undefined,
    maxBarThickness: 26,
    order: 2,
  }];

  const annotations = {};

  if (ACTIVE_MODEL === 's_curve') {
    const sc = series.model.s_curve;
    if (sc && sc.status !== 'no_fit') {
      const curveKey = sc.fit_target === 'cumulative' ? 'quarterly_flow_fit' : 'curve';
      const valKey = sc.fit_target === 'cumulative' ? 'flow_fit' : 'level_fit';
      const overlay = sc[curveKey].map((p) => ({ x: dateMs(p.date), y: p[valKey] }));
      datasets.push({
        type: 'line', label: 'S-curve fit', data: overlay,
        borderColor: hsl('--text'), borderWidth: 1.75, borderDash: [5, 4],
        pointRadius: 0, tension: 0.15, order: 1, spanGaps: true,
      });
      const peakMs = dateMs(sc.peak_date);
      const lastActualMs = actualPoints.length ? actualPoints[actualPoints.length - 1].x : null;
      const horizonMs = lastActualMs != null ? lastActualMs + 3 * 365 * 86400000 : null;
      if (horizonMs != null && peakMs <= horizonMs) {
        annotations.peak = {
          type: 'line', xMin: peakMs, xMax: peakMs,
          borderColor: hsl('--fair'), borderWidth: 1.5, borderDash: [3, 3],
          label: { display: true, content: `Peak ${fmtDateShort(sc.peak_date)}`, position: 'start', color: hsl('--fair'), font: { size: 10, family: getMonoFont() }, backgroundColor: hsl('--surface-2') },
        };
      }
    }
  } else {
    const lr = series.model.local_regression;
    if (lr && lr.a !== undefined && actualPoints.length >= 3) {
      const tsClean = actualPoints.map((p) => toT(new Date(p.x).toISOString().slice(0, 10)));
      const w = Math.min(8, tsClean.length);
      const tRef = lr.t_ref;
      const tStart = tsClean[tsClean.length - w] - 0.5;
      const tEnd = tsClean[tsClean.length - 1] + 2;
      const overlay = [];
      for (let t = tStart; t <= tEnd; t += 0.25) {
        const x = t - tRef;
        const y = lr.a + lr.b * x + lr.c * x * x;
        overlay.push({ x: tToMs(t), y });
      }
      datasets.push({
        type: 'line', label: 'Local regression', data: overlay,
        borderColor: hsl('--text'), borderWidth: 1.75, borderDash: [5, 4],
        pointRadius: 0, tension: 0.2, order: 1,
      });
      if (lr.status === 'peak_forecast' && lr.vertex_t != null) {
        const peakMs = tToMs(lr.vertex_t);
        annotations.peak = {
          type: 'line', xMin: peakMs, xMax: peakMs,
          borderColor: hsl('--fair'), borderWidth: 1.5, borderDash: [3, 3],
          label: { display: true, content: 'Local peak', position: 'start', color: hsl('--fair'), font: { size: 10 } },
        };
      }
    }
  }

  destroyChart(canvasId);
  CHART_INSTANCES[canvasId] = new Chart(ctx, {
    data: { datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'linear',
          ticks: { color: hsl('--text-faint'), callback: tickDateFormatter, font: { size: 10, family: getMonoFont() }, maxRotation: 0 },
          grid: { color: hsl('--border-soft') },
        },
        y: {
          ticks: { color: hsl('--text-faint'), callback: (v) => (unit === '$' ? '$' + fmtUSD(v) : v), font: { size: 10, family: getMonoFont() } },
          grid: { color: hsl('--border-soft') },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.raw?.period || tickDateFormatter(items[0]?.parsed?.x),
            label: (c) => `${c.dataset.label}: ${unit === '$' ? fmtUSDFull(c.parsed.y) : c.parsed.y.toFixed(1)}`,
          },
        },
        annotation: { annotations },
      },
    },
  });
}

function renderRateChart(canvasId, seriesA, seriesB, labelA, labelB) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const ptsA = seriesA.dates.map((d, i) => ({ x: dateMs(d), y: seriesA.values[i], period: seriesA.periods[i] }));
  const ptsB = seriesB.dates.map((d, i) => ({ x: dateMs(d), y: seriesB.values[i], period: seriesB.periods[i] }));

  const datasets = [
    { type: 'line', label: labelA, data: ptsA, borderColor: hsl('--c-etn'), backgroundColor: hsl('--c-etn', 0.15), borderWidth: 2, pointRadius: 3, tension: 0.25, fill: false },
    { type: 'line', label: labelB, data: ptsB, borderColor: hsl('--text-muted'), backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4, 3], pointRadius: 2.5, tension: 0.25, fill: false },
  ];

  const annotations = {
    zero: { type: 'line', yMin: 0, yMax: 0, borderColor: hsl('--border'), borderWidth: 1 },
  };

  if (ACTIVE_MODEL === 'local_regression') {
    const lr = seriesA.model.local_regression;
    if (lr && lr.a !== undefined) {
      const tsAll = seriesA.dates.map(toT);
      const w = Math.min(8, tsAll.length);
      const tRef = lr.t_ref;
      const tStart = tsAll[tsAll.length - w] - 0.5;
      const tEnd = tsAll[tsAll.length - 1] + 2;
      const overlay = [];
      for (let t = tStart; t <= tEnd; t += 0.25) {
        const x = t - tRef;
        overlay.push({ x: tToMs(t), y: lr.a + lr.b * x + lr.c * x * x });
      }
      datasets.push({ type: 'line', label: `${labelA} local fit`, data: overlay, borderColor: hsl('--text'), borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, tension: 0.2 });
    }
  }

  destroyChart(canvasId);
  CHART_INSTANCES[canvasId] = new Chart(ctx, {
    data: { datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'linear', ticks: { color: hsl('--text-faint'), callback: tickDateFormatter, font: { size: 10, family: getMonoFont() } }, grid: { color: hsl('--border-soft') } },
        y: { ticks: { color: hsl('--text-faint'), callback: (v) => v + '%', font: { size: 10, family: getMonoFont() } }, grid: { color: hsl('--border-soft') } },
      },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: hsl('--text-muted'), font: { size: 10 }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.raw?.period || tickDateFormatter(items[0]?.parsed?.x),
            label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? '—' : c.parsed.y.toFixed(0) + '%'}`,
          },
        },
        annotation: { annotations },
      },
    },
  });
}

function renderGrowthPanel(canvasId, seriesA, colorVarA, seriesB, colorVarB) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const barData = seriesA.dates.map((d, i) => ({ x: dateMs(d), y: seriesA.accel_yoy_pp ? seriesA.accel_yoy_pp[i] : null, period: seriesA.periods[i] }));
  const lineDataA = seriesA.dates.map((d, i) => ({ x: dateMs(d), y: seriesA.yoy_pct[i], period: seriesA.periods[i] }));

  const datasets = [
    { type: 'bar', label: 'Acceleration (Δ YoY pp)', data: barData, backgroundColor: hsl('--text-faint', 0.35), borderWidth: 0, yAxisID: 'yAccel', order: 2, barThickness: 10 },
    { type: 'line', label: `${seriesA.label} YoY %`, data: lineDataA, borderColor: hsl(colorVarA), backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2.5, tension: 0.25, yAxisID: 'yGrowth', order: 1 },
  ];

  if (seriesB) {
    const lineDataB = seriesB.dates.map((d, i) => ({ x: dateMs(d), y: seriesB.yoy_pct[i], period: seriesB.periods[i] }));
    datasets.push({ type: 'line', label: `${seriesB.label} YoY %`, data: lineDataB, borderColor: hsl('--text-muted'), backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4, 3], pointRadius: 2, tension: 0.25, yAxisID: 'yGrowth', order: 1 });
  }

  destroyChart(canvasId);
  CHART_INSTANCES[canvasId] = new Chart(ctx, {
    data: { datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'linear', ticks: { color: hsl('--text-faint'), callback: tickDateFormatter, font: { size: 10, family: getMonoFont() } }, grid: { color: hsl('--border-soft') } },
        yGrowth: { position: 'left', ticks: { color: hsl('--text-faint'), callback: (v) => v + '%', font: { size: 10, family: getMonoFont() } }, grid: { color: hsl('--border-soft') } },
        yAccel: { position: 'right', ticks: { color: hsl('--text-faint'), callback: (v) => v + 'pp', font: { size: 10, family: getMonoFont() } }, grid: { display: false } },
      },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: hsl('--text-muted'), font: { size: 10 }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.raw?.period || tickDateFormatter(items[0]?.parsed?.x),
            label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? '—' : c.parsed.y.toFixed(1) + (c.dataset.yAxisID === 'yAccel' ? 'pp' : '%')}`,
          },
        },
      },
    },
  });
}

// ==================== Detail table ====================
function buildDetailTable(tkr, comp) {
  const meta = COMPANY_META[tkr];
  const primary = comp.series[meta.primary];
  const hasSource = tkr === 'ETN';
  const rows = primary.periods.map((p, i) => {
    const val = primary.values[i];
    const yoy = primary.yoy_pct[i];
    const src = hasSource ? comp.quarters[i]?.source : null;
    return `<tr>
      <td>${p}</td>
      <td>${fmtUSDFull(val)}</td>
      <td>${fmtPct(yoy)}</td>
      ${hasSource ? `<td>${src ? `<a class="src-link" href="${src}" target="_blank" rel="noopener">filing</a>` : '—'}</td>` : ''}
    </tr>`;
  }).join('');

  return `
    <div class="detail-table-wrap">
      <table class="detail-table" data-testid="table-detail-${tkr}">
        <thead>
          <tr>
            <th>Quarter</th>
            <th>${primary.label}</th>
            <th>YoY %</th>
            ${hasSource ? '<th>Source</th>' : ''}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ==================== Sources ====================
const SOURCES = [
  { name: 'Micron Technology — SEC EDGAR filings', url: 'https://www.sec.gov/edgar/browse/?CIK=0000723125&owner=exclude' },
  { name: 'Micron Technology — Investor Relations SEC filings', url: 'https://investors.micron.com/sec-filings' },
  { name: 'Nvidia — SEC EDGAR filings', url: 'https://www.sec.gov/edgar/browse/?CIK=0001045810&owner=exclude' },
  { name: 'Nvidia — Investor Relations SEC filings', url: 'https://investor.nvidia.com/financial-info/sec-filings/default.aspx' },
  { name: 'Alphabet — SEC EDGAR filings', url: 'https://www.sec.gov/edgar/browse/?CIK=0001652044' },
  { name: 'Eaton — SEC EDGAR filings', url: 'https://www.sec.gov/edgar/browse/?CIK=0001551182&owner=exclude' },
  { name: 'Eaton — Q1 2026 10-Q (SEC EDGAR)', url: 'https://www.sec.gov/Archives/edgar/data/1551182/000155118226000013/etn-20260331.htm' },
  { name: 'Eaton — Q2 2026 reporting date (Business Wire)', url: 'https://www.businesswire.com/news/home/20260721456786/en/Eaton-declares-quarterly-dividend-payable-August-28-2026' },
  { name: 'GE Vernova — SEC EDGAR filings', url: 'https://www.sec.gov/edgar/browse/?CIK=0001996810&owner=exclude' },
  { name: 'GE Vernova — Investor Relations reports & filings', url: 'https://www.gevernova.com/investors/reports-filings' },
];
function renderSources() {
  const list = document.getElementById('sources-list');
  list.innerHTML = SOURCES.map((s) => `<li><a href="${s.url}" target="_blank" rel="noopener">${s.name}</a></li>`).join('');
}
function renderFooterMeta() {
  document.getElementById('last-updated').textContent = DATA.meta.generated;
}
