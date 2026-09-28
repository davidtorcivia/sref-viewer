/**
 * Radar Map Page
 * MapLibre GL basemap (OpenFreeMap vector tiles) with animated radar
 * frames from LibreWXR: ~2 hours of history plus a 60-minute nowcast.
 *
 * Frame index and tiles come from our backend (/api/radar/frames and
 * /api/radar/tile), which caches tiles and pre-warms the NYC viewport.
 *
 * Playback is deliberately simple: one discrete frame at a time, no
 * crossfading or interpolation (tried both - blending 10-minute radar
 * steps reads worse than honest frames).
 *
 * Loading: LibreWXR renders tiles on demand and a cold tile can take
 * 10-90s, and MapLibre caps parallel image requests at 16. Adding all 18
 * frames at once starved the visible frame behind invisible ones. So the
 * current frame is added first and the rest trickle in a couple at a
 * time (nearest first); playback only steps over frames whose tiles have
 * actually arrived.
 */

import { store as savedStore } from './config.js?v=__V__';

// Embedded in the overview page (radar.html?embed=1 in an iframe): start
// from the defaults and leave the user's saved radar settings alone
const EMBED = new URLSearchParams(location.search).has('embed');
let setGestures = () => {};   // cooperative gestures on in the mini embed (page scroll wins), off full screen
const store = EMBED ? { get: () => null, set() {} } : savedStore;
if (EMBED) {
    document.body.classList.add('embed', 'embed-mini');
    // The overview drives the embed: mini/full view, and pausing while scrolled away
    window.addEventListener('message', e => {
        if (e.origin !== location.origin || e.data?.type !== 'wx-radar') return;
        if ('view' in e.data) {
            document.body.classList.toggle('embed-mini', e.data.view === 'mini');
            setGestures(e.data.view === 'mini');
            if (map) map.resize();
        }
        if (OVERLAYS.includes(e.data.layer)) { layerFromParent = true; if (overlayReady) setOverlay(e.data.layer); else overlay = e.data.layer; }
        if (e.data.play === false) pause();
        else if (e.data.play === true && frames.length) play();
    });
    // Focus inside the iframe keeps Escape from the overview: pass it up
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape') parent.postMessage({ type: 'wx-radar-close' }, location.origin);
    });
}
import { applySiteSettings } from './site.js?v=__V__';

// Tiles come through our backend (/api/radar/tile), which caches them and
// pre-renders the NYC viewport for each new frame; style options live there.
const TILE_SIZE = 256;    // Backend requests 512px tiles; declaring 256 renders them at 2x density
const RADAR_OPACITY = 0.75;
const SAT_OPACITY = 0.8;
// Radar colors changed with the backend TILE_STYLE: a new value keeps browsers
// from mixing hour-cached tiles of the old scheme into the loop
const TILE_STYLE_V = 'twc';
// Field tiles and grids are cached immutable per URL: bump with any extractor palette/format change
const FIELD_STYLE_V = '3';
const SAT_MAXZOOM = 7;              // GMGSI is ~4-8km; MapLibre overzooms past this instead of fetching
const FRAME_MS = 500;               // ms per frame at 1x
const LAST_FRAME_HOLD_MS = 1500;    // Extra pause on the final nowcast frame
const REFRESH_MS = 2 * 60 * 1000;   // Re-fetch frame index
const LOAD_PARALLEL = 4;            // Frames loading tiles at once (the backend pre-warms the NYC views)
const LOAD_STALL_MS = 10000;        // Give up waiting on a cold frame, move on

// Radar is only ever useful slower, never faster
const SPEEDS = [
    { mult: 1, label: '1×' },
    { mult: 0.5, label: '½×' },
    { mult: 0.25, label: '¼×' },
];

const NYC = { center: [-73.95, 40.75], zoom: 8.2 };
const POSITION_KEY = 'sref-radar-position';
const SPEED_KEY = 'sref-radar-speed';
const OVERLAY_KEY = 'sref-radar-overlay';
const RANGE_KEY = 'sref-radar-range';
const LEGEND_KEY = 'sref-radar-legend';
// Overlay -> extractor field name, and how opaque each field draws
const FIELD_OVERLAYS = { temp: 'tmp', dewpoint: 'dpt', wind: 'wind', gust: 'gust', clouds: 'cloud', precip: 'qpf', snow: 'snowtot' };
const FIELD_OPACITY = { tmp: 0.6, dpt: 0.6, wind: 0.75, gust: 0.75, cloud: 0.9, qpf: 0.8, snowtot: 0.85 };
// Run totals have no observed "Now": that range shows them from the 36h run
const NO_NOW = new Set(['precip', 'snow']);
// Radar/satellite past 'now' come from RRFS simulated reflectivity and IR
const MODEL_OVERLAYS = { radar: 'refc', satellite: 'sat', both: 'both' };
const OVERLAYS = ['radar', 'satellite', 'both', ...Object.keys(FIELD_OVERLAYS)];
// Time range: observed (radar with its 1h nowcast; fields from RTMA
// analyses) for the last ~2h, then RRFS hourly to 36h, then hourly to 84h
const RANGES = [
    { mode: 'now', label: 'Now', title: 'Observed, last 2 hours' },
    { mode: 'hourly', label: '36h', title: 'RRFS forecast, hourly to 36 hours' },
    { mode: 'extended', label: '3½d', title: 'RRFS forecast, hourly to 3½ days' },
];
const fieldFor = (which, mode) => FIELD_OVERLAYS[which] || (mode === 'now' ? null : MODEL_OVERLAYS[which]);
const rangeMode = () => RANGES[rangeIdx].mode === 'now' && NO_NOW.has(overlay) ? 'hourly' : RANGES[rangeIdx].mode;

function savedPosition() {
    try {
        const saved = JSON.parse(store.get(POSITION_KEY));
        if (saved && Array.isArray(saved.center) && typeof saved.zoom === 'number') {
            return saved;
        }
    } catch { /* corrupt/missing - use default */ }
    return NYC;
}

// radar.html sets data-theme before first paint (saved choice, else the system's)
const isLight = document.documentElement.dataset.theme === 'light';
const BASEMAP_STYLE = isLight
    ? 'https://tiles.openfreemap.org/styles/positron'
    : 'https://tiles.openfreemap.org/styles/dark';

