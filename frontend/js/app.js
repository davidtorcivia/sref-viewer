/**
 * SREF Viewer - Main Application
 * Orchestrates UI, state management, and data loading
 */

import { CONFIG, MODELS, getLatestRunWithDate, isMobile, toggleWindUnit, getWindUnit, convertWind } from './config.js?v=__V__';
import { fetchSREFData, hasSnowForecast, getEnsembleStats } from './api.js?v=__V__';
import { createChart, toggleCore, exportChartPng } from './charts.js?v=__V__';

// ============ Application State ============
// Get local date in YYYY-MM-DD format (not UTC, which may be tomorrow already)
function getLocalDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const result = `${year}-${month}-${day}`;
    console.log(`[DATE] Local: ${now.toString()} → ${result}`);
    return result;
}

const state = {
    model: localStorage.getItem('sref-model') || 'sref',
    station: 'JFK',
    date: getLocalDateString(),
    run: null, // Will be set by initializeRunSelection
    data: {},
    hasSnow: false,
    currentView: { snow: 'total', precip: 'total' },
    isLoading: false,
    // Run comparison feature
    previousRuns: {}, // { '03': { param: data }, '09': { param: data }, ... }
    // Overlays default off on phones: 26 lines + 3 dashed means is unreadable there
    visibleRuns: Object.fromEntries(
        ['00', '03', '06', '09', '12', '15', '18', '21'].map(r => [r, !isMobile()])),
    // Chart display mode: 'spaghetti' (individual lines), 'bands', or 'both'.
    // Bands are the only legible default at phone widths.
    chartViewMode: localStorage.getItem('sref-chart-view-mode') || (isMobile() ? 'bands' : 'spaghetti'),
};

// Run colors for comparison overlay (SREF and REFS cycle times)
const RUN_COLORS = {
    '03': '#ff9f43', '09': '#10ac84', '15': '#ee5a24', '21': '#8854d0',
    '00': '#ff9f43', '06': '#10ac84', '12': '#ee5a24', '18': '#8854d0',
};

// ============ DOM Elements ============
const elements = {
    pageTitle: null,
    mainContent: null,
    stationBtns: null,
    customStation: null,
    dateInput: null,
    runSelect: null,
    timeDisplay: null,
    reloadBtn: null,
    helpBtn: null,
    weatherSummary: null,
    status: null,
    lastUpdate: null
};

// ============ Initialization ============
async function init() {
    // Cache DOM elements
    elements.pageTitle = document.getElementById('pageTitle');
    elements.mainContent = document.getElementById('mainContent');
    elements.stationBtns = document.getElementById('stationBtns');
    elements.customStation = document.getElementById('customStation');
    elements.dateInput = document.getElementById('dateInput');
    elements.runSelect = document.getElementById('runSelect');
    elements.timeDisplay = document.getElementById('timeDisplay');
    elements.reloadBtn = document.getElementById('reloadBtn');
    elements.helpBtn = document.getElementById('helpBtn');
    elements.weatherSummary = document.getElementById('weatherSummary');
    elements.status = document.getElementById('status');
    elements.lastUpdate = document.getElementById('lastUpdate');

    // Set initial date
    elements.dateInput.value = state.date;

    // Parse URL parameters for share links
    const urlParams = new URLSearchParams(window.location.search);
    const urlModel = urlParams.get('model');
    const urlStation = urlParams.get('station');
    const urlRun = urlParams.get('run');
    const urlDate = urlParams.get('date');

    // Apply URL params if present (highest priority)
    if (urlModel && MODELS[urlModel]) state.model = urlModel;
    if (urlStation) state.station = urlStation.toUpperCase();
    if (urlRun && MODELS[state.model].runs.includes(urlRun)) state.run = urlRun;
    if (urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)) state.date = urlDate;

    // Model toggle buttons
    document.querySelectorAll('#modelBtns button').forEach(b => {
        b.classList.toggle('active', b.dataset.model === state.model);
        b.addEventListener('click', () => handleModelChange(b.dataset.model));
    });

    // If no URL station, try localStorage (second priority)  
    if (!urlStation) {
        const savedStation = localStorage.getItem('sref-last-station');
        if (savedStation) state.station = savedStation;
    }

    // Load custom station from localStorage (for the input field)
    const savedCustomStation = localStorage.getItem('sref-custom-station');
    if (savedCustomStation) {
        elements.customStation.value = savedCustomStation;
    }

    // Update UI to reflect state
    elements.dateInput.value = state.date;
    document.querySelectorAll('#stationBtns button').forEach(b => {
        b.classList.toggle('active', b.dataset.val === state.station);
    });

    // Update time display
    updateTimeDisplay();
    setInterval(updateTimeDisplay, 60000); // Update every minute

    // Event listeners
    elements.stationBtns.addEventListener('click', handleStationClick);
    elements.dateInput.addEventListener('change', handleDateChange);
    elements.runSelect.addEventListener('change', handleRunChange);
    elements.reloadBtn.addEventListener('click', () => loadAllCharts());
    elements.helpBtn.addEventListener('click', showHelpModal);

    // Custom station input
    elements.customStation.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            handleCustomStation();
        }
    });

    // Custom station Go button
    const customStationBtn = document.getElementById('customStationBtn');
    if (customStationBtn) {
        customStationBtn.addEventListener('click', handleCustomStation);
    }

    // Share button - copy URL to clipboard
    const shareBtn = document.getElementById('shareBtn');
    if (shareBtn) {
        shareBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(window.location.href);
                const originalText = shareBtn.textContent;
                shareBtn.textContent = 'Copied!';
                shareBtn.style.background = 'var(--accent)';
                shareBtn.style.color = '#000';
                setTimeout(() => {
                    shareBtn.textContent = originalText;
                    shareBtn.style.background = '';
                    shareBtn.style.color = '';
                }, 1500);
            } catch (err) {
                console.error('Failed to copy:', err);
                // Fallback: select the URL in a prompt
                prompt('Copy this link:', window.location.href);
            }
        });
    }

    // Handle resize for responsive charts. Only react to width changes -
    // mobile browsers fire resize when the address bar shows/hides, and
    // rebuilding every chart mid-scroll causes visible jank.
    let resizeTimeout;
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (window.innerWidth === lastWidth) return;
            lastWidth = window.innerWidth;
            if (Object.keys(state.data).length > 0) {
                rebuildCharts();
            }
        }, 250);
    });

    // Load site settings from admin panel
    await loadSiteSettings();

    // Initialize run selection and load data.
    // A shared URL's run/date must survive - don't auto-select over them.
    initializeRunSelection(Boolean(urlRun || urlDate));
}

