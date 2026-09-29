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

// The ramp for a line on the page: lightness capped on paper, floored on dark, a little more chroma
export function lineColor(f, dark, alpha = 1) {
    const [l, c, h] = rampColor(f).match(/[\d.]+/g).map(Number);
    const L = dark ? Math.max(l, 0.68) : Math.min(l, 0.64);
    return `oklch(${L.toFixed(3)} ${(c * 1.2).toFixed(3)} ${h}${alpha < 1 ? ` / ${alpha}` : ''})`;
}

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
const EDGE = 272;         // the disk's radius: the outer lap's hours reach it
const ARROW_BAND = 13;    // the wind arrows ride this deep inside each hour's outer edge
const HOUR_GAP = 0.03;    // hours of space between neighboring wedges

/**
 * The spiral's shapes in a 520-unit box. s is hours since now - 24 h: s 0..24
 * is the inner lap (observed), 24..48 the outer (forecast); both laps start at
 * the top and run clockwise, so the same time of day lines up across them.
 *   past:   [{t, tmp, precip, cloud, wind, dir}] hourly observations (°F, inches, %, mph), oldest first
 *   future: [{t, tmp, qpf, cloud, wind, dir}] hourly forecast rows
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
        // before the first observation (the lap starts mid-hour) the first one stands in, up to two hours back
        if (pastPts.length && t < pastPts[0].t && pastPts[0].t - t <= 2 * HOUR) return pastPts[0].v;
        return valueAt(pastPts, t);
    };

    const segs = [];
    for (let q = 0; q < 192; q++) {
        const a = q / 4, b = Math.min(48, (q + 1) / 4 + 0.04), v = temp(a + 0.125);
        const p1 = P(R(a) - W, a), p2 = P(R(a) + W, a), p3 = P(R(b) + W, b), p4 = P(R(b) - W, b);
        segs.push({ s: a, t: tOf(a), tmp: v, observed: a < 24,
            d: `M${f1(p1[0])},${f1(p1[1])} L${f1(p2[0])},${f1(p2[1])} L${f1(p3[0])},${f1(p3[1])} L${f1(p4[0])},${f1(p4[1])} Z` });
    }
    const track = [];
    for (let q = 0; q <= 192; q++) { const s = q / 4, m = P(R(s), s); track.push(`${f1(m[0])},${f1(m[1])}`); }
    // round ends: the start turns in, the end turns out
    const cap = s => { const [x, y] = P(R(s), s); return { x: f1(x), y: f1(y), r: W, tmp: temp(Math.min(47.9, Math.max(0.05, s))) }; };
    // the start turns in with a shallow arch: a circle behind the start edge that bites DEPTH into the band
    const DEPTH = 5, back = (W * W - DEPTH * DEPTH) / (2 * DEPTH), a0 = A(0);
    const [sx, sy] = P(R(0), 0);
    const notch = { x: f1(sx + Math.sin(a0) * back), y: f1(sy - Math.cos(a0) * back), r: f1(back + DEPTH) };

    // rain: a drop on the band for each wet hour, sized by the amount (0.01 in to 0.25 in and up)
    const rain = [];
    const drop = (s0, inches, t) => {
        if (!(inches >= 0.01)) return;
        const s = s0 + 0.5, [x, y] = P(R(s), s), r = 3 + Math.min(1, Math.sqrt(inches / 0.25)) * 5.5;
        rain.push({ t, inches, x: f1(x), y: f1(y), d: dropPath(x, y, r) });
    };
    for (const h of past) { const s = (h.t - t0) / HOUR; if (s >= 0 && s < 24) drop(s, h.precip, h.t); }
    for (const r of future) { const s = 24 + (r.t - now) / HOUR; if (s >= 24 && s < 48) drop(s, r.qpf, r.t); }

    // Each hour a wedge from its lap out to the next lap (the outer lap's: to the disk's edge),
    // dark at night, and a graph of the sky: filled from its outer edge in, full when overcast,
    // empty when clear. The wind rides near its outer edge (the way it blows, longer when stronger)
    const dark = t => nights.some(([a, b]) => t >= a && t < b);
    const along = (sa, sb, r) => Array.from({ length: 7 }, (_, i) => { const v = sa + (sb - sa) * i / 6; return P(r(v), v); });
    const shape = (sa, sb, rIn, rOut) => `M${[...along(sa, sb, rIn), ...along(sa, sb, rOut).reverse()].map(p => `${f1(p[0])},${f1(p[1])}`).join('L')}Z`;
    const hours = [];
    const hour = (t, s0, observed, h) => {
        const sa = Math.max(observed ? 0 : 24, s0) + HOUR_GAP, sb = Math.min(observed ? 24 : 48, s0 + 1) - HOUR_GAP;
        if (sb - sa < 0.1) return;
        const rIn = v => R(v) + W + 2, rOut = v => (observed ? R(v + 24) - W - 2 : EDGE);
        const depth = v => Math.min(ARROW_BAND, (rOut(v) - rIn(v)) * 0.45);   // where the arrow sits
        const cloud = h.cloud == null ? null : Math.max(0, Math.min(100, h.cloud));
        const sm = (sa + sb) / 2, [x, y] = P(rOut(sm) - depth(sm) / 2, sm);
        let arrow = null;
        if (h.wind != null && h.dir != null && h.wind >= 0.5) {
            // the inner lap's room between laps is narrow: shorter arrows there
            // (capped to the gap between the laps, so it never crosses onto the next lap's band)
            const len = observed ? Math.min(6 + Math.min(h.wind, 30) * 0.5, depth(sm) + 4) : 6 + Math.min(h.wind, 30) * 1.2;
            const a = (h.dir + 180) * Math.PI / 180;
            arrow = windArrow(x - Math.sin(a) * len / 2, y + Math.cos(a) * len / 2, h.dir, len, observed ? 4.5 : 6);
            arrow.x = f1(x - Math.sin(a) * len / 2); arrow.y = f1(y + Math.cos(a) * len / 2);
        }
        hours.push({ t, observed, night: dark(t + HOUR / 2), cloud, wind: h.wind, dir: h.dir, gust: h.gust ?? null, arrow,
            d: shape(sa, sb, rIn, rOut),
            cover: cloud ? shape(sa, sb, v => rOut(v) - (rOut(v) - rIn(v)) * cloud / 100, rOut) : null });
    };
    for (const h of past) hour(h.t, (h.t - t0) / HOUR, true, h);
    for (const r of future) hour(r.t, 24 + (r.t - now) / HOUR, false, r);

    // Key points, placed; the caller words them
    const ahead = future.filter(r => r.t + HOUR > now && r.t < now + 24 * HOUR);
    const lo = ahead.reduce((m, r) => (m == null || r.tmp < m.tmp ? r : m), null);
    const hi = ahead.reduce((m, r) => (m == null || r.tmp >= m.tmp ? r : m), null);
    const nowPt = P(R(24), 24);
    const pastRain = past.reduce((a, h) => a + (h.precip || 0), 0);
    const pastTemps = past.map(h => h.tmp).filter(v => v != null);
    return {
        segs, rain, hours, track: `M${track.join('L')}`,
        caps: [cap(0), cap(48)], notch,
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