const els = {
    playBtn: document.getElementById('playBtn'),
    speedBtn: document.getElementById('speedBtn'),
    scrubber: document.getElementById('scrubber'),
    frameTime: document.getElementById('frameTime'),
    frameBadge: document.getElementById('frameBadge'),
    updated: document.getElementById('radarUpdated'),
    fieldUnit: document.getElementById('fieldUnit'),
    fieldBar: document.getElementById('fieldBar'),
    fieldAxis: document.getElementById('fieldAxis'),
    fieldCaption: document.getElementById('fieldCaption'),
    legend: document.getElementById('legend'),
    overlay: document.getElementById('overlaySelect'),
    overlayName: document.getElementById('overlayName'),
    themeBtn: document.getElementById('themeBtn'),
    rangeBtn: document.getElementById('rangeBtn'),
};

let map = null;
let overlayReady = false, layerFromParent = false;   // setOverlay needs the map and controls; an embed's early message just picks the start
let overlay = OVERLAYS.includes(store.get(OVERLAY_KEY)) ? store.get(OVERLAY_KEY) : 'radar';
let rangeIdx = Math.max(0, RANGES.findIndex(r => r.mode === store.get(RANGE_KEY)));
let frames = [];          // [{ time, path, nowcast, sat, field }]
let mapReady = false;
let backdropId = null;    // latest satellite frame under the radar in 'both'
let currentFrame = 0;
let playing = false;
let playTimer = null;
let loadedLayerIds = new Set();   // layers added to the map
let readyIds = new Set();         // layers whose tiles have arrived
let pending = [];                 // frames waiting for a load slot
let staleTwins = new Map();       // replacement layer id -> superseded layer id kept until ready
let inFlight = 0;
const loadWaiters = new Map();    // layer id -> releases its load slot
let speedIdx = (() => {
    const saved = store.get(SPEED_KEY);
    const idx = SPEEDS.findIndex(s => String(s.mult) === saved);
    return idx === -1 ? 0 : idx;
})();

function tileUrl(frame) {
    if (frame.field) return `/api/radar/field/${frame.field}/{z}/{x}/{y}.png?v=${FIELD_STYLE_V}`;
    if (frame.sat) return `/api/radar/sat/${frame.time}/{z}/{x}/{y}.png`;
    const url = `/api/radar/tile/${frame.time}/{z}/{x}/{y}.png?v=${TILE_STYLE_V}`;
    // A nowcast frame shares its time with the observed frame it later
    // becomes; a distinct URL keeps caches from serving the forecast as
    // the observation.
    return frame.nowcast ? `${url}&fc=${frame.basis}` : url;
}

// Nowcast frames are regenerated from each new observation, so their
// identity includes the observation they were derived from.
function layerId(frame) {
    if (frame.sat) return `sat-${frame.time}`;
    if (frame.field) return `${frame.name}-${frame.time}-c${frame.basis}`;
    return frame.nowcast ? `radar-${frame.time}-fc${frame.basis}` : `radar-${frame.time}`;
}

// Animated frames for the chosen overlay, plus the static satellite
// backdrop shown under the radar in 'both'
async function fetchFrames(which) {
    const field = fieldFor(which, rangeMode());
    if (field) return { ...await fetchFieldFrames(field), backdrop: null };
    const res = await fetch('/api/radar/frames');
    if (!res.ok) throw new Error(`Frame index HTTP ${res.status}`);
    const data = await res.json();
    const sat = (data.satellite?.infrared || []).map(f => ({ ...f, nowcast: false, sat: true }));
    if (which === 'satellite') return { frames: sat, backdrop: null };
    const past = (data.radar?.past || []).map(f => ({ ...f, nowcast: false }));
    const basis = past.length ? past[past.length - 1].time : 0;
    const nowcast = (data.radar?.nowcast || []).map(f => ({ ...f, nowcast: true, basis }));
    return { frames: past.concat(nowcast), backdrop: which === 'both' ? sat[sat.length - 1] || null : null };
}

// Extractor-rendered field frames: RRFS forecast hours, or RTMA analyses (observed) for 'now'
async function fetchFieldFrames(name, mode = rangeMode()) {
    const res = await fetch(`/api/radar/field?mode=${mode}&field=${name}`);
    if (!res.ok) throw new Error(`Field index HTTP ${res.status}`);
    const d = await res.json();
    const now = Date.now() / 1000;
    const fmt = d.grid.fields[name];
    return { legend: d.fields[name], frames: d.frames.map(f => ({
        time: f.time, basis: f.time - f.fh * 3600, fh: f.fh, src: f.src, cycle: f.cycle,
        bounds: d.bounds, tile: d.tile, maxzoom: d.maxzoom, grid: fmt ? { ...d.grid, fmt, stops: d.fields[name]?.stops } : null,
        name, field: `${name}/${f.src}/${f.date}/${f.cycle}/${f.fh}`, nowcast: f.time > now,
    })) };
}

// Legend bar and ticks from the same stops the extractor paints with
function renderFieldLegend({ stops, unit, label, ticks, sqrt }) {
    // Totals band on sqrt(value) in the extractor; the bar follows
    const axis = v => sqrt ? Math.sqrt(Math.max(v, 0)) : v;
    const lo = axis(stops[0][0]), hi = axis(stops[stops.length - 1][0]);
    const pct = v => `${((axis(v) - lo) / (hi - lo) * 100).toFixed(2)}%`;
    els.fieldBar.style.background = 'linear-gradient(to right, ' + stops.map(([v, [r, g, b, a]]) =>
        `rgba(${r},${g},${b},${(a / 255).toFixed(2)}) ${pct(v)}`).join(', ') + ')';
    // Match the map's light-mode cloud dimming
    els.fieldBar.style.filter = unit === '%' && isLight ? 'brightness(0.6)' : '';
    els.fieldAxis.replaceChildren(...ticks.map(t => {
        const span = document.createElement('span');
        span.style.left = pct(t);
        span.textContent = t;
        return span;
    }));
    els.fieldUnit.textContent = unit;
    els.fieldCaption.textContent = rangeMode() === 'now' ? `${label}, observed (RTMA 2.5 km analysis)` : `${label}, RRFS 3 km model`;
}

