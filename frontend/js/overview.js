/**
 * Weather overview: saved places (plus the device location) as cards, and a
 * page per place: observed conditions, the next 48 hours, daily summaries
 * and detail tiles (wind, humidity, sun, moon, feels-like, precipitation),
 * over a living sky (sky.js). Data: /api/forecast (RTMA now + RRFS hourly),
 * /api/geocode, /api/radar/alerts. Routes: #  (places)  and  #p=<id>.
 */

import { store } from './config.js?v=__V__';
import { applySiteSettings } from './site.js?v=__V__';
import {
    hourlyRows, dailyRows, condition, nowcast, sunAltitude, sunPosition, sunTimes, moonPhase, nextMoon,
    moonPath, humidity, feelsLike, comfort, moments, compass, tempColor, monotonePath, dayKey,
} from './forecast.js?v=__V__';
import { setScene } from './sky.js?v=__V__';

const PLACES_KEY = 'wx-places';
const HERE_KEY = 'wx-here';            // last device position {lat, lon, name}
const GPS_KEY = 'wx-gps';              // '1' once the user turned on "my location"
const DEFAULT_PLACES = [{ id: 'nyc', name: 'New York, NY', lat: 40.7128, lon: -74.006 }];
const POLL_MS = 4000;                  // a new region's hourly series is cut in ~7 s
const POLL_TRIES = 10;
const HOURS_SHOWN = 48;
const NS = 'http://www.w3.org/2000/svg';

const view = document.getElementById('view');
const sky = document.getElementById('sky');
const header = document.getElementById('header');
const headerTitle = document.getElementById('headerTitle');
const backBtn = document.getElementById('backBtn');
const dialog = document.getElementById('searchDialog');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

const readJson = (key, fallback) => { try { return JSON.parse(store.get(key)) ?? fallback; } catch { return fallback; } };
let places = readJson(PLACES_KEY, DEFAULT_PLACES);
let here = readJson(HERE_KEY, null);
const savePlaces = () => store.set(PLACES_KEY, JSON.stringify(places));

const forecasts = new Map();   // place id -> Promise<forecast>

// ============ Small DOM helpers ============

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};
const svgEl = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent?.appendChild(e);
    return e;
};
const icon = (key, cls = '') => {
    const s = svgEl('svg', { class: `ic ic-${key} ${cls}`, 'aria-hidden': 'true' });
    svgEl('use', { href: `#i-${key}` }, s);
    return s;
};
const deg = v => (v == null ? '--' : `${Math.round(v)}°`);
const timeOf = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const hourOf = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric' }).replace(' ', '');
const weekday = ms => (dayKey(ms) === dayKey(Date.now()) ? 'Today' : new Date(ms).toLocaleDateString('en-US', { weekday: 'short' }));
const radarLink = (place, layer, t) =>
    `/radar?layer=${layer}${t ? `&t=${Math.round(t / 1000)}` : ''}#8.5/${place.lat.toFixed(4)}/${place.lon.toFixed(4)}`;
// A place's id as a CSS ident, for the card-to-hero view transition
const vtName = id => `t${[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`;

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
    const sun = sunPosition(now, place.lat, place.lon);
    const night = sun.alt < -0.8;
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
    const temp = obs.tmp ?? cur?.tmp;
    const dpt = obs.dpt ?? cur?.dpt;
    const wind = obs.wind?.mph ?? cur?.wind ?? 0;
    return {
        raw: d, rows, upcoming, night, sun, obs: d.now, days, nowRow,
        cond: nowRow ? condition(nowRow, night) : { key: night ? 'clear-night' : 'clear', label: '' },
        temp, dpt, wind,
        feels: temp != null && dpt != null ? feelsLike(temp, dpt, wind) : null,
        line: nowcast(rows, now),
        moments: moments(upcoming, now),
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
    clear: ['#2c6fd4', '#86bcef'], partly: ['#3868b4', '#94b6db'], cloudy: ['#4d5b70', '#8a98ab'],
    rain: ['#243246', '#4c5d73'], snow: ['#4f617a', '#90a3ba'], storm: ['#1b2130', '#453a5c'],
    'clear-night': ['#050b20', '#18264e'], 'partly-night': ['#0a1230', '#28345a'],
};
const skyColors = (key, night) => {
    const [a, b] = SKIES[key] || SKIES.cloudy;
    const dim = night && !key.endsWith('night');
    return dim ? [`color-mix(in srgb, ${a} 42%, #04060e)`, `color-mix(in srgb, ${b} 42%, #04060e)`] : [a, b];
};

