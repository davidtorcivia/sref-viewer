/**
 * Weather overview: saved places (plus the device location) as cards, and a
 * page per place: observed conditions, the next 48 hours, daily summaries
 * and detail tiles (wind, humidity, sun, moon, feels-like, precipitation),
 * over a living sky (sky.js). Data: /api/forecast (RTMA now + RRFS hourly),
 * /api/geocode, /api/radar/alerts. Routes: #  (places)  and  #p=<id>.
 */

import { store, getLatestRunWithDate, previousCycle } from './config.js?v=__V__';
import { applySiteSettings } from './site.js?v=__V__';
import {
    hourlyRows, dailyRows, condition, nowcast, sunAltitude, sunPosition, sunTimes, moonPhase, nextMoon,
    moonPath, humidity, feelsLike, comfort, moments, compass, tempColor, monotonePath, dayKey, nbmDays,
    sunCross, solarNoon, moonTimes, nextPhases, uvIndex, uvCategory,
} from './forecast.js?v=__V__';
import { setScene } from './sky.js?v=__V__';
import * as U from './units.js?v=__V__';

const PLACES_KEY = 'wx-places';
const UNITS_KEY = 'wx-units';
const HERE_KEY = 'wx-here';            // last device position {lat, lon, name}
const GPS_KEY = 'wx-gps';              // '1' once the user turned on "my location"
const DEFAULT_PLACES = [{ id: 'nyc', name: 'New York, NY', lat: 40.7128, lon: -74.006 }];
const POLL_MS = 4000;                  // a new region's hourly series is cut in ~7 s
const POLL_TRIES = 10;
const HOURS_SHOWN = 48;
const ENSEMBLE_MAX_KM = 40;            // farther than this, the station's spread says little about the place
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
let units = U.parseUnits(store.get(UNITS_KEY));

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
// Formatting in the user's units (data stays °F, mph, inches)
const deg = v => U.deg(v, units);
const timeOf = ms => U.clock(ms, units);
const hourOf = ms => U.clock(ms, units, false);
const windStr = mph => U.wind(mph, units);
const rain = (inches, snow) => U.precip(inches, units, snow);
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
    // Today's range, shared by the hero, the card and the daily row: the RRFS
    // and NBM days and the observed temperature all fold in
    const nbmToday = d.daily?.find(x => x.date === new Date(now).toLocaleDateString('en-CA'));
    const rrfsToday = days.find(x => x.key === dayKey(now));
    const his = [rrfsToday?.hi, nbmToday?.hi, obs.tmp].filter(v => v != null);
    const los = [rrfsToday?.lo, nbmToday?.lo, obs.tmp].filter(v => v != null);
    return {
        raw: d, rows, upcoming, night, sun, obs: d.now, days, nowRow,
        cond: nowRow ? condition(nowRow, night) : { key: night ? 'clear-night' : 'clear', label: '' },
        temp, dpt, wind,
        feels: temp != null && dpt != null ? feelsLike(temp, dpt, wind) : null,
        today: his.length ? { hi: Math.max(...his), lo: Math.min(...los) } : null,
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

// REFS plume series at the nearest plume station: {RRFS: [{x, y}], Mean:
// [{x, y, p10, p25, p75, p90}] every 3 hours to 60 h}, or null
const refsCache = new Map();   // station|param -> Promise
function refsSeries(st, param, cycle = getLatestRunWithDate('refs')) {
    if (!st || st.km > ENSEMBLE_MAX_KM) return Promise.resolve(null);
    const { run, date } = cycle;
    const key = `${st.id}|${param}|${date}${run}`;
    if (!refsCache.has(key)) {
        refsCache.set(key, fetch(`/api/refs/${encodeURIComponent(st.id)}/${run}/${param}?date=${date}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => (d?.Mean?.some(m => m.p10 != null && m.p90 != null)
                ? { RRFS: d.RRFS || [], Mean: d.Mean.filter(m => m.p10 != null && m.p90 != null) } : null))
            .catch(() => null)
            .then(d => { if (!d) refsCache.delete(key); return d; }));
    }
    return refsCache.get(key);
}
const ensembleFor = f => refsSeries(f.raw.station, '3hrly-TMP').then(d => d?.Mean || null);

// Spread below and above the mean at time t, linear between the 3-hourly points
function spreadAt(ens, t) {
    const k = ens.findIndex(m => m.x >= t);
    if (k < 0 || (k === 0 && ens[0].x > t)) return null;
    const a = ens[Math.max(0, k - 1)], b = ens[k];
    const w = b.x === a.x ? 0 : (t - a.x) / (b.x - a.x);
    const lerp = key => a[key] + (b[key] - a[key]) * w;
    const y = lerp('y');
    return { lo90: y - lerp('p10'), hi90: lerp('p90') - y, lo75: y - lerp('p25'), hi75: lerp('p75') - y };
}

function confidence(ens, t) {
    const s = spreadAt(ens, t);
    if (!s) return null;
    const width = s.lo90 + s.hi90;
    return width <= 4 ? 'High confidence' : width <= 8 ? 'Moderate confidence' : 'Low confidence';
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
    clear: ['#1f5fc4', '#5e9ce0'], partly: ['#2c569c', '#6488b8'], cloudy: ['#343f52', '#5a6679'],
    rain: ['#1d2737', '#36445a'], snow: ['#3a4a63', '#63758e'], storm: ['#161b28', '#3a3150'],
    'clear-night': ['#050b20', '#18264e'], 'partly-night': ['#0a1230', '#28345a'],
};
const skyColors = (key, night) => {
    const [a, b] = SKIES[key] || SKIES.cloudy;
    const dim = night && !key.endsWith('night');
    return dim ? [`color-mix(in srgb, ${a} 42%, #04060e)`, `color-mix(in srgb, ${b} 42%, #04060e)`] : [a, b];
};

function showSky(f) {
    const [a, b] = skyColors(f.cond.key, f.night);
    document.documentElement.style.setProperty('--sky-a', a);
    document.documentElement.style.setProperty('--sky-b', b);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', a);
    const r = f.nowRow || {};
    setScene({
        cloud: r.cloud ?? 30, wind: f.wind, precip: r.qpf >= 0.01 || r.dbz >= 20 ? Math.max(r.qpf, 0.02) : 0,
        snowy: !!r.snowy, storm: f.cond.key === 'storm', sunAlt: f.sun.alt, sunAz: f.sun.az, moon: moonPhase(Date.now()),
    });
}

// ============ Navigation ============

// Same-document view transitions where supported: a card's temperature
// morphs into the place page's large one. Opening a place from home pushes
// an entry marked fromHome, so "back" (the header arrow or the system back)
// pops it instead of stacking another home entry; going home otherwise
// replaces the current entry.
function navigate(hash) {
    const home = !hash || hash === '#';
    const url = home ? location.pathname + location.search : hash;
    const go = () => {
        if (home && history.state?.fromHome) { history.back(); return; }   // popstate routes
        if (home) history.replaceState(null, '', url);
        else history.pushState({ fromHome: !location.hash.startsWith('#p=') }, '', url);
        route();
    };
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.startViewTransition(go);
    } else go();
}
document.addEventListener('click', e => {
    if (document.body.classList.contains('editing') && e.target.closest?.('.places a, [data-section] a')) {
        e.preventDefault();   // in edit mode, cards and links are for dragging
        return;
    }
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.button) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
});
// Back/forward and a typed #hash both arrive as popstate
window.addEventListener('popstate', () => route());

// Header: transparent at the top of the page; scrolling down it gets out of
// the way, scrolling up it comes back as a compact floating capsule. On a
// place page the capsule carries the place's name and temperature.
let lastScroll = 0;
window.addEventListener('scroll', () => {
    const y = scrollY, down = y > lastScroll;
    if (Math.abs(y - lastScroll) < 6 && y > 60) return;   // ignore jitter
    header.classList.toggle('floating', y > 60 && !down);
    header.classList.toggle('tucked', y > 60 && down);
    lastScroll = y;
}, { passive: true });
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
    view.classList.remove('place-view');
    heroObserver?.disconnect();
    header.classList.remove('show-title');
    backBtn.hidden = true;
    view.replaceChildren();
    const intro = el('div', 'home-intro');
    const titleRow = el('div', 'home-title-row');
    const editBtn = el('button', 'text-btn', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => setEditing(true));
    titleRow.append(el('h1', 'home-title', 'Your places'), editBtn);
    intro.append(el('div', 'home-date', new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })), titleRow);
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
    // Saved places reorder by drag in edit mode (the device location stays first)
    sortable(list, '.place-card:not([data-place="here"])', ids => {
        places = ids.map(id => places.find(p => p.id === id)).filter(Boolean);
        savePlaces();
    });
    if (!ps.length) {
        document.documentElement.style.setProperty('--sky-a', SKIES.cloudy[0]);
        document.documentElement.style.setProperty('--sky-b', SKIES.cloudy[1]);
    }
}

