// Run: node frontend/charts.test.cjs
const assert = require('node:assert/strict');

let now = Date.parse('2026-09-26T12:00:00Z');
Date.now = () => now;
const frames = [];
global.window = {
    innerWidth: 1200,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: callback => frames.push(callback),
};
global.getComputedStyle = () => ({ fontFamily: 'sans-serif', getPropertyValue: () => '#888' });
const elements = new Map();
global.document = { getElementById: id => elements.get(id) };

const Chart = require('./vendor/chart.umd.min.js');
class AnimatedPlatform extends Chart.BasicPlatform {
    updateConfig() {}
}
global.Chart = class extends Chart {
    constructor(canvas, config) {
        config.platform = AnimatedPlatform;
        // The readout uses numeric timestamps; this avoids needing a date adapter.
        config.options.scales.x.type = 'linear';
        super(canvas, config);
    }
};

(async () => {
    const { createChart, toggleCore, destroyAllCharts } = await import('./js/charts.js');
    for (const mode of ['spaghetti', 'bands', 'both']) {
        window.innerWidth = mode === 'bands' ? 390 : 1200;
        window.matchMedia = () => ({ matches: mode === 'bands' });
        const readout = { innerHTML: '', classList: { toggle() {} } };
        const canvas = { width: 600, height: 300, getContext: () => ctx };
        const ctx = new Proxy({ canvas, length: undefined, measureText: text => ({ width: String(text).length * 6 }) }, {
            get: (target, key) => key in target ? target[key] : () => {},
        });
        elements.set('chart-3hrly-TMP', canvas);
        elements.set('readout-3hrly-TMP', readout);
        const points = y => [-3600000, 3600000, 7200000].map(offset => ({ x: now + offset, y }));
        const chart = createChart('3hrly-TMP', {
            ARWC: points(40), MBCN: points(60), Mean: points(50),
        }, [], mode);
        assert.ok(readout.innerHTML, `${mode}: initial readout is populated`);
        assert.doesNotMatch(readout.innerHTML, /NaN|undefined/, `${mode}: initial readout is finite`);
        for (let i = 0; frames.length && i < 10; i++) {
            now += 100;
            frames.shift()();
        }
        assert.match(readout.innerHTML, /50°/, `${mode}: animation updates the mean without interaction`);
        assert.match(readout.innerHTML, /40°–60°/, `${mode}: range matches the data`);
        canvas.ontouchend();
        assert.match(readout.innerHTML, /50°/, `${mode}: touch release restores the readout`);
        toggleCore('3hrly-TMP', 'Mean');
        chart.draw();
        assert.doesNotMatch(readout.innerHTML, /ro-label">Mean</, `${mode}: hidden mean leaves the readout`);
        destroyAllCharts();
        while (frames.length) frames.shift()();
    }
    console.log('Chart readout checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