function showSky(f) {
    const [a, b] = skyColors(f.cond.key, f.night);
    sky.style.setProperty('--sky-a', a);
    sky.style.setProperty('--sky-b', b);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', a);
    const r = f.nowRow || {};
    setScene({
        cloud: r.cloud ?? 30, wind: f.wind, precip: r.qpf >= 0.01 || r.dbz >= 20 ? Math.max(r.qpf, 0.02) : 0,
        snowy: !!r.snowy, storm: f.cond.key === 'storm', sunAlt: f.sun.alt, sunAz: f.sun.az, moon: moonPhase(Date.now()),
    });
}

// ============ Navigation ============

// Same-document view transitions where supported: a card's temperature
// morphs into the place page's large one
function navigate(hash) {
    const go = () => { history.pushState(null, '', hash || location.pathname); route(); };
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.startViewTransition(go);
    } else go();
}
document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.button) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
});
// Back/forward and a typed #hash both arrive as popstate
window.addEventListener('popstate', route);

// Header: transparent over the hero, glass once the page scrolls; on a
// place page it takes the place's name and temperature when the hero is gone
window.addEventListener('scroll', () => header.classList.toggle('scrolled', scrollY > 8), { passive: true });
let heroObserver = null;
function watchHero(hero, title) {
    heroObserver?.disconnect();
    headerTitle.textContent = title;
    header.classList.remove('show-title');
    heroObserver = new IntersectionObserver(([e]) => header.classList.toggle('show-title', !e.isIntersecting),
        { rootMargin: '-64px 0px 0px 0px' });
    heroObserver.observe(hero);
}

// ============ Places (home) ============

let renderSeq = 0;

function renderHome() {
    renderSeq++;   // a place page still loading must not draw over home
    heroObserver?.disconnect();
    header.classList.remove('show-title');
    backBtn.hidden = true;
    view.replaceChildren();
    const intro = el('div', 'home-intro');
    intro.append(el('div', 'home-date', new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })),
        el('h1', 'home-title', 'Your places'));
    view.append(intro);
    const list = el('section', 'places');
    const ps = allPlaces();
    ps.forEach((place, i) => list.append(placeCard(place, i === 0)));
    if (store.get(GPS_KEY) !== '1' && navigator.geolocation) {
        const b = el('button', 'glass place-add');
        b.append(icon('locate', 'ic-sm'), el('span', null, 'Use my location'));
        b.addEventListener('click', () => locate(true));
        list.append(b);
    }
    const add = el('button', 'glass place-add');
    add.append(icon('plus', 'ic-sm'), el('span', null, 'Add a place'));
    add.addEventListener('click', openSearch);
    list.append(add);
    view.append(list);
    if (!ps.length) {
        sky.style.setProperty('--sky-a', SKIES.cloudy[0]);
        sky.style.setProperty('--sky-b', SKIES.cloudy[1]);
    }
}

