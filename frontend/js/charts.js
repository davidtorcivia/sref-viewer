/**
 * Chart.js Configuration and Rendering
 * Handles all chart creation and updates
 */
console.log('Charts.js loaded (v2.0.1 - exportChartPng update)');

import { CONFIG, isMobile, convertWind, getWindUnit } from './config.js';

// Store chart instances for cleanup
const chartInstances = {};

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
 * @returns {Chart} Chart instance
 */
/**
 * Create or update a chart
 * @param {string} param - Parameter name
 * @param {Object} data - Ensemble data
 * @param {Array} overlayData - Array of { label, data, color } for overlays
 * @returns {Chart} Chart instance
 */
export function createChart(param, data, overlayData = []) {
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
    // We truncate to avoid extending the X-axis with data that has already passed
    if (overlayData && overlayData.length > 0) {
        for (const overlay of overlayData) {
            const points = overlay.data;
            if (!points || points.length === 0) continue;

            // Filter points to only those within main data time range
            const filteredPoints = points.filter(p => p.x >= minTime && p.x <= maxTime);
            if (filteredPoints.length === 0) continue;

            const chartPoints = isWind
                ? filteredPoints.map(p => ({ x: p.x, y: convertWind(p.y) }))
                : filteredPoints;

            datasets.push({
                label: overlay.label, // e.g., "09Z Mean"
                data: chartPoints,
                borderColor: overlay.color,
                borderWidth: 2,
                borderDash: [6, 4], // Dashed line
                pointRadius: 0,
                pointHitRadius: 20,
                pointHoverRadius: 4,
                tension: 0.3,
                fill: false,
                order: 2, // Behind main mean
            });
        }
    }

    // 2. Add Current Run Datasets
    for (const [label, points] of Object.entries(data)) {
        if (points.length === 0) continue;

        const isMean = label === 'Mean';
        const isARW = label.startsWith('AR');

        // Convert wind data if needed
        const chartPoints = isWind
            ? points.map(p => ({ x: p.x, y: convertWind(p.y) }))
            : points;

        datasets.push({
            label,
            data: chartPoints,
            borderColor: isMean ? theme.meanLineColor : (CONFIG.memberColors[label] || '#666'),
            borderWidth: isMean ? responsive.meanLineWidth : responsive.memberLineWidth,
            borderWidth: isMean ? responsive.meanLineWidth : responsive.memberLineWidth,
            pointRadius: 0,
            pointHitRadius: 20, // Make hover detection area much larger
            pointHoverRadius: isMean ? responsive.pointHoverRadius + 2 : responsive.pointHoverRadius,
            tension: 0.3,
            fill: false,
            order: isMean ? 0 : 1, // Mean on top, members below
            _core: isMean ? 'Mean' : (isARW ? 'ARW' : 'NMB')
        });
    }

    // Destroy existing chart if present
    if (chartInstances[param]) {
        chartInstances[param].destroy();
    }

    const ctx = document.getElementById(`chart-${param}`).getContext('2d');

    // Define display unit for tooltips
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
                    position: 'nearest',
                    xAlign: 'left',  // Anchor tooltip to left, so it appears to the right
                    yAlign: 'center',
                    caretPadding: 15, // Offset from cursor
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
 * Download chart as PNG image
 * @param {string} param - Parameter name
 * @param {string} station - Station code
 * @param {string} run - Model run
 */
export function exportChartPng(param, station, run) {
    const chart = chartInstances[param];
    if (!chart) return;

    const link = document.createElement('a');
    link.download = `SREF_${station}_${run}Z_${param}.png`;
    link.href = chart.toBase64Image();
    link.click();
}

