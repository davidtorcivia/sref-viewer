/**
 * Chart.js Configuration and Rendering
 * Handles all chart creation and updates
 */
import { CONFIG, isMobile, isTouchDevice, convertWind, getWindUnit, formatValue } from './config.js?v=__V__';
import { getPercentileBands } from './api.js?v=__V__';

// Store chart instances for cleanup
const chartInstances = {};

/**
 * Get responsive chart options based on screen size
 */
function getResponsiveOptions() {
    const mobile = isMobile();
    return {
        tickFontSize: mobile ? 10 : 11,
        stepSize: mobile ? 12 : 6,
        meanLineWidth: 4,
        memberLineWidth: mobile ? 1.3 : 1.1,
    };
}

Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

/**
 * Theme colors come from the stylesheet tokens so charts match the chrome
 * in both color schemes
 */
function getThemeColors() {
    const css = getComputedStyle(document.documentElement);
    const token = name => css.getPropertyValue(name).trim();
    return {
        gridColor: token('--chart-grid'),
        tickColor: token('--chart-tick'),
        meanLineColor: token('--chart-mean'),
        memberColor: token('--chart-member'),
        bandOuter: token('--chart-band-outer'),
        bandInner: token('--chart-band-inner'),
        surface: token('--surface'),
        crosshair: token('--chart-crosshair'),
        nowLineColor: token('--chart-now'),
        nowLabelBg: token('--chart-mean'),
        nowLabelText: token('--surface'),
    };
}

/**
 * Create or update a chart
 * @param {string} param - Parameter name
 * @param {Object} data - Ensemble data
 * @param {Array} overlayData - Array of { label, data, color } for overlays
 * @param {string} viewMode - 'spaghetti' (default) or 'bands' for confidence bands
 * @returns {Chart} Chart instance
 */
