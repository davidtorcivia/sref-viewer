/**
 * Forecast logic for the overview page, free of DOM so it can be tested
 * (frontend/forecast.test.cjs): hourly rows from the /api/forecast series,
 * sky conditions, daily summaries and the next-precipitation sentence.
 *
 * The series is one deterministic model run (RRFS), so wording states what
 * the model shows rather than a probability.
 */

const PRECIP_IN = 0.01;     // in/hr that counts as precipitating
const ECHO_DBZ = 20;        // simulated reflectivity that counts as precipitating
const STORM_DBZ = 50;       // convective cores

/** Hourly rows {t (ms), tmp, dpt, wind, dir, gust, cloud, qpf, snow, snowy, dbz} */
export function hourlyRows(h) {
    return h.tmp.map((tmp, i) => ({
        t: (h.start + i * h.step) * 1000, tmp, dpt: h.dpt[i], wind: h.wind[i], dir: h.dir[i],
        gust: h.gust[i], cloud: h.cloud[i], qpf: h.qpf[i] ?? 0, snow: h.snow[i] ?? 0,
        snowy: h.snowflag[i], dbz: h.dbz[i] ?? -30,
    })).filter(r => r.tmp !== null);
}

/** Solar altitude in degrees (NOAA low-precision formulas, ~0.5 degree) */
export function sunAltitude(ms, lat, lon) {
    const d = ms / 86400000 - 10957.5;               // days since J2000
    const g = (357.529 + 0.98560028 * d) * Math.PI / 180;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180;
    const e = (23.439 - 0.00000036 * d) * Math.PI / 180;
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const ha = ((gmst * 15 + lon) * Math.PI / 180) - ra;
    const phi = lat * Math.PI / 180;
    return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)) * 180 / Math.PI;
}

const isWet = r => r.qpf >= PRECIP_IN || r.dbz >= ECHO_DBZ;

/**
 * Condition for one hour: {key, label}. key picks the icon and sky:
 * clear, partly, cloudy, rain, snow, storm (+ night variants for clear/partly).
 */
export function condition(r, night) {
    if (isWet(r)) {
        if (r.dbz >= STORM_DBZ && !r.snowy) return { key: 'storm', label: 'Thunderstorms' };
        if (r.snowy) return { key: 'snow', label: r.qpf >= 0.1 ? 'Heavy snow' : r.qpf >= 0.03 ? 'Snow' : 'Light snow' };
        return { key: 'rain', label: r.qpf >= 0.3 ? 'Heavy rain' : r.qpf >= 0.1 ? 'Rain' : 'Light rain' };
    }
    const c = r.cloud ?? 0;
    if (c < 20) return { key: night ? 'clear-night' : 'clear', label: night ? 'Clear' : 'Sunny' };
    if (c < 60) return { key: night ? 'partly-night' : 'partly', label: 'Partly cloudy' };
    return { key: 'cloudy', label: c < 90 ? 'Mostly cloudy' : 'Cloudy' };
}

const SEVERITY = { storm: 5, snow: 4, rain: 3, cloudy: 2, partly: 1, 'partly-night': 1, clear: 0, 'clear-night': 0 };

/** Local calendar day key (device time zone) */
export const dayKey = ms => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/**
 * Daily summaries by device-local day: {key, t (first hour), hi, lo, qpf,
 * snow, gust, cond}. The condition is the most severe daytime (7-19h) one,
 * so a rainy afternoon reads as rain. A trailing day with fewer than 12
 * hours of data is dropped: its high and low would be misleading.
 */
