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
    // Sun times: NYC 2026-09-28, reference sunrise 6:48, sunset 6:43 PM EDT (within ~3 min)
    const st = f.sunTimes(Date.parse('2026-09-28T16:00:00Z'), 40.71, -74.0);
    assert.ok(Math.abs(st.rise - Date.parse('2026-09-28T10:48:00Z')) < 4 * 60000, `sunrise ${new Date(st.rise).toISOString()}`);
    assert.ok(Math.abs(st.set - Date.parse('2026-09-28T22:43:00Z')) < 4 * 60000, `sunset ${new Date(st.set).toISOString()}`);
    const noon = f.sunPosition(Date.parse('2026-09-28T16:53:00Z'), 40.71, -74.0);
    assert.ok(Math.abs(noon.az - 180) < 3, `solar noon azimuth ${noon.az}`);

    // Moon: full moon 2026-09-26 16:49 UTC; new moon 2026-10-10 15:50 UTC
    assert.ok(f.moonPhase(Date.parse('2026-09-26T16:49:00Z')).illum > 0.99);
    assert.ok(Math.abs(f.nextMoon(Date.parse('2026-09-28T00:00:00Z'), 0) - Date.parse('2026-10-10T15:50:00Z')) < 18 * 3600000);

    // Comfort
    assert.equal(f.comfort(68), 'Muggy');
    assert.ok(Math.abs(f.feelsLike(20, 5, 20) - 4) < 1.5, 'wind chill 20°F at 20 mph ~4°F');
    assert.ok(Math.abs(f.feelsLike(95, 75, 5) - 108) < 2, 'heat index 95°F at ~52% humidity ~108°F (NWS table)');
    assert.ok(Math.abs(f.humidity(70, 70) - 100) < 0.1);

    // Holidays: Thanksgiving 2026 is Nov 26; a Halloween moment from covering hours
    assert.equal(new Date(f.holidays(2026).find(h => h.name === 'Thanksgiving').window[0]).getDate(), 26);
    const hw = Date.parse('2026-10-31T21:00:00Z');   // 5 PM EDT
    const hrows = Array.from({ length: 4 }, (_, i) => ({ t: hw + i * H, tmp: 55 + i, cloud: 10, qpf: 0, dbz: -10, snowy: false }));
    const m = f.moments(hrows, hw - 86400000);
    assert.equal(m.length, 1);
    assert.equal(m[0].text, '55–57°, clear');
    console.log('Forecast checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
