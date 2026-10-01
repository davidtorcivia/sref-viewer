/**
 * Weather overview, Signal layout: one place per page, switched by the place
 * chips. Color is temperature and nothing else (signal.js rampColor).
 *   hero      the next 24 hours as a color field, the observed temperature,
 *             one sentence, and the 48-hour spiral (last 24 h observed inside,
 *             next 24 h forecast outside)
 *   readouts  eight values at the cursor time; a card slides its detail open below
 *   hours     48 hours: RRFS line, the ensemble spread as a band, cloud cover, wind
 *   days      the NBM days on one temperature axis, the chance of rain as 20 squares
 *   radar, ensemble plumes
 * One cursor time drives the hero number, the readouts, the chart and the
 * spiral; a drag on the chart or the spiral moves it, release returns to now.
 * Data: /api/forecast, /api/history, /api/refs, /api/geocode, /api/radar/alerts.
 * Routes: #  (the first place)  and  #p=<id>.
 */

import { store, getLatestRunWithDate, previousCycle } from './config.js?v=__V__';
import { applySiteSettings } from './site.js?v=__V__';
import {
    hourlyRows, condition, nowcast, sunAltitude, sunPosition, sunTimes, moonPhase, moonPath, humidity, feelsLike,
    comfort, compass, monotonePath, nbmDays, sunCross, solarNoon, moonTimes, nextPhases, uvIndex, uvCategory, sky, outlook, nextHour, rateClass, WET_MMH,
} from './forecast.js?v=__V__';
import { rampColor, lineColor, windArrow, spiral, spiralTimeAt, SPIRAL, fieldColor } from './signal.js?v=__V__';
import * as U from './units.js?v=__V__';
import * as Z from './zone.js?v=__V__';

const PLACES_KEY = 'wx-places';
const UNITS_KEY = 'wx-units';
const HERE_KEY = 'wx-here';            // last device position {lat, lon, name}
const GPS_KEY = 'wx-gps';              // '1' once the user turned on "my location"
const DEFAULT_PLACES = [{ id: 'nyc', name: 'New York, NY', lat: 40.7128, lon: -74.006 }];
const POLL_MS = 4000;                  // a new region's hourly series is cut in ~7 s
const POLL_TRIES = 10;
const HOURS_SHOWN = 48;
const HOLD_MS = 180;                   // a touch held this long scrubs instead of scrolling
const HOUR = 3600000;
const ENSEMBLE_MAX_KM = 40;            // farther than this, the station's spread says little about the place
const NS = 'http://www.w3.org/2000/svg';
const PAPER = '#f3f0e8';
const SAVED_KEY = 'wx-fc:';            // + place id: the last forecast, drawn at once on the next visit
const SAVED_MAX_AGE = 6 * HOUR;        // older than this the page waits for a fresh one

const view = document.getElementById('view');
const chipsBox = document.getElementById('chips');
const dialog = document.getElementById('searchDialog');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

const readJson = (key, fallback) => { try { return JSON.parse(store.get(key)) ?? fallback; } catch { return fallback; } };
let places = readJson(PLACES_KEY, DEFAULT_PLACES);
let here = readJson(HERE_KEY, null);
const savePlaces = () => store.set(PLACES_KEY, JSON.stringify(places));

const forecasts = new Map();   // place id -> Promise<forecast>
const histories = new Map();   // place id -> Promise<history | null>
const airs = new Map();        // place id -> Promise<{ air, pollen } | null>
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
const svgTitle = (node, text) => { svgEl('title', {}, node).textContent = text; return node; };
const icon = (key, cls = '') => {
    const s = svgEl('svg', { class: `ic ic-${key} ${cls}`, 'aria-hidden': 'true' });
    svgEl('use', { href: `#i-${key}` }, s);
    return s;
};
// Formatting in the user's units (data stays °F, mph, inches)
// ============ The place's time zone ============
// Times, days and "tonight" read in the place's own zone (the forecast's tz); undefined is the device's
let zone;
const zDay = (ms, tz = zone) => Z.day(ms, tz);
const zHour = ms => Z.hour(ms, zone);
const zMidnight = ms => Z.midnight(ms, zone);
const zNoon = ms => Z.noon(ms, zone);
const zDate = (ms, opts) => Z.format(ms, opts, zone);
const zMidnights = (a, b) => Z.midnights(a, b, zone);
const zoneTag = ms => Z.tag(ms, zone);

const deg = v => U.deg(v, units);
const timeOf = ms => U.clock(ms, units, true, zone);
const hourOf = ms => U.clock(ms, units, false, zone);      // compact "3PM": axes and hour blocks
const hourText = ms => U.hourText(ms, units, zone);        // "3 PM": sentences, hovers, cards
const windStr = mph => U.wind(mph, units);
const rain = (inches, snow) => U.precip(inches, units, snow);
const weekday = ms => (zDay(ms) === zDay(Date.now()) ? 'Today' : zDate(ms, { weekday: 'short' }));
// Yesterday, Today, Tomorrow, else the short weekday
const dayName = ms => ({ '-1': 'Yesterday', 0: 'Today', 1: 'Tomorrow' })[Math.round((zNoon(ms) - zNoon(Date.now())) / 86400000)] ?? zDate(ms, { weekday: 'short' });
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
// Gusts count when they beat the wind by 5 mph
const gusty = (mph, gust) => gust != null && gust - (mph ?? 0) >= 5;
// "NW 4 mph, gusts 8", or "Calm"
function windText(dir, mph, gust) {
    const g = gusty(mph, gust) ? `, gusts ${Math.round(U.toWind(gust, units))}` : '';
    if (Math.round(U.toWind(mph ?? 0, units)) === 0) return g ? `Calm, gusts ${windStr(gust)}` : 'Calm';
    return `${dir != null ? `${compass(dir)} ` : ''}${windStr(mph)}${g}`;
}
// "0.05\" rain", "0.3\" snow", "Dry"
const precipText = (qpf, snow, snowy) => (!(qpf >= 0.01) ? 'Dry' : snowy ? `${rain(snow, true)} snow` : `${rain(qpf)} rain`);

// Words for a time ahead: "this afternoon", "tonight", "tomorrow morning"
function partOfDay(t, now = Date.now()) {
    const h = zHour(t);
    const days = Math.round((zNoon(t) - zNoon(now)) / 86400000);
    if (days === 0) return h < 12 ? 'this morning' : h < 17 ? 'this afternoon' : h < 21 ? 'this evening' : 'tonight';
    if (days === 1) return h < 6 ? 'overnight' : h < 12 ? 'tomorrow morning' : h < 17 ? 'tomorrow afternoon' : h < 21 ? 'tomorrow evening' : 'tomorrow night';
    return zDate(t, { weekday: 'long' });
}

function allPlaces() {
    return here && store.get(GPS_KEY) === '1' ? [{ id: 'here', here: true, ...here }, ...places] : places;
}

// ============ Data ============

async function fetchForecast(place) {
    const url = `/api/forecast?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`;
    for (let i = 0; i < POLL_TRIES; i++) {
        const early = window.earlyForecast?.url === url && window.earlyForecast;   // the page's head started it
        if (early) window.earlyForecast = null;                                    // a body reads once
        const res = await (early ? early.res : fetch(url));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (!d.building) store.set(SAVED_KEY + place.id, JSON.stringify({ at: Date.now(), lat: place.lat, lon: place.lon, d }));
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
    const upcoming = rows.filter(r => r.t + HOUR > now);
    const cur = upcoming[0];
    const sun = sunPosition(now, place.lat, place.lon);
    const night = sun.alt < -0.8;
    // Observed values where RTMA has them; the model hour fills the rest (precipitation)
    const obs = d.now || {};
    const nowRow = cur ? { ...cur, tmp: obs.tmp ?? cur.tmp, dpt: obs.dpt ?? cur.dpt, cloud: obs.cloud ?? cur.cloud }
        : obs.cloud != null ? { cloud: obs.cloud, qpf: 0, dbz: -30 } : null;
    const temp = obs.tmp ?? cur?.tmp;
    const dpt = obs.dpt ?? cur?.dpt;
    const wind = obs.wind?.mph ?? cur?.wind ?? 0;
    const days = daysWithObserved(d.daily, temp, d.tz);
    return {
        raw: d, rows, upcoming, night, sun, obs: d.now, nowRow, days,
        cond: nowRow ? condition(nowRow, night) : { key: night ? 'clear-night' : 'clear', label: '' },
        temp, dpt, wind, gust: obs.gust ?? cur?.gust, dir: obs.wind?.from ?? cur?.dir,
        feels: temp != null && dpt != null ? feelsLike(temp, dpt, wind) : null,
    };
}

// NBM days, today's range widened by what has actually been observed
function daysWithObserved(daily, temp, tz) {
    // keyed by the NBM date itself, which is the place's calendar date
    // t: noon of that date in the place (UTC noon of a date is on that date in every US zone)
    const days = daily?.length ? nbmDays(daily).map((x, i) => {
        const [y, m, d] = daily[i].date.split('-').map(Number);
        return { ...x, key: daily[i].date, t: Z.noon(Date.UTC(y, m - 1, d, 12), tz) };
    }) : [];
    const today = days.find(x => x.key === zDay(Date.now(), tz));
    if (today && temp != null) {
        today.hi = Math.max(today.hi ?? temp, temp);
        today.lo = today.lo == null ? null : Math.min(today.lo, temp);
    }
    return days;
}

// The saved forecast from the last visit answers at once (the page is whole on its first
// paint, not a skeleton for the round trips a phone needs); the fresh one then redraws in place
function forecastFor(place) {
    if (!forecasts.has(place.id)) {
        const fresh = fetchForecast(place).then(f => {
            if (f.raw.building) forecasts.delete(place.id);   // observations only: ask again next time
            return f;
        }, err => { forecasts.delete(place.id); throw err; });
        const saved = readJson(SAVED_KEY + place.id, null);
        let instant = null;
        // the same spot: GPS drifts a little between opens (locate() moves "here" past 0.01°)
        if (saved && Date.now() - saved.at < SAVED_MAX_AGE && Math.abs(saved.lat - place.lat) <= 0.01 && Math.abs(saved.lon - place.lon) <= 0.01) {
            try { instant = Promise.resolve(shape(saved.d, place)); } catch { /* an older format: wait for the fresh one */ }
        }
        if (instant) {
            forecasts.set(place.id, instant);
            fresh.then(f => {
                // a newer ask (moved, tab back after a while) owns the entry now
                if (f.raw.building || forecasts.get(place.id) !== instant) return;
                forecasts.set(place.id, fresh);
                if (JSON.stringify(f.raw) === JSON.stringify(saved.d)) return;
                // redraw only a page nobody has touched yet: a scrub, an open row, the full-screen radar stay put
                if (shownId === place.id && !touched()) route(true, null, true);
                else if (shownId) renderChips(shownId);
            }, () => {});
        } else forecasts.set(place.id, fresh);
    }
    return forecasts.get(place.id);
}

// The last 24 hours observed at the nearest NWS station; null outside the US or on failure
function historyFor(place) {
    if (!histories.has(place.id)) {
        histories.set(place.id, fetch(`/api/history?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`)
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null)
            .then(h => { if (!h) histories.delete(place.id); return h; }));
    }
    return histories.get(place.id);
}

// Air quality at the nearest monitors and the pollen forecast (/api/air); null on failure
function airFor(place) {
    if (!airs.has(place.id)) {
        airs.set(place.id, fetch(`/api/air?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`)
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null)
            .then(a => { if (!a) airs.delete(place.id); return a; }));
    }
    return airs.get(place.id);
}