function placeCard(place, setsSky) {
    const a = el('a', 'glass place-card loading');
    a.href = `#p=${encodeURIComponent(place.id)}`;
    a.dataset.place = place.id;
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
        if (f.today) hilo.textContent = `H ${deg(f.today.hi)}  L ${deg(f.today.lo)}`;
        line.textContent = nowcast(f.rows, Date.now(), hourOf);
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
    view.classList.add('place-view');
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
    let hourly = hourlySection(place, f, null), daily = dailySection(place, f, null), ens = null;
    const sections = { hourly, radar: radarPanel(place), daily, plumes: plumePanel(f), tiles: tiles(place, f) };
    if (hourly) hourly.dataset.section = 'hourly';
    if (daily) daily.dataset.section = 'daily';
    view.append(...layout().sections.map(k => sections[k]).filter(Boolean), actions(place, f), sources(f));
    sortable(view, '[data-section]', keys => saveLayout('sections', keys));
    sortable(sections.tiles, '.tile', keys => saveLayout('tiles', keys));
    // A new region's 10-day rows are cut after its hourly series: ask again until they land
    if (f.raw.daily_building) {
        (async () => {
            for (let i = 0; i < 12 && seq === renderSeq; i++) {
                await new Promise(r => setTimeout(r, 5000));
                try {
                    const d = await (await fetch(`/api/forecast?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`)).json();
                    if (d.daily?.length && !d.daily_building) {
                        Object.assign(f.raw, { daily: d.daily, daily_run: d.daily_run, daily_building: false });
                        if (seq !== renderSeq) return;
                        const d2 = dailySection(place, f, ens);
                        if (d2) d2.dataset.section = 'daily';
                        if (daily && d2) { daily.replaceWith(d2); daily = d2; }
                        return;
                    }
                } catch { /* try again */ }
            }
        })();
    }
    alertsFor(place).then(al => { if (seq === renderSeq) al.forEach(a => hero.append(alertRow(a))); });
    // The ensemble arrives later: redraw the strip and days with its spread
    ensembleFor(f).then(e => {
        if (!e || seq !== renderSeq) return;
        ens = e;
        const keep = hourly?.querySelector('.hourly-scroll')?.scrollLeft || 0;
        const h2 = hourlySection(place, f, ens), d2 = dailySection(place, f, ens);
        if (h2) h2.dataset.section = 'hourly';
        if (d2) d2.dataset.section = 'daily';
        if (hourly && h2) { hourly.replaceWith(h2); h2.querySelector('.hourly-scroll').scrollLeft = keep; hourly = h2; }
        if (daily && d2) { daily.replaceWith(d2); daily = d2; }
    });
}

function heroContent(place, f) {
    const out = [el('div', 'hero-name', place.name)];
    const temp = el('div', 'hero-temp', deg(f.temp));
    temp.style.viewTransitionName = vtName(place.id);
    out.push(temp);
    const cond = el('div', 'hero-cond');
    cond.append(icon(f.cond.key), el('span', null, f.cond.label));
    out.push(cond);
    const bits = [];
    if (f.today) bits.push(`H ${deg(f.today.hi)}  L ${deg(f.today.lo)}`);
    if (f.feels != null && Math.abs(f.feels - f.temp) >= 2) bits.push(`Feels like ${deg(f.feels)}`);
    if (bits.length) out.push(el('div', 'hero-hilo', bits.join('   ')));
    const line = nowcast(f.rows, Date.now(), hourOf);
    if (line) out.push(el('div', 'hero-line', line));
    for (const m of moments(f.upcoming, Date.now(), 3, deg)) {
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
    if (p.expires) a.append(el('span', null, ` until ${weekday(Number(p.expires) * 1000)} ${timeOf(Number(p.expires) * 1000)}`));
    return a;
}

// Next 48 hours: temperature curve colored by temperature, night shaded,
// precipitation bars, wind; each hour opens the radar page at that time
function hourlySection(place, f, ens) {
    const rows = f.upcoming.slice(0, HOURS_SHOWN);
    if (rows.length < 2) return null;
    const sec = el('section', 'glass panel');
    const head = el('div', 'panel-head');
    head.append(el('h2', 'panel-title', `Next ${rows.length} hours`));
    const conf = ens && confidence(ens, rows[0].t + 24 * 3600000);
    if (conf) head.append(el('span', 'panel-chip', conf));
    sec.append(head);
    const scroller = el('div', 'hourly-scroll');
    const W = 56, H = 218, n = rows.length;
    // Ensemble spread placed around this place's curve: its width says how far
    // the forecast could swing (the station ensemble's own level can differ)
    const spreads = rows.map(r => (ens ? spreadAt(ens, r.t) : null));
    const temps = rows.flatMap((r, i) => (spreads[i] ? [r.tmp - spreads[i].lo90, r.tmp + spreads[i].hi90] : [r.tmp]));
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

    // Ensemble bands: 10-90% outer, 25-75% inner, over the hours the ensemble covers
    const covered = rows.map((r, i) => [r, spreads[i], i]).filter(([, s]) => s);
    if (covered.length > 1) {
        const band = (lo, hi, cls) => {
            const top = covered.map(([r, s, i]) => [i * W + W / 2, yT(r.tmp + s[hi])]);
            const bot = covered.map(([r, s, i]) => [i * W + W / 2, yT(r.tmp - s[lo])]).reverse();
            svgEl('path', { d: `${monotonePath(top)}L${bot.map(p => p.join(',')).join('L')}Z`, class: cls }, svg);
        };
        band('lo90', 'hi90', 'band-outer');
        band('lo75', 'hi75', 'band-inner');
    }

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
            svgEl('text', { x: cx, y: 145, class: 'h-amt' }, link).textContent = units.precip === 'mm'
                ? String(Math.max(1, Math.round(r.qpf * 25.4))) : r.qpf >= 0.1 ? r.qpf.toFixed(1) : r.qpf.toFixed(2).slice(1);
        }
        svgEl('line', { x1: x + 8, x2: x + W - 8, y1: 184.5, y2: 184.5, class: 'bar-base' }, link);
        // Wind: arrow points where the air is going
        if (r.wind != null) {
            const g = svgEl('g', { transform: `translate(${cx - 13} 196) rotate(${r.dir} 6 7)` }, link);
            svgEl('use', { href: '#i-arrow', width: 12, height: 14, class: 'h-arrow' }, g);
            svgEl('text', { x: cx + 7, y: 208, class: 'h-wind' }, link).textContent = Math.round(U.toWind(r.wind, units));
        }
    });
    scroller.append(svg);
    dragScroll(scroller);
    sec.append(scroller);
    if (covered.length > 1) {
        sec.append(el('div', 'panel-note', `Shaded: the range the REFS ensemble spans at ${f.raw.station.id} (10-90% and 25-75%)`));
    }
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

