// Run: node test.js
const assert = require('assert');
const { latestReadyRun, snowInches, shapeMemberSeries, shapeEnsembleMean, processSref, pickSettings, takeToken } = require('./server');

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

console.log('backend: all checks passed');