function sourceFor(frame) {
    if (frame.field) {
        return { type: 'raster', tiles: [tileUrl(frame)], tileSize: frame.tile, maxzoom: frame.maxzoom,
            bounds: frame.bounds, attribution: frame.src === 'rtma' ? 'Analysis &copy; NOAA RTMA' : 'Model &copy; NOAA RRFS' };
    }
    return frame.sat
        ? { type: 'raster', tiles: [tileUrl(frame)], tileSize: TILE_SIZE, maxzoom: SAT_MAXZOOM,
            attribution: 'Satellite &copy; NOAA GMGSI via <a href="https://librewxr.net/">LibreWXR</a>' }
        : { type: 'raster', tiles: [tileUrl(frame)], tileSize: TILE_SIZE,
            attribution: 'Radar &copy; <a href="https://librewxr.net/">LibreWXR</a> (CC-BY-4.0)' };
}

function opacityFor(id) {
    const kind = id.split('-')[0];
    return FIELD_OPACITY[kind] ?? (kind === 'sat' ? SAT_OPACITY : RADAR_OPACITY);
}

function labelLayerId() {
    const labelLayer = map.getStyle().layers.find(l =>
        l.type === 'symbol' && (l.id.includes('label') || l.id.includes('place')));
    return labelLayer ? labelLayer.id : undefined;
}

function addFrameLayer(frame) {
    const id = layerId(frame);
    // Insert below map numbers, warning polygons and labels so they all
    // stay visible on top of the radar.
    const beforeId = ['numbers', 'alerts-fill'].find(id => map.getLayer(id)) ?? labelLayerId();
    map.addSource(id, sourceFor(frame));
    map.addLayer({
        id,
        type: 'raster',
        source: id,
        paint: {
            'raster-opacity': frames[currentFrame] === frame ? opacityFor(id) : 0,
            'raster-opacity-transition': { duration: 0 },
            'raster-fade-duration': 0,
            // White clouds vanish on the light basemap: dim them to gray
            ...((frame.name === 'cloud' || frame.name === 'sat') && isLight ? { 'raster-brightness-max': 0.6 } : {})
        }
    }, beforeId);
    loadedLayerIds.add(id);
}

// Resolves once the source's tiles are in (or after LOAD_STALL_MS so one
// cold frame can't block the queue). Readiness itself is tracked by the
// global 'sourcedata' listener in init(), which also catches late arrivals.
function waitForSource(id) {
    return new Promise(resolve => {
        const timer = setTimeout(done, LOAD_STALL_MS);
        function onData(e) {
            if (e.sourceId === id && e.sourceDataType !== 'metadata' && map.isSourceLoaded(id)) done();
        }
        function done() { clearTimeout(timer); map.off('sourcedata', onData); loadWaiters.delete(id); resolve(); }
        map.on('sourcedata', onData);
        loadWaiters.set(id, done);
    });
}

function pumpQueue() {
    while (pending.length && inFlight < LOAD_PARALLEL) {
        const frame = pending.shift();
        const id = layerId(frame);
        if (loadedLayerIds.has(id)) continue;
        addFrameLayer(frame);
        inFlight++;
        waitForSource(id).then(() => { inFlight--; pumpQueue(); });
    }
}

/**
 * Sync map layers to the current frame list: drop frames that fell out
 * of the window, add the current frame now, queue the rest nearest-first.
 */
function syncLayers() {
    const wanted = new Set(frames.map(layerId));

    for (const k of staleTwins.keys()) if (!wanted.has(k)) staleTwins.delete(k);
    const byTime = new Map(frames.map(f => [String(f.time), layerId(f)]));
    for (const id of [...loadedLayerIds]) {
        if (wanted.has(id)) continue;
        // A regenerated nowcast frame keeps its old layer on screen until
        // the replacement has tiles, otherwise the map blanks every 10 min.
        const twin = byTime.get(id.split('-')[1]);
        if (twin && !isReady(frames.findIndex(f => layerId(f) === twin))) {
            staleTwins.set(twin, id);
            continue;
        }
        removeLayer(id);
        if (twin) staleTwins.delete(twin);
    }

    const current = frames[currentFrame];
    if (current && !loadedLayerIds.has(layerId(current))) addFrameLayer(current);

    pending = frames
        .map((frame, i) => ({ frame, dist: Math.abs(i - currentFrame) }))
        .filter(({ frame }) => !loadedLayerIds.has(layerId(frame)))
        .sort((a, b) => a.dist - b.dist)
        .map(({ frame }) => frame);
    pumpQueue();
}

function removeLayer(id) {
    loadWaiters.get(id)?.();
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    loadedLayerIds.delete(id);
    readyIds.delete(id);
}

// Tile errors and cache hits settle a source without a 'sourcedata'
// event, so the event listener is only the fast path; poll too.
function isReady(index) {
    if (index < 0) return false;
    const id = layerId(frames[index]);
    if (readyIds.has(id)) return true;
    if (loadedLayerIds.has(id) && map.getSource(id) && map.isSourceLoaded(id)) {
        readyIds.add(id);
        return true;
    }
    return false;
}

function showFrame(index) {
    if (!frames.length) return;
    currentFrame = Math.max(0, Math.min(Math.round(index), frames.length - 1));
    // Scrubbing to a frame still in the queue: load it now
    const curId = layerId(frames[currentFrame]);
    if (!loadedLayerIds.has(curId)) addFrameLayer(frames[currentFrame]);
    const stale = staleTwins.get(curId);
    if (stale && isReady(currentFrame)) { removeLayer(stale); staleTwins.delete(curId); }
    for (const id of loadedLayerIds) {
        const show = (stale && !readyIds.has(curId)) ? id === stale : id === curId;
        map.setPaintProperty(id, 'raster-opacity', show ? opacityFor(id) : 0);
    }
    els.scrubber.value = String(currentFrame);
    updateFrameLabel();
    syncGrid(frames[currentFrame]);
}

function updateFrameLabel() {
    const frame = frames[currentFrame];
    if (!frame) return;
    const d = new Date(frame.time * 1000);
    els.frameTime.textContent = d.toLocaleTimeString('en-US', {
        // Model frames span two days
        weekday: frame.field ? 'short' : undefined,
        hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
    }) + ' ET';

    if (frame.field) {
        // The RRFS cycle is in the header pill
        els.frameBadge.textContent = frame.src === 'rtma' ? 'OBSERVED' : `+${frame.fh}h`;
        els.frameBadge.classList.toggle('nowcast', frame.nowcast);
    } else if (frame.nowcast) {
        const minsAhead = Math.round((frame.time * 1000 - Date.now()) / 60000);
        els.frameBadge.textContent = `FORECAST +${Math.max(minsAhead, 0)} min`;
        els.frameBadge.classList.add('nowcast');
    } else {
        els.frameBadge.textContent = '';
        els.frameBadge.classList.remove('nowcast');
    }
}

