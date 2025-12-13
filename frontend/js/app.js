/**
 * SREF Viewer - Main Application
 * Orchestrates UI, state management, and data loading
 */

import { CONFIG, getLatestRun, isMobile, toggleWindUnit, getWindUnit, convertWind } from './config.js';
import { fetchSREFData, hasSnowForecast, getEnsembleStats } from './api.js';
import { createChart, toggleCore } from './charts.js';

// ============ Application State ============
const state = {
    station: 'JFK',
    date: new Date().toISOString().split('T')[0],
    run: null, // Will be set by initializeRunSelection
    data: {},
    hasSnow: false,
    currentView: { snow: 'total', precip: 'total' },
    isLoading: false
};

// ============ DOM Elements ============
const elements = {
    pageTitle: null,
    mainContent: null,
    stationBtns: null,
    dateInput: null,
    runSelect: null,
    timeDisplay: null,
    reloadBtn: null,
    status: null,
    lastUpdate: null
};

// ============ Initialization ============
async function init() {
    // Cache DOM elements
    elements.pageTitle = document.getElementById('pageTitle');
    elements.mainContent = document.getElementById('mainContent');
    elements.stationBtns = document.getElementById('stationBtns');
    elements.dateInput = document.getElementById('dateInput');
    elements.runSelect = document.getElementById('runSelect');
    elements.timeDisplay = document.getElementById('timeDisplay');
    elements.reloadBtn = document.getElementById('reloadBtn');
    elements.status = document.getElementById('status');
    elements.lastUpdate = document.getElementById('lastUpdate');

    // Set initial date
    elements.dateInput.value = state.date;

    // Update time display
    updateTimeDisplay();
    setInterval(updateTimeDisplay, 60000); // Update every minute

    // Event listeners
    elements.stationBtns.addEventListener('click', handleStationClick);
    elements.dateInput.addEventListener('change', handleDateChange);
    elements.runSelect.addEventListener('change', handleRunChange);
    elements.reloadBtn.addEventListener('click', () => loadAllCharts());

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
                                    <button class="active" data-core="ARW" data-param="${param}">ARW</button>
                                    <button class="active" data-core="NMB" data-param="${param}">NMB</button>
                                    <button class="active" data-core="Mean" data-param="${param}">Mean</button>
                                </div>
                            </div>
                            <div class="chart-body">
                                <div class="loading" id="loading-${param}">Loading...</div>
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
    document.querySelectorAll('.chart-actions button').forEach(btn => {
        btn.addEventListener('click', () => {
            const param = btn.dataset.param;
            const core = btn.dataset.core;
            btn.classList.toggle('active');
            toggleCore(param, core);
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

    // Load all charts
    const paramsToLoad = state.hasSnow ? CONFIG.snowOrder : CONFIG.defaultOrder;

    for (const param of paramsToLoad) {
        if (param === 'Total-SNO' && state.data['Total-SNO']) {
            createChart(param, state.data['Total-SNO']);
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

    state.isLoading = false;
    elements.reloadBtn.disabled = false;
}

// ============ Start Application ============
document.addEventListener('DOMContentLoaded', init);
