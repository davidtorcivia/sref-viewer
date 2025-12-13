/**
 * SREF Viewer - Main Application
 * Orchestrates UI, state management, and data loading
 */

import { CONFIG, getLatestRun, isMobile, toggleWindUnit, getWindUnit, convertWind } from './config.js';
import { fetchSREFData, hasSnowForecast, getEnsembleStats } from './api.js';
import { createChart, toggleCore, downloadChart } from './charts.js';

// ============ Application State ============
const state = {
    station: 'JFK',
    date: new Date().toISOString().split('T')[0],
    run: null, // Will be set by initializeRunSelection
    data: {},
    hasSnow: false,
    currentView: { snow: 'total', precip: 'total' },
    isLoading: false,
    // Run comparison feature
    previousRuns: {}, // { '03': { param: data }, '09': { param: data }, ... }
    visibleRuns: {}, // { '03': true, '09': false, ... } - which runs to overlay
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

    // Load custom station from localStorage
    const savedStation = localStorage.getItem('sref-custom-station');
    if (savedStation) {
        elements.customStation.value = savedStation;
    }

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

    // Initialize run selection and load data
    initializeRunSelection();
}

// ============ Run Selection ============
/**
 * Initialize run selection based on time logic.
 * - All runs are always selectable (older data should always exist)
 * - Auto-select the run that's most likely to have data based on current time
 * - If data isn't ready, user sees a loading error but can try again later
 */
function initializeRunSelection() {
    // All runs are always enabled - user can select any
    const options = elements.runSelect.querySelectorAll('option');
    options.forEach(opt => {
        opt.disabled = false;
        opt.textContent = `${opt.value}Z`;
    });

    // Auto-select the most likely available run based on current UTC time
    state.run = getLatestRun();
    elements.runSelect.value = state.run;

    loadAllCharts();
}

// ============ Event Handlers ============
function handleStationClick(e) {
    if (!e.target.dataset.val || state.isLoading) return;

    document.querySelectorAll('#stationBtns button').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    state.station = e.target.dataset.val;
    loadAllCharts();
}

function handleDateChange(e) {
    state.date = e.target.value;
    loadAllCharts();
}

function handleRunChange(e) {
    if (state.isLoading) return;
    state.run = e.target.value;
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
                                <div class="loading" id="loading-${param}">Loading...</div>
                                <canvas id="chart-${param}"></canvas>
                                <button class="download-btn" data-param="${param}" title="Download as PNG">⬇</button>
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
            downloadChart(param, state.station, state.run);
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
        createChart(param, data);
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
        createChart(param, data);
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

    const isWind = info.type === 'wind';

    const fmt = (v) => {
        // Convert wind if needed
        const value = isWind ? convertWind(v) : v;
        if (info.type === 'temp') return value.toFixed(0) + '°';
        if (info.type === 'wind') return value.toFixed(0);
        return value.toFixed(2);
    };

    document.getElementById(`mean-${param}`).textContent = stats.mean !== null ? fmt(stats.mean) : '--';
    document.getElementById(`max-${param}`).textContent = fmt(stats.max);
    document.getElementById(`min-${param}`).textContent = fmt(stats.min);
    document.getElementById(`spread-${param}`).textContent = fmt(stats.spread);
    document.getElementById(`summary-${param}`).style.display = 'flex';
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

        // Update title
        elements.pageTitle.innerHTML = state.hasSnow
            ? `NYC SREF Plumes <span class="snow-alert">❄ SNOW</span>`
            : `NYC SREF Ensemble Plumes`;

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
            createChart(param, state.data['Total-SNO'], getOverlayData('Total-SNO'));
            document.getElementById(`loading-${param}`)?.classList.add('hidden');
            updateSummary(param, state.data['Total-SNO']);
        } else {
            loadChart(param);
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
    // We'll append to summary-bar for now
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
    `;

    // Add listeners
    controls.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', (e) => {
            state.visibleRuns[e.target.value] = e.target.checked;
            rebuildCharts();
        });
    });
}

// ============ Previous Runs for Trend Comparison ============
async function fetchPreviousRuns() {
    const allRuns = ['03', '09', '15', '21'];
    const otherRuns = allRuns.filter(r => r !== state.run);

    // Clear previous data
    state.previousRuns = {};

    // Fetch each run's data in parallel
    for (const run of otherRuns) {
        try {
            // Just fetch the main parameter for trend comparison (use snow or precip)
            const param = state.hasSnow ? 'Total-SNO' : 'Total-QPF';
            const data = await fetchSREFData(state.station, run, param, state.date);

            if (data && Object.keys(data).length > 0) {
                state.previousRuns[run] = { [param]: data };
                console.log(`[TREND] Loaded ${run}Z ${param}`);
            }
        } catch (err) {
            console.log(`[TREND] ${run}Z not available:`, err.message);
        }
    }

    // Update trend text
    updateTrendText();
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

    // Update UI
    document.querySelectorAll('#stationBtns button').forEach(b => b.classList.remove('active'));
    // If the input matches a button, active it, otherwise just load
    const existingBtn = document.querySelector(`#stationBtns button[data-val="${input}"]`);
    if (existingBtn) existingBtn.classList.add('active');

    state.station = input;
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
                <p>This tool visualizes forecast data from NOAA's <strong>Short Range Ensemble Forecast (SREF)</strong> model.</p>
                
                <h3>What are the colored lines?</h3>
                <p>Each line represents a different "ensemble member" - a slightly different model run. Having multiple runs helps show forecast uncertainty.</p>
                
                <h3>ARW vs NMB</h3>
                <ul>
                    <li><strong>ARW</strong> (red tones) - Advanced Research WRF dynamical core</li>
                    <li><strong>NMB</strong> (blue tones) - NEMS-NMMB dynamical core</li>
                </ul>
                <p>These are two different physics configurations. When they agree, confidence is higher.</p>
                
                <h3>The Mean Line</h3>
                <p>The thick white/black line is the <strong>ensemble mean</strong> - the average of all 26 members. It's often the best single forecast.</p>
                
                <h3>Model Runs</h3>
                <p>SREF runs 4 times daily: 03Z, 09Z, 15Z, 21Z (UTC). Data is typically available ~2 hours after each run.</p>
                
                <h3>Tips</h3>
                <ul>
                    <li>Tight clustering = high confidence</li>
                    <li>Wide spread = uncertain forecast</li>
                    <li>ARW/NMB disagreement = model uncertainty</li>
                </ul>
                
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