function frameInterval() {
    return FRAME_MS / SPEEDS[speedIdx].mult;
}

function play() {
    if (playing || frames.length === 0) return;
    playing = true;
    els.playBtn.classList.add('playing');
    els.playBtn.setAttribute('aria-label', 'Pause animation');
    const step = () => {
        if (!playing) return;
        // Advance to the next frame whose tiles have arrived; if none
        // have yet, hold the current one rather than flash blanks.
        let next = currentFrame;
        for (let k = 1; k <= frames.length; k++) {
            const i = (currentFrame + k) % frames.length;
            if (isReady(i)) { next = i; break; }
        }
        showFrame(next);
        const hold = next === frames.length - 1
            ? frameInterval() + LAST_FRAME_HOLD_MS
            : frameInterval();
        playTimer = setTimeout(step, hold);
    };
    playTimer = setTimeout(step, frameInterval());
}

function pause() {
    playing = false;
    clearTimeout(playTimer);
    els.playBtn.classList.remove('playing');
    els.playBtn.setAttribute('aria-label', 'Play animation');
}

// ============ Weather Alerts ============
const ALERTS_RADIUS_KM = 700;
const ALERTS_REFRESH_MS = 2 * 60 * 1000;
let lastAlertsCenter = null;

function alertColor(props) {
    const t = (props.title || '').toLowerCase();
    if (t.includes('tornado')) return '#ff2d55';
    if (t.includes('severe thunderstorm')) return '#ff9f0a';
    if (t.includes('winter') || t.includes('snow') || t.includes('blizzard') || t.includes('ice storm')) return '#bf5af2';
    if (t.includes('flood')) return '#30d158';
    const sev = (props.severity || '').toLowerCase();
    if (sev === 'extreme') return '#ff2d55';
    if (sev === 'severe') return '#ff9f0a';
    if (sev === 'moderate') return '#ffd60a';
    return '#8e8e93';
}

function showAlertPopup(e) {
    const p = e.features[0].properties;
    const wrap = document.createElement('div');
    wrap.className = 'alert-popup';
    const title = document.createElement('div');
    title.className = 'alert-popup-title';
    // Titles are long ("X issued <date> until <date> by NWS Y") - keep the lead
    title.textContent = (p.title || 'Weather alert').split(' issued ')[0];
    wrap.appendChild(title);
    if (p.expires) {
        const until = document.createElement('div');
        until.className = 'alert-popup-until';
        until.textContent = 'Until ' + new Date(Number(p.expires) * 1000).toLocaleString('en-US', {
            weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
        }) + ' ET';
        wrap.appendChild(until);
    }
    new maplibregl.Popup({ maxWidth: '320px', closeButton: true })
        .setLngLat(e.lngLat)
        .setDOMContent(wrap)
        .addTo(map);
}

async function loadAlerts() {
    try {
        const c = map.getCenter();
        const res = await fetch(`/api/radar/alerts?lat=${c.lat.toFixed(2)}&lon=${c.lng.toFixed(2)}&radius=${ALERTS_RADIUS_KM}`);
        if (!res.ok) return;
        const geojson = await res.json();
        const nowSec = Date.now() / 1000;
        geojson.features = (geojson.features || []).filter(f =>
            f.geometry && (!f.properties?.expires || Number(f.properties.expires) > nowSec));
        for (const f of geojson.features) {
            f.properties.color = alertColor(f.properties);
        }
        lastAlertsCenter = [c.lng, c.lat];

        const src = map.getSource('alerts');
        if (src) {
            src.setData(geojson);
            return;
        }
        map.addSource('alerts', { type: 'geojson', data: geojson });
        const beforeId = labelLayerId();
        map.addLayer({
            id: 'alerts-fill', type: 'fill', source: 'alerts',
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.10 }
        }, beforeId);
        map.addLayer({
            id: 'alerts-line', type: 'line', source: 'alerts',
            paint: { 'line-color': ['get', 'color'], 'line-width': 1.8, 'line-opacity': 0.9 }
        }, beforeId);

        map.on('click', 'alerts-fill', showAlertPopup);
        map.on('mouseenter', 'alerts-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'alerts-fill', () => { map.getCanvas().style.cursor = ''; });
    } catch (err) {
        console.error('[ALERTS]', err);
    }
}

// Static satellite frame kept beneath every radar layer
function syncBackdrop(frame) {
    const id = frame ? `backdrop-${frame.time}` : null;
    if (id === backdropId) return;
    // ponytail: old backdrop drops before the new one loads (a blink once an hour)
    if (backdropId) { map.removeLayer(backdropId); map.removeSource(backdropId); }
    backdropId = id;
    if (!frame) return;
    const firstRadar = map.getStyle().layers.find(l => loadedLayerIds.has(l.id));
    map.addSource(id, sourceFor(frame));
    map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': SAT_OPACITY, 'raster-fade-duration': 0 } },
        firstRadar?.id ?? (map.getLayer('alerts-fill') ? 'alerts-fill' : labelLayerId()));
}

function showRange() {
    const r = RANGES.find(r => r.mode === rangeMode());
    els.rangeBtn.textContent = r.label;
    els.rangeBtn.title = r.title;
    els.rangeBtn.dataset.forecast = String(r.mode !== 'now');
}

function setOverlay(which) {
    overlay = which;
    store.set(OVERLAY_KEY, which);
    els.overlay.value = which;
    els.overlayName.textContent = els.overlay.selectedOptions[0].text;
    els.legend.dataset.overlay = FIELD_OVERLAYS[which] ? 'field' : which;
    els.legend.dataset.model = String(!FIELD_OVERLAYS[which] && !!fieldFor(which, rangeMode()));
    showRange();
    if (!mapReady) return;   // map 'load' picks it up
    pause();
    for (const id of [...loadedLayerIds]) removeLayer(id);
    staleTwins.clear();
    pending = [];
    frames = [];
    refreshFrames({ initial: true }).then(play);
}

