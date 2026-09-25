/**
 * Plume viewer: state, layout and data loading
 */

import {
    CONFIG, MODELS, store, isRetired, getLatestRunWithDate, previousCycle,
    isMobile, toggleWindUnit, getWindUnit, convertWind
} from './config.js?v=__V__';
import { fetchModelData, hasSnowForecast, getEnsembleStats } from './api.js?v=__V__';
import { createChart, toggleCore, destroyAllCharts, exportChartPng } from './charts.js?v=__V__';
import { applySiteSettings } from './site.js?v=__V__';

// ============ State ============
function initialModel() {
    const saved = store.get('sref-model');
    if (MODELS[saved] && !isRetired(saved)) return saved;
    return isRetired('sref') ? 'refs' : 'sref';
}

const state = {
    model: initialModel(),
    station: store.get('sref-last-station') || 'JFK',
    date: null,
    run: null,
    data: {},                      // param -> ensemble data for the shown run
    hasSnow: false,
    currentView: { snow: 'total', precip: 'total' },
    previousRuns: {},              // run hour -> { param: data } for the preceding cycles
    visibleRuns: {},               // run hour -> overlay shown (default: not on phones)
    // Bands are the only legible default at phone widths
    chartViewMode: store.get('sref-chart-view-mode') || (isMobile() ? 'bands' : 'spaghetti'),
    siteName: null,
    load: null,                    // AbortController of the load in progress
};

const COMPARE_CYCLES = 3;
const isRunVisible = run => state.visibleRuns[run] ?? !isMobile();

// Comparison overlay colors by cycle slot (SREF and REFS cycle times)
const RUN_COLORS = {
    '03': '#ff9f43', '09': '#10ac84', '15': '#ee5a24', '21': '#8854d0',
    '00': '#ff9f43', '06': '#10ac84', '12': '#ee5a24', '18': '#8854d0',
};

const $ = id => document.getElementById(id);
const elements = {};

function setPressed(buttons, isOn) {
    for (const b of buttons) {
        const on = Boolean(isOn(b));
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
    }
}

// ============ Initialization ============
function init() {
    for (const id of ['pageTitle', 'mainContent', 'stationBtns', 'customStation', 'dateInput', 'runSelect',
        'timeDisplay', 'reloadBtn', 'weatherSummary', 'trendText', 'status', 'lastUpdate', 'helpDialog']) {
        elements[id] = $(id);
    }
    elements.defaultTitle = elements.pageTitle.textContent.trim();

    // Share links carry model/station and, when pinned, run/date
    const url = new URLSearchParams(location.search);
    if (MODELS[url.get('model')]) state.model = url.get('model');
    if (/^[A-Za-z]{3,4}$/.test(url.get('station') || '')) state.station = url.get('station').toUpperCase();
    const latest = getLatestRunWithDate(state.model);
    state.run = MODELS[state.model].runs.includes(url.get('run')) ? url.get('run') : latest.run;
    state.date = /^\d{4}-\d{2}-\d{2}$/.test(url.get('date') || '') ? url.get('date') : latest.date;

    elements.customStation.value = store.get('sref-custom-station') || '';
    elements.dateInput.max = new Date().toISOString().slice(0, 10);

    document.querySelectorAll('#modelBtns button').forEach(b =>
        b.addEventListener('click', () => handleModelChange(b.dataset.model)));
    elements.stationBtns.addEventListener('click', e => {
        if (e.target.dataset.val) selectStation(e.target.dataset.val);
    });
    elements.customStation.addEventListener('keydown', e => { if (e.key === 'Enter') handleCustomStation(); });
    $('customStationBtn').addEventListener('click', handleCustomStation);
    elements.dateInput.addEventListener('change', e => {
        if (!e.target.value) return;
        state.date = e.target.value;
        loadAllCharts();
    });
    elements.runSelect.addEventListener('change', e => {
        state.run = e.target.value;
        loadAllCharts();
    });
    elements.reloadBtn.addEventListener('click', loadAllCharts);
    $('shareBtn').addEventListener('click', shareLink);
    $('helpBtn').addEventListener('click', () => elements.helpDialog.showModal());
    // Backdrop click closes (the inner wrapper fills the dialog box)
    elements.helpDialog.addEventListener('click', e => {
        if (e.target === elements.helpDialog) elements.helpDialog.close();
    });

    updateTimeDisplay();
    setInterval(updateTimeDisplay, 60000);

    // Rebuild on width changes only: mobile browsers fire resize when the
    // address bar shows/hides, and rebuilding mid-scroll causes jank
    let resizeTimeout;
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (window.innerWidth === lastWidth) return;
            lastWidth = window.innerWidth;
            updateTimeDisplay();
            rebuildCharts();
        }, 250);
    });
    // Chart colors are baked in at creation: redraw on theme switch
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', rebuildCharts);

    // Settings only affect chrome: don't hold the first data fetch for them
    applySiteSettings().then(s => {
        if (s.siteName) {
            state.siteName = s.siteName;
            document.title = s.siteName;
            renderTitle();
        }
        if (s.defaultStations?.length) renderStationButtons(s.defaultStations);
    });

    loadAllCharts();
}

