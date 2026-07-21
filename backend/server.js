const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// Behind the nginx container (one proxy hop) - required so req.ip reflects
// the real client from X-Forwarded-For instead of the nginx container IP.
// Without this, all visitors share one rate-limit bucket.
app.set('trust proxy', 1);

// Body limit sized for base64 image uploads (admin favicon/OG image)
app.use(express.json({ limit: '15mb' }));

// ============ Persistent Cache ============
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
let cache = new Map();

// Ensure data directory exists
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
} catch (err) {
    console.error('[CACHE] Failed to create data dir:', err);
}

// Load cache from disk on startup
try {
    if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const json = JSON.parse(raw);
        const now = Date.now();
        Object.entries(json).forEach(([key, val]) => {
            if (val.expiry > now) {
                cache.set(key, val);
            }
        });
        console.log(`[CACHE] Loaded ${cache.size} items from disk`);
    }
} catch (err) {
    console.error('[CACHE] Failed to load cache from disk:', err);
}

/**
 * Get a cache entry (with flags), or null if missing/expired.
 * Entries may carry `incomplete` (partial member set, short TTL) or
 * `negative` (upstream failure, short TTL) flags.
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

const CACHE_MAX_ENTRIES = 1000;
const CACHE_TTL_DAYS = 14;       // Complete runs are immutable - keep for 14 days
const INCOMPLETE_TTL_MS = 10 * 60 * 1000;  // Partial data: retry after 10 min
const NEGATIVE_TTL_MS = 5 * 60 * 1000;     // Upstream failure: retry after 5 min

function setInCache(key, data, ttlMs = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000, flags = {}) {
    // Evict oldest entries if at capacity
    if (cache.size >= CACHE_MAX_ENTRIES) {
        // Find oldest entries by cachedAt timestamp
        const entries = [...cache.entries()].sort((a, b) =>
            new Date(a[1].cachedAt) - new Date(b[1].cachedAt)
        );
        // Remove oldest 10% to avoid constant eviction
        const toRemove = Math.ceil(CACHE_MAX_ENTRIES * 0.1);
        for (let i = 0; i < toRemove && i < entries.length; i++) {
            cache.delete(entries[i][0]);
            console.log(`[CACHE] Evicted: ${entries[i][0]}`);
        }
    }

    cache.set(key, {
        data,
        expiry: Date.now() + ttlMs,
        cachedAt: new Date().toISOString(),
        ...flags
    });
    saveCacheToDisk();
}

let saveTimeout;
function saveCacheToDisk() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        try {
            const obj = Object.fromEntries(cache);
            fs.writeFile(CACHE_FILE, JSON.stringify(obj), (err) => {
                if (err) console.error('[CACHE] Write error:', err);
            });
        } catch (err) {
            console.error('[CACHE] Serialize error:', err);
        }
    }, 5000);
}

/**
 * Fetch data from NOAA SREF API
 */