// The radar's next hour at a place (/api/nowcast), or null
async function nowcastFor(place) {
    try {
        const res = await fetch(`/api/nowcast?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`);
        const nc = res.ok ? await res.json() : null;
        return nc?.dbz ? nc : null;
    } catch {
        return null;
    }
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

// Linear value of a series' key at time t; null outside it
function interp(series, t, key = 'y') {
    const k = series.findIndex(p => p.x >= t);
    if (k < 0 || series[k][key] == null) return null;
    if (series[k].x === t || k === 0) return series[k].x === t ? series[k][key] : null;
    const a = series[k - 1], b = series[k];
    if (a[key] == null) return null;
    return a[key] + (b[key] - a[key]) * (t - a.x) / (b.x - a.x);
}

// Ensemble p10..p90 at time t, or null
function rangeAt(ens, t) {
    if (!ens) return null;
    const lo = interp(ens, t, 'p10'), hi = interp(ens, t, 'p90');
    return lo == null || hi == null ? null : { lo, hi };
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

// Dark spells [sunset, next sunrise] around now, for the spiral's night wedge
function nightsAround(place, now) {
    const out = [];
    for (let d = -1; d <= 1; d++) {
        const day = zNoon(now) + d * 86400000;
        const set = sunTimes(day, place.lat, place.lon, zone).set;
        const rise = sunTimes(day + 86400000, place.lat, place.lon, zone).rise;
        if (set && rise) out.push([set, rise]);
    }
    return out;
}

// ============ The cursor ============
// One time for the whole page: null is now. Views subscribe while connected.

const cursor = { t: null, subs: new Set() };
function setCursor(t) {
    if (t === cursor.t) return;
    cursor.t = t;
    for (const fn of cursor.subs) fn(t);
}
function onCursor(node, fn) {
    const sub = t => { if (!node.isConnected) { cursor.subs.delete(sub); return; } fn(t); };
    cursor.subs.add(sub);
}
// Pointing (a mouse) moves the cursor while it hovers; a drag or tap pins it where it is let go,
// until a tap anywhere outside the scrub surfaces or Escape. A touch that becomes a page scroll lets go.
let pinned = false;
const unpin = () => { pinned = false; setCursor(null); };
document.addEventListener('click', e => { if (pinned && !e.target.closest?.('.scrub')) unpin(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && pinned) unpin(); });
function scrubSurface(node, timeAt) {
    let active = false;
    node.classList.add('scrub');
    const move = e => setCursor(timeAt(e));
    node.addEventListener('pointerdown', e => { active = true; pinned = false; node.setPointerCapture?.(e.pointerId); move(e); });
    node.addEventListener('pointermove', e => { if (active || (e.pointerType === 'mouse' && !pinned)) move(e); });
    node.addEventListener('pointerup', () => { if (active) { active = false; pinned = cursor.t != null; } });
    node.addEventListener('pointercancel', () => { active = false; unpin(); });
    node.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !active && !pinned) setCursor(null); });
    // Touch: a finger held still for a moment grabs the cursor, and sliding then moves it
    // instead of scrolling the page; a quick swipe still scrolls
    let hold = 0, from = null, held = false;
    node.addEventListener('touchstart', e => {
        clearTimeout(hold);
        held = false;
        from = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
        if (from) hold = setTimeout(() => { held = true; }, HOLD_MS);
    }, { passive: true });
    node.addEventListener('touchmove', e => {
        if (held) { if (e.cancelable) e.preventDefault(); return; }   // the pointer events move the cursor
        const t = e.touches[0];
        // moving first is a scroll (under the browser's own threshold, so the hold never lands mid-scroll)
        if (from && Math.hypot(t.clientX - from.x, t.clientY - from.y) > 6) { clearTimeout(hold); from = null; }
    }, { passive: false });
    const release = () => { clearTimeout(hold); held = false; from = null; };
    node.addEventListener('touchend', release);
    node.addEventListener('touchcancel', release);
}
// Arrow keys step the cursor an hour at a time within [first, last]; Escape returns to now
function keyScrub(node, first, last) {
    node.tabIndex = 0;
    node.addEventListener('keydown', e => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (e.key === 'Escape') { unpin(); return; }
        if (!step) return;
        e.preventDefault();
        const base = cursor.t ?? Math.floor(Date.now() / HOUR) * HOUR;
        const t = base + step * HOUR;
        setCursor(t < first ? null : Math.min(last, t));
        pinned = cursor.t != null;
    });
    node.addEventListener('blur', () => { if (!pinned) setCursor(null); });
}

// The hourly row at time t (the hour containing it), falling back to the first
const rowAt = (f, t) => f.upcoming.find(r => r.t <= t && r.t + HOUR > t) ?? f.upcoming[0];

// ============ Navigation ============

// (the query is left behind: it is the shown place's ?at=, which the next place writes anew)
function navigate(hash) {
    const url = location.pathname + (!hash || hash === '#' ? '' : hash);
    history.replaceState({ ...history.state, y: scrollY }, '');   // where this page was, for back
    history.pushState(null, '', url);
    route();
}
history.scrollRestoration = 'manual';
document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.button) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
});
// Back/forward and a typed #hash both arrive as popstate
window.addEventListener('popstate', e => route(false, e.state?.y ?? null));

// ============ Place chips ============

function renderChips(activeId) {
    const ps = allPlaces();
    chipsBox.replaceChildren(...ps.map(place => {
        const a = el('a', 'chip');
        a.href = `#p=${encodeURIComponent(place.id)}`;
        if (place.id === activeId) a.setAttribute('aria-current', 'page');
        const sw = el('span', 'chip-swatch');
        const name = el('span', 'chip-name', place.here ? 'Here' : place.name.split(',')[0]);
        const t = el('span', 'chip-temp', '');
        a.append(sw, name, t);
        a.title = place.name;
        forecastFor(place).then(f => {
            if (f.temp == null) return;
            sw.style.background = rampColor(f.temp);
            t.textContent = deg(f.temp);
        }).catch(() => {});
        return a;
    }));
    chipsBox.querySelector('[aria-current]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

// ============ One place ============

// Phones: the color field fills the first screen and the spiral follows it
const narrowScreen = matchMedia('(max-width: 860px)');
let placeSpiral = () => {};   // the current page's: move the spiral in or out of the color field
narrowScreen.addEventListener?.('change', () => placeSpiral());

let renderSeq = 0;
// the user has done something on the page a redraw would undo (the radar map reloading is fine:
// on wide screens it is in view from the start, and old data must not stay for that)
const touched = () => cursor.t != null || pinned || document.body.classList.contains('no-scroll')
    || !!view.querySelector('[aria-expanded="true"]');
let shownId = null;          // the place on screen
let spiralDrawn = false;     // its spiral has drawn (a quiet redraw does not sweep it in again)

// quiet: the same place redrawn with fresher data, nothing animates in again
async function renderPlace(place, quiet = false) {
    const seq = ++renderSeq;
    if (!quiet || shownId !== place.id) spiralDrawn = false;
    shownId = place.id;
    cursor.t = null;
    renderChips(place.id);
    view.replaceChildren();
    const top = el('section', 'sg-top');
    const heroText = el('div', 'sg-hero');
    const label = el('div', 'sg-label', place.name);
    const num = el('div', 'sg-num sg-skeleton', '--');
    heroText.append(label, num);
    top.append(heroText);
    view.append(top);
    document.title = `${place.name} · WX-Plumes`;

    let f;
    try {
        f = await forecastFor(place);
    } catch {
        if (seq === renderSeq) heroText.append(el('p', 'sg-sentence', 'Forecast unavailable. Try again in a moment.'));
        return;
    }
    if (seq !== renderSeq) return;   // another render started meanwhile (navigation, refresh)
    zone = f.raw.tz || undefined;
    num.classList.remove('sg-skeleton');
    const next24 = f.upcoming.slice(0, 25);
    top.style.background = fieldGradient(next24, f.temp);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || PAPER);
    top.prepend(skyTicks(next24));
    const strip = hourStrip(next24);

    const sentence = el('p', 'sg-sentence', headline(f));
    const minutes = el('div', 'sg-minutes');   // empty (hidden) unless rain is due within the nowcast's two hours
    heroText.append(sentence, minutes);
    const showMinutes = nc => {
        if (seq !== renderSeq) return;
        sentence.textContent = headline(f, nc);
        minutes.replaceChildren(...minuteBars(minutes, nc));
    };
    nowcastFor(place).then(showMinutes);
    // a scan every 2 minutes; the minutes move on with it
    const tick = setInterval(() => {
        if (seq !== renderSeq) clearInterval(tick);
        else if (document.visibilityState === 'visible') nowcastFor(place).then(showMinutes);
    }, 120000);
    const alerts = el('section', 'sg-alertbox');   // empty (hidden) unless an alert covers the place
    alerts.setAttribute('aria-label', 'Weather alerts');
    top.after(alerts);
    const hero = { label, num, place, f };
    showHero(hero, null, null);

    const spiralBox = el('div', 'sg-spiral');
    placeSpiral = () => {
        if (narrowScreen.matches) { top.append(strip.el); alerts.after(spiralBox); } else top.append(spiralBox, strip.el);
    };
    placeSpiral();
    const cells = readouts(place, f);
    const hours = hoursSection(place, f, null);
    const daysSec = daysSection(f);
    const more = el('div', 'sg-more');
    const radar = radarPanel(place);
    const plume = plumePanel(f);
    more.append(radar, ...(plume ? [plume] : []));
    view.append(cells.sec, ...(hours ? [hours.sec] : []), ...(daysSec ? [daysSec] : []), more, placeFooter(place, f));

    let ens = null, hist = null;
    // a redraw keeps keyboard focus on the spiral
    // only the first drawing sweeps in; a redraw when the history lands appears in place
    const drawSpiral = () => {
        const hadFocus = spiralBox.contains(document.activeElement);
        spiralBox.replaceChildren(spiralSvg(place, f, hist, !spiralBox.firstChild && !spiralDrawn));
        spiralDrawn = true;
        if (hadFocus) spiralBox.firstChild.focus();
    };
    // The spiral grows in its colors: its first drawing waits briefly for the observed lap;
    // a history later than that fills in without growing again
    const history = historyFor(place).then(h => { if (h && seq === renderSeq) hist = h; return h; });
    (quiet && spiralDrawn ? Promise.resolve() : Promise.race([history, new Promise(r => setTimeout(r, 1500))])).then(() => {
        if (seq !== renderSeq) return;
        drawSpiral();
        history.then(h => { if (h && seq === renderSeq && !spiralBox.firstChild?.hasHistory) drawSpiral(); });
    });
    onCursor(top, t => { showHero(hero, t, ens); });
    onCursor(cells.sec, t => cells.update(t, ens));
    alertsFor(place).then(al => { if (seq === renderSeq) alerts.replaceChildren(...al.map(alertRow)); });
    ensembleFor(f).then(e => {
        if (!e || seq !== renderSeq) return;
        ens = e;
        cells.update(cursor.t, ens);
        cells.lock();   // the ensemble's ranges lengthen the later cards' lines
        hours?.setEnsemble(ens);
    });
    // A new region's days are cut after its hourly series: ask again until they land
    if (f.raw.daily_building) {
        (async () => {
            for (let i = 0; i < 12 && seq === renderSeq; i++) {
                await new Promise(r => setTimeout(r, 5000));
                try {
                    const d = await (await fetch(`/api/forecast?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`)).json();
                    if (d.daily?.length && !d.daily_building) {
                        Object.assign(f.raw, { daily: d.daily, daily_run: d.daily_run, daily_building: false });
                        f.days = daysWithObserved(d.daily, f.temp, f.raw.tz);
                        if (seq !== renderSeq) return;
                        const d2 = daysSection(f);
                        if (d2) (daysSec ? daysSec.replaceWith(d2) : more.before(d2));
                        return;
                    }
                } catch { /* try again */ }
            }
        })();
    }
}

// The color field: the next 24 hours, smoothed over three hours so it reads as weather
// rather than stripes, and softened toward the paper
// The color field: stops every two hours, each the three-hour mean's field color (signal.js)
function fieldGradient(rows, temp) {
    const dark = document.documentElement.dataset.theme === 'dark';
    const soft = t => fieldColor(t, dark);
    if (rows.length < 2) return temp != null ? soft(temp) : '';
    const n = rows.length - 1;
    const stops = [];
    for (let i = 0; i <= n; i += 2) {
        const win = rows.slice(Math.max(0, i - 1), i + 2).map(r => r.tmp).filter(Number.isFinite);   // a missing hour is skipped, not 0 °F
        if (win.length) stops.push(`${soft(win.reduce((a, b) => a + b, 0) / win.length)} ${(i / n * 100).toFixed(1)}%`);
    }
    return stops.length > 1 ? `linear-gradient(90deg, ${stops.join(', ')})` : temp != null ? soft(temp) : '';
}

// Cloud cover along the top edge of the color field: ink density per hour
function skyTicks(rows) {
    const strip = el('div', 'sg-sky');
    strip.setAttribute('aria-hidden', 'true');
    for (const r of rows.slice(0, 24)) {
        const i = el('i');
        i.style.opacity = ((r.cloud ?? 0) / 100 * 0.85).toFixed(2);
        strip.append(i);
    }
    return strip;
}

// The next 24 hours as blocks along the bottom of the color field, time and temperature;
// pointing at one moves the cursor there
function hourStrip(rows) {
    const box = el('div', 'sg-strip');
    const cells = rows.slice(0, 24).map((r, i) => {
        const c = el('div', 'sg-strip-h');
        c.append(el('span', null, hourOf(r.t)), el('b', null, deg(r.tmp)));
        const t = i ? r.t : null;   // the first block is the current hour: now
        c.tabIndex = 0;
        c.setAttribute('role', 'button');
        c.setAttribute('aria-label', `${hourText(r.t)}, ${deg(r.tmp)}`);
        const toggle = () => { const on = !(pinned && cursor.t === t); setCursor(on ? t : null); pinned = on && t != null; };
        c.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse' && !pinned) setCursor(t); });
        c.addEventListener('pointerup', toggle);
        c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        box.append(c);
        return [r, c];
    });
    box.classList.add('scrub');
    box.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !pinned) setCursor(null); });
    onCursor(box, t => { for (const [r, c] of cells) c.classList.toggle('on', t != null && r.t <= t && r.t + HOUR > t); });
    return { el: box };
}

