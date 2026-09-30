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
    siteName: 'WX-Plumes',
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

// ============ Radar Frame Index ============
// Radar is NOAA MRMS, a scan every 2 minutes, held in RAM and rendered by the
// extractor (no nowcast). LibreWXR's index still supplies the satellite
// frames, and its radar stands in while MRMS has nothing recent (extractor
// restarting and backfilling, or a feed outage). All visitors share one
// LibreWXR request per minute.
const LIBRE_HOST = 'https://api.librewxr.net';
const MRMS_TTL_MS = 15 * 1000;       // local call; a new scan shows within 15s of the extractor having it
const MRMS_STALE_S = 20 * 60;        // newest scan older than this: fall back to LibreWXR
let radarFramesCache = { data: null, fetchedAt: 0 };
let radarFramesInFlight = null;
let mrmsCache = { times: [], fetchedAt: 0 };
let mrmsInFlight = null;

async function getLibreFrames() {
    if (radarFramesCache.data && Date.now() - radarFramesCache.fetchedAt < MINUTE) {
        return radarFramesCache.data;
    }
    // Many tile misses can expire the index at once: one upstream fetch for all
    radarFramesInFlight ??= getJson(`${LIBRE_HOST}/public/weather-maps.json`, 10000)
        .then(data => {
            radarFramesCache = { data, fetchedAt: Date.now() };
            return data;
        })
        .catch(err => {
            console.error('[RADAR]', err.message);
            if (!radarFramesCache.data) throw err;
            // Serve stale for a TTL rather than retrying upstream per tile batch
            radarFramesCache.fetchedAt = Date.now();
            return radarFramesCache.data;
        })
        .finally(() => { radarFramesInFlight = null; });
    return radarFramesInFlight;
}

// Scan times (epoch seconds, oldest first) in the extractor's ring; [] when it is unreachable
function getMrmsTimes() {
    if (Date.now() - mrmsCache.fetchedAt < MRMS_TTL_MS) return Promise.resolve(mrmsCache.times);
    mrmsInFlight ??= getJson(`${EXTRACTOR_URL}/mrms`, 5000)
        .then(d => d.frames)
        .catch(err => { console.error('[MRMS]', err.message); return []; })
        .then(times => { mrmsCache = { times, fetchedAt: Date.now() }; return times; })
        .finally(() => { mrmsInFlight = null; });
    return mrmsInFlight;
}

// NEXRAD composite frames in the extractor: { frames, revs, snow } (revs: a frame is
// rebuilt when a nearer scan lands, and its crops are cached per rev); empty when unreachable
let nexradCache = { index: null, fetchedAt: 0 };
let nexradInFlight = null;
function getNexrad() {
    if (Date.now() - nexradCache.fetchedAt < MRMS_TTL_MS) return Promise.resolve(nexradCache.index);
    nexradInFlight ??= getJson(`${EXTRACTOR_URL}/nexrad`, 5000)
        .catch(err => { console.error('[NEXRAD]', err.message); return null; })
        .then(index => { nexradCache = { index, fetchedAt: Date.now() }; return index; })
        .finally(() => { nexradInFlight = null; });
    return nexradInFlight;
}

/**
 * The page's frame index: LibreWXR's (satellite included) with radar.past
 * from MRMS while it is current, else LibreWXR's own past frames. Never a
 * nowcast. radar.source says which ('mrms' | 'librewxr'). An MRMS frame
 * with a NEXRAD composite at its time carries the composite's rev as nx, and
 * radar.snow says whether any composite frame has snow.
 */
function shapeRadarFrames(libre, mrms, now = Date.now() / 1000, nexrad = null) {
    const live = mrms.length > 0 && now - mrms[mrms.length - 1] < MRMS_STALE_S;
    const nx = new Map((nexrad?.frames || []).map((t, i) => [t, nexrad.revs[i]]));
    return {
        ...libre,
        radar: live
            ? { source: 'mrms', nowcast: [], ...(nx.size ? { snow: !!nexrad.snow } : {}),
                past: mrms.map(time => ({ time, path: `/mrms/${time}`, ...(nx.has(time) ? { nx: nx.get(time) } : {}) })) }
            : { source: 'librewxr', past: libre?.radar?.past || [], nowcast: [] },
    };
}

async function getRadarFrames() {
    const [libre, mrms, nexrad] = await Promise.all([getLibreFrames().catch(() => null), getMrmsTimes(), getNexrad()]);
    if (!libre && !mrms.length) throw new Error('No radar source reachable');
    return shapeRadarFrames(libre, mrms, undefined, nexrad);
}

app.get('/api/radar/frames', async (req, res) => {
    try {
        res.json(await getRadarFrames());
    } catch (err) {
        res.status(502).json({ error: 'Failed to fetch radar frames', details: err.message });
    }
});