export function createChart(param, data, overlayData = [], viewMode = 'spaghetti') {
    const info = CONFIG.params[param];
    const responsive = getResponsiveOptions();
    const theme = getThemeColors();
    const datasets = [];

    // Check if this is wind data - we may need to convert
    const isWind = info.type === 'wind';

    // 1. Find the time range from main data to truncate overlays
    let minTime = Infinity, maxTime = -Infinity;
    for (const points of Object.values(data)) {
        if (!points || points.length === 0) continue;
        for (const p of points) {
            if (p.x < minTime) minTime = p.x;
            if (p.x > maxTime) maxTime = p.x;
        }
    }

    // 2. Add Overlay Datasets (Previous Runs) - TRUNCATED to main data range
    if (overlayData && overlayData.length > 0) {
        for (const overlay of overlayData) {
            const points = overlay.data;
            if (!points || points.length === 0) continue;

            const filteredPoints = points.filter(p => p.x >= minTime && p.x <= maxTime);
            if (filteredPoints.length === 0) continue;

            const chartPoints = isWind
                ? filteredPoints.map(p => ({ x: p.x, y: convertWind(p.y) }))
                : filteredPoints;

            datasets.push({
                label: overlay.label,
                data: chartPoints,
                borderColor: overlay.color,
                borderWidth: 1.5,
                pointRadius: 0,
                pointHitRadius: 20,
                pointHoverRadius: 0,
                tension: 0.3,
                fill: false,
                order: 5,
                _overlay: true,
            });
        }
    }

    // Which member families are present? SREF has ARW (AR*) + NMB (MB*)
    // cores; REFS members (M01..) form a single group.
    const memberLabels = Object.keys(data).filter(l => l !== 'Mean');
    const hasARW = memberLabels.some(l => l.startsWith('AR'));
    const hasNMB = memberLabels.some(l => l.startsWith('MB'));

    // 3. Add main datasets based on view mode
    // Add confidence bands (for 'bands' or 'both' mode)
    if (viewMode === 'bands' || viewMode === 'both') {
        // Convert wind data if needed
        const convertPoints = (points) => isWind
            ? points.map(p => ({ x: p.x, y: convertWind(p.y) }))
            : points;

        const bandGroups = [];
        // Both SREF cores in the same ink: where they agree the bands stack darker
        if (hasARW) bandGroups.push({ name: 'ARW', core: 'ARW', filter: 'ARW' });
        if (hasNMB) bandGroups.push({ name: 'NMB', core: 'NMB', filter: 'NMB' });
        if (!hasARW && !hasNMB) {
            // Single-family ensemble (REFS): one band set over all members
            bandGroups.push({ name: 'ENS', core: 'Mean', filter: null });
        }

        for (const group of bandGroups) {
            const bands = getPercentileBands(data, group.filter);
            if (!bands) continue;

            // Outer band: P90 filling down to a hidden P10 boundary
            // Inner band: P75 filling down to a hidden P25 boundary (darker)
            const layers = [
                { lo: bands.p10, hi: bands.p90, loName: 'P10', hiName: 'P90', order: 4, fill: theme.bandOuter },
                { lo: bands.p25, hi: bands.p75, loName: 'P25', hiName: 'P75', order: 3, fill: theme.bandInner },
            ];
            for (const layer of layers) {
                datasets.push({
                    label: `${group.name} ${layer.loName}`,
                    data: convertPoints(layer.lo),
                    borderColor: 'transparent',
                    borderWidth: 0,
                    pointRadius: 0,
                    pointHitRadius: 0,
                    pointHoverRadius: 0,
                    tension: 0.3,
                    fill: false,
                    order: layer.order,
                    _band: true,
                    _core: group.core
                });
                datasets.push({
                    label: `${group.name} ${layer.hiName}`,
                    data: convertPoints(layer.hi),
                    borderColor: 'transparent',
                    borderWidth: 0,
                    pointRadius: 0,
                    pointHitRadius: 0,
                    pointHoverRadius: 0,
                    tension: 0.3,
                    fill: {
                        target: datasets.length - 1,
                        above: layer.fill,
                        below: layer.fill
                    },
                    order: layer.order,
                    _band: true,
                    _core: group.core
                });
            }
        }

        // Add Mean line on top (only if in pure bands mode - otherwise it comes with spaghetti)
        if (viewMode === 'bands') {
            const meanPoints = data['Mean'];
            if (meanPoints && meanPoints.length > 0) {
                const chartPoints = isWind
                    ? meanPoints.map(p => ({ x: p.x, y: convertWind(p.y) }))
                    : meanPoints;

                datasets.push({
                    label: 'Mean',
                    data: chartPoints,
                    borderColor: theme.meanLineColor,
                    borderWidth: responsive.meanLineWidth,
                    pointRadius: 0,
                    pointHitRadius: 20,
                    pointHoverRadius: 0,
                    tension: 0.3,
                    fill: false,
                    order: 0,
                    _core: 'Mean'
                });
            }
        }
    }

    // Add spaghetti lines (for 'spaghetti' or 'both' mode)
    if (viewMode === 'spaghetti' || viewMode === 'both') {
        for (const [label, points] of Object.entries(data)) {
            if (points.length === 0) continue;

            const isMean = label === 'Mean';
            const core = isMean ? 'Mean'
                : label.startsWith('AR') ? 'ARW'
                    : label.startsWith('MB') ? 'NMB'
                        : 'MEM';  // REFS members (M01..M05)

            const chartPoints = isWind
                ? points.map(p => ({ x: p.x, y: convertWind(p.y) }))
                : points;

            // Ink throughout: mean heavy, RRFS (deterministic) dashed,
            // members faint (NMB dashed so the two SREF cores stay apart)
            const isRRFS = label === 'RRFS';
            datasets.push({
                label,
                data: chartPoints,
                borderColor: isMean || isRRFS ? theme.meanLineColor : theme.memberColor,
                borderWidth: isMean ? responsive.meanLineWidth : isRRFS ? 1.75 : responsive.memberLineWidth,
                borderDash: isRRFS ? [6, 4] : core === 'NMB' ? [4, 3] : [],
                pointRadius: 0,
                pointHitRadius: 20,
                pointHoverRadius: 0,
                tension: 0.3,
                fill: false,
                order: isMean ? 0 : 1,
                _core: core
            });
        }
    }

    // Destroy existing chart if present
    if (chartInstances[param]) {
        chartInstances[param].destroy();
    }

    const canvas = document.getElementById(`chart-${param}`);
    if (!canvas) {
        console.warn(`[CHART] Canvas not found for ${param}, skipping`);
        return null;
    }

    const touch = isTouchDevice();
    const chart = chartInstances[param] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { datasets },
        plugins: [crosshairPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            // Nearest in time, not by array index: REFS mixes hourly RRFS
            // with 3-hourly ensemble series
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            // Touch: no compat mouse/click events, which would re-arm the
            // crosshair at the tap point after the finger lifts
            events: touch ? ['touchstart', 'touchmove', 'mouseout'] : ['mousemove', 'mouseout', 'touchstart', 'touchmove'],
            plugins: {
                legend: { display: false },
                annotation: {
                    annotations: {
                        nowLine: {
                            type: 'line',
                            xMin: Date.now(),
                            xMax: Date.now(),
                            borderColor: theme.nowLineColor,
                            borderWidth: 1.5,
                            borderDash: [3, 4],
                            label: {
                                display: true,
                                content: 'NOW',
                                position: 'start',
                                backgroundColor: theme.nowLabelBg,
                                borderWidth: 0,
                                borderRadius: 4,
                                padding: { x: 6, y: 3 },
                                color: theme.nowLabelText,
                                font: { size: 10, weight: '700' }
                            }
                        }
                    }
                },
                // The floating box sat under the finger on phones: values go
                // to the readout strip above the plot (crosshairPlugin)
                tooltip: { enabled: false }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'hour',
                        stepSize: responsive.stepSize,
                        displayFormats: { hour: 'EEE ha' }
                    },
                    grid: { display: false },
                    border: { display: false },
                    ticks: {
                        color: theme.tickColor,
                        padding: 8,
                        maxRotation: 0,
                        font: { size: responsive.tickFontSize },
                        callback: value => fmtTime(value)
                    }
                },
                y: {
                    beginAtZero: info.type !== 'temp',
                    grid: { color: theme.gridColor, drawTicks: false },
                    border: { display: false },
                    ticks: {
                        color: theme.tickColor,
                        padding: 8,
                        maxTicksLimit: 7,
                        font: { size: responsive.tickFontSize },
                        callback: (v) => {
                            if (info.type === 'temp') return v.toFixed(0) + '°';
                            if (info.type === 'wind') return v.toFixed(0);
                            return v.toFixed(1);
                        }
                    }
                }
            }
        }
    });
    chart.$type = info.type;
    chart.$param = param;
    chart.$theme = theme;

    // A mouse that went from the chart into the readout (for its map link)
    // resets it on leaving, unless it heads back to the chart
    const readout = document.getElementById(`readout-${param}`);
    if (readout) readout.onmouseleave = (e) => {
        if (e.relatedTarget === canvas || chart.$scrubX == null) return;
        chart.$scrubX = null;
        renderReadout(chart);
        chart.draw();
    };

    // Lifting the finger returns the readout to "now" after a short hold
    canvas.ontouchstart = () => clearTimeout(chart.$hold);
    canvas.ontouchend = canvas.ontouchcancel = () => {
        clearTimeout(chart.$hold);
        chart.$hold = setTimeout(() => {
            if (!chart.canvas) return;   // destroyed meanwhile (station/model switch)
            chart.$scrubX = null;
            renderReadout(chart);
            chart.draw();
        }, HOLD_MS);
    };
    chart.draw();
    return chart;
}