function renderStationButtons(stations) {
    elements.stationBtns.querySelectorAll('button[data-val]').forEach(b => b.remove());
    for (const s of stations) {
        const b = Object.assign(document.createElement('button'), { textContent: s });
        b.dataset.val = s;
        elements.stationBtns.insertBefore(b, elements.customStation);
    }
    syncControls();
}

/** Reflect state in the header controls and the address bar. */
function syncControls() {
    const model = MODELS[state.model];
    setPressed(document.querySelectorAll('#modelBtns button'), b => b.dataset.model === state.model);
    setPressed(elements.stationBtns.querySelectorAll('button[data-val]'), b => b.dataset.val === state.station);
    elements.runSelect.replaceChildren(...model.runs.map(r => new Option(`${r}Z`, r)));
    elements.runSelect.value = state.run;
    elements.dateInput.value = state.date;

    // The address bar pins run/date only when they aren't the latest, so a
    // reload or bookmark keeps following new runs
    const latest = getLatestRunWithDate(state.model);
    history.replaceState(null, '', shareUrl(latest.run !== state.run || latest.date !== state.date));
}

function shareUrl(pinRun = true) {
    const p = new URLSearchParams({ model: state.model, station: state.station });
    if (pinRun) {
        p.set('run', state.run);
        p.set('date', state.date);
    }
    return `${location.pathname}?${p}`;
}

async function shareLink() {
    const btn = $('shareBtn');
    // A shared forecast is pinned to the run on screen
    const link = new URL(shareUrl(), location.href).href;
    try {
        await navigator.clipboard.writeText(link);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Share'; }, 1500);
    } catch {
        prompt('Copy this link:', link);
    }
}

// ============ Event Handlers ============
function handleModelChange(model) {
    if (!MODELS[model] || model === state.model) return;
    state.model = model;
    store.set('sref-model', model);
    Object.assign(state, getLatestRunWithDate(model));
    loadAllCharts();
}

function selectStation(station) {
    state.station = station;
    store.set('sref-last-station', station);
    loadAllCharts();
}

function handleCustomStation() {
    const input = elements.customStation;
    input.value = input.value.trim().toUpperCase();
    if (!input.value || !input.reportValidity()) return;
    store.set('sref-custom-station', input.value);
    selectStation(input.value);
}

// ============ Header ============
function updateTimeDisplay() {
    const fmt = (timeZone, hour12) => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone, hour12 });
    elements.timeDisplay.textContent = isMobile()
        ? fmt('America/New_York', true)
        : `${fmt('America/New_York', true)} ET / ${fmt('UTC', false)}Z`;
}

function renderTitle() {
    elements.pageTitle.textContent = state.siteName || elements.defaultTitle;
    if (state.hasSnow) {
        elements.pageTitle.appendChild(Object.assign(document.createElement('span'), { className: 'snow-alert', textContent: 'SNOW' }));
    }
}