async function refreshFrames({ initial = false } = {}) {
    try {
        const which = overlay, range = rangeIdx;
        const { frames: newFrames, backdrop, legend } = await fetchFrames(which);
        if (which !== overlay || range !== rangeIdx) return;   // switched mid-fetch
        if (legend) renderFieldLegend(legend);
        syncBackdrop(backdrop);
        if (!newFrames.length) throw new Error('No frames available');

        const latestPastIdx = (() => {
            const idx = newFrames.map(f => f.nowcast).indexOf(true);
            return idx === -1 ? newFrames.length - 1 : idx - 1;
        })();

        const prevTime = frames[currentFrame]?.time;
        frames = newFrames;
        els.scrubber.max = String(frames.length - 1);

        // Pick the frame to show before syncing so it gets loaded first
        const keep = initial ? -1 : frames.findIndex(f => f.time >= (prevTime || 0));
        currentFrame = keep === -1 ? latestPastIdx : keep;
        syncLayers();
        showFrame(currentFrame);

        const latest = frames[latestPastIdx];
        if (frames[0].src === 'rtma') {
            els.updated.textContent = 'Observed, RTMA';
        } else if (frames[0].field) {
            els.updated.textContent = `RRFS ${frames[0].cycle}Z run`;
        } else if (latest) {
            const d = new Date(latest.time * 1000);
            els.updated.textContent = 'Updated ' + d.toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
            }) + ' ET';
        }
    } catch (err) {
        console.error('[RADAR]', err);
        if (initial) {
            els.frameTime.textContent = `${els.overlay.selectedOptions[0].text} unavailable`;
            els.frameBadge.textContent = '';
        }
    }
}

// ============ Map numbers + wind particles ============
// Both read the field's coarse lat/lon grid (/grid.bin: int8, -128 off the
// model grid; wind is earth-relative u then v in 0.5 m/s). Numbers sit under
// the towns the basemap is currently showing, so their density follows the
// basemap's own label density; a sparse lattice fills the gaps (sea, rural
// areas) and yields to them in collision placement.
const NUMBER_FILL_PX = 240;           // spacing of the numbers filling town-less areas
// Place classes that get a number, in placement priority order
const NUMBER_PLACES = ['city', 'town', 'village'];
const FLOW_CELL = 8;                  // px per screen-space velocity lookup cell
const PARTICLE_SPEED = 0.25;          // px per animation frame per m/s, same at every zoom
const PARTICLE_DENSITY = 1 / 900;     // particles per px of map
const PARTICLE_BAND_MPH = 5;          // particles are colored and sized per 5 mph band
const PARTICLE_BANDS = 16;            // up to 80 mph
const PX_TO_MPH = 2.23694 / PARTICLE_SPEED;

// Stroke color per speed band from the legend's own stops (mph), lifted
// toward white on the dark map (toward black on the light one) so a particle
// reads against the same hue in the field under it; width grows with speed
const PARTICLE_TINT = isLight ? [0, 0, 0, 0.3] : [255, 255, 255, 0.4];
function particleStyles(stops) {
    return Array.from({ length: PARTICLE_BANDS }, (_, b) => {
        const mph = (b + 0.5) * PARTICLE_BAND_MPH;
        const k = stops.findIndex(([v]) => v >= mph);
        const [v0, c0] = stops[Math.max(0, k - 1)], [v1, c1] = stops[k === -1 ? stops.length - 1 : k];
        const f = v1 > v0 ? Math.min(Math.max((mph - v0) / (v1 - v0), 0), 1) : 0;
        const [r, g, bl] = c0.map((x, i) => x + (c1[i] - x) * f)
            .slice(0, 3).map((x, i) => Math.round(x + (PARTICLE_TINT[i] - x) * PARTICLE_TINT[3]));
        return { color: `rgb(${r},${g},${bl})`, width: 0.7 + b * 0.18 };   // ~1px at 5 mph, ~3px at 60
    });
}
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const gridCache = new Map();          // url -> Promise<Int8Array | null>
let grid = null;                      // { name, meta, data } for the frame on screen
let flow = null;                      // { cols, rows, v: Float32Array [vx, vy] per cell }
let particles = [];
let particleRaf = 0;
let particleCanvas = null;

function loadGrid(frame) {
    const url = `/api/radar/field/${frame.field}/grid.bin?v=${FIELD_STYLE_V}`;
    if (!gridCache.has(url)) {
        if (gridCache.size >= 48) gridCache.delete(gridCache.keys().next().value);
        gridCache.set(url, fetch(url)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
            })
            // Undo the extractor's pack_grid: cumulative sum, wrapping like int8
            .then(b => {
                const a = new Int8Array(b);
                for (let i = 1; i < a.length; i++) a[i] += a[i - 1];
                return a;
            })
            .catch(() => { gridCache.delete(url); return null; }));
    }
    return gridCache.get(url);
}

// Bilinear value of grid layer k (0, or 1 for wind v) at lng/lat; null off the grid
function gridValue(lng, lat, k = 0) {
    const { meta, data } = grid;
    const x = (lng - meta.west) / meta.step, y = (meta.north - lat) / meta.step;
    // Epsilon: grid points given back as west + c * step land on c, not c - 1e-14
    const c = Math.floor(x + 1e-9), r = Math.floor(y + 1e-9);
    if (c < 0 || r < 0 || c >= meta.nx - 1 || r >= meta.ny - 1) return null;
    const o = k * meta.nx * meta.ny + r * meta.nx + c;
    const q = [data[o], data[o + 1], data[o + meta.nx], data[o + meta.nx + 1]];
    if (q.includes(-128)) return null;
    const fx = x - c, fy = y - r;
    return (q[0] * (1 - fx) + q[1] * fx) * (1 - fy) + (q[2] * (1 - fx) + q[3] * fx) * fy;
}

// fmt (from the extractor): grid value = scale x unit value; peak fields
// (winds, totals) skip zeros and label each fill cell at its maximum
function numberText(lng, lat) {
    const { scale, suffix, peak } = grid.meta.fmt;
    let v;
    if (grid.meta.fmt.uv) {
        const u = gridValue(lng, lat, 0), vv = gridValue(lng, lat, 1);
        v = u === null || vv === null ? null : Math.hypot(u, vv) / 2 * 2.23694;
    } else {
        v = gridValue(lng, lat);
        v = v === null ? null : v / scale;
    }
    if (v === null || peak && v < 0.5 / scale) return null;
    return (scale > 1 ? v.toFixed(1).replace(/^0\./, '.') : Math.round(v)) + suffix;
}

