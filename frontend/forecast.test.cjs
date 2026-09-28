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
    // NBM days: local noon, likely-and-measurable precipitation sets the condition
    const nd = f.nbmDays([{ date: '2026-10-04', hi: 71, lo: 62, pop_day: 37, qpf: 0.65, ptype: 'rain', cloud: 77 },
        { date: '2026-10-05', hi: 69, lo: null, pop_day: 20, qpf: 0.25, ptype: 'rain', cloud: 54 }]);
    assert.equal(new Date(nd[0].t).getHours(), 12);
    assert.equal(nd[0].key, '2026-10-4');
    assert.equal(nd[0].cond.key, 'rain');
    assert.equal(nd[1].cond.key, 'partly', 'a 20% chance does not make a rain day');

    // Twilight: each crossing is where the sun's altitude equals the target, in order through the day
    const day0 = Date.parse('2026-09-28T16:00:00Z');
    const cross = [-18, -12, -6, -0.833, 6].map(h => [h, f.sunCross(day0, 40.71, -74.0, h)]);
    for (const [h, c] of cross) {
        for (const t of [c.up, c.down]) assert.ok(Math.abs(f.sunAltitude(t, 40.71, -74.0) - h) < 0.05, `altitude at ${h}`);
    }
    const ups = cross.map(([, c]) => c.up), downs = cross.map(([, c]) => c.down);
    assert.ok(ups.every((t, i) => !i || t > ups[i - 1]) && downs.every((t, i) => !i || t < downs[i - 1]), 'twilights in order');
    // Sunrise from sunCross matches sunTimes (checked above against the published 6:48 AM)
    assert.ok(Math.abs(cross[3][1].up - st.rise) < 60000);
    const noonT = f.solarNoon(day0, 40.71, -74.0);
    assert.ok(Math.abs(noonT.t - (st.rise + st.set) / 2) < 6 * 60000, 'solar noon midway between rise and set');

    // Moon: opposite the sun (within a degree or two) at the 2026-09-26 16:49 UTC full moon
    const mp = f.moonPosition(Date.parse('2026-09-26T16:49:00Z'));
    const elong = Math.abs((((mp.lon - mp.sunLon) % 360) + 360) % 360 - 180);   // 0 at exactly opposite
    assert.ok(elong < 2, `full moon elongation off by ${elong.toFixed(2)} degrees`);
    const mt = f.moonTimes(Date.parse('2026-09-28T16:00:00Z'), 40.71, -74.0);
    assert.ok(mt.rise && mt.set, 'moon rises and sets on an ordinary day');
    // DST days (run with TZ=America/New_York): the 23h day ends before the Mar 9 00:42 EDT moonrise,
    // the 25h day keeps its last hour for the 23:14 EST one
    if (new Date(2026, 2, 8, 12).getTimezoneOffset() === 240) {
        assert.equal(f.moonTimes(new Date(2026, 2, 8, 12).getTime(), 40.71, -74.0).rise, null);
        const nov = f.moonTimes(new Date(2026, 10, 1, 12).getTime(), 40.71, -74.0).rise;
        assert.ok(nov && new Date(nov).getDate() === 1 && new Date(nov).getHours() === 23, 'Nov 1 moonrise in its last hour');
    }
    assert.deepEqual(f.nextPhases(Date.parse('2026-09-28T00:00:00Z')).map(p => p.name), ['Last quarter', 'New moon', 'First quarter', 'Full moon']);

    // UV estimate: clear summer noon ~11, overcast cuts it, night is 0
    assert.ok(Math.abs(f.uvIndex(72, 0) - 11.1) < 0.3);
    assert.ok(f.uvIndex(72, 100) < f.uvIndex(72, 0) * 0.45);
    assert.equal(f.uvIndex(-5, 0), 0);
    assert.equal(f.uvCategory(6.4), 'High');

    // Units
    const u = await import('./js/units.js');
    const C = u.parseUnits('{"temp":"C","wind":"kmh","precip":"mm","clock":"24","bogus":1}');
    assert.deepEqual(C, { temp: 'C', wind: 'kmh', precip: 'mm', clock: '24' });
    assert.deepEqual(u.parseUnits('{"temp":"K"}'), u.DEFAULT_UNITS, 'unknown values fall back');
    assert.deepEqual(u.parseUnits('not json'), u.DEFAULT_UNITS);
    assert.equal(u.deg(212, C), '100°');
    assert.equal(u.deg(null, C), '--');
    assert.equal(u.wind(10, C), '16 km/h');
    assert.equal(u.wind(10, { ...C, wind: 'kts' }), '9 kt');
    assert.equal(u.precip(1, C), '25 mm');
    assert.equal(u.precip(2, C, true), '5.1 cm');
    assert.equal(u.precip(0.254, u.DEFAULT_UNITS), '0.25"');
    assert.equal(u.clock(Date.parse('2026-09-28T19:05:00Z'), C), '15:05');
    assert.equal(u.clock(Date.parse('2026-09-28T19:05:00Z'), u.DEFAULT_UNITS, false), '3PM');
    // Signal layout: ramp, quantiles, the spiral
    const sg = await import('./js/signal.js');
    assert.match(sg.rampColor(63), /^oklch\(/);
    assert.equal(sg.rampColor(-100), sg.rampColor(-10));
    assert.equal(sg.rampColor(200), sg.rampColor(110));
    assert.equal(sg.rampColor(NaN), sg.rampColor(-10));
    const qrow = { y: 60, p10: 56, p25: 58, p75: 62, p90: 64 };
    assert.equal(sg.quantile(qrow, 0.1), 56);
    assert.equal(sg.quantile(qrow, 0.5), 60);
    assert.equal(sg.quantile(qrow, 0.9), 64);
    assert.equal(sg.quantile(qrow, 0.2), 56 + 2 * (0.1 / 0.15));
    assert.equal(sg.valueAt([{ t: 0, v: 1 }, { t: 10, v: 3 }], 5), 2);
    assert.equal(sg.valueAt([{ t: 0, v: 1 }, { t: 10, v: 3 }], 11), null);
    assert.equal(sg.valueAt([{ t: 0, v: 1 }, { t: 4 * H, v: 3 }], H), null);   // across a gap
    {
        const now = Date.parse('2026-09-28T19:15:00Z');
        const h0 = Math.floor(now / H) * H;
        const past = Array.from({ length: 25 }, (_, i) => ({ t: h0 - 24 * H + i * H, tmp: 60 + (i % 3), precip: i === 2 ? 0.1 : i === 5 ? 0 : null }));
        const future = Array.from({ length: 26 }, (_, i) => ({ t: h0 + i * H, tmp: 55 + i / 2, qpf: i === 3 ? 0.02 : 0, wind: 10, dir: 270 }));
        const sp = sg.spiral({ past, future, now, nowTemp: 63, nights: [[now + 3 * H, now + 15 * H]] });
        assert.equal(sp.segs.length, 192);
        assert.ok(sp.segs[0].observed && !sp.segs[96].observed);
        assert.equal(sp.segs[96].tmp, 63);                       // the join shows the analysis value
        assert.equal(sp.now.x, '260.0');                         // now sits at the top
        assert.equal(sp.rain.length, 2);                         // one drop per wet hour
        assert.ok(sp.rain[0].t < now && sp.rain[1].t > now);
        assert.equal(sp.wedges.length, 1);
        assert.equal(sp.table.pastRain, 0.1);
        assert.equal(sp.table.pastLow, 60);
        assert.equal(sp.table.nextLow, 55);
        assert.ok(Math.abs(sp.table.nextRain - 0.02) < 1e-9);
        assert.equal(sp.table.nextHigh, 67);                     // the hour starting 24 h out still counts
        assert.equal(sp.table.nextLowAt, h0);
        assert.equal(sp.wind.length, 12);
        assert.equal(sp.caps.length, 2);
        assert.equal(sp.caps[0].x, '260.0');                     // both ends sit at the top
        // the current hour's report not in yet: the lap still reaches now, no gap
        const gap = past.map((h, i) => (i === past.length - 1 ? { ...h, tmp: null } : h));
        const sp2 = sg.spiral({ past: gap, future, now, nowTemp: 63 });
        assert.ok(sp2.segs.slice(88, 96).every(x => x.tmp != null));
        assert.ok(Math.abs(sp2.segs[95].tmp - 63) < 1);
        // a pointer on the outer lap just clockwise of the top reads as just after now
        const t = sg.spiralTimeAt(260 + 5, 260 - (120 + 25 / 48 * 100), now);
        assert.ok(t > now && t < now + 2 * H, 'outer lap is the future');
        const tp = sg.spiralTimeAt(260 + 5, 260 - (120 + 1 / 48 * 100), now);
        assert.ok(tp < now - 20 * H, 'inner lap is the past');
    }
    // Place time zones
    const z = await import('./js/zone.js');
    const LA = 'America/Los_Angeles', NY = 'America/New_York';
    const t0 = Date.parse('2026-09-29T03:30:00Z');             // 11:30 PM EDT Sep 28, 8:30 PM PDT Sep 28
    assert.equal(z.day(t0, NY), '2026-09-28');
    assert.equal(z.day(Date.parse('2026-09-29T05:30:00Z'), NY), '2026-09-29');
    assert.equal(z.day(Date.parse('2026-09-29T05:30:00Z'), LA), '2026-09-28');
    assert.equal(z.hour(t0, LA), 20);
    assert.equal(z.midnight(t0, LA), Date.parse('2026-09-28T07:00:00Z'));
    assert.equal(z.noon(t0, LA), Date.parse('2026-09-28T19:00:00Z'));
    // across the November change the day is 25 hours and the midnights still land on 00:00
    const ms = z.midnights(Date.parse('2026-10-31T12:00:00Z'), Date.parse('2026-11-03T12:00:00Z'), LA);
    assert.deepEqual(ms.map(m => z.hour(m, LA)), [0, 0, 0]);
    assert.equal(ms[1] - ms[0], 25 * H);
    assert.equal(z.format(t0, { weekday: 'short' }, LA), 'Mon');
    assert.equal(u.clock(t0, u.DEFAULT_UNITS, true, LA), '8:30 PM');
    assert.equal(z.tag(t0, 'America/New_York'), '');         // the test runs in New York time
    assert.equal(z.tag(t0, LA), ' PDT');
    // sun searches run over the place's day whatever the device's zone (run this file under TZ=Asia/Tokyo too)
    const la = { lat: 34.05, lon: -118.24 };
    const sc = f.sunCross(z.noon(t0, LA), la.lat, la.lon, -0.833, LA);
    assert.ok(sc.up < sc.down, 'sunrise before sunset');
    assert.equal(z.day(sc.up, LA), '2026-09-28');
    assert.equal(z.hour(sc.down, LA), 18);                    // sunset 6:4x PM PDT
    assert.equal(z.day(f.sunTimes(z.noon(t0, LA), la.lat, la.lon, LA).set, LA), '2026-09-28');
    console.log('Forecast checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
