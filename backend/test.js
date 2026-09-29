// Run: node test.js
const assert = require('assert');
const { shapeRadarFrames, latestReadyRun, snowInches, shapeMemberSeries, shapeEnsembleMean, processSref, pickSettings, takeToken, bucketObservations, zoneByLongitude, validZone } = require('./server');

// Latest ready run rolls back to yesterday before the first cycle is out
const at = (iso) => Date.parse(iso);
assert.deepStrictEqual(latestReadyRun(['00', '06', '12', '18'], 3.6, at('2026-09-24T03:00Z')),
    { runEpoch: at('2026-09-23T18:00Z'), run: '18', date: '2026-09-23' });
assert.strictEqual(latestReadyRun(['03', '09', '15', '21'], 5.33, at('2026-09-24T14:30Z')).run, '09');

// Snow: 10:1 fallback, model ratio when plausible, percent-style ratio scaled
const r2 = v => Math.round(v * 100) / 100;
assert.strictEqual(r2(snowInches(25.4, null)), 10);
assert.strictEqual(r2(snowInches(25.4, 15)), 15);
assert.strictEqual(r2(snowInches(25.4, 1500)), 15);
assert.strictEqual(snowInches(null, 10), 0);

// Hourly member series: totals accumulate, 3h buckets sum hours 1-3, 4-6
const n = 7;
const series = {
    ftimes: Array.from({ length: n }, (_, i) => i * 3600),
    t2ms: Array(n).fill(273.15), u10m: Array(n).fill(3), v10m: Array(n).fill(4),
    tp01: [0, 25.4, 25.4, 25.4, 0, 0, 25.4], snfl: Array(n).fill(null), snra: null
};
const total = shapeMemberSeries(series, 'Total-QPF', 0);
assert.strictEqual(total[n - 1].y, 4);
assert.deepStrictEqual(shapeMemberSeries(series, '3hrly-QPF', 0), [{ x: 3 * 3600e3, y: 3 }, { x: 6 * 3600e3, y: 1 }]);
assert.strictEqual(shapeMemberSeries(series, '3hrly-TMP', 0)[0].y, 32);
assert.strictEqual(shapeMemberSeries(series, '3h-10mWND', 0)[0].y, 9.72);

// Ensemble band: accumulations never go negative, totals sum buckets
const ens = { hours: [3, 6], mean: { qpf: [2.54, 2.54] }, sprd: { qpf: [25.4, 0] } };
const band = shapeEnsembleMean(ens, 'Total-QPF', 0);
assert.strictEqual(band[1].y, 0.2);
assert.strictEqual(band[0].p10, 0);

// SPC members -> Mean across members at each time
const sref = processSref({ A: { data: [[1, '1'], [2, '3']] }, B: { data: [[1, '3'], [2, '5']] }, C: { data: [] } });
assert.deepStrictEqual(sref.Mean, [{ x: 1, y: 2 }, { x: 2, y: 4 }]);
assert.ok(!('C' in sref));

// Settings: unknown keys and wrong types dropped, stations validated
assert.deepStrictEqual(pickSettings({ siteName: 'X', evil: 1, analyticsEnabled: 'yes', defaultStations: ['JFK'] }),
    { siteName: 'X', defaultStations: ['JFK'] });
assert.deepStrictEqual(pickSettings({ defaultStations: ['<b>'] }), {});
assert.deepStrictEqual(pickSettings({ defaultStations: [] }), {});

// Token bucket: burst then refuse
const buckets = new Map();
for (let i = 0; i < 3; i++) assert.ok(takeToken('ip', buckets, 3, 1));
assert.ok(!takeToken('ip', buckets, 3, 1));

// Observed history: nearest-:51 report with a temperature wins, km/h -> mph,
// precip null vs 0 kept apart, empty hours present, oldest first
const ob = (iso, c, extra = {}) => ({ properties: { timestamp: iso, temperature: { value: c },
    dewpoint: { value: 0 }, windSpeed: { value: 16.09344 }, windGust: { value: null },
    windDirection: { value: 270 }, precipitationLastHour: { value: null }, textDescription: iso, ...extra } });
const hist = bucketObservations([
    ob('2026-09-28T19:51:00Z', 20, { precipitationLastHour: { value: 25.4 } }),
    ob('2026-09-28T19:20:00Z', 10),
    ob('2026-09-28T19:55:00Z', null),
    ob('2026-09-28T18:10:00Z', 0),
    ob('2026-09-28T18:40:00Z', 5, { precipitationLastHour: { value: 0 } }),
    ob('2026-09-28T17:30:00Z', null, { textDescription: 'no temp' }),
    ob('2026-09-27T12:00:00Z', 30)
], at('2026-09-28T20:05Z'));
assert.strictEqual(hist.length, 25);
assert.ok(hist.every((h, i) => i === 0 || h.t - hist[i - 1].t === 3600e3));
assert.strictEqual(hist[0].t, at('2026-09-27T20:00Z'));
const hr = iso => hist.find(h => h.t === at(iso));
assert.deepStrictEqual(hr('2026-09-28T19:00Z'), { t: at('2026-09-28T19:00Z'), tmp: 68, dpt: 32, wind: 10, dir: 270,
    gust: null, precip: 1, text: '2026-09-28T19:51:00Z' });
assert.strictEqual(hr('2026-09-28T18:00Z').tmp, 41);
assert.strictEqual(hr('2026-09-28T18:00Z').precip, 0);
assert.strictEqual(hr('2026-09-28T17:00Z').tmp, null);
assert.strictEqual(hr('2026-09-28T17:00Z').text, 'no temp');
assert.deepStrictEqual(hr('2026-09-28T20:00Z'), { t: at('2026-09-28T20:00Z'), tmp: null, dpt: null, wind: null,
    dir: null, gust: null, precip: null, text: null });