// ============ Site Settings ============
async function loadSiteSettings() {
    try {
        const res = await fetch('/api/settings');
        if (!res.ok) {
            console.log('[SETTINGS] Failed to fetch settings:', res.status);
            return;
        }

        const settings = await res.json();
        console.log('[SETTINGS] Received:', settings);

        // Update page title (tab and header)
        if (settings.siteName) {
            document.title = settings.siteName;
            // Store original site name for later (snow mode modifies it)
            state.siteNameBase = settings.siteName;
            console.log('[SETTINGS] Applied site name:', settings.siteName);
        }

        // Update meta description
        if (settings.siteDescription) {
            let meta = document.querySelector('meta[name="description"]');
            if (meta) {
                meta.content = settings.siteDescription;
            }
        }

        // Apply favicon - remove any existing and add new
        if (settings.favicon) {
            // Remove all existing favicon links
            document.querySelectorAll('link[rel*="icon"]').forEach(el => el.remove());

            // Add new favicon
            const link = document.createElement('link');
            link.rel = 'icon';
            link.type = 'image/x-icon';
            link.href = settings.favicon + '?v=' + Date.now(); // Cache bust
            document.head.appendChild(link);
            console.log('[SETTINGS] Applied favicon:', settings.favicon);
        }

        // Inject analytics script
        if (settings.analyticsScript && settings.analyticsScript.trim()) {
            console.log('[SETTINGS] Injecting analytics script...');
            const div = document.createElement('div');
            div.innerHTML = settings.analyticsScript;

            // Move scripts to head
            const scripts = div.querySelectorAll('script');
            if (scripts.length > 0) {
                scripts.forEach(script => {
                    const newScript = document.createElement('script');
                    // Copy attributes
                    for (const attr of script.attributes) {
                        newScript.setAttribute(attr.name, attr.value);
                    }
                    // Copy inline content
                    if (script.textContent) {
                        newScript.textContent = script.textContent;
                    }
                    document.head.appendChild(newScript);
                    console.log('[SETTINGS] Injected script:', newScript.src || '[inline]');
                });
            } else {
                console.log('[SETTINGS] No script tags found in analytics content');
            }
        }

        // Apply custom CSS
        if (settings.customCss && settings.customCss.trim()) {
            const style = document.createElement('style');
            style.textContent = settings.customCss;
            document.head.appendChild(style);
            console.log('[SETTINGS] Applied custom CSS');
        }

        console.log('[SETTINGS] Site settings loaded successfully');
    } catch (err) {
        console.error('[SETTINGS] Could not load settings:', err);
    }
}

// ============ Run Selection ============
/**
 * Initialize run selection based on time logic.
 * - All runs are always selectable (older data should always exist)
 * - Auto-select the run that's most likely to have data based on current time
 * - Sets both the run AND the correct date (handles midnight rollover)
 */
function initializeRunSelection(preserveState = false) {
    // Rebuild run options for the active model's cycle times
    const runs = MODELS[state.model].runs;
    elements.runSelect.innerHTML = runs
        .map(r => `<option value="${r}">${r}Z</option>`).join('');

    if (!preserveState || !runs.includes(state.run)) {
        // Auto-select the most likely available run AND correct date
        const { run, date } = getLatestRunWithDate(state.model);
        state.run = run;
        if (!preserveState) state.date = date;
        else state.date = state.date || date;
    }
    elements.runSelect.value = state.run;
    elements.dateInput.value = state.date;

    loadAllCharts();
}

