/**
 * Radar Map Page
 * MapLibre GL basemap (OpenFreeMap vector tiles) with animated radar
 * frames from LibreWXR: ~2 hours of history plus a 60-minute nowcast.
 *
 * Frame index comes from our backend (/api/radar/frames, 60s shared cache);
 * tiles load directly from api.librewxr.net.
 *
 * Rendering: MorphRenderer stitches each frame's tiles into a canvas,
 * estimates a motion vector between consecutive frames (block matching
 * on the echo alpha channel), and renders fractional positions by
 * translating both frames along that vector while dissolving at constant
 * intensity - i.e. echoes MOVE between frames instead of blinking.
 * If tile pixel access fails, LayerRenderer (plain per-frame raster
 * layers with a constant-intensity dissolve) is the fallback.
 */

const TILE_HOST = 'https://api.librewxr.net';
const COLOR_SCHEME = 2;   // Universal Blue
const SMOOTH = 1;
const SNOW = 1;           // Per-pixel rain/snow classification
const RADAR_OPACITY = 0.75;
const PLAY_SPEED_BASE = 2.4;        // Frames per second at 1x
const SPEED_STEPS = [0.5, 1, 2];    // Speed button cycle
const LAST_FRAME_HOLD_MS = 1500;    // Pause on the final nowcast frame
const REFRESH_MS = 2 * 60 * 1000;   // Re-fetch frame index

// Morph renderer tuning
const STITCH_TILE = 256;      // Tile size used for stitched frames
const MAX_STITCH_TILES = 36;  // Memory cap: lower stitch zoom beyond this
const VIEW_MARGIN = 0.35;     // Extra area around viewport (pan headroom)
const FLOW_WIDTH = 160;       // Downsample width for motion estimation
const FLOW_RANGE = 10;        // Max search offset (downsampled px)
// Internal dissolve target < 1 so single-frame pixels fade instead of
// popping; the map layer opacity compensates to reach RADAR_OPACITY.
const INTERNAL_A = 0.85;

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
let renderer = null;      // MorphRenderer or LayerRenderer
let frames = [];          // [{ time, path, nowcast }]
let position = 0;         // Fractional frame index
let playing = false;
let rafId = null;
let holdUntil = 0;
let lastTick = null;
let labeledFrame = -1;
let speedIdx = Math.max(0, SPEED_STEPS.indexOf(Number(localStorage.getItem(SPEED_KEY)) || 1));

function tileUrl(frame, size) {
    return `${TILE_HOST}${frame.path}/${size}/{z}/{x}/{y}/${COLOR_SCHEME}/${SMOOTH}_${SNOW}.png`;
}

function tilePngUrl(frame, z, x, y) {
    return `${TILE_HOST}${frame.path}/${STITCH_TILE}/${z}/${x}/${y}/${COLOR_SCHEME}/${SMOOTH}_${SNOW}.png`;
}

async function fetchFrames() {
    const res = await fetch('/api/radar/frames');
    if (!res.ok) throw new Error(`Frame index HTTP ${res.status}`);
    const data = await res.json();
    const past = (data.radar?.past || []).map(f => ({ ...f, nowcast: false }));
    const nowcast = (data.radar?.nowcast || []).map(f => ({ ...f, nowcast: true }));
    return past.concat(nowcast);
}

// ============ Slippy tile math ============
const lng2tile = (lng, z) => (lng + 180) / 360 * 2 ** z;
const lat2tile = (lat, z) => {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};
const tile2lng = (x, z) => x / 2 ** z * 360 - 180;
const tile2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;

function loadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);  // Missing tile = transparent
        img.src = url;
    });
}

/**
 * Motion-morphing renderer. All frames are stitched into offscreen
 * canvases sharing one geographic footprint; a single MapLibre canvas
 * source displays the blended result.
 */
class MorphRenderer {
    constructor(mapInstance) {
        this.map = mapInstance;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.stitches = new Map();  // "time|geoKey" -> canvas
        this.flows = new Map();     // "tA|tB|geoKey" -> {vx, vy}
        this.geo = null;
        this.rebuildSeq = 0;
        this.sourceId = 'radar-morph';
    }