// The hero number: the observation at rest, the forecast at the cursor
function showHero({ label, num, place, f }, t, ens) {
    if (t == null) {
        const age = f.obs?.time ? Math.round((Date.now() - f.obs.time * 1000) / 60000) : null;
        label.textContent = f.obs?.time
            ? `Now · observed ${timeOf(f.obs.time * 1000)}${zoneTag(f.obs.time * 1000)}${age != null && age >= 2 ? `, ${ago(age)}` : ''} · ${place.name}`
            : `Now · ${place.name}`;
        num.textContent = deg(f.temp);
        return;
    }
    const r = rowAt(f, t);
    if (!r) return;
    label.textContent = `${weekday(t)} ${hourText(t)} · forecast`;
    num.textContent = deg(r.tmp);
}

// "12 min ago", "1 h 35 min ago"
const ago = min => (min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''} ago`);

// The next hours (the radar, then HRRR) as a bar a minute, from now: height the rain rate;
// nothing when they stay dry
function minuteBars(box, nc, now = Date.now()) {
    if (!nc?.rain) return [];
    const n = nc.dbz.length - 1;
    box.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    const skip = Math.max(0, Math.round((now / 1000 - nc.time) / 60));
    const out = [el('b')];   // the plate
    for (let k = 0; k < n && skip + k < nc.dbz.length; k++) {
        const v = nc.rate[skip + k], kind = nc.kind?.[skip + k] ?? 'rain';
        const cls = rateClass(v, kind);
        if (!cls) continue;
        const bar = el('i', kind === 'snow' || kind === 'wet snow' ? 'snow' : kind === 'rain' ? null : 'ice');
        bar.style.gridColumn = String(k + 1);
        // height on a log scale of the liquid rate: the wet threshold low, 12 mm/h (a downpour) full
        const frac = Math.log(v / WET_MMH) / Math.log(12 / WET_MMH);
        bar.style.height = `${Math.round(Math.min(1, 0.2 + 0.8 * Math.max(0, frac)) * 100)}%`;
        bar.title = `${timeOf(now + k * 60000)} · ${cls} ${kind}`;
        out.push(bar);
    }
    const every = n > 60 ? 30 : 15;
    for (let k = 0; k < n; k += every) {
        const t = el('span', null, k ? timeOf(now + k * 60000) : 'now');
        t.style.gridColumn = `${k + 1} / span ${every}`;
        out.push(t);
    }
    return out;
}

// One sentence: the sky now, the next 12 hours, and the next rain in the days;
// the radar's next hour (nc) words the near part when it has rain
function headline(f, nc = null) {
    const now = Date.now();
    const soon = nextHour(nc, now, v => rain(v, true)) || nowcast(f.rows, now, hourText);
    const wetSoon = !!soon && !soon.startsWith('Dry');
    // the weekday within six days, else the date
    const name = d => (Math.round((d.t - zNoon(now)) / 86400000) <= 6 ? zDate(d.t, { weekday: 'long' }) : zDate(d.t, { month: 'short', day: 'numeric' }));
    const days = outlook(f.days, zDay(now), name, wetSoon);
    // "Dry for the next 12 hours" says nothing that "No rain expected through ..." does not
    // the radar knows better than the model's hour whether it is raining now
    const radarSays = nc && (f.cond.key === 'rain' || f.cond.key === 'snow');
    const cond = radarSays ? (nc.rain ? '' : sky(f.nowRow?.cloud ?? 0, f.night)) : f.cond.label;
    const parts = [cond, days.startsWith('No rain') ? '' : soon, days].filter(Boolean);
    return parts.length ? `${parts.join('. ')}.` : '';
}

// NWS text in its parts: "* WHAT...", "* WHERE..." paragraphs as [label, text], others unlabeled
function alertParts(text) {
    return (text || '').split(/\n\s*\n/).map(chunk => {
        // "* WHAT..." in watches and advisories, "HAZARD..." (no star) in warnings
        const m = chunk.match(/^\s*(?:\*\s*)?([A-Z][A-Z ]*?)\.\.\.([\s\S]*)$/);
        const flat = v => v.replace(/^\s*\*\s*/, '').replace(/\s*\n\s*/g, ' ').trim();
        return m ? [m[1].trim(), flat(m[2])] : ['', flat(chunk)];
    }).filter(([, t]) => t && !/^The National Weather Service .* has issued an?$/.test(t));   // a warning's opening fragment
}

// One alert: what it is, how long, what happens; tapped, the rest slides open under it
function alertRow(feature) {
    const p = feature.properties;
    const sev = ['extreme', 'severe', 'moderate'].includes((p.severity || '').toLowerCase()) ? p.severity.toLowerCase() : 'minor';
    const a = el('div', `sg-alert sev-${sev}`);
    const head = el('div', 'sg-alert-head');
    head.append(el('strong', null, (p.title || 'Weather alert').split(' issued ')[0]));
    const end = Number(p.expires) * 1000;
    if (p.expires) head.append(el('span', 'sg-alert-until', zDay(end) === zDay(Date.now()) ? `until ${timeOf(end)} today` : `until ${zDate(end, { weekday: 'short' })} ${timeOf(end)}`));
    const parts = alertParts(p.description);
    const lead = parts.find(([k]) => k === 'WHAT') || parts[0];
    a.append(head);
    if (lead) a.append(el('p', 'sg-alert-lead', lead[1]));
    const rest = parts.filter(x => x !== lead);
    if (!rest.length) return a;
    const more = el('div', 'sg-alert-more');
    const inner = el('div', 'sg-alert-more-inner');
    for (const [k, t] of rest) {
        const row = el('p');
        if (k) row.append(el('span', 'sg-alert-k', `${k[0]}${k.slice(1).toLowerCase()}`));
        row.append(t);
        inner.append(row);
    }
    more.append(inner);
    a.append(more);
    a.tabIndex = 0;
    a.setAttribute('role', 'button');
    a.setAttribute('aria-expanded', 'false');
    const flip = () => a.setAttribute('aria-expanded', String(a.classList.toggle('open')));
    a.addEventListener('click', flip);
    a.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    return a;
}

// ============ The spiral ============

function spiralSvg(place, f, hist, sweep = true) {
    const now = Date.now();
    const past = hist?.hours?.map(h => ({ t: h.t, tmp: h.tmp, precip: h.precip, cloud: h.cloud, wind: h.wind, dir: h.dir, gust: h.gust })) ?? [];
    const future = f.upcoming.slice(0, 26);
    const sp = spiral({ past, future, now, nowTemp: f.temp, nights: nightsAround(place, now) });
    const s = svgEl('svg', { viewBox: '-40 -40 600 612', class: 'spiral', role: 'img',
        'aria-label': `The last 24 hours observed and the next 24 forecast, as a spiral colored by temperature` });

    svgEl('circle', { cx: SPIRAL.C, cy: SPIRAL.C, r: 272, class: 'sp-disk' }, s);
    // The plate behind the laps: blue, a deeper blue for the night's hours; each hour's cloud cover
    // a hard bar from the outer edge in, full when overcast
    for (const k of sp.skies) svgEl('path', { d: k.d, class: 'sp-sky' }, s);
    for (const n of sp.nights) svgEl('path', { d: n.d, class: 'sp-night' }, s);
    for (const h of sp.hours) if (h.bar) svgEl('path', { d: h.bar, class: h.night ? 'sp-cloud sp-cloud-night' : 'sp-cloud' }, s);
    // the hours: an invisible wedge each for its title; the cursor's hour lit in its temperature's color
    const wedgeAt = new Map();
    const hoursG = svgEl('g', {}, s);
    for (const h of sp.hours) {
        const w = svgEl('path', { d: h.d, class: 'sp-wedge' }, hoursG);
        if (!h.observed) wedgeAt.set(h.t, w);   // the cursor is on the forecast lap only
        const cover = h.cloud == null ? '' : ` · ${sky(h.cloud, h.night).toLowerCase()} (${Math.round(h.cloud)}% cloud)`;
        const wind = h.wind == null ? '' : ` · wind ${windText(h.dir, h.wind, h.gust).replace(/^Calm/, 'calm')}`;
        h.title = `${dayName(h.t)} ${hourText(h.t)}${h.night ? ', night' : ''}${cover}${wind}${h.observed ? ', observed' : ''}`;
        svgTitle(w, h.title);
    }
    const id = `sw${Math.random().toString(36).slice(2, 8)}`;
    const mask = svgEl('mask', { id }, svgEl('defs', {}, s));
    svgEl('path', { d: sp.track, class: sweep ? 'sp-sweep' : '', pathLength: 1, fill: 'none', stroke: '#fff', 'stroke-width': 44, 'stroke-linecap': 'round' }, mask);
    svgEl('circle', { cx: sp.notch.x, cy: sp.notch.y, r: sp.notch.r, fill: '#000' }, mask);   // the start arches into the band
    const g = svgEl('g', { mask: `url(#${id})` }, s);
    for (const seg of sp.segs) {
        const p = seg.tmp == null ? svgEl('path', { d: seg.d, class: 'sp-missing' }, g)
            : svgEl('path', { d: seg.d, fill: rampColor(seg.tmp), stroke: rampColor(seg.tmp), 'stroke-width': 0.6 }, g);
        const at = Math.round(seg.t / HOUR) * HOUR;
        svgTitle(p, `${dayName(at)} ${hourText(at)} · ${seg.tmp == null ? 'no observation' : deg(seg.tmp)}${seg.observed ? `, observed${hist?.station ? ` at ${hist.station.id}` : ''}` : ''}`);
    }
    const end = sp.caps[1];
    svgEl('circle', { cx: end.x, cy: end.y, r: end.r, ...(end.tmp == null ? { class: 'sp-missing' } : { fill: rampColor(end.tmp) }) }, g);
    // snow: a snowy forecast hour, or an observation whose weather reads snow
    const snowAt = t => (t < now ? /snow/i.test(hist?.hours?.find(h => h.t === t)?.text ?? '') : !!f.upcoming.find(r => r.t === t)?.snowy);
    for (const r of sp.rain) {
        const fr = r.t < now ? null : f.upcoming.find(x => x.t === r.t);
        const amount = fr?.snowy && fr.snow >= 0.05 ? `${rain(fr.snow, true)} snow` : `${rain(r.inches)} ${snowAt(r.t) ? 'snow' : 'rain'}`;
        svgTitle(svgEl('path', { d: r.d, class: 'sp-drop' }, g), `${dayName(r.t)} ${hourText(r.t)} · ${amount}${r.t < now ? ', observed' : ', forecast'}`);
    }

    for (const h of sp.hours) {
        if (!h.arrow) continue;
        const a = svgEl('g', { class: sweep ? 'sp-wind sp-late' : 'sp-wind' }, s);
        svgEl('line', { x1: h.arrow.x, y1: h.arrow.y, x2: h.arrow.x2.toFixed(1), y2: h.arrow.y2.toFixed(1) }, a);
        svgEl('path', { d: h.arrow.head }, a);
        svgTitle(a, h.title);
    }
    svgEl('circle', { cx: sp.now.x, cy: sp.now.y, r: 7, class: 'sp-now' }, s);
    svgEl('text', { x: sp.now.x, y: (sp.now.y - 17).toFixed(1), class: 'sp-now-label', 'text-anchor': 'middle' }, s).textContent = 'NOW';


    // Center: the day behind against the day ahead
    const { C } = SPIRAL, tb = sp.table;
    const cell = (x, y, cls, text, anchor = 'middle') => { svgEl('text', { x, y, class: cls, 'text-anchor': anchor }, s).textContent = text; };
    const orDash = (v, fmt) => (v == null ? '—' : fmt(v));
    cell(C - 46, C - 56, 'sp-th', 'Last 24 h');
    cell(C + 46, C - 56, 'sp-th', 'Next 24 h');
    const rows3 = [
        [future.some(r => r.snowy && r.qpf >= 0.01) ? 'snow' : 'rain', orDash(tb.pastRain, v => (v < 0.005 ? 'Dry' : rain(v))), tb.nextRain < 0.005 ? 'Dry' : rain(tb.nextRain), null],
        ['low', orDash(tb.pastLow, deg), orDash(tb.nextLow, deg), tb.nextLowAt],
        ['high', orDash(tb.pastHigh, deg), orDash(tb.nextHigh, deg), tb.nextHighAt],
    ];
    rows3.forEach(([k, a, b, at], i) => {
        const y = C - 18 + i * 44;
        cell(C - 46, y, 'sp-td', a);
        const nb = svgEl('text', { x: C + 46, y, class: 'sp-td', 'text-anchor': 'middle' }, s);
        nb.textContent = b;
        if (at) svgTitle(nb, `${cap(partOfDay(at, now))} around ${hourText(at)}`);
        cell(C, y + 15, 'sp-tl', k);
    });

    // The cursor on the spiral
    const mark = svgEl('circle', { r: 8, class: 'sp-cursor', visibility: 'hidden' }, s);
    const R = sv => SPIRAL.r0 + sv / 48 * (SPIRAL.r1 - SPIRAL.r0);
    let lit = null;
    onCursor(s, t => {
        // the cursor's hour lights its whole wedge, washed in its temperature's color
        const w = t == null ? null : wedgeAt.get(Math.floor(t / HOUR) * HOUR);
        if (w !== lit) {
            lit?.style.removeProperty('fill');
            const r = w && f.upcoming.find(x => x.t === Math.floor(t / HOUR) * HOUR);
            if (r?.tmp != null) w.style.fill = rampColor(r.tmp);
            lit = w;
        }
        const s0 = t == null ? null : 24 + (t - now) / HOUR;
        if (s0 == null || s0 < 23 || s0 > 48) { mark.setAttribute('visibility', 'hidden'); return; }
        // centered on its hour's wedge (the part of the current hour still ahead)
        const sv = Math.min(47.9, (Math.max(24, s0) + Math.min(48, s0 + 1)) / 2);
        const a = ((sv % 24) / 24) * 2 * Math.PI - Math.PI / 2;
        mark.setAttribute('cx', (C + R(sv) * Math.cos(a)).toFixed(1));
        mark.setAttribute('cy', (C + R(sv) * Math.sin(a)).toFixed(1));
        mark.setAttribute('visibility', 'visible');
    });
    s.hasHistory = !!hist;
    const last = f.upcoming[Math.min(f.upcoming.length - 1, 24)]?.t ?? now;
    if (f.upcoming.length) keyScrub(s, f.upcoming[0].t, last);
    scrubSurface(s, e => {
        const b = s.getBoundingClientRect();
        const x = -40 + (e.clientX - b.left) / b.width * 600, y = -40 + (e.clientY - b.top) / b.height * 612;
        if (Math.hypot(x - C, y - C) < SPIRAL.r0 - 20) return null;   // the table, not the ring
        const t = spiralTimeAt(x, y, now);
        // the hour whose wedge is under the finger (the current one included)
        return t < now || !f.upcoming.length ? null : Math.min(last, Math.max(f.upcoming[0].t, Math.floor(t / HOUR) * HOUR));
    });
    return s;
}