function handleModelChange(model) {
    if (!MODELS[model] || model === state.model || state.isLoading) return;
    state.model = model;
    localStorage.setItem('sref-model', model);
    document.querySelectorAll('#modelBtns button').forEach(b => {
        b.classList.toggle('active', b.dataset.model === model);
    });
    // Reset run comparison data - runs differ between models
    state.previousRuns = {};
    state.run = null;
    initializeRunSelection();
    updateShareUrl();
}

// ============ Event Handlers ============
function handleStationClick(e) {
    if (!e.target.dataset.val || state.isLoading) return;

    document.querySelectorAll('#stationBtns button').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    state.station = e.target.dataset.val;
    localStorage.setItem('sref-last-station', state.station);
    updateShareUrl();
    loadAllCharts();
}

function handleDateChange(e) {
    state.date = e.target.value;
    updateShareUrl();
    loadAllCharts();
}

function handleRunChange(e) {
    if (state.isLoading) return;
    state.run = e.target.value;
    updateShareUrl();
    loadAllCharts();
}

// ============ Time Display ============
function updateTimeDisplay() {
    const now = new Date();
    const et = now.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
        timeZone: 'America/New_York',
        hour12: true
    });

    if (isMobile()) {
        elements.timeDisplay.textContent = et;
    } else {
        const utc = now.toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit',
            timeZone: 'UTC',
            hour12: false
        });
        elements.timeDisplay.textContent = `${et} ET / ${utc}Z`;
    }
}

// ============ Share URL ============
/**
 * Update the browser URL with current state for sharing
 * Creates URLs like: ?station=JFK&run=21&date=2025-12-13
 */
function updateShareUrl() {
    const params = new URLSearchParams();
    params.set('model', state.model);
    params.set('station', state.station);
    params.set('run', state.run);
    params.set('date', state.date);

    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
}

// ============ Layout Building ============
function buildLayout() {
    const sections = [];

    if (state.hasSnow) {
        sections.push({
            id: 'snow-section',
            title: 'SNOWFALL',
            featured: true,
            params: ['Total-SNO', '3hrly-SNO'],
            viewType: 'snow'
        });
    }

    sections.push({ id: 'temp-section', title: 'TEMPERATURE', params: ['3hrly-TMP'] });
    sections.push({ id: 'precip-section', title: 'PRECIPITATION', params: ['Total-QPF', '3hrly-QPF'], viewType: 'precip' });
    sections.push({ id: 'wind-section', title: 'WIND', params: ['3h-10mWND'] });

    elements.mainContent.innerHTML = sections.map(section => {
        const hasViewToggle = section.viewType && section.params.length === 2;
        const activeParam = hasViewToggle ?
            (state.currentView[section.viewType] === 'total' ? section.params[0] : section.params[1]) :
            section.params[0];

        return `
            <div class="chart-section" id="${section.id}">
                <div class="section-header">
                    <div class="section-title">${section.title}</div>
                    ${hasViewToggle ? `
                        <div class="view-toggle" data-type="${section.viewType}">
                            <button class="${state.currentView[section.viewType] === 'total' ? 'active' : ''}" data-view="total">Total</button>
                            <button class="${state.currentView[section.viewType] === '3h' ? 'active' : ''}" data-view="3h">3-Hour</button>
                        </div>
                    ` : ''}
                    <div class="mean-legend"><div class="mean-line"></div> Ensemble Mean</div>
                </div>
                ${section.params.map((param, idx) => {
            const info = CONFIG.params[param];
            const isHidden = hasViewToggle && param !== activeParam;
            const isWind = info.type === 'wind';
            const windUnit = isWind ? getWindUnit() : null;
            return `
                        <div class="chart-card ${section.featured && idx === 0 ? 'featured' : ''}" 
                             id="card-${param}" 
                             style="${isHidden ? 'display:none' : ''}"
                             data-param="${param}">
                            <div class="chart-header">
                                <div class="chart-title-area">
                                    <div class="chart-title">${info.name}</div>
                                    <div class="chart-subtitle" id="unit-${param}">${isWind ? windUnit : info.unit}</div>
                                    ${isWind ? `
                                        <button class="unit-toggle" id="wind-unit-btn" title="Toggle kts/mph">
                                            ↔
                                        </button>
                                    ` : ''}
                                </div>
                                <div class="chart-actions">
                                    ${MODELS[state.model].cores.map(core => `
                                        <button class="active tooltip-trigger" data-core="${core.key}" data-param="${param}" data-tooltip="${core.tooltip}">${core.label || core.key}</button>
                                    `).join('')}
                                </div>
                            </div>
                            <div class="chart-body">
                                <div class="loading" id="loading-${param}">
                                    <div class="skeleton skeleton-chart"></div>
                                </div>
                                <canvas id="chart-${param}"></canvas>
                            </div>
                            <div class="axis-label">Forecast Time (Eastern)</div>
                            <div class="summary-row" id="summary-${param}" style="display:none">
                                <div class="summary-item">
                                    <span class="summary-label">Mean ${param.includes('3h') || param.includes('3hr') ? 'Peak' : 'Total'}</span>
                                    <span class="summary-value ${info.type}" id="mean-${param}">--</span>
                                </div>
                                <div class="summary-item">
                                    <span class="summary-label">Max</span>
                                    <span class="summary-value ${info.type}" id="max-${param}">--</span>
                                </div>
                                <div class="summary-item">
                                    <span class="summary-label">Min</span>
                                    <span class="summary-value ${info.type}" id="min-${param}">--</span>
                                </div>
                                <div class="summary-item">
                                    <span class="summary-label">Spread</span>
                                    <span class="summary-value ${info.type}" id="spread-${param}">--</span>
                                </div>
                                <button class="download-btn" data-param="${param}" title="Download as PNG">⬇ Save</button>
                            </div>
                        </div>
                    `;
        }).join('')}
            </div>
        `;
    }).join('');

    attachEventHandlers();
}