    /** Choose stitch zoom + tile range for the current view. */
    computeGeometry() {
        const bounds = this.map.getBounds();
        const latSpan = bounds.getNorth() - bounds.getSouth();
        const lngSpan = bounds.getEast() - bounds.getWest();
        const north = Math.min(85, bounds.getNorth() + latSpan * VIEW_MARGIN);
        const south = Math.max(-85, bounds.getSouth() - latSpan * VIEW_MARGIN);
        const west = bounds.getWest() - lngSpan * VIEW_MARGIN;
        const east = bounds.getEast() + lngSpan * VIEW_MARGIN;

        let z = Math.max(3, Math.min(12, Math.round(this.map.getZoom())));
        for (; z >= 3; z--) {
            const x0 = Math.floor(lng2tile(west, z));
            const x1 = Math.floor(lng2tile(east, z));
            const y0 = Math.max(0, Math.floor(lat2tile(north, z)));
            const y1 = Math.min(2 ** z - 1, Math.floor(lat2tile(south, z)));
            const count = (x1 - x0 + 1) * (y1 - y0 + 1);
            if (count <= MAX_STITCH_TILES || z === 3) {
                return {
                    z, x0, x1, y0, y1,
                    key: `${z}/${x0}/${y0}/${x1}/${y1}`,
                    width: (x1 - x0 + 1) * STITCH_TILE,
                    height: (y1 - y0 + 1) * STITCH_TILE,
                    coordinates: [
                        [tile2lng(x0, z), tile2lat(y0, z)],
                        [tile2lng(x1 + 1, z), tile2lat(y0, z)],
                        [tile2lng(x1 + 1, z), tile2lat(y1 + 1, z)],
                        [tile2lng(x0, z), tile2lat(y1 + 1, z)]
                    ]
                };
            }
        }
    }

    async stitchFrame(frame, geo) {
        const key = `${frame.time}|${geo.key}`;
        if (this.stitches.has(key)) return this.stitches.get(key);

        const canvas = document.createElement('canvas');
        canvas.width = geo.width;
        canvas.height = geo.height;
        const ctx = canvas.getContext('2d');

        const jobs = [];
        for (let x = geo.x0; x <= geo.x1; x++) {
            for (let y = geo.y0; y <= geo.y1; y++) {
                jobs.push(loadImage(tilePngUrl(frame, geo.z, x, y)).then(img => {
                    if (img) ctx.drawImage(img, (x - geo.x0) * STITCH_TILE, (y - geo.y0) * STITCH_TILE);
                }));
            }
        }
        await Promise.all(jobs);
        this.stitches.set(key, canvas);
        return canvas;
    }

    /** Downsampled echo-intensity field (alpha channel) for flow matching. */
    intensityField(canvas) {
        const sw = FLOW_WIDTH;
        const sh = Math.max(8, Math.round(canvas.height * sw / canvas.width));
        const small = document.createElement('canvas');
        small.width = sw;
        small.height = sh;
        const sctx = small.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(canvas, 0, 0, sw, sh);
        const data = sctx.getImageData(0, 0, sw, sh).data;
        const field = new Float32Array(sw * sh);
        let total = 0;
        for (let i = 0; i < field.length; i++) {
            field[i] = data[i * 4 + 3];
            total += field[i];
        }
        return { field, sw, sh, mean: total / field.length };
    }

