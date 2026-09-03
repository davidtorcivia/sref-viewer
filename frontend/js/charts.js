/**
 * Chart.js Configuration and Rendering
 * Handles all chart creation and updates
 */
import { CONFIG, isMobile, isTouchDevice, convertWind, getWindUnit } from './config.js?v=__V__';
import { getPercentileBands } from './api.js?v=__V__';

// Store chart instances for cleanup
const chartInstances = {};

// Register custom tooltip positioner - offset 50px to the right of cursor
Chart.Tooltip.positioners.rightOfCursor = function (elements, eventPosition) {
    return {
        x: eventPosition.x + 50,  // 50px to the right
        y: eventPosition.y
    };
};

/**
 * Get responsive chart options based on screen size
 */
function getResponsiveOptions() {
    const mobile = isMobile();
    return {
        tickFontSize: mobile ? 10 : 11,
        tooltipTitleSize: mobile ? 12 : 13,
        tooltipBodySize: mobile ? 11 : 12,
        stepSize: mobile ? 12 : 6,
        pointHoverRadius: mobile ? 10 : 5,
        meanLineWidth: mobile ? 5 : 4,
        memberLineWidth: mobile ? 1.8 : 1.4,
    };
}

/**
 * Check if light mode is active (explicitly check for light preference)
 */
function isLightMode() {
    if (!window.matchMedia) return false;
    return window.matchMedia('(prefers-color-scheme: light)').matches;
}

/**
 * Get theme-aware colors for charts
 */
