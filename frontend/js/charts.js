/**
 * Chart.js Configuration and Rendering
 * Handles all chart creation and updates
 */
console.log('Charts.js loaded (v3.0.0 - confidence bands)');

import { CONFIG, isMobile, convertWind, getWindUnit } from './config.js';
import { getPercentileBands } from './api.js';

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
        tooltipBorder: light ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.1)'
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

    // 3. Add main datasets based on view mode
    if (viewMode === 'bands') {
        // Confidence bands mode - shaded regions instead of spaghetti lines
        const bands = getPercentileBands(data);

        if (bands) {
            // Get param-specific color
            const paramColor = info.type === 'snow' ? '165, 216, 255' :   // --snow
                info.type === 'precip' ? '81, 207, 102' :  // --precip
                    info.type === 'temp' ? '255, 135, 135' :   // --temp
                        info.type === 'wind' ? '255, 212, 59' :    // --wind
                            '110, 158, 255';                           // default accent

            // Convert wind data if needed
            const convertPoints = (points) => isWind
                ? points.map(p => ({ x: p.x, y: convertWind(p.y) }))
                : points;

            // P10 line (hidden, used as fill boundary)
            datasets.push({
                label: 'P10',
                data: convertPoints(bands.p10),
                borderColor: 'transparent',
                borderWidth: 0,
                pointRadius: 0,
                pointHitRadius: 0,
                tension: 0.3,
                fill: false,
                order: 4,
                _band: true
            });

            // P90 filling down to P10 (outer band)
            datasets.push({
                label: 'P90',
                data: convertPoints(bands.p90),
                borderColor: `rgba(${paramColor}, 0.3)`,
                borderWidth: 1,
                pointRadius: 0,
                pointHitRadius: 0,
                tension: 0.3,
                fill: {
                    target: datasets.length - 1, // Fill to P10
                    above: `rgba(${paramColor}, 0.15)`,
                    below: `rgba(${paramColor}, 0.15)`
                },
                order: 4,
                _band: true
            });

            // P25 line (hidden, used as fill boundary)
            datasets.push({
                label: 'P25',
                data: convertPoints(bands.p25),
                borderColor: 'transparent',
                borderWidth: 0,
                pointRadius: 0,
                pointHitRadius: 0,
                tension: 0.3,
                fill: false,
                order: 3,
                _band: true
            });

            // P75 filling down to P25 (inner band - darker)
            datasets.push({
                label: 'P75',
                data: convertPoints(bands.p75),
                borderColor: `rgba(${paramColor}, 0.5)`,
                borderWidth: 1,
                pointRadius: 0,
                pointHitRadius: 0,
                tension: 0.3,
                fill: {
                    target: datasets.length - 1, // Fill to P25
                    above: `rgba(${paramColor}, 0.25)`,
                    below: `rgba(${paramColor}, 0.25)`
                },
                order: 3,
                _band: true
            });
        }

        // Add Mean line on top
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
    } else {
        // Spaghetti mode - individual ensemble member lines
        for (const [label, points] of Object.entries(data)) {
            if (points.length === 0) continue;

            const isMean = label === 'Mean';
            const isARW = label.startsWith('AR');

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
                _core: isMean ? 'Mean' : (isARW ? 'ARW' : 'NMB')
            });
        }
    }

    // Destroy existing chart if present
    if (chartInstances[param]) {
        chartInstances[param].destroy();
    }

    const ctx = document.getElementById(`chart-${param}`).getContext('2d');
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
                            borderColor: 'rgba(255, 255, 255, 0.5)',
                            borderWidth: 2,
                            borderDash: [4, 4],
                            label: {
                                display: true,
                                content: 'Now',
                                position: 'start',
                                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                                color: '#fff',
                                font: { size: 10 }
                            }
                        }
                    }
                },
                tooltip: {
                    enabled: true,
                    position: 'rightOfCursor',
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
                        // In bands mode, hide P10/P25/P75/P90 from tooltip
                        if (viewMode === 'bands' && item.dataset._band) {
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