// Daily rows with low-high bars on one shared scale (Apple Weather style):
// the National Blend of Models' 10-11 days when available, else the RRFS
// run's days. Today folds in the observed temperature and the RRFS low.
function dailySection(place, f, ens) {
    const nbm = f.raw.daily?.length ? nbmDays(f.raw.daily) : null;
    const today = dayKey(Date.now());
    let days = (nbm || f.days).filter(d => d.t >= new Date().setHours(0, 0, 0, 0)).map(d => ({ ...d }));
    // An evening 00z NBM run starts tomorrow: today comes from the RRFS run
    const rrfsToday = f.days.find(d => d.key === today);
    if (days[0]?.key !== today && rrfsToday) days.unshift({ ...rrfsToday });
    if (days[0]?.key === today && f.today) Object.assign(days[0], f.today);
    days = days.filter(d => d.hi != null && d.lo != null);
    if (!days.length) return null;
    const sec = el('section', 'glass panel');
    const head = el('div', 'panel-head');
    head.append(el('h2', 'panel-title', nbm ? `${days.length}-day forecast` : `Next ${days.length} days`));
    if (nbm) head.append(el('span', 'panel-chip', 'National Blend'));
    sec.append(head);
    const lo = Math.min(...days.map(d => d.lo)), hi = Math.max(...days.map(d => d.hi));
    const pct = v => `${((v - lo) / Math.max(hi - lo, 1) * 100).toFixed(1)}%`;
    const list = el('div', 'days');
    for (const d of days) {
        const row = el('a', 'day');
        row.href = radarLink(place, d.qpf >= 0.05 ? 'precip' : 'temp', new Date(d.t).setHours(14, 0, 0, 0));
        const precip = el('span', 'day-precip');
        if (d.pop != null && d.pop >= 20) precip.append(el('b', null, `${Math.round(d.pop / 10) * 10}%`));
        if (d.snow >= 0.1) precip.append(el('span', null, `${rain(d.snow, true)} snow`));
        else if (d.qpf >= 0.05 || (d.pop == null && d.qpf >= 0.01)) precip.append(el('span', null, rain(d.qpf)));
        const bar = el('span', 'day-bar');
        const fill = el('i');
        fill.style.left = pct(d.lo);
        fill.style.right = `calc(100% - ${pct(d.hi)})`;
        fill.style.background = `linear-gradient(90deg, ${tempColor(d.lo)}, ${tempColor(d.hi)})`;
        bar.append(fill);
        if (d.key === today && f.temp != null) {
            const dot = el('b');
            dot.style.left = pct(Math.min(Math.max(f.temp, d.lo), d.hi));
            bar.append(dot);
        }
        const hiCell = el('span', 'day-hi', deg(d.hi));
        // Ensemble half-width over the day's hours, where the ensemble reaches
        const hrs = f.rows.filter(r => dayKey(r.t) === d.key).map(r => ens && spreadAt(ens, r.t)).filter(Boolean);
        if (hrs.length >= 6) hiCell.append(el('small', 'day-spread', `±${Math.round(U.toTempDelta(Math.max(...hrs.map(s => (s.lo90 + s.hi90) / 2)), units))}`));
        const name = el('span', 'day-name', weekday(d.t));
        name.append(el('small', 'day-date', new Date(d.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })));
        row.append(name, icon(d.cond.key), precip, el('span', 'day-lo', deg(d.lo)), bar, hiCell);
        list.append(row);
    }
    sec.append(list);
    return sec;
}

// ============ Ensemble plumes ============
// The plume page's REFS series drawn in place: 10-90% and 25-75% bands, the
// ensemble mean, the dashed deterministic RRFS run and the two previous
// runs' means (fainter the older), 60 hours. The pointer scrubs on a
// 30-minute grid, interpolating between the ensemble's 3-hourly points.
const PLUMES = [
    { key: 'temp', label: 'Temperature', param: '3hrly-TMP', conv: v => U.toTemp(v, units), fmt: v => `${Math.round(v)}°`,
        trend: ['Warmer', 'Cooler'], delta: d => `${Math.round(Math.abs(U.toTempDelta(d, units)))}°`, flat: 1 },
    { key: 'precip', label: 'Precipitation', param: 'Total-QPF', conv: v => (units.precip === 'mm' ? v * 25.4 : v),
        fmt: v => (units.precip === 'mm' ? `${Math.round(v)} mm` : `${v.toFixed(2)}"`), total: true,
        trend: ['Wetter', 'Drier'], delta: d => rain(Math.abs(d)), flat: 0.05 },
    { key: 'wind', label: 'Wind', param: '3h-10mWND', conv: kts => U.toWind(kts * 1.150779, units), fmt: v => `${Math.round(v)} ${U.windUnit(units)}`,
        trend: ['Windier', 'Calmer'], delta: d => windStr(Math.abs(d) * 1.150779), flat: 2 },
    { key: 'snow', label: 'Snow', param: 'Total-SNO', conv: v => (units.precip === 'mm' ? v * 2.54 : v),
        fmt: v => (units.precip === 'mm' ? `${v.toFixed(1)} cm` : `${v.toFixed(1)}"`), total: true,
        trend: ['Snowier', 'Less snowy'], delta: d => rain(Math.abs(d), true), flat: 0.3 },
];
const HALF_HOUR = 1800000;

// Linear value of a series' key at time t; null outside it
function interp(series, t, key = 'y') {
    const k = series.findIndex(p => p.x >= t);
    if (k < 0 || series[k][key] == null) return null;
    if (series[k].x === t || k === 0) return series[k].x === t ? series[k][key] : null;
    const a = series[k - 1], b = series[k];
    if (a[key] == null) return null;
    return a[key] + (b[key] - a[key]) * (t - a.x) / (b.x - a.x);
}