function placeCard(place, setsSky) {
    const a = el('a', 'glass place-card loading');
    a.href = `#p=${encodeURIComponent(place.id)}`;
    const name = el('div', 'pc-name', place.name);
    if (place.here) name.prepend(icon('locate', 'ic-xs'));
    const temp = el('div', 'pc-temp', '--');
    temp.style.viewTransitionName = vtName(place.id);
    const cond = el('div', 'pc-cond');
    const hilo = el('div', 'pc-hilo');
    const line = el('div', 'pc-line');
    const spark = el('div', 'pc-spark');
    const alertChip = el('div', 'pc-alert');
    alertChip.hidden = true;
    a.append(name, temp, cond, hilo, spark, line, alertChip);

    forecastFor(place).then(f => {
        a.classList.remove('loading');
        temp.textContent = deg(f.temp);
        cond.replaceChildren(icon(f.cond.key), el('span', null, f.cond.label));
        const today = f.days.find(d => d.key === dayKey(Date.now()));
        if (today) hilo.textContent = `H ${deg(today.hi)}  L ${deg(today.lo)}`;
        line.textContent = f.line;
        // The card carries its own sky
        const [ca, cb] = skyColors(f.cond.key, f.night);
        a.style.setProperty('--tint-a', ca);
        a.style.setProperty('--tint-b', cb);
        spark.append(sparkline(f.upcoming.slice(0, 13)));
        if (setsSky && a.isConnected) showSky(f);   // not after leaving home
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

// Next 12 hours as a small temperature curve with precipitation ticks
function sparkline(rows) {
    const W = 240, H = 34;
    const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'spark', 'aria-hidden': 'true' });
    if (rows.length < 2) return s;
    const t = rows.map(r => r.tmp);
    const lo = Math.min(...t), hi = Math.max(...t, lo + 4);
    const pts = rows.map((r, i) => [i / (rows.length - 1) * W, 4 + (1 - (r.tmp - lo) / (hi - lo)) * (H - 12)]);
    const defs = svgEl('defs', {}, s);
    const id = `sg${Math.random().toString(36).slice(2, 8)}`;
    const g = svgEl('linearGradient', { id, x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
    rows.forEach((r, i) => svgEl('stop', { offset: i / (rows.length - 1), 'stop-color': tempColor(r.tmp) }, g));
    svgEl('path', { d: monotonePath(pts), fill: 'none', stroke: `url(#${id})`, 'stroke-width': 2.2, 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }, s);
    rows.forEach((r, i) => {
        if (r.qpf < 0.01) return;
        const h = Math.min(r.qpf / 0.2, 1) * 8 + 1;
        svgEl('rect', { x: pts[i][0] - 2, y: H - 2 - h, width: 4, height: h, rx: 1, class: r.snowy ? 'bar-snow' : 'bar-rain' }, s);
    });
    return s;
}

// ============ One place ============

async function renderPlace(id) {
    const seq = ++renderSeq;
    const place = allPlaces().find(p => p.id === id);
    if (!place) { history.replaceState(null, '', location.pathname); renderHome(); return; }
    backBtn.hidden = false;
    view.replaceChildren();
    const hero = el('section', 'hero');
    const temp = el('div', 'hero-temp skeleton-text', '--');
    temp.style.viewTransitionName = vtName(place.id);
    hero.append(el('div', 'hero-name', place.name), temp);
    view.append(hero);
    watchHero(hero, place.name);

    let f;
    try {
        f = await forecastFor(place);
    } catch {
        if (seq === renderSeq) hero.append(el('div', 'hero-line', 'Forecast unavailable. Try again in a moment.'));
        return;
    }
    if (seq !== renderSeq) return;   // another render started meanwhile (navigation, refresh)
    showSky(f);
    hero.replaceChildren(...heroContent(place, f));
    headerTitle.textContent = `${place.name}  ${deg(f.temp)}`;
    view.append(...[hourlySection(place, f), dailySection(place, f), tiles(place, f), actions(place, f), sources(f)].filter(Boolean));
    alertsFor(place).then(al => { if (seq === renderSeq) al.forEach(a => hero.append(alertRow(a))); });
}

function heroContent(place, f) {
    const out = [el('div', 'hero-name', place.name)];
    const temp = el('div', 'hero-temp', deg(f.temp));
    temp.style.viewTransitionName = vtName(place.id);
    out.push(temp);
    const cond = el('div', 'hero-cond');
    cond.append(icon(f.cond.key), el('span', null, f.cond.label));
    out.push(cond);
    const today = f.days.find(d => d.key === dayKey(Date.now()));
    const bits = [];
    if (today) bits.push(`H ${deg(today.hi)}  L ${deg(today.lo)}`);
    if (f.feels != null && Math.abs(f.feels - f.temp) >= 2) bits.push(`Feels like ${deg(f.feels)}`);
    if (bits.length) out.push(el('div', 'hero-hilo', bits.join('   ')));
    if (f.line) out.push(el('div', 'hero-line', f.line));
    for (const m of f.moments) {
        const chip = el('div', 'hero-moment');
        chip.append(el('span', 'moment-name', m.name), el('span', null, `${m.label === m.name ? '' : `${m.label} `}${m.text}`));
        out.push(chip);
    }
    return out;
}

function alertRow(feature) {
    const p = feature.properties;
    const a = el('div', 'hero-alert');
    a.append(el('strong', null, (p.title || 'Weather alert').split(' issued ')[0]));
    if (p.expires) a.append(el('span', null, ` until ${new Date(Number(p.expires) * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`));
    return a;
}

// Next 48 hours: temperature curve colored by temperature, night shaded,
// precipitation bars, wind; each hour opens the radar page at that time
function hourlySection(place, f) {
    const rows = f.upcoming.slice(0, HOURS_SHOWN);
    if (rows.length < 2) return null;
    const sec = el('section', 'glass panel');
    sec.append(el('h2', 'panel-title', `Next ${rows.length} hours`));
    const scroller = el('div', 'hourly-scroll');
    const W = 56, H = 218, n = rows.length;
    const temps = rows.map(r => r.tmp);
    const tmin = Math.min(...temps), tmax = Math.max(...temps);
    const span = Math.max(tmax - tmin, 6);
    const yT = t => 128 - (t - tmin) / span * 58;        // curve band y 70..128
    const xAt = ms => (ms - rows[0].t) / 3600000 * W + W / 2;
    const QMAX = 0.25;                                     // in/hr for a full precip bar
    const svg = svgEl('svg', { width: n * W, height: H, class: 'hourly-svg' });

    // Night: shade from each sunset to the next sunrise
    const nights = svgEl('g', { class: 'nights' }, svg);
    for (let d = new Date(rows[0].t).setHours(12, 0, 0, 0) - 86400000; d < rows[n - 1].t + 86400000; d += 86400000) {
        const a = sunTimes(d, place.lat, place.lon).set, b = sunTimes(d + 86400000, place.lat, place.lon).rise;
        if (!a || !b) continue;
        const x0 = Math.max(0, xAt(a)), x1 = Math.min(n * W, xAt(b));
        if (x1 > x0) svgEl('rect', { x: x0, y: 0, width: x1 - x0, height: H, class: 'night' }, nights);
    }

    const defs = svgEl('defs', {}, svg);
    const grad = (id, alpha0, alpha1) => {
        const g = svgEl('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, y1: yT(tmax), x2: 0, y2: yT(tmin) }, defs);
        for (let k = 0; k <= 4; k++) {
            const t = tmax - (tmax - tmin) * k / 4;
            svgEl('stop', { offset: k / 4, 'stop-color': tempColor(t), 'stop-opacity': alpha0 + (alpha1 - alpha0) * k / 4 }, g);
        }
    };
    grad('tline', 1, 1);
    grad('tfill', 0.32, 0.04);

    const pts = rows.map((r, i) => [i * W + W / 2, yT(r.tmp)]);
    const path = monotonePath(pts);
    svgEl('path', { d: `${path}L${pts[n - 1][0]},140L${pts[0][0]},140Z`, fill: 'url(#tfill)' }, svg);
    svgEl('path', { d: path, fill: 'none', stroke: 'url(#tline)', 'stroke-width': 3, 'stroke-linecap': 'round' }, svg);

    rows.forEach((r, i) => {
        const x = i * W, cx = x + W / 2;
        const night = sunAltitude(r.t, place.lat, place.lon) < -0.8;
        const c = condition(r, night);
        const wet = r.qpf >= 0.01 || r.dbz >= 20;
        const link = svgEl('a', { href: radarLink(place, wet ? 'radar' : 'temp', r.t) }, svg);
        svgEl('rect', { x, y: 0, width: W, height: H, fill: 'transparent', class: 'hour-hit' }, link);
        const newDay = i > 0 && dayKey(r.t) !== dayKey(rows[i - 1].t);
        if (newDay) svgEl('line', { x1: x, x2: x, y1: 6, y2: H - 6, class: 'day-rule' }, link);
        svgEl('text', { x: cx, y: 17, class: 'h-time' }, link).textContent = i === 0 ? 'Now' : newDay ? weekday(r.t) : hourOf(r.t);
        svgEl('use', { href: `#i-${c.key}`, x: cx - 11, y: 26, width: 22, height: 22, class: `ic ic-${c.key}` }, link);
        svgEl('text', { x: cx, y: yT(r.tmp) - 10, class: 'h-temp' }, link).textContent = deg(r.tmp);
        // Precip bar: liquid equivalent; blue for rain, white for snow
        if (r.qpf >= 0.005) {
            const h = Math.max(3, Math.min(r.qpf / QMAX, 1) * 38);
            svgEl('rect', { x: cx - 9, y: 184 - h, width: 18, height: h, rx: 3, class: r.snowy ? 'bar-snow' : 'bar-rain' }, link);
            svgEl('text', { x: cx, y: 145, class: 'h-amt' }, link).textContent = r.qpf >= 0.1 ? r.qpf.toFixed(1) : r.qpf.toFixed(2).slice(1);
        }
        svgEl('line', { x1: x + 8, x2: x + W - 8, y1: 184.5, y2: 184.5, class: 'bar-base' }, link);
        // Wind: arrow points where the air is going
        if (r.wind != null) {
            const g = svgEl('g', { transform: `translate(${cx - 13} 196) rotate(${r.dir} 6 7)` }, link);
            svgEl('use', { href: '#i-arrow', width: 12, height: 14, class: 'h-arrow' }, g);
            svgEl('text', { x: cx + 7, y: 208, class: 'h-wind' }, link).textContent = Math.round(r.wind);
        }
    });
    scroller.append(svg);
    dragScroll(scroller);
    sec.append(scroller);
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
    return sec;
}

// ============ Detail tiles ============

function tile(title, cls) {
    const t = el('section', `glass tile ${cls || ''}`);
    t.append(el('h3', 'tile-title', title));
    return t;
}

function tiles(place, f) {
    const grid = el('div', 'tiles');
    grid.append(windTile(f), humidityTile(f), sunTile(place), moonTile(), feelsTile(f), precipTile(f));
    return grid;
}

function windTile(f) {
    const t = tile('Wind', 'tile-wind');
    const dir = f.obs?.wind?.from ?? f.upcoming[0]?.dir ?? 0;
    const gust = f.obs?.gust ?? f.upcoming[0]?.gust;
    const s = svgEl('svg', { viewBox: '0 0 120 120', class: 'compass', 'aria-hidden': 'true' });
    svgEl('circle', { cx: 60, cy: 60, r: 52, class: 'dial' }, s);
    for (let a = 0; a < 360; a += 15) {
        const major = a % 90 === 0;
        const r0 = major ? 44 : 48, rad = a * Math.PI / 180;
        svgEl('line', { x1: 60 + r0 * Math.sin(rad), y1: 60 - r0 * Math.cos(rad), x2: 60 + 52 * Math.sin(rad), y2: 60 - 52 * Math.cos(rad), class: major ? 'tick tick-major' : 'tick' }, s);
    }
    [['N', 60, 30], ['E', 91, 64], ['S', 60, 98], ['W', 29, 64]].forEach(([l, x, y]) => {
        svgEl('text', { x, y, class: 'cardinal' }, s).textContent = l;
    });
    // Arrow from the upwind edge toward where the air goes
    const g = svgEl('g', { transform: `rotate(${dir} 60 60)` }, s);
    svgEl('path', { d: 'M60 12 L60 106 M53 97 L60 107 L67 97', class: 'wind-arrow' }, g);
    svgEl('circle', { cx: 60, cy: 60, r: 21, class: 'hub' }, s);
    svgEl('text', { x: 60, y: 62, class: 'hub-speed' }, s).textContent = Math.round(f.wind);
    svgEl('text', { x: 60, y: 74, class: 'hub-unit' }, s).textContent = 'mph';
    t.append(s, el('div', 'tile-note', `From the ${compass(dir)}${gust != null ? `, gusts ${Math.round(gust)}` : ''}`));
    return t;
}

function humidityTile(f) {
    const t = tile('Humidity');
    if (f.temp == null || f.dpt == null) return t;
    const rh = humidity(f.temp, f.dpt);
    t.append(el('div', 'tile-value', `${Math.round(rh)}%`), el('div', 'tile-sub', comfort(f.dpt)),
        el('div', 'tile-note', `Dew point ${deg(f.dpt)}`));
    const bar = el('div', 'meter');
    const fill = el('i');
    fill.style.width = `${Math.round(rh)}%`;
    bar.append(fill);
    t.append(bar);
    return t;
}

function sunTile(place) {
    const t = tile('Sun');
    const now = Date.now();
    const { rise, set } = sunTimes(now, place.lat, place.lon);
    if (!rise || !set) return t;
    const s = svgEl('svg', { viewBox: '0 0 160 70', class: 'sun-arc', 'aria-hidden': 'true' });
    svgEl('path', { d: 'M8 62 Q80 -18 152 62', class: 'arc' }, s);
    svgEl('line', { x1: 0, x2: 160, y1: 62, y2: 62, class: 'horizon' }, s);
    const frac = (now - rise) / (set - rise);
    if (frac > 0 && frac < 1) {
        // Point on the quadratic curve at frac, and the traveled part of it (de Casteljau split)
        const x = (1 - frac) ** 2 * 8 + 2 * (1 - frac) * frac * 80 + frac ** 2 * 152;
        const y = (1 - frac) ** 2 * 62 + 2 * (1 - frac) * frac * -18 + frac ** 2 * 62;
        svgEl('path', { d: `M8 62 Q${8 + (80 - 8) * frac} ${62 + (-18 - 62) * frac} ${x} ${y}`, class: 'arc-done' }, s);
        svgEl('circle', { cx: x, cy: y, r: 6, class: 'sun-dot' }, s);
    }
    const len = set - rise;
    const times = el('div', 'sun-times');
    times.append(el('span', null, `Rise ${timeOf(rise)}`), el('span', null, `Set ${timeOf(set)}`));
    t.append(s, times,
        el('div', 'tile-note', `${Math.floor(len / 3600000)}h ${Math.round(len % 3600000 / 60000)}m of daylight`));
    return t;
}

function moonTile() {
    const t = tile('Moon');
    const now = Date.now();
    const m = moonPhase(now);
    const s = svgEl('svg', { viewBox: '0 0 80 80', class: 'moon', 'aria-hidden': 'true' });
    svgEl('circle', { cx: 40, cy: 40, r: 30, class: 'moon-dark' }, s);
    svgEl('path', { d: moonPath(40, 40, 30, m.phase), class: 'moon-lit' }, s);
    const full = nextMoon(now, 0.5);
    const next = full - now < 86400000 ? nextMoon(now + 2 * 86400000, 0.5) : full;
    t.append(s, el('div', 'tile-sub', m.name), el('div', 'tile-note',
        `${Math.round(m.illum * 100)}% lit · full ${new Date(next).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`));
    return t;
}

function feelsTile(f) {
    const t = tile('Feels like');
    if (f.feels == null) return t;
    const diff = Math.round(f.feels - f.temp);
    const why = diff <= -2 ? 'The wind makes it feel colder.' : diff >= 2 ? 'Humidity makes it feel warmer.' : 'Close to the actual temperature.';
    t.append(el('div', 'tile-value', deg(f.feels)), el('div', 'tile-note', why));
    return t;
}

function precipTile(f) {
    const t = tile('Precipitation');
    const sum = (h, k) => f.upcoming.slice(0, h).reduce((a, r) => a + (r[k] || 0), 0);
    const q24 = sum(24, 'qpf'), q48 = sum(48, 'qpf'), s48 = sum(48, 'snow');
    t.append(el('div', 'tile-value', `${q24.toFixed(2)}"`), el('div', 'tile-sub', 'next 24 hours'),
        el('div', 'tile-note', `${q48.toFixed(2)}" over 48 hours${s48 >= 0.1 ? `, ${s48.toFixed(1)}" snow` : ''}`));
    return t;
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
    if (st) sec.append(link(`Ensemble plumes (${st.id})`, `/?station=${encodeURIComponent(st.id)}`));
    if (!place.here) {
        const rn = el('button', 'glass action action-quiet', 'Rename');
        rn.addEventListener('click', () => {
            const name = prompt('Name this place', place.name)?.trim();
            if (!name) return;
            place.name = name.slice(0, 60);
            savePlaces();
            route();
        });
        const rm = el('button', 'glass action action-quiet', 'Remove');
        rm.addEventListener('click', () => {
            places = places.filter(p => p.id !== place.id);
            savePlaces();
            navigate('');
        });
        sec.append(rn, rm);
    }
    return sec;
}

function sources(f) {
    const src = [];
    if (f.obs) src.push(`Observed ${timeOf(f.obs.time * 1000)} (NOAA RTMA, 2.5 km)`);
    if (f.raw.hourly) src.push(`Forecast RRFS ${f.raw.hourly.run.slice(8)}Z (3 km)`);
    return el('footer', 'sources', src.join('  ·  '));
}

// ============ Location and search ============

function locate(prompted) {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        let name = here?.name || 'My location';
        try {
            const r = await fetch(`/api/geocode?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
            if (r.ok) name = (await r.json()).name || name;
        } catch { /* keep the old name */ }
        const moved = !here || Math.abs(here.lat - lat) > 0.01 || Math.abs(here.lon - lon) > 0.01;
        here = { lat, lon, name };
        store.set(HERE_KEY, JSON.stringify(here));
        store.set(GPS_KEY, '1');
        if (moved) forecasts.delete('here');
        if (prompted && dialog.open) dialog.close();
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

function resultRow(iconKey, title, detail, onClick) {
    const li = el('li');
    const b = el('button', 'wx-result');
    b.type = 'button';
    const text = el('span', 'wx-result-text');
    text.append(el('span', 'wx-result-name', title));
    if (detail) text.append(el('span', 'wx-result-detail', detail));
    b.append(icon(iconKey, 'ic-sm'), text);
    b.addEventListener('click', onClick);
    li.append(b);
    return li;
}

function renderSearchHome() {
    const rows = [];
    if (navigator.geolocation) rows.push(resultRow('locate', 'Current location', here ? here.name : 'Use this device\'s position', () => locate(true)));
    searchResults.replaceChildren(...rows);
}

async function search() {
    const q = searchInput.value.trim();
    const seq = ++searchSeq;
    if (q.length < 2) { renderSearchHome(); return; }
    let rows = [];
    try {
        const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        rows = r.ok ? await r.json() : [];
    } catch { /* offline: no results */ }
    if (seq !== searchSeq) return;
    searchResults.replaceChildren(...rows.map(p => resultRow(p.address ? 'pin' : 'city', p.name, p.detail, () => {
        const id = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
        if (!places.some(x => x.id === id)) places.push({ id, name: p.name, lat: p.lat, lon: p.lon });
        savePlaces();
        dialog.close();
        navigate(`#p=${encodeURIComponent(id)}`);
    })));
    if (!rows.length) searchResults.append(el('li', 'wx-empty', 'No places found. Try a town, ZIP code or street address.'));
}

function openSearch() {
    searchSeq++;   // drop any lookup still in flight from last time
    searchInput.value = '';
    renderSearchHome();
    dialog.showModal();
    searchInput.focus();
}

document.getElementById('searchBtn').addEventListener('click', openSearch);
document.getElementById('searchCancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
// Enter searches now instead of submitting (and closing) the dialog
dialog.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    clearTimeout(searchTimer);
    search();
});

// ============ Routing ============

function route() {
    const m = location.hash.match(/^#p=(.+)$/);
    if (m) renderPlace(decodeURIComponent(m[1]));
    else renderHome();
    window.scrollTo(0, 0);
}

// Coming back to the tab after a while: drop stale forecasts
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > 10 * 60000) { forecasts.clear(); route(); }
});

applySiteSettings();
route();
if (store.get(GPS_KEY) === '1') locate(false);