function attachEventHandlers() {
    // View toggle handlers
    document.querySelectorAll('.view-toggle').forEach(toggle => {
        toggle.addEventListener('click', e => {
            if (!e.target.dataset.view) return;

            const type = toggle.dataset.type;
            state.currentView[type] = e.target.dataset.view;
            toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            const section = toggle.closest('.chart-section');
            section.querySelectorAll('.chart-card').forEach(card => {
                const param = card.dataset.param;
                const isTotal = param.startsWith('Total');
                const shouldShow = (state.currentView[type] === 'total') === isTotal;
                card.style.display = shouldShow ? '' : 'none';
            });
        });
    });

    // Core toggle handlers
    document.querySelectorAll('.chart-actions button[data-core]').forEach(btn => {
        btn.addEventListener('click', () => {
            const param = btn.dataset.param;
            const core = btn.dataset.core;
            btn.classList.toggle('active');
            toggleCore(param, core);
        });
    });

    // Download button handlers
    document.querySelectorAll('.download-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const param = btn.dataset.param;
            exportChartPng(param, state.station, state.run, state.date);
        });
    });

    // Wind unit toggle handler
    const windUnitBtn = document.getElementById('wind-unit-btn');
    if (windUnitBtn) {
        windUnitBtn.addEventListener('click', () => {
            const newUnit = toggleWindUnit();
            // Update the unit label
            const unitLabel = document.getElementById('unit-3h-10mWND');
            if (unitLabel) unitLabel.textContent = newUnit;
            // Rebuild the wind chart with new unit
            if (state.data['3h-10mWND']) {
                createChart('3h-10mWND', state.data['3h-10mWND']);
                updateSummary('3h-10mWND', state.data['3h-10mWND']);
            }
        });
    }
}

// ============ Lazy Chart Rendering ============
// Fetching is cheap (cached JSON) but Chart.js instantiation of 26-line
// charts is not - defer rendering of below-fold charts until they scroll
// near the viewport.
const pendingRenders = new Map(); // param -> data
let chartObserver = null;

function ensureChartObserver() {
    if (chartObserver) return chartObserver;
    chartObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const param = entry.target.dataset.param;
            const data = pendingRenders.get(param);
            if (data) {
                pendingRenders.delete(param);
                createChart(param, data, getOverlayData(param), state.chartViewMode);
            }
            chartObserver.unobserve(entry.target);
        }
    }, { rootMargin: '250px' });
    return chartObserver;
}

function renderChart(param, data) {
    document.getElementById(`loading-${param}`)?.classList.add('hidden');
    updateSummary(param, data);

    const card = document.getElementById(`card-${param}`);
    if (!card || !('IntersectionObserver' in window)) {
        createChart(param, data, getOverlayData(param), state.chartViewMode);
        return;
    }

    const rect = card.getBoundingClientRect();
    const nearViewport = rect.top < window.innerHeight + 250 && rect.bottom > -250;
    if (nearViewport) {
        createChart(param, data, getOverlayData(param), state.chartViewMode);
    } else {
        pendingRenders.set(param, data);
        ensureChartObserver().observe(card);
    }
}

function rebuildCharts() {
    // Layout is regenerated - previous observers point at detached nodes
    pendingRenders.clear();
    buildLayout();
    for (const [param, data] of Object.entries(state.data)) {
        renderChart(param, data);
    }
}

// ============ Data Loading ============
async function loadChart(param) {
    const loading = document.getElementById(`loading-${param}`);
    if (!loading) return null;

    loading.classList.remove('hidden', 'error');

    try {
        const data = await fetchSREFData(state.station, state.run, param, state.date, MODELS[state.model].apiBase);

        // Check if we got actual data
        if (!data || Object.keys(data).length === 0) {
            throw new Error('No data available');
        }

        state.data[param] = data;
        renderChart(param, data);
        return data;
    } catch (err) {
        console.error(`Failed to load ${param}:`, err);
        loading.textContent = '';
        const label = document.createElement('span');
        label.className = 'error';
        label.textContent = 'No data';
        const detail = document.createElement('small');
        detail.style.color = '#666';
        detail.textContent = err.message;
        loading.append(label, document.createElement('br'), detail);
        return null;
    }
}