function setStatus(text, busy = false) {
    elements.status.replaceChildren(text);
    if (busy) elements.status.prepend(Object.assign(document.createElement('span'), { className: 'spinner' }));
}

// ============ Layout ============
function buildLayout() {
    destroyAllCharts();
    pendingRenders.clear();
    chartObserver?.disconnect();

    const sections = [];
    if (state.hasSnow) {
        sections.push({ id: 'snow-section', title: 'SNOWFALL', featured: true, params: ['Total-SNO', '3hrly-SNO'], viewType: 'snow' });
    }
    sections.push({ id: 'temp-section', title: 'TEMPERATURE', params: ['3hrly-TMP'] });
    sections.push({ id: 'precip-section', title: 'PRECIPITATION', params: ['Total-QPF', '3hrly-QPF'], viewType: 'precip' });
    sections.push({ id: 'wind-section', title: 'WIND', params: ['3h-10mWND'] });

    const model = MODELS[state.model];
    // REFS stats come from the mean +/- spread band, not member extremes
    const [hiLabel, loLabel] = state.model === 'refs' ? ['P90', 'P10'] : ['Max', 'Min'];

    elements.mainContent.innerHTML = sections.map(section => {
        const view = state.currentView[section.viewType];
        const activeParam = section.viewType ? section.params[view === 'total' ? 0 : 1] : section.params[0];

        return `
            <section class="chart-section" id="${section.id}">
                <div class="section-header">
                    <h2 class="section-title">${section.title}</h2>
                    ${section.viewType ? `
                        <div class="view-toggle" data-type="${section.viewType}">
                            <button class="${view === 'total' ? 'active' : ''}" aria-pressed="${view === 'total'}" data-view="total">Total</button>
                            <button class="${view === '3h' ? 'active' : ''}" aria-pressed="${view === '3h'}" data-view="3h">3-Hour</button>
                        </div>
                    ` : ''}
                    <div class="mean-legend"><div class="mean-line"></div> Ensemble Mean</div>
                </div>
                ${section.params.map((param, idx) => {
            const info = CONFIG.params[param];
            const isWind = info.type === 'wind';
            return `
                        <div class="chart-card ${section.featured && idx === 0 ? 'featured' : ''}"
                             id="card-${param}" data-param="${param}" ${param !== activeParam ? 'hidden' : ''}>
                            <div class="chart-header">
                                <div class="chart-title-area">
                                    <h3 class="chart-title">${info.name}</h3>
                                    <div class="chart-subtitle" id="unit-${param}">${isWind ? getWindUnit() : info.unit}</div>
                                    ${isWind ? '<button class="unit-toggle" id="wind-unit-btn" title="Toggle kts/mph" aria-label="Toggle wind unit">↔</button>' : ''}
                                </div>
                                <div class="chart-actions">
                                    ${model.cores.map(core => `
                                        <button class="active tooltip-trigger" aria-pressed="true" data-core="${core.key}" data-param="${param}" data-tooltip="${core.tooltip}">${core.label || core.key}</button>
                                    `).join('')}
                                </div>
                            </div>
                            <div class="chart-body">
                                <div class="loading" id="loading-${param}">
                                    <div class="skeleton skeleton-chart"></div>
                                </div>
                                <canvas id="chart-${param}" role="img" aria-label="${info.name} ensemble plume"></canvas>
                            </div>
                            <div class="axis-label">Forecast Time (Eastern)</div>
                            <div class="summary-row" id="summary-${param}" hidden>
                                ${[['mean', `Mean ${param.startsWith('Total') ? 'Total' : 'Peak'}`], ['max', hiLabel], ['min', loLabel], ['spread', 'Spread']]
                    .map(([key, label]) => `
                                    <div class="summary-item">
                                        <span class="summary-label">${label}</span>
                                        <span class="summary-value ${info.type}" id="${key}-${param}">--</span>
                                    </div>`).join('')}
                                <button class="download-btn" data-param="${param}" title="Download as PNG">⬇ Save</button>
                            </div>
                        </div>
                    `;
        }).join('')}
            </section>
        `;
    }).join('');

    attachEventHandlers();
}

