const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const EXTRACTOR_URL = process.env.EXTRACTOR_URL || 'http://extractor:3002';
const USER_AGENT = 'SREF-Viewer/1.0 (Personal Weather Tool)';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// NCEP discontinues SREF at this time (SCN 26-47); its cached runs stay viewable
const SREF_RETIRED_AT = Date.UTC(2026, 9, 6, 12);

const app = express();

// nginx (one hop) resolves the real client IP and sends it as X-Forwarded-For
app.set('trust proxy', 1);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SREF_RUNS = ['03', '09', '15', '21'];
const REFS_RUNS = ['00', '06', '12', '18'];
const PARAMS = ['Total-SNO', '3hrly-SNO', 'Total-QPF', '3hrly-QPF', '3hrly-TMP', '3h-10mWND'];

const round2 = v => Math.round(v * 100) / 100;
const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * GET a URL with a timeout. Non-2xx responses throw an Error carrying
 * `status` and, when the upstream sent a JSON { error }, its message.
 */
async function httpGet(url, timeoutMs) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || `${new URL(url).host} returned ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res;
}

const getJson = async (url, timeoutMs) => (await httpGet(url, timeoutMs)).json();

// ============ Persistent Cache ============
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const CACHE_MAX_ENTRIES = 1000;
const COMPLETE_TTL_MS = 14 * DAY;       // Complete runs never change
const INCOMPLETE_TTL_MS = 10 * MINUTE;  // Partial data: retry after 10 min
const NEGATIVE_TTL_MS = 5 * MINUTE;     // Upstream failure: retry after 5 min

const cache = new Map();
try {
    const now = Date.now();
    for (const [key, val] of Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')))) {
        if (val.expiry > now) cache.set(key, val);
    }
    console.log(`[CACHE] Loaded ${cache.size} items from disk`);
} catch (err) {
    if (err.code !== 'ENOENT') console.error('[CACHE] Failed to load cache from disk:', err.message);
}

/**
 * A cache entry or null if missing/expired. Entries may carry `incomplete`
 * (partial member set) or `negative` (upstream failure) flags.
 */
function getFromCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
        cache.delete(key);
        return null;
    }
    return item;
}

function setInCache(key, data, ttlMs = COMPLETE_TTL_MS, flags = {}) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
        const now = Date.now();
        for (const [k, v] of cache) if (v.expiry <= now) cache.delete(k);
    }
    if (cache.size >= CACHE_MAX_ENTRIES) {
        // Map order is insertion order: drop the oldest 10% in one go
        const drop = [...cache.keys()].slice(0, CACHE_MAX_ENTRIES / 10);
        for (const k of drop) cache.delete(k);
        console.log(`[CACHE] Evicted ${drop.length} oldest entries`);
    }
    cache.delete(key);  // re-insert at the end so eviction order stays by age
    cache.set(key, { data, expiry: Date.now() + ttlMs, cachedAt: new Date().toISOString(), ...flags });
    scheduleCacheSave();
}

let saveTimeout;
function scheduleCacheSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        // Write-then-rename: a crash mid-write must not destroy the cache
        const tmp = `${CACHE_FILE}.tmp`;
        fs.writeFile(tmp, JSON.stringify(Object.fromEntries(cache)), (err) => {
            if (err) return console.error('[CACHE] Write error:', err.message);
            fs.rename(tmp, CACHE_FILE, (e) => e && console.error('[CACHE] Rename error:', e.message));
        });
    }, 5000);
}

// Serve a cached/negative entry. Returns true when the response was sent.
function sendCached(res, key, errorLabel) {
    const cached = getFromCache(key);
    if (!cached) return false;
    if (cached.negative) {
        res.set('X-Cache', 'NEGATIVE');
        res.status(502).json({ error: errorLabel, details: cached.data, cached: true });
    } else {
        res.set('X-Cache', cached.incomplete ? 'INCOMPLETE-HIT' : 'HIT');
        res.json(cached.data);
    }
    return true;
}

// Complete data for the long TTL; partial data briefly so every visitor
// doesn't re-hit upstream for a run that is still publishing
function cacheResult(res, key, data, complete) {
    if (complete) setInCache(key, data);
    else setInCache(key, data, INCOMPLETE_TTL_MS, { incomplete: true });
    res.set('X-Cache', complete ? 'MISS' : 'INCOMPLETE');
}

// ============ Rate Limiting (token buckets, per client IP) ============
// Only upstream work (cache misses) spends tokens.
const apiBuckets = new Map();
const tileBuckets = new Map();

function takeToken(ip, buckets = apiBuckets, max = 50, perSecond = 1) {
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket) {
        bucket = { tokens: max, lastRefill: now };
        buckets.set(ip, bucket);
    }
    // Only advance lastRefill by whole seconds, else sub-second traffic never refills
    const secs = Math.floor((now - bucket.lastRefill) / 1000);
    if (secs > 0) {
        bucket.tokens = Math.min(max, bucket.tokens + secs * perSecond);
        bucket.lastRefill = now;
    }
    if (bucket.tokens > 0) {
        bucket.tokens--;
        return true;
    }
    return false;
}

function rateLimited(req, res, buckets, max, perSecond) {
    if (takeToken(req.ip, buckets, max, perSecond)) return false;
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
    return true;
}

// ============ Routes ============

app.get('/health', (req, res) => {
    res.json({ status: 'ok', cacheSize: cache.size, uptime: process.uptime() });
});

// ============ SREF (SPC plumes) ============

async function fetchSref(station, run, param, date) {
    const ymd = date.replace(/-/g, '');
    const url = 'https://www.spc.noaa.gov/exper/sref/srefplumes/returndata.php?' +
        `search=${station}-${run}-${param}&file=json_sid/${ymd}_${run}/${station}&mem=:&means=`;
    // Retry network errors, timeouts and 5xx with exponential backoff
    for (let attempt = 1; ; attempt++) {
        try {
            const text = await (await httpGet(url, 15000)).text();
            // SPC double-encodes the JSON (a JSON string holding JSON)
            const parsed = JSON.parse(text);
            return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
        } catch (err) {
            if (attempt === 3 || err.status < 500 || err instanceof SyntaxError) throw err;
            console.log(`[RETRY] Attempt ${attempt} failed (${err.message})`);
            await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        }
    }
}

/** Raw SPC member series -> { label: [{x, y}] } plus a computed 'Mean'. */
function processSref(raw) {
    const processed = {};
    const sums = new Map();
    for (const [label, series] of Object.entries(raw)) {
        if (!series.data || series.data.length === 0) continue;
        processed[label] = series.data.map(([x, value]) => {
            const y = parseFloat(value) || 0;
            const agg = sums.get(x) || { sum: 0, count: 0 };
            agg.sum += y;
            agg.count++;
            sums.set(x, agg);
            return { x, y };
        });
    }
    if (sums.size > 0) {
        processed['Mean'] = [...sums.entries()].sort((a, b) => a[0] - b[0])
            .map(([x, agg]) => ({ x, y: agg.sum / agg.count }));
    }
    return processed;
}

app.get('/api/sref/:station/:run/:param', async (req, res) => {
    const station = req.params.station.toUpperCase();
    const { run, param } = req.params;
    const date = String(req.query.date || todayUtc());

    if (!/^[A-Z]{3,4}$/.test(station)) return res.status(400).json({ error: 'Invalid station format' });
    if (!SREF_RUNS.includes(run)) return res.status(400).json({ error: 'Invalid run time' });
    if (!PARAMS.includes(param)) return res.status(400).json({ error: 'Invalid parameter' });
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Invalid date' });

    const cacheKey = `${date}_${run}_${station}_${param}`;
    if (sendCached(res, cacheKey, 'Failed to fetch from NOAA')) return;
    if (rateLimited(req, res)) return;

    console.log(`[SREF MISS] ${cacheKey}`);
    try {
        const processed = processSref(await fetchSref(station, run, param, date));
        const memberCount = Object.keys(processed).length - 1;
        cacheResult(res, cacheKey, processed, memberCount >= 10);
        res.json(processed);
    } catch (err) {
        console.error(`[SREF ERROR] ${cacheKey}:`, err.message);
        // Negative-cache so repeated loads don't hammer NOAA for runs that don't exist
        setInCache(cacheKey, err.message, NEGATIVE_TTL_MS, { negative: true });
        res.status(502).json({ error: 'Failed to fetch from NOAA', details: err.message });
    }
});

// ============ Admin ============
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
const ADMIN_ENABLED = ADMIN_PASS !== '' && ADMIN_PASS !== 'changeme';
if (!ADMIN_ENABLED) console.warn('[ADMIN] Disabled: set ADMIN_PASSWORD (not "changeme") to enable');

const DEFAULT_SETTINGS = {
    siteName: 'NYC SREF Ensemble Plumes',
    siteDescription: 'SREF ensemble plume diagrams for weather forecasting',
    favicon: '',
    defaultStations: ['JFK', 'LGA', 'EWR'],
    analyticsScript: '',
    analyticsEnabled: false,
    customCss: ''
};

let settings = null;
function loadSettings() {
    if (!settings) {
        settings = { ...DEFAULT_SETTINGS };
        try {
            Object.assign(settings, pickSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))));
        } catch (err) {
            if (err.code !== 'ENOENT') console.error('[ADMIN] Failed to load settings:', err.message);
        }
    }
    return settings;
}

function saveSettings(next) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
    settings = next;
}

/** Known keys only, each with its default's type; stations must look like ICAO codes. */
function pickSettings(input) {
    const out = {};
    for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
        const v = input?.[key];
        if (Array.isArray(def)) {
            if (Array.isArray(v) && v.length && v.every(s => typeof s === 'string' && /^[A-Z]{3,4}$/.test(s))) {
                out[key] = v.slice(0, 8);
            }
        } else if (typeof v === typeof def) {
            out[key] = v;
        }
    }
    return out;
}

function safeEqual(a, b) {
    // Hash first: equal-length inputs for timingSafeEqual, no length leak
    const h = s => crypto.createHash('sha256').update(String(s ?? '')).digest();
    return crypto.timingSafeEqual(h(a), h(b));
}

const SESSION_TTL_MS = DAY;
const sessions = new Map();  // token -> created (in-memory, cleared on restart)

function requireAuth(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const created = sessions.get(token);
    if (!created || Date.now() - created > SESSION_TTL_MS) {
        sessions.delete(token);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Failed logins per IP within the window
const LOGIN_WINDOW_MS = 15 * MINUTE;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map();  // ip -> [timestamps]

function recentFailures(ip) {
    const now = Date.now();
    const recent = (loginFailures.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    if (recent.length) loginFailures.set(ip, recent);
    else loginFailures.delete(ip);
    return recent;
}

const smallJson = express.json({ limit: '100kb' });

app.post('/api/admin/login', smallJson, (req, res) => {
    if (!ADMIN_ENABLED) return res.status(503).json({ error: 'Admin is disabled: ADMIN_PASSWORD is not set' });
    const failures = recentFailures(req.ip);
    if (failures.length >= LOGIN_MAX_FAILURES) {
        return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
    const { username, password } = req.body || {};
    // Both compared unconditionally so timing doesn't reveal which was wrong
    const userOk = safeEqual(username, ADMIN_USER);
    const passOk = safeEqual(password, ADMIN_PASS);
    if (userOk && passOk) {
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now());
        console.log('[ADMIN] Login successful');
        return res.json({ token });
    }
    loginFailures.set(req.ip, [...failures, Date.now()]);
    console.log(`[ADMIN] Login failed from ${req.ip}`);
    res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/admin/check', requireAuth, (req, res) => res.json({ authenticated: true }));

app.get('/api/admin/settings', requireAuth, (req, res) => res.json(loadSettings()));

app.post('/api/admin/settings', requireAuth, smallJson, (req, res) => {
    const picked = pickSettings(req.body);
    if (req.body?.defaultStations !== undefined && !picked.defaultStations) {
        return res.status(400).json({ error: 'Stations must be 1-8 codes of 3-4 letters' });
    }
    const updated = { ...loadSettings(), ...picked };
    try {
        saveSettings(updated);
        console.log('[ADMIN] Settings updated');
        res.json(updated);
    } catch (err) {
        console.error('[ADMIN] Failed to save settings:', err.message);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// Base64 JSON upload; the large body limit applies only after auth
const FAVICON_EXTS = ['.ico', '.png', '.svg'];
app.post('/api/admin/upload/favicon', requireAuth, express.json({ limit: '2mb' }), (req, res) => {
    const { data, filename } = req.body || {};
    if (typeof data !== 'string' || typeof filename !== 'string') {
        return res.status(400).json({ error: 'Missing data or filename' });
    }
    const ext = path.extname(filename).toLowerCase();
    if (!FAVICON_EXTS.includes(ext)) {
        return res.status(400).json({ error: `Invalid file type. Allowed: ${FAVICON_EXTS.join(', ')}` });
    }
    const safeName = `favicon${ext}`;
    try {
        fs.writeFileSync(path.join(UPLOADS_DIR, safeName), Buffer.from(data, 'base64'));
        // Version the URL so browsers pick up a replaced icon
        const url = `/uploads/${safeName}?v=${Date.now()}`;
        saveSettings({ ...loadSettings(), favicon: url });
        console.log(`[ADMIN] Uploaded ${safeName}`);
        res.json({ path: url });
    } catch (err) {
        console.error('[ADMIN] Upload error:', err.message);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Uploaded SVGs are same-origin: serve them inert
app.use('/uploads', express.static(UPLOADS_DIR, {
    setHeaders: res => res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
}));

app.get('/api/cache-stats', requireAuth, (req, res) => {
    const now = Date.now();
    res.json({
        entries: cache.size,
        keys: [...cache].map(([key, v]) => ({
            key, cachedAt: v.cachedAt, expiresInMinutes: Math.round((v.expiry - now) / MINUTE)
        }))
    });
});

// Public site config for the frontend
app.get('/api/settings', (req, res) => {
    const s = loadSettings();
    res.json({
        siteName: s.siteName,
        siteDescription: s.siteDescription,
        favicon: s.favicon,
        defaultStations: s.defaultStations,
        analyticsScript: s.analyticsEnabled ? s.analyticsScript : '',
        customCss: s.customCss
    });
});

// ============ REFS (RRFS Ensemble) via extractor ============
// NOAA publishes no per-member REFS files. The extractor returns the
// deterministic RRFS station sounding (hourly) plus the REFS ensemble
// mean and spread at the station grid point (3-hourly). This route shapes
// them into the { member: [{x, y}] } format the charts consume: one
// 'RRFS' member line and a 'Mean' whose points carry p10/p25/p75/p90
// derived from mean +/- spread.

// ICAO -> 6-digit BUFR station number (verified against RPID in the files)
const REFS_STATIONS = { JFK: '744860', LGA: '725030', EWR: '725020', BOS: '725090' };

// Full RPID -> station-number index built by the extractor (~1900 stations)
let refsStationIndex = { stations: null, fetchedAt: 0 };
const STATION_INDEX_TTL_MS = 6 * HOUR;

async function resolveRefsSid(station) {
    const key = station.toUpperCase();
    if (REFS_STATIONS[key]) return REFS_STATIONS[key];
    if (/^\d{6}$/.test(key)) return key;
    if (!/^[A-Z]{3,4}$/.test(key)) return null;

    if (!refsStationIndex.stations || Date.now() - refsStationIndex.fetchedAt > STATION_INDEX_TTL_MS) {
        try {
            const idx = await getJson(`${EXTRACTOR_URL}/stations`, 30000);
            refsStationIndex = { stations: idx.stations || null, fetchedAt: Date.now() };
            console.log(`[REFS] Station index loaded: ${idx.count} stations (${idx.source})`);
        } catch (err) {
            console.log('[REFS] Station index unavailable:', err.message);
        }
    }
    const idx = refsStationIndex.stations;
    if (!idx) return null;
    // 3-letter US identifiers are usually K-prefixed in the feed (JFK -> KJFK)
    for (const candidate of key.length === 3 ? [`K${key}`, key] : [key]) {
        if (idx[candidate]) return idx[candidate].sid;
    }
    return null;
}

// Every param of a page load asks for the same plume at once: one extractor call
const plumeInFlight = new Map();
function fetchPlume(sid, ymd, run) {
    const key = `${sid}_${ymd}_${run}`;
    if (!plumeInFlight.has(key)) {
        // Above a cold cycle's build time; nginx's proxy timeout is longer still
        plumeInFlight.set(key, getJson(`${EXTRACTOR_URL}/plume?sid=${sid}&date=${ymd}&cycle=${run}`, 120000)
            .finally(() => plumeInFlight.delete(key)));
    }
    return plumeInFlight.get(key);
}

const K_TO_F = k => (k - 273.15) * 9 / 5 + 32;
const MS_TO_KTS = 1.94384;
const MM_TO_IN = 1 / 25.4;
const M_TO_IN = 39.3701;

/**
 * Liquid-equivalent snowfall (mm) -> snow depth (inches) using the
 * model's explicit snow ratio when it looks sane, else 10:1.
 * SNRA is nominally percent; values that look like ratio*100 are scaled.
 */
function snowInches(snflMm, snra) {
    if (snflMm === null || snflMm === undefined) return 0;
    let ratio = 10;
    if (typeof snra === 'number' && snra > 0) {
        const r = snra > 100 ? snra / 100 : snra;
        if (r >= 2 && r <= 40) ratio = r;
    }
    return snflMm * MM_TO_IN * ratio;
}

/** Shape one member's raw hourly series into [{x, y}] for a param. */
function shapeMemberSeries(series, param, cycleEpochMs) {
    const hourly = series.ftimes.map((ftime, i) => ({
        x: cycleEpochMs + ftime * 1000,
        tmp: series.t2ms[i] !== null ? K_TO_F(series.t2ms[i]) : null,
        wnd: (series.u10m[i] !== null && series.v10m[i] !== null)
            ? Math.hypot(series.u10m[i], series.v10m[i]) * MS_TO_KTS : null,
        qpf: series.tp01[i] !== null ? series.tp01[i] * MM_TO_IN : 0,
        sno: snowInches(series.snfl[i], series.snra ? series.snra[i] : null)
    }));

    const cumulative = key => {
        let sum = 0;
        return hourly.map(h => ({ x: h.x, y: round2(sum += h[key]) }));
    };
    // Sum hours 1-3, 4-6, ... into 3-hour buckets (x at bucket end), matching SREF
    const buckets = key => {
        const out = [];
        for (let i = 1; i < hourly.length; i += 3) {
            const bucket = hourly.slice(i, i + 3);
            out.push({ x: bucket[bucket.length - 1].x, y: round2(bucket.reduce((s, h) => s + h[key], 0)) });
        }
        return out;
    };
    const instant = key => hourly.filter(h => h[key] !== null).map(h => ({ x: h.x, y: round2(h[key]) }));

    switch (param) {
        case '3hrly-TMP': return instant('tmp');
        case '3h-10mWND': return instant('wnd');
        case 'Total-QPF': return cumulative('qpf');
        case 'Total-SNO': return cumulative('sno');
        case '3hrly-QPF': return buckets('qpf');
        case '3hrly-SNO': return buckets('sno');
        default: return [];
    }
}

/**
 * REFS ensemble mean at 3h steps as Mean points carrying a band:
 * p10/p90 = mean -/+ 1.28 spread, p25/p75 = mean -/+ 0.67 spread
 * (Gaussian quantiles). Accumulations sum the 3h buckets; their spread
 * is summed too, which assumes member wetness persists across buckets.
 */
function shapeEnsembleMean(ens, param, cycleEpochMs) {
    const { hours, mean, sprd } = ens;
    const total = param.startsWith('Total-');
    const pick = {
        '3hrly-TMP': i => [K_TO_F(mean.tmp[i]), sprd.tmp[i] * 9 / 5],
        '3h-10mWND': i => [mean.wnd[i] * MS_TO_KTS, sprd.wnd[i] * MS_TO_KTS],
        '3hrly-QPF': i => [mean.qpf[i] * MM_TO_IN, sprd.qpf[i] * MM_TO_IN],
        '3hrly-SNO': i => [mean.sno[i] * M_TO_IN, sprd.sno[i] * M_TO_IN],
    }[total ? param.replace('Total-', '3hrly-') : param];
    if (!pick || !hours) return [];

    const nonNegative = param !== '3hrly-TMP';
    let sum = 0, sumSprd = 0;
    return hours.map((hour, i) => {
        let [m, s] = pick(i);
        if (total) {
            m = sum += m;
            s = sumSprd += s;
        }
        const q = k => round2(nonNegative ? Math.max(0, m + k * s) : m + k * s);
        return {
            x: cycleEpochMs + hour * HOUR,
            y: round2(m),
            p10: q(-1.28), p25: q(-0.67), p75: q(0.67), p90: q(1.28)
        };
    });
}

/** Per-hour fraction of members flagging each precip type. */
function shapePtype(members, cycleEpochMs) {
    const list = Object.values(members);
    const steps = Math.min(...list.map(m => m.ftimes.length));
    const frac = (flag, i) => list.filter(m => (m[flag] || [])[i] === 1).length / list.length;
    return Array.from({ length: steps }, (_, i) => ({
        x: cycleEpochMs + list[0].ftimes[i] * 1000,
        snow: frac('wxts', i), rain: frac('wxtr', i), zr: frac('wxtz', i), ip: frac('wxtp', i)
    }));
}

function shapePlume(plume, param, cycleEpochMs) {
    const shaped = {};
    for (const member of Object.keys(plume.members).sort()) {
        const label = member === 'rrfs' ? 'RRFS' : 'M' + member.replace(/^m0*/, '').padStart(2, '0');
        const pts = shapeMemberSeries(plume.members[member], param, cycleEpochMs);
        if (pts.length > 0) shaped[label] = pts;
    }
    const labels = Object.keys(shaped);
    const ensMean = plume.ens ? shapeEnsembleMean(plume.ens, param, cycleEpochMs) : [];
    if (ensMean.length > 0) {
        shaped['Mean'] = ensMean;
    } else if (labels.length > 0) {
        // No ensemble products: fall back to the mean across member lines
        const sums = new Map();
        for (const label of labels) {
            for (const p of shaped[label]) {
                const agg = sums.get(p.x) || { sum: 0, count: 0 };
                agg.sum += p.y;
                agg.count++;
                sums.set(p.x, agg);
            }
        }
        shaped['Mean'] = [...sums.entries()].sort((a, b) => a[0] - b[0])
            .map(([x, agg]) => ({ x, y: round2(agg.sum / agg.count) }));
    }
    const steps = labels.length ? Math.min(...labels.map(l => shaped[l].length)) : 0;
    return { shaped, steps };
}

// What the extractor is doing for a cycle right now (drives the UI status line)
const statusCache = new Map();
app.get('/api/refs/status/:run', async (req, res) => {
    const date = String(req.query.date || '');
    if (!REFS_RUNS.includes(req.params.run) || !DATE_RE.test(date)) {
        return res.status(400).json({ error: 'Invalid run or date' });
    }
    // 1s shared TTL: N viewers polling a cold cycle cost one extractor hit
    const key = `${date}_${req.params.run}`;
    const hit = statusCache.get(key);
    if (hit && Date.now() - hit.at < 1000) return res.json(hit.data);
    let data;
    try {
        data = await getJson(`${EXTRACTOR_URL}/status?date=${date.replace(/-/g, '')}&cycle=${req.params.run}`, 5000);
    } catch {
        data = { busy: false };
    }
    if (statusCache.size > 64) statusCache.clear();  // client-chosen dates must not grow the map
    statusCache.set(key, { at: Date.now(), data });
    res.json(data);
});

app.get('/api/refs/:station/:run/:param', async (req, res) => {
    const { station, run, param } = req.params;
    const date = String(req.query.date || todayUtc());

    if (!REFS_RUNS.includes(run)) return res.status(400).json({ error: 'Invalid run time' });
    if (!PARAMS.includes(param) && param !== 'ptype') return res.status(400).json({ error: 'Invalid parameter' });
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Invalid date' });
    const sid = await resolveRefsSid(station);
    if (!sid) {
        return res.status(400).json({
            error: 'Unknown REFS station. Use an ICAO code from the RRFS feed (e.g. KJFK/JFK) or a 6-digit BUFR station number.'
        });
    }

    // Prefix versions the persisted cache: bump when the shaped output changes
    const cacheKey = `refs2_${date}_${run}_${sid}_${param}`;
    if (sendCached(res, cacheKey, 'REFS data unavailable')) return;
    if (rateLimited(req, res)) return;

    const ymd = date.replace(/-/g, '');
    try {
        const plume = await fetchPlume(sid, ymd, run);
        const cycleEpochMs = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), +run);

        if (param === 'ptype') {
            const out = shapePtype(plume.members, cycleEpochMs);
            cacheResult(res, cacheKey, out, plume.complete && out.length >= 16);
            return res.json(out);
        }

        const { shaped, steps } = shapePlume(plume, param, cycleEpochMs);
        const complete = plume.complete && steps >= 16;
        cacheResult(res, cacheKey, shaped, complete);
        console.log(`[REFS] ${cacheKey}: ${steps} pts, complete=${complete}`);
        res.json(shaped);
    } catch (err) {
        console.error(`[REFS ERROR] ${cacheKey}:`, err.message);
        // A timed-out build keeps running in the extractor: let the next request pick it up
        if (err.name !== 'TimeoutError') setInCache(cacheKey, err.message, NEGATIVE_TTL_MS, { negative: true });
        res.status(502).json({ error: 'REFS data unavailable', details: err.message });
    }
});

// ============ Radar Frame Index (LibreWXR) ============
// All visitors share one upstream request per minute.
const LIBRE_HOST = 'https://api.librewxr.net';
let radarFramesCache = { data: null, fetchedAt: 0 };
let radarFramesInFlight = null;

async function getRadarFrames() {
    if (radarFramesCache.data && Date.now() - radarFramesCache.fetchedAt < MINUTE) {
        return { data: radarFramesCache.data, status: 'HIT' };
    }
    // Many tile misses can expire the index at once: one upstream fetch for all
    radarFramesInFlight ??= getJson(`${LIBRE_HOST}/public/weather-maps.json`, 10000)
        .then(data => {
            radarFramesCache = { data, fetchedAt: Date.now() };
            return { data, status: 'MISS' };
        })
        .catch(err => {
            console.error('[RADAR]', err.message);
            if (!radarFramesCache.data) throw err;
            // Serve stale for a TTL rather than retrying upstream per tile batch
            radarFramesCache.fetchedAt = Date.now();
            return { data: radarFramesCache.data, status: 'STALE' };
        })
        .finally(() => { radarFramesInFlight = null; });
    return radarFramesInFlight;
}

app.get('/api/radar/frames', async (req, res) => {
    try {
        const { data, status } = await getRadarFrames();
        res.set('X-Cache', status);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Failed to fetch radar frames', details: err.message });
    }
});

// ============ Radar Tiles (proxy + cache + warming) ============
// LibreWXR renders tiles on demand and a cold tile can take 5-90s. Tiles
// are immutable per (frame, nowcast basis), so they are cached here and
// the default NYC viewport is pre-rendered for every new frame as soon as
// the index shows it, so the page normally never waits on upstream.
const TILE_OPTS = '512';            // 512px tiles, declared 256 client-side for 2x density
// Legend colors in radar.html/css mirror this scheme; bump the client's TILE_STYLE_V with it
const TILE_STYLE = '4/1_1';         // The Weather Channel (green rain, blue snow), smoothed, rain/snow classified
const TILE_TTL_MS = 3 * HOUR;
const TILE_CACHE_MAX = 12000;       // 1-20KB each; ~2900 warm tiles live at once plus browsing
const tileCache = new Map();        // key -> { body, type, at }
const tileInFlight = new Map();     // key -> Promise
// NYC default viewport (lon -75.5..-72.5, lat 39.8..41.8). The page opens at
// map zoom 8.2 and, because 512px tiles are declared as 256, requests source
// zoom round(map zoom + 1) = 9; 8 covers zooming out one step.
// ponytail: fixed box; derive from visitors' viewports if that matters.
// Zoom 7 covers the wider view the overview's embedded mini radar opens on;
// 8 and 9 the radar page's default NYC view
const TILE_WARM = [
    { z: 7, bbox: { west: -78.5, east: -69.5, south: 38.3, north: 43.2 } },
    { z: 8, bbox: { west: -75.5, east: -72.5, south: 39.8, north: 41.8 } },
    { z: 9, bbox: { west: -75.5, east: -72.5, south: 39.8, north: 41.8 } },
];

const tileKey = (time, z, x, y, fc) => `${time}/${z}/${x}/${y}/${fc || ''}`;
const freshTile = key => {
    const hit = tileCache.get(key);
    return hit && Date.now() - hit.at < TILE_TTL_MS ? hit : null;
};

// fc 'sat' marks a satellite tile; otherwise it is the radar nowcast basis
async function fetchTile(time, z, x, y, fc) {
    const url = fc === 'sat'
        ? `${LIBRE_HOST}/v2/satellite/${time}/${TILE_OPTS}/${z}/${x}/${y}/0/0_0.png`
        : `${LIBRE_HOST}/v2/radar/${time}/${TILE_OPTS}/${z}/${x}/${y}/${TILE_STYLE}.png`;
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(120000)
    });
    return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
}

// Cached tile or one upstream fetch shared by everyone waiting for it
function getTile(time, z, x, y, fc) {
    const key = tileKey(time, z, x, y, fc);
    const hit = freshTile(key);
    if (hit) return Promise.resolve(hit);
    if (!tileInFlight.has(key)) {
        tileInFlight.set(key, fetchTile(time, z, x, y, fc).then(t => {
            if (t.status === 200) {
                if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
                tileCache.set(key, { ...t, at: Date.now() });
            }
            return t;
        }).finally(() => tileInFlight.delete(key)));
    }
    return tileInFlight.get(key);
}

app.get('/api/radar/tile/:time/:z/:x/:y.png', (req, res) => serveTile(req, res, false));
// Satellite (NOAA GMGSI via LibreWXR): hourly frames, no nowcast
app.get('/api/radar/sat/:time/:z/:x/:y.png', (req, res) => serveTile(req, res, true));

async function serveTile(req, res, sat) {
    const [time, z, x, y] = [req.params.time, req.params.z, req.params.x, req.params.y].map(Number);
    const fc = sat ? 'sat' : req.query.fc ? String(req.query.fc) : '';
    if (![time, z, x, y].every(Number.isInteger) || z < 3 || z > 12
        || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z || (!sat && !/^\d*$/.test(fc))) {
        return res.status(400).end();
    }
    try {
        const key = tileKey(time, z, x, y, fc);
        // A cached tile was validated when fetched: serve it without touching
        // the index (which may be briefly unavailable or newer than the client)
        if (!freshTile(key) && !tileInFlight.has(key)) {
            // Only frames in the index, and a nowcast frame only under an fc key
            // that is an observed time: its render would otherwise be cached as
            // the observation it becomes
            const { data } = await getRadarFrames();
            const pastTimes = (data.radar?.past || []).map(f => f.time);
            const isNowcast = (data.radar?.nowcast || []).some(f => f.time === time);
            if (sat) {
                if (!(data.satellite?.infrared || []).some(f => f.time === time)) return res.status(404).end();
            } else {
                if (!pastTimes.includes(time) && !isNowcast) return res.status(404).end();
                if (isNowcast && !fc) return res.status(404).end();
                if (fc && !pastTimes.includes(Number(fc))) return res.status(400).end();
            }
            // One zoom action re-requests every visible tile for all 18 frames (~430 misses)
            if (!takeToken(req.ip, tileBuckets, 500, 20)) return res.status(429).end();
        }
        const t = await getTile(time, z, x, y, fc);
        if (t.status !== 200) return res.status(t.status).end();
        res.set('Content-Type', t.type || 'image/png');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(t.body);
    } catch {
        res.status(502).end();
    }
}

const lonToX = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
function latToY(lat, z) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
}

let radarWarming = false;
async function warmRadarTiles() {
    // A stalled upstream must not stack passes (and sockets) every minute
    if (radarWarming) return;
    radarWarming = true;
    try {
        await warmRadarTilesOnce();
    } catch (err) {
        console.error('[RADAR WARM]', err.message);
    } finally {
        radarWarming = false;
    }
}

async function warmRadarTilesOnce() {
    const { data } = await getRadarFrames();
    const past = data.radar?.past || [];
    const basis = past.length ? String(past[past.length - 1].time) : '';
    // Newest observed frame first: it is what the page opens on
    const frames = [...past].reverse().map(f => ({ time: f.time, fc: '' }))
        .concat((data.radar?.nowcast || []).map(f => ({ time: f.time, fc: basis })));
    // Gate on cache state per tile so failures, eviction, expiry and
    // restarts all get re-warmed; in-flight dedup keeps overlapping passes cheap
    const jobs = [];
    for (const f of frames) {
        for (const { z, bbox } of TILE_WARM) {
            for (let x = lonToX(bbox.west, z); x <= lonToX(bbox.east, z); x++) {
                for (let y = latToY(bbox.north, z); y <= latToY(bbox.south, z); y++) {
                    if (!freshTile(tileKey(f.time, z, x, y, f.fc))) jobs.push(() => getTile(f.time, z, x, y, f.fc));
                }
            }
        }
    }
    if (!jobs.length) return;
    const t0 = Date.now();
    // Three at a time: gentle on a volunteer-run service
    let i = 0;
    await Promise.all([0, 1, 2].map(async () => {
        while (i < jobs.length) { try { await jobs[i++](); } catch { /* still a miss: next pass retries */ } }
    }));
    console.log(`[RADAR WARM] ${jobs.length} tiles in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// ============ Model fields (RRFS temp/dew point/wind/cloud, rendered by the extractor) ============
