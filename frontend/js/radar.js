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

// Tiles come through our backend (/api/radar/tile), which caches them and
// pre-renders the NYC viewport for each new frame; style options live there.
const TILE_SIZE = 256;    // Backend requests 512px tiles; declaring 256 renders them at 2x density
const RADAR_OPACITY = 0.75;
const FRAME_MS = 500;               // ms per frame at 1x
const LAST_FRAME_HOLD_MS = 1500;    // Extra pause on the final nowcast frame
const REFRESH_MS = 2 * 60 * 1000;   // Re-fetch frame index
const LOAD_PARALLEL = 2;            // Frames loading tiles at once
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

function savedPosition() {
    try {
        const saved = JSON.parse(localStorage.getItem(POSITION_KEY));
        if (saved && Array.isArray(saved.center) && typeof saved.zoom === 'number') {
            return saved;
        }
    } catch { /* corrupt/missing - use default */ }
    return NYC;
}

const isLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
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
};

let map = null;
let frames = [];          // [{ time, path, nowcast }]
let currentFrame = 0;
let playing = false;
let playTimer = null;
let loadedLayerIds = new Set();   // layers added to the map
let readyIds = new Set();         // layers whose tiles have arrived
let pending = [];                 // frames waiting for a load slot
let staleTwins = new Map();       // replacement layer id -> superseded layer id kept until ready
let inFlight = 0;
let speedIdx = (() => {
    const saved = localStorage.getItem(SPEED_KEY);
    const idx = SPEEDS.findIndex(s => String(s.mult) === saved);
    return idx === -1 ? 0 : idx;
})();

function tileUrl(frame) {
    const url = `/api/radar/tile/${frame.time}/{z}/{x}/{y}.png`;
    // A nowcast frame shares its time with the observed frame it later
    // becomes; a distinct URL keeps caches from serving the forecast as
    // the observation.
    return frame.nowcast ? `${url}?fc=${frame.basis}` : url;
}

// Nowcast frames are regenerated from each new observation, so their
// identity includes the observation they were derived from.
function layerId(frame) {
    return frame.nowcast ? `radar-${frame.time}-fc${frame.basis}` : `radar-${frame.time}`;
}

async function fetchFrames() {
    const res = await fetch('/api/radar/frames');
    if (!res.ok) throw new Error(`Frame index HTTP ${res.status}`);
    const data = await res.json();
    const past = (data.radar?.past || []).map(f => ({ ...f, nowcast: false }));
    const basis = past.length ? past[past.length - 1].time : 0;
    const nowcast = (data.radar?.nowcast || []).map(f => ({ ...f, nowcast: true, basis }));
    return past.concat(nowcast);
}

function labelLayerId() {
    const labelLayer = map.getStyle().layers.find(l =>
        l.type === 'symbol' && (l.id.includes('label') || l.id.includes('place')));
    return labelLayer ? labelLayer.id : undefined;
}

function addFrameLayer(frame) {
    const id = layerId(frame);
    // Insert below warning polygons (and labels) so alert outlines stay
    // visible on top of the radar.
    const beforeId = map.getLayer('alerts-fill') ? 'alerts-fill' : labelLayerId();
    map.addSource(id, {
        type: 'raster',
        tiles: [tileUrl(frame)],
        tileSize: TILE_SIZE,
        attribution: 'Radar &copy; <a href="https://librewxr.net/">LibreWXR</a> (CC-BY-4.0)'
    });
    map.addLayer({
        id,
        type: 'raster',
        source: id,
        paint: {
            'raster-opacity': frames[currentFrame] === frame ? RADAR_OPACITY : 0,
            'raster-opacity-transition': { duration: 0 },
            'raster-fade-duration': 0
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
        function done() { clearTimeout(timer); map.off('sourcedata', onData); resolve(); }
        map.on('sourcedata', onData);
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
        map.setPaintProperty(id, 'raster-opacity', show ? RADAR_OPACITY : 0);
    }
    els.scrubber.value = String(currentFrame);
    updateFrameLabel();
}

function updateFrameLabel() {
    const frame = frames[currentFrame];
    if (!frame) return;
    const d = new Date(frame.time * 1000);
    els.frameTime.textContent = d.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
    }) + ' ET';

    if (frame.nowcast) {
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
    els.playBtn.textContent = '❚❚';
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
    els.playBtn.textContent = '▶';
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

async function refreshFrames({ initial = false } = {}) {
    try {
        const newFrames = await fetchFrames();
        if (!newFrames.length) throw new Error('No radar frames available');

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
        if (latest) {
            const d = new Date(latest.time * 1000);
            els.updated.textContent = 'Updated ' + d.toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
            }) + ' ET';
        }
    } catch (err) {
        console.error('[RADAR]', err);
        if (initial) {
            els.frameTime.textContent = 'Radar unavailable';
            els.frameBadge.textContent = '';
        }
    }
}

function init() {
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
        attributionControl: { compact: true }
    });

    // Remember where the user left the map
    map.on('moveend', () => {
        const c = map.getCenter();
        localStorage.setItem(POSITION_KEY, JSON.stringify({
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
        loadAlerts();
        setInterval(loadAlerts, ALERTS_REFRESH_MS);
        await refreshFrames({ initial: true });
        // Playback only steps over frames whose tiles have arrived, so it
        // can start immediately and grow as frames trickle in.
        play();
        setInterval(() => refreshFrames(), REFRESH_MS);
    });

    // Refetch alerts when the map moves well away from the last fetch center
    map.on('moveend', () => {
        if (!lastAlertsCenter) return;
        const c = map.getCenter();
        if (Math.abs(c.lng - lastAlertsCenter[0]) > 3 || Math.abs(c.lat - lastAlertsCenter[1]) > 3) {
            loadAlerts();
        }
    });

    els.playBtn.addEventListener('click', () => playing ? pause() : play());

    els.speedBtn.textContent = SPEEDS[speedIdx].label;
    els.speedBtn.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % SPEEDS.length;
        localStorage.setItem(SPEED_KEY, String(SPEEDS[speedIdx].mult));
        els.speedBtn.textContent = SPEEDS[speedIdx].label;
    });

    els.scrubber.addEventListener('input', (e) => {
        pause();
        showFrame(Number(e.target.value));
    });

    // Pause the animation while the tab is hidden to save battery
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) pause();
    });
}

document.addEventListener('DOMContentLoaded', init);