function updateSummary(param, data) {
    const info = CONFIG.params[param];
    const isTotal = param.startsWith('Total');
    const stats = getEnsembleStats(data, !isTotal);

    if (!stats) return;

    // Check if summary elements exist (they won't for params not in current layout, e.g., snow for dry locations)
    const summaryEl = document.getElementById(`summary-${param}`);
    if (!summaryEl) return;

    const isWind = info.type === 'wind';

    const fmt = (v) => {
        // Convert wind if needed
        const value = isWind ? convertWind(v) : v;
        if (info.type === 'temp') return value.toFixed(0) + '°';
        if (info.type === 'wind') return value.toFixed(0);
        return value.toFixed(2);
    };

    const meanEl = document.getElementById(`mean-${param}`);
    const maxEl = document.getElementById(`max-${param}`);
    const minEl = document.getElementById(`min-${param}`);
    const spreadEl = document.getElementById(`spread-${param}`);

    if (meanEl) meanEl.textContent = stats.mean !== null ? fmt(stats.mean) : '--';
    if (maxEl) maxEl.textContent = fmt(stats.max);
    if (minEl) minEl.textContent = fmt(stats.min);
    if (spreadEl) spreadEl.textContent = fmt(stats.spread);
    summaryEl.style.display = 'flex';
}

async function loadAllCharts() {
    if (state.isLoading) return;

    state.isLoading = true;
    elements.status.textContent = 'Loading...';
    elements.reloadBtn.disabled = true;
    state.data = {};

    try {
        // Check for snow first
        const snowData = await fetchSREFData(state.station, state.run, 'Total-SNO', state.date, MODELS[state.model].apiBase);
        state.data['Total-SNO'] = snowData;
        state.hasSnow = hasSnowForecast(snowData);

        // Update title (use site name from settings if available)
        const baseName = state.siteNameBase || 'SREF Ensemble Plumes';
        elements.pageTitle.innerHTML = state.hasSnow
            ? `${baseName} <span class="snow-alert">SNOW</span>`
            : baseName;

    } catch (err) {
        console.log('Snow check failed:', err);
        state.hasSnow = false;
    }

    // Build layout based on snow status
    buildLayout();

    // Render comparison controls
    renderComparisonControls();

    // Load all charts in parallel - the backend cache makes these cheap,
    // and serial loading multiplied worst-case latency by six
    const paramsToLoad = state.hasSnow ? CONFIG.snowOrder : CONFIG.defaultOrder;

    await Promise.all(paramsToLoad.map(param => {
        if (param === 'Total-SNO' && state.data['Total-SNO']) {
            renderChart(param, state.data['Total-SNO']);
            return Promise.resolve();
        }
        return loadChart(param);
    }));

    const now = new Date();
    elements.status.textContent = `${state.station} • ${state.run}Z`;
    elements.lastUpdate.textContent = `Updated ${now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/New_York'
    })} ET`;

    // Update weather summary
    updateWeatherSummary();

    // Precip-type timeline (REFS only - SREF has no p-type data)
    loadPtypeStrip();

    state.isLoading = false;
    elements.reloadBtn.disabled = false;

    // Fetch previous runs in background for trend comparison
    fetchPreviousRuns();
}

function getOverlayData(param) {
    const overlays = [];
    for (const [run, isVisible] of Object.entries(state.visibleRuns)) {
        if (!isVisible) continue;

        // Find data for this run
        const runData = state.previousRuns[run]?.[param];
        if (!runData) continue;

        // Find Mean line
        const meanPoints = runData['Mean'];
        if (meanPoints) {
            overlays.push({
                label: `${run}Z Mean`,
                data: meanPoints,
                color: RUN_COLORS[run] || '#888'
            });
        }
    }
    return overlays;
}