    /**
     * Global motion vector A->B via exhaustive block matching on the
     * downsampled fields, with parabolic sub-pixel refinement.
     * Returns displacement in stitch-canvas pixels.
     */
    estimateFlow(canvasA, canvasB) {
        const a = this.intensityField(canvasA);
        const b = this.intensityField(canvasB);
        // Not enough echo to correlate - fall back to pure dissolve
        if (a.mean < 1 || b.mean < 1) return { vx: 0, vy: 0 };

        const { sw, sh } = a;
        const R = FLOW_RANGE;
        const sadAt = (dx, dy) => {
            let sad = 0;
            for (let y = R; y < sh - R; y++) {
                const rowA = y * sw;
                const rowB = (y + dy) * sw + dx;
                for (let x = R; x < sw - R; x++) {
                    sad += Math.abs(a.field[rowA + x] - b.field[rowB + x]);
                }
            }
            return sad;
        };

        let best = Infinity, bx = 0, by = 0;
        for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
                const s = sadAt(dx, dy);
                if (s < best) { best = s; bx = dx; by = dy; }
            }
        }

        // Parabolic sub-pixel refinement along each axis
        const refine = (sm, s0, sp) => {
            const denom = sm - 2 * s0 + sp;
            if (denom <= 0) return 0;
            return Math.max(-0.5, Math.min(0.5, 0.5 * (sm - sp) / denom));
        };
        let fx = 0, fy = 0;
        if (Math.abs(bx) < R) fx = refine(sadAt(bx - 1, by), best, sadAt(bx + 1, by));
        if (Math.abs(by) < R) fy = refine(sadAt(bx, by - 1), best, sadAt(bx, by + 1));

        const scale = canvasA.width / sw;
        return { vx: (bx + fx) * scale, vy: (by + fy) * scale };
    }

    async setFrames(newFrames) {
        const seq = ++this.rebuildSeq;
        const geo = this.computeGeometry();

        // Stitch all frames (cached ones resolve instantly)
        const stitched = await Promise.all(newFrames.map(f => this.stitchFrame(f, geo)));
        if (seq !== this.rebuildSeq) return;  // Superseded by a newer rebuild

        // Prune stitches/flows from other geometries or dropped frames
        const wanted = new Set(newFrames.map(f => `${f.time}|${geo.key}`));
        for (const key of [...this.stitches.keys()]) {
            if (!wanted.has(key)) this.stitches.delete(key);
        }

        // Compute motion vectors for each consecutive pair, yielding
        // between pairs to keep the main thread responsive
        const wantedFlows = new Set();
        for (let i = 0; i < newFrames.length - 1; i++) {
            const fkey = `${newFrames[i].time}|${newFrames[i + 1].time}|${geo.key}`;
            wantedFlows.add(fkey);
            if (!this.flows.has(fkey)) {
                this.flows.set(fkey, this.estimateFlow(stitched[i], stitched[i + 1]));
                await new Promise(r => setTimeout(r, 0));
                if (seq !== this.rebuildSeq) return;
            }
        }
        for (const key of [...this.flows.keys()]) {
            if (!wantedFlows.has(key)) this.flows.delete(key);
        }

        this.geo = geo;
        this.ensureSource(geo);
    }

    ensureSource(geo) {
        const layerRebuild = this.canvas.width !== geo.width || this.canvas.height !== geo.height
            || !this.map.getSource(this.sourceId);

        if (layerRebuild) {
            if (this.map.getLayer(this.sourceId)) this.map.removeLayer(this.sourceId);
            if (this.map.getSource(this.sourceId)) this.map.removeSource(this.sourceId);
            this.canvas.width = geo.width;
            this.canvas.height = geo.height;

            this.map.addSource(this.sourceId, {
                type: 'canvas',
                canvas: this.canvas,
                coordinates: geo.coordinates,
                animate: true,
                attribution: 'Radar &copy; <a href="https://librewxr.net/">LibreWXR</a> (CC-BY-4.0)'
            });

            const labelLayer = this.map.getStyle().layers.find(l =>
                l.type === 'symbol' && (l.id.includes('label') || l.id.includes('place')));
            this.map.addLayer({
                id: this.sourceId,
                type: 'raster',
                source: this.sourceId,
                paint: {
                    // Canvas blends internally at INTERNAL_A; compensate here
                    'raster-opacity': Math.min(1, RADAR_OPACITY / INTERNAL_A),
                    'raster-opacity-transition': { duration: 0 },
                    'raster-fade-duration': 0
                }
            }, labelLayer ? labelLayer.id : undefined);
        } else {
            this.map.getSource(this.sourceId).setCoordinates(geo.coordinates);
        }
    }

    setPosition(pos, framesRef) {
        if (!this.geo) return;
        const base = Math.floor(pos);
        const frac = pos - base;
        const geoKey = this.geo.key;
        const A = this.stitches.get(`${framesRef[base]?.time}|${geoKey}`);
        const B = this.stitches.get(`${framesRef[base + 1]?.time}|${geoKey}`);
        const flow = (framesRef[base] && framesRef[base + 1])
            ? (this.flows.get(`${framesRef[base].time}|${framesRef[base + 1].time}|${geoKey}`) || { vx: 0, vy: 0 })
            : { vx: 0, vy: 0 };

        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Constant-intensity dissolve (see charts in git history): with the
        // top layer at p, bottom at (A-p)/(1-p), overlapping echo intensity
        // stays flat for the entire fade.
        const top = INTERNAL_A * frac;
        const bottom = (INTERNAL_A - top) / (1 - top);

        // Motion compensation: features travel A -> B along `flow`; at
        // fraction t, A is shifted forward t*v and B back (1-t)*v so both
        // copies of the same echo coincide mid-blend.
        if (A) {
            ctx.globalAlpha = bottom;
            ctx.drawImage(A, flow.vx * frac, flow.vy * frac);
        }
        if (B && frac > 0) {
            ctx.globalAlpha = top;
            ctx.drawImage(B, -flow.vx * (1 - frac), -flow.vy * (1 - frac));
        }
        ctx.globalAlpha = 1;
    }
}

