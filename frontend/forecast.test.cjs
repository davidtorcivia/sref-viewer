// Run: TZ=America/New_York node frontend/forecast.test.cjs
const assert = require('node:assert/strict');

(async () => {
    const f = await import('./js/forecast.js');
    const H = 3600000;
    const start = Date.parse('2026-09-28T04:00:00Z');   // midnight EDT
    const row = (i, o = {}) => ({ t: start + i * H, tmp: 60, dpt: 50, wind: 5, dir: 180, gust: 10, cloud: 10,
        qpf: 0, snow: 0, snowy: false, dbz: -10, ...o });

    // Conditions
    assert.equal(f.condition(row(0), false).key, 'clear');
    assert.equal(f.condition(row(0), true).label, 'Clear');
    assert.equal(f.condition(row(0, { cloud: 95 }), false).label, 'Cloudy');
    assert.equal(f.condition(row(0, { qpf: 0.15 }), false).label, 'Rain');
    assert.equal(f.condition(row(0, { qpf: 0.05, snowy: true }), false).label, 'Snow');
    assert.equal(f.condition(row(0, { dbz: 55, qpf: 0.4 }), false).key, 'storm');

    // Next-precipitation sentence
    const dry = Array.from({ length: 24 }, (_, i) => row(i));
    assert.equal(f.nowcast(dry, start), 'Dry for the next 12 hours');
    const later = dry.map((r, i) => (i === 3 ? { ...r, qpf: 0.05 } : r));
    assert.match(f.nowcast(later, start), /^Rain starting around 3 AM$/);
    const now = dry.map((r, i) => (i < 2 ? { ...r, qpf: 0.05, snowy: true } : r));
    assert.match(f.nowcast(now, start + 30 * 60000), /^Snow ending around 2 AM$/);

    // Days: local days, most severe daytime condition, short trailing day dropped
    const rows = Array.from({ length: 30 }, (_, i) => row(i, { tmp: 50 + i, qpf: i === 14 ? 0.2 : 0 }));
    const days = f.dailyRows(rows);
    assert.equal(days.length, 1, 'a 6-hour second day is dropped');
    assert.deepEqual([days[0].lo, days[0].hi, days[0].hours], [50, 73, 24]);
    assert.equal(days[0].cond.key, 'rain');

    // Sun: NYC noon EDT is day, midnight is night
    assert.ok(f.sunAltitude(Date.parse('2026-09-28T16:00:00Z'), 40.7, -74) > 30);
    assert.ok(f.sunAltitude(Date.parse('2026-09-28T04:00:00Z'), 40.7, -74) < -30);

    // Monotone curve never overshoots a flat stretch
    const path = f.monotonePath([[0, 10], [1, 20], [2, 20], [3, 5]]);
    const ys = [...path.matchAll(/,(-?[\d.]+)/g)].map(m => Number(m[1]));
    assert.ok(Math.max(...ys) <= 20 && Math.min(...ys) >= 5, 'control points stay within the data');

    assert.equal(f.tempColor(-60), 'rgb(255,255,255)');
    assert.equal(f.tempColor(32), 'rgb(94,198,242)');
    assert.equal(f.compass(225), 'SW');
    console.log('Forecast checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