// ============ Radar Tiles (proxy + cache + warming) ============
// MRMS tiles render in the extractor in ~10-30ms; LibreWXR (satellite, and
// radar when falling back) renders on demand and a cold tile can take 5-90s.
// Tiles are immutable per frame, so they are cached here, and the default
// views are pre-rendered for the newest frames.
const TILE_OPTS = '512';            // LibreWXR tile size (satellite is declared 256 client-side for 2x density)
// LibreWXR fallback style: the TWC rain table the extractor paints MRMS with
// (radar.html/css draw the legend from it); snow only exists in this fallback
const TILE_STYLE = '4/1_1';
const TILE_TTL_MS = 3 * HOUR;
const TILE_CACHE_MAX = 12000;       // 1-20KB each; ~800 warm tiles live at once plus browsing
const tileCache = new Map();        // key -> { body, type, at }
const tileInFlight = new Map();     // key -> Promise
// Radar tiles are 512px declared as 512, so source zoom = round(map zoom).
// The overview's embedded mini radar opens at 7.6 (z8, a wide box), the
// radar page at 8.2 (z8) and the overview's radar link at 8.5 (z9, the NYC
// viewport lon -75.5..-72.5, lat 39.8..41.8); 7 covers zooming out a step.
// ponytail: fixed box; derive from visitors' viewports if that matters.
const TILE_WARM = [
    { z: 7, bbox: { west: -78.5, east: -69.5, south: 38.3, north: 43.2 } },
    { z: 8, bbox: { west: -78.5, east: -69.5, south: 38.3, north: 43.2 } },
    { z: 9, bbox: { west: -75.5, east: -72.5, south: 39.8, north: 41.8 } },
];
// Newest frames warmed (~80 tiles each): the page opens on the newest and
// loads outward from it; older MRMS frames render on demand in milliseconds
const RADAR_WARM_FRAMES = 10;
const MRMS_MAXZOOM = 11;            // extractor MRMS_MAXZOOM, radar.js RADAR_MAXZOOM (tiles are drawn smooth)

// fc: 'mrms' an MRMS scan, 'sat' a satellite frame, '' a LibreWXR radar frame.
// MRMS and LibreWXR times collide (every 10-minute time is also a 2-minute one)
const tileKey = (time, z, x, y, fc, nx) => `${time}/${z}/${x}/${y}/${fc || ''}${nx ? `/${nx}` : ''}`;
const freshTile = key => {
    const hit = tileCache.get(key);
    return hit && Date.now() - hit.at < TILE_TTL_MS ? hit : null;
};

async function fetchTile(time, z, x, y, fc, nx) {
    const url = fc === 'mrms' ? `${EXTRACTOR_URL}/mrms/${time}/${z}/${x}/${y}.png${nx ? `?nx=${nx}` : ''}`
        : fc === 'sat' ? `${LIBRE_HOST}/v2/satellite/${time}/${TILE_OPTS}/${z}/${x}/${y}/0/0_0.png`
        : `${LIBRE_HOST}/v2/radar/${time}/${TILE_OPTS}/${z}/${x}/${y}/${TILE_STYLE}.png`;
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(120000)
    });
    return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
}