function attachEventHandlers() {
    document.querySelectorAll('.view-toggle').forEach(toggle => {
        toggle.addEventListener('click', e => {
            if (!e.target.dataset.view) return;
            state.currentView[toggle.dataset.type] = e.target.dataset.view;
            setPressed(toggle.querySelectorAll('button'), b => b === e.target);
            const showTotal = e.target.dataset.view === 'total';
            toggle.closest('.chart-section').querySelectorAll('.chart-card').forEach(card => {
                card.hidden = card.dataset.param.startsWith('Total') !== showTotal;
            });
        });
    });

    document.querySelectorAll('.chart-actions button[data-core]').forEach(btn => {
        btn.addEventListener('click', () => {
            setPressed([btn], () => !btn.classList.contains('active'));
            toggleCore(btn.dataset.param, btn.dataset.core);
        });
    });

    document.querySelectorAll('.download-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const label = MODELS[state.model].label;
            exportChartPng(btn.dataset.param,
                `${label} • ${state.station} • ${state.run}Z ${state.date}`,
                `${label}_${state.station}_${state.date}_${state.run}Z_${btn.dataset.param}`);
        });
    });

    $('wind-unit-btn')?.addEventListener('click', () => {
        $('unit-3h-10mWND').textContent = toggleWindUnit();
        const data = state.data['3h-10mWND'];
        if (data) {
            drawChart('3h-10mWND', data);
            updateSummary('3h-10mWND', data);
        }
    });
}

// ============ Lazy Chart Rendering ============
// Fetching is cheap (cached JSON) but instantiating 26-line charts is not:
// charts below the fold render when they scroll near the viewport.
const pendingRenders = new Map(); // param -> data
let chartObserver = null;

const drawChart = (param, data) => createChart(param, data, getOverlayData(param), state.chartViewMode);

function ensureChartObserver() {
    chartObserver ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const param = entry.target.dataset.param;
            const data = pendingRenders.get(param);
            if (data) {
                pendingRenders.delete(param);
                drawChart(param, data);
            }
            chartObserver.unobserve(entry.target);
        }
    }, { rootMargin: '250px' });
    return chartObserver;
}

function renderChart(param, data) {
    $(`loading-${param}`)?.classList.add('hidden');
    updateSummary(param, data);

    const card = $(`card-${param}`);
    const rect = card?.getBoundingClientRect();
    if (!card || (rect.top < window.innerHeight + 250 && rect.bottom > -250)) {
        drawChart(param, data);
    } else {
        pendingRenders.set(param, data);
        ensureChartObserver().observe(card);
    }
}

function rebuildCharts() {
    if (Object.keys(state.data).length === 0) return;
    buildLayout();
    for (const [param, data] of Object.entries(state.data)) renderChart(param, data);
}

// ============ Data Loading ============
/**
 * Load the selected run. A newer load aborts this one: every step after an
 * await checks the signal before touching state or the DOM.
 */
async function loadAllCharts() {
    state.load?.abort();
    const load = state.load = new AbortController();
    const { signal } = load;
    const { model, station, run, date } = state;
    const label = MODELS[model].label;
    const fetchParam = param => fetchModelData(MODELS[model].apiBase, station, run, param, date, signal);

    syncControls();
    state.data = {};
    state.previousRuns = {};
    elements.trendText.textContent = '';
    setStatus('Loading…', true);
    const stopProgress = model === 'refs' ? watchRefsProgress(run, date, signal) : () => {};

    // Request everything at once: the snow check decides the layout and the
    // rest are usually cache hits by then
    const requests = Object.fromEntries(CONFIG.snowOrder.map(p => [p, fetchParam(p)]));
    Object.values(requests).forEach(r => r.catch(() => {}));  // unused ones may fail quietly

    try {
        const snow = await requests['Total-SNO'].catch(() => null);
        if (signal.aborted) return;
        state.hasSnow = hasSnowForecast(snow);
        renderTitle();
        buildLayout();
        renderComparisonControls();

        const params = state.hasSnow ? CONFIG.snowOrder : CONFIG.defaultOrder;
        const results = await Promise.all(params.map(p => loadChart(p, requests[p], signal)));
        if (signal.aborted) return;

        const ok = results.some(Boolean);
        setStatus(ok ? `${label} • ${station} • ${run}Z ${date}`
            : `No ${label} data for ${station} ${run}Z ${date}. The run may not be published yet.`);
        elements.lastUpdate.textContent = `Updated ${new Date().toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
        })} ET`;
        updateWeatherSummary(ok);
        if (!ok) return $('ptypeStrip')?.remove();

        loadPtypeStrip(model === 'refs' ? fetchParam('ptype') : null, signal);
        fetchPreviousRuns(signal);
    } finally {
        stopProgress();
    }
}

