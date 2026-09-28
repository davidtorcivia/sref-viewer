/**
 * Geometry and color for the overview's Signal layout: the temperature ramp,
 * ensemble quantiles, and the 48-hour spiral (the last 24 hours observed on
 * the inner lap, the next 24 forecast on the outer, joined at now at the
 * top). Pure functions over plain numbers; overview.js draws them. Checked by
 * frontend/forecast.test.cjs.
 */

// One temperature scale for the whole page, interpolated in OKLCH so equal
// steps look equal. [°F, L, C, h]
const RAMP = [[-10, .42, .09, 290], [10, .5, .11, 272], [20, .55, .10, 262], [32, .63, .09, 238], [40, .68, .09, 225],
    [55, .79, .07, 170], [65, .85, .11, 98], [75, .77, .15, 58], [85, .65, .19, 34], [95, .53, .18, 22], [110, .42, .15, 12]];

export function rampColor(f) {
    const r = RAMP;
    const at = (a, b, x) => a + (b - a) * x;
    const fmt = (l, c, h) => `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
    if (!(f > r[0][0])) return fmt(r[0][1], r[0][2], r[0][3]);
    for (let i = 1; i < r.length; i++) {
        if (f <= r[i][0]) {
            const x = (f - r[i - 1][0]) / (r[i][0] - r[i - 1][0]);
            return fmt(at(r[i - 1][1], r[i][1], x), at(r[i - 1][2], r[i][2], x), at(r[i - 1][3], r[i][3], x));
        }
    }
    const l = r[r.length - 1];
    return fmt(l[1], l[2], l[3]);
}

// Quantile q (0.1..0.9) of one REFS row {y (mean), p10, p25, p75, p90},
// linear between the published levels; the mean stands in for the median
const QL = [0.1, 0.25, 0.5, 0.75, 0.9];
export function quantile(row, q) {
    const v = [row.p10, row.p25, row.y, row.p75, row.p90];
    let k = 0;
    while (k < 3 && q > QL[k + 1]) k++;
    return v[k] + (v[k + 1] - v[k]) * (q - QL[k]) / (QL[k + 1] - QL[k]);
}

const f1 = n => n.toFixed(1);

export function annulus(cx, cy, r1, r2, a0, a1) {
    const p = (r, a) => `${f1(cx + r * Math.cos(a))},${f1(cy + r * Math.sin(a))}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M${p(r2, a0)} A${r2},${r2} 0 ${large} 1 ${p(r2, a1)} L${p(r1, a1)} A${r1},${r1} 0 ${large} 0 ${p(r1, a0)} Z`;
}

// An arrow from (x, y) the way the wind blows (dirFrom is where it comes
// from, degrees clockwise from north): the shaft end and a filled head
export function windArrow(x, y, dirFrom, len, head) {
    const a = (dirFrom + 180) * Math.PI / 180, ux = Math.sin(a), uy = -Math.cos(a);
    const x2 = x + ux * len, y2 = y + uy * len, bx = x2 - ux * head, by = y2 - uy * head, px = -uy * head * 0.55, py = ux * head * 0.55;
    return { x2, y2, head: `M${f1(x2 + ux * 1.5)},${f1(y2 + uy * 1.5)} L${f1(bx + px)},${f1(by + py)} L${f1(bx - px)},${f1(by - py)} Z` };
}

// Linear value at time t over [{t, v}] sorted by t; null outside or across a gap
export function valueAt(pts, t) {
    const k = pts.findIndex(p => p.t >= t);
    if (k < 0) return null;
    if (pts[k].t === t) return pts[k].v;
    if (k === 0) return null;
    const a = pts[k - 1], b = pts[k];
    if (a.v == null || b.v == null || b.t - a.t > 3 * 3600000) return null;
    return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
}

const HOUR = 3600000;
export const SPIRAL = { C: 260, W: 13, r0: 120, r1: 220 };

/**
 * The spiral's shapes in a 520-unit box. s is hours since now - 24 h: s 0..24
 * is the inner lap (observed), 24..48 the outer (forecast); both laps start at
 * the top and run clockwise, so the same time of day lines up across them.
 *   past:   [{t, tmp, precip}] hourly observations (°F, inches), oldest first
 *   future: [{t, tmp, qpf, wind, dir}] hourly forecast rows
 *   now, nowTemp: the join, which shows the analysis value
 *   nights: [[start, end]] ms, sun below the horizon
 * Colors come back as temperatures (°F); the caller paints them.
 */
export function spiral({ past, future, now, nowTemp, nights = [] }) {
    const { C, W, r0, r1 } = SPIRAL;
    const R = s => r0 + s / 48 * (r1 - r0);
    const A = s => ((s % 24) / 24) * 2 * Math.PI - Math.PI / 2;
    const P = (r, s) => [C + r * Math.cos(A(s)), C + r * Math.sin(A(s))];
    const t0 = now - 24 * HOUR;
    const tOf = s => t0 + s * HOUR;
    past = past.filter(h => h.t + HOUR > t0);   // hours that overlap the last 24
    // an hour's observation stands for its middle; hours without one leave a gap
    const pastPts = past.filter(h => h.tmp != null).map(h => ({ t: h.t + HOUR / 2, v: h.tmp }));
    const futPts = future.map(r => ({ t: r.t, v: r.tmp }));
    const lastObs = pastPts[pastPts.length - 1];
    const temp = s => {
        const t = tOf(s);
        if (s >= 23.999) return s <= 24.25 ? nowTemp ?? valueAt(futPts, t) : valueAt(futPts, t) ?? null;
        // after the last observation the lap runs straight into the analysis value at the join
        if (lastObs && t > lastObs.t && nowTemp != null && now - lastObs.t <= 3 * HOUR) {
            return lastObs.v + (nowTemp - lastObs.v) * (t - lastObs.t) / (now - lastObs.t);
        }
        return valueAt(pastPts, t);
    };

    const segs = [];
    for (let q = 0; q < 192; q++) {
        const a = q / 4, b = (q + 1) / 4, v = temp(a + 0.125);
        const p1 = P(R(a) - W, a), p2 = P(R(a) + W, a), p3 = P(R(b) + W, b), p4 = P(R(b) - W, b);
        segs.push({ s: a, t: tOf(a), tmp: v, observed: a < 24,
            d: `M${f1(p1[0])},${f1(p1[1])} L${f1(p2[0])},${f1(p2[1])} L${f1(p3[0])},${f1(p3[1])} L${f1(p4[0])},${f1(p4[1])} Z` });
    }
    const track = [];
    for (let q = 0; q <= 192; q++) { const s = q / 4, m = P(R(s), s); track.push(`${f1(m[0])},${f1(m[1])}`); }
    // round ends: the start turns in, the end turns out
    const cap = s => { const [x, y] = P(R(s), s); return { x: f1(x), y: f1(y), r: W, tmp: temp(Math.min(47.9, Math.max(0.05, s))) }; };

    // rain: a drop on the band for each wet hour, sized by the amount (0.01 in to 0.25 in and up)
    const rain = [];
    const drop = (s0, inches, t) => {
        if (!(inches >= 0.01)) return;
        const s = s0 + 0.5, [x, y] = P(R(s), s), r = 3 + Math.min(1, Math.sqrt(inches / 0.25)) * 5.5;
        rain.push({ t, inches, x: f1(x), y: f1(y), d: dropPath(x, y, r) });
    };
    for (const h of past) { const s = (h.t - t0) / HOUR; if (s >= 0 && s < 24) drop(s, h.precip, h.t); }
    for (const r of future) { const s = 24 + (r.t - now) / HOUR; if (s >= 24 && s < 48) drop(s, r.qpf, r.t); }

    // night: one wedge per dark spell behind both laps (sunset and sunrise barely move in a day)
    const wedges = [];
    for (const [a, b] of nights) {
        const sa = Math.max(0, (a - now) / HOUR), sb = Math.min(24, (b - now) / HOUR);
        if (sb - sa < 0.05) continue;
        const th = s => (s / 24) * 2 * Math.PI - Math.PI / 2;
        wedges.push({ a, b, d: annulus(C, C, r0 - 20, r1 + W + 38, th(sa), th(sb)) });
    }

    // wind ahead: every two hours outside the outer lap, longer when stronger
    const wind = [];
    for (const r of future) {
        const s = 24 + (r.t - now) / HOUR + 0.5;
        if (s < 24 || s >= 48 || Math.round((r.t - future[0].t) / HOUR) % 2) continue;
        const [x, y] = P(R(s) + W + 20, s);
        wind.push({ t: r.t, x: f1(x), y: f1(y), wind: r.wind, dir: r.dir, ...windArrow(x, y, r.dir, 5 + Math.min(r.wind, 30) * 1.6, 6) });
    }

    // Key points, placed; the caller words them
    const ahead = future.filter(r => r.t + HOUR > now && r.t < now + 24 * HOUR);
    const lo = ahead.reduce((m, r) => (m == null || r.tmp < m.tmp ? r : m), null);
    const hi = ahead.reduce((m, r) => (m == null || r.tmp >= m.tmp ? r : m), null);
    const nowPt = P(R(24), 24);
    const pastRain = past.reduce((a, h) => a + (h.precip || 0), 0);
    const pastTemps = past.map(h => h.tmp).filter(v => v != null);
    return {
        segs, rain, wedges, wind, track: `M${track.join('L')}`,
        caps: [cap(0), cap(48)],
        now: { x: f1(nowPt[0]), y: f1(nowPt[1]) },
        table: {
            pastRain: past.length ? pastRain : null, nextRain: ahead.reduce((a, r) => a + (r.qpf || 0), 0),
            pastLow: pastTemps.length ? Math.min(...pastTemps) : null, nextLow: lo?.tmp ?? null,
            pastHigh: pastTemps.length ? Math.max(...pastTemps) : null, nextHigh: hi?.tmp ?? null,
            nextLowAt: lo?.t ?? null, nextHighAt: hi?.t ?? null,
        },
    };
}

// A raindrop of radius r centered at (x, y), point up
export function dropPath(x, y, r) {
    const p = (dx, dy) => `${f1(x + dx * r)},${f1(y + dy * r)}`;
    return `M${p(0, -1.75)} C${p(0.55, -0.95)} ${p(1, -0.35)} ${p(1, 0.15)} A${f1(r)},${f1(r)} 0 1 1 ${p(-1, 0.15)} C${p(-1, -0.35)} ${p(-0.55, -0.95)} ${p(0, -1.75)} Z`;
}

// Angle-to-time for a pointer on the spiral: the lap is picked by radius
export function spiralTimeAt(x, y, now) {
    const { C, r0, r1 } = SPIRAL;
    const dx = x - C, dy = y - C, r = Math.hypot(dx, dy);
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    if (a < 0) a += 2 * Math.PI;
    const frac = a / (2 * Math.PI);
    // the two laps at this angle sit at R(24 frac) and R(24 + 24 frac)
    const R = s => r0 + s / 48 * (r1 - r0);
    const inner = R(24 * frac), outer = R(24 + 24 * frac);
    const s = Math.abs(r - inner) < Math.abs(r - outer) ? 24 * frac : 24 + 24 * frac;
    return now - 24 * HOUR + s * HOUR;
}