app.get('/api/radar/field', async (req, res) => {
    try {
        const mode = ['now', 'hourly', 'extended'].includes(req.query.mode) ? req.query.mode : 'hourly';
        // field: the extractor pre-fetches that field's hours in the background
        const field = /^[a-z]{1,10}$/.test(req.query.field || '') ? req.query.field : '';
        const index = await getJson(`${EXTRACTOR_URL}/fields?mode=${mode}&field=${field}`, 30000);
        res.set('Cache-Control', 'public, max-age=300');
        res.json(index);
    } catch (err) {
        res.status(502).json({ error: 'Model fields unavailable', details: err.message });
    }
});

// One loop is ~37 frames x ~12 visible tiles, re-requested on every zoom
const fieldBuckets = new Map();

// Tiles, the numbers/particles grid and tap-to-inspect values for one field
// and frame. src is rrfs (cycle HH, forecast hour fh) or rtma (analysis HHMM, fh 0).
const FIELD_FRAME = '/api/radar/field/:name/:src/:date/:cycle/:fh';
app.get(`${FIELD_FRAME}/:z/:x/:y.png`, (req, res) =>
    proxyField(req, res, 'png', `&z=${req.params.z}&x=${req.params.x}&y=${req.params.y}`, true));
app.get(`${FIELD_FRAME}/grid.bin`, (req, res) => proxyField(req, res, 'grid', '', true));
app.get(`${FIELD_FRAME}/point`, (req, res) => {
    const [lat, lon] = [Number(req.query.lat), Number(req.query.lon)];
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return res.status(400).end();
    proxyField(req, res, 'point', `&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, false);
});

async function proxyField(req, res, kind, extra, immutable) {
    const { name, src, date, cycle, fh } = req.params;
    if (!/^[a-z]{1,10}$/.test(name) || !/^(rrfs|rtma)$/.test(src) || !/^\d{8}$/.test(date)
        || !/^\d{2}(\d{2})?$/.test(cycle) || !Object.values(req.params).slice(4).every(v => /^\d{1,4}$/.test(v))) {
        return res.status(400).end();
    }
    // ponytail: every miss renders in the extractor (~20ms warm); wrap in tileCache if extractor CPU bites
    if (!takeToken(req.ip, fieldBuckets, 1500, 60)) return res.status(429).end();
    try {
        const up = await fetch(`${EXTRACTOR_URL}/fields/${name}.${kind}?src=${src}&date=${date}&cycle=${cycle}&fh=${fh}${extra}`,
            { signal: AbortSignal.timeout(60000) });
        if (!up.ok) return res.status(up.status >= 500 ? 502 : up.status).end();
        res.set('Content-Type', up.headers.get('content-type'));
        // A frame's data never changes; a point's answer grows as more fields get cached
        res.set('Cache-Control', immutable ? 'public, max-age=86400, immutable' : 'no-store');
        res.send(Buffer.from(await up.arrayBuffer()));
    } catch {
        res.status(502).end();
    }
}

// ============ Overview: point forecast and place search ============
// Observed now (RTMA), the hourly RRFS series and daily NBM rows for one
// place. A place in a region the extractor has not cut yet comes back with
// building: true and no hourly (daily_building: true and no daily for NBM);
// the page asks again a few seconds later.
app.get('/api/forecast', async (req, res) => {
    const [lat, lon] = [Number(req.query.lat), Number(req.query.lon)];
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return res.status(400).json({ error: 'Invalid lat/lon' });
    if (rateLimited(req, res)) return;
    try {
        const up = await fetch(`${EXTRACTOR_URL}/forecast?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
            { signal: AbortSignal.timeout(60000) });
        const body = await up.json();
        if (!up.ok) return res.status(up.status >= 500 ? 502 : up.status).json(body);
        // Observations turn over every 15 minutes; a building answer must not stick
        res.set('Cache-Control', body.building || body.daily_building ? 'no-store' : 'public, max-age=120');
        res.json(body);
    } catch (err) {
        res.status(502).json({ error: 'Forecast unavailable', details: err.message });
    }
});