export function dailyRows(rows) {
    const days = new Map();
    for (const r of rows) {
        const k = dayKey(r.t);
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(r);
    }
    const out = [];
    for (const [key, hrs] of days) {
        const daytime = hrs.filter(r => { const h = new Date(r.t).getHours(); return h >= 7 && h <= 19; });
        const conds = (daytime.length ? daytime : hrs).map(r => condition(r, false));
        out.push({
            key, t: hrs[0].t, hours: hrs.length,
            hi: Math.max(...hrs.map(r => r.tmp)), lo: Math.min(...hrs.map(r => r.tmp)),
            qpf: hrs.reduce((a, r) => a + r.qpf, 0), snow: hrs.reduce((a, r) => a + r.snow, 0),
            gust: Math.max(...hrs.map(r => r.gust ?? 0)),
            cond: conds.reduce((a, c) => SEVERITY[c.key] > SEVERITY[a.key] ? c : a),
        });
    }
    if (out.length > 1 && out[out.length - 1].hours < 12) out.pop();
    return out;
}

const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric' });

/**
 * One sentence about precipitation over the next 12 hours from `now`:
 * when it starts, or when it ends if it is already falling.
 */
export function nowcast(rows, now) {
    const ahead = rows.filter(r => r.t + 3600000 > now && r.t < now + 12 * 3600000);
    if (!ahead.length) return '';
    const kind = r => (r.snowy ? 'Snow' : 'Rain');
    if (isWet(ahead[0])) {
        const end = ahead.find(r => !isWet(r));
        return end ? `${kind(ahead[0])} ending around ${clock(end.t)}` : `${kind(ahead[0])} continuing for the next 12 hours`;
    }
    const start = ahead.find(isWet);
    return start ? `${kind(start)} starting around ${clock(start.t)}` : 'Dry for the next 12 hours';
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = deg => COMPASS[Math.round(deg / 22.5) % 16];

// Temperature colors (°F), the stops the extractor paints the map with
// (extractor.py FIELDS['tmp']), so curves and bars match the radar page
const TEMP_STOPS = [[-40, [255, 255, 255]], [-20, [227, 198, 247]], [0, [123, 91, 214]], [10, [62, 70, 201]],
    [20, [47, 127, 224]], [32, [94, 198, 242]], [40, [111, 211, 168]], [50, [127, 211, 90]],
    [60, [216, 224, 74]], [70, [245, 197, 66]], [80, [242, 139, 48]], [90, [226, 74, 42]],
    [100, [179, 31, 54]], [120, [122, 16, 48]]];

export function tempColor(f) {
    const k = TEMP_STOPS.findIndex(([v]) => v >= f);
    if (k <= 0) return `rgb(${TEMP_STOPS[k === 0 ? 0 : TEMP_STOPS.length - 1][1].join(',')})`;
    const [[v0, c0], [v1, c1]] = [TEMP_STOPS[k - 1], TEMP_STOPS[k]];
    const x = (f - v0) / (v1 - v0);
    return `rgb(${c0.map((c, i) => Math.round(c + (c1[i] - c) * x)).join(',')})`;
}

/**
 * Monotone cubic path through points (Fritsch-Carlson): smooth, and never
 * overshoots between hours, so the curve shows no highs the data lacks.
 */
export function monotonePath(pts) {
    const n = pts.length;
    if (n < 2) return '';
    const dx = [], m = [];
    for (let i = 0; i < n - 1; i++) {
        dx.push(pts[i + 1][0] - pts[i][0]);
        m.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
    }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
    t.push(m[n - 2]);
    for (let i = 0; i < n - 1; i++) {
        if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
        const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
        if (s > 9) { t[i] = 3 * a / Math.sqrt(s) * m[i]; t[i + 1] = 3 * b / Math.sqrt(s) * m[i]; }
    }
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
        const h = dx[i] / 3;
        d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + t[i] * h).toFixed(1)} `
            + `${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)} `
            + `${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
    }
    return d;
}

// ============ Sun, moon, comfort, holidays ============

const RAD = Math.PI / 180;

/** Sun altitude and azimuth (degrees, azimuth clockwise from north) */
export function sunPosition(ms, lat, lon) {
    const d = ms / 86400000 - 10957.5;
    const g = (357.529 + 0.98560028 * d) * RAD;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const e = (23.439 - 0.00000036 * d) * RAD;
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const ha = (gmst * 15 + lon) * RAD - ra;
    const phi = lat * RAD;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
    const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
    return { alt: alt / RAD, az: ((az / RAD) + 360) % 360 };
}

