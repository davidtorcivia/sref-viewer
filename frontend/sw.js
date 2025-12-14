/**
 * SREF Viewer Service Worker
 * Provides offline support and caching
 */

const CACHE_NAME = 'sref-v1';
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// Assets to precache on install
const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/css/styles.css',
    '/js/app.js',
    '/js/api.js',
    '/js/charts.js',
    '/js/config.js'
];

// CDN assets to cache on first use
const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.1',
    'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0',
    'https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1'
];

// Install event - precache static assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Precaching static assets');
                return cache.addAll(PRECACHE_URLS);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch event - network-first for API, cache-first for static
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // API requests: network-first with cache fallback
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirstWithCache(event.request));
        return;
    }

    // CDN assets: cache-first
    if (CDN_ASSETS.some(cdn => url.href.startsWith(cdn))) {
        event.respondWith(cacheFirstWithNetwork(event.request));
        return;
    }

    // Static assets: cache-first with network fallback
    if (url.origin === location.origin) {
        event.respondWith(cacheFirstWithNetwork(event.request));
        return;
    }
});

/**
 * Network-first strategy with cache fallback
 * Used for API requests - always try network first for fresh data
 */
async function networkFirstWithCache(request) {
    const cache = await caches.open(CACHE_NAME);

    try {
        const networkResponse = await fetch(request);

        // Only cache successful responses
        if (networkResponse.ok) {
            // Clone response because it can only be consumed once
            const responseToCache = networkResponse.clone();

            // Add timestamp to cached response
            cache.put(request, responseToCache);
        }

        return networkResponse;
    } catch (error) {
        // Network failed, try cache
        console.log('[SW] Network failed, trying cache:', request.url);
        const cachedResponse = await cache.match(request);

        if (cachedResponse) {
            console.log('[SW] Serving from cache:', request.url);
            return cachedResponse;
        }

        // Return offline fallback for API
        return new Response(
            JSON.stringify({ error: 'Offline', offline: true }),
            {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

/**
 * Cache-first strategy with network fallback
 * Used for static assets - prefer cached version for speed
 */
async function cacheFirstWithNetwork(request) {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
        // Return cached immediately, update in background
        updateCacheInBackground(request, cache);
        return cachedResponse;
    }

    // Not in cache, fetch from network
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        console.log('[SW] Both cache and network failed:', request.url);
        return new Response('Offline', { status: 503 });
    }
}

/**
 * Update cache in background (stale-while-revalidate pattern)
 */
async function updateCacheInBackground(request, cache) {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            cache.put(request, networkResponse);
        }
    } catch (error) {
        // Silent fail - we already served from cache
    }
}
