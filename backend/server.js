const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

// ============ In-Memory Cache ============
const cache = new Map();

// SREF model runs at 03Z, 09Z, 15Z, 21Z
// Data typically available ~2 hours after run time
const MODEL_RUNS = [3, 9, 15, 21];

/**
 * Calculate cache TTL based on when the next model run will be available
 * @param {number} runHour - The model run hour (3, 9, 15, or 21)
 * @returns {number} TTL in milliseconds
 */
function getCacheTTL(runHour) {
    const now = new Date();
    const currentUTC = now.getUTCHours();

    // Find the next run after the requested one
    const runIndex = MODEL_RUNS.indexOf(runHour);
    const nextRunHour = MODEL_RUNS[(runIndex + 1) % MODEL_RUNS.length];

    // Calculate hours until next run + 2 hours for processing
    let hoursUntilNext;
    if (nextRunHour > currentUTC) {
        hoursUntilNext = nextRunHour - currentUTC + 2;
    } else {
        hoursUntilNext = (24 - currentUTC) + nextRunHour + 2;
    }

    // Minimum 1 hour, maximum 8 hours
    const ttlHours = Math.max(1, Math.min(8, hoursUntilNext));
    return ttlHours * 60 * 60 * 1000;
}

/**
 * Get cached data or null if expired/missing
 */
function getFromCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expires) {
        cache.delete(key);
        return null;
    }

    return entry.data;
}

/**
 * Store data in cache with TTL
 */
function setInCache(key, data, ttlMs) {
    cache.set(key, {
        data,
        expires: Date.now() + ttlMs,
        cachedAt: new Date().toISOString()
    });

    // Prune old entries periodically (keep cache under control)
    if (cache.size > 1000) {
        const now = Date.now();
        for (const [k, v] of cache.entries()) {
            if (now > v.expires) cache.delete(k);
        }
    }
}

/**
 * Fetch data from NOAA SREF API
 */
function fetchFromNOAA(station, run, param, date) {
    return new Promise((resolve, reject) => {
        const ymd = date.replace(/-/g, '');
        const path = `/exper/sref/srefplumes/returndata.php?` +
            `search=${station}-${run}-${param}` +
            `&file=json_sid/${ymd}_${run}/${station}` +
            `&mem=:&means=`;

        const options = {
            hostname: 'www.spc.noaa.gov',
            port: 443,
            path: path,
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
                    // NOAA sometimes double-encodes JSON
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

    // Compute ensemble mean
    const sortedTimes = Array.from(timePoints).sort((a, b) => a - b);
    const memberKeys = Object.keys(processed);

    if (memberKeys.length > 0) {
        processed['Mean'] = sortedTimes.map(time => {
            let sum = 0, count = 0;
            for (const key of memberKeys) {
                const point = processed[key].find(p => p.x === time);
                if (point) { sum += point.y; count++; }
            }
            return { x: time, y: count > 0 ? sum / count : 0 };
        });
    }

    return processed;
}

// ============ Routes ============

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        cacheSize: cache.size,
        uptime: process.uptime()
    });
});

// Cache stats
app.get('/api/cache-stats', (req, res) => {
    const stats = {
        entries: cache.size,
        keys: []
    };

    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        stats.keys.push({
            key,
            cachedAt: value.cachedAt,
            expiresIn: Math.round((value.expires - now) / 1000 / 60) + ' minutes'
        });
    }

    res.json(stats);
});

// Main SREF data endpoint
app.get('/api/sref/:station/:run/:param', async (req, res) => {
    const { station, run, param } = req.params;
    const date = req.query.date || new Date().toISOString().split('T')[0];

    // Validate inputs
    // Station: allow any 3-4 letter code (NOAA will 404 for invalid stations)
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

    // Check cache
    const cached = getFromCache(cacheKey);
    if (cached) {
        console.log(`[CACHE HIT] ${cacheKey}`);
        res.set('X-Cache', 'HIT');
        return res.json(cached);
    }

    console.log(`[CACHE MISS] ${cacheKey} - fetching from NOAA...`);

    try {
        const raw = await fetchFromNOAA(station.toUpperCase(), run, param, date);
        const processed = processData(raw);

        // Count valid ensemble members (not Mean)
        const memberCount = Object.keys(processed).filter(k => k !== 'Mean').length;

        // Only cache if we have complete data (10+ members)
        // This prevents caching partial/empty responses that would block future fetches
        if (memberCount >= 10) {
            const ttl = getCacheTTL(parseInt(run));
            setInCache(cacheKey, processed, ttl);
            console.log(`[CACHED] ${cacheKey} for ${Math.round(ttl / 1000 / 60)} minutes (${memberCount} members)`);
            res.set('X-Cache', 'MISS');
        } else {
            console.log(`[NOT CACHED] ${cacheKey} - incomplete data (${memberCount} members)`);
            res.set('X-Cache', 'INCOMPLETE');
        }

        res.json(processed);
    } catch (err) {
        console.error(`[ERROR] ${cacheKey}:`, err.message);
        res.status(502).json({ error: 'Failed to fetch from NOAA', details: err.message });
    }
});

// ============ Start Server ============
app.listen(PORT, () => {
    console.log(`SREF Proxy running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
