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

    // Advection: seconds from each scan to the moment shown; they meet: dt0 + dt1
    // is the whole gap, so an echo moving steadily is in one place
    let k = g.advection(g.bracket(times, 1060));
    assert.deepEqual(k, { dt0: 60, dt1: 60, lead: 0 });
    k = g.advection(g.bracket(times, 1300));           // a 4-minute gap
    assert.deepEqual(k, { dt0: 60, dt1: 180, lead: 0 });
    // The nowcast: a lead along the mean motion, then the newest scan's own age as at its time
    assert.deepEqual(g.advection(g.bracket(times, 1480 + 1800)), { dt0: 0, dt1: 0, lead: 1800 });
    // A scan is drawn the same just before and just after its time (no seam): the interval
    // ending at it moves it by dt1 = 0, the next one by dt0 = 0, both along its own motion
    assert.equal(g.advection(g.bracket(times, 1240)).dt1, 0);
    assert.equal(g.advection(g.bracket(times, 1240 + 1e-6)).dt0 < 1e-5, true);
    // A blob moving v per 2 minutes, as the shader moves it: scan 0 back by (dt0 + age0), scan 1
    // forward by (dt1 - age1). Fresh data: they land on the same spot. Scan 1 repeating scan 0's
    // data (age1 = gap + age0) lands exactly on scan 0's copy, so a repeat never ghosts.
    const v = 3, x = 10, where = (x, k) => x + v * k / g.FLOW_S;
    const blob = t => 100 + v * t / g.FLOW_S;          // true position at time t
    const seen0 = where(x, -(k.dt0 + 0)), seen1 = where(x, k.dt1 - 0);
    near(blob(1300) - x, blob(1240) - seen0);           // scan 0 (data at 1240) drawn where the blob is at 1300
    near(blob(1300) - x, blob(1480) - seen1);
    const age1 = 1480 - 1240;                           // scan 1 repeats scan 0's data
    near(where(x, k.dt1 - age1), seen0);

    // Flow texel bytes -> degrees per 2 minutes, east and north (y bytes point south)
    assert.deepEqual(g.flowDegrees(128, 128), [0, -0]);
    near(g.flowDegrees(160, 96)[0], 0.04);
    near(g.flowDegrees(160, 96)[1], 0.04);

    // Nowcast never fades; the hatch marks it at one strength for every lead, observed frames never
    assert.equal(g.nowcastFade, undefined);
    assert.equal(g.hatchStrength(0), 0);
    for (const lead of [60, 600, 1800, 3600]) assert.equal(g.hatchStrength(lead), g.HATCH);
    assert.ok(g.HATCH > 0 && g.HATCH <= 0.1 && g.HATCH_PX >= 6 && g.HATCH_PX <= 8);

    // Scrubber index <-> time, piecewise linear
    near(g.indexAt(times, 1060), 0.5);
    near(g.indexAt(times, 1300), 2.25);
    near(g.timeAt(times, 2.25), 1300);
    near(g.timeAt(times, 3), 1480);
    near(g.timeAt(times, g.indexAt(times, 1400)), 1400);
    assert.equal(g.indexAt(times, 5000), 3);

    console.log('radar-gl: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