async function loadChart(param, request, signal) {
    try {
        const data = await request;
        if (signal.aborted) return null;
        if (!data || Object.keys(data).length === 0) throw new Error('No data available');
        state.data[param] = data;
        renderChart(param, data);
        return data;
    } catch (err) {
        if (signal.aborted) return null;
        const label = Object.assign(document.createElement('span'), { className: 'error', textContent: 'No data' });
        const detail = Object.assign(document.createElement('small'), { className: 'error-detail', textContent: err.message });
        $(`loading-${param}`)?.replaceChildren(label, detail);
        return null;
    }
}

function updateSummary(param, data) {
    const summaryEl = $(`summary-${param}`);
    const stats = getEnsembleStats(data, !param.startsWith('Total'));
    if (!stats || !summaryEl) return;

    const type = CONFIG.params[param].type;
    const fmt = v => {
        if (type === 'temp') return v.toFixed(0) + '°';
        if (type === 'wind') return convertWind(v).toFixed(0);
        return v.toFixed(2);
    };
    $(`mean-${param}`).textContent = stats.mean !== null ? fmt(stats.mean) : '--';
    $(`max-${param}`).textContent = fmt(stats.max);
    $(`min-${param}`).textContent = fmt(stats.min);
    $(`spread-${param}`).textContent = fmt(stats.spread);
    summaryEl.hidden = false;
}

/**
 * While a REFS cycle is being built server-side (a cold cycle streams
 * ~350MB upstream), show what the extractor is doing. Returns a stop fn.
 */