/**
 * Fallback: one raster layer per frame, constant-intensity opacity
 * dissolve. No motion compensation, but works without pixel access.
 */
class LayerRenderer {
    constructor(mapInstance) {
        this.map = mapInstance;
        this.loaded = new Set();
    }

    async setFrames(newFrames) {
        const layerId = f => `radar-${f.time}`;
        const wanted = new Set(newFrames.map(layerId));
        for (const id of [...this.loaded]) {
            if (!wanted.has(id)) {
                if (this.map.getLayer(id)) this.map.removeLayer(id);
                if (this.map.getSource(id)) this.map.removeSource(id);
                this.loaded.delete(id);
            }
        }
        const labelLayer = this.map.getStyle().layers.find(l =>
            l.type === 'symbol' && (l.id.includes('label') || l.id.includes('place')));
        for (const frame of newFrames) {
            const id = layerId(frame);
            if (this.loaded.has(id)) continue;
            this.map.addSource(id, {
                type: 'raster',
                tiles: [tileUrl(frame, 512)],
                tileSize: 256,
                attribution: 'Radar &copy; <a href="https://librewxr.net/">LibreWXR</a> (CC-BY-4.0)'
            });
            this.map.addLayer({
                id, type: 'raster', source: id,
                paint: {
                    'raster-opacity': 0,
                    'raster-opacity-transition': { duration: 0 },
                    'raster-fade-duration': 0
                }
            }, labelLayer ? labelLayer.id : undefined);
            this.loaded.add(id);
        }
    }

    setPosition(pos, framesRef) {
        const base = Math.floor(pos);
        const frac = pos - base;
        const top = RADAR_OPACITY * frac;
        const bottom = (RADAR_OPACITY - top) / (1 - top);
        for (let i = 0; i < framesRef.length; i++) {
            const id = `radar-${framesRef[i].time}`;
            if (!this.map.getLayer(id)) continue;
            let opacity = 0;
            if (i === base) opacity = bottom;
            else if (i === base + 1) opacity = top;
            this.map.setPaintProperty(id, 'raster-opacity', opacity);
        }
    }
}

// ============ Animation ============
function setPosition(pos) {
    if (!frames.length || !renderer) return;
    position = Math.max(0, Math.min(pos, frames.length - 1));
    renderer.setPosition(position, frames);
    els.scrubber.value = String(position);

    const nearest = Math.round(position);
    if (nearest !== labeledFrame) {
        labeledFrame = nearest;
        updateFrameLabel(nearest);
    }
}

