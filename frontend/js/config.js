/**
 * SREF Viewer Configuration
 * All constants and parameter definitions
 */

export const CONFIG = {
    apiBase: '/api/sref',

    params: {
        'Total-SNO': { name: 'Total Snowfall', unit: 'in', type: 'snow', pair: '3hrly-SNO' },
        '3hrly-SNO': { name: '3-Hour Snowfall', unit: 'in', type: 'snow', pair: 'Total-SNO' },
        'Total-QPF': { name: 'Total Precipitation', unit: 'in', type: 'precip', pair: '3hrly-QPF' },
        '3hrly-QPF': { name: '3-Hour Precipitation', unit: 'in', type: 'precip', pair: 'Total-QPF' },
        '3hrly-TMP': { name: 'Temperature', unit: '°F', type: 'temp', pair: null },
        '3h-10mWND': { name: '10m Wind Speed', unit: 'kts', type: 'wind', pair: null },
    },

    defaultOrder: ['3hrly-TMP', 'Total-QPF', '3hrly-QPF', '3h-10mWND'],
    snowOrder: ['Total-SNO', '3hrly-SNO', '3hrly-TMP', 'Total-QPF', '3hrly-QPF', '3h-10mWND'],

    memberColors: {
        ARWC: '#ff4444',
        ARN1: '#cc3333', ARN2: '#bb2222', ARN3: '#aa1111',
        ARN4: '#991111', ARN5: '#881111', ARN6: '#771111',
        ARP1: '#ff6644', ARP2: '#ff7755', ARP3: '#ff8866',
        ARP4: '#ff9977', ARP5: '#ffaa88', ARP6: '#ffbb99',
        MBCN: '#4488ff',
        MBN1: '#3377ee', MBN2: '#2266dd', MBN3: '#1155cc',
        MBN4: '#0044bb', MBN5: '#0033aa', MBN6: '#002299',
        MBP1: '#55aaff', MBP2: '#66bbff', MBP3: '#77ccff',
        MBP4: '#88ddff', MBP5: '#99eeff', MBP6: '#aaffff',
    },

    // Model run times (UTC)
    modelRuns: ['03', '09', '15', '21'],

    // Stations available
    stations: ['JFK', 'LGA', 'EWR']
};

// User preferences (persisted to localStorage)
export const preferences = {
    windUnit: localStorage.getItem('sref-wind-unit') || 'kts' // 'kts' or 'mph'
};

/**
 * Toggle wind unit between kts and mph
 */
export function toggleWindUnit() {
    preferences.windUnit = preferences.windUnit === 'kts' ? 'mph' : 'kts';
    localStorage.setItem('sref-wind-unit', preferences.windUnit);
    return preferences.windUnit;
}

/**
 * Convert wind speed based on current unit preference
 * @param {number} kts - Wind speed in knots
 * @returns {number} Wind speed in preferred unit
 */
export function convertWind(kts) {
    if (preferences.windUnit === 'mph') {
        return kts * 1.15078; // 1 knot = 1.15078 mph
    }
    return kts;
}

/**
 * Get current wind unit label
 */
export function getWindUnit() {
    return preferences.windUnit;
}

/**
 * Determine the most recent available model run based on current UTC time
 * SREF runs at 03Z, 09Z, 15Z, 21Z
 * Data typically completes ~5h20m after run time:
 *   03Z ready by ~08:20 UTC
 *   09Z ready by ~14:20 UTC
 *   15Z ready by ~20:20 UTC
 *   21Z ready by ~02:20 UTC (next day)
 */
export function getLatestRun() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const utcTime = utcHour + utcMinute / 60; // Decimal hours

    // Check in reverse order (most recent first)
    if (utcTime >= 20.33) return '15';         // After 20:20 UTC
    if (utcTime >= 14.33) return '09';         // After 14:20 UTC
    if (utcTime >= 8.33) return '03';          // After 08:20 UTC
    if (utcTime >= 2.33) return '21';          // After 02:20 UTC (21Z from yesterday)
    return '15';                                // Before 02:20 UTC, use 15Z from yesterday
}

/**
 * Check if device is mobile
 */
export function isMobile() {
    return window.innerWidth <= 600;
}

