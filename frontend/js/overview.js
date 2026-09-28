/**
 * Weather overview: saved places (plus the device location) as cards, and a
 * page per place with observed conditions, the next 48 hours and daily
 * summaries. Data: /api/forecast (RTMA now + RRFS hourly), /api/geocode,
 * /api/radar/alerts. Routes: #  (places)  and  #p=<id>  (one place).
 */

import { store } from './config.js?v=__V__';
import { applySiteSettings } from './site.js?v=__V__';
import { hourlyRows, dailyRows, condition, nowcast, sunAltitude, compass, tempColor, monotonePath, dayKey } from './forecast.js?v=__V__';

const PLACES_KEY = 'wx-places';
const HERE_KEY = 'wx-here';            // last device position {lat, lon, name}
const GPS_KEY = 'wx-gps';              // '1' once the user turned on "my location"
const DEFAULT_PLACES = [{ id: 'nyc', name: 'New York, NY', lat: 40.7128, lon: -74.006 }];
const POLL_MS = 4000;                  // a new region's hourly series is cut in ~7 s
const POLL_TRIES = 10;
const HOURS_SHOWN = 48;

const view = document.getElementById('view');
const sky = document.getElementById('sky');
const dialog = document.getElementById('searchDialog');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

const readJson = (key, fallback) => { try { return JSON.parse(store.get(key)) ?? fallback; } catch { return fallback; } };
let places = readJson(PLACES_KEY, DEFAULT_PLACES);
let here = readJson(HERE_KEY, null);
const savePlaces = () => store.set(PLACES_KEY, JSON.stringify(places));

const forecasts = new Map();   // place id -> Promise<forecast>

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};
const icon = (key, cls = '') => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `ic ic-${key} ${cls}`);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${key}`);
    svg.appendChild(use);
    return svg;
};
const deg = v => (v == null ? '--' : `${Math.round(v)}°`);
const timeOf = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const hourOf = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric' }).replace(' ', '');
const weekday = ms => (dayKey(ms) === dayKey(Date.now()) ? 'Today' : new Date(ms).toLocaleDateString('en-US', { weekday: 'short' }));
const radarLink = (place, layer, t) =>
    `/radar?layer=${layer}${t ? `&t=${Math.round(t / 1000)}` : ''}#8.5/${place.lat.toFixed(4)}/${place.lon.toFixed(4)}`;

function allPlaces() {
    return here && store.get(GPS_KEY) === '1' ? [{ id: 'here', here: true, ...here }, ...places] : places;
}

// ============ Data ============

