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
        // REFS: deterministic RRFS line (bands come from ensemble mean/spread)
        RRFS: '#4dabf7',
        // SREF members
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

/**
 * Forecast models. SREF retires 2026-10-06; REFS (RRFS ensemble) is its
 * successor. NOAA publishes no REFS members, so the REFS view is the
 * deterministic RRFS run (hourly) over the REFS mean +/- spread band
 * (3-hourly to 60h), cycles at 00/06/12/18Z.
 * readyLagHours: how long after cycle time the data is typically complete.
 */
export const MODELS = {
    sref: {
        label: 'SREF',
        apiBase: '/api/sref',
        runs: ['03', '09', '15', '21'],
        readyLagHours: 5.33,
        cores: [
            { key: 'ARW', tooltip: 'Advanced Research WRF core (red lines)' },
            { key: 'NMB', tooltip: 'NEMS-NMMB core (blue lines)' },
            { key: 'Mean', tooltip: 'Average of all 26 ensemble members' },
        ]
    },
    refs: {
        label: 'REFS',
        apiBase: '/api/refs',
        runs: ['00', '06', '12', '18'],
        readyLagHours: 3.6,
        cores: [
            { key: 'MEM', label: 'RRFS', tooltip: 'Deterministic RRFS run (hourly to 84h)' },
            { key: 'Mean', tooltip: 'REFS ensemble mean; band = mean +/- spread' },
        ]
    }
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
 * Get the most recent available run AND the correct date for that run,
 * for any model: a run is "ready" readyLagHours after its cycle time.
 * Handles date rollover (e.g. SREF 21Z isn't ready until 02:20 UTC the
 * next day, so shortly after midnight UTC the latest run is yesterday's).
 */
export function getLatestRunWithDate(modelKey = 'sref') {
    const model = MODELS[modelKey] || MODELS.sref;
    const now = Date.now();

    // Consider today's and yesterday's cycles; pick the most recent one
    // whose ready time has passed
    let best = null;
    for (const dayOffset of [0, -1]) {
        const day = new Date(now + dayOffset * 86400000);
        const y = day.getUTCFullYear(), m = day.getUTCMonth(), d = day.getUTCDate();
        for (const run of model.runs) {
            const runEpoch = Date.UTC(y, m, d, Number(run));
            const readyEpoch = runEpoch + model.readyLagHours * 3600000;
            if (readyEpoch <= now && (!best || runEpoch > best.runEpoch)) {
                const iso = new Date(runEpoch).toISOString();
                best = { run, date: iso.split('T')[0], runEpoch };
            }
        }
    }

    if (!best) {
        // Degenerate fallback (shouldn't happen with 4 cycles/day)
        const iso = new Date(now).toISOString();
        best = { run: model.runs[0], date: iso.split('T')[0] };
    }

    console.log(`[RUN] ${modelKey} → ${best.run}Z on ${best.date}`);
    return { run: best.run, date: best.date };
}

/**
 * Check if device is mobile (matches the CSS breakpoint in styles.css)
 */
export function isMobile() {
    return window.innerWidth <= 768;
}

/**
 * Check if this is a touch-primary device (affects tooltip behavior)
 */
export function isTouchDevice() {
    return window.matchMedia('(pointer: coarse)').matches;
}

