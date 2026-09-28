/**
 * Calendar arithmetic in a place's IANA time zone (undefined: the device's),
 * so a forecast for Los Angeles reads in Pacific time wherever it is viewed.
 * Checked by frontend/forecast.test.cjs.
 */

const HOUR = 3600000;
const cache = new Map();
export const formatter = (opts, tz) => {
    const k = `${tz}|${JSON.stringify(opts)}`;
    if (!cache.has(k)) cache.set(k, new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }));
    return cache.get(k);
};

export function parts(ms, tz) {
    const o = {};
    const f = formatter({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, tz);
    for (const p of f.formatToParts(ms)) o[p.type] = p.value;
    return o;
}

/** 'YYYY-MM-DD' of the place's calendar day holding ms */
export const day = (ms, tz) => { const p = parts(ms, tz); return `${p.year}-${p.month}-${p.day}`; };
export const hour = (ms, tz) => Number(parts(ms, tz).hour);

/** The instant the place's calendar day holding ms began */
export function midnight(ms, tz) {
    const p = parts(ms, tz);
    let m = ms - ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 - (((ms % 1000) + 1000) % 1000);
    // a clock change earlier in the day moves the start by its hour
    for (let i = 0; i < 2; i++) {
        const h = hour(m, tz);
        if (h === 0) break;
        m += h >= 12 ? HOUR : -HOUR;
    }
    return m;
}
export const noon = (ms, tz) => midnight(ms, tz) + 12 * HOUR;

/** Place midnights strictly inside (a, b); a day runs 23 to 25 hours around a clock change */
export function midnights(a, b, tz) {
    const out = [];
    for (let m = midnight(a, tz), i = 0; i < 40; i++) {
        m = midnight(m + 26 * HOUR, tz);
        if (m >= b) break;
        if (m > a) out.push(m);
    }
    return out;
}

export const format = (ms, opts, tz) => formatter(opts, tz).format(ms);

/** " PDT" when the place keeps a different clock from this device, else '' */
export function tag(ms, tz) {
    if (!tz || tz === Intl.DateTimeFormat().resolvedOptions().timeZone) return '';
    const name = formatter({ timeZoneName: 'short' }, tz).formatToParts(ms).find(p => p.type === 'timeZoneName')?.value;
    return name ? ` ${name}` : '';
}