/**
 * Sunrise and sunset (ms) on the device-local day containing `ms`: where
 * the sun's center crosses -0.833 degrees (refraction plus the disk).
 * null for a crossing that does not happen (polar day or night).
 */
export function sunTimes(ms, lat, lon) {
    const day = new Date(ms);
    day.setHours(0, 0, 0, 0);
    const f = t => sunAltitude(t, lat, lon) + 0.833;
    let rise = null, set = null;
    const step = 10 * 60000;
    for (let t = day.getTime(); t < day.getTime() + 86400000; t += step) {
        const a = f(t), b = f(t + step);
        if (a < 0 && b >= 0 && rise === null) rise = t + step * a / (a - b);
        if (a >= 0 && b < 0 && set === null) set = t + step * a / (a - b);
    }
    return { rise, set };
}

const SYNODIC = 29.530588853;
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);   // reference new moon

/** Moon phase: {phase 0..1 (0 new, 0.5 full), illum 0..1, name, waxing} */
export function moonPhase(ms) {
    const phase = (((ms - NEW_MOON) / 86400000 / SYNODIC) % 1 + 1) % 1;
    const illum = (1 - Math.cos(2 * Math.PI * phase)) / 2;
    const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon',
        'Waning gibbous', 'Last quarter', 'Waning crescent'];
    return { phase, illum, name: names[Math.round(phase * 8) % 8], waxing: phase < 0.5 };
}

/** The next time (ms) the moon reaches `target` phase (0 new, 0.5 full) after `ms` */
export function nextMoon(ms, target) {
    const { phase } = moonPhase(ms);
    return ms + (((target - phase) % 1 + 1) % 1) * SYNODIC * 86400000;
}

/** Relative humidity (%) from temperature and dew point in °F (Magnus) */
export function humidity(tf, dpf) {
    const c = f => (f - 32) * 5 / 9;
    const m = t => Math.exp(17.625 * t / (243.04 + t));
    return Math.min(100, 100 * m(c(dpf)) / m(c(tf)));
}

/** Apparent temperature (°F): NWS heat index when hot, wind chill when cold, else the air */
export function feelsLike(tf, dpf, mph) {
    if (tf <= 50 && mph > 3) {
        return 35.74 + 0.6215 * tf - 35.75 * mph ** 0.16 + 0.4275 * tf * mph ** 0.16;
    }
    if (tf >= 80) {
        const rh = humidity(tf, dpf);
        const hi = -42.379 + 2.04901523 * tf + 10.14333127 * rh - 0.22475541 * tf * rh - 0.00683783 * tf * tf
            - 0.05481717 * rh * rh + 0.00122874 * tf * tf * rh + 0.00085282 * tf * rh * rh - 0.00000199 * tf * tf * rh * rh;
        return Math.max(tf, hi);
    }
    return tf;
}

/** How the air feels from its dew point (°F) */
export function comfort(dpf) {
    if (dpf < 40) return 'Dry';
    if (dpf < 55) return 'Comfortable';
    if (dpf < 61) return 'A little humid';
    if (dpf < 66) return 'Humid';
    if (dpf < 71) return 'Muggy';
    return 'Oppressive';
}