// A vertical gradient in temperature colors for an SVG line or band: from fTop (°F) at yTop to
// fBottom at yBottom, lightness kept legible on the page's theme. Returns a url() for style.
function tempGradient(svg, yTop, yBottom, fTop, fBottom) {
    const dark = document.documentElement.dataset.theme === 'dark';
    const id = `tg${Math.random().toString(36).slice(2, 8)}`;
    const g = svgEl('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0, y1: yTop, y2: yBottom }, svgEl('defs', {}, svg));
    for (let i = 0; i <= 8; i++) svgEl('stop', { offset: i / 8, 'stop-color': lineColor(fTop + (fBottom - fTop) * i / 8, dark) }, g);
    return `url(#${id})`;
}
const toF = v => (units.temp === 'C' ? v * 9 / 5 + 32 : v);

// ============ Readouts at the cursor ============

function gauge(v, a, b, marks) {
    const s = svgEl('svg', { viewBox: '0 0 140 30', class: 'mini', 'aria-hidden': 'true' });
    svgEl('rect', { x: 0, y: 13, width: 138, height: 4, class: 'mini-track' }, s);
    for (const m of marks) { const x = (m - a) / (b - a) * 138; svgEl('line', { x1: x, x2: x, y1: 8, y2: 22, class: 'mini-mark' }, s); }
    svgEl('circle', { cx: Math.max(6, Math.min(132, (v - a) / (b - a) * 138)), cy: 15, r: 6, class: 'mini-dot' }, s);
    return s;
}
function squares(n) {
    const s = svgEl('svg', { viewBox: '0 0 140 30', class: 'mini', 'aria-hidden': 'true' });
    for (let i = 0; i < 20; i++) svgEl('rect', { x: (i % 10) * 13 + 1, y: Math.floor(i / 10) * 13 + 3, width: 10, height: 10, class: i < n ? 'sq sq-on' : 'sq' }, s);
    return s;
}
// The Universal Pollen Index, 0-5, as five blocks
function pollenBar(v) {
    const s = svgEl('svg', { viewBox: '0 0 140 30', class: 'mini', 'aria-hidden': 'true' });
    for (let i = 0; i < 5; i++) svgEl('rect', { x: i * 28 + 1, y: 10, width: 24, height: 10, class: i < v ? 'sq sq-on' : 'sq' }, s);
    return s;
}
const POLLEN_WORDS = ['None', 'Very low', 'Low', 'Moderate', 'High', 'Very high'];
const POLLEN_TYPES = { tree: 'Trees', grass: 'Grass', weed: 'Weeds' };
const AQI_WORDS = [[50, 'Good'], [100, 'Moderate'], [150, 'Unhealthy for sensitive groups'], [200, 'Unhealthy'], [300, 'Very unhealthy'], [Infinity, 'Hazardous']];
function coverBar(pct) {
    const s = svgEl('svg', { viewBox: '0 0 140 30', class: 'mini', 'aria-hidden': 'true' });
    svgEl('rect', { x: 1, y: 10, width: 136, height: 10, class: 'sq' }, s);
    svgEl('rect', { x: 1, y: 10, width: 136 * Math.max(0, Math.min(1, pct / 100)), height: 10, class: 'sq-on' }, s);
    return s;
}
function windGlyph(dir, mph, gust) {
    const s = svgEl('svg', { viewBox: '0 0 140 30', class: 'mini', 'aria-hidden': 'true' });
    const a = (dir + 180) * Math.PI / 180, ux = Math.sin(a), uy = -Math.cos(a);
    const x0 = 22 - ux * 11, y0 = 15 - uy * 11, w = windArrow(x0, y0, dir, 22, 8);
    svgEl('line', { x1: x0, y1: y0, x2: w.x2, y2: w.y2, class: 'mini-shaft' }, s);
    svgEl('path', { d: w.head, class: 'mini-head' }, s);
    const X = v => 56 + Math.min(v, 40) / 40 * 80;
    svgEl('rect', { x: 56, y: 12, width: 80, height: 6, class: 'mini-track' }, s);
    svgEl('rect', { x: 56, y: 12, width: X(mph) - 56, height: 6, class: 'sq-on' }, s);
    if (gusty(mph, gust)) svgEl('line', { x1: X(gust), x2: X(gust), y1: 6, y2: 24, class: 'mini-mark' }, s);
    return s;
}
// The ensemble's 8-in-10 range around the forecast, its ends labeled
function band(lo, hi, v) {
    const s = svgEl('svg', { viewBox: '0 0 140 30', class: 'mini', 'aria-hidden': 'true' });
    if (lo == null) {
        svgEl('rect', { x: 0, y: 13, width: 138, height: 4, class: 'mini-track' }, s);
        return s;
    }
    const a = lo - (hi - lo) * 0.9 - 1, b = hi + (hi - lo) * 0.9 + 1;
    const X = x => Math.max(0, Math.min(138, (x - a) / (b - a) * 138));
    svgEl('rect', { x: 0, y: 19, width: 138, height: 3, class: 'mini-track' }, s);
    svgEl('rect', { x: X(lo), y: 15, width: Math.max(2, X(hi) - X(lo)), height: 11, rx: 5.5, fill: rampColor(v), class: 'mini-band' }, s);
    svgEl('circle', { cx: X(v), cy: 20.5, r: 3.5, class: 'mini-dot' }, s);
    svgEl('text', { x: X(lo), y: 10, class: 'mini-label', 'text-anchor': 'middle' }, s).textContent = deg(lo);
    svgEl('text', { x: X(hi), y: 10, class: 'mini-label', 'text-anchor': 'middle' }, s).textContent = deg(hi);
    return s;
}
function dayBar(rise, set, t) {
    const s = svgEl('svg', { viewBox: '0 0 140 30', class: 'mini', 'aria-hidden': 'true' });
    const d0 = zMidnight(t), X = ms => (ms - d0) / 86400000 * 138;
    svgEl('rect', { x: 0, y: 10, width: 138, height: 10, class: 'mini-night' }, s);
    if (rise && set) svgEl('rect', { x: X(rise), y: 10, width: X(set) - X(rise), height: 10, class: 'mini-day' }, s);
    svgEl('line', { x1: X(t), x2: X(t), y1: 5, y2: 25, class: 'mini-mark' }, s);
    return s;
}

const CELL_DETAIL = { feels: 'feels', dew: 'humidity', wind: 'wind', rain: 'precip', sun: 'sun' };

function readouts(place, f) {
    const sec = el('section', 'sg-cells');
    sec.setAttribute('aria-label', 'Conditions at the cursor time');
    // A card opens its detail in place, sliding down under the row
    const detail = el('section', 'sg-detail');
    const inner = el('div', 'sg-detail-inner');
    detail.append(inner);
    let open = null;
    // The detail sits in the grid right after the row of the card that opened it (cards span unevenly)
    const place_ = btn => {
        const last = [...sec.querySelectorAll('.sg-cell')].filter(c => c.offsetTop === btn.offsetTop).pop();
        if (last.nextElementSibling !== detail) last.after(detail);
    };
    const toggle = (key, btn) => {
        const closing = open === key;
        sec.querySelectorAll('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', 'false'));
        if (closing) { open = null; detail.classList.remove('open'); return; }
        open = key;
        btn.setAttribute('aria-expanded', 'true');
        place_(btn);
        detail.classList.add('open');
        renderDetail(inner, key, place, f);
        drawnW = Math.round(contentWidth(inner));   // as the observer reports it
    };
    // an open detail redraws when it has grown or shrunk 8 px from the width it was drawn at
    let drawnW = 0;
    new ResizeObserver(([e]) => {
        const w = Math.round(e.contentRect.width);
        if (open && Math.abs(w - drawnW) > 8) {
            const btn = sec.querySelector('[aria-expanded="true"]');
            if (btn) place_(btn);
            renderDetail(inner, open, place, f);
            drawnW = w;
        }
    }).observe(inner);
    const close = () => {
        if (!open) return;
        open = null;
        detail.classList.remove('open');
        sec.querySelectorAll('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    };
    // a tap anywhere outside the cards and the open detail closes it (click, so a scroll doesn't)
    document.addEventListener('click', function outside(e) {
        if (!sec.isConnected) { document.removeEventListener('click', outside); return; }
        if (open && !sec.contains(e.target)) close();
    });
    const keys = ['feels', 'dew', 'wind', 'sky', 'rain', 'later3', 'later12', 'sun', 'air', 'pollen'];
    const cells = Object.fromEntries(keys.map(k => {
        const c = el(CELL_DETAIL[k] ? 'button' : 'div', `sg-cell sg-cell-${k}`);
        if (CELL_DETAIL[k]) {
            c.type = 'button';
            c.setAttribute('aria-expanded', 'false');
            c.addEventListener('click', () => toggle(CELL_DETAIL[k], c));
        }
        const parts = { k: el('div', 'sg-cell-k'), v: el('div', 'sg-cell-v'), sub: el('div', 'sg-cell-sub'), mini: el('div', 'sg-cell-mini') };
        c.append(parts.k, parts.v, parts.sub, parts.mini);
        sec.append(c);
        return [k, parts];
    }));
    const put = (k, key, value, sub, mini) => {
        const c = cells[k];
        c.k.textContent = key;
        c.v.textContent = value;
        c.sub.textContent = sub;
        c.mini.replaceChildren(...(mini ? [mini] : []));
    };
    const draw = (t, ens) => {
        const now = t == null;
        const tt = t ?? Date.now();
        const r = rowAt(f, tt) || {};
        const tmp = now ? f.temp : r.tmp, dpt = now ? f.dpt : r.dpt, wind = now ? f.wind : r.wind;
        const dir = now ? f.dir ?? r.dir : r.dir, gust = now ? f.gust : r.gust;
        const feels = tmp != null && dpt != null ? feelsLike(tmp, dpt, wind ?? 0) : null;
        const diff = feels != null ? feels - tmp : 0;
        put('feels', 'Feels like', deg(feels), diff <= -2 ? 'The wind makes it feel colder.' : diff >= 2 ? 'Humidity makes it feel hotter.' : 'Same as the air temperature.', feels != null ? gauge(feels, 0, 110, [32, 80]) : null);
        const rh = tmp != null && dpt != null ? Math.round(humidity(tmp, dpt)) : null;
        put('dew', 'Dew point', deg(dpt), dpt != null ? `Feels ${comfort(dpt).toLowerCase()}.${rh != null ? ` Relative humidity ${rh}%.` : ''}` : '', dpt != null ? gauge(dpt, 30, 80, [55, 65]) : null);
        const gustN = gusty(wind, gust) ? `gusts ${Math.round(U.toWind(gust, units))}` : '';
        if (Math.round(U.toWind(wind ?? 0, units)) === 0) put('wind', 'Wind', 'Calm', gustN ? `${gustN} ${U.windUnit(units)}` : '', null);
        else put('wind', dir != null ? `Wind, from ${compass(dir)}` : 'Wind', String(Math.round(U.toWind(wind, units))),
            `${U.windUnit(units)}${gustN ? `, ${gustN}` : ''}`, dir != null ? windGlyph(dir, wind, gust) : null);
        const cloud = now ? f.nowRow?.cloud : r.cloud;
        const dark = now ? f.night : sunAltitude(tt, place.lat, place.lon) < -0.8;
        put('sky', 'Sky', cloud == null ? '--' : `${Math.round(cloud)}%`, cloud == null ? '' : sky(cloud, dark), cloud != null ? coverBar(cloud) : null);
        const day = f.days.find(d => d.key === zDay(tt));
        if (day?.pop != null) {
            cells.rain.mini.classList.add('mini-rain');
            // the day's hours still ahead of the cursor, where the hourly forecast reaches
            const left = f.rows.filter(x => zDay(x.t) === day.key && x.t + HOUR > tt);
            const wet = left.filter(x => x.qpf >= 0.01);
            const snowy = day.snow >= 0.1;
            const sub = wet.length
                ? `About ${snowy ? rain(wet.reduce((a, x) => a + x.snow, 0), true) : rain(wet.reduce((a, x) => a + x.qpf, 0))}.`
                : day.pop === 0 ? `No ${snowy ? 'snow' : 'rain'} expected.`
                    : day.qpf >= 0.01 ? `About ${snowy ? rain(day.snow, true) : rain(day.qpf)}.`
                        : left.length && day.pop < 20 ? 'Dry the rest of the day.' : '';
            put('rain', `Chance of ${snowy ? 'snow' : 'rain'} ${zDay(tt) === zDay(Date.now()) ? 'today' : zDate(tt, { weekday: 'short' })}`,
                `${day.pop}%`, sub, squares(Math.round(day.pop / 5)));
        } else put('rain', 'Rain this hour', precipText(r.qpf, r.snow, r.snowy), '', null);
        const ahead = (h, key) => {
            const at = tt + h * HOUR, rr = rowAt(f, at), rg = rangeAt(ens, at);
            const title = now ? `In ${h} hours` : `${h} hours later`;
            if (!rr || rr.t + HOUR < at) { put(key, title, '--', '', null); return; }
            const when = `${zDay(at) === zDay(Date.now()) ? '' : `${zDate(at, { weekday: 'short' })} `}${hourText(at)}`;
            put(key, title, deg(rr.tmp), rg ? `${when} · ensemble ${U.span(deg(rg.lo), deg(rg.hi))}` : when, band(rg?.lo, rg?.hi, rr.tmp));
        };
        ahead(3, 'later3');
        ahead(12, 'later12');
        const st = sunTimes(zNoon(tt), place.lat, place.lon, zone), st2 = sunTimes(zNoon(tt) + 86400000, place.lat, place.lon, zone);
        const events = [[st.rise, 'Sunrise'], [st.set, 'Sunset'], [st2.rise, 'Sunrise'], [st2.set, 'Sunset']].filter(([x]) => x && x > tt);
        if (events.length) {
            const [when, name] = events[0];
            const len = st.rise && st.set ? Math.round((st.set - st.rise) / 60000) : null;
            put('sun', name, timeOf(when), len != null ? `${Math.floor(len / 60)} h ${len % 60} m of daylight.` : '', dayBar(st.rise, st.set, tt));
        }
        // air is the latest hour measured, whatever the cursor; pollen follows the cursor's day
        const aq = air?.air;
        if (aq) {
            const m = aq[aq.main];
            put('air', 'Air quality', String(aq.aqi), `${AQI_WORDS.find(([top]) => aq.aqi <= top)[1]}. ${aq.main === 'pm25' ? 'Fine particles' : 'Ozone'} at ${m.site}, ${Math.round(m.km)} km.`,
                gauge(Math.min(aq.aqi, 200), 0, 200, [50, 100, 150]));
        } else put('air', 'Air quality', '--', '', null);
        const pd = air?.pollen?.find(d => d.date === zDay(tt));
        const worst = pd && Math.max(...['tree', 'grass', 'weed'].map(x => pd[x] ?? -1));
        if (worst >= 0) {
            const main = ['weed', 'grass', 'tree'].filter(x => pd[x] === worst && worst > 0);
            put('pollen', `Pollen ${zDay(tt) === zDay(Date.now()) ? 'today' : zDate(tt, { weekday: 'short' })}`, String(worst),
                `${POLLEN_WORDS[worst]}.${main.length ? ` Mostly ${(pd.plants.length ? pd.plants.slice(0, 2) : main.map(x => POLLEN_TYPES[x])).join(' and ').toLowerCase()}.` : ''}`,
                pollenBar(worst));
        } else put('pollen', 'Pollen', '--', '', null);
    };
    let shownT = null, shownEns = null, air = null;
    const update = (t, ens) => { shownT = t; shownEns = ens; draw(t, ens); };
    airFor(place).then(a => { if (a && sec.isConnected) { air = a; lock(); } });
    // Scrubbing must not move the page: every card holds the height of the tallest reading over
    // the hours the cursor reaches, measured once in place and again when the width changes
    const lock = () => {
        if (!sec.isConnected) return;
        sec.style.removeProperty('--cell-h');
        const cards = [...sec.querySelectorAll('.sg-cell')];
        let tall = 0;
        for (const t of [null, ...f.upcoming.slice(0, HOURS_SHOWN + 1).map(x => x.t)]) {
            draw(t, shownEns);
            for (const c of cards) tall = Math.max(tall, c.offsetHeight);
        }
        draw(shownT, shownEns);
        sec.style.setProperty('--cell-h', `${tall}px`);
    };
    // measured again once the width settles (a window drag would redraw every hour each frame)
    let lockedW = 0, settle = 0;
    new ResizeObserver(([e]) => {
        const w = Math.round(e.contentRect.width);
        if (!w || Math.abs(w - lockedW) <= 1) return;
        const first = !lockedW;
        lockedW = w;
        clearTimeout(settle);
        if (first) lock(); else settle = setTimeout(lock, 150);
    }).observe(sec);
    // the display font wraps lines differently than the fallback
    if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(lock);
    update(null, null);
    sec.append(detail);
    return { sec, update, lock };
}

// ============ 48 hours ============

function hoursSection(place, f, ens0) {
    const rows = f.upcoming.slice(0, HOURS_SHOWN);
    if (rows.length < 2) return null;
    const sec = el('section', 'sg-hours');
    sec.setAttribute('aria-label', 'Next 48 hours');
    const wrap = el('div', 'sg-chart');
    wrap.title = 'Line: the RRFS forecast. Band: where 8 in 10 REFS ensemble runs fall, the middle half darker. Columns: cloud cover. Arrows point the way the wind blows; longer is stronger.';
    const card = el('div', 'sg-card');
    card.hidden = true;
    wrap.append(card);
    sec.append(wrap);
    let ens = ens0;
    let redraw = () => {};

    const draw = () => {
        const W = Math.max(300, wrap.clientWidth);
        const narrow = W < 700;
        const L = 40, Rm = narrow ? 30 : 64, HT = narrow ? 220 : 340, STRIP = 22, CLOUD = narrow ? 36 : 44, WIND = narrow ? 72 : 96, HRS = 26;
        const C0 = HT + STRIP + 26, W0 = C0 + CLOUD + 26;   // tops of the cloud and wind lanes
        const H = W0 + WIND + HRS;
        const x0 = rows[0].t, x1 = rows[rows.length - 1].t;
        const X = t => L + (t - x0) / (x1 - x0) * (W - L - Rm);
        const ensIn = ens ? ens.filter(m => m.x >= x0 - 3 * HOUR && m.x <= x1 + 3 * HOUR) : [];
        let paint = null;   // the temperature gradient, set once the scale is known
        const vals = [...rows.map(r => r.tmp), ...ensIn.flatMap(m => [m.p10, m.p90])].map(v => U.toTemp(v, units));
        let lo = Math.min(...vals), hi = Math.max(...vals);
        const pad = Math.max(1.5, (hi - lo) * 0.12);
        lo -= pad; hi += pad;
        const Y = v => 26 + (1 - (U.toTemp(v, units) - lo) / (hi - lo)) * (HT - 34);
        const s = svgEl('svg', { width: W, height: H, class: 'sg-svg', role: 'img', 'aria-label': 'Temperature and wind for the next 48 hours' });
        paint = tempGradient(s, 26, HT - 8, toF(hi), toF(lo));

        // grid
        const step = (hi - lo) > 24 ? 10 : (hi - lo) > 12 ? 5 : 2;
        for (let v = Math.ceil(lo / step) * step; v < hi; v += step) {
            const y = 26 + (1 - (v - lo) / (hi - lo)) * (HT - 34);
            svgEl('line', { x1: L, x2: W - Rm, y1: y, y2: y, class: 'g-grid' }, s);
            svgEl('text', { x: 0, y: y + 4, class: 'g-axis' }, s).textContent = `${v}°`;
        }
        // days
        for (const t of zMidnights(x0, x1)) {
            svgEl('line', { x1: X(t), x2: X(t), y1: 0, y2: H - HRS, class: 'g-day' }, s);
            svgEl('text', { x: X(t) + 8, y: 16, class: 'g-dayname' }, s).textContent = zDate(t, { weekday: 'long' });
        }
        // the hours as color
        const bw = (W - L - Rm) / (rows.length - 1);
        for (const r of rows) {
            const rect = svgEl('rect', { x: X(r.t) - bw / 2, y: HT, width: bw + 0.5, height: STRIP, fill: rampColor(r.tmp) }, s);
            svgTitle(rect, `${weekday(r.t)} ${hourText(r.t)} · ${deg(r.tmp)}`);
        }
        // the ensemble's spread as a band: 8 in 10 runs, and the middle half darker
        if (ensIn.length > 1) {
            const clipId = `hc${Math.random().toString(36).slice(2, 8)}`;
            svgEl('rect', { x: L, y: 0, width: W - L - Rm, height: HT }, svgEl('clipPath', { id: clipId }, svgEl('defs', {}, s)));
            const g = svgEl('g', { 'clip-path': `url(#${clipId})` }, s);
            const area = (a, b, cls) => {
                const top = ensIn.map(m => [X(m.x), Y(m[b])]);
                const bot = ensIn.map(m => [X(m.x), Y(m[a])]).reverse();
                svgEl('path', { d: `${monotonePath(top)}L${monotonePath(bot).slice(1)}Z`, class: cls }, g);
            };
            area('p10', 'p90', 'g-band');
            area('p25', 'p75', 'g-band g-band-mid');
            g.querySelectorAll('.g-band').forEach(b => { b.style.fill = paint; });
        }
        // rain and snow, hourly
        for (const r of rows) {
            if (!(r.qpf >= 0.01)) continue;
            const h = Math.min(40, 6 + r.qpf * 160);
            const b = svgEl('rect', { x: X(r.t) - Math.max(2, bw * 0.3), y: HT - h, width: Math.max(4, bw * 0.6), height: h, class: r.snowy ? 'g-rain g-snow' : 'g-rain' }, s);
            svgTitle(b, `${weekday(r.t)} ${hourText(r.t)} · ${precipText(r.qpf, r.snow, r.snowy)}`);
        }
        // the forecast
        svgEl('path', { d: monotonePath(rows.map(r => [X(r.t), Y(r.tmp)])), class: 'g-line' }, s).style.stroke = paint;
        if (!narrow) {
            const lastR = rows[rows.length - 1];
            svgEl('text', { x: X(lastR.t) + 8, y: Y(lastR.tmp) + 4, class: 'g-end' }, s).textContent = 'forecast';
            if (ensIn.length > 1) {
                const lm = ensIn[ensIn.length - 1];
                if (lm.x <= x1 + 3 * HOUR) svgEl('text', { x: Math.min(X(lm.x), W - Rm) + 8, y: Y(lm.p10) + 16, class: 'g-end g-end-soft' }, s).textContent = '8 in 10';
            }
        }
        // cloud cover lane: a column per hour, as tall as the sky is covered
        svgEl('text', { x: 0, y: C0 - 4, class: 'g-lane' }, s).textContent = 'Cloud cover';
        svgEl('rect', { x: L, y: C0, width: W - L - Rm, height: CLOUD, class: 'g-lane-bg' }, s);
        for (const r of rows) {
            if (r.cloud == null) continue;
            const h = CLOUD * Math.min(100, r.cloud) / 100;
            svgTitle(svgEl('rect', { x: X(r.t) - bw / 2, y: C0 + CLOUD - h, width: bw + 0.5, height: h, class: 'g-cloud' }, s),
                `${weekday(r.t)} ${hourText(r.t)} · ${Math.round(r.cloud)}% cloud cover`);
        }
        // wind lane
        const wy = W0 + WIND / 2 - 8;
        svgEl('text', { x: 0, y: W0 - 4, class: 'g-lane' }, s).textContent = `Wind, ${U.windUnit(units)}`;
        const every = narrow ? 3 : bw < 12 ? 2 : 1;
        rows.forEach((r, i) => {
            if (i % every) return;
            const len = 4 + Math.min(r.wind, 30) * (narrow ? 1.1 : 1.6);
            const w = windArrow(X(r.t), wy, r.dir, len, narrow ? 4 : 6);
            const g = svgEl('g', { class: 'g-wind' }, s);
            svgEl('line', { x1: X(r.t), y1: wy, x2: w.x2, y2: w.y2 }, g);
            svgEl('path', { d: w.head }, g);
            svgEl('circle', { cx: X(r.t), cy: wy, r: 1.8 }, g);
            svgTitle(g, `${weekday(r.t)} ${hourText(r.t)} · wind ${windText(r.dir, r.wind, r.gust).replace(/^Calm/, 'calm')}`);
        });
        rows.forEach((r, i) => {
            if (i % (narrow ? 6 : 3)) return;
            svgEl('text', { x: X(r.t), y: W0 + WIND - 2, class: `g-speed${r.wind >= 15 ? ' strong' : ''}`, 'text-anchor': 'middle' }, s).textContent = Math.round(U.toWind(r.wind, units));
            svgEl('text', { x: X(r.t), y: H - 6, class: 'g-hour', 'text-anchor': 'middle' }, s).textContent = hourOf(r.t);
        });
        // now, and the cursor
        const now = Date.now();
        if (now >= x0 && now <= x1) svgEl('line', { x1: X(now), x2: X(now), y1: 22, y2: H - HRS, class: 'g-now' }, s);
        const cur = svgEl('line', { y1: 22, y2: H - HRS, class: 'g-cursor', visibility: 'hidden' }, s);
        const dot = svgEl('circle', { r: 7, class: 'g-dot', visibility: 'hidden' }, s);
        const old = wrap.querySelector('svg'), hadFocus = old && old === document.activeElement;
        old?.remove();
        wrap.prepend(s);

        const show = t => {
            if (t == null) { cur.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); card.hidden = true; return; }
            const r = rowAt(f, t);
            const x = X(r.t);
            cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.setAttribute('visibility', 'visible');
            dot.setAttribute('cx', x); dot.setAttribute('cy', Y(r.tmp)); dot.setAttribute('visibility', 'visible');
            const rg = rangeAt(ens, r.t);
            card.hidden = false;
            const w = windText(r.dir, r.wind, r.gust);
            card.replaceChildren(el('div', 'sg-card-k', `${weekday(r.t)} ${hourText(r.t)}`),
                el('div', 'sg-card-v', deg(r.tmp)),
                el('div', 'sg-card-sub', [rg ? `${U.span(deg(rg.lo), deg(rg.hi))}, 8 in 10 runs.` : null,
                    `${condition(r, sunAltitude(r.t, place.lat, place.lon) < -0.8).label}, ${w.startsWith('Calm') ? w.toLowerCase() : `wind ${w}`}.`].filter(Boolean).join(' ')));
            const cw = Math.min(260, W * 0.45);
            card.style.width = `${cw}px`;
            card.style.left = `${x + 18 + cw > W ? x - 18 - cw : x + 18}px`;
        };
        redraw = () => show(cursor.t);
        show(cursor.t);
        keyScrub(s, x0, x1);
        if (hadFocus) s.focus();
        scrubSurface(s, e => {
            const b = s.getBoundingClientRect();
            const t = x0 + (e.clientX - b.left - L) / (W - L - Rm) * (x1 - x0);
            return Math.min(x1, Math.max(x0, Math.round(t / HOUR) * HOUR));
        });
    };
    onCursor(sec, () => redraw());
    let lastW = 0, timer = 0;
    new ResizeObserver(([e]) => {
        const w = Math.round(e.contentRect.width);
        if (w && w !== lastW) { const first = !lastW; lastW = w; clearTimeout(timer); timer = setTimeout(draw, first ? 0 : 120); }
    }).observe(wrap);
    return { sec, setEnsemble: e => { ens = e; if (wrap.isConnected && wrap.clientWidth) draw(); } };
}

// ============ Days ============

function daysSection(f) {
    const days = f.days;
    if (!days.length) return null;
    const sec = el('section', 'sg-days');
    sec.setAttribute('aria-label', `${days.length} days`);
    const lowOf = d => d.lo ?? (d.key === zDay(Date.now()) ? f.temp : null) ?? d.hi;
    const his = days.map(d => d.hi).filter(v => v != null), los = days.map(lowOf).filter(v => v != null);
    const lo = Math.min(...los) - 2, hi = Math.max(...his) + 2;
    const pos = v => `${((v - lo) / (hi - lo) * 100).toFixed(2)}%`;
    const table = el('div', 'sg-daylist');
    const axis = el('div', 'sg-day sg-day-axis');
    const scale = el('div', 'sg-day-bar');
    const step = hi - lo > 40 ? 10 : 5;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        const tick = el('span', 'sg-tick', U.deg(v, units));
        tick.style.left = pos(v);
        scale.append(tick);
    }
    const anySnow = days.some(d => d.snow >= 0.1);
    axis.append(el('span'), el('span', 'sg-day-date'), el('span'), scale, el('span', 'sg-day-colh', anySnow ? 'Chance of rain or snow' : 'Chance of rain'), el('span', 'sg-day-colh sg-right', 'Amount'));
    table.append(axis);
    for (const d of days) {
        const row = el('div', 'sg-day');
        const low = d.lo ?? (d.key === zDay(Date.now()) ? f.temp : null) ?? null;
        const name = el('span', 'sg-day-name', weekday(d.t));
        const date = el('span', 'sg-day-date', zDate(d.t, { month: 'short', day: 'numeric' }));
        const look = el('span', 'sg-day-ic');   // the day at a glance
        look.append(icon(d.cond.key));
        look.title = d.cond.label;
        const barBox = el('div', 'sg-day-bar');
        if (d.hi != null) {
            const l = low ?? d.hi;
            const bar = el('div', 'sg-day-fill');
            bar.style.left = pos(l);
            bar.style.width = `${((d.hi - l) / (hi - lo) * 100).toFixed(2)}%`;
            bar.style.background = `linear-gradient(90deg, ${rampColor(l)}, ${rampColor(d.hi)})`;
            const lt = el('span', 'sg-day-lo', low == null ? '' : deg(low));
            lt.style.left = pos(l);
            const ht = el('span', 'sg-day-hi', deg(d.hi));
            ht.style.left = pos(d.hi);
            barBox.append(bar, lt, ht);
        }
        const n = d.pop != null ? Math.round(d.pop / 5) : 0;
        const sq = el('div', 'sg-squares');
        sq.title = d.pop != null ? `${d.pop}% chance of ${anySnow ? 'rain or snow' : 'rain'}` : 'No chance given';
        for (let i = 0; i < 20; i++) sq.append(el('i', i < n ? 'on' : ''));
        const snow = d.snow >= 0.1;
        const amt = el('span', 'sg-day-amt sg-right', (d.pop ?? 0) >= 30 && (snow || d.qpf >= 0.01) ? `${rain(snow ? d.snow : d.qpf, snow)}${snow ? ' snow' : ''}` : '');
        row.append(name, date, look, barBox, sq, amt, dayMore(d, f));
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-expanded', 'false');
        const flip = () => row.setAttribute('aria-expanded', String(row.classList.toggle('open')));
        row.addEventListener('click', flip);
        row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
        table.append(row);
    }
    sec.append(table);
    return sec;
}