function updateNumbers() {
    const src = map.getSource('numbers');
    if (!src) return;
    const features = [];
    const add = (lng, lat, rank) => {
        const t = numberText(lng, lat);
        if (t !== null) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { t, rank } });
    };
    if (grid) {
        const seen = new Set();
        for (const f of map.queryRenderedFeatures({ layers: placeLayerIds() })) {
            const rank = NUMBER_PLACES.indexOf(f.properties.class);
            const key = `${f.properties.name}|${f.geometry.coordinates}`;
            if (rank === -1 || f.geometry.type !== 'Point' || seen.has(key)) continue;
            seen.add(key);
            add(...f.geometry.coordinates, rank);
        }
        // Fill: cells fixed in lat/lon (power-of-two degrees, stable while
        // panning), each labelled at its most unusual grid point, so terrain
        // shows up: a cold hollow, a warm valley, a windy ridge
        const pxPerDeg = 512 * 2 ** map.getZoom() / 360;
        const s = 2 ** Math.round(Math.log2(NUMBER_FILL_PX / pxPerDeg));
        const b = map.getBounds();
        for (let i = Math.floor(b.getSouth() / s); i * s <= b.getNorth(); i++) {
            for (let j = Math.floor(b.getWest() / s); j * s <= b.getEast(); j++) {
                const p = standoutPoint(j * s, i * s, s);
                if (p) add(p[0], p[1], NUMBER_PLACES.length);
            }
        }
    }
    src.setData({ type: 'FeatureCollection', features });
}

// Grid point in the cell [lng0, lng0+s) x [lat0, lat0+s) furthest from the
// cell's mean (wind: the strongest, which is what matters offshore); null if
// the cell has no model data. Only points gridValue can interpolate (all four
// corners on the model grid) qualify, so the cell's label never comes back null.
function standoutPoint(lng0, lat0, s) {
    const { meta, data } = grid;
    const n = meta.nx * meta.ny;
    const c0 = Math.max(0, Math.ceil((lng0 - meta.west) / meta.step));
    const c1 = Math.min(meta.nx - 2, Math.floor((lng0 + s - meta.west) / meta.step - 1e-9));
    const r0 = Math.max(0, Math.ceil((meta.north - lat0 - s) / meta.step + 1e-9));
    const r1 = Math.min(meta.ny - 2, Math.floor((meta.north - lat0) / meta.step));
    const pts = [];
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const o = r * meta.nx + c;
            if (data[o] === -128 || data[o + 1] === -128 || data[o + meta.nx] === -128 || data[o + meta.nx + 1] === -128) continue;
            pts.push([c, r, meta.fmt.uv ? Math.hypot(data[o], data[o + n]) : data[o]]);
        }
    }
    if (!pts.length) return null;
    const mean = meta.fmt.peak ? 0 : pts.reduce((a, p) => a + p[2], 0) / pts.length;
    const [c, r] = pts.reduce((best, p) => Math.abs(p[2] - mean) > Math.abs(best[2] - mean) ? p : best);
    return [meta.west + c * meta.step, meta.north - r * meta.step];
}

let placeLayers = null;
function placeLayerIds() {
    placeLayers ??= map.getStyle().layers.filter(l => l.type === 'symbol' && l['source-layer'] === 'place').map(l => l.id);
    return placeLayers;
}

function addNumbersLayer() {
    // An upright font the basemap already serves glyphs for (bold if it has one)
    const fonts = map.getStyle().layers.flatMap(l => l.type === 'symbol' && Array.isArray(l.layout?.['text-font'])
        ? [l.layout['text-font']] : []).filter(f => !/italic/i.test(f.join()));
    const font = fonts.find(f => /bold/i.test(f.join())) || fonts[0] || ['Noto Sans Regular'];
    map.addSource('numbers', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'numbers', type: 'symbol', source: 'numbers',
        layout: {
            'text-field': ['get', 't'], 'text-font': font, 'text-padding': 6,
            'text-size': ['case', ['<', ['get', 'rank'], NUMBER_PLACES.length], 13, 11],
            // Just under the town name when there is room, else beside it
            'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
            'text-radial-offset': 0.95,
            'symbol-sort-key': ['get', 'rank'],
        },
        paint: {
            'text-opacity': ['case', ['<', ['get', 'rank'], NUMBER_PLACES.length], 1, 0.7],
            'text-color': isLight ? '#1b2230' : '#f4f6fb',
            'text-halo-color': isLight ? 'rgba(255,255,255,0.8)' : 'rgba(8,10,16,0.7)',
            'text-halo-width': 1.4,
        },
    }, labelLayerId());
}

// Screen-space velocity per FLOW_CELL, rebuilt when the view settles or
// the wind frame changes, so the animation loop never unprojects. A running
// animation just picks up the new velocities, keeping its trails.
let cellLngLat = null;                // { key, ll: Float64Array [lng, lat] per cell } for the current view
function buildFlow() {
    if (!grid?.meta.fmt.uv || reducedMotion) { flow = null; stopParticles(); return; }
    if (map.isMoving()) return;       // moveend rebuilds
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    const cols = Math.ceil(w / FLOW_CELL) + 1, rows = Math.ceil(h / FLOW_CELL) + 1;
    const key = `${w}x${h}@${map.getCenter().toArray()}/${map.getZoom()}`;
    if (cellLngLat?.key !== key) {
        const ll = new Float64Array(cols * rows * 2);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const p = map.unproject([c * FLOW_CELL, r * FLOW_CELL]);
                ll[(r * cols + c) * 2] = p.lng;
                ll[(r * cols + c) * 2 + 1] = p.lat;
            }
        }
        cellLngLat = { key, ll };
    }
    const v = new Float32Array(cols * rows * 2);
    for (let i = 0; i < v.length; i += 2) {
        const u = gridValue(cellLngLat.ll[i], cellLngLat.ll[i + 1], 0);
        const vv = gridValue(cellLngLat.ll[i], cellLngLat.ll[i + 1], 1);
        v[i] = u === null ? NaN : u / 2 * PARTICLE_SPEED;
        v[i + 1] = vv === null ? NaN : -vv / 2 * PARTICLE_SPEED;   // north is up the screen
    }
    const resized = flow?.w !== w || flow?.h !== h;
    flow = { cols, rows, w, h, v, styles: particleStyles(grid.meta.stops) };
    if (!particleRaf || resized) startParticles();
}