// Holidays with the hours people are out in the weather. Dates are local.
const nthWeekday = (y, m, weekday, n) => {
    const d = new Date(y, m, 1);
    const shift = (weekday - d.getDay() + 7) % 7 + (n - 1) * 7;
    return new Date(y, m, 1 + shift);
};
const lastWeekday = (y, m, weekday) => {
    const d = new Date(y, m + 1, 0);
    return new Date(y, m, d.getDate() - (d.getDay() - weekday + 7) % 7);
};
export function holidays(year) {
    const at = (d, h0, h1) => [new Date(d).setHours(h0, 0, 0, 0), new Date(d).setHours(h1, 0, 0, 0)];
    const day = (y, m, d) => new Date(y, m, d);
    return [
        { name: "New Year's Day", window: at(day(year, 0, 1), 10, 16) },
        { name: 'Martin Luther King Jr. Day', window: at(nthWeekday(year, 0, 1, 3), 10, 16) },
        { name: "Valentine's Day", window: at(day(year, 1, 14), 18, 22), label: 'Evening out' },
        { name: 'Presidents Day', window: at(nthWeekday(year, 1, 1, 3), 10, 16) },
        { name: "St. Patrick's Day", window: at(day(year, 2, 17), 11, 17), label: 'Parade hours' },
        { name: "Mother's Day", window: at(nthWeekday(year, 4, 0, 2), 11, 15), label: 'Brunch' },
        { name: 'Memorial Day', window: at(lastWeekday(year, 4, 1), 11, 18), label: 'Cookout hours' },
        { name: "Father's Day", window: at(nthWeekday(year, 5, 0, 3), 11, 17) },
        { name: 'Juneteenth', window: at(day(year, 5, 19), 11, 18) },
        { name: 'Independence Day', window: at(day(year, 6, 4), 21, 22), label: 'Fireworks' },
        { name: 'Labor Day', window: at(nthWeekday(year, 8, 1, 1), 11, 18), label: 'Cookout hours' },
        { name: 'Indigenous Peoples Day', window: at(nthWeekday(year, 9, 1, 2), 10, 16) },
        { name: 'Halloween', window: at(day(year, 9, 31), 17, 20), label: 'Trick-or-treat' },
        { name: 'Veterans Day', window: at(day(year, 10, 11), 10, 16) },
        { name: 'Thanksgiving', window: at(nthWeekday(year, 10, 4, 4), 9, 17), label: 'Travel and parade' },
        { name: 'Christmas Eve', window: at(day(year, 11, 24), 16, 23) },
        { name: 'Christmas', window: at(day(year, 11, 25), 8, 18) },
        { name: "New Year's Eve", window: at(day(year, 11, 31), 22, 24), label: 'Midnight' },
    ];
}

/**
 * Holiday "moments" within `days` days of `now` that the hourly forecast
 * covers: [{name, label, when, text}], e.g. Halloween trick-or-treat 58°, dry.
 */
export function moments(rows, now, days = 3) {
    const out = [];
    const y = new Date(now).getFullYear();
    for (const h of [...holidays(y), ...holidays(y + 1)]) {
        const [t0, t1] = h.window;
        if (t1 < now || t0 > now + days * 86400000) continue;
        const hrs = rows.filter(r => r.t >= t0 && r.t < t1);
        if (!hrs.length) continue;
        const temps = hrs.map(r => r.tmp);
        const wet = hrs.filter(isWet);
        const lo = Math.round(Math.min(...temps)), hi = Math.round(Math.max(...temps));
        const range = lo === hi ? `${lo}°` : `${lo}–${hi}°`;
        const sky = wet.length ? `${wet.some(r => r.snowy) ? 'snow' : 'rain'} at times`
            : hrs.every(r => (r.cloud ?? 0) < 40) ? 'clear' : 'dry';
        out.push({ name: h.name, label: h.label || h.name, when: t0, text: `${range}, ${sky}` });
    }
    return out;
}

/**
 * SVG path of the moon's lit part: a disk of radius r at (cx, cy) in
 * `phase` (0 new, 0.5 full). The limb is a half circle on the lit side,
 * the terminator a half ellipse whose width follows the phase. Northern
 * sky: lit on the right while waxing.
 */
export function moonPath(cx, cy, r, phase) {
    const k = Math.cos(2 * Math.PI * phase);   // 1 new, -1 full
    const rx = Math.abs(k) * r;
    const waxing = phase < 0.5;
    const limb = waxing ? 1 : 0;
    const term = waxing ? (k > 0 ? 0 : 1) : (k > 0 ? 1 : 0);
    return `M${cx},${cy - r}A${r},${r} 0 0 ${limb} ${cx},${cy + r}A${rx},${r} 0 0 ${term} ${cx},${cy - r}Z`;
}