// ============ Scrub readout ============
const fmtTime = x => new Date(x).toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', timeZone: 'America/New_York'
});

const STEP = 30 * 60000;  // scrub resolution
const snap = x => Math.round(x / STEP) * STEP;

/**
 * Dataset i's value at time x, read off the drawn (smoothed) line so rings
 * sit on the curve between model steps. Null outside the series.
 */
function valueAt(chart, i, x) {
    let p = chart.getDatasetMeta(i).dataset?.interpolate({ x: chart.scales.x.getPixelForValue(x) }, 'x');
    if (Array.isArray(p)) p = p[0];
    return p ? { x, y: chart.scales.y.getValueForPixel(p.y) } : null;
}

/** Everything the readout and crosshair show at time x */
function valuesAt(chart, x) {
    const out = { mean: null, rrfs: null, lo: null, hi: null, bands: false, overlays: [] };
    const members = [], band = [];
    chart.data.datasets.forEach((ds, i) => {
        if (!chart.isDatasetVisible(i)) return;
        if (ds._band && !/P(10|90)$/.test(ds.label)) return;
        const p = valueAt(chart, i, x);
        if (!p) return;
        if (ds._overlay) out.overlays.push({ label: ds.label.replace(' Mean', ''), color: ds.borderColor, p });
        else if (ds.label === 'Mean') out.mean = p;
        else if (ds.label === 'RRFS') out.rrfs = p;
        else if (ds._band) band.push(p.y);
        else members.push(p.y);
    });
    // Member min/max when lines are shown, else the outer P10-P90 band
    const range = members.length ? members : band;
    if (range.length) Object.assign(out, { lo: Math.min(...range), hi: Math.max(...range), bands: !members.length });
    return out;
}