// Cached tile or one upstream fetch shared by everyone waiting for it.
// nx: the NEXRAD composite's rev at that time, drawn over MRMS (MRMS tiles only)
function getTile(time, z, x, y, fc, nx) {
    const key = tileKey(time, z, x, y, fc, nx);
    const hit = freshTile(key);
    if (hit) return Promise.resolve(hit);
    if (!tileInFlight.has(key)) {
        tileInFlight.set(key, fetchTile(time, z, x, y, fc, nx).then(t => {
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
// Satellite (NOAA GMGSI via LibreWXR): hourly frames
app.get('/api/radar/sat/:time/:z/:x/:y.png', (req, res) => serveTile(req, res, true));

async function serveTile(req, res, sat) {
    const [time, z, x, y] = [req.params.time, req.params.z, req.params.x, req.params.y].map(Number);
    if (![time, z, x, y].every(Number.isInteger) || z < 3 || z > 12
        || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
        return res.status(400).end();
    }
    try {
        // The client names the radar source (?src=librewxr for fallback frames):
        // MRMS and LibreWXR share times, so one must never answer for the other
        const fc = sat ? 'sat' : req.query.src === 'librewxr' ? '' : 'mrms';
        // The page overzooms MRMS past its maxzoom (radar.js RADAR_MAXZOOM)
        if (fc === 'mrms' && z > MRMS_MAXZOOM) return res.status(404).end();
        if (req.query.nx !== undefined && (fc !== 'mrms' || typeof req.query.nx !== 'string' || !/^\d{1,12}$/.test(req.query.nx))) return res.status(400).end();
        // zoomed out the extractor draws MRMS alone (extractor NX_TILE_MINZOOM): one cache entry, not one per rev
        const nx = z >= 6 ? req.query.nx : undefined;
        const key = tileKey(time, z, x, y, fc, nx);
        // A cached tile was validated when fetched: serve it without touching
        // the index (a scan may just have left the ring the client still shows)
        if (!freshTile(key) && !tileInFlight.has(key)) {
            // Only frames in that source's index. The extractor answers 404 for
            // a scan not in its ring, which keeps a few scans past the listed
            // 60 for pages whose frame list is a minute old
            if (fc !== 'mrms' && !((await getLibreFrames())[sat ? 'satellite' : 'radar']?.[sat ? 'infrared' : 'past'] || [])
                .some(f => f.time === time)) return res.status(404).end();
            // One zoom action re-requests every visible tile for all 60 frames (~1000 misses)
            if (!takeToken(req.ip, tileBuckets, 1500, 60)) return res.status(429).end();
        }
        const t = await getTile(time, z, x, y, fc, nx);
        if (t.status !== 200) return res.status(t.status === 404 ? 404 : 502).end();
        res.set('Content-Type', t.type || 'image/png');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(t.body);
    } catch {
        res.status(502).end();
    }
}

// ============ MRMS for the WebGL radar (radar-gl.js): scan crops, motion, palette ============
// The page draws MRMS itself: per scan a gray crop of raw values over its view
// and the motion field over the same box; X-Crop gives the box the extractor
// snapped to. Crops are immutable per scan and small at the zooms people use,
// so the browser caches them and nothing is kept here.
const COORD = /^-?\d{1,3}(\.\d{1,6})?$/;
function mrmsCropQuery(q) {
    if (!['w', 's', 'e', 'n'].every(k => typeof q[k] === 'string' && COORD.test(q[k]))) return null;
    const [w, s, e, n] = ['w', 's', 'e', 'n'].map(k => Number(q[k]));
    if (!(-180 <= w && w < e && e <= 180 && -90 <= s && s < n && n <= 90)) return null;
    const step = q.step === undefined ? 1 : Number(q.step);
    if (!Number.isInteger(step) || step < 1 || step > 64) return null;
    if (q.mean !== undefined && q.mean !== '1') return null;
    return `w=${w}&s=${s}&e=${e}&n=${n}&step=${step}${q.mean ? '&mean=1' : ''}`;
}

async function proxyMrms(res, path) {
    try {
        const up = await fetch(`${EXTRACTOR_URL}${path}`, { signal: AbortSignal.timeout(30000) });
        // 404: the scan left the ring, or its motion is not computed yet (the page draws a plain cross-fade)
        if (!up.ok) return res.status(up.status === 404 || up.status === 400 ? up.status : 502).end();
        res.set('Content-Type', 'image/png');
        if (up.headers.get('x-crop')) res.set('X-Crop', up.headers.get('x-crop'));
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(Buffer.from(await up.arrayBuffer()));
    } catch {
        res.status(502).end();
    }
}

app.get('/api/radar/mrms/palette.png', (req, res) => proxyMrms(res, '/mrms/palette.png'));
app.get('/api/radar/mrms/:time/:kind.png', (req, res) => {
    const { time, kind } = req.params;
    const query = mrmsCropQuery(req.query);
    if (!/^\d{10}$/.test(time) || !['crop', 'flow'].includes(kind) || !query || (kind === 'crop' && req.query.mean)) {
        return res.status(400).end();
    }
    // A view change asks for every scan's crop and motion (~120 requests): the tile bucket covers it
    // ponytail: shared with raster tiles; give crops their own bucket if quick pans start hitting 429
    if (!takeToken(req.ip, tileBuckets, 1500, 60)) return res.status(429).end();
    proxyMrms(res, `/mrms/${time}/${kind}.png?${query}`);
});

// NEXRAD composite crops (RGB: q, coverage, precip class) for the same view boxes;
// r is the frame's rev from the frame index, so a rebuilt frame is a new URL
app.get('/api/radar/nexrad/:time/crop.png', (req, res) => {
    const query = mrmsCropQuery(req.query);
    const rev = req.query.r;
    if (!/^\d{10}$/.test(req.params.time) || !query || req.query.mean || typeof rev !== 'string' || !/^\d{1,12}$/.test(rev)) {
        return res.status(400).end();
    }
    if (!takeToken(req.ip, tileBuckets, 1500, 60)) return res.status(429).end();
    proxyMrms(res, `/nexrad/${req.params.time}/crop.png?${query}&r=${rev}`);
});

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
    const { radar } = await getRadarFrames();
    const fc = radar.source === 'mrms' ? 'mrms' : '';
    // Newest frame first: it is what the page opens on
    const frames = radar.past.slice(-RADAR_WARM_FRAMES).reverse();
    // Gate on cache state per tile so failures, eviction, expiry and
    // restarts all get re-warmed; in-flight dedup keeps overlapping passes cheap
    const jobs = [];
    for (const f of frames) {
        for (const { z, bbox } of TILE_WARM) {
            for (let x = lonToX(bbox.west, z); x <= lonToX(bbox.east, z); x++) {
                for (let y = latToY(bbox.north, z); y <= latToY(bbox.south, z); y++) {
                    if (!freshTile(tileKey(f.time, z, x, y, fc, f.nx))) jobs.push(() => getTile(f.time, z, x, y, fc, f.nx));
                }
            }
        }
    }
    if (!jobs.length) return;
    const t0 = Date.now();
    // Three at a time: gentle on the extractor's CPU and on a volunteer-run service
    let i = 0;
    await Promise.all([0, 1, 2].map(async () => {
        while (i < jobs.length) { try { await jobs[i++](); } catch { /* still a miss: next pass retries */ } }
    }));
    console.log(`[RADAR WARM] ${jobs.length} ${radar.source} tiles in ${Math.round((Date.now() - t0) / 1000)}s`);
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
        // Daily rows are cut on the place's calendar, so the zone goes first
        const tz = await placeZone(lat, lon);
        const up = await fetch(`${EXTRACTOR_URL}/forecast?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&tz=${encodeURIComponent(tz)}`,
            { signal: AbortSignal.timeout(60000) });
        const body = await up.json();
        if (!up.ok) return res.status(up.status >= 500 ? 502 : up.status).json(body);
        body.tz = tz;
        // Observations turn over every 15 minutes; a building answer must not stick
        res.set('Cache-Control', body.building || body.daily_building ? 'no-store' : 'public, max-age=120');
        res.json(body);
    } catch (err) {
        res.status(502).json({ error: 'Forecast unavailable', details: err.message });
    }
});

// Rain in the next hour: a minute at a time from the newest radar scan. Apart from
// /api/forecast, whose answer the page keeps for its instant paint: minutes go stale in one.
app.get('/api/nowcast', async (req, res) => {
    const [lat, lon] = [Number(req.query.lat), Number(req.query.lon)];
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return res.status(400).json({ error: 'Invalid lat/lon' });
    if (rateLimited(req, res)) return;
    try {
        const up = await fetch(`${EXTRACTOR_URL}/nowcast?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { signal: AbortSignal.timeout(20000) });
        const body = await up.json();
        const fresh = up.ok && Date.now() / 1000 - body.time < MRMS_STALE_S;
        res.set('Cache-Control', fresh ? 'public, max-age=60' : 'no-store');
        if (!up.ok) return res.status(up.status >= 500 ? 502 : up.status).json(body);
        res.json(fresh ? body : { stale: true });
    } catch (err) {
        res.status(502).json({ error: 'Nowcast unavailable', details: err.message });
    }
});

// IANA zone for a place: NWS /points (cached with the station lookup), or
// the longitude guess when NWS has no answer within 1.5 s (the lookup keeps
// going and fills the cache for the next request) or none at all.
const TZ_NAME = /^[A-Za-z_]+\/[A-Za-z_\/+-]+$/;
const validZone = z => {
    if (typeof z !== 'string' || z.length > 48 || !TZ_NAME.test(z)) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
};
// ponytail: lower-48 longitude bands, an approximation (Arizona, the Indiana
// and Dakota splits, Alaska and Hawaii come out wrong); NWS answers cover those
const zoneByLongitude = lon => lon > -87.5 ? 'America/New_York' : lon > -101 ? 'America/Chicago'
    : lon > -114.5 ? 'America/Denver' : 'America/Los_Angeles';
async function placeZone(lat, lon, waitMs = 1500) {
    let timer;
    const late = new Promise(r => { timer = setTimeout(r, waitMs, null); });
    const zone = await Promise.race([nwsPoint(lat, lon).then(p => p.timeZone, () => null), late]);
    clearTimeout(timer);
    return validZone(zone) ? zone : zoneByLongitude(lon);
}

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

function nominatimResult(r) {
    const a = r.address || {};
    const street = (a.house_number || r.category === 'highway' || r.type === 'house') && streetName(a);
    return { name: street || placeName(a) || r.display_name, detail: r.display_name, address: !!street,
        lat: Number(r.lat), lon: Number(r.lon) };
}

/** One Photon GeoJSON feature as a search result, named the way nominatimResult names them. */
function photonResult(f) {
    const p = f.properties || {};
    const town = p.city || p.locality || p.district;
    const road = p.housenumber ? p.street : p.type === 'street' && p.name;
    const street = road && streetName({ house_number: p.housenumber, road, city: town });
    const place = p.osm_value === 'postcode' ? town || p.county : p.name || town || p.county;
    const uniq = xs => [...new Set(xs.filter(Boolean))].join(', ');
    return {
        name: street || (p.type === 'state' ? p.name : [place, p.state].filter(Boolean).join(', ')),
        detail: uniq([p.name, [p.housenumber, p.street].filter(Boolean).join(' '), p.city, p.county, p.state, p.postcode]),
        address: !!street,
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0]
    };
}

// Forward search goes to Photon (komoot): built for type-ahead, no one-a-second
// queue. A few requests at a time; Nominatim is the fallback when it fails.
const PHOTON_MAX_ACTIVE = 4;
let photonActive = 0;
const photonWaiting = [];
async function photon(q) {
    if (photonActive >= PHOTON_MAX_ACTIVE) await new Promise(r => photonWaiting.push(r));   // slot handed over
    else photonActive++;
    try {
        return await getJson('https://photon.komoot.io/api/?limit=6&lang=en&bbox=-125,24,-66,50'
            + `&osm_tag=!highway:bus_stop&q=${encodeURIComponent(q)}`, 2500);
    } finally {
        const next = photonWaiting.shift();
        if (next) next(); else photonActive--;
    }
}

async function forwardSearch(q) {
    let results;
    try {
        const data = await photon(q);
        results = (data.features || []).filter(f => f.properties?.countrycode === 'US' && f.geometry).map(photonResult);
    } catch (err) {
        console.warn(`Photon search failed (${err.message}); using Nominatim`);
        // Bounded to the forecast area (the lower 48): the models cover nothing else
        const rows = await nominatim(`search?format=jsonv2&addressdetails=1&countrycodes=us&limit=6`
            + `&viewbox=-134,53,-61,21&bounded=1&q=${encodeURIComponent(q)}`);
        results = rows.map(nominatimResult);
    }
    const seen = new Set();
    return results.filter(r => !seen.has(r.name + '|' + r.detail) && seen.add(r.name + '|' + r.detail));
}

// Forward answers cached a day by normalized query; concurrent identical queries share one lookup
const searchKey = q => String(q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
const searchCache = new Map();
function searchPlaces(key) {
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < GEOCODE_TTL_MS) return hit.promise;
    const promise = forwardSearch(key);
    searchCache.delete(key);
    if (searchCache.size >= 500) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(key, { at: Date.now(), promise });
    promise.catch(() => { if (searchCache.get(key)?.promise === promise) searchCache.delete(key); });
    return promise;
}

app.get('/api/geocode', async (req, res) => {
    if (rateLimited(req, res)) return;
    try {
        if (req.query.lat !== undefined) {
            const [lat, lon] = [Number(req.query.lat), Number(req.query.lon)];
            if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return res.status(400).json({ error: 'Invalid lat/lon' });
            // Rounded to 3 decimals, so the day-long nominatim() cache catches nearby fixes
            const r = await nominatim(`reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
            return res.json({ name: r.address ? placeName(r.address) : '' });
        }
        const key = searchKey(req.query.q);
        if (key.length < 2) return res.json([]);
        res.json(await searchPlaces(key));
    } catch (err) {
        res.status(502).json({ error: 'Place search unavailable', details: err.message });
    }
});

// ============ Observed history (NWS station observations) ============
// The last 25 clock hours at the nearest NWS station, one observation per
// hour: the one nearest the routine :51 METAR that has a temperature, else
// the latest in the hour. Hours without reports stay in, all null.
const cToF = c => c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10;
const kmhToMph = k => k == null ? null : Math.round(k / 1.609344 * 10) / 10;
// Sky cover (%) from the report's cloud layers: the most covered layer, at the middle of its oktas
const CLOUD_PCT = { SKC: 0, CLR: 0, FEW: 19, SCT: 44, BKN: 75, OVC: 100, VV: 100 };
const cloudCover = layers => {
    const v = (layers || []).map(l => CLOUD_PCT[l.amount]).filter(x => x != null);
    return v.length ? Math.max(...v) : null;
};

function bucketObservations(features, nowMs) {
    const byHour = new Map();
    for (const f of features || []) {
        const p = f.properties || {};
        const at = Date.parse(p.timestamp);
        if (!Number.isFinite(at)) continue;
        const t = Math.floor(at / HOUR) * HOUR;
        if (!byHour.has(t)) byHour.set(t, []);
        byHour.get(t).push({ p, at });
    }
    const end = Math.floor(nowMs / HOUR) * HOUR;
    const hours = [];
    for (let t = end - 24 * HOUR; t <= end; t += HOUR) {
        const obs = byHour.get(t) || [];
        // Nearest :51; ties go to a METAR/SPECI (non-empty rawMessage), then the later report
        const nearest51 = list => list.reduce((a, b) => {
            if (!a) return b;
            const da = Math.abs((a.at - t) / MINUTE - 51), db = Math.abs((b.at - t) / MINUTE - 51);
            if (db !== da) return db < da ? b : a;
            if (!!a.p.rawMessage !== !!b.p.rawMessage) return b.p.rawMessage ? b : a;
            return b.at > a.at ? b : a;
        }, null);
        const withTemp = obs.filter(o => o.p.temperature?.value != null);
        // No temperature anywhere in the hour: the latest report
        const pick = withTemp.length ? nearest51(withTemp) : obs.reduce((a, b) => (!a || b.at > a.at ? b : a), null);
        const p = pick?.p || {};
        // 5-minute reports carry no precipitation; take it from the hour's METAR
        const metar = nearest51(obs.filter(o => o.p.rawMessage && o.p.precipitationLastHour?.value != null));
        const mm = (metar?.p || p).precipitationLastHour?.value;
        hours.push({
            t,
            tmp: cToF(p.temperature?.value),
            dpt: cToF(p.dewpoint?.value),
            wind: kmhToMph(p.windSpeed?.value),
            dir: p.windDirection?.value ?? null,
            gust: kmhToMph(p.windGust?.value),
            precip: mm == null ? null : Math.round(mm / 25.4 * 1000) / 1000,
            text: p.textDescription || null,
            cloud: cloudCover(p.cloudLayers)
        });
    }
    return hours;
}

const kmBetween = (lat1, lon1, lat2, lon2) => {
    const r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2
        + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
};

// NWS /points for a place (its station list and time zone) and place ->
// station change only when NWS redraws its grid; observations every 10
// minutes per station. Concurrent askers share one request.
// ponytail: unbounded Maps, fine at personal-tool scale; add an LRU cap if traffic grows
const pointsCache = new Map();
const stationCache = new Map();
const obsCache = new Map();
function nwsPoint(lat, lon) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = pointsCache.get(key);
    if (hit && (hit.pending || Date.now() - hit.at < (hit.ok ? 7 * DAY : DAY))) return hit.promise;
    const promise = getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, 10000)
        .then(d => d.properties);
    const entry = { promise, pending: true };
    pointsCache.set(key, entry);
    promise.then(() => Object.assign(entry, { pending: false, ok: true, at: Date.now() }),
        err => {
            // Outside NWS coverage stays known for a day; other failures retry next time
            if (err.status !== 404) return pointsCache.delete(key);
            Object.assign(entry, { pending: false, ok: false, at: Date.now(),
                promise: Promise.reject(Object.assign(new Error('Outside NWS coverage'), { status: 404 })) });
            entry.promise.catch(() => {});
        });
    return promise;
}