function plumePanel(f) {
    const st = f.raw.station;
    if (!st || st.km > ENSEMBLE_MAX_KM) return null;
    const sec = el('section', 'glass panel plume-panel');
    sec.dataset.section = 'plumes';
    const head = el('div', 'panel-head');
    head.append(el('h2', 'panel-title', 'Ensemble plumes'));
    const tabs = el('div', 'seg');
    head.append(tabs);
    const readout = el('div', 'plume-readout');
    const trend = el('div', 'plume-trend');
    const chart = el('div', 'plume-chart');
    const legend = el('div', 'plume-legend');
    const foot = el('div', 'panel-foot');
    const more = el('a', 'text-link', `Full plumes for ${st.id}`);
    more.href = `/?station=${encodeURIComponent(st.id)}`;
    foot.append(el('span', null, `REFS ensemble at ${st.id}, ${st.km} km away`), more);
    sec.append(head, readout, chart, legend, trend, foot);

    const latest = getLatestRunWithDate('refs');
    const cycles = [latest, previousCycle('refs', latest.date, latest.run, 1), previousCycle('refs', latest.date, latest.run, 2)];
    let active = -1;
    const show = async i => {
        active = i;
        [...tabs.children].forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
        const [d, ...prev] = await Promise.all(cycles.map(c => refsSeries(st, PLUMES[i].param, c)));
        if (active !== i || !sec.isConnected) return;
        chart.replaceChildren();
        trend.textContent = '';
        if (!d) { readout.textContent = 'Ensemble not available right now'; legend.replaceChildren(); return; }
        // A total counts from each run's own start: older runs rebased to this run's first point, to compare
        const since = p => {
            if (!PLUMES[i].total) return p.Mean;
            const at = interp(p.Mean, d.Mean[0].x);
            return at == null ? null : p.Mean.map(m => ({ ...m, y: m.y - at + d.Mean[0].y }));
        };
        const prevs = prev.map((p, k) => { const mean = p && since(p); return mean && { label: `${cycles[k + 1].run}Z`, mean }; }).filter(Boolean);
        drawPlume(chart, readout, d, PLUMES[i], prevs);
        legend.replaceChildren(...[['mean', `${latest.run}Z mean`], ['det', 'RRFS'], ...prevs.map((p, k) => [`prev prev${k}`, p.label])]
            .map(([cls, text]) => { const e = el('span', `key key-${cls.split(' ')[0]} ${cls}`); e.append(el('i'), el('span', null, text)); return e; }));
        // Trend: the mean against the previous run over the hours both cover
        if (prevs[0]) {
            const spec = PLUMES[i];
            const ts = d.Mean.map(m => m.x).filter(t => t >= Date.now() && interp(prevs[0].mean, t) != null);
            if (ts.length) {
                const diff = spec.total
                    ? d.Mean.find(m => m.x === ts[ts.length - 1]).y - interp(prevs[0].mean, ts[ts.length - 1])
                    : ts.reduce((a, t) => a + interp(d.Mean, t) - interp(prevs[0].mean, t), 0) / ts.length;
                trend.textContent = Math.abs(diff) < spec.flat ? `Little change from the ${prevs[0].label} run`
                    : `${spec.trend[diff > 0 ? 0 : 1]} than the ${prevs[0].label} run by ${spec.delta(diff)}`;
            }
        }
    };
    PLUMES.forEach((p, i) => {
        const b = el('button', 'seg-btn', p.label);
        b.type = 'button';
        b.addEventListener('click', () => show(i));
        tabs.append(b);
    });
    // Snow: shown when the ensemble or the RRFS run has any; opened first when a real snowfall is on the way
    const snowBtn = tabs.children[3];
    snowBtn.hidden = true;
    requestAnimationFrame(() => { if (active < 0) show(0); });   // unless snow already opened first
    // Redraw at the new width after a resize or rotation
    let lastW = 0, timer = 0;
    new ResizeObserver(([e]) => {
        const w = Math.round(e.contentRect.width);
        if (lastW && w !== lastW && active >= 0) { clearTimeout(timer); timer = setTimeout(() => show(active), 150); }
        lastW = w;
    }).observe(chart);
    refsSeries(st, 'Total-SNO').then(d => {
        if (!d || !sec.isConnected) return;
        const most = Math.max(...d.Mean.map(m => m.p90), ...d.RRFS.map(p => p.y ?? 0));
        if (most >= 0.1) snowBtn.hidden = false;
        if (Math.max(...d.Mean.map(m => m.y)) >= 1 && active <= 0) show(3);
    });
    return sec;
}

function drawPlume(box, readout, d, spec, prevs) {
    const cs = getComputedStyle(box);
    const W = Math.max(260, box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), H = 210, L = 44, R = 12, T = 12, B = 26;
    const now = Date.now();
    const mean = d.Mean.filter(m => m.x >= now - 3 * 3600000);
    if (mean.length < 2) { readout.textContent = 'Ensemble not available right now'; return; }
    const x0 = mean[0].x, x1 = mean[mean.length - 1].x;
    const det = d.RRFS.filter(p => p.x >= x0 - 3600000 && p.x <= x1 + 3600000 && p.y != null);
    const c = v => spec.conv(v);
    const vals = [...mean.flatMap(m => [c(m.p10), c(m.p90)]), ...det.map(p => c(p.y)),
        ...prevs.flatMap(p => p.mean.filter(m => m.x >= x0 && m.x <= x1).map(m => c(m.y)))];
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.12 || 1;
    hi += pad;
    lo = spec.total ? 0 : spec.key === 'wind' ? Math.max(0, lo - pad) : lo - pad;   // no negative wind
    const X = t => L + (t - x0) / (x1 - x0) * (W - L - R);
    const Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const s = svgEl('svg', { width: W, height: H, class: 'plume-svg', role: 'img', 'aria-label': `${spec.label} ensemble plume` });

    for (let k = 0; k <= 3; k++) {
        const v = lo + (hi - lo) * k / 3;
        svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'grid' }, s);
        svgEl('text', { x: L - 6, y: Y(v), class: 'axis axis-y', 'dominant-baseline': 'central' }, s).textContent = spec.fmt(v);
    }
    for (let t = new Date(x0).setHours(24, 0, 0, 0); t < x1; t += 86400000) {
        svgEl('line', { x1: X(t), x2: X(t), y1: T, y2: H - B, class: 'grid grid-day' }, s);
        svgEl('text', { x: X(t) + 4, y: H - 8, class: 'axis' }, s).textContent = new Date(t).toLocaleDateString('en-US', { weekday: 'short' });
    }
    const area = (a, b, cls) => {
        const top = mean.map(m => [X(m.x), Y(c(m[b]))]);
        const bot = mean.map(m => [X(m.x), Y(c(m[a]))]).reverse();
        svgEl('path', { d: `${monotonePath(top)}L${bot.map(p => p.map(n => n.toFixed(1)).join(',')).join('L')}Z`, class: cls }, s);
    };
    area('p10', 'p90', 'plume-outer');
    area('p25', 'p75', 'plume-inner');
    const clipT = p => p.x >= x0 && p.x <= x1;
    prevs.slice().reverse().forEach((p, k) => {
        const pts = p.mean.filter(clipT).map(m => [X(m.x), Y(c(m.y))]);
        if (pts.length > 1) svgEl('path', { d: monotonePath(pts), class: `plume-prev prev${prevs.length - 1 - k}` }, s);
    });
    const detIn = det.filter(clipT);
    if (detIn.length > 1) svgEl('path', { d: monotonePath(detIn.map(p => [X(p.x), Y(c(p.y))])), class: 'plume-det' }, s);
    svgEl('path', { d: monotonePath(mean.map(m => [X(m.x), Y(c(m.y))])), class: 'plume-mean' }, s);

    const cursor = svgEl('line', { y1: T, y2: H - B, class: 'plume-cursor' }, s);
    const dot = svgEl('circle', { r: 4, class: 'plume-dot' }, s);
    const at = t => {
        const m = interp(mean, t);
        if (m == null) return;
        cursor.setAttribute('x1', X(t));
        cursor.setAttribute('x2', X(t));
        dot.setAttribute('cx', X(t));
        dot.setAttribute('cy', Y(c(m)));
        const r = interp(det, t);
        const when = `${new Date(t).toLocaleDateString('en-US', { weekday: 'short' })} ${timeOf(t)}`;
        readout.replaceChildren(el('b', null, when), el('span', null, `Mean ${spec.fmt(c(m))}`),
            el('span', null, `Range ${spec.fmt(c(interp(mean, t, 'p10')))} to ${spec.fmt(c(interp(mean, t, 'p90')))}`),
            ...(r != null ? [el('span', 'det', `RRFS ${spec.fmt(c(r))}`)] : []),
            ...prevs.map(p => { const v = interp(p.mean, t); return v == null ? null : el('span', 'prev', `${p.label} ${spec.fmt(c(v))}`); }).filter(Boolean));
    };
    const scrub = e => {
        const r = s.getBoundingClientRect();
        const t = x0 + (e.clientX - r.left - L) / (W - L - R) * (x1 - x0);
        at(Math.min(x1, Math.max(x0, Math.round(t / HALF_HOUR) * HALF_HOUR)));
    };
    s.addEventListener('pointermove', scrub);
    s.addEventListener('pointerdown', scrub);
    at(Math.min(x1, Math.max(x0, Math.round((now + 21 * 3600000) / HALF_HOUR) * HALF_HOUR)));
    box.append(s);
}