// OpenStreetMap Nominatim: identifying User-Agent, at most one request a
// second across all users (its usage policy), answers cached for a day.
const GEOCODE_TTL_MS = DAY;
const geocodeCache = new Map();
let geocodeChain = Promise.resolve();
function nominatim(path) {
    const hit = geocodeCache.get(path);
    if (hit && Date.now() - hit.at < GEOCODE_TTL_MS) return Promise.resolve(hit.data);
    const run = geocodeChain.then(async () => {
        const data = await getJson(`https://nominatim.openstreetmap.org/${path}`, 10000);
        if (geocodeCache.size >= 300) geocodeCache.delete(geocodeCache.keys().next().value);
        geocodeCache.set(path, { data, at: Date.now() });
        return data;
    });
    geocodeChain = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, 1100)));
    return run;
}

const placeName = a => [a.city || a.town || a.village || a.hamlet || a.suburb || a.county, a.state]
    .filter(Boolean).join(', ');
// Street results read as "12 Main St, Hoboken"; places as "Hoboken, New Jersey"
const streetName = a => a.road && [[a.house_number, a.road].filter(Boolean).join(' '),
    a.city || a.town || a.village || a.hamlet || a.suburb].filter(Boolean).join(', ');

app.get('/api/geocode', async (req, res) => {
    if (rateLimited(req, res)) return;
    try {
        if (req.query.lat !== undefined) {
            const [lat, lon] = [Number(req.query.lat), Number(req.query.lon)];
            if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return res.status(400).json({ error: 'Invalid lat/lon' });
            const r = await nominatim(`reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
            return res.json({ name: r.address ? placeName(r.address) : '' });
        }
        const q = String(req.query.q || '').trim().slice(0, 100);
        if (q.length < 2) return res.json([]);
        // Bounded to the forecast area (the lower 48): the models cover nothing else
        const rows = await nominatim(`search?format=jsonv2&addressdetails=1&countrycodes=us&limit=6`
            + `&viewbox=-134,53,-61,21&bounded=1&q=${encodeURIComponent(q.toLowerCase())}`);
        res.json(rows.map(r => {
            const a = r.address || {};
            const street = (a.house_number || r.category === 'highway' || r.type === 'house') && streetName(a);
            return { name: street || placeName(a) || r.display_name, detail: r.display_name, address: !!street,
                lat: Number(r.lat), lon: Number(r.lon) };
        }));
    } catch (err) {
        res.status(502).json({ error: 'Place search unavailable', details: err.message });
    }
});

// ============ Weather Alerts (LibreWXR / NWS-CAP) ============
// Cached per rounded location so all viewers of an area share one
// upstream request every 2 minutes.
const alertsCache = new Map();
const ALERTS_TTL_MS = 2 * MINUTE;

app.get('/api/radar/alerts', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radius = Math.min(1500, Math.max(50, parseInt(req.query.radius, 10) || 700));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
        return res.status(400).json({ error: 'Invalid lat/lon' });
    }

    const key = `${lat.toFixed(1)},${lon.toFixed(1)},${radius}`;
    const hit = alertsCache.get(key);
    if (hit && Date.now() - hit.at < ALERTS_TTL_MS) {
        res.set('X-Cache', 'HIT');
        return res.json(hit.data);
    }
    if (rateLimited(req, res)) return;

    try {
        const data = await getJson(
            `${LIBRE_HOST}/v2/alerts?lat=${lat.toFixed(1)}&lon=${lon.toFixed(1)}&radius=${radius}`, 10000);
        alertsCache.delete(key);
        alertsCache.set(key, { data, at: Date.now() });
        // Bound growth from scattered map positions
        if (alertsCache.size > 50) alertsCache.delete(alertsCache.keys().next().value);
        res.set('X-Cache', 'MISS');
        res.json(data);
    } catch (err) {
        console.error('[ALERTS]', err.message);
        if (hit) {
            res.set('X-Cache', 'STALE');
            return res.json(hit.data);
        }
        res.status(502).json({ error: 'Failed to fetch alerts', details: err.message });
    }
});

// ============ Cache Warming ============
// Prefetch the latest run for the default stations so the first visitor
// after a new run publishes gets instant charts. Negative caching keeps
// retries for not-yet-published runs cheap (one upstream attempt per
// 5 minutes at most).
const WARM_MODELS = [
    { base: '/api/sref', runs: SREF_RUNS, lagHours: 5.33, until: SREF_RETIRED_AT },
    // Tarball lands ~3h after the cycle, the last ensemble file ~3.5h
    { base: '/api/refs', runs: REFS_RUNS, lagHours: 3.6 },
];
const WARM_INTERVAL_MS = 5 * MINUTE;

/** Most recent cycle whose data should be out by `now`. */
function latestReadyRun(runs, lagHours, now = Date.now()) {
    let best = null;
    for (const dayOffset of [0, -1]) {
        const day = new Date(now + dayOffset * DAY);
        for (const run of runs) {
            const runEpoch = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(run));
            if (runEpoch + lagHours * HOUR <= now && (!best || runEpoch > best.runEpoch)) {
                best = { runEpoch, run, date: new Date(runEpoch).toISOString().slice(0, 10) };
            }
        }
    }
    return best;
}

let warming = false;
async function warmCache() {
    if (warming) return;
    warming = true;
    try {
        for (const model of WARM_MODELS) {
            // A retired model's last run is already cached
            if (model.until && Date.now() > model.until + model.lagHours * HOUR) continue;
            const latest = latestReadyRun(model.runs, model.lagHours);
            if (!latest) continue;
            for (const station of loadSettings().defaultStations) {
                for (const param of PARAMS) {
                    // Through the routes so warming shares their cache and validation
                    await fetch(`http://localhost:${PORT}${model.base}/${station}/${latest.run}/${param}?date=${latest.date}`,
                        { signal: AbortSignal.timeout(150000) }).then(r => r.arrayBuffer()).catch(() => {});
                    await new Promise(r => setTimeout(r, 250));
                }
            }
        }
    } finally {
        warming = false;
    }
}

// Drop idle rate-limit buckets, stale login failures and expired sessions
function sweep() {
    const now = Date.now();
    for (const buckets of [apiBuckets, tileBuckets]) {
        for (const [ip, b] of buckets) if (now - b.lastRefill > HOUR) buckets.delete(ip);
    }
    for (const ip of loginFailures.keys()) recentFailures(ip);
    for (const [token, created] of sessions) if (now - created > SESSION_TTL_MS) sessions.delete(token);
}

if (require.main === module) {
    app.listen(PORT, () => console.log(`SREF proxy listening on :${PORT}`));
    setTimeout(warmCache, 10000);
    setInterval(warmCache, WARM_INTERVAL_MS);
    setTimeout(warmRadarTiles, 5000);
    setInterval(warmRadarTiles, MINUTE);
    setInterval(sweep, 10 * MINUTE);
}

module.exports = { shapePlume, shapePtype, latestReadyRun, snowInches, shapeMemberSeries, shapeEnsembleMean, processSref, pickSettings, takeToken };
