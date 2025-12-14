/**
 * SREF API Client
 * Handles all data fetching from the local caching proxy
 */

import { CONFIG } from './config.js';

/**
 * Fetch SREF data for a specific parameter
 * @param {string} station - Airport code (JFK, LGA, EWR)
 * @param {string} run - Model run time (03, 09, 15, 21)
 * @param {string} param - Parameter name (Total-SNO, 3hrly-TMP, etc.)
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<Object>} Processed ensemble data with Mean included
 */
export async function fetchSREFData(station, run, param, date) {
    const url = `${CONFIG.apiBase}/${station}/${run}/${param}?date=${date}`;

    const response = await fetch(url);

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.details || `HTTP ${response.status}`);
    }

    const data = await response.json();

    // Check cache status from header
    const cacheStatus = response.headers.get('X-Cache') || 'UNKNOWN';
    console.log(`[${cacheStatus}] ${station}/${run}/${param}`);

    return data;
}

/**
 * Check if snow is forecast (any member > 0.1")
 * @param {Object} snowData - Total snow data object
 * @returns {boolean} True if snow is forecast
 */
export function hasSnowForecast(snowData) {
    if (!snowData) return false;

    for (const [label, points] of Object.entries(snowData)) {
        if (label === 'Mean') continue;
        const finalVal = points[points.length - 1]?.y || 0;
        if (finalVal > 0.1) return true;
    }

    return false;
}

/**
 * Get summary statistics from ensemble data
 * @param {Object} data - Ensemble data object
 * @param {boolean} useMax - Use max value instead of final value
 * @returns {Object} Statistics object
 */
export function getEnsembleStats(data, useMax = false) {
    if (!data) return null;

    const memberValues = [];
    let meanValue = null;

    for (const [label, points] of Object.entries(data)) {
        if (!points || points.length === 0) continue;

        const values = points.map(p => p.y);
        const val = useMax ? Math.max(...values) : values[values.length - 1];

        if (label === 'Mean') {
            meanValue = val;
        } else {
            memberValues.push(val);
        }
    }

    if (memberValues.length === 0) return null;

    return {
        mean: meanValue,
        max: Math.max(...memberValues),
        min: Math.min(...memberValues),
        spread: Math.max(...memberValues) - Math.min(...memberValues)
    };
}



/**
 * Calculate percentile value from sorted array
 * @param {number[]} sortedArr - Sorted array of values
 * @param {number} percentile - Percentile (0-100)
 * @returns {number} Value at percentile
 */
function percentile(sortedArr, p) {
    const index = (p / 100) * (sortedArr.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedArr[lower];
    return sortedArr[lower] + (sortedArr[upper] - sortedArr[lower]) * (index - lower);
}

/**
 * Calculate percentile bands from ensemble data
 * Returns P10, P25, P75, P90 series aligned to common timestamps
 * @param {Object} data - Ensemble data object (member name -> [{x, y}])
 * @param {string} coreFilter - Optional: 'ARW', 'NMB', or null for all members
 * @returns {Object} Band data with p10, p25, p75, p90 arrays
 */
export function getPercentileBands(data, coreFilter = null) {
    if (!data) return null;

    // Get all member data (exclude Mean, optionally filter by core)
    const members = [];
    for (const [label, points] of Object.entries(data)) {
        if (label === 'Mean' || !points || points.length === 0) continue;

        // Filter by core type if specified
        if (coreFilter === 'ARW' && !label.startsWith('AR')) continue;
        if (coreFilter === 'NMB' && !label.startsWith('NM')) continue;

        members.push(points);
    }

    if (members.length === 0) return null;

    // Use first member's timestamps as reference
    const refTimestamps = members[0].map(p => p.x);

    // For each timestamp, collect values from all members and calculate percentiles
    const p10 = [];
    const p25 = [];
    const p75 = [];
    const p90 = [];

    for (let i = 0; i < refTimestamps.length; i++) {
        const x = refTimestamps[i];
        const values = [];

        for (const memberPoints of members) {
            // Find value at this timestamp (or closest)
            const point = memberPoints[i];
            if (point) {
                values.push(point.y);
            }
        }

        if (values.length === 0) continue;

        // Sort for percentile calculation
        values.sort((a, b) => a - b);

        p10.push({ x, y: percentile(values, 10) });
        p25.push({ x, y: percentile(values, 25) });
        p75.push({ x, y: percentile(values, 75) });
        p90.push({ x, y: percentile(values, 90) });
    }

    return { p10, p25, p75, p90 };
}

/**
 * Check backend health
 * @returns {Promise<Object>} Health status
 */
export async function checkHealth() {
    try {
        const response = await fetch('/health');
        return await response.json();
    } catch {
        return { status: 'error', message: 'Backend unreachable' };
    }
}