// ============ Radar panel ============
let radarEscape = null;   // the current page's radar panel's close, for Escape inside the map
window.addEventListener('message', e => {
    if (e.origin === location.origin && e.data?.type === 'wx-radar-close') radarEscape?.(e.source);
});

// The radar page embedded (radar.html?embed=1): loaded once scrolled near,
// paused while out of view, a tap expands it to full screen in place
function radarPanel(place) {
    const sec = el('section', 'glass panel radar-panel');
    const head = el('div', 'panel-head');
    head.append(el('h2', 'panel-title', 'Radar'));
    const frame = el('div', 'radar-frame');
    const open = el('button', 'wx-icon-btn radar-expand');
    open.setAttribute('aria-label', 'Open the radar full screen');
    open.append(icon('expand'));
    const close = el('button', 'wx-icon-btn radar-close');
    close.setAttribute('aria-label', 'Close the radar');
    close.append(icon('close'));
    frame.append(open, close);
    sec.append(head, frame);
    sec.dataset.section = 'radar';

    let iframe = null;
    const post = msg => iframe?.contentWindow?.postMessage({ type: 'wx-radar', ...msg }, location.origin);
    const load = () => {
        if (iframe) return;
        iframe = el('iframe');
        iframe.title = 'Radar map';
        iframe.loading = 'lazy';
        iframe.src = `/radar?embed=1#7.6/${place.lat.toFixed(4)}/${place.lon.toFixed(4)}`;
        frame.prepend(iframe);
    };
    new IntersectionObserver(([e]) => {
        if (e.isIntersecting) load();
        if (!sec.classList.contains('full')) post({ play: e.isIntersecting });
    }, { rootMargin: '300px 0px' }).observe(sec);

    const setFull = full => {
        sec.classList.toggle('full', full);
        document.body.classList.toggle('no-scroll', full);
        post({ view: full ? 'full' : 'mini', play: true });
        if (full) close.focus();
    };
    open.addEventListener('click', () => { load(); setFull(true); });
    // Escape pressed inside the map arrives as a message from the iframe
    radarEscape = source => { if (source === iframe?.contentWindow && sec.classList.contains('full')) setFull(false); };
    close.addEventListener('click', () => setFull(false));
    sec.addEventListener('keydown', e => { if (e.key === 'Escape' && sec.classList.contains('full')) setFull(false); });
    return sec;
}

// ============ Detail tiles ============
// Tiles in the user's order (edit mode); a tap opens the tile's detail sheet

const TILE_KEYS = ['wind', 'humidity', 'uv', 'sun', 'moon', 'feels', 'precip'];
const SECTION_KEYS = ['hourly', 'radar', 'daily', 'plumes', 'tiles'];
const LAYOUT_KEY = 'wx-layout';
const layout = () => {
    const saved = readJson(LAYOUT_KEY, {});
    const order = (keys, got) => [...(got || []).filter(k => keys.includes(k)), ...keys.filter(k => !(got || []).includes(k))];
    return { sections: order(SECTION_KEYS, saved.sections), tiles: order(TILE_KEYS, saved.tiles) };
};
const saveLayout = (part, keys) => store.set(LAYOUT_KEY, JSON.stringify({ ...readJson(LAYOUT_KEY, {}), [part]: keys }));

function tile(key, title, place, f) {
    const t = el('section', 'glass tile');
    t.dataset.tile = key;
    t.tabIndex = 0;
    t.setAttribute('role', 'button');
    t.setAttribute('aria-label', `${title} details`);
    t.append(el('h3', 'tile-title', title));
    const open = () => { if (!document.body.classList.contains('editing')) openDetail(key, place, f); };
    t.addEventListener('click', open);
    t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return t;
}

// Today's hourly UV estimate from the sun's elevation and the forecast cloud cover
function uvHours(place, f) {
    const today = dayKey(Date.now());
    return f.rows.filter(r => dayKey(r.t) === today).map(r => ({ t: r.t, uv: uvIndex(sunAltitude(r.t, place.lat, place.lon), r.cloud) }));
}

function tiles(place, f) {
    const grid = el('div', 'tiles');
    grid.dataset.section = 'tiles';
    const make = { wind: windTile, humidity: humidityTile, uv: uvTile, sun: sunTile, moon: moonTile, feels: feelsTile, precip: precipTile };
    for (const key of layout().tiles) {
        const t = make[key](place, f);
        if (t) grid.append(t);
    }
    return grid;
}

function windTile(place, f) {
    const t = tile('wind', 'Wind', place, f);
    const dir = f.obs?.wind?.from ?? f.upcoming[0]?.dir ?? 0;
    const gust = f.obs?.gust ?? f.upcoming[0]?.gust;
    t.append(compassSvg(dir, f.wind), el('div', 'tile-note', `From the ${compass(dir)}${gust != null ? ` · gusts ${windStr(gust)}` : ''}`));
    return t;
}