function spawn(p) {
    p.x = Math.random() * flow.w;
    p.y = Math.random() * flow.h;
    p.age = 40 + Math.random() * 60;
    return p;
}

function startParticles() {
    stopParticles();
    if (!particleCanvas) {
        particleCanvas = document.createElement('canvas');
        particleCanvas.className = 'particles';
        map.getCanvasContainer().appendChild(particleCanvas);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    particleCanvas.width = flow.w * dpr;
    particleCanvas.height = flow.h * dpr;
    const ctx = particleCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    // A thin dark halo keeps particles readable over the same colors in the field below
    const halo = isLight ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.3)';
    const count = Math.min(3000, Math.round(flow.w * flow.h * PARTICLE_DENSITY));
    particles = Array.from({ length: count }, () => spawn({}));
    const step = () => {
        // Fade the trails, then extend each particle one step along the flow
        ctx.globalCompositeOperation = 'destination-in';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.92)';
        ctx.fillRect(0, 0, flow.w, flow.h);
        ctx.globalCompositeOperation = 'source-over';
        const paths = flow.styles.map(() => null);
        for (const p of particles) {
            const i = (((p.y / FLOW_CELL) | 0) * flow.cols + ((p.x / FLOW_CELL) | 0)) * 2;
            const vx = flow.v[i], vy = flow.v[i + 1];
            if (p.age-- <= 0 || !(vx === vx) || p.x < 0 || p.y < 0 || p.x >= flow.w || p.y >= flow.h) {
                spawn(p);
                continue;
            }
            const band = Math.min(PARTICLE_BANDS - 1, (Math.hypot(vx, vy) * PX_TO_MPH / PARTICLE_BAND_MPH) | 0);
            const path = paths[band] ??= new Path2D();
            path.moveTo(p.x, p.y);
            p.x += vx;
            p.y += vy;
            path.lineTo(p.x, p.y);
        }
        paths.forEach((path, b) => {
            if (!path) return;
            const { color, width } = flow.styles[b];
            ctx.strokeStyle = halo;
            ctx.lineWidth = width + 1;
            ctx.stroke(path);
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.stroke(path);
        });
        particleRaf = requestAnimationFrame(step);
    };
    particleRaf = requestAnimationFrame(step);
}

function stopParticles() {
    cancelAnimationFrame(particleRaf);
    particleRaf = 0;
    particleCanvas?.getContext('2d').clearRect(0, 0, particleCanvas.width, particleCanvas.height);
}

// Point numbers and particles at the frame on screen once its grid arrives
function syncGrid(frame) {
    if (!frame?.grid) {
        if (grid) { grid = null; updateNumbers(); buildFlow(); }
        return;
    }
    loadGrid(frame).then(data => {
        if (frames[currentFrame] !== frame) return;
        grid = data ? { name: frame.name, meta: frame.grid, data } : null;
        updateNumbers();
        buildFlow();
    });
}