function watchRefsProgress(run, date, signal) {
    let stopped = false;
    const timer = setInterval(async () => {
        try {
            const p = await (await fetch(`/api/refs/status/${run}?date=${date}`, { signal })).json();
            // A response landing after loading finished must not repaint the final status
            if (stopped || signal.aborted || !p.busy) return;
            const parts = [];
            if (p.soundings && p.soundings !== 'done') parts.push(`soundings ${p.soundings}`);
            if (p.ensemble && p.ensemble !== 'done') parts.push(`ensemble ${p.ensemble}`);
            setStatus(`Building REFS ${run}Z: ${parts.join(' · ') || 'finishing'} (${p.elapsed}s)`, true);
        } catch { /* status is best-effort */ }
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
}

// ============ Run Comparison ============
/** The cycles before the one shown, most recent first */
function comparisonCycles() {
    return Array.from({ length: COMPARE_CYCLES }, (_, i) => previousCycle(state.model, state.date, state.run, i + 1));
}

function getOverlayData(param) {
    const overlays = [];
    for (const { run } of comparisonCycles()) {
        const mean = state.previousRuns[run]?.[param]?.['Mean'];
        if (isRunVisible(run) && mean) {
            overlays.push({ label: `${run}Z Mean`, data: mean, color: RUN_COLORS[run] || '#888' });
        }
    }
    return overlays;
}

function renderComparisonControls() {
    let controls = $('runComparison');
    if (!controls) {
        controls = Object.assign(document.createElement('div'), { id: 'runComparison', className: 'run-comparison' });
        elements.weatherSummary.parentElement.appendChild(controls);
    }

    const modes = [
        ['spaghetti', 'Lines', 'Show individual ensemble member lines'],
        ['bands', 'Bands', 'Show confidence bands (P10-P90)'],
        ['both', 'Both', 'Show both lines and bands'],
    ];
    controls.innerHTML = `
        <span class="comp-label">Compare:</span>
        ${comparisonCycles().map(({ run, date }) => `
            <label class="run-toggle" style="color: ${RUN_COLORS[run]}" title="${date} ${run}Z run">
                <input type="checkbox" value="${run}" ${isRunVisible(run) ? 'checked' : ''}>
                ${run}Z
            </label>
        `).join('')}
        <div class="chart-mode-toggle">
            <span class="comp-label">Chart:</span>
            ${modes.map(([mode, label, title]) => `
                <button class="mode-btn ${state.chartViewMode === mode ? 'active' : ''}" aria-pressed="${state.chartViewMode === mode}"
                    data-mode="${mode}" title="${title}">${label}</button>
            `).join('')}
        </div>
    `;

    controls.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', async () => {
            state.visibleRuns[input.value] = input.checked;
            const { signal } = state.load;
            if (input.checked) {
                // Only the trend param is prefetched while every overlay is off
                const cycle = comparisonCycles().find(c => c.run === input.value);
                if (!cycle) return;  // control from a superseded model/run
                await ensureRunData(cycle, Object.keys(state.data), signal);
                if (signal.aborted) return;
            }
            rebuildCharts();
        });
    });

    controls.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.mode === state.chartViewMode) return;
            state.chartViewMode = btn.dataset.mode;
            store.set('sref-chart-view-mode', state.chartViewMode);
            setPressed(controls.querySelectorAll('.mode-btn'), b => b === btn);
            rebuildCharts();
        });
    });
}

async function ensureRunData({ run, date }, params, signal) {
    // Bound to this load's object: a superseded load can't write into the next one's
    const bucket = state.previousRuns[run] ??= {};
    const api = MODELS[state.model].apiBase;
    await Promise.all(params.filter(p => !bucket[p]).map(async (param) => {
        try {
            const data = await fetchModelData(api, state.station, run, param, date, signal);
            if (data && Object.keys(data).length > 0) bucket[param] = data;
        } catch { /* that cycle/param isn't available */ }
    }));
}

const trendParam = () => state.hasSnow ? 'Total-SNO' : 'Total-QPF';

async function fetchPreviousRuns(signal) {
    const cycles = comparisonCycles();
    // With no overlays shown (the phone default) only the summary trend
    // needs previous-run data: one param instead of six per run
    const anyVisible = cycles.some(c => isRunVisible(c.run));
    const params = anyVisible ? Object.keys(state.data) : [trendParam()];
    await Promise.all(cycles.map(c => ensureRunData(c, params, signal)));
    if (signal.aborted) return;
    updateTrendText();
    if (anyVisible) rebuildCharts();
}

// ============ Weather Summary ============
// Spread (inches) below which the ensemble counts as agreeing
const CONFIDENCE = { snow: [1, 3], precip: [0.25, 0.75] };

function confidence(type, spread) {
    const [high, moderate] = CONFIDENCE[type];
    if (spread < high) return { text: 'high confidence', cls: 'high-confidence' };
    if (spread < moderate) return { text: 'moderate spread', cls: 'moderate-confidence' };
    return { text: 'low agreement', cls: 'low-confidence' };
}

function updateWeatherSummary(hasData) {
    const el = elements.weatherSummary;
    if (!hasData) {
        el.textContent = 'No forecast data';
        return;
    }
    const snow = getEnsembleStats(state.data['Total-SNO'], false);
    const rain = getEnsembleStats(state.data['Total-QPF'], false);
    let lead, stats, type, digits;
    if (snow && snow.max > 0.5) [lead, stats, type, digits] = ['❄ Snow likely:', snow, 'snow', 1];
    else if (rain && rain.max > 0.1) [lead, stats, type, digits] = ['Rain likely:', rain, 'precip', 2];
    else {
        el.textContent = 'Dry conditions expected';
        return;
    }
    const c = confidence(type, stats.spread);
    el.innerHTML = `<strong>${lead}</strong> ${stats.min.toFixed(digits)}-${stats.max.toFixed(digits)} in expected
        <span class="${c.cls}">(${c.text})</span>`;
}