// The day opened: hour by hour where the hourly forecast reaches (temperature, cloud cover, rain),
// else the NBM day's cloud cover, wind and rain
function dayMore(d, f) {
    const box = el('div', 'sg-day-more');
    const inner = el('div', 'sg-day-more-inner');
    // today: the hours still ahead
    const today = d.key === zDay(Date.now());
    const hrs = f.rows.filter(r => zDay(r.t) === d.key && (!today || r.t + HOUR > Date.now()));
    const snow = d.snow >= 0.1;
    // hour by hour only where the hourly forecast reaches the day's end and (but today) starts at its start;
    // otherwise the day's overview
    if (hrs.length && (today || zDay(hrs[0].t - HOUR) !== d.key) && zDay(hrs[hrs.length - 1].t + HOUR) !== d.key) {
        const grid = el('div', 'sg-ribbon');
        grid.style.setProperty('--hrs', hrs.length);
        const lane = (name, make) => {
            grid.append(el('span', 'sg-ribbon-k', name));
            hrs.forEach((r, i) => grid.append(make(r, i)));
        };
        lane('Temperature', (r, i) => {
            const c = el('div', 'sg-rb-t', i % 3 === 0 ? deg(r.tmp) : '');
            c.style.background = rampColor(r.tmp);
            c.title = `${hourText(r.t)} · ${deg(r.tmp)}`;
            return c;
        });
        lane('Cloud cover', r => {
            const c = el('div', 'sg-rb-c');
            const i = el('i');
            i.style.height = `${Math.round(r.cloud ?? 0)}%`;
            c.append(i);
            c.title = `${hourText(r.t)} · ${Math.round(r.cloud ?? 0)}% cloud cover`;
            return c;
        });
        lane(snow ? 'Snow' : 'Rain', r => {
            const c = el('div', 'sg-rb-r');
            if (r.qpf >= 0.01) {
                const i = el('i');
                i.style.height = `${Math.min(100, 20 + r.qpf * 400)}%`;
                c.append(i);
            }
            c.title = `${hourText(r.t)} · ${precipText(r.qpf, r.snow, r.snowy)}`;
            return c;
        });
        lane('', (r, i) => el('span', 'sg-rb-h', i % 3 === 0 ? hourOf(r.t) : ''));
        inner.append(grid);
    } else {
        const stats = el('div', 'sg-day-stats');
        const stat = (k, v, pct) => {
            const e = el('div', 'sg-stat');
            e.append(el('span', null, k), el('b', null, v));
            if (pct != null) { const bar = el('i'); const fill = el('i'); fill.style.width = `${Math.max(0, Math.min(100, pct))}%`; bar.append(fill); e.append(bar); }
            stats.append(e);
        };
        if (d.cloud != null) stat('Cloud cover', `${Math.round(d.cloud)}%`, d.cloud);
        if (d.wind != null) stat('Wind', windText(null, d.wind));
        if (gusty(d.wind, d.gust)) stat('Gusts', windStr(d.gust));
        if (d.pop != null) stat(`Chance of ${snow ? 'snow' : 'rain'}`, `${d.pop}%`, d.pop);
        if (d.qpf >= 0.01 || snow) stat(snow ? 'Snow' : 'Rain', rain(snow ? d.snow : d.qpf, snow));
        else if ((d.pop ?? 0) < 20) stat('Rain', 'Dry');
        inner.append(stats);
    }
    box.append(inner);
    return box;
}