function renderComparisonControls() {
    // Inject controls into summary bar or new container
    const bar = elements.weatherSummary.parentElement;
    let controls = document.getElementById('runComparison');
    if (!controls) {
        controls = document.createElement('div');
        controls.id = 'runComparison';
        controls.className = 'run-comparison';
        bar.appendChild(controls);
    }

    // Only show other runs
    const allRuns = MODELS[state.model].runs;
    const otherRuns = allRuns.filter(r => r !== state.run);

    controls.innerHTML = `
        <span class="comp-label">Compare:</span>
        ${otherRuns.map(run => `
            <label class="run-toggle run-toggle-${run}">
                <input type="checkbox" value="${run}" ${state.visibleRuns[run] ? 'checked' : ''}>
                ${run}Z
            </label>
        `).join('')}
        <div class="chart-mode-toggle">
            <span class="comp-label">Chart:</span>
            <button class="mode-btn ${state.chartViewMode === 'spaghetti' ? 'active' : ''}" data-mode="spaghetti" title="Show individual ensemble member lines">Lines</button>
            <button class="mode-btn ${state.chartViewMode === 'bands' ? 'active' : ''}" data-mode="bands" title="Show confidence bands (P10-P90)">Bands</button>
            <button class="mode-btn ${state.chartViewMode === 'both' ? 'active' : ''}" data-mode="both" title="Show both lines and bands">Both</button>
        </div>
    `;

    // Run comparison listeners
    controls.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', async (e) => {
            state.visibleRuns[e.target.value] = e.target.checked;
            if (e.target.checked) {
                // May not be prefetched (mobile only prefetches the trend param)
                await ensureRunData(e.target.value);
            }
            rebuildCharts();
        });
    });

    // Chart mode toggle listeners
    controls.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const newMode = e.target.dataset.mode;
            if (newMode === state.chartViewMode) return;

            state.chartViewMode = newMode;
            localStorage.setItem('sref-chart-view-mode', newMode);

            // Update button states
            controls.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            // Rebuild charts with new mode
            rebuildCharts();
        });
    });
}

// ============ Previous Runs for Trend Comparison ============
/**
 * Get the date to use for a given run.
 * If the run hasn't completed yet today, use yesterday's date.
 * Completion times (~5h20m after run):
 *   03Z ready by ~08:20 UTC
 *   09Z ready by ~14:20 UTC
 *   15Z ready by ~20:20 UTC
 *   21Z ready by ~02:20 UTC (next day)
 */
function getDateForRun(run) {
    const now = Date.now();
    const todayUTC = new Date(now).toISOString().split('T')[0];
    const latestDate = getLatestRunWithDate(state.model).date;

    // Viewing a historical date: every run from that date already exists,
    // so compare runs from the SAME date instead of mixing in today's
    if (state.date !== todayUTC && state.date !== latestDate) {
        return state.date;
    }

    // Current view: use the most recent completed instance of this run -
    // today's if its ready time has passed, else yesterday's
    const lagMs = MODELS[state.model].readyLagHours * 3600000;
    for (const dayOffset of [0, -1]) {
        const day = new Date(now + dayOffset * 86400000);
        const runEpoch = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(),
            day.getUTCDate(), Number(run));
        if (runEpoch + lagMs <= now) {
            return new Date(runEpoch).toISOString().split('T')[0];
        }
    }
    return state.date;
}

/**
 * Fetch a previous run's data for all current params (used when a
 * comparison overlay is toggled on and its data isn't loaded yet)
 */
async function ensureRunData(run) {
    const paramsToFetch = state.hasSnow ? CONFIG.snowOrder : CONFIG.defaultOrder;
    if (!state.previousRuns[run]) state.previousRuns[run] = {};
    const dateForRun = getDateForRun(run);

    await Promise.all(paramsToFetch.map(async (param) => {
        if (state.previousRuns[run][param]) return;
        try {
            const data = await fetchSREFData(state.station, run, param, dateForRun, MODELS[state.model].apiBase);
            if (data && Object.keys(data).length > 0) {
                state.previousRuns[run][param] = data;
            }
        } catch {
            // Run/param combo not available
        }
    }));
}

async function fetchPreviousRuns() {
    const allRuns = MODELS[state.model].runs;
    const otherRuns = allRuns.filter(r => r !== state.run);

    // When no overlays are shown (the mobile default), only the summary
    // trend needs previous-run data - one param instead of six per run
    const anyOverlayVisible = otherRuns.some(r => state.visibleRuns[r]);
    const trendParam = state.hasSnow ? 'Total-SNO' : 'Total-QPF';

    // Clear previous data
    state.previousRuns = {};

    await Promise.all(otherRuns.map(async (run) => {
        if (anyOverlayVisible) {
            await ensureRunData(run);
        } else {
            state.previousRuns[run] = {};
            const dateForRun = getDateForRun(run);
            try {
                const data = await fetchSREFData(state.station, run, trendParam, dateForRun, MODELS[state.model].apiBase);
                if (data && Object.keys(data).length > 0) {
                    state.previousRuns[run][trendParam] = data;
                }
            } catch {
                // Run not available
            }
        }
    }));

    // Update UI
    updateTrendText();
    if (anyOverlayVisible) {
        rebuildCharts(); // Rebuild to show overlays
    }
}