// ============ Tap to inspect ============
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// Every field the extractor has at the tapped point for the frame on screen.
// Radar/satellite observation frames have no model data: the nearest RTMA
// analysis stands in.
async function inspectAt(lngLat) {
    const cur = frames[currentFrame];
    if (!cur) return;
    // A pin marks the exact spot; the card sits just above it and takes the pin with it on close
    const pin = document.createElement('div');
    pin.className = 'inspect-pin';
    const marker = new maplibregl.Marker({ element: pin }).setLngLat(lngLat).addTo(map);
    const popup = new maplibregl.Popup({ maxWidth: '260px', offset: 14, className: 'inspect-popup' })
        .setLngLat(lngLat).setText('Loading\u2026').addTo(map);
    popup.on('close', () => marker.remove());
    try {
        let frame = cur;
        if (!frame.field) {
            const obs = (await fetchFieldFrames('tmp', 'now')).frames;
            frame = obs.reduce((a, f) => Math.abs(f.time - cur.time) < Math.abs(a.time - cur.time) ? f : a);
        }
        const res = await fetch(`/api/radar/field/${frame.field}/point?lat=${lngLat.lat.toFixed(4)}&lon=${lngLat.lng.toFixed(4)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        popup.setDOMContent(inspectContent(await res.json(), frame));
    } catch (err) {
        console.error('[INSPECT]', err);
        popup.setText('No data here');
    }
}

function inspectContent(v, frame) {
    const wrap = document.createElement('div');
    wrap.className = 'inspect';
    const line = (cls, text) => {
        const el = document.createElement('div');
        el.className = cls;
        el.textContent = text;
        wrap.appendChild(el);
    };
    if (!Object.keys(v).length) {
        line('inspect-row', 'Outside the model area');
        return wrap;
    }
    if (v.tmp != null) line('inspect-temp', `${Math.round(v.tmp)}°F` + (v.dpt != null ? `  dew point ${Math.round(v.dpt)}°` : ''));
    if (v.wind) {
        const calm = v.wind.mph < 1;
        line('inspect-row', calm ? 'Wind calm' : `Wind ${COMPASS[Math.round(v.wind.from / 22.5) % 16]} ${Math.round(v.wind.mph)} mph`
            + (v.gust != null && v.gust > v.wind.mph + 3 ? `, gusts ${Math.round(v.gust)}` : ''));
    }
    if (v.cloud != null) line('inspect-row', `Clouds ${Math.round(v.cloud)}%`);
    if (v.refc && v.refc.dbz >= 10) line('inspect-row', `Radar ${Math.round(v.refc.dbz)} dBZ ${v.refc.snow ? 'snow' : 'rain'} (simulated)`);
    if (v.qpf >= 0.01) line('inspect-row', `Precip ${v.qpf.toFixed(2)}" since run start`);
    if (v.snowtot >= 0.1) line('inspect-row', `Snow ${v.snowtot.toFixed(1)}" since run start`);
    const at = new Date(frame.time * 1000).toLocaleString('en-US', {
        weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
    });
    line('inspect-src', `${at} ET \u00b7 ${frame.src === 'rtma' ? 'observed (RTMA)' : `RRFS ${frame.cycle}Z +${frame.fh}h`}`);
    return wrap;
}

function init() {
    applySiteSettings().then(s => {
        if (s.siteName) document.title = `Radar - ${s.siteName}`;
    });

    const start = savedPosition();
    map = new maplibregl.Map({
        container: 'map',
        style: BASEMAP_STYLE,
        center: start.center,
        zoom: start.zoom,
        minZoom: 3,
        maxZoom: 12,          // LibreWXR radar tiles top out around z12
        hash: true,           // Shareable URLs with position (overrides saved)
        fadeDuration: 0,      // No basemap label crossfade - snappier feel
        attributionControl: { compact: true },
        // Embedded mini map: one finger / plain wheel scroll the page; two fingers / ctrl+wheel move the map
        cooperativeGestures: EMBED,
    });
    setGestures = on => map.cooperativeGestures?.[on ? 'enable' : 'disable']?.();
    if (EMBED) els.legend.open = false;

    // Remember where the user left the map
    map.on('moveend', () => {
        const c = map.getCenter();
        store.set(POSITION_KEY, JSON.stringify({
            center: [c.lng, c.lat], zoom: map.getZoom()
        }));
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: false },
        trackUserLocation: false
    }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');

    // Mark a frame ready once its tiles are in. Sticky: panning later
    // makes a source momentarily "not loaded" again, which shouldn't
    // pull frames back out of the animation.
    map.on('sourcedata', (e) => {
        if (e.sourceDataType !== 'metadata' && loadedLayerIds.has(e.sourceId) && map.isSourceLoaded(e.sourceId)) {
            readyIds.add(e.sourceId);
            // Swap a superseded frame out the moment its replacement is in
            if (staleTwins.has(e.sourceId) && frames[currentFrame] && layerId(frames[currentFrame]) === e.sourceId) {
                showFrame(currentFrame);
            }
        }
    });

    map.on('load', async () => {
        mapReady = true;
        addNumbersLayer();
        loadAlerts();
        setInterval(() => !document.hidden && loadAlerts(), ALERTS_REFRESH_MS);
        await refreshFrames({ initial: true });
        if (linkTime && frames.length) {
            // Opened from a plume chart: hold on the frame nearest that time
            showFrame(frames.reduce((best, f, i) =>
                Math.abs(f.time - linkTime) < Math.abs(frames[best].time - linkTime) ? i : best, 0));
        } else {
            // Playback only steps over frames whose tiles have arrived, so it
            // can start immediately and grow as frames trickle in.
            play();
        }
        setInterval(() => !document.hidden && refreshFrames(), REFRESH_MS);
    });

    map.on('click', (e) => {
        if (map.getLayer('alerts-fill') && map.queryRenderedFeatures(e.point, { layers: ['alerts-fill'] }).length) return;
        inspectAt(e.lngLat);
    });

    map.on('movestart', stopParticles);
    // Town labels are only queryable once placed, so numbers wait for idle
    map.on('moveend', () => { if (grid) { map.once('idle', updateNumbers); buildFlow(); } });
    map.on('resize', () => grid && buildFlow());   // a size change restarts the particles

    // Refetch alerts when the map moves well away from the last fetch center
    map.on('moveend', () => {
        if (!lastAlertsCenter) return;
        const c = map.getCenter();
        if (Math.abs(c.lng - lastAlertsCenter[0]) > 3 || Math.abs(c.lat - lastAlertsCenter[1]) > 3) {
            loadAlerts();
        }
    });

    els.playBtn.addEventListener('click', () => playing ? pause() : play());

    // Deep link from a plume chart: /radar?layer=temp&t=<unix seconds>. The
    // range is chosen to cover t; the query is dropped so a reload resumes normally.
    const link = new URLSearchParams(location.search);
    const linkTime = Number(link.get('t')) || 0;
    if (OVERLAYS.includes(link.get('layer')) && !layerFromParent) overlay = link.get('layer');
    if (linkTime) {
        const ahead = (linkTime - Date.now() / 1000) / 3600;
        rangeIdx = RANGES.findIndex(r => r.mode === (ahead <= 0.5 ? 'now' : ahead <= 26 ? 'hourly' : 'extended'));
    }
    if (link.has('t') || link.has('layer')) {
        link.delete('t');
        link.delete('layer');
        history.replaceState(null, '', location.pathname + (link.size ? `?${link}` : '') + location.hash);
    }

    setOverlay(overlay);
    overlayReady = true;
    els.overlay.addEventListener('change', () => setOverlay(els.overlay.value));

    els.rangeBtn.addEventListener('click', () => {
        // Step from what is shown (run totals show 'now' as 36h)
        rangeIdx = (RANGES.findIndex(r => r.mode === rangeMode()) + 1) % RANGES.length;
        if (RANGES[rangeIdx].mode === 'now' && NO_NOW.has(overlay)) rangeIdx = (rangeIdx + 1) % RANGES.length;
        store.set(RANGE_KEY, RANGES[rangeIdx].mode);
        setOverlay(overlay);
    });

    // The basemap style, tile dimming and canvas colors are all chosen at
    // load, so switching reloads; position, overlay and range persist
    els.themeBtn.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
    els.themeBtn.addEventListener('click', () => {
        store.set('sref-theme', isLight ? 'dark' : 'light');
        location.reload();
    });

    if (store.get(LEGEND_KEY) === '0') els.legend.open = false;
    els.legend.addEventListener('toggle', () => store.set(LEGEND_KEY, els.legend.open ? '1' : '0'));

    els.speedBtn.textContent = SPEEDS[speedIdx].label;
    els.speedBtn.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % SPEEDS.length;
        store.set(SPEED_KEY, String(SPEEDS[speedIdx].mult));
        els.speedBtn.textContent = SPEEDS[speedIdx].label;
    });

    els.scrubber.addEventListener('input', (e) => {
        pause();
        showFrame(Number(e.target.value));
    });

    // Pause while hidden to save battery; on return, catch up and resume
    let resumeOnShow = false;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            resumeOnShow = playing;
            pause();
        } else if (frames.length) {
            refreshFrames();
            loadAlerts();
            if (resumeOnShow) play();
        }
    });
}

document.addEventListener('DOMContentLoaded', init);
