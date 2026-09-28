/**
 * Display units for the overview (settings sheet): temperature, wind,
 * precipitation and clock. Data stays in °F, mph and inches internally;
 * these convert and format at the edge. Checked by frontend/forecast.test.cjs.
 */

export const UNIT_CHOICES = {
    temp: [['F', '°F'], ['C', '°C']],
    wind: [['mph', 'mph'], ['kmh', 'km/h'], ['kts', 'knots']],
    precip: [['in', 'inches'], ['mm', 'mm']],
    clock: [['12', '12-hour'], ['24', '24-hour']],
};
export const DEFAULT_UNITS = { temp: 'F', wind: 'mph', precip: 'in', clock: '12' };

/** Units from a stored JSON string; unknown or missing keys fall back to the defaults */
export function parseUnits(raw) {
    let u = {};
    try { u = JSON.parse(raw) || {}; } catch { /* defaults */ }
    const out = { ...DEFAULT_UNITS };
    for (const [k, opts] of Object.entries(UNIT_CHOICES)) {
        if (opts.some(([v]) => v === u[k])) out[k] = u[k];
    }
    return out;
}

export const toTemp = (f, u) => (u.temp === 'C' ? (f - 32) * 5 / 9 : f);
/** A temperature difference (spread): no offset */
export const toTempDelta = (df, u) => (u.temp === 'C' ? df * 5 / 9 : df);
export const deg = (f, u) => (f == null || Number.isNaN(f) ? '--' : `${Math.round(toTemp(f, u))}°`);

const WIND = { mph: [1, 'mph'], kmh: [1.609344, 'km/h'], kts: [0.868976, 'kt'] };
export const toWind = (mph, u) => mph * WIND[u.wind][0];
export const windUnit = u => WIND[u.wind][1];
export const wind = (mph, u) => `${Math.round(toWind(mph, u))} ${windUnit(u)}`;

/** Precipitation: inches to 2 decimals ("0.25\"") or whole millimetres ("6 mm"), snow to 1 decimal / cm */
export function precip(inches, u, snow = false) {
    if (u.precip === 'mm') return snow ? `${(inches * 2.54).toFixed(1)} cm` : `${Math.round(inches * 25.4)} mm`;
    return `${inches.toFixed(snow ? 1 : 2)}"`;
}

export function clock(ms, u, minutes = true) {
    const opts = u.clock === '24'
        ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
        : { hour: 'numeric', ...(minutes ? { minute: '2-digit' } : {}) };
    const s = new Date(ms).toLocaleTimeString('en-US', opts);
    return u.clock === '24' && !minutes ? s.slice(0, 2) : s.replace(' ', minutes ? ' ' : '');
}