function updateTrendText() {
    const param = state.hasSnow ? 'Total-SNO' : 'Total-QPF';
    const currentData = state.data[param];
    if (!currentData) return;

    const currentStats = getEnsembleStats(currentData, false);
    if (!currentStats) return;

    // Find the most recent previous run
    const allRuns = MODELS[state.model].runs;
    const currentIdx = allRuns.indexOf(state.run);
    const prevRun = allRuns[(currentIdx - 1 + 4) % 4]; // Previous in cycle

    const prevData = state.previousRuns[prevRun]?.[param];
    if (!prevData) return;

    const prevStats = getEnsembleStats(prevData, false);
    if (!prevStats) return;

    const delta = currentStats.mean - prevStats.mean;
    const absChange = Math.abs(delta);

    // Only show trend if meaningful change
    if (absChange < 0.1) return;

    const arrow = delta > 0 ? '↑' : '↓';
    const direction = delta > 0 ? 'higher' : 'lower';
    const unit = state.hasSnow ? 'in' : 'in';

    // Append trend to weather summary
    const summaryEl = elements.weatherSummary;
    if (summaryEl && !summaryEl.innerHTML.includes('vs')) {
        summaryEl.innerHTML += ` <span class="trend-text">${arrow} trending ${direction} vs ${prevRun}Z (${delta > 0 ? '+' : ''}${delta.toFixed(1)} ${unit})</span>`;
    }
}

// ============ Custom Station ============
function handleCustomStation() {
    console.log('Custom station triggered');
    const input = elements.customStation.value.trim().toUpperCase();

    // Allow 3 or 4 letter station codes
    if (!input || input.length < 3 || input.length > 4) {
        console.log('Invalid length:', input.length);
        return;
    }

    if (!/^[A-Z]{3,4}$/.test(input)) {
        console.log('Invalid charset');
        return;
    }

    // Update local storage and state
    console.log('Switching to custom station:', input);
    localStorage.setItem('sref-custom-station', input);
    localStorage.setItem('sref-last-station', input);

    // Update UI
    document.querySelectorAll('#stationBtns button').forEach(b => b.classList.remove('active'));
    // If the input matches a button, active it, otherwise just load
    const existingBtn = document.querySelector(`#stationBtns button[data-val="${input}"]`);
    if (existingBtn) existingBtn.classList.add('active');

    state.station = input;
    updateShareUrl();
    loadAllCharts();
}

// ============ Weather Summary ============
function updateWeatherSummary() {
    if (!elements.weatherSummary) return;

    const snowData = state.data['Total-SNO'];
    const precipData = state.data['Total-QPF'];

    if (snowData) {
        const stats = getEnsembleStats(snowData, false);
        if (stats && stats.max > 0.5) {
            const confidence = getConfidenceLevel(stats.spread);
            const range = `${stats.min.toFixed(1)}-${stats.max.toFixed(1)}`;
            elements.weatherSummary.innerHTML = `
                <span class="snow-icon">❄</span>
                <strong>Snow likely:</strong> ${range} in expected 
                <span class="${confidence.class}">(${confidence.text})</span>
            `;
            return;
        }
    }

    if (precipData) {
        const stats = getEnsembleStats(precipData, false);
        if (stats && stats.max > 0.1) {
            const confidence = getConfidenceLevel(stats.spread);
            const range = `${stats.min.toFixed(2)}-${stats.max.toFixed(2)}`;
            elements.weatherSummary.innerHTML = `
                <strong>Rain likely:</strong> ${range} in expected 
                <span class="${confidence.class}">(${confidence.text})</span>
            `;
            return;
        }
    }

    elements.weatherSummary.textContent = 'Dry conditions expected';
}

// ============ Precip Type (REFS) ============
const PTYPE_DEFS = [
    { key: 'snow', label: 'Snow', color: '#a5d8ff' },
    { key: 'rain', label: 'Rain', color: '#51cf66' },
    { key: 'zr', label: 'Frz rain', color: '#ff8787' },
    { key: 'ip', label: 'Sleet', color: '#da77f2' },
];

/**
 * REFS members carry per-hour precip-type flags. Show a colored timeline
 * strip (dominant type per hour, >=40% of members) plus transition text
 * like "Rain -> Snow Tue 7 PM".
 */
async function loadPtypeStrip() {
    const existing = document.getElementById('ptypeStrip');
    if (state.model !== 'refs') {
        existing?.remove();
        return;
    }

    try {
        const data = await fetchSREFData(state.station, state.run, 'ptype', state.date, MODELS.refs.apiBase);
        if (!Array.isArray(data) || data.length === 0) throw new Error('no ptype');

        // Dominant type per hour
        const hours = data.map(pt => {
            let best = null, bestFrac = 0;
            for (const t of PTYPE_DEFS) {
                if (pt[t.key] > bestFrac) { bestFrac = pt[t.key]; best = t; }
            }
            return { x: pt.x, type: bestFrac >= 0.4 ? best : null };
        });

        if (!hours.some(h => h.type)) {
            existing?.remove();
            return;
        }

        // Merge consecutive hours into segments
        const segments = [];
        for (const h of hours) {
            const last = segments[segments.length - 1];
            if (last && last.type === h.type) last.count++;
            else segments.push({ type: h.type, count: 1, startX: h.x });
        }

        // Transition text: onset + type changes (skip gaps shorter than 2h)
        const fmtTime = x => new Date(x).toLocaleString('en-US', {
            weekday: 'short', hour: 'numeric', timeZone: 'America/New_York'
        });
        const events = [];
        let prevType = null;
        for (const seg of segments) {
            if (!seg.type || seg.count < 2) continue;
            if (!prevType) {
                events.push(`${seg.type.label} ${fmtTime(seg.startX)}`);
            } else if (seg.type !== prevType) {
                events.push(`${seg.type.label.toLowerCase()} ${fmtTime(seg.startX)}`);
            } else {
                continue;
            }
            prevType = seg.type;
        }

        let strip = existing;
        if (!strip) {
            strip = document.createElement('div');
            strip.id = 'ptypeStrip';
            strip.className = 'ptype-strip';
            elements.weatherSummary.parentElement.appendChild(strip);
        }
        strip.textContent = '';

        const text = document.createElement('div');
        text.className = 'ptype-text';
        text.textContent = 'P-type: ' + events.slice(0, 3).join(' → ');
        strip.appendChild(text);

        const bar = document.createElement('div');
        bar.className = 'ptype-bar';
        for (const seg of segments) {
            const el = document.createElement('div');
            el.className = 'ptype-seg';
            el.style.flexGrow = String(seg.count);
            el.style.background = seg.type ? seg.type.color : 'transparent';
            el.title = (seg.type ? seg.type.label : 'No precip') + ' from ' + fmtTime(seg.startX);
            bar.appendChild(el);
        }
        strip.appendChild(bar);
    } catch (err) {
        console.log('[PTYPE]', err.message);
        existing?.remove();
    }
}