function updateTrendText() {
    const param = trendParam();
    const prev = previousCycle(state.model, state.date, state.run);
    const now = getEnsembleStats(state.data[param], false);
    const before = getEnsembleStats(state.previousRuns[prev.run]?.[param], false);
    if (!now || !before || now.mean === null || before.mean === null) return;

    const delta = now.mean - before.mean;
    if (Math.abs(delta) < (state.hasSnow ? 0.1 : 0.05)) return;
    const sign = delta > 0 ? '+' : '';
    elements.trendText.textContent =
        `${delta > 0 ? '↑' : '↓'} trending ${delta > 0 ? 'higher' : 'lower'} vs ${prev.run}Z (${sign}${delta.toFixed(state.hasSnow ? 1 : 2)} in)`;
}

// ============ Precip Type (REFS) ============
const PTYPE_DEFS = [
    { key: 'snow', label: 'Snow', color: '#a5d8ff' },
    { key: 'rain', label: 'Rain', color: '#51cf66' },
    { key: 'zr', label: 'Frz rain', color: '#ff8787' },
    { key: 'ip', label: 'Sleet', color: '#da77f2' },
];

/**
 * Timeline strip of the dominant precip type per hour (>=40% of members)
 * plus transition text like "Rain Tue 7 PM → snow Tue 11 PM".
 */
async function loadPtypeStrip(request, signal) {
    const remove = () => $('ptypeStrip')?.remove();
    if (!request) return remove();

    let data;
    try {
        data = await request;
    } catch {
        data = null;
    }
    if (signal.aborted) return;
    if (!Array.isArray(data)) return remove();

    const hours = data.map(pt => {
        const best = PTYPE_DEFS.reduce((a, t) => (pt[t.key] > (pt[a?.key] ?? 0) ? t : a), null);
        return { x: pt.x, type: best && pt[best.key] >= 0.4 ? best : null };
    });
    if (!hours.some(h => h.type)) return remove();

    // Merge consecutive hours into segments
    const segments = [];
    for (const h of hours) {
        const last = segments[segments.length - 1];
        if (last && last.type === h.type) last.count++;
        else segments.push({ type: h.type, count: 1, startX: h.x });
    }

    // Onset and type changes, ignoring blips shorter than 2h
    const fmtTime = x => new Date(x).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', timeZone: 'America/New_York' });
    const events = [];
    let prevType = null;
    for (const seg of segments) {
        if (!seg.type || seg.count < 2 || seg.type === prevType) continue;
        events.push(`${prevType ? seg.type.label.toLowerCase() : seg.type.label} ${fmtTime(seg.startX)}`);
        prevType = seg.type;
    }

    let strip = $('ptypeStrip');
    if (!strip) {
        strip = Object.assign(document.createElement('div'), { id: 'ptypeStrip', className: 'ptype-strip' });
        elements.weatherSummary.parentElement.appendChild(strip);
    }
    const text = Object.assign(document.createElement('div'), {
        className: 'ptype-text', textContent: 'P-type: ' + (events.slice(0, 3).join(' → ') || 'brief/mixed')
    });
    const bar = Object.assign(document.createElement('div'), { className: 'ptype-bar' });
    for (const seg of segments) {
        const el = Object.assign(document.createElement('div'), {
            className: 'ptype-seg',
            title: `${seg.type ? seg.type.label : 'No precip'} from ${fmtTime(seg.startX)}`
        });
        el.style.flexGrow = String(seg.count);
        el.style.background = seg.type ? seg.type.color : 'transparent';
        bar.appendChild(el);
    }
    strip.replaceChildren(text, bar);
}

document.addEventListener('DOMContentLoaded', init);
