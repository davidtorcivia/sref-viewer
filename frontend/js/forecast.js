/**
 * Forecast logic for the overview page, free of DOM so it can be tested
 * (frontend/forecast.test.cjs): hourly rows from the /api/forecast series,
 * sky conditions, daily summaries and the next-precipitation sentence.
 *
 * The series is one deterministic model run (RRFS), so wording states what
 * the model shows rather than a probability.
 */

import * as Z from './zone.js?v=__V__';

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
    const label = sky(c, night);
    if (c < 20) return { key: night ? 'clear-night' : 'clear', label };
    if (c < 60) return { key: night ? 'partly-night' : 'partly', label };
    return { key: 'cloudy', label };
}

/** The sky in words from cloud cover (%): the same words as condition() */
export function sky(cloud, night) {
    return cloud < 20 ? (night ? 'Clear' : 'Sunny') : cloud < 60 ? 'Partly cloudy' : cloud < 90 ? 'Mostly cloudy' : 'Overcast';
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

const clock12 = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric' });

/**
 * One sentence about precipitation over the next 12 hours from `now`:
 * when it starts, or when it ends if it is already falling. `clock`
 * formats the hour (the user's 12/24-hour choice).
 */
export function nowcast(rows, now, clock = clock12) {
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

/**
 * The next hours from /api/nowcast (the radar, then HRRR) in words, or '' when they stay dry:
 * "Heavy rain starting in 12 min, for about 20 min", "Light rain ending in 1 h 25 min",
 * "Rain for the next 2 hours". Minutes count from `now`, not the scan.
 */
const span = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
export function nextHour(nc, now) {
    const r = nc?.rain;
    if (!r) return '';
    const mins = t => span(Math.max(1, Math.round((t * 1000 - now) / 60000)));
    const lead = (nc.dbz?.length ?? 61) - 1;
    const whole = lead === 60 ? 'hour' : lead % 60 ? span(lead) : `${lead / 60} hours`;
    const at = Math.max(0, Math.round(((r.start ?? nc.time) - nc.time) / 60));
    const kind = nc.snow?.[at] ? 'snow' : 'rain';
    const what = r.peak === 'heavy' ? `Heavy ${kind}` : r.peak === 'light' ? `Light ${kind}` : kind[0].toUpperCase() + kind.slice(1);
    if (r.start != null && r.start * 1000 > now) {
        return `${what} starting in ${mins(r.start)}${r.end != null ? `, for about ${span(Math.round((r.end - r.start) / 60))}` : ''}`;
    }
    return r.end != null ? `${what} ending in ${mins(r.end)}` : `${what} for the next ${whole}`;
}

/**
 * The days ahead in one sentence: the wettest day after today when its chance
 * is 20% or more, else how long it stays dry. `name` words a day ("Sunday",
 * "Oct 8"); `wetSoon` when rain is already in the next hours' sentence.
 */
export function outlook(days, todayKey, name, wetSoon = false) {
    const ahead = days.filter(d => d.key !== todayKey);
    if (!ahead.length) return '';
    const top = ahead.reduce((a, d) => ((d.pop ?? 0) > (a.pop ?? 0) ? d : a));
    const pop = top.pop ?? 0, kind = top.snow >= 0.1 ? 'snow' : 'rain';
    if (pop >= 60) return `${kind === 'snow' ? 'Snow' : 'Rain'} likely ${name(top)} (${pop}%)`;
    if (pop >= 30) return `Chance of ${kind} ${name(top)}, ${pop}%`;
    if (pop >= 20) return `Slight chance of ${kind} ${name(top)}, ${pop}%`;
    if (ahead.length < 3) return '';
    return `${wetSoon ? 'Dry after that' : 'No rain expected'} through ${name(ahead[ahead.length - 1])}`;
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
export function sunTimes(ms, lat, lon, tz) {
    const [start, end] = placeDay(ms, tz);
    const f = t => sunAltitude(t, lat, lon) + 0.833;
    let rise = null, set = null;
    const step = 10 * 60000;
    for (let t = start; t < end; t += step) {
        const a = f(t), b = f(t + step);
        if (a < 0 && b >= 0 && rise === null) rise = t + step * a / (a - b);
        if (a >= 0 && b < 0 && set === null) set = t + step * a / (a - b);
    }
    return { rise, set };
}

// The place's calendar day holding ms, [start, end): 23 or 25 hours on a DST day; tz undefined is the device's
function placeDay(ms, tz) {
    const start = Z.midnight(ms, tz);
    return [start, Z.midnight(start + 26 * 3600000, tz)];
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
export function moments(rows, now, days = 3, deg = f => `${Math.round(f)}°`) {
    const out = [];
    const y = new Date(now).getFullYear();
    for (const h of [...holidays(y), ...holidays(y + 1)]) {
        const [t0, t1] = h.window;
        if (t1 < now || t0 > now + days * 86400000) continue;
        const hrs = rows.filter(r => r.t >= t0 && r.t < t1);
        if (!hrs.length) continue;
        const temps = hrs.map(r => r.tmp);
        const wet = hrs.filter(isWet);
        const lo = deg(Math.min(...temps)), hi = deg(Math.max(...temps));
        const range = lo === hi ? lo : `${lo.replace('°', '')}–${hi}`;
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

/**
 * Daily rows from the NBM `daily` list ({date 'YYYY-MM-DD', hi, lo,
 * pop_day, qpf, snow, ptype, cloud, ...}), shaped like dailyRows' output:
 * {key, t (local noon), hi, lo, pop, qpf, snow, gust, cond}. The condition
 * shows precipitation only when it is both likely (30% or more) and
 * measurable; otherwise the day's mean cloud cover.
 */
export function nbmDays(daily) {
    return daily.map(d => {
        const [y, m, day] = d.date.split('-').map(Number);
        const t = new Date(y, m - 1, day, 12).getTime();
        const wet = (d.pop_day ?? 0) >= 30 && (d.qpf ?? 0) >= 0.01;
        const c = d.cloud ?? 50;
        const cond = wet ? (d.ptype === 'snow' ? { key: 'snow', label: 'Snow' } : { key: 'rain', label: d.ptype === 'ice' ? 'Freezing rain' : 'Rain' })
            : c < 25 ? { key: 'clear', label: 'Sunny' } : c < 60 ? { key: 'partly', label: 'Partly cloudy' } : { key: 'cloudy', label: 'Cloudy' };
        return { key: dayKey(t), t, hi: d.hi, lo: d.lo, pop: d.pop_day, qpf: d.qpf ?? 0, snow: d.snow ?? 0, gust: d.gust, wind: d.wind, cloud: d.cloud, cond };
    });
}

/**
 * When the sun's center crosses altitude `h` degrees on the local day of
 * `ms`: {up, down} (ms, null when it does not). h = -0.833 is sunrise and
 * sunset; -6, -12 and -18 the civil, nautical and astronomical twilights;
 * +6 the edge of golden hour.
 */
export function sunCross(ms, lat, lon, h, tz) {
    const [start, end] = placeDay(ms, tz);
    const f = t => sunAltitude(t, lat, lon) - h;
    let up = null, down = null;
    const step = 10 * 60000;
    for (let t = start; t < end; t += step) {
        const a = f(t), b = f(t + step);
        if (a < 0 && b >= 0 && up === null) up = t + step * a / (a - b);
        if (a >= 0 && b < 0 && down === null) down = t + step * a / (a - b);
    }
    return { up, down };
}

/** Solar noon on the local day of `ms`: {t, alt} at the sun's highest */
export function solarNoon(ms, lat, lon, tz) {
    const [start, end] = placeDay(ms, tz);
    let best = { t: start, alt: -90 };
    for (let t = start; t < end; t += 5 * 60000) {
        const alt = sunAltitude(t, lat, lon);
        if (alt > best.alt) best = { t, alt };
    }
    return best;
}

const rev = x => ((x % 360) + 360) % 360;
const sind = x => Math.sin(x * RAD), cosd = x => Math.cos(x * RAD);

/**
 * Moon right ascension and declination (degrees) from Paul Schlyter's
 * low-precision method with the main perturbations (a few arcminutes).
 * Also returns its ecliptic longitude and the sun's, for tests.
 */
export function moonPosition(ms) {
    const d = ms / 86400000 + 2440587.5 - 2451543.5;
    const N = rev(125.1228 - 0.0529538083 * d), i = 5.1454, w = rev(318.0634 + 0.1643573223 * d);
    const a = 60.2666, e = 0.054900, M = rev(115.3654 + 13.0649929509 * d);
    const ws = rev(282.9404 + 4.70935e-5 * d), Ms = rev(356.0470 + 0.9856002585 * d);
    let E = M + (180 / Math.PI) * e * sind(M) * (1 + e * cosd(M));
    for (let k = 0; k < 5; k++) E -= (E - (180 / Math.PI) * e * sind(E) - M) / (1 - e * cosd(E));
    const xv = a * (cosd(E) - e), yv = a * Math.sqrt(1 - e * e) * sind(E);
    const v = Math.atan2(yv, xv) / RAD, r = Math.hypot(xv, yv);
    const xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
    const yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
    const zh = r * sind(v + w) * sind(i);
    let lon = Math.atan2(yh, xh) / RAD, lat = Math.atan2(zh, Math.hypot(xh, yh)) / RAD;
    const Ls = rev(ws + Ms), Lm = rev(N + w + M), D = rev(Lm - Ls), F = rev(Lm - N);
    lon += -1.274 * sind(M - 2 * D) + 0.658 * sind(2 * D) - 0.186 * sind(Ms) - 0.059 * sind(2 * M - 2 * D)
        - 0.057 * sind(M - 2 * D + Ms) + 0.053 * sind(M + 2 * D) + 0.046 * sind(2 * D - Ms) + 0.041 * sind(M - Ms)
        - 0.035 * sind(D) - 0.031 * sind(M + Ms) - 0.015 * sind(2 * F - 2 * D) + 0.011 * sind(M - 4 * D);
    lat += -0.173 * sind(F - 2 * D) - 0.055 * sind(M - F - 2 * D) - 0.046 * sind(M + F - 2 * D)
        + 0.033 * sind(F + 2 * D) + 0.017 * sind(2 * M + F);
    const ecl = 23.4393 - 3.563e-7 * d;
    const x = cosd(lon) * cosd(lat), y = sind(lon) * cosd(lat), z = sind(lat);
    const ye = y * cosd(ecl) - z * sind(ecl), ze = y * sind(ecl) + z * cosd(ecl);
    // Sun's ecliptic longitude from its own orbit, for elongation checks
    const Es = Ms + (180 / Math.PI) * 0.016709 * sind(Ms) * (1 + 0.016709 * cosd(Ms));
    const vs = Math.atan2(Math.sqrt(1 - 0.016709 ** 2) * sind(Es), cosd(Es) - 0.016709) / RAD;
    return { ra: rev(Math.atan2(ye, x) / RAD), dec: Math.atan2(ze, Math.hypot(x, ye)) / RAD, lon: rev(lon), sunLon: rev(vs + ws) };
}

export function moonAltitude(ms, lat, lon) {
    const { ra, dec } = moonPosition(ms);
    const D = ms / 86400000 - 10957.5;
    const ha = ((18.697374558 + 24.06570982441908 * D) % 24) * 15 + lon - ra;
    return Math.asin(sind(lat) * sind(dec) + cosd(lat) * cosd(dec) * cosd(ha)) / RAD;
}

/** Moonrise and moonset on the local day of `ms` (+0.125 degrees: refraction, radius, parallax) */
export function moonTimes(ms, lat, lon, tz) {
    const [start, end] = placeDay(ms, tz);
    const f = t => moonAltitude(t, lat, lon) - 0.125;
    let rise = null, set = null;
    const step = 10 * 60000;
    for (let t = start; t < end; t += step) {
        const a = f(t), b = f(t + step);
        if (a < 0 && b >= 0 && rise === null) rise = t + step * a / (a - b);
        if (a >= 0 && b < 0 && set === null) set = t + step * a / (a - b);
    }
    return { rise, set };
}

/** The next new, first quarter, full and last quarter moons after `ms`, in date order */
export function nextPhases(ms) {
    return [[0, 'New moon'], [0.25, 'First quarter'], [0.5, 'Full moon'], [0.75, 'Last quarter']]
        .map(([p, name]) => ({ name, t: nextMoon(ms + 3600000, p) }))
        .sort((a, b) => a.t - b.t);
}

/**
 * Estimated UV index: a clear-sky curve on solar elevation (12.5 * sin(alt)^2.42,
 * about 11 at a summer noon sun and 6 at a late-September one in NYC) cut by
 * cloud cover (up to 56% for overcast). No model here forecasts UV, so this
 * ignores ozone and haze: shown as an estimate.
 */
export function uvIndex(alt, cloud) {
    if (alt <= 0) return 0;
    return 12.5 * Math.sin(alt * RAD) ** 2.42 * (1 - 0.56 * Math.min(Math.max(cloud ?? 0, 0), 100) / 100);
}

export function uvCategory(uv) {
    return uv < 3 ? 'Low' : uv < 6 ? 'Moderate' : uv < 8 ? 'High' : uv < 11 ? 'Very high' : 'Extreme';
}
