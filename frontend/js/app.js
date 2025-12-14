/**
 * SREF Viewer - Main Application
 * Orchestrates UI, state management, and data loading
 */

import { CONFIG, getLatestRun, getLatestRunWithDate, isMobile, toggleWindUnit, getWindUnit, convertWind } from './config.js';
import { fetchSREFData, hasSnowForecast, getEnsembleStats } from './api.js';
import { createChart, toggleCore, exportChartPng } from './charts.js';

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
    station: 'JFK',
    date: getLocalDateString(),
    run: null, // Will be set by initializeRunSelection
    data: {},
    hasSnow: false,
    currentView: { snow: 'total', precip: 'total' },
    isLoading: false,
    // Run comparison feature
    previousRuns: {}, // { '03': { param: data }, '09': { param: data }, ... }
    visibleRuns: { '03': true, '09': true, '15': true, '21': true }, // All checked by default
    // Chart display mode: 'spaghetti' (individual lines) or 'bands' (confidence bands)
    chartViewMode: localStorage.getItem('sref-chart-view-mode') || 'spaghetti',
};

// Run colors for comparison overlay
const RUN_COLORS = {
    '03': '#ff9f43',  // orange
    '09': '#10ac84',  // green
    '15': '#ee5a24',  // red
    '21': '#8854d0',  // purple
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
    const urlStation = urlParams.get('station');
    const urlRun = urlParams.get('run');
    const urlDate = urlParams.get('date');

    // Apply URL params if present (highest priority)
    if (urlStation) state.station = urlStation.toUpperCase();
    if (urlRun && ['03', '09', '15', '21'].includes(urlRun)) state.run = urlRun;
    if (urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)) state.date = urlDate;

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

    // Handle resize for responsive charts
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (Object.keys(state.data).length > 0) {
                rebuildCharts();
            }
        }, 250);
    });

    // Load site settings from admin panel
    await loadSiteSettings();

    // Initialize run selection and load data
    initializeRunSelection();
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
function initializeRunSelection() {
    // All runs are always enabled - user can select any
    const options = elements.runSelect.querySelectorAll('option');
    options.forEach(opt => {
        opt.disabled = false;
        opt.textContent = `${opt.value}Z`;
    });

    // Auto-select the most likely available run AND correct date
    const { run, date } = getLatestRunWithDate();
    state.run = run;
    state.date = date;
    elements.runSelect.value = run;
    elements.dateInput.value = date;

    loadAllCharts();
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
                                    <button class="active tooltip-trigger" data-core="ARW" data-param="${param}" data-tooltip="Advanced Research WRF core (red lines)">ARW</button>
                                    <button class="active tooltip-trigger" data-core="NMB" data-param="${param}" data-tooltip="NEMS-NMMB core (blue lines)">NMB</button>
                                    <button class="active tooltip-trigger" data-core="Mean" data-param="${param}" data-tooltip="Average of all 26 ensemble members">Mean</button>
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

function rebuildCharts() {
    buildLayout();
    for (const [param, data] of Object.entries(state.data)) {
        createChart(param, data, getOverlayData(param), state.chartViewMode);
        document.getElementById(`loading-${param}`)?.classList.add('hidden');
        updateSummary(param, data);
    }
}

// ============ Data Loading ============
async function loadChart(param) {
    const loading = document.getElementById(`loading-${param}`);
    if (!loading) return null;

    loading.textContent = 'Loading...';
    loading.classList.remove('hidden', 'error');

    try {
        const data = await fetchSREFData(state.station, state.run, param, state.date);

        // Check if we got actual data
        if (!data || Object.keys(data).length === 0) {
            throw new Error('No data available');
        }

        state.data[param] = data;
        createChart(param, data, getOverlayData(param), state.chartViewMode);
        loading.classList.add('hidden');
        updateSummary(param, data);
        return data;
    } catch (err) {
        console.error(`Failed to load ${param}:`, err);
        loading.innerHTML = `<span class="error">No data</span><br><small style="color:#666">${err.message}</small>`;
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
        const snowData = await fetchSREFData(state.station, state.run, 'Total-SNO', state.date);
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

    // Load all charts
    const paramsToLoad = state.hasSnow ? CONFIG.snowOrder : CONFIG.defaultOrder;

    for (const param of paramsToLoad) {
        if (param === 'Total-SNO' && state.data['Total-SNO']) {
            createChart(param, state.data['Total-SNO'], getOverlayData('Total-SNO'), state.chartViewMode);
            document.getElementById(`loading-${param}`)?.classList.add('hidden');
            updateSummary(param, state.data['Total-SNO']);
        } else {
            await loadChart(param);
        }
    }

    const now = new Date();
    elements.status.textContent = `${state.station} • ${state.run}Z`;
    elements.lastUpdate.textContent = `Updated ${now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/New_York'
    })} ET`;

    // Update weather summary
    updateWeatherSummary();

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
    const allRuns = ['03', '09', '15', '21'];
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
        </div>
    `;

    // Run comparison listeners
    controls.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', (e) => {
            state.visibleRuns[e.target.value] = e.target.checked;
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
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const utcTime = utcHour + utcMinute / 60;

    // Completion times in decimal UTC hours
    const completionTimes = {
        '03': 8.33,   // 08:20 UTC
        '09': 14.33,  // 14:20 UTC
        '15': 20.33,  // 20:20 UTC
        '21': 2.33    // 02:20 UTC (next day, special handling)
    };

    const runCompleteTime = completionTimes[run];

    // 21Z is special - it completes after midnight UTC
    // If we're before 02:20 UTC, 21Z from TODAY hasn't completed, use yesterday
    // If we're after 02:20 UTC but 21Z is still "future", it means today's 21Z hasn't run
    let needsYesterday;
    if (run === '21') {
        // 21Z completes at 02:20 UTC next day
        // Use today's date only if utcTime >= 2.33 (meaning yesterday's 21Z completed)
        // But we want yesterday's 21Z data, not today's (which hasn't run)
        needsYesterday = utcTime < 2.33 || utcTime >= 21; // Before 02:20 or after 21:00
    } else {
        // For other runs, use yesterday if current time < completion time
        needsYesterday = utcTime < runCompleteTime;
    }

    if (needsYesterday) {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const year = yesterday.getFullYear();
        const month = String(yesterday.getMonth() + 1).padStart(2, '0');
        const day = String(yesterday.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    return state.date;
}

async function fetchPreviousRuns() {
    const allRuns = ['03', '09', '15', '21'];
    const otherRuns = allRuns.filter(r => r !== state.run);

    // Get params to fetch based on current view
    const paramsToFetch = state.hasSnow ? CONFIG.snowOrder : CONFIG.defaultOrder;

    // Clear previous data
    state.previousRuns = {};

    // Fetch each run's data
    for (const run of otherRuns) {
        state.previousRuns[run] = {};
        const dateForRun = getDateForRun(run);

        for (const param of paramsToFetch) {
            try {
                const data = await fetchSREFData(state.station, run, param, dateForRun);
                if (data && Object.keys(data).length > 0) {
                    state.previousRuns[run][param] = data;
                }
            } catch (err) {
                // Silent fail - run/param combo not available
            }
        }

        const loadedCount = Object.keys(state.previousRuns[run]).length;
        if (loadedCount > 0) {
            console.log(`[TREND] Loaded ${run}Z (${dateForRun}): ${loadedCount} params`);
        }
    }

    // Update UI
    updateTrendText();
    rebuildCharts(); // Rebuild to show overlays
}

function updateTrendText() {
    const param = state.hasSnow ? 'Total-SNO' : 'Total-QPF';
    const currentData = state.data[param];
    if (!currentData) return;

    const currentStats = getEnsembleStats(currentData, false);
    if (!currentStats) return;

    // Find the most recent previous run
    const allRuns = ['03', '09', '15', '21'];
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
                <h2>Understanding SREF Ensemble Plumes</h2>
                <p>This tool visualizes forecast data from NOAA's <strong>Short Range Ensemble Forecast (SREF)</strong> model, providing probabilistic weather forecasts up to 87 hours ahead.</p>
                
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