// ============ Ensemble plumes ============

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

function plumePanel(f) {
    const st = f.raw.station;
    if (!st || st.km > ENSEMBLE_MAX_KM) return null;
    const sec = el('section', 'plume-panel');
    sec.setAttribute('aria-label', 'Ensemble plumes');
    const head = el('div', 'panel-head');
    const tabs = el('div', 'seg');
    head.append(tabs);
    const readout = el('div', 'plume-readout');
    const trend = el('div', 'plume-trend');
    const chart = el('div', 'plume-chart');
    const legend = el('div', 'plume-legend');
    const foot = el('div', 'panel-foot');
    const more = el('a', 'text-link', `Full plumes for ${st.id}`);
    more.href = `/plumes?station=${encodeURIComponent(st.id)}&model=refs`;
    foot.append(el('span', null, `REFS ensemble at ${st.id}, ${st.km} km away`), more);
    sec.append(head, trend, readout, chart, legend, foot);

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
    const mean = d.Mean.filter(m => m.x >= now - 3 * HOUR);
    if (mean.length < 2) { readout.textContent = 'Ensemble not available right now'; return; }
    const x0 = mean[0].x, x1 = mean[mean.length - 1].x;
    const det = d.RRFS.filter(p => p.x >= x0 - HOUR && p.x <= x1 + HOUR && p.y != null);
    const c = v => spec.conv(v);
    const vals = [...mean.flatMap(m => [c(m.p10), c(m.p90)]), ...det.map(p => c(p.y)),
        ...prevs.flatMap(p => p.mean.filter(m => m.x >= x0 && m.x <= x1).map(m => c(m.y)))];
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.12 || 1;
    hi += pad;
    lo = spec.total ? 0 : spec.key === 'wind' ? Math.max(0, lo - pad) : lo - pad;   // no negative wind
    const X = t => L + (t - x0) / (x1 - x0) * (W - L - R);
    const Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const s = svgEl('svg', { width: W, height: H, class: `plume-svg plume-${spec.key}`, role: 'img', 'aria-label': `${spec.label} ensemble plume` });
    const paint = spec.key === 'temp' ? tempGradient(s, Y(hi), Y(lo), toF(hi), toF(lo)) : null;

    for (let k = 0; k <= 3; k++) {
        const v = lo + (hi - lo) * k / 3;
        svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'grid' }, s);
        svgEl('text', { x: L - 6, y: Y(v), class: 'axis axis-y', 'dominant-baseline': 'central' }, s).textContent = spec.fmt(v);
    }
    for (const t of zMidnights(x0, x1)) {
        svgEl('line', { x1: X(t), x2: X(t), y1: T, y2: H - B, class: 'grid grid-day' }, s);
        svgEl('text', { x: X(t) + 4, y: H - 8, class: 'axis' }, s).textContent = zDate(t, { weekday: 'short' });
    }
    const area = (a, b, cls) => {
        const top = mean.map(m => [X(m.x), Y(c(m[b]))]);
        const bot = mean.map(m => [X(m.x), Y(c(m[a]))]).reverse();
        svgEl('path', { d: `${monotonePath(top)}L${bot.map(p => p.map(n => n.toFixed(1)).join(',')).join('L')}Z`, class: cls }, s);
    };
    area('p10', 'p90', 'plume-outer');
    area('p25', 'p75', 'plume-inner');
    if (paint) s.querySelectorAll('.plume-outer, .plume-inner').forEach(b => { b.style.fill = paint; });
    const clipT = p => p.x >= x0 && p.x <= x1;
    prevs.slice().reverse().forEach((p, k) => {
        const pts = p.mean.filter(clipT).map(m => [X(m.x), Y(c(m.y))]);
        if (pts.length > 1) svgEl('path', { d: monotonePath(pts), class: `plume-prev prev${prevs.length - 1 - k}` }, s);
    });
    const detIn = det.filter(clipT);
    if (detIn.length > 1) {
        const det = svgEl('path', { d: monotonePath(detIn.map(p => [X(p.x), Y(c(p.y))])), class: 'plume-det' }, s);
        if (paint) det.style.stroke = paint;
    }
    const meanPath = svgEl('path', { d: monotonePath(mean.map(m => [X(m.x), Y(c(m.y))])), class: 'plume-mean' }, s);
    if (paint) meanPath.style.stroke = paint;

    const cursorLine = svgEl('line', { y1: T, y2: H - B, class: 'plume-cursor' }, s);
    const dot = svgEl('circle', { r: 4, class: 'plume-dot' }, s);
    const at = t => {
        const m = interp(mean, t);
        if (m == null) return;
        cursorLine.setAttribute('x1', X(t));
        cursorLine.setAttribute('x2', X(t));
        dot.setAttribute('cx', X(t));
        dot.setAttribute('cy', Y(c(m)));
        const r = interp(det, t);
        const when = `${zDate(t, { weekday: 'short' })} ${timeOf(t)}`;
        readout.replaceChildren(el('b', null, when), el('span', null, `Mean ${spec.fmt(c(m))}`),
            el('span', null, `8 in 10: ${U.span(spec.fmt(c(interp(mean, t, 'p10'))), spec.fmt(c(interp(mean, t, 'p90'))))}`),
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
    at(Math.min(x1, Math.max(x0, Math.round((now + 21 * HOUR) / HALF_HOUR) * HALF_HOUR)));
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
    const sec = el('section', 'radar-panel');
    sec.setAttribute('aria-label', 'Map');
    const frame = el('div', 'radar-frame');
    const open = el('button', 'wx-icon-btn radar-expand');
    open.setAttribute('aria-label', 'Open the radar full screen');
    open.append(icon('expand'));
    const close = el('button', 'wx-icon-btn radar-close');
    close.setAttribute('aria-label', 'Close the radar');
    close.append(icon('close'));
    frame.append(open, close);
    sec.append(frame);

    let iframe = null;
    const post = msg => iframe?.contentWindow?.postMessage({ type: 'wx-radar', ...msg }, location.origin);
    const load = () => {
        if (iframe) return;
        iframe = el('iframe');
        iframe.title = 'Radar map';
        iframe.loading = 'lazy';
        iframe.src = `/radar?embed=1&theme=${document.documentElement.dataset.theme}${zone ? `&tz=${encodeURIComponent(zone)}` : ''}#7.6/${place.lat.toFixed(4)}/${place.lon.toFixed(4)}`;
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

function placeFooter(place, f) {
    const foot = el('footer', 'sg-foot');
    const src = [];
    if (f.obs) src.push(`Observed ${timeOf(f.obs.time * 1000)}, NOAA RTMA`);
    if (f.raw.hourly) src.push(`Hours: RRFS ${f.raw.hourly.run.slice(8)}Z`);
    if (f.raw.station) src.push(`Ensemble: REFS at ${f.raw.station.id}`);
    if (f.raw.daily_run) src.push(`Days: NBM ${f.raw.daily_run.slice(8)}Z`);
    foot.append(el('span', null, src.join(' · ')));
    const links = el('span', 'sg-foot-links');
    const a = el('a', null, 'Radar map');
    a.href = `/radar?layer=radar#8.5/${place.lat.toFixed(4)}/${place.lon.toFixed(4)}`;
    links.append(a);
    foot.append(links);
    return foot;
}

// ============ Detail sheets ============


// Today's hourly UV estimate from the sun's elevation and the forecast cloud cover
function uvHours(place, f) {
    const today = zDay(Date.now());
    return f.rows.filter(r => zDay(r.t) === today).map(r => ({ t: r.t, uv: uvIndex(sunAltitude(r.t, place.lat, place.lon), r.cloud) }));
}

// The sun's altitude over the whole local day: above the horizon lit, below it dim; the sun where it is now
function sunCurve(place) {
    const W = 160, H = 90, BASE = 56;
    const day = zMidnight(Date.now());
    const noon = solarNoon(zNoon(Date.now()), place.lat, place.lon, zone);
    const up = Math.max(noon.alt, 10), down = 28;
    const X = t => (t - day) / 86400000 * W;
    // Night side capped at `down` degrees below the horizon, so the curve stays in its box
    const Y = alt => BASE - (alt >= 0 ? alt / up * (BASE - 6) : Math.max(alt, -down) / down * (H - BASE - 4));
    const pts = [];
    for (let t = day; t <= day + 86400000; t += 15 * 60000) pts.push([X(t), Y(sunAltitude(t, place.lat, place.lon))]);
    const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sun-arc', 'aria-hidden': 'true' });
    const path = monotonePath(pts);
    svgEl('path', { d: path, class: 'sun-night' }, s);
    const clip = svgEl('clipPath', { id: 'sunlit' }, svgEl('defs', {}, s));
    svgEl('rect', { x: 0, y: 0, width: W, height: BASE }, clip);
    svgEl('path', { d: path, class: 'sun-day', 'clip-path': 'url(#sunlit)' }, s);
    svgEl('line', { x1: 0, x2: W, y1: BASE, y2: BASE, class: 'horizon' }, s);
    const alt = sunAltitude(Date.now(), place.lat, place.lon);
    svgEl('circle', { cx: X(Date.now()), cy: Y(alt), r: 5.5, class: alt > 0 ? 'sun-dot' : 'sun-dot sun-below' }, s);
    return s;
}

function moonDisk(size) {
    const m = moonPhase(Date.now());
    const s = svgEl('svg', { viewBox: '0 0 80 80', class: 'moon', 'aria-hidden': 'true', width: size, height: size });
    svgEl('circle', { cx: 40, cy: 40, r: 30, class: 'moon-dark' }, s);
    svgEl('path', { d: moonPath(40, 40, 30, m.phase), class: 'moon-lit' }, s);
    return s;
}

function rowsList(rows) {
    const dl = el('dl', 'detail-rows');
    for (const [k, v] of rows) {
        if (v == null) continue;
        dl.append(el('dt', null, k), el('dd', null, v));
    }
    return dl;
}

const contentWidth = node => node.clientWidth - 2 * parseFloat(getComputedStyle(node).paddingLeft || 0);
let detailWidth = 520;   // the open detail's inner width; its charts fill it
function renderDetail(body, key, place, f) {
    detailWidth = contentWidth(body);
    const hrs = f.upcoming.slice(0, 48);
    const T = v => U.toTemp(v, units);
    const content = {
        sun: () => {
            const now = Date.now();
            const noonMs = zNoon(now);
            const c = h => sunCross(noonMs, place.lat, place.lon, h, zone);
            const [ast, nau, civ, rs, gold] = [-18, -12, -6, -0.833, 6].map(c);
            const noon = solarNoon(noonMs, place.lat, place.lon, zone);
            const len = rs.up && rs.down ? rs.down - rs.up : null;
            const y = sunTimes(noonMs - 86400000, place.lat, place.lon, zone);
            const change = len && y.rise && y.set ? Math.round((len - (y.set - y.rise)) / 1000) : null;
            const t = v => (v ? timeOf(v) : '--');
            const m = moonPhase(now);
            const today = moonTimes(noonMs, place.lat, place.lon, zone), tmr = moonTimes(noonMs + 86400000, place.lat, place.lon, zone);
            const tm = v => (v ? timeOf(v) : 'none');
            const date = ms => zDate(ms, { weekday: 'short', month: 'short', day: 'numeric' });
            const u = uvHours(place, f), peak = u.reduce((a, h) => (h.uv > (a?.uv ?? -1) ? h : a), null);
            return [sunCurve(place), rowsList([
                ['Astronomical dawn', t(ast.up)], ['Nautical dawn', t(nau.up)], ['Civil dawn', t(civ.up)],
                ['Sunrise', t(rs.up)], ['Morning golden hour ends', t(gold.up)],
                ['Solar noon', `${t(noon.t)} · ${Math.round(noon.alt)}° high`],
                ['Evening golden hour begins', t(gold.down)], ['Sunset', t(rs.down)], ['Civil dusk', t(civ.down)],
                ['Nautical dusk', t(nau.down)], ['Astronomical dusk', t(ast.down)],
                ['Daylight', len ? `${Math.floor(Math.round(len / 60000) / 60)} h ${Math.round(len / 60000) % 60} m` : '--'],
                ['Change from yesterday', change == null ? null : `${change < 0 ? '−' : '+'}${Math.floor(Math.abs(change) / 60)} min ${Math.abs(change) % 60} s`],
                ['UV peak today', peak ? `${Math.round(peak.uv)} (${uvCategory(peak.uv).toLowerCase()}) around ${hourText(peak.t)}, estimated` : null],
            ]), el('div', 'detail-moon'), rowsList([
                ['Moon', `${m.name}, ${Math.round(m.illum * 100)}% lit`],
                ['Moonrise today', tm(today.rise)], ['Moonset today', tm(today.set)],
                ['Moonrise tomorrow', tm(tmr.rise)], ['Moonset tomorrow', tm(tmr.set)],
                ...nextPhases(now).map(p => [p.name, date(p.t)]),
            ])];
        },
        // the gust line meets the wind line where gusts don't beat it by 5 mph, and the readout leaves them out
        wind: () => [seriesChart(hrs, [{ get: r => U.toWind(gusty(r.wind, r.gust) ? r.gust : r.wind, units), cls: 'line-gust', label: 'Gusts', hide: r => !gusty(r.wind, r.gust) },
            { get: r => U.toWind(r.wind, units), cls: 'line-main', label: 'Wind' }], { fmt: v => `${Math.round(v)} ${U.windUnit(units)}`, zero: true }),
            rowsList(hrs.filter((_, i) => i % 6 === 0).map(r => [`${weekday(r.t)} ${hourText(r.t)}`, windText(r.dir, r.wind, r.gust)]))],
        humidity: () => [seriesChart(hrs, [{ get: r => T(r.dpt), cls: 'line-main', label: 'Dew point' }], { fmt: v => `${Math.round(v)}°` }),
            seriesChart(hrs, [{ get: r => humidity(r.tmp, r.dpt), cls: 'line-alt', label: 'Relative humidity' }], { fmt: v => `${Math.round(v)}%`, zero: true, max: 100 }),
            rowsList([['Dew point', f.dpt != null ? deg(f.dpt) : null],
                ['Relative humidity', f.temp != null && f.dpt != null ? `${Math.round(humidity(f.temp, f.dpt))}%` : null]])],
        feels: () => [seriesChart(hrs, [{ get: r => T(r.tmp), cls: 'line-alt', label: 'Air' },
            { get: r => T(feelsLike(r.tmp, r.dpt, r.wind)), cls: 'line-main', label: 'Feels like' }], { fmt: v => `${Math.round(v)}°` })],
        precip: () => [hrs.some(r => r.qpf >= 0.01)
            ? seriesChart(hrs, [], { fmt: v => rain(v), bars: { get: r => r.qpf, snow: r => r.snowy, text: r => precipText(r.qpf, r.snow, r.snowy) }, zero: true })
            : el('p', 'series-readout', 'Dry for the next 48 hours.'),
        rowsList(f.days.slice(0, 11).map(d => {
            const amt = d.snow >= 0.1 ? `${rain(d.snow, true)} snow` : d.qpf >= 0.01 ? rain(d.qpf) : 'dry';
            return [weekday(d.t), d.pop != null ? `${d.pop}% · ${amt}` : cap(amt)];
        }))],
    }[key];
    body.replaceChildren(...content());
    body.querySelector('.detail-moon')?.append(moonDisk(96));
}

// A scrubbable 48-hour chart: lines (and optional bars) over hourly rows
function seriesChart(rows, lines, opts) {
    const wrap = el('div', 'series');
    const readout = el('div', 'series-readout');
    wrap.append(readout);
    if (rows.length < 2) return wrap;
    const W = Math.max(260, detailWidth), H = 170, L = 44, R = 10, T = 10, B = 24;
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
    for (const t of zMidnights(x0, x1)) {
        svgEl('line', { x1: X(t), x2: X(t), y1: T, y2: H - B, class: 'grid grid-day' }, s);
        svgEl('text', { x: X(t) + 4, y: H - 7, class: 'axis' }, s).textContent = zDate(t, { weekday: 'short' });
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
    const cursorLine = svgEl('line', { y1: T, y2: H - B, class: 'plume-cursor' }, s);
    const at = i => {
        const r = rows[i];
        cursorLine.setAttribute('x1', X(r.t));
        cursorLine.setAttribute('x2', X(r.t));
        readout.replaceChildren(el('b', null, `${weekday(r.t)} ${hourText(r.t)}`),
            ...lines.filter(l => !l.hide?.(r)).map(l => el('span', l.cls, `${l.label} ${opts.fmt(l.get(r))}`)),
            ...(opts.bars ? [el('span', 'det', opts.bars.text(r))] : []));
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
        if (moved) { forecasts.delete('here'); histories.delete('here'); airs.delete('here'); }
        if (prompted && dialog.open) dialog.close();
        if (prompted) navigate('#p=here');
        else if (moved) route(true);
    }, err => {
        if (prompted) alert(err.code === 1 ? 'Location permission was denied.' : 'Could not get your location.');
    }, { maximumAge: 10 * 60000, timeout: 15000 });
}

let searchTimer = 0;
let searchSeq = 0;
searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, 200);
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
    if (!rows.length) searchResults.append(el('li', 'wx-empty', 'No places found.'));
}

function openSearch() {
    searchSeq++;   // drop any lookup still in flight from last time
    searchInput.value = '';
    renderSearchHome();
    dialog.showModal();
    searchInput.focus();
}

document.getElementById('searchBtn').addEventListener('click', openSearch);

// ============ Settings: units and places ============
const settingsDialog = document.getElementById('settingsDialog');
const SETTING_LABELS = { temp: 'Temperature', wind: 'Wind', precip: 'Precipitation', clock: 'Time' };
function renderSettings() {
    const body = settingsDialog.querySelector('.settings-body');
    const unitRows = Object.entries(U.UNIT_CHOICES).map(([k, opts]) => {
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
    });
    // Places: order, rename, remove; the device location is a switch
    const list = el('ol', 'setting-places');
    places.forEach((p, i) => {
        const li = el('li', 'setting-place');
        const btn = (text, label, fn, disabled) => {
            const b = el('button', 'seg-btn', text);
            b.type = 'button';
            b.setAttribute('aria-label', `${label} ${p.name}`);
            b.disabled = !!disabled;
            b.addEventListener('click', () => { fn(); savePlaces(); renderSettings(); route(true); });
            return b;
        };
        const move = d => { const [x] = places.splice(i, 1); places.splice(i + d, 0, x); };
        li.append(el('span', 'setting-place-name', p.name),
            btn('↑', 'Move up', () => move(-1), i === 0), btn('↓', 'Move down', () => move(1), i === places.length - 1),
            btn('Rename', 'Rename', () => { const n = prompt('Name this place', p.name)?.trim(); if (n) p.name = n.slice(0, 60); }),
            btn('Remove', 'Remove', () => { places = places.filter(x => x.id !== p.id); try { localStorage.removeItem(SAVED_KEY + p.id); } catch { /* none kept */ } }));
        list.append(li);
    });
    const gps = el('div', 'setting');
    const gb = el('button', 'seg-btn', store.get(GPS_KEY) === '1' ? 'On' : 'Off');
    gb.type = 'button';
    gb.setAttribute('aria-pressed', String(store.get(GPS_KEY) === '1'));
    gb.addEventListener('click', () => {
        if (store.get(GPS_KEY) === '1') { store.set(GPS_KEY, '0'); renderSettings(); route(true); } else { settingsDialog.close(); locate(true); }
    });
    gps.append(el('span', 'setting-label', 'My location'), gb);
    body.replaceChildren(...unitRows, el('h3', 'setting-h', 'Places'), gps, list);
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

// ============ Light and dark ============
// data-theme is set before first paint (overview.html); the button saves a choice for every page
const themeBtn = document.getElementById('themeBtn');
function showTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon'));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151413' : '#f3f0e8');
}
themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set('sref-theme', next);
    document.documentElement.dataset.theme = next;
    showTheme();
    route(true);   // the embedded map picks its basemap at load
});
// Following the system until the button is used
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', e => {
    if (store.get('sref-theme')) return;
    document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
    showTheme();
    route(true);
});
showTheme();

