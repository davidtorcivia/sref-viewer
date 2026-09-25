/**
 * Configuration: parameters, models, preferences
 */

export const CONFIG = {
    params: {
        'Total-SNO': { name: 'Total Snowfall', unit: 'in', type: 'snow' },
        '3hrly-SNO': { name: '3-Hour Snowfall', unit: 'in', type: 'snow' },
        'Total-QPF': { name: 'Total Precipitation', unit: 'in', type: 'precip' },
        '3hrly-QPF': { name: '3-Hour Precipitation', unit: 'in', type: 'precip' },
        '3hrly-TMP': { name: 'Temperature', unit: '°F', type: 'temp' },
        '3h-10mWND': { name: '10m Wind Speed', unit: 'kts', type: 'wind' },
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
};

/**
 * Forecast models. SREF retires 2026-10-06 12Z; REFS (RRFS ensemble) is its
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
        retiredAt: Date.UTC(2026, 9, 6, 12),
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
            { key: 'Mean', tooltip: 'REFS ensemble mean; band = mean ± spread' },
        ]
    }
};

export const isRetired = key => Boolean(MODELS[key].retiredAt && Date.now() >= MODELS[key].retiredAt);

// localStorage throws in some privacy modes: preferences are best-effort
export const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* not persisted */ } },
};

export const preferences = {
    windUnit: store.get('sref-wind-unit') === 'mph' ? 'mph' : 'kts'
};

export function setWindUnit(unit) {
    preferences.windUnit = unit;
    store.set('sref-wind-unit', unit);
}

/** One display format per variable (wind values already in the chosen unit) */
export function formatValue(type, v) {
    if (type === 'temp') return Math.round(v) + '°';
    if (type === 'wind') return Math.round(v).toString();
    if (type === 'snow') return v.toFixed(1);
    return v.toFixed(2);
}

/** Knots -> the preferred wind unit */
export function convertWind(kts) {
    return preferences.windUnit === 'mph' ? kts * 1.15078 : kts;
}

export function getWindUnit() {
    return preferences.windUnit;
}

const HOUR = 3600000;
const isoDate = epoch => new Date(epoch).toISOString().slice(0, 10);

/** UTC epoch of a model cycle */
export function cycleEpoch(date, run) {
    return Date.parse(`${date}T${run}:00:00Z`);
}

/**
 * The cycle `k` steps before (date, run) for a model: its runs are evenly
 * spaced, so stepping back is plain epoch arithmetic across day boundaries.
 */
export function previousCycle(modelKey, date, run, k = 1) {
    const step = 24 / MODELS[modelKey].runs.length;
    const epoch = cycleEpoch(date, run) - k * step * HOUR;
    return { run: new Date(epoch).toISOString().slice(11, 13), date: isoDate(epoch) };
}

/**
 * The most recent run whose data should be out, with its UTC date: a run
 * is "ready" readyLagHours after its cycle time. A retired model's latest
 * run is its last one before retirement.
 */
export function getLatestRunWithDate(modelKey) {
    const model = MODELS[modelKey];
    const now = Math.min(Date.now(), (model.retiredAt || Infinity) + model.readyLagHours * HOUR);
    const step = 24 / model.runs.length;
    const first = Number(model.runs[0]);
    // Latest cycle hour at or before (now - lag), on the model's cycle grid
    const ready = now - model.readyLagHours * HOUR;
    const epoch = Math.floor((ready - first * HOUR) / (step * HOUR)) * step * HOUR + first * HOUR;
    return { run: new Date(epoch).toISOString().slice(11, 13), date: isoDate(epoch) };
}

/** Matches the CSS mobile breakpoint in styles.css */
export function isMobile() {
    return window.innerWidth <= 768;
}

/** Touch-primary device (affects tooltip behavior) */
export function isTouchDevice() {
    return window.matchMedia('(pointer: coarse)').matches;
}