function getThemeColors() {
    const light = isLightMode();
    return {
        gridColor: light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.08)',
        tickColor: light ? '#444' : '#999',
        meanLineColor: light ? '#000000' : '#ffffff',
        tooltipBg: light ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.9)',
        tooltipText: light ? '#1c1c1e' : '#fff',
        tooltipBorder: light ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.1)',
        nowLineColor: light ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.5)',
        nowLabelBg: light ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.5)',
        nowLabelText: light ? '#1c1c1e' : '#fff'
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
    const windUnit = isWind ? getWindUnit() : null;

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
                borderWidth: 2,
                borderDash: [6, 4],
                pointRadius: 0,
                pointHitRadius: 20,
                pointHoverRadius: 4,
                tension: 0.3,
                fill: false,
                order: 5,
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
        if (hasARW) bandGroups.push({ name: 'ARW', core: 'ARW', filter: 'ARW', color: '255, 100, 100' });
        if (hasNMB) bandGroups.push({ name: 'NMB', core: 'NMB', filter: 'NMB', color: '100, 150, 255' });
        if (!hasARW && !hasNMB) {
            // Single-family ensemble (REFS): one band set over all members
            bandGroups.push({ name: 'ENS', core: 'Mean', filter: null, color: '100, 150, 255' });
        }

        for (const group of bandGroups) {
            const bands = getPercentileBands(data, group.filter);
            if (!bands) continue;

            // Outer band: P90 filling down to a hidden P10 boundary
            // Inner band: P75 filling down to a hidden P25 boundary (darker)
            const layers = [
                { lo: bands.p10, hi: bands.p90, loName: 'P10', hiName: 'P90', order: 4, edge: 0.4, fill: 0.12 },
                { lo: bands.p25, hi: bands.p75, loName: 'P25', hiName: 'P75', order: 3, edge: 0.6, fill: 0.22 },
            ];
            for (const layer of layers) {
                datasets.push({
                    label: `${group.name} ${layer.loName}`,
                    data: convertPoints(layer.lo),
                    borderColor: 'transparent',
                    borderWidth: 0,
                    pointRadius: 0,
                    pointHitRadius: 0,
                    tension: 0.3,
                    fill: false,
                    order: layer.order,
                    _band: true,
                    _core: group.core
                });
                datasets.push({
                    label: `${group.name} ${layer.hiName}`,
                    data: convertPoints(layer.hi),
                    borderColor: `rgba(${group.color}, ${layer.edge})`,
                    borderWidth: 1,
                    pointRadius: 0,
                    pointHitRadius: 0,
                    tension: 0.3,
                    fill: {
                        target: datasets.length - 1,
                        above: `rgba(${group.color}, ${layer.fill})`,
                        below: `rgba(${group.color}, ${layer.fill})`
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
                    pointHoverRadius: responsive.pointHoverRadius + 2,
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

            datasets.push({
                label,
                data: chartPoints,
                borderColor: isMean ? theme.meanLineColor : (CONFIG.memberColors[label] || '#666'),
                borderWidth: isMean ? responsive.meanLineWidth : responsive.memberLineWidth,
                pointRadius: 0,
                pointHitRadius: 20,
                pointHoverRadius: isMean ? responsive.pointHoverRadius + 2 : responsive.pointHoverRadius,
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

    const ctx = canvas.getContext('2d');
    const displayUnit = isWind ? windUnit : info.unit;

    chartInstances[param] = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: {
                intersect: false,
                mode: 'index',
            },
            plugins: {
                legend: { display: false },
                annotation: {
                    annotations: {
                        nowLine: {
                            type: 'line',
                            xMin: Date.now(),
                            xMax: Date.now(),
                            borderColor: theme.nowLineColor,
                            borderWidth: 2,
                            borderDash: [4, 4],
                            label: {
                                display: true,
                                content: 'Now',
                                position: 'start',
                                backgroundColor: theme.nowLabelBg,
                                color: theme.nowLabelText,
                                font: { size: 10 }
                            }
                        }
                    }
                },
                tooltip: {
                    enabled: true,
                    // On touch devices the +50px offset pushes the tooltip
                    // off-screen - use the default positioner there
                    position: isTouchDevice() ? 'nearest' : 'rightOfCursor',
                    backgroundColor: theme.tooltipBg,
                    titleColor: theme.tooltipText,
                    bodyColor: theme.tooltipText,
                    borderColor: theme.tooltipBorder,
                    borderWidth: 1,
                    titleFont: { size: responsive.tooltipTitleSize, weight: 'bold' },
                    bodyFont: { size: responsive.tooltipBodySize },
                    padding: 12,
                    displayColors: true,
                    boxWidth: 10,
                    boxHeight: 10,
                    filter: (item) => {
                        // Hide band boundary lines from tooltip
                        if (item.dataset._band) {
                            return false;
                        }
                        // On small screens a 26-member list is unreadable -
                        // show only the Mean and comparison-run overlays
                        if (isMobile() && item.dataset.label &&
                            !item.dataset.label.includes('Mean')) {
                            return false;
                        }
                        return true;
                    },
                    itemSort: (a, b) => {
                        const aIsMean = a.dataset.label.includes('Mean');
                        const bIsMean = b.dataset.label.includes('Mean');
                        if (aIsMean && !bIsMean) return -1;
                        if (!aIsMean && bIsMean) return 1;
                        return a.dataset.label.localeCompare(b.dataset.label);
                    },
                    callbacks: {
                        title: (items) => {
                            if (items.length === 0) return '';
                            const d = new Date(items[0].parsed.x);
                            return d.toLocaleString('en-US', {
                                weekday: 'short', month: 'short', day: 'numeric',
                                hour: 'numeric', minute: '2-digit',
                                timeZone: 'America/New_York'
                            }) + ' ET';
                        },
                        label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(info.type === 'wind' ? 0 : 2)} ${displayUnit}`
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'hour',
                        stepSize: responsive.stepSize,
                        displayFormats: { hour: 'EEE ha' }
                    },
                    grid: { color: theme.gridColor },
                    ticks: {
                        color: theme.tickColor,
                        maxRotation: 0,
                        font: { size: responsive.tickFontSize },
                        callback: function (value) {
                            const d = new Date(value);
                            return d.toLocaleString('en-US', {
                                weekday: 'short', hour: 'numeric',
                                timeZone: 'America/New_York'
                            });
                        }
                    }
                },
                y: {
                    beginAtZero: info.type !== 'temp',
                    grid: { color: theme.gridColor },
                    ticks: {
                        color: theme.tickColor,
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

    return chartInstances[param];
}

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

/**
 * Get chart instance by param
 */
export function getChart(param) {
    return chartInstances[param];
}

/**
 * Destroy all charts (cleanup)
 */
export function destroyAllCharts() {
    for (const param of Object.keys(chartInstances)) {
        chartInstances[param].destroy();
        delete chartInstances[param];
    }
}

/**
 * Download chart as PNG image with title and labels
 * @param {string} param - Parameter name
 * @param {string} station - Station code
 * @param {string} run - Model run
 * @param {string} date - Forecast date
 */
export function exportChartPng(param, station, run, date = '') {
    const chart = chartInstances[param];
    if (!chart) return;

    const info = CONFIG.params[param];
    const paramName = info?.name || param;
    const unit = info?.unit || '';

    // Get the original chart canvas
    const chartCanvas = chart.canvas;
    const chartWidth = chartCanvas.width;
    const chartHeight = chartCanvas.height;

    // Create new canvas with space for title/labels
    const padding = { top: 60, bottom: 30, left: 0, right: 0 };
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = chartWidth + padding.left + padding.right;
    exportCanvas.height = chartHeight + padding.top + padding.bottom;

    const ctx = exportCanvas.getContext('2d');

    // Fill background
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    // Draw title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(paramName, exportCanvas.width / 2, 28);

    // Draw subtitle (station, run, date)
    ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#888888';
    const subtitle = `${station} • ${run}Z${date ? ' • ' + date : ''} • Units: ${unit}`;
    ctx.fillText(subtitle, exportCanvas.width / 2, 48);

    // Draw the chart
    ctx.drawImage(chartCanvas, padding.left, padding.top);

    // Draw footer
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#666666';
    ctx.textAlign = 'right';
    ctx.fillText('NOAA SREF Ensemble Plumes', exportCanvas.width - 10, exportCanvas.height - 10);

    // Download
    const link = document.createElement('a');
    link.download = `SREF_${station}_${run}Z_${param}${date ? '_' + date : ''}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
}