// ============ Routing ============

function renderEmpty() {
    renderSeq++;
    renderChips(null);
    const box = el('section', 'sg-empty');
    const b = el('button', 'sg-btn', 'Find a place');
    b.type = 'button';
    b.addEventListener('click', openSearch);
    box.append(el('p', null, 'No places yet.'), b);
    view.replaceChildren(box);
}

// keepScroll: a redraw of the same page (settings, refresh) stays where the user was
// restoreY: a scroll position to return to (back and forward)
// ?at=lat,lon (a shared place) as { lat, lon }, or null
function atOf(search) {
    const m = /[?&]at=(-?\d{1,2}(?:\.\d{1,6})?)(?:,|%2C)(-?\d{1,3}(?:\.\d{1,6})?)(?:&|$)/i.exec(search);
    // (to the 3 decimals the address bar keeps: a longer link is the same place after the rewrite)
    const lat = m && Math.round(Number(m[1]) * 1000) / 1000, lon = m && Math.round(Number(m[2]) * 1000) / 1000;
    const dp = m && (m[1].split('.')[1]?.length ?? 0);   // a GPS place's link carries 2
    return m && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon, dp } : null;
}
// A shared place not in the viewer's list: shown, not saved; named once the geocoder answers
let shared = null;
function sharedPlace(at) {
    if (shared?.lat === at.lat && shared.lon === at.lon) return shared;
    const p = shared = { id: `at:${at.lat},${at.lon}`, lat: at.lat, lon: at.lon, name: `${at.lat.toFixed(2)}, ${at.lon.toFixed(2)}` };
    fetch(`/api/geocode?lat=${at.lat.toFixed(4)}&lon=${at.lon.toFixed(4)}`).then(r => r.json()).then(r => {
        if (!r?.name || shared !== p) return;
        p.name = r.name;
        if (shownId === p.id) route(true, null, true);
    }).catch(() => {});
    return p;
}