function fetchFromNOAA(station, run, param, date) {
    return new Promise((resolve, reject) => {
        const ymd = date.replace(/-/g, '');
        const reqPath = `/exper/sref/srefplumes/returndata.php?` +
            `search=${station}-${run}-${param}` +
            `&file=json_sid/${ymd}_${run}/${station}` +
            `&mem=:&means=`;

        const options = {
            hostname: 'www.spc.noaa.gov',
            port: 443,
            path: reqPath,
            method: 'GET',
            headers: {
                'User-Agent': 'SREF-Viewer/1.0 (Personal Weather Tool)',
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`NOAA returned ${res.statusCode}`));
                    return;
                }
                try {
                    let parsed;
                    try {
                        parsed = JSON.parse(JSON.parse(data));
                    } catch {
                        parsed = JSON.parse(data);
                    }
                    resolve(parsed);
                } catch (e) {
                    reject(new Error('Failed to parse NOAA response'));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

/**
 * Fetch with exponential backoff retry
 * Retries on network errors and 5xx status codes
 */
async function fetchWithRetry(station, run, param, date, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fetchFromNOAA(station, run, param, date);
        } catch (err) {
            const isRetryable = err.message.includes('timeout') ||
                err.message.includes('ECONNRESET') ||
                err.message.includes('NOAA returned 5');

            if (attempt === retries || !isRetryable) {
                throw err;
            }

            const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
            console.log(`[RETRY] Attempt ${attempt} failed (${err.message}), retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

/**
 * Process raw NOAA data into a cleaner format with computed mean
 */
function processData(raw) {
    const processed = {};
    const timePoints = new Set();

    for (const [label, series] of Object.entries(raw)) {
        if (!series.data || series.data.length === 0) continue;
        processed[label] = series.data.map(([time, value]) => {
            timePoints.add(time);
            return { x: time, y: parseFloat(value) || 0 };
        });
    }

    const sortedTimes = Array.from(timePoints).sort((a, b) => a - b);
    const memberKeys = Object.keys(processed);

    if (memberKeys.length > 0) {
        const sums = new Map();
        for (const key of memberKeys) {
            for (const p of processed[key]) {
                const agg = sums.get(p.x) || { sum: 0, count: 0 };
                agg.sum += p.y;
                agg.count++;
                sums.set(p.x, agg);
            }
        }
        processed['Mean'] = sortedTimes.map(time => {
            const agg = sums.get(time);
            return { x: time, y: agg && agg.count > 0 ? agg.sum / agg.count : 0 };
        });
    }

    return processed;
}

// ============ API Rate Limiting (Token Bucket) ============
// Token bucket allows bursts for initial cache population, then refills over time
const rateBuckets = new Map();
const BUCKET_MAX = 50;        // Max tokens (allows burst of 50 requests)
const REFILL_RATE = 1;        // Tokens added per second
const REFILL_INTERVAL = 1000; // 1 second

function checkApiRateLimit(ip) {
    const now = Date.now();
    let bucket = rateBuckets.get(ip);

    if (!bucket) {
        // New user gets a full bucket
        bucket = { tokens: BUCKET_MAX, lastRefill: now };
        rateBuckets.set(ip, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(elapsed / REFILL_INTERVAL) * REFILL_RATE;
    bucket.tokens = Math.min(BUCKET_MAX, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // Try to consume a token
    if (bucket.tokens > 0) {
        bucket.tokens--;
        return true;
    }

    return false;
}

// ============ Routes ============

app.get('/health', (req, res) => {
    res.json({ status: 'ok', cacheSize: cache.size, uptime: process.uptime() });
});

app.get('/api/cache-stats', (req, res) => {
    const stats = { entries: cache.size, keys: [] };
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        stats.keys.push({
            key,
            cachedAt: value.cachedAt,
            expiresIn: Math.round((value.expiry - now) / 1000 / 60) + ' minutes'
        });
    }
    res.json(stats);
});

app.get('/api/sref/:station/:run/:param', async (req, res) => {
    const { station, run, param } = req.params;
    const date = req.query.date || new Date().toISOString().split('T')[0];

    // Validate inputs
    if (!/^[A-Za-z]{3,4}$/.test(station)) {
        return res.status(400).json({ error: 'Invalid station format' });
    }
    const validRuns = ['03', '09', '15', '21'];
    const validParams = ['Total-SNO', '3hrly-SNO', 'Total-QPF', '3hrly-QPF', '3hrly-TMP', '3h-10mWND'];

    if (!validRuns.includes(run)) {
        return res.status(400).json({ error: 'Invalid run time' });
    }
    if (!validParams.includes(param)) {
        return res.status(400).json({ error: 'Invalid parameter' });
    }

    const cacheKey = `${date}_${run}_${station}_${param}`;

    // Check cache first - cache hits don't count against rate limit
    const cached = getFromCache(cacheKey);
    if (cached) {
        if (cached.negative) {
            console.log(`[NEGATIVE HIT] ${cacheKey}`);
            res.set('X-Cache', 'NEGATIVE');
            return res.status(502).json({ error: 'Failed to fetch from NOAA', details: cached.data, cached: true });
        }
        console.log(`[CACHE HIT] ${cacheKey}${cached.incomplete ? ' (incomplete)' : ''}`);
        res.set('X-Cache', cached.incomplete ? 'INCOMPLETE-HIT' : 'HIT');
        return res.json(cached.data);
    }

    // Rate limiting only for cache misses (actual NOAA requests)
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkApiRateLimit(ip)) {
        console.log(`[RATE LIMIT] ${ip} - ${cacheKey}`);
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }

    console.log(`[CACHE MISS] ${cacheKey} - fetching from NOAA...`);

    try {
        const raw = await fetchWithRetry(station.toUpperCase(), run, param, date);
        const processed = processData(raw);
        const memberCount = Object.keys(processed).filter(k => k !== 'Mean').length;

        if (memberCount >= 10) {
            setInCache(cacheKey, processed);
            console.log(`[CACHED] ${cacheKey} for ${CACHE_TTL_DAYS} days (${memberCount} members)`);
            res.set('X-Cache', 'MISS');
        } else {
            // Cache partial data briefly so every visitor doesn't re-hit NOAA
            // for runs that aren't fully published yet
            setInCache(cacheKey, processed, INCOMPLETE_TTL_MS, { incomplete: true });
            console.log(`[CACHED INCOMPLETE] ${cacheKey} for 10 min (${memberCount} members)`);
            res.set('X-Cache', 'INCOMPLETE');
        }

        res.json(processed);
    } catch (err) {
        console.error(`[ERROR] ${cacheKey}:`, err.message);
        // Negative-cache the failure so repeated loads don't hammer NOAA
        // for runs/dates that don't exist
        setInCache(cacheKey, err.message, NEGATIVE_TTL_MS, { negative: true });
        res.status(502).json({ error: 'Failed to fetch from NOAA', details: err.message });
    }
});

// ============ Admin Panel ============
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure uploads directory exists
try {
    if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
} catch (err) {
    console.error('[ADMIN] Failed to create uploads dir:', err);
}

// Admin credentials from environment
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'changeme';

// Constant-time string comparison to avoid timing side-channels on login
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length) {
        // Compare b against itself to keep timing consistent
        crypto.timingSafeEqual(bufB, bufB);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

// Active sessions (in-memory, cleared on restart)
const sessions = new Map();

// Default settings
const DEFAULT_SETTINGS = {
    siteName: 'NYC SREF Ensemble Plumes',
    siteDescription: 'SREF ensemble plume diagrams for weather forecasting',
    favicon: '',
    ogImage: '',
    defaultStations: ['JFK', 'LGA', 'EWR'],
    analyticsScript: '',
    analyticsEnabled: false,
    customCss: ''
};

// Load settings
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
            return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        }
    } catch (err) {
        console.error('[ADMIN] Failed to load settings:', err);
    }
    return { ...DEFAULT_SETTINGS };
}

// Save settings
function saveSettings(settings) {
    try {
        // Ensure data directory exists
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        console.log('[ADMIN] Settings saved to:', SETTINGS_FILE);
        return true;
    } catch (err) {
        console.error('[ADMIN] Failed to save settings:', err.message);
        console.error('[ADMIN] Settings file path:', SETTINGS_FILE);
        console.error('[ADMIN] Full error:', err);
        return false;
    }
}

// Generate session token
function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { created: Date.now() });
    return token;
}

// Validate session
function validateSession(token) {
    if (!token) return false;
    const session = sessions.get(token);
    if (!session) return false;
    // Sessions expire after 24 hours
    if (Date.now() - session.created > 24 * 60 * 60 * 1000) {
        sessions.delete(token);
        return false;
    }
    return true;
}

// Auth middleware
function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!validateSession(token)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Rate limiting for login (simple in-memory)
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

function checkRateLimit(ip) {
    const now = Date.now();
    const attempts = loginAttempts.get(ip) || [];
    // Filter to recent attempts only
    const recentAttempts = attempts.filter(t => now - t < RATE_LIMIT_WINDOW);
    loginAttempts.set(ip, recentAttempts);
    return recentAttempts.length < MAX_ATTEMPTS;
}

function recordLoginAttempt(ip) {
    const attempts = loginAttempts.get(ip) || [];
    attempts.push(Date.now());
    loginAttempts.set(ip, attempts);
}

// Admin login
app.post('/api/admin/login', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;

    if (!checkRateLimit(ip)) {
        console.log(`[ADMIN] Rate limited: ${ip}`);
        return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }

    const { username, password } = req.body;

    if (safeEqual(username, ADMIN_USER) && safeEqual(password, ADMIN_PASS)) {
        const token = createSession();
        console.log('[ADMIN] Login successful');
        res.json({ token });
    } else {
        recordLoginAttempt(ip);
        console.log('[ADMIN] Login failed');
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// Check auth status
app.get('/api/admin/check', requireAuth, (req, res) => {
    res.json({ authenticated: true });
});

// Get settings
app.get('/api/admin/settings', requireAuth, (req, res) => {
    res.json(loadSettings());
});

// Update settings
app.post('/api/admin/settings', requireAuth, (req, res) => {
    const current = loadSettings();
    const updated = { ...current, ...req.body };

    // Validate
    if (updated.defaultStations && !Array.isArray(updated.defaultStations)) {
        return res.status(400).json({ error: 'defaultStations must be an array' });
    }

    if (saveSettings(updated)) {
        console.log('[ADMIN] Settings updated');
        res.json(updated);
    } else {
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// File upload (favicon, OG image)
app.post('/api/admin/upload/:type', requireAuth, (req, res) => {
    const { type } = req.params;

    if (!['favicon', 'ogImage'].includes(type)) {
        return res.status(400).json({ error: 'Invalid upload type' });
    }

    // Simple base64 upload handling
    const { data, filename } = req.body;
    if (!data || !filename) {
        return res.status(400).json({ error: 'Missing data or filename' });
    }

    // Validate file extension
    const ext = path.extname(filename).toLowerCase();
    const allowedExts = type === 'favicon'
        ? ['.ico', '.png', '.svg']
        : ['.jpg', '.jpeg', '.png', '.webp'];

    if (!allowedExts.includes(ext)) {
        return res.status(400).json({ error: `Invalid file type. Allowed: ${allowedExts.join(', ')}` });
    }

    // Sanitize filename
    const safeName = `${type}${ext}`;
    const filePath = path.join(UPLOADS_DIR, safeName);

    try {
        // Decode base64 and save
        const buffer = Buffer.from(data, 'base64');
        fs.writeFileSync(filePath, buffer);

        // Update settings with the file path
        const settings = loadSettings();
        settings[type] = `/uploads/${safeName}`;
        saveSettings(settings);

        console.log(`[ADMIN] Uploaded ${type}: ${safeName}`);
        res.json({ path: `/uploads/${safeName}` });
    } catch (err) {
        console.error('[ADMIN] Upload error:', err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));

// Public settings endpoint (for frontend to load site config)
app.get('/api/settings', (req, res) => {
    const settings = loadSettings();
    // Don't expose admin-only fields
    res.json({
        siteName: settings.siteName,
        siteDescription: settings.siteDescription,
        favicon: settings.favicon,
        ogImage: settings.ogImage,
        defaultStations: settings.defaultStations,
        analyticsScript: settings.analyticsEnabled ? settings.analyticsScript : '',
        customCss: settings.customCss
    });
});

// ============ Radar Frame Index (LibreWXR) ============
// Proxies the LibreWXR frame catalog so all visitors share one upstream
// request per minute. Tiles themselves load directly from api.librewxr.net.
let radarFramesCache = { data: null, fetchedAt: 0 };
const RADAR_FRAMES_TTL_MS = 60 * 1000;

function fetchRadarFrames() {
    return new Promise((resolve, reject) => {
        const req = https.get('https://api.librewxr.net/public/weather-maps.json', {
            headers: { 'User-Agent': 'SREF-Viewer/1.0 (Personal Weather Tool)', 'Accept': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`LibreWXR returned ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error('Failed to parse LibreWXR response'));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('LibreWXR request timeout'));
        });
    });
}

app.get('/api/radar/frames', async (req, res) => {
    const now = Date.now();
    if (radarFramesCache.data && now - radarFramesCache.fetchedAt < RADAR_FRAMES_TTL_MS) {
        res.set('X-Cache', 'HIT');
        return res.json(radarFramesCache.data);
    }
    try {
        const data = await fetchRadarFrames();
        radarFramesCache = { data, fetchedAt: now };
        res.set('X-Cache', 'MISS');
        res.json(data);
    } catch (err) {
        console.error('[RADAR]', err.message);
        // Serve stale frames if we have them - better than nothing
        if (radarFramesCache.data) {
            res.set('X-Cache', 'STALE');
            return res.json(radarFramesCache.data);
        }
        res.status(502).json({ error: 'Failed to fetch radar frames', details: err.message });
    }
});

// ============ Start Server ============
app.listen(PORT, () => {
    console.log(`SREF Proxy running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