// A 5-minute report (no rawMessage) wins temperature; the hour's METAR supplies precip;
// at equal distance from :51 the METAR wins temperature too
const five = bucketObservations([
    ob('2026-09-28T19:50:00Z', 18, { rawMessage: '', textDescription: 'five' }),
    ob('2026-09-28T19:05:00Z', 17, { rawMessage: 'KEWR 281905Z', precipitationLastHour: { value: 2.54 } }),
    ob('2026-09-28T18:50:00Z', 10, { rawMessage: '' }),
    ob('2026-09-28T18:52:00Z', 12, { rawMessage: 'KEWR 281852Z' })
], at('2026-09-28T20:05Z'));
const f19 = five.find(h => h.t === at('2026-09-28T19:00Z'));
assert.strictEqual(f19.text, 'five');
assert.strictEqual(f19.precip, 0.1);
assert.strictEqual(five.find(h => h.t === at('2026-09-28T18:00Z')).tmp, 53.6);

// Place zones: NWS names pass, anything else is refused; longitude fallback bands
assert.ok(validZone('America/Los_Angeles') && validZone('America/Indiana/Indianapolis'));
assert.ok(!validZone('Nowhere/Land') && !validZone('UTC') && !validZone('../x') && !validZone(null));
assert.deepStrictEqual([-74, -90, -105, -118].map(zoneByLongitude),
    ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']);
// Photon features become results named like the Nominatim ones
{
    const { photonResult, searchKey } = require('./server');
    const feat = (props, lon = -74, lat = 40.7) => ({ geometry: { coordinates: [lon, lat] }, properties: { countrycode: 'US', ...props } });
    assert.deepStrictEqual(photonResult(feat({ type: 'city', osm_key: 'place', osm_value: 'town', name: 'Hoboken',
        county: 'Hudson', state: 'New Jersey', postcode: '07030' }, -74.03, 40.74)),
        { name: 'Hoboken, New Jersey', detail: 'Hoboken, Hudson, New Jersey, 07030', address: false, lat: 40.74, lon: -74.03 });
    const house = photonResult(feat({ type: 'house', housenumber: '123', street: 'Washington Street', city: 'Hoboken',
        county: 'Hudson', state: 'New Jersey', postcode: '07030' }));
    assert.strictEqual(house.name, '123 Washington Street, Hoboken');
    assert.strictEqual(house.address, true);
    assert.strictEqual(house.detail, '123 Washington Street, Hoboken, Hudson, New Jersey, 07030');
    const poi = photonResult(feat({ type: 'house', housenumber: '1600', name: 'White House',
        street: 'Pennsylvania Avenue Northwest', city: 'Washington', state: 'District of Columbia' }));
    assert.strictEqual(poi.name, '1600 Pennsylvania Avenue Northwest, Washington');
    assert.strictEqual(poi.detail, 'White House, 1600 Pennsylvania Avenue Northwest, Washington, District of Columbia');
    const road = photonResult(feat({ type: 'street', osm_key: 'highway', name: 'Main Street', city: 'Hobart', state: 'Indiana' }));
    assert.deepStrictEqual([road.name, road.address], ['Main Street, Hobart', true]);
    assert.strictEqual(photonResult(feat({ type: 'other', osm_value: 'postcode', name: '10001', district: 'Manhattan',
        city: 'New York', state: 'New York' })).name, 'New York, New York');
    assert.strictEqual(photonResult(feat({ type: 'district', name: 'Brooklyn', state: 'New York' })).name, 'Brooklyn, New York');
    assert.strictEqual(photonResult(feat({ type: 'state', name: 'New Jersey', state: 'New Jersey' })).name, 'New Jersey');

    assert.strictEqual(searchKey('  Hoboken \t NJ  '), 'hoboken nj');
    assert.strictEqual(searchKey(undefined), '');
    assert.strictEqual(searchKey('x'.repeat(150)).length, 100);
}

// Radar frames: MRMS scans as past frames, never a nowcast, satellite passed through
{
    const libre = { host: 'h', radar: { past: [{ time: 600, path: '/v2/radar/600' }], nowcast: [{ time: 1200, path: '/v2/radar/1200' }] },
        satellite: { infrared: [{ time: 0, path: '/v2/satellite/0' }] } };
    const live = shapeRadarFrames(libre, [3000, 3120], 3200);
    assert.deepStrictEqual(live.radar, { source: 'mrms', nowcast: [],
        past: [{ time: 3000, path: '/mrms/3000' }, { time: 3120, path: '/mrms/3120' }] });
    assert.deepStrictEqual(live.satellite, libre.satellite);
    assert.strictEqual(libre.radar.nowcast.length, 1, 'the cached LibreWXR index is not mutated');
    // Ring empty, or its newest scan 20+ minutes old: LibreWXR's past frames, still no nowcast
    for (const mrms of [[], [3000]]) {
        const fb = shapeRadarFrames(libre, mrms, 3000 + 20 * 60);
        assert.deepStrictEqual(fb.radar, { source: 'librewxr', past: libre.radar.past, nowcast: [] });
    }
    // LibreWXR down: MRMS alone, no satellite
    const solo = shapeRadarFrames(null, [3000], 3100);
    assert.strictEqual(solo.radar.source, 'mrms');
    assert.strictEqual(solo.satellite, undefined);
}

console.log('backend: all checks passed');