function route(keepScroll = false, restoreY = null, quiet = false) {
    document.body.classList.remove('no-scroll');   // a full-screen radar left by back or refresh
    const y = restoreY ?? scrollY;
    cursor.t = null;
    pinned = false;
    const m = location.hash.match(/^#p=(.+)$/);
    const ps = allPlaces();
    // A shared link's ?at= names the place; a #p= that disagrees with it is someone else's list
    const at = atOf(location.search);
    // (the GPS place's link is rounded to 2 decimals, the others' to 3)
    const near = p => { const tol = p.here && at.dp <= 2 ? 0.006 : 0.002; return at && Math.abs(p.lat - at.lat) <= tol && Math.abs(p.lon - at.lon) <= tol; };
    let place = m && ps.find(p => p.id === decodeURIComponent(m[1]));
    if (at && !(place && near(place))) place = ps.find(near) || sharedPlace(at);
    place ||= ps[0];
    if (m && place && place.id !== decodeURIComponent(m[1])) history.replaceState(null, '', location.pathname + location.search);
    // the address bar names the shown place, so any page is a link to it
    if (place) {
        const dp = place.here ? 2 : 3;   // your own position only to about a kilometer
        const want = `?at=${place.lat.toFixed(dp)},${place.lon.toFixed(dp)}`;
        if (location.search !== want) history.replaceState(history.state, '', location.pathname + want + location.hash);
    }
    if (!place) shownId = null;
    const done = place ? renderPlace(place, quiet) : renderEmpty();
    // once the redraw is in: a place page waits on its forecast before its sections exist
    const seq = renderSeq;
    if (keepScroll || restoreY != null) Promise.resolve(done).then(() => { if (seq === renderSeq) requestAnimationFrame(() => window.scrollTo(0, y)); });
    else window.scrollTo(0, 0);
}

// Coming back to the tab after a while: drop stale forecasts
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > 10 * 60000) { forecasts.clear(); histories.clear(); airs.clear(); refsCache.clear(); route(true); }
});
applySiteSettings();
route();
if (store.get(GPS_KEY) === '1') locate(false);
