// Run: node frontend/radar-gl.test.cjs
const assert = require('node:assert/strict');

(async () => {
    const g = await import('./js/radar-gl.js');
    const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

    // Mercator y <-> latitude (the shader's lat = atan(sinh(pi (1 - 2y))))
    for (const lat of [-60, -20.005, 0, 20.005, 40.755, 54.995, 70]) near(g.latAt(g.mercY(lat)), lat, 1e-9);
    near(g.mercY(0), 0.5);
    near(g.mercX(-180), 0);
    near(g.mercX(-73.985), (180 - 73.985) / 360);

    // Crop: view + margin (at least 1 degree), clamped to the MRMS grid
    const nyc = { west: -74.5, south: 40.3, east: -73.5, north: 41.1, zoom: 9 };
    let c = g.cropFor(nyc);
    assert.deepEqual([c.w, c.s, c.e, c.n, c.step], [-75.5, 39.3, -72.5, 42.1, 1]);
    // Zoomed out over CONUS: clamped to the grid, texels no finer than CSS pixels, sides within 2048
    c = g.cropFor({ west: -135, south: 15, east: -55, north: 58, zoom: 3.5 }, { frames: 60, budget: 1e12 });
    assert.deepEqual([c.w, c.s, c.e, c.n], [-130, 20, -60, 55]);
    assert.ok(c.step >= Math.ceil(7000 / 2048) && 7000 / c.step <= 2048);
    // The byte budget: 60 frames x texels within it
    c = g.cropFor({ west: -100, south: 30, east: -90, north: 38, zoom: 6 }, { frames: 60, budget: 24e6 });
    const texels = ((c.e - c.w) / 0.01 / c.step) * ((c.n - c.s) / 0.01 / c.step);
    assert.ok(60 * texels <= 24e6 * 1.0001, `${c.step} ${texels}`);
    // Phones: coarser texels
    assert.ok(g.cropFor({ ...nyc, zoom: 5 }, { texelPx: 1.5 }).step > g.cropFor({ ...nyc, zoom: 5 }).step);
    assert.equal(g.cropFor({ west: 0, south: 0, east: 10, north: 10, zoom: 6 }), null, 'off the grid');

    // Re-crop when the view leaves the crop or a finer step is wanted, not for small pans
    const cur = { bounds: [-75.52, 39.28, -72.48, 42.16], step: 2 };
    assert.equal(g.needsCrop(cur, { ...nyc }, { step: 2 }), false);
    assert.equal(g.needsCrop(cur, { ...nyc, west: -76 }, { step: 2 }), true);
    assert.equal(g.needsCrop(cur, nyc, { step: 1 }), true);
    assert.equal(g.needsCrop(null, nyc, { step: 1 }), true);

    // Time bracket: fraction between scans, gaps included; past the newest a lead (capped at an hour)
    const times = [1000, 1120, 1240, 1480];
    assert.deepEqual(g.bracket(times, 1060), { t0: 1000, t1: 1120, a: 0.5, lead: 0 });
    assert.deepEqual(g.bracket(times, 1300), { t0: 1240, t1: 1480, a: 0.25, lead: 0 });
    assert.deepEqual(g.bracket(times, 900), { t0: 1000, t1: 1000, a: 0, lead: 0 });
    assert.deepEqual(g.bracket(times, 1480 + 600), { t0: 1480, t1: 1480, a: 0, lead: 600 });
    assert.equal(g.bracket(times, 1480 + 9999).lead, 3600);
    assert.equal(g.bracket([], 5), null);

    // At a scan's own time: that scan alone (the next interval, not the end of the last)
    assert.deepEqual(g.bracket(times, 1120), { t0: 1120, t1: 1240, a: 0, lead: 0 });

    // Observed: each frame held crisp, then an eased dBZ blend over the last 45%, no motion
    // crisp steps: each frame holds until the next
    for (const a of [0, 0.3, 0.55, 0.99]) assert.equal(g.blendWeight(a), 0);
    assert.equal(g.blendWeight(1), 1);
    const six = [0, 360, 720, 1080];
    assert.deepEqual(g.frameMix(six, 180), { t0: 0, t1: 360, w: 0, k0: 0, k1: 0, step: 0, gap: 360 });
    let m = g.frameMix(six, 0.9 * 360);                       // late in a step: still the first frame
    assert.equal(m.t1, 360); assert.equal(m.w, 0); assert.equal(m.k0 + m.k1, 0);
    assert.equal(g.shownTime(six, 0.9 * 360), 0);
    // Nowcast: discrete 6-minute steps of the newest frame moved k flow periods (2 min) along v
    m = g.frameMix(six, 1080 + 100);                          // first step, held: the newest frame itself
    assert.deepEqual(m, { t0: 1080, t1: 1080, w: 0, k0: 0, k1: 3, step: 0, gap: 360 });
    m = g.frameMix(six, 1080 + 1800 + 60);                    // +30 min, held
    assert.deepEqual([m.k0, m.k1, m.w, m.step], [15, 18, 0, 5]);
    m = g.frameMix(six, 1080 + 1800 + 359);                   // the end of the +30 step: still +30
    assert.deepEqual([m.k0, m.w, m.step], [15, 0, 5]);
    m = g.frameMix(six, 1080 + 9999);                         // capped at +60, no blend past it
    assert.deepEqual([m.k0, m.w, m.step], [30, 0, 10]);
    // Badge: minutes after the newest frame, counting up in 6s, never negative
    assert.equal(g.forecastMinutes(0), 0);
    assert.equal(g.forecastMinutes(g.frameMix(six, 1080 + 370).step), 6);
    assert.equal(g.forecastMinutes(g.frameMix(six, 1080 + 3600).step), 60);
    let prev = 0;
    for (let T = 1080; T <= 1080 + 3600; T += 7) {
        const min = g.forecastMinutes(g.frameMix(six, T).step);
        assert.ok(min >= prev && min <= 60 && min % 6 === 0);
        prev = min;
    }

    // Flow texel bytes -> degrees per 2 minutes, east and north (y bytes point south)
    assert.deepEqual(g.flowDegrees(128, 128), [0, -0]);
    near(g.flowDegrees(160, 96)[0], 0.04);
    near(g.flowDegrees(160, 96)[1], 0.04);

    // Nowcast never fades; the hatch marks it at one strength for every step, observed frames never
    assert.equal(g.nowcastFade, undefined);
    assert.equal(g.hatchStrength(0), 0);
    for (const step of [1, 3, 5, 10]) assert.equal(g.hatchStrength(step), g.HATCH);
    assert.ok(g.HATCH > 0 && g.HATCH <= 0.1 && g.HATCH_PX >= 6 && g.HATCH_PX <= 8);

    // Scrubber index <-> time, piecewise linear
    near(g.indexAt(times, 1060), 0.5);
    near(g.indexAt(times, 1300), 2.25);
    near(g.timeAt(times, 2.25), 1300);
    near(g.timeAt(times, 3), 1480);
    near(g.timeAt(times, g.indexAt(times, 1400)), 1400);
    assert.equal(g.indexAt(times, 5000), 3);

    // the label names the picture on screen: a held scan, the scan blended into, or the nowcast step
    {
        const ts = [0, 360, 720];
        assert.equal(g.shownTime(ts, 10), 0);
        assert.equal(g.shownTime(ts, 355), 0);                  // crisp steps: the scan until the next one
        assert.equal(g.shownTime(ts, 721), 720);                // just past the newest scan: still the newest
        assert.equal(g.shownTime(ts, 720 + 3600), 720 + 3600);  // the last forecast step
        for (let T = 721; T <= 720 + 3600; T += 30) {
            const m = g.frameMix(ts, T);
            assert.equal(g.shownTime(ts, T), 720 + m.step * g.STEP_S);
        }
    }
    console.log('radar-gl: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