/** Time span of the chart's data */
function dataRange(chart) {
    const xs = chart.data.datasets.flatMap(ds => ds.data.length ? [ds.data[0].x, ds.data[ds.data.length - 1].x] : []);
    return [Math.min(...xs), Math.max(...xs)];
}

const clampTo = (x, [lo, hi]) => Math.min(Math.max(x, lo), hi);

/** Rest state shows the forecast at "now" (clamped into the run) */
const restX = chart => clampTo(snap(Date.now()), dataRange(chart));

// Radar page overlay for each plume chart (3-hour precip maps best to simulated radar)
const MAP_LAYER = { 'Total-SNO': 'snow', '3hrly-SNO': 'snow', 'Total-QPF': 'precip', '3hrly-QPF': 'radar',
    '3hrly-TMP': 'temp', '3h-10mWND': 'wind' };
const HOLD_MS = 3000;   // readout stays on the scrubbed time after a touch, so its map link can be tapped

const fmtReadoutTime = x => new Date(x).toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
});

function renderReadout(chart) {
    const el = document.getElementById(`readout-${chart.$param}`);
    if (!el) return;
    const live = chart.$scrubX != null;
    const x = live ? chart.$scrubX : restX(chart);
    const v = valuesAt(chart, x);
    const f = y => formatValue(chart.$type, y);
    const hours = Math.round((x - Date.now()) / STEP) / 2;
    const when = !live ? 'Now' : hours === 0 ? 'now' : hours > 0 ? `+${hours}h` : `\u2212${-hours}h`;

    const item = (label, value, color) => `<div class="ro-item">
        <span class="ro-label">${color ? `<i style="background:${color}"></i>` : ''}${label}</span>
        <span class="ro-value">${value}</span></div>`;
    const items = [];
    if (v.mean) items.push(item('Mean', f(v.mean.y)));
    if (v.lo !== null) items.push(item(v.bands ? 'P10\u2013P90' : 'Range', `${f(v.lo)}\u2013${f(v.hi)}`));
    if (v.rrfs) items.push(item('RRFS', f(v.rrfs.y)));
    for (const o of v.overlays) items.push(item(o.label, f(o.p.y), o.color));

    el.classList.toggle('live', live);
    const layer = MAP_LAYER[chart.$param] || 'radar';
    el.innerHTML = `<div class="ro-time"><span class="ro-when">${when}</span><span class="ro-at">${fmtReadoutTime(x)}</span></div>
        <div class="ro-items">${items.join('')}</div>
        <a class="ro-map" href="/radar?layer=${layer}&t=${Math.round(x / 1000)}" title="Open the map at this time">Map<span class="caret" data-dir="right"></span></a>`;
}

/** Pointer-driven scrub on a 30-min grid, with a vertical crosshair and a
 *  ring on each tracked line */