// Dial: fine ticks every 5 degrees, cardinals outside the ring, a needle
// pointing downwind that passes under the speed hub
function compassSvg(dir, mph) {
    const s = svgEl('svg', { viewBox: '-10 -10 140 140', class: 'compass', 'aria-hidden': 'true' });
    svgEl('circle', { cx: 60, cy: 60, r: 55, class: 'dial' }, s);
    for (let a = 0; a < 360; a += 5) {
        const major = a % 90 === 0, mid = a % 30 === 0;
        const r0 = major ? 47 : mid ? 49 : 51, rad = a * Math.PI / 180;
        svgEl('line', { x1: 60 + r0 * Math.sin(rad), y1: 60 - r0 * Math.cos(rad), x2: 60 + 54 * Math.sin(rad), y2: 60 - 54 * Math.cos(rad), class: major ? 'tick tick-major' : 'tick' }, s);
    }
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([l, a]) => {
        const rad = a * Math.PI / 180;
        svgEl('text', { x: 60 + 64 * Math.sin(rad), y: 60 - 64 * Math.cos(rad), class: `cardinal${l === 'N' ? ' north' : ''}`, 'dominant-baseline': 'central' }, s).textContent = l;
    });
    const g = svgEl('g', { transform: `rotate(${dir} 60 60)` }, s);
    svgEl('path', { d: 'M60 10 L60 38', class: 'needle-tail' }, g);
    svgEl('path', { d: 'M60 82 L60 108 M54 100 L60 109 L66 100', class: 'needle' }, g);
    svgEl('circle', { cx: 60, cy: 60, r: 22, class: 'hub' }, s);
    svgEl('text', { x: 60, y: 57, class: 'hub-speed', 'dominant-baseline': 'central' }, s).textContent = Math.round(U.toWind(mph, units));
    svgEl('text', { x: 60, y: 71, class: 'hub-unit', 'dominant-baseline': 'central' }, s).textContent = U.windUnit(units);
    return s;
}