function getConfidenceLevel(spread) {
    if (spread < 1) return { text: 'high confidence', class: 'high-confidence' };
    if (spread < 3) return { text: 'moderate spread', class: 'moderate-confidence' };
    return { text: 'low agreement', class: 'low-confidence' };
}

// ============ Help Modal ============
function showHelpModal() {
    // Create modal if it doesn't exist
    let modal = document.getElementById('helpModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'helpModal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content">
                <h2>Understanding Ensemble Plumes</h2>
                <p>This tool visualizes forecast data from NOAA's <strong>Short Range Ensemble Forecast (SREF)</strong> model, providing probabilistic weather forecasts up to 87 hours ahead.</p>

                <h3>SREF vs REFS</h3>
                <p>SREF retires on <strong>August 31, 2026</strong>. Its successor is <strong>REFS</strong> (the RRFS ensemble): 5 members at 3km resolution with <strong>hourly</strong> output to 60 hours, cycles at 00Z/06Z/12Z/18Z. Use the model toggle in the header to switch. REFS has a single model core, so there is no ARW/NMB split - just Members and Mean.</p>
                
                <h3>What are the colored lines?</h3>
                <p>Each line represents a different "ensemble member" - a model run with slightly different initial conditions or physics settings. The <strong>26 members</strong> span a range of possible outcomes, helping show forecast uncertainty.</p>
                
                <h3>ARW vs NMB Cores</h3>
                <ul>
                    <li><strong>ARW</strong> (red/warm tones) - Advanced Research WRF dynamical core (13 members)</li>
                    <li><strong>NMB</strong> (blue/cool tones) - NEMS-NMMB dynamical core (13 members)</li>
                </ul>
                <p>These use different physics packages. When both cores agree, forecast confidence is higher. Disagreement indicates model uncertainty.</p>
                
                <h3>The Mean Line</h3>
                <p>The thick white line is the <strong>ensemble mean</strong> - the average of all 26 members. It's typically the most reliable single forecast value and smooths out individual member noise.</p>
                
                <h3>Model Run Schedule</h3>
                <p>SREF runs 4 times daily at 03Z, 09Z, 15Z, and 21Z (UTC). Data becomes available <strong>5 to 5.5 hours</strong> after each run initiates:</p>
                <ul>
                    <li><strong>03Z run</strong> → available ~8:20 AM UTC (3:20 AM EST)</li>
                    <li><strong>09Z run</strong> → available ~2:20 PM UTC (9:20 AM EST)</li>
                    <li><strong>15Z run</strong> → available ~8:20 PM UTC (3:20 PM EST)</li>
                    <li><strong>21Z run</strong> → available ~2:20 AM UTC (9:20 PM EST)</li>
                </ul>
                <p>The app automatically selects the most recent available run.</p>
                
                <h3>Reading the Charts</h3>
                <ul>
                    <li><strong>Tight clustering</strong> = High confidence in forecast</li>
                    <li><strong>Wide spread</strong> = Uncertain forecast, multiple outcomes possible</li>
                    <li><strong>ARW/NMB split</strong> = Models disagree, watch for updates</li>
                    <li><strong>Mean near edge</strong> = Possible for bigger/smaller totals</li>
                </ul>
                
                <h3>Summary Statistics</h3>
                <p>Each chart shows Mean, Max, Min, and Spread values. For snow/precip, lower spread indicates higher confidence in the expected amount.</p>
                
                <button class="btn" onclick="this.closest('.modal-overlay').remove()">Got it!</button>
            </div>
        `;
        document.body.appendChild(modal);

        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }
}

// ============ Start Application ============
document.addEventListener('DOMContentLoaded', init);