async function nearestStation(lat, lon) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = stationCache.get(key);
    if (hit && Date.now() - hit.at < 7 * DAY) return hit.station;
    const point = await nwsPoint(lat, lon);
    const list = await getJson(point.observationStations, 10000);
    const f = list.features?.[0];
    if (!f) throw Object.assign(new Error('No observation station near this place'), { status: 404 });
    const [slon, slat] = f.geometry.coordinates;
    const station = { id: f.properties.stationIdentifier, name: f.properties.name, lat: slat, lon: slon };
    stationCache.set(key, { station, at: Date.now() });
    return station;
}

function stationObservations(id) {
    const hit = obsCache.get(id);
    if (hit && (hit.pending || Date.now() - hit.at < 10 * MINUTE)) return hit.promise;
    const start = new Date(Date.now() - 26 * HOUR).toISOString().replace(/\.\d+Z$/, 'Z');
    const promise = getJson(`https://api.weather.gov/stations/${id}/observations?start=${start}&limit=500`, 15000)
        .then(d => d.features || []);
    const entry = { promise, pending: true };
    obsCache.set(id, entry);
    promise.then(() => Object.assign(entry, { pending: false, at: Date.now() }), () => obsCache.delete(id));
    return promise;
}

app.get('/api/history', async (req, res) => {
    const [lat, lon] = [Number(req.query.lat), Number(req.query.lon)];
    if (req.query.lat === '' || req.query.lon === '' || !(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
        return res.status(400).json({ error: 'Invalid lat/lon' });
    }
    if (rateLimited(req, res)) return;
    try {
        const s = await nearestStation(lat, lon);
        const features = await stationObservations(s.id);
        res.set('Cache-Control', 'public, max-age=300');
        res.json({
            station: { id: s.id, name: s.name, km: Math.round(kmBetween(lat, lon, s.lat, s.lon) * 10) / 10 },
            hours: bucketObservations(features, Date.now())
        });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: 'No NWS observations for this place' });
        res.status(502).json({ error: 'Observations unavailable', details: err.message });
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
    for (const buckets of [apiBuckets, tileBuckets, ogBuckets]) {
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

// ============ Link-preview card (/api/og.png) ============
// A 1200x630 PNG of a place right now, as the overview's hero draws it: the name, the temperature,
// and the spiral (the last 24 hours observed, the next 24 forecast) on the color field. Drawn with
// the page's own pure modules (frontend/js: the spiral's geometry, the colors, the sun) and fonts
// cut from the page's variable font at the hero's settings, rasterized without a browser.
const { Resvg } = require('@resvg/resvg-js');
const { pathToFileURL } = require('url');
const SHARED = fs.existsSync(path.join(__dirname, 'shared')) ? path.join(__dirname, 'shared') : path.join(__dirname, '..', 'frontend', 'js');
let sharedMods = null;
const sharedModules = () => sharedMods ??= Promise.all(['signal.js', 'forecast.js', 'zone.js']
    .map(f => import(pathToFileURL(path.join(SHARED, f)).href)));
const OG_FONTS = ['AnybodyHero', 'AnybodyNum', 'AnybodyText', 'AnybodyBold'].map(f => path.join(__dirname, 'fonts', `${f}.ttf`));
const NYC = { lat: 40.7128, lon: -74.006, name: 'New York, NY' };
const OG_TTL_MS = 10 * MINUTE;
const ogCache = new Map();   // "lat,lon" (2 decimals) -> { at, png | promise }
const ogBuckets = new Map();

// oklch() -> #rrggbb (resvg reads sRGB colors only)
function oklchHex(css) {
    const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(css);
    if (!m) return css;
    const [L, C, H] = m.slice(1).map(Number), h = H * Math.PI / 180;
    const a = C * Math.cos(h), b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
        s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * s];
    return '#' + lin.map(v => {
        const c = Math.min(1, Math.max(0, v)), g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
        return Math.round(g * 255).toString(16).padStart(2, '0');
    }).join('');
}
const esc = t => String(t).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The overview's light theme (overview.css), as sRGB
const OG = { paper: '#f3f0e8', ink: '#141312', missing: '#dcd7cb', rain: oklchHex('oklch(0.58 0.14 248)'), wind: oklchHex('oklch(0.56 0.09 175)'),
    sky: oklchHex('oklch(0.93 0.035 232)'), night: oklchHex('oklch(0.5 0.09 262)'),
    cloud: oklchHex('oklch(0.965 0.016 234)'), cloudNight: oklchHex('oklch(0.57 0.07 262)') };

// The card's SVG for a place's forecast body (the extractor's /forecast) and observed hours
async function ogSvg(place, body, hist, tz, now) {
    const [sg, fc, Z] = await sharedModules();
    const rows = body.hourly ? fc.hourlyRows(body.hourly) : [];
    const upcoming = rows.filter(r => r.t + HOUR > now);
    const temp = body.now?.tmp ?? upcoming[0]?.tmp ?? null;
    const nights = [];
    for (let d = -1; d <= 1; d++) {
        const day = Z.noon(now, tz) + d * DAY;
        const set = fc.sunTimes(day, place.lat, place.lon, tz).set, rise = fc.sunTimes(day + DAY, place.lat, place.lon, tz).rise;
        if (set && rise) nights.push([set, rise]);
    }
    const past = (hist || []).map(h => ({ t: h.t, tmp: h.tmp, precip: h.precip, cloud: h.cloud, wind: h.wind, dir: h.dir }));
    const future = upcoming.slice(0, 26);
    const sp = sg.spiral({ past, future, now, nowTemp: temp, nights });
    const col = f => oklchHex(sg.rampColor(f));
    // the field: stops every two hours over the next day, each the three-hour mean's color
    const next = upcoming.slice(0, 25), stops = [];
    for (let i = 0; i < next.length; i += 2) {
        const win = next.slice(Math.max(0, i - 1), i + 2).map(r => r.tmp).filter(Number.isFinite);
        if (win.length) stops.push(`<stop offset="${(i / Math.max(1, next.length - 1)).toFixed(3)}" stop-color="${oklchHex(sg.fieldColor(win.reduce((a, b) => a + b, 0) / win.length, false))}"/>`);
    }
    const field = stops.length ? stops.join('') : `<stop offset="0" stop-color="${oklchHex(sg.fieldColor(temp ?? 65, false))}"/>`;
    // the spiral, in its own 600 x 612 box (viewBox -40 -40), scaled into the card's right side
    const g = [];
    g.push(`<circle cx="${sg.SPIRAL.C}" cy="${sg.SPIRAL.C}" r="272" fill="${OG.paper}"/>`);
    for (const k of sp.skies) g.push(`<path d="${k.d}" fill="${OG.sky}"/>`);
    for (const n of sp.nights) g.push(`<path d="${n.d}" fill="${OG.night}"/>`);
    for (const h of sp.hours) if (h.bar) g.push(`<path d="${h.bar}" fill="${h.night ? OG.cloudNight : OG.cloud}"/>`);
    g.push(`<mask id="band"><path d="${sp.track}" fill="none" stroke="#fff" stroke-width="44" stroke-linecap="round"/><circle cx="${sp.notch.x}" cy="${sp.notch.y}" r="${sp.notch.r}" fill="#000"/></mask><g mask="url(#band)">`);
    for (const seg of sp.segs) {
        const c = seg.tmp == null ? OG.missing : col(seg.tmp);
        g.push(`<path d="${seg.d}" fill="${c}" stroke="${c}" stroke-width="0.6"/>`);
    }
    const end = sp.caps[1];
    g.push(`<circle cx="${end.x}" cy="${end.y}" r="${end.r}" fill="${end.tmp == null ? OG.missing : col(end.tmp)}"/>`);
    for (const r of sp.rain) g.push(`<path d="${r.d}" fill="${OG.rain}"/>`);
    g.push('</g>');
    for (const h of sp.hours) if (h.arrow) g.push(`<line x1="${h.arrow.x}" y1="${h.arrow.y}" x2="${h.arrow.x2.toFixed(1)}" y2="${h.arrow.y2.toFixed(1)}" stroke="${OG.wind}" stroke-width="2" stroke-linecap="round"/><path d="${h.arrow.head}" fill="${OG.wind}"/>`);
    g.push(`<circle cx="${sp.now.x}" cy="${sp.now.y}" r="7" fill="${OG.paper}" stroke="${OG.ink}" stroke-width="3"/>`);
    g.push(`<text x="${sp.now.x}" y="${(sp.now.y - 17).toFixed(1)}" font-family="AnybodyBold" font-size="12" letter-spacing="1.5" text-anchor="middle" fill="${OG.ink}">NOW</text>`);
    // the center: the day behind against the day ahead
    const C = sg.SPIRAL.C, tb = sp.table, deg = v => (v == null ? '—' : `${Math.round(v)}°`);
    const inches = v => (v < 0.005 ? 'Dry' : v < 0.1 ? `${v.toFixed(2).replace(/^0/, '')}"` : `${v.toFixed(1)}"`);
    const cell = (x, y, font, size, text) => g.push(`<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" text-anchor="middle" fill="${OG.ink}">${esc(text)}</text>`);
    cell(C - 46, C - 56, 'AnybodyBold', 12, 'Last 24 h');
    cell(C + 46, C - 56, 'AnybodyBold', 12, 'Next 24 h');
    [['rain', tb.pastRain == null ? '—' : inches(tb.pastRain), future.length ? inches(tb.nextRain) : '—'], ['low', deg(tb.pastLow), deg(tb.nextLow)], ['high', deg(tb.pastHigh), deg(tb.nextHigh)]]
        .forEach(([k, a, b], i) => {
            const y = C - 18 + i * 44;
            cell(C - 46, y, 'AnybodyNum', 28, a);
            cell(C + 46, y, 'AnybodyNum', 28, b);
            cell(C, y + 15, 'AnybodyBold', 12, k);
        });
    const k = 560 / 600;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="field" x1="0" x2="1" y1="0" y2="0">${field}</linearGradient></defs>
<rect width="1200" height="630" fill="url(#field)"/>
<text x="64" y="96" font-family="AnybodyText" font-size="30" fill="${OG.ink}">${esc(place.name)}</text>
<text x="52" y="468" font-family="AnybodyHero" font-size="360" fill="${OG.ink}">${temp == null ? '--' : `${Math.round(temp)}°`}</text>
<g transform="translate(${(610 + 40 * k).toFixed(1)} ${(22 + 40 * k).toFixed(1)}) scale(${k.toFixed(4)})">${g.join('')}</g>
</svg>`;
}

// The place for a card request: ?at=lat,lon (named by reverse geocoding when drawn), ?station= (a
// REFS plume station), else New York. null when the query is malformed. No lookups here: a request
// that the cache or the rate limit answers must not queue a reverse geocode.
function ogPlace(q) {
    if (typeof q.at === 'string') {
        const m = /^(-?\d{1,2}(?:\.\d{1,6})?),(-?\d{1,3}(?:\.\d{1,6})?)$/.exec(q.at);
        if (!m) return null;
        const lat = Number(m[1]), lon = Number(m[2]);
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        return { lat, lon, name: null };
    }
    if (typeof q.station === 'string') {
        const id = q.station.toUpperCase();
        if (!/^[A-Z]{3,4}$/.test(id)) return null;
        let st = null;
        try { st = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'refs-stations.json'), 'utf8')).stations; } catch { /* list not built yet */ }
        const hit = st?.[id] || st?.[`K${id}`];
        return hit ? { lat: hit.lat, lon: hit.lon, name: id } : { ...NYC };
    }
    return { ...NYC };
}

async function ogPng(place) {
    const now = Date.now();
    if (place.name == null) {
        try {
            const r = await nominatim(`reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${place.lat.toFixed(3)}&lon=${place.lon.toFixed(3)}`);
            place = { ...place, name: r.address ? placeName(r.address) : '' };
        } catch { /* unnamed */ }
        place.name ||= `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}`;
    }
    const tz = await placeZone(place.lat, place.lon);
    const [body, hist] = await Promise.all([
        fetch(`${EXTRACTOR_URL}/forecast?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}&tz=${encodeURIComponent(tz)}`,
            { signal: AbortSignal.timeout(60000) }).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
        nearestStation(place.lat, place.lon).then(s => stationObservations(s.id)).then(f => bucketObservations(f, now)).catch(() => []),
    ]);
    const svg = await ogSvg(place, body, hist, tz, now);
    const png = new Resvg(svg, { font: { fontFiles: OG_FONTS, loadSystemFonts: false, defaultFontFamily: 'AnybodyText' } }).render().asPng();
    return { png, building: !body.hourly || !!body.building };   // a new region's forecast is still being cut
}

app.get('/api/og.png', async (req, res) => {
    try {
        const place = ogPlace(req.query);
        if (!place) return res.status(400).json({ error: 'Invalid place' });
        const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
        let hit = ogCache.get(key);
        if (!hit || Date.now() - hit.at > (hit.building ? MINUTE : OG_TTL_MS)) {
            // a new card costs a geocode, a forecast and the station's observations: crawlers retry, so
            // rate-limit the misses (an old card, when there is one, rather than nothing)
            if (!takeToken(req.ip, ogBuckets, 20, 0.2)) {
                if (!hit) return res.status(429).end();
            } else {
                hit = { at: Date.now(), png: ogPng(place) };
                ogCache.delete(key);   // most recently drawn last: the eviction below takes the oldest
                ogCache.set(key, hit);
                if (ogCache.size > 200) ogCache.delete(ogCache.keys().next().value);
                const mine = hit;
                mine.png.then(r => { mine.building = r.building; }, () => { if (ogCache.get(key) === mine) ogCache.delete(key); });
            }
        }
        const { png, building } = await hit.png;
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', `public, max-age=${building ? 60 : 600}`);
        res.send(png);
    } catch (err) {
        console.error('[OG]', err.message);
        res.status(502).end();
    }
});

module.exports = { app, oklchHex, ogSvg, shapeRadarFrames, mrmsCropQuery, shapePlume, shapePtype, latestReadyRun, snowInches, shapeMemberSeries, shapeEnsembleMean, processSref, pickSettings, takeToken, bucketObservations, zoneByLongitude, validZone, photonResult, searchKey };