async function fetchForecast(place) {
    for (let i = 0; i < POLL_TRIES; i++) {
        const res = await fetch(`/api/forecast?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        // Still building after every try (a new region while a run lands):
        // show the observations anyway
        if (!d.building || i === POLL_TRIES - 1) return shape(d, place);
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

// Rows from the model run's start; "now" is the first hour not yet over
function shape(d, place) {
    const rows = d.hourly ? hourlyRows(d.hourly) : [];
    const now = Date.now();
    const upcoming = rows.filter(r => r.t + 3600000 > now);
    const cur = upcoming[0];
    const night = sunAltitude(now, place.lat, place.lon) < -0.8;
    // Observed values where RTMA has them; the model hour fills the rest (precipitation)
    const obs = d.now || {};
    // Without a model hour (still building), the observed cloud cover alone sets the condition
    const nowRow = cur ? { ...cur, tmp: obs.tmp ?? cur.tmp, dpt: obs.dpt ?? cur.dpt, cloud: obs.cloud ?? cur.cloud }
        : obs.cloud != null ? { cloud: obs.cloud, qpf: 0, dbz: -30 } : null;
    // A run from last evening still holds hours of yesterday: days start today
    const today = new Date().setHours(0, 0, 0, 0);
    const days = dailyRows(rows.filter(r => r.t >= today));
    // Today's range includes what has actually been observed
    if (days[0]?.key === dayKey(now) && obs.tmp != null) {
        days[0].hi = Math.max(days[0].hi, obs.tmp);
        days[0].lo = Math.min(days[0].lo, obs.tmp);
    }
    return {
        raw: d, rows, upcoming, night, obs: d.now, days,
        cond: nowRow ? condition(nowRow, night) : { key: night ? 'clear-night' : 'clear', label: '' },
        temp: obs.tmp ?? cur?.tmp,
        line: nowcast(rows, now),
    };
}

function forecastFor(place) {
    if (!forecasts.has(place.id)) {
        forecasts.set(place.id, fetchForecast(place).then(f => {
            if (f.raw.building) forecasts.delete(place.id);   // observations only: ask again next time
            return f;
        }, err => { forecasts.delete(place.id); throw err; }));
    }
    return forecasts.get(place.id);
}

async function alertsFor(place) {
    try {
        const res = await fetch(`/api/radar/alerts?lat=${place.lat.toFixed(2)}&lon=${place.lon.toFixed(2)}&radius=50`);
        if (!res.ok) return [];
        const now = Date.now() / 1000;
        return ((await res.json()).features || []).filter(f =>
            f.geometry && (!f.properties?.expires || Number(f.properties.expires) > now) && contains(f.geometry, place));
    } catch {
        return [];
    }
}

// Point in (Multi)Polygon by ray casting; holes count as outside
function contains(geom, { lat, lon }) {
    const inRing = ring => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    };
    const inPoly = rings => inRing(rings[0]) && !rings.slice(1).some(inRing);
    if (geom.type === 'Polygon') return inPoly(geom.coordinates);
    if (geom.type === 'MultiPolygon') return geom.coordinates.some(inPoly);
    return false;
}

// ============ Sky ============

// Two-stop gradients per condition; night variants are deeper
const SKIES = {
    clear: ['#2c6fd4', '#7eb4ec'], partly: ['#3a6ab8', '#8fb2d9'], cloudy: ['#4f5d72', '#8795a8'],
    rain: ['#27364a', '#4f6076'], snow: ['#51637c', '#8ea0b6'], storm: ['#1e2434', '#433a58'],
    'clear-night': ['#070d24', '#1b2a55'], 'partly-night': ['#0c1330', '#2a3658'],
};
function setSky(key, night) {
    const [a, b] = SKIES[key] || SKIES.cloudy;
    const dim = night && !key.endsWith('night');
    sky.style.setProperty('--sky-a', dim ? `color-mix(in srgb, ${a} 45%, #05070f)` : a);
    sky.style.setProperty('--sky-b', dim ? `color-mix(in srgb, ${b} 45%, #05070f)` : b);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', a);
}

// ============ Places (home) ============

function renderHome() {
    renderSeq++;   // a place page still loading must not draw over home
    view.replaceChildren();
    const list = el('section', 'places');
    const ps = allPlaces();
    if (store.get(GPS_KEY) !== '1' && navigator.geolocation) {
        const b = el('button', 'glass place-card place-locate');
        b.append(icon('locate', 'ic-sm'), el('span', null, 'Use my location'));
        b.addEventListener('click', () => locate(true));
        list.append(b);
    }
    ps.forEach((place, i) => list.append(placeCard(place, i === 0)));
    view.append(list);
    if (!ps.length) setSky('cloudy', false);
}

function placeCard(place, setsSky) {
    const a = el('a', 'glass place-card');
    a.href = `#p=${encodeURIComponent(place.id)}`;
    const top = el('div', 'pc-top');
    const name = el('div', 'pc-name', place.name);
    if (place.here) name.prepend(icon('locate', 'ic-xs'));
    const temp = el('div', 'pc-temp', '--');
    top.append(name, temp);
    const cond = el('div', 'pc-cond');
    const hilo = el('div', 'pc-hilo');
    const line = el('div', 'pc-line');
    const alertChip = el('div', 'pc-alert');
    alertChip.hidden = true;
    a.append(top, cond, hilo, line, alertChip);
    a.classList.add('loading');

    forecastFor(place).then(f => {
        a.classList.remove('loading');
        temp.textContent = deg(f.temp);
        cond.replaceChildren(icon(f.cond.key), el('span', null, f.cond.label));
        const today = f.days.find(d => d.key === dayKey(Date.now()));
        if (today) hilo.textContent = `H ${deg(today.hi)}  L ${deg(today.lo)}`;
        line.textContent = f.line;
        if (setsSky && a.isConnected) setSky(f.cond.key, f.night);   // not after leaving home
    }).catch(() => {
        a.classList.remove('loading');
        line.textContent = 'Forecast unavailable';
    });
    alertsFor(place).then(al => {
        if (!al.length) return;
        alertChip.hidden = false;
        alertChip.textContent = al[0].properties.title?.split(' issued ')[0] || 'Weather alert';
    });
    return a;
}

// ============ One place ============

let renderSeq = 0;
async function renderPlace(id) {
    const seq = ++renderSeq;
    const place = allPlaces().find(p => p.id === id);
    if (!place) { location.hash = ''; return; }
    view.replaceChildren();
    const back = el('a', 'wx-back', 'Places');
    back.href = '#';
    const hero = el('section', 'hero');
    hero.append(el('div', 'hero-name', place.name), el('div', 'hero-temp skeleton-text', '--'));
    view.append(back, hero);

    let f;
    try {
        f = await forecastFor(place);
    } catch {
        hero.append(el('div', 'hero-line', 'Forecast unavailable. Try again in a moment.'));
        return;
    }
    if (seq !== renderSeq) return;   // another render started meanwhile (navigation, refresh)
    setSky(f.cond.key, f.night);
    hero.replaceChildren(...heroContent(place, f));
    view.append(...[hourlySection(place, f), dailySection(place, f), actions(place, f)].filter(Boolean));
    alertsFor(place).then(al => al.forEach(a => hero.append(alertRow(a))));
}

function heroContent(place, f) {
    const obs = f.obs;
    const out = [el('div', 'hero-name', place.name), el('div', 'hero-temp', deg(f.temp))];
    const cond = el('div', 'hero-cond');
    cond.append(icon(f.cond.key), el('span', null, f.cond.label));
    out.push(cond);
    const today = f.days.find(d => d.key === dayKey(Date.now()));
    if (today) out.push(el('div', 'hero-hilo', `H ${deg(today.hi)}   L ${deg(today.lo)}`));
    const stats = el('div', 'hero-stats');
    const stat = (label, value) => {
        const s = el('div', 'stat');
        s.append(el('span', 'stat-label', label), el('span', 'stat-value', value));
        stats.append(s);
    };
    if (obs) {
        stat('Dew point', deg(obs.dpt));
        if (obs.wind) {
            const calm = obs.wind.mph < 1;
            stat('Wind', calm ? 'Calm' : `${compass(obs.wind.from)} ${Math.round(obs.wind.mph)} mph`);
        }
        if (obs.gust != null) stat('Gusts', `${Math.round(obs.gust)} mph`);
        if (obs.cloud != null) stat('Clouds', `${Math.round(obs.cloud)}%`);
    }
    out.push(stats);
    if (f.line) out.push(el('div', 'hero-line', f.line));
    const src = [];
    if (obs) src.push(`Observed ${timeOf(obs.time * 1000)} (RTMA)`);
    if (f.raw.hourly) src.push(`Forecast RRFS ${f.raw.hourly.run.slice(8)}Z`);
    out.push(el('div', 'hero-src', src.join(' · ')));
    return out;
}

function alertRow(feature) {
    const p = feature.properties;
    const a = el('div', 'hero-alert');
    a.append(el('strong', null, (p.title || 'Weather alert').split(' issued ')[0]));
    if (p.expires) a.append(el('span', null, ` until ${new Date(Number(p.expires) * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`));
    return a;
}

// Next 48 hours: temperature curve colored by temperature, precip bars,
// wind; each hour opens the radar page at that time
function hourlySection(place, f) {
    const rows = f.upcoming.slice(0, HOURS_SHOWN);
    if (rows.length < 2) return null;
    const sec = el('section', 'glass panel');
    sec.append(el('h2', 'panel-title', 'Next 48 hours'));
    const scroller = el('div', 'hourly-scroll');
    const W = 56, H = 218, n = rows.length;
    const temps = rows.map(r => r.tmp);
    const tmin = Math.min(...temps), tmax = Math.max(...temps);
    const span = Math.max(tmax - tmin, 6);
    const yT = t => 128 - (t - tmin) / span * 58;        // curve band y 70..128
    const QMAX = 0.25;                                     // in/hr for a full precip bar
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', n * W);
    svg.setAttribute('height', H);
    svg.setAttribute('class', 'hourly-svg');
    const mk = (tag, attrs, parent = svg) => {
        const e = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        parent.appendChild(e);
        return e;
    };

    const defs = mk('defs', {});
    const grad = (id, alpha0, alpha1) => {
        const g = mk('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, y1: yT(tmax), x2: 0, y2: yT(tmin) }, defs);
        for (let k = 0; k <= 4; k++) {
            const t = tmax - (tmax - tmin) * k / 4;
            mk('stop', { offset: k / 4, 'stop-color': tempColor(t), 'stop-opacity': alpha0 + (alpha1 - alpha0) * k / 4 }, g);
        }
    };
    grad('tline', 1, 1);
    grad('tfill', 0.32, 0.04);

    const pts = rows.map((r, i) => [i * W + W / 2, yT(r.tmp)]);
    const path = monotonePath(pts);
    mk('path', { d: `${path}L${pts[n - 1][0]},140L${pts[0][0]},140Z`, fill: 'url(#tfill)' });
    mk('path', { d: path, fill: 'none', stroke: 'url(#tline)', 'stroke-width': 3, 'stroke-linecap': 'round' });

    rows.forEach((r, i) => {
        const x = i * W, cx = x + W / 2;
        const night = sunAltitude(r.t, place.lat, place.lon) < -0.8;
        const c = condition(r, night);
        const wet = r.qpf >= 0.01 || r.dbz >= 20;
        const link = mk('a', { href: radarLink(place, wet ? 'radar' : 'temp', r.t) });
        mk('rect', { x, y: 0, width: W, height: H, fill: 'transparent', class: 'hour-hit' }, link);
        const newDay = i > 0 && dayKey(r.t) !== dayKey(rows[i - 1].t);
        if (newDay) mk('line', { x1: x, x2: x, y1: 6, y2: H - 6, class: 'day-rule' }, link);
        const label = mk('text', { x: cx, y: 17, class: 'h-time' }, link);
        label.textContent = i === 0 ? 'Now' : newDay ? weekday(r.t) : hourOf(r.t);
        const ic = mk('use', { href: `#i-${c.key}`, x: cx - 11, y: 26, width: 22, height: 22, class: `ic ic-${c.key}` }, link);
        ic.setAttribute('aria-hidden', 'true');
        const tt = mk('text', { x: cx, y: yT(r.tmp) - 10, class: 'h-temp' }, link);
        tt.textContent = deg(r.tmp);
        // Precip bar: height by amount; blue for rain, white for snow
        const amt = r.qpf;   // liquid equivalent for snow too
        if (amt >= 0.005) {
            const h = Math.max(3, Math.min(amt / QMAX, 1) * 38);
            mk('rect', { x: cx - 9, y: 184 - h, width: 18, height: h, rx: 3, class: r.snowy ? 'bar-snow' : 'bar-rain' }, link);
            const at = mk('text', { x: cx, y: 145, class: 'h-amt' }, link);
            at.textContent = amt >= 0.1 ? amt.toFixed(1) : amt.toFixed(2).slice(1);
        }
        mk('line', { x1: x + 8, x2: x + W - 8, y1: 184.5, y2: 184.5, class: 'bar-base' }, link);
        // Wind: arrow points where the air is going
        if (r.wind != null) {
            const g = mk('g', { transform: `translate(${cx - 13} 196) rotate(${r.dir} 6 7)` }, link);
            mk('use', { href: '#i-arrow', width: 12, height: 14, class: 'h-arrow' }, g);
            const wt = mk('text', { x: cx + 7, y: 208, class: 'h-wind' }, link);
            wt.textContent = Math.round(r.wind);
        }
    });
    scroller.append(svg);
    dragScroll(scroller);
    sec.append(scroller);
    sec.append(el('div', 'panel-note', 'Precipitation bars in inches per hour. Tap an hour for the map.'));
    return sec;
}

// A mouse wheel scrolls vertically and a mouse cannot swipe: turn the wheel
// sideways over the strip (until it reaches an end) and let a mouse drag it.
// A drag must not end as a click on the hour under the pointer.
function dragScroll(box) {
    box.addEventListener('wheel', e => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;   // trackpads already scroll sideways
        const max = box.scrollWidth - box.clientWidth;
        const next = Math.min(max, Math.max(0, box.scrollLeft + e.deltaY));
        if (next === box.scrollLeft) return;   // at an end: let the page scroll
        e.preventDefault();
        box.scrollLeft = next;
    }, { passive: false });
    // Pointer capture keeps the drag on the strip even outside it, with no
    // window listeners to pile up across renders
    let start = null, moved = false;
    const end = () => { start = null; box.classList.remove('dragging'); };
    box.addEventListener('pointerdown', e => {
        moved = false;   // any new press (mouse, touch, pen) starts clean
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        start = { x: e.clientX, left: box.scrollLeft };
    });
    box.addEventListener('pointermove', e => {
        if (start && !(e.buttons & 1)) end();   // released outside before the drag captured
        if (!start) return;
        const dx = e.clientX - start.x;
        if (!moved && Math.abs(dx) > 4) {
            moved = true;
            box.setPointerCapture(e.pointerId);
            box.classList.add('dragging');
        }
        if (moved) box.scrollLeft = start.left - dx;
    });
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    box.addEventListener('keydown', () => { moved = false; });
    box.addEventListener('click', e => {
        if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    }, true);
}

// Daily rows with low-high bars on one shared scale (Apple Weather style)
function dailySection(place, f) {
    if (!f.days.length) return null;
    const sec = el('section', 'glass panel');
    sec.append(el('h2', 'panel-title', `Next ${f.days.length} days`));
    const lo = Math.min(...f.days.map(d => d.lo)), hi = Math.max(...f.days.map(d => d.hi));
    const pct = v => `${((v - lo) / Math.max(hi - lo, 1) * 100).toFixed(1)}%`;
    const list = el('div', 'days');
    for (const d of f.days) {
        const row = el('a', 'day');
        row.href = radarLink(place, d.qpf >= 0.05 ? 'precip' : 'temp', new Date(d.t).setHours(14, 0, 0, 0));
        const precip = el('span', 'day-precip');
        if (d.snow >= 0.1) precip.textContent = `${d.snow.toFixed(1)}" snow`;
        else if (d.qpf >= 0.01) precip.textContent = `${d.qpf.toFixed(2)}"`;
        const bar = el('span', 'day-bar');
        const fill = el('i');
        fill.style.left = pct(d.lo);
        fill.style.right = `calc(100% - ${pct(d.hi)})`;
        fill.style.background = `linear-gradient(90deg, ${tempColor(d.lo)}, ${tempColor(d.hi)})`;
        bar.append(fill);
        if (d.key === dayKey(Date.now()) && f.temp != null) {
            const dot = el('b');
            dot.style.left = pct(Math.min(Math.max(f.temp, d.lo), d.hi));
            bar.append(dot);
        }
        row.append(el('span', 'day-name', weekday(d.t)), icon(d.cond.key), precip,
            el('span', 'day-lo', deg(d.lo)), bar, el('span', 'day-hi', deg(d.hi)));
        list.append(row);
    }
    sec.append(list);
    sec.append(el('div', 'panel-note', 'Days from one RRFS run. The 10-day outlook arrives with the National Blend of Models.'));
    return sec;
}

function actions(place, f) {
    const sec = el('section', 'actions');
    const link = (text, href) => {
        const a = el('a', 'glass action', text);
        a.href = href;
        return a;
    };
    sec.append(link('Radar', radarLink(place, 'radar')));
    const st = f.raw.station;
    if (st) sec.append(link(`How sure is this? (${st.id}, ${st.km} km)`, `/?station=${encodeURIComponent(st.id)}`));
    if (!place.here) {
        const rm = el('button', 'glass action action-quiet', 'Remove place');
        rm.addEventListener('click', () => {
            places = places.filter(p => p.id !== place.id);
            savePlaces();
            location.hash = '';
        });
        sec.append(rm);
    }
    return sec;
}

// ============ Location and search ============

function locate(prompted) {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        let name = here?.name || 'My location';
        try {
            const r = await fetch(`/api/geocode?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
            if (r.ok) name = (await r.json()).name || name;
        } catch { /* keep the old name */ }
        const moved = !here || Math.abs(here.lat - lat) > 0.01 || Math.abs(here.lon - lon) > 0.01;
        here = { lat, lon, name };
        store.set(HERE_KEY, JSON.stringify(here));
        store.set(GPS_KEY, '1');
        if (moved) forecasts.delete('here');
        if (moved || prompted) route();
    }, err => {
        if (prompted) alert(err.code === 1 ? 'Location permission was denied.' : 'Could not get your location.');
    }, { maximumAge: 10 * 60000, timeout: 15000 });
}

let searchTimer = 0;
let searchSeq = 0;
searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, 450);   // the server allows one lookup a second
});

async function search() {
    const q = searchInput.value.trim();
    const seq = ++searchSeq;
    if (q.length < 2) { searchResults.replaceChildren(); return; }
    let rows = [];
    try {
        const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        rows = r.ok ? await r.json() : [];
    } catch { /* offline: no results */ }
    if (seq !== searchSeq) return;
    searchResults.replaceChildren(...rows.map(p => {
        const li = el('li');
        const b = el('button', 'wx-result');
        b.type = 'button';
        b.append(el('span', 'wx-result-name', p.name), el('span', 'wx-result-detail', p.detail));
        b.addEventListener('click', () => {
            const id = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
            if (!places.some(x => x.id === id)) places.push({ id, name: p.name, lat: p.lat, lon: p.lon });
            savePlaces();
            dialog.close();
            location.hash = `#p=${encodeURIComponent(id)}`;
        });
        li.append(b);
        return li;
    }));
    if (!rows.length) searchResults.append(el('li', 'wx-empty', 'No places found'));
}

// Enter searches now instead of submitting (and closing) the dialog; the
// form has no submit button, so Cancel closes it explicitly
document.getElementById('searchCancel').addEventListener('click', () => dialog.close());
dialog.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    clearTimeout(searchTimer);
    search();
});

document.getElementById('addBtn').addEventListener('click', () => {
    searchSeq++;   // drop any lookup still in flight from last time
    searchInput.value = '';
    searchResults.replaceChildren();
    dialog.showModal();
    searchInput.focus();
});

// ============ Routing ============

function route() {
    const m = location.hash.match(/^#p=(.+)$/);
    if (m) renderPlace(decodeURIComponent(m[1]));
    else renderHome();
    window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
// Coming back to the tab after a while: drop stale forecasts
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > 10 * 60000) { forecasts.clear(); route(); }
});

applySiteSettings();
route();
if (store.get(GPS_KEY) === '1') locate(false);