function updateFrameLabel(index) {
    const frame = frames[index];
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

function playSpeed() {
    return PLAY_SPEED_BASE * SPEED_STEPS[speedIdx];
}

function tick(ts) {
    if (!playing) return;
    if (lastTick === null) lastTick = ts;
    const dt = (ts - lastTick) / 1000;
    lastTick = ts;

    if (ts >= holdUntil) {
        let next = position + dt * playSpeed();
        if (next >= frames.length - 1) {
            if (position >= frames.length - 1) {
                next = 0;
            } else {
                next = frames.length - 1;
                holdUntil = ts + LAST_FRAME_HOLD_MS;
            }
        }
        setPosition(next);
    }
    rafId = requestAnimationFrame(tick);
}

function play() {
    if (playing || frames.length === 0) return;
    playing = true;
    lastTick = null;
    holdUntil = 0;
    els.playBtn.textContent = '❚❚';
    els.playBtn.setAttribute('aria-label', 'Pause animation');
    rafId = requestAnimationFrame(tick);
}

function pause() {
    playing = false;
    cancelAnimationFrame(rafId);
    els.playBtn.textContent = '▶';
    els.playBtn.setAttribute('aria-label', 'Play animation');
}

// ============ Data refresh ============
async function refreshFrames({ initial = false } = {}) {
    try {
        const newFrames = await fetchFrames();
        if (!newFrames.length) throw new Error('No radar frames available');

        const latestPastIdx = (() => {
            const idx = newFrames.map(f => f.nowcast).indexOf(true);
            return idx === -1 ? newFrames.length - 1 : idx - 1;
        })();

        const prevTime = frames[Math.round(position)]?.time;
        frames = newFrames;
        els.scrubber.max = String(frames.length - 1);
        labeledFrame = -1;

        try {
            await renderer.setFrames(frames);
        } catch (err) {
            // Morph renderer failed (CORS/canvas) - fall back to layers
            if (renderer instanceof MorphRenderer) {
                console.warn('[RADAR] Morph renderer failed, falling back to layers:', err);
                renderer = new LayerRenderer(map);
                await renderer.setFrames(frames);
            } else {
                throw err;
            }
        }

        if (initial) {
            setPosition(latestPastIdx);
        } else {
            const keep = frames.findIndex(f => f.time >= (prevTime || 0));
            setPosition(keep === -1 ? latestPastIdx : keep);
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

// ============ Init ============
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
        fadeDuration: 0,
        attributionControl: { compact: true }
    });

    renderer = new MorphRenderer(map);

    // Remember where the user left the map
    map.on('moveend', () => {
        const c = map.getCenter();
        localStorage.setItem(POSITION_KEY, JSON.stringify({
            center: [c.lng, c.lat], zoom: map.getZoom()
        }));
    });

    // Re-stitch for the new view after pan/zoom settles (only actually
    // refetches when the tile footprint changed - margin absorbs small pans)
    let moveTimer;
    map.on('moveend', () => {
        clearTimeout(moveTimer);
        moveTimer = setTimeout(async () => {
            if (!(renderer instanceof MorphRenderer) || !frames.length) return;
            const geo = renderer.computeGeometry();
            if (geo.key !== renderer.geo?.key) {
                await renderer.setFrames(frames);
                setPosition(position);
            }
        }, 350);
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: false },
        trackUserLocation: false
    }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');

    map.on('load', async () => {
        await refreshFrames({ initial: true });
        play();
        setInterval(() => refreshFrames(), REFRESH_MS);
    });

    els.playBtn.addEventListener('click', () => playing ? pause() : play());

    els.speedBtn.textContent = `${SPEED_STEPS[speedIdx]}×`;
    els.speedBtn.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % SPEED_STEPS.length;
        localStorage.setItem(SPEED_KEY, String(SPEED_STEPS[speedIdx]));
        els.speedBtn.textContent = `${SPEED_STEPS[speedIdx]}×`;
    });

    els.scrubber.addEventListener('input', (e) => {
        pause();
        setPosition(Number(e.target.value));
    });

    // Pause the animation while the tab is hidden to save battery
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) pause();
    });
}

document.addEventListener('DOMContentLoaded', init);