const crosshairPlugin = {
    id: 'crosshair',
    afterEvent(chart, args) {
        const e = args.event;
        let x = chart.$scrubX;
        // Chart.js reports touchstart/touchmove as mousedown/mousemove
        // Leaving for the readout (to click its map link) keeps the scrubbed time
        if (e.type === 'mouseout') x = e.native?.relatedTarget?.closest?.('.chart-readout') ? x : null;
        else if (e.type === 'mousemove' || e.type === 'mousedown') {
            x = clampTo(snap(chart.scales.x.getValueForPixel(e.x)), dataRange(chart));
        } else return;
        if (x === chart.$scrubX) return;
        chart.$scrubX = x;
        renderReadout(chart);
        args.changed = true;
    },
    afterDatasetsDraw(chart) {
        renderReadout(chart);
        const x = chart.$scrubX;
        if (x == null) return;
        const { ctx, chartArea, scales } = chart;
        const px = scales.x.getPixelForValue(x);
        const v = valuesAt(chart, x);
        const t = chart.$theme;

        ctx.save();
        ctx.strokeStyle = t.crosshair;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();

        const ring = (p, color) => {
            ctx.beginPath();
            ctx.arc(scales.x.getPixelForValue(p.x), scales.y.getPixelForValue(p.y), 5, 0, Math.PI * 2);
            ctx.fillStyle = t.surface;
            ctx.fill();
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = color;
            ctx.stroke();
        };
        for (const o of v.overlays) ring(o.p, o.color);
        if (v.rrfs) ring(v.rrfs, t.meanLineColor);
        if (v.mean) ring(v.mean, t.meanLineColor);
        ctx.restore();
    }
};

/**
 * Toggle visibility of ensemble core (ARW, NMB, or Mean)
 * @param {string} param - Parameter name
 * @param {string} core - Core to toggle ('ARW', 'NMB', or 'Mean')
 */
export function toggleCore(param, core) {
    const chart = chartInstances[param];
    if (!chart) return;

    chart.data.datasets.forEach((ds, i) => {
        if (ds._core === core) {
            const isVisible = chart.isDatasetVisible(i);
            chart.setDatasetVisibility(i, !isVisible);
        }
    });
    chart.update();
}

/** Destroy every chart (their canvases are about to be replaced) */
export function destroyAllCharts() {
    for (const param of Object.keys(chartInstances)) {
        chartInstances[param].destroy();
        delete chartInstances[param];
    }
}

/**
 * Download a chart as PNG with a title block, in the page's current theme
 * @param {string} param - Parameter name
 * @param {string} subtitle - e.g. "REFS • JFK • 12Z 2026-09-24"
 * @param {string} filename - without extension
 */
export function exportChartPng(param, subtitle, filename) {
    const chart = chartInstances[param];
    if (!chart) return;

    const info = CONFIG.params[param];
    const unit = info.type === 'wind' ? getWindUnit() : info.unit;
    const css = getComputedStyle(document.documentElement);
    const color = name => css.getPropertyValue(name).trim();
    // The canvas is in device pixels: scale the title block to match
    const dpr = window.devicePixelRatio || 1;
    const font = (weight, px) => `${weight} ${px * dpr}px Anybody, system-ui, sans-serif`;

    const src = chart.canvas;
    const top = 60 * dpr, bottom = 30 * dpr;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height + top + bottom;
    const ctx = out.getContext('2d');

    ctx.fillStyle = color('--surface');
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.textAlign = 'center';
    ctx.fillStyle = color('--text');
    ctx.font = font('bold', 20);
    ctx.fillText(info.name, out.width / 2, 28 * dpr);
    ctx.fillStyle = color('--text-dim');
    ctx.font = font('normal', 14);
    ctx.fillText(`${subtitle} • ${unit}`, out.width / 2, 48 * dpr);
    ctx.drawImage(src, 0, top);
    ctx.font = font('normal', 11);
    ctx.textAlign = 'right';
    ctx.fillText(location.host, out.width - 10 * dpr, out.height - 10 * dpr);

    const link = document.createElement('a');
    link.download = `${filename}.png`;
    link.href = out.toDataURL('image/png');
    link.click();
}