function humidityTile(place, f) {
    const t = tile('humidity', 'Humidity', place, f);
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

// UV: only on days whose estimated peak is moderate or more
function uvTile(place, f) {
    const hrs = uvHours(place, f);
    const peak = hrs.reduce((a, h) => (h.uv > (a?.uv ?? -1) ? h : a), null);
    if (!peak || peak.uv < 3) return null;
    const t = tile('uv', 'UV index', place, f);
    const now = uvIndex(f.sun.alt, f.nowRow?.cloud);
    const guard = hrs.filter(h => h.uv >= 3);
    t.append(el('div', 'tile-value', String(Math.round(now))), el('div', 'tile-sub', uvCategory(now)),
        el('div', 'tile-note', guard.length ? `Protection ${hourOf(guard[0].t)}–${hourOf(guard[guard.length - 1].t + 3600000)} · peak ${Math.round(peak.uv)}` : `Peak ${Math.round(peak.uv)}`));
    const bar = el('div', 'meter meter-uv');
    const fill = el('i');
    fill.style.width = `${Math.min(100, now / 11 * 100)}%`;
    bar.append(fill);
    t.append(bar);
    return t;
}

// The sun's altitude over the whole local day: above the horizon lit and
// filled, below it dim; the sun where it is now
function sunCurve(place, big) {
    const W = 160, H = big ? 90 : 74, BASE = big ? 56 : 46;
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const noon = solarNoon(Date.now(), place.lat, place.lon);
    const up = Math.max(noon.alt, 10), down = 28;
    const X = t => (t - day.getTime()) / 86400000 * W;
    // Night side capped at `down` degrees below the horizon, so the curve stays in its box
    const Y = alt => BASE - (alt >= 0 ? alt / up * (BASE - 6) : Math.max(alt, -down) / down * (H - BASE - 4));
    const pts = [];
    for (let t = day.getTime(); t <= day.getTime() + 86400000; t += 15 * 60000) pts.push([X(t), Y(sunAltitude(t, place.lat, place.lon))]);
    const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sun-arc', 'aria-hidden': 'true' });
    const id = `sc${Math.random().toString(36).slice(2, 8)}`;
    const defs = svgEl('defs', {}, s);
    const clip = svgEl('clipPath', { id: `${id}a` }, defs);
    svgEl('rect', { x: 0, y: 0, width: W, height: BASE }, clip);
    const lg = svgEl('linearGradient', { id: `${id}f`, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
    svgEl('stop', { offset: 0, 'stop-color': '#ffcf5a', 'stop-opacity': 0.5 }, lg);
    svgEl('stop', { offset: 1, 'stop-color': '#ffcf5a', 'stop-opacity': 0.02 }, lg);
    const path = monotonePath(pts);
    svgEl('path', { d: path, class: 'sun-night' }, s);
    const lit = svgEl('g', { 'clip-path': `url(#${id}a)` }, s);
    svgEl('path', { d: `${path}L${W},${BASE}L0,${BASE}Z`, fill: `url(#${id}f)` }, lit);
    svgEl('path', { d: path, class: 'sun-day' }, lit);
    svgEl('line', { x1: 0, x2: W, y1: BASE, y2: BASE, class: 'horizon' }, s);
    const alt = sunAltitude(Date.now(), place.lat, place.lon);
    const cx = X(Date.now()), cy = Y(alt);
    if (alt > 0) svgEl('circle', { cx, cy, r: big ? 10 : 8, class: 'sun-halo' }, s);
    svgEl('circle', { cx, cy, r: big ? 5.5 : 4.5, class: alt > 0 ? 'sun-dot' : 'sun-dot sun-below' }, s);
    return s;
}

function sunTile(place, f) {
    const t = tile('sun', 'Sun', place, f);
    const { rise, set } = sunTimes(Date.now(), place.lat, place.lon);
    if (!rise || !set) return t;
    const times = el('div', 'sun-times');
    times.append(el('span', null, `Rise ${timeOf(rise)}`), el('span', null, `Set ${timeOf(set)}`));
    const mins = Math.round((set - rise) / 60000);
    t.append(sunCurve(place), times, el('div', 'tile-note', `${Math.floor(mins / 60)}h ${mins % 60}m of daylight`));
    return t;
}

function moonDisk(size) {
    const m = moonPhase(Date.now());
    const s = svgEl('svg', { viewBox: '0 0 80 80', class: 'moon', 'aria-hidden': 'true', width: size, height: size });
    svgEl('circle', { cx: 40, cy: 40, r: 30, class: 'moon-dark' }, s);
    svgEl('path', { d: moonPath(40, 40, 30, m.phase), class: 'moon-lit' }, s);
    return s;
}

function moonTile(place, f) {
    const t = tile('moon', 'Moon', place, f);
    const now = Date.now();
    const m = moonPhase(now);
    const full = nextMoon(now, 0.5);
    const next = full - now < 86400000 ? nextMoon(now + 2 * 86400000, 0.5) : full;
    t.append(moonDisk(64), el('div', 'tile-sub', m.name), el('div', 'tile-note',
        `${Math.round(m.illum * 100)}% lit · full ${new Date(next).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`));
    return t;
}

function feelsTile(place, f) {
    const t = tile('feels', 'Feels like', place, f);
    if (f.feels == null) return t;
    const diff = Math.round(f.feels - f.temp);   // °F: the thresholds below are in °F
    const why = diff <= -2 ? 'The wind makes it feel colder.' : diff >= 2 ? 'Humidity makes it feel warmer.' : 'Close to the actual temperature.';
    t.append(el('div', 'tile-value', deg(f.feels)), el('div', 'tile-note', why));
    return t;
}

function precipTile(place, f) {
    const t = tile('precip', 'Precipitation', place, f);
    const sum = (h, k) => f.upcoming.slice(0, h).reduce((a, r) => a + (r[k] || 0), 0);
    const q24 = sum(24, 'qpf'), q48 = sum(48, 'qpf'), s48 = sum(48, 'snow');
    t.append(el('div', 'tile-value', rain(q24)), el('div', 'tile-sub', 'next 24 hours'),
        el('div', 'tile-note', `${rain(q48)} over 48 hours${s48 >= 0.1 ? `, ${rain(s48, true)} snow` : ''}`));
    return t;
}

// ============ Detail sheets ============

const detailDialog = document.getElementById('detailDialog');
detailDialog.querySelector('.detail-done').addEventListener('click', () => detailDialog.close());
detailDialog.addEventListener('click', e => { if (e.target === detailDialog) detailDialog.close(); });

function rowsList(rows) {
    const dl = el('dl', 'detail-rows');
    for (const [k, v] of rows) {
        if (v == null) continue;
        dl.append(el('dt', null, k), el('dd', null, v));
    }
    return dl;
}

function openDetail(key, place, f) {
    const body = detailDialog.querySelector('.detail-body');
    const titles = { wind: 'Wind', humidity: 'Humidity', uv: 'UV index', sun: 'Sun', moon: 'Moon', feels: 'Feels like', precip: 'Precipitation' };
    detailDialog.querySelector('.detail-title').textContent = titles[key];
    body.replaceChildren();
    detailDialog.showModal();
    const hrs = f.upcoming.slice(0, 48);
    const T = v => U.toTemp(v, units);
    const content = {
        sun: () => {
            const now = Date.now();
            const c = h => sunCross(now, place.lat, place.lon, h);
            const [ast, nau, civ, rs, gold] = [-18, -12, -6, -0.833, 6].map(c);
            const noon = solarNoon(now, place.lat, place.lon);
            const len = rs.up && rs.down ? rs.down - rs.up : null;
            const y = sunTimes(now - 86400000, place.lat, place.lon);
            const change = len && y.rise && y.set ? Math.round((len - (y.set - y.rise)) / 1000) : null;
            const t = v => (v ? timeOf(v) : '--');
            return [sunCurve(place, true), rowsList([
                ['Astronomical dawn', t(ast.up)], ['Nautical dawn', t(nau.up)], ['Civil dawn', t(civ.up)],
                ['Sunrise', t(rs.up)], ['Morning golden hour ends', t(gold.up)],
                ['Solar noon', `${t(noon.t)} · ${Math.round(noon.alt)}° high`],
                ['Evening golden hour begins', t(gold.down)], ['Sunset', t(rs.down)], ['Civil dusk', t(civ.down)],
                ['Nautical dusk', t(nau.down)], ['Astronomical dusk', t(ast.down)],
                ['Daylight', len ? `${Math.floor(Math.round(len / 60000) / 60)}h ${Math.round(len / 60000) % 60}m` : '--'],
                ['Change from yesterday', change == null ? null : `${change < 0 ? '−' : '+'}${Math.floor(Math.abs(change) / 60)}m ${Math.abs(change) % 60}s`],
            ])];
        },
        moon: () => {
            const now = Date.now();
            const m = moonPhase(now);
            const today = moonTimes(now, place.lat, place.lon), tmr = moonTimes(now + 86400000, place.lat, place.lon);
            const t = v => (v ? timeOf(v) : 'none');
            const date = ms => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            return [el('div', 'detail-moon', null), rowsList([
                ['Phase', m.name], ['Illuminated', `${Math.round(m.illum * 100)}%`], ['Age', `${(m.phase * 29.53).toFixed(1)} days`],
                ['Moonrise today', t(today.rise)], ['Moonset today', t(today.set)],
                ['Moonrise tomorrow', t(tmr.rise)], ['Moonset tomorrow', t(tmr.set)],
                ...nextPhases(now).map(p => [p.name, date(p.t)]),
            ])];
        },
        wind: () => [seriesChart(hrs, [{ get: r => U.toWind(r.gust ?? r.wind, units), cls: 'line-gust', label: 'Gusts' },
            { get: r => U.toWind(r.wind, units), cls: 'line-main', label: 'Wind' }], { fmt: v => `${Math.round(v)} ${U.windUnit(units)}`, zero: true }),
            rowsList(hrs.filter((_, i) => i % 6 === 0).map(r => [`${weekday(r.t)} ${hourOf(r.t)}`, `${compass(r.dir)} ${windStr(r.wind)}, gusts ${windStr(r.gust ?? r.wind)}`]))],
        humidity: () => [seriesChart(hrs, [{ get: r => T(r.dpt), cls: 'line-main', label: 'Dew point' }], { fmt: v => `${Math.round(v)}°` }),
            seriesChart(hrs, [{ get: r => humidity(r.tmp, r.dpt), cls: 'line-alt', label: 'Relative humidity' }], { fmt: v => `${Math.round(v)}%`, zero: true, max: 100 }),
            rowsList([['Now', f.dpt != null ? `${comfort(f.dpt)} · dew point ${deg(f.dpt)}` : null]])],
        feels: () => [seriesChart(hrs, [{ get: r => T(r.tmp), cls: 'line-alt', label: 'Air' },
            { get: r => T(feelsLike(r.tmp, r.dpt, r.wind)), cls: 'line-main', label: 'Feels like' }], { fmt: v => `${Math.round(v)}°` })],
        precip: () => {
            const daily = f.raw.daily?.length ? nbmDays(f.raw.daily) : [];
            return [seriesChart(hrs, [], { fmt: v => rain(v), bars: { get: r => r.qpf, snow: r => r.snowy }, zero: true, label: 'Per hour' }),
                rowsList(daily.slice(0, 10).map(d => [weekday(d.t), `${d.pop != null ? `${d.pop}% chance · ` : ''}${d.snow >= 0.1 ? `${rain(d.snow, true)} snow` : rain(d.qpf)}`]))];
        },
        uv: () => {
            const u = uvHours(place, f);
            return [seriesChart(u.map(h => ({ t: h.t, uv: h.uv })), [{ get: r => r.uv, cls: 'line-uv', label: 'UV index' }], { fmt: v => v.toFixed(0), zero: true }),
                rowsList([['Estimate', 'From the sun\'s elevation and forecast cloud cover; no model here forecasts UV, so ozone and haze are not included.']])];
        },
    }[key];
    // Charts size to the sheet, so build once it is laid out
    requestAnimationFrame(() => {
        body.replaceChildren(...content());
        if (key === 'moon') body.querySelector('.detail-moon').append(moonDisk(120));
    });
}

// A scrubbable 48-hour chart: lines (and optional bars) over hourly rows
function seriesChart(rows, lines, opts) {
    const wrap = el('div', 'series');
    const readout = el('div', 'series-readout');
    wrap.append(readout);
    if (rows.length < 2) return wrap;
    const W = Math.max(260, (detailDialog.querySelector('.detail-body')?.clientWidth || 520)), H = 170, L = 44, R = 10, T = 10, B = 24;
    const x0 = rows[0].t, x1 = rows[rows.length - 1].t;
    const vals = [...lines.flatMap(l => rows.map(l.get)), ...(opts.bars ? rows.map(opts.bars.get) : [])].filter(v => v != null && !Number.isNaN(v));
    let lo = opts.zero ? 0 : Math.min(...vals), hi = opts.max ?? Math.max(...vals, lo + 1);
    const pad = (hi - lo) * 0.1;
    if (!opts.zero) lo -= pad;
    if (opts.max == null) hi += pad;
    const X = t => L + (t - x0) / (x1 - x0) * (W - L - R);
    const Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const s = svgEl('svg', { width: W, height: H, class: 'plume-svg' });
    for (let k = 0; k <= 3; k++) {
        const v = lo + (hi - lo) * k / 3;
        svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'grid' }, s);
        svgEl('text', { x: L - 6, y: Y(v), class: 'axis axis-y', 'dominant-baseline': 'central' }, s).textContent = opts.fmt(v);
    }
    for (let t = new Date(x0).setHours(24, 0, 0, 0); t < x1; t += 86400000) {
        svgEl('line', { x1: X(t), x2: X(t), y1: T, y2: H - B, class: 'grid grid-day' }, s);
        svgEl('text', { x: X(t) + 4, y: H - 7, class: 'axis' }, s).textContent = new Date(t).toLocaleDateString('en-US', { weekday: 'short' });
    }
    if (opts.bars) {
        const bw = Math.max(2, (W - L - R) / rows.length - 2);
        rows.forEach(r => {
            const v = opts.bars.get(r) || 0;
            if (v > 0) svgEl('rect', { x: X(r.t) - bw / 2, y: Y(v), width: bw, height: Y(lo) - Y(v), rx: 1.5, class: opts.bars.snow?.(r) ? 'bar-snow' : 'bar-rain' }, s);
        });
    }
    for (const l of lines) {
        const pts = rows.map(r => [X(r.t), l.get(r)]).filter(p => p[1] != null && !Number.isNaN(p[1])).map(([x, v]) => [x, Y(v)]);
        if (pts.length > 1) svgEl('path', { d: monotonePath(pts), class: `series-line ${l.cls}` }, s);
    }
    const cursor = svgEl('line', { y1: T, y2: H - B, class: 'plume-cursor' }, s);
    const at = i => {
        const r = rows[i];
        cursor.setAttribute('x1', X(r.t));
        cursor.setAttribute('x2', X(r.t));
        readout.replaceChildren(el('b', null, `${weekday(r.t)} ${hourOf(r.t)}`),
            ...lines.map(l => el('span', l.cls, `${l.label} ${opts.fmt(l.get(r))}`)),
            ...(opts.bars ? [el('span', 'det', `${opts.label} ${opts.fmt(opts.bars.get(r) || 0)}`)] : []));
    };
    const scrub = e => {
        const r = s.getBoundingClientRect();
        const t = x0 + (e.clientX - r.left - L) / (W - L - R) * (x1 - x0);
        let best = 0;
        rows.forEach((row, i) => { if (Math.abs(row.t - t) < Math.abs(rows[best].t - t)) best = i; });
        at(best);
    };
    s.addEventListener('pointermove', scrub);
    s.addEventListener('pointerdown', scrub);
    at(0);
    wrap.append(s);
    return wrap;
}

function actions(place, f) {
    const sec = el('section', 'actions');
    const link = (text, href) => {
        const a = el('a', 'glass action', text);
        a.href = href;
        return a;
    };
    sec.append(link('Radar', radarLink(place, 'radar')));
    const ed = el('button', 'glass action', 'Edit layout');
    ed.type = 'button';
    ed.addEventListener('click', () => setEditing(true));
    sec.append(ed);
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

// ============ Edit mode: drag to reorder ============
// Items of a container reorder by dragging while the page is in edit mode;
// onEnd gets the new order of the items' keys (data-place/-section/-tile)
function sortable(container, itemSel, onEnd) {
    if (!container) return;
    container.addEventListener('pointerdown', e => {
        if (!document.body.classList.contains('editing')) return;
        const item = e.target.closest(itemSel);
        if (!item || item.parentElement !== container) return;
        e.preventDefault();
        e.stopPropagation();   // a tile inside the tiles section: the inner list takes the drag
        item.classList.add('lifted');
        const move = ev => {
            const over = document.elementsFromPoint(ev.clientX, ev.clientY)
                .map(n => n.closest?.(itemSel)).find(n => n && n !== item && n.parentElement === container);
            if (!over) return;
            const r = over.getBoundingClientRect();
            const sameRow = ev.clientY > r.top && ev.clientY < r.bottom && r.width < container.clientWidth * 0.9;
            const after = sameRow ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2;
            after ? over.after(item) : over.before(item);
        };
        // Listen on window for the drag: moving the item in the DOM would drop a pointer capture
        const end = () => {
            item.classList.remove('lifted');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            const keys = [...container.children].filter(n => n.matches(itemSel))
                .map(n => n.dataset.place ?? n.dataset.section ?? n.dataset.tile);
            onEnd(keys);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
    });
}

const editDone = document.getElementById('editDone');
function setEditing(on) {
    document.body.classList.toggle('editing', on);
    editDone.hidden = !on;
}
editDone.addEventListener('click', () => { setEditing(false); route(true); });

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

// ============ Settings ============
const settingsDialog = document.getElementById('settingsDialog');
const SETTING_LABELS = { temp: 'Temperature', wind: 'Wind', precip: 'Precipitation', clock: 'Time' };
function renderSettings() {
    const body = settingsDialog.querySelector('.settings-body');
    body.replaceChildren(...Object.entries(U.UNIT_CHOICES).map(([k, opts]) => {
        const row = el('div', 'setting');
        const seg = el('div', 'seg');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', SETTING_LABELS[k]);
        for (const [v, label] of opts) {
            const b = el('button', 'seg-btn', label);
            b.type = 'button';
            b.setAttribute('aria-pressed', String(units[k] === v));
            b.addEventListener('click', () => {
                units = { ...units, [k]: v };
                store.set(UNITS_KEY, JSON.stringify(units));
                renderSettings();
                route(true);
            });
            seg.append(b);
        }
        row.append(el('span', 'setting-label', SETTING_LABELS[k]), seg);
        return row;
    }));
}
document.getElementById('settingsBtn').addEventListener('click', () => { renderSettings(); settingsDialog.showModal(); });
settingsDialog.querySelector('.settings-done').addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', e => { if (e.target === settingsDialog) settingsDialog.close(); });
document.getElementById('searchCancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
// Enter searches now instead of submitting (and closing) the dialog
dialog.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    clearTimeout(searchTimer);
    search();
});

// ============ Routing ============

// keepScroll: a redraw of the same page (settings, refresh) stays where the user was
function route(keepScroll = false) {
    document.body.classList.remove('no-scroll');   // a full-screen radar left by back or refresh
    const y = scrollY;
    const m = location.hash.match(/^#p=(.+)$/);
    const done = m ? renderPlace(decodeURIComponent(m[1])) : renderHome();
    // once the redraw is in: a place page waits on its forecast before its sections exist
    const seq = renderSeq;
    if (keepScroll) Promise.resolve(done).then(() => { if (seq === renderSeq) requestAnimationFrame(() => window.scrollTo(0, y)); });
    else window.scrollTo(0, 0);
}

// Coming back to the tab after a while: drop stale forecasts
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > 10 * 60000) { forecasts.clear(); refsCache.clear(); route(true); }
});

applySiteSettings();
route();
if (store.get(GPS_KEY) === '1') locate(false);
