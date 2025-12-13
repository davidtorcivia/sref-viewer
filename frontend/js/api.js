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
