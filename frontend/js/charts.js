/**
 * Chart.js Configuration and Rendering
 * Handles all chart creation and updates
 */

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
 * Check if dark mode is active
 */
function isDarkMode() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Get theme-aware colors for charts
 */
function getThemeColors() {
    const dark = isDarkMode();
    return {
        gridColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.15)',
        tickColor: dark ? '#999' : '#555',
        meanLineColor: dark ? '#ffffff' : '#000000',
        tooltipBg: dark ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.95)',
        tooltipText: dark ? '#fff' : '#1c1c1e',
        tooltipBorder: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.15)'
    };
}

/**
 * Create or update a chart
 * @param {string} param - Parameter name
 * @param {Object} data - Ensemble data
 * @returns {Chart} Chart instance
 */
export function createChart(param, data) {
    const info = CONFIG.params[param];
    const responsive = getResponsiveOptions();
    const theme = getThemeColors();
    const datasets = [];

    // Check if this is wind data - we may need to convert
    const isWind = info.type === 'wind';
    const displayUnit = isWind ? getWindUnit() : info.unit;

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
            pointRadius: 0,
            pointHoverRadius: isMean ? responsive.pointHoverRadius + 2 : responsive.pointHoverRadius,
            tension: 0.3,
            fill: false,
            order: isMean ? 0 : 1,
            _core: isMean ? 'Mean' : (isARW ? 'ARW' : 'NMB')
        });
    }

    // Destroy existing chart if present
    if (chartInstances[param]) {
        chartInstances[param].destroy();
    }

    const ctx = document.getElementById(`chart-${param}`).getContext('2d');

    chartInstances[param] = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
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
