/**
 * Radar Map Page
 * MapLibre GL basemap (OpenFreeMap vector tiles) with animated radar
 * frames from LibreWXR: ~2 hours of history plus a 60-minute nowcast.
 *
 * Frame index comes from our backend (/api/radar/frames, 60s shared cache);
 * tiles load directly from api.librewxr.net.
 */

const TILE_HOST = 'https://api.librewxr.net';
const TILE_SIZE = 512;    // 4x fewer tile requests than 256
const COLOR_SCHEME = 2;   // Universal Blue
const SMOOTH = 1;
const SNOW = 1;           // Per-pixel rain/snow classification
const RADAR_OPACITY = 0.75;
const FRAME_INTERVAL_MS = 450;      // Animation speed
const LAST_FRAME_HOLD_MS = 1350;    // Pause on the latest/last frame
const REFRESH_MS = 2 * 60 * 1000;   // Re-fetch frame index

const NYC = { center: [-73.95, 40.75], zoom: 8.2 };
const POSITION_KEY = 'sref-radar-position';

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
let loadedLayerIds = new Set();

function tileUrl(frame) {
    return `${TILE_HOST}${frame.path}/${TILE_SIZE}/{z}/{x}/{y}/${COLOR_SCHEME}/${SMOOTH}_${SNOW}.png`;
}

function layerId(frame) {
    return `radar-${frame.time}`;
}

async function fetchFrames() {
    const res = await fetch('/api/radar/frames');
    if (!res.ok) throw new Error(`Frame index HTTP ${res.status}`);
    const data = await res.json();
    const past = (data.radar?.past || []).map(f => ({ ...f, nowcast: false }));
    const nowcast = (data.radar?.nowcast || []).map(f => ({ ...f, nowcast: true }));
    return past.concat(nowcast);
}

/**
 * Sync map layers to the current frame list: add new frames as raster
 * layers (opacity 0), remove frames that fell out of the window.
 */
function syncLayers() {
    const wanted = new Set(frames.map(layerId));

    // Remove stale layers/sources
    for (const id of [...loadedLayerIds]) {
        if (!wanted.has(id)) {
            if (map.getLayer(id)) map.removeLayer(id);
            if (map.getSource(id)) map.removeSource(id);
            loadedLayerIds.delete(id);
        }
    }

    // Add missing ones. Insert below label layers so place names stay readable.
    const labelLayer = map.getStyle().layers.find(l =>
        l.type === 'symbol' && (l.id.includes('label') || l.id.includes('place')));
    const beforeId = labelLayer ? labelLayer.id : undefined;

    for (const frame of frames) {
        const id = layerId(frame);
        if (loadedLayerIds.has(id)) continue;
        map.addSource(id, {
            type: 'raster',
            tiles: [tileUrl(frame)],
            tileSize: TILE_SIZE,
            attribution: 'Radar &copy; <a href="https://librewxr.net/">LibreWXR</a> (CC-BY-4.0)'
        });
        // Opacity 0 layers still fetch their tiles (opacity is a paint
        // property), so every frame preloads and scrubbing is instant.
        // No transitions/fades - crossfading between frames reads as blur.
        map.addLayer({
            id,
            type: 'raster',
            source: id,
            paint: {
                'raster-opacity': 0,
                'raster-opacity-transition': { duration: 0 },
                'raster-fade-duration': 0
            }
        }, beforeId);
        loadedLayerIds.add(id);
    }
}

function showFrame(index) {
    if (!frames.length) return;
    currentFrame = Math.max(0, Math.min(index, frames.length - 1));
    for (let i = 0; i < frames.length; i++) {
        const id = layerId(frames[i]);
        if (map.getLayer(id)) {
            map.setPaintProperty(id, 'raster-opacity', i === currentFrame ? RADAR_OPACITY : 0);
        }
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

function play() {
    if (playing || frames.length === 0) return;
    playing = true;
    els.playBtn.textContent = '❚❚';
    els.playBtn.setAttribute('aria-label', 'Pause animation');
    const step = () => {
        if (!playing) return;
        const next = (currentFrame + 1) % frames.length;
        showFrame(next);
        const hold = next === frames.length - 1 ? LAST_FRAME_HOLD_MS : FRAME_INTERVAL_MS;
        playTimer = setTimeout(step, hold);
    };
    playTimer = setTimeout(step, FRAME_INTERVAL_MS);
}

function pause() {
    playing = false;
    clearTimeout(playTimer);
    els.playBtn.textContent = '▶';
    els.playBtn.setAttribute('aria-label', 'Play animation');
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
        syncLayers();

        if (initial) {
            // Start on the most recent observed frame
            showFrame(latestPastIdx);
        } else {
            // Keep the closest frame to what was showing
            const keep = frames.findIndex(f => f.time >= (prevTime || 0));
            showFrame(keep === -1 ? latestPastIdx : keep);
        }

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

    map.on('load', async () => {
        await refreshFrames({ initial: true });
        // Don't animate until every frame's tiles are loaded - playing
        // through half-loaded frames looks broken. 'idle' fires once all
        // sources finish; the timeout is a fallback for a stalled tile.
        await Promise.race([
            new Promise(resolve => map.once('idle', resolve)),
            new Promise(resolve => setTimeout(resolve, 6000))
        ]);
        play();
        setInterval(() => refreshFrames(), REFRESH_MS);
    });

    els.playBtn.addEventListener('click', () => playing ? pause() : play());
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
