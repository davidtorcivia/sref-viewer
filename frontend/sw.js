/**
 * SREF Viewer Service Worker
 * Provides offline support and caching
 */

const STATIC_CACHE = 'sref-static-__V__';
const API_CACHE = 'sref-api-v1';
const API_MAX_ENTRIES = 80;               // Bound Cache Storage growth
const API_MAX_AGE_MS = 24 * 60 * 60 * 1000; // Don't serve API data older than 24h offline

// Assets to precache on install
const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/radar',
    '/radar.html',
    '/css/styles.css?v=__V__',
    '/css/radar.css?v=__V__',
    '/icons/favicon.svg',
    '/js/app.js?v=__V__',
    '/js/api.js?v=__V__',
    '/js/charts.js?v=__V__',
    '/js/config.js?v=__V__',
    '/js/radar.js?v=__V__',
    '/vendor/chart.umd.min.js',
    '/vendor/chartjs-adapter-date-fns.bundle.min.js',
    '/vendor/chartjs-plugin-annotation.min.js',
    '/vendor/maplibre-gl.js',
    '/vendor/maplibre-gl.css'
];

// Install event - precache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== STATIC_CACHE && name !== API_CACHE)
                    .map((name) => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (event.request.method !== 'GET') return;

    // Radar tiles / external hosts: let the browser handle them
    if (url.origin !== location.origin) return;

    // Radar tiles: immutable per URL, the browser HTTP cache handles them
    if (url.pathname.startsWith('/api/radar/tile/')) return;

    // API requests: network-first with bounded cache fallback
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirstApi(event.request));
        return;
    }

    // Vendored libraries are pinned versions - cache-first is safe and fast
    if (url.pathname.startsWith('/vendor/')) {
        event.respondWith(staleWhileRevalidate(event.request));
        return;
    }

    // Everything else (pages, app css/js, icons): network-first. App HTML,
    // CSS, and JS must always be the same version - serving stale CSS with
    // fresh HTML breaks styling after a deploy. nginx serves these with
    // etags, so revalidation is a cheap 304 and offline still works.
    event.respondWith(networkFirstPage(event.request));
});

/**
 * Network-first for API data. Successful responses are cached with a
 * timestamp header; the cache is trimmed to API_MAX_ENTRIES and entries
 * older than API_MAX_AGE_MS are not served.
 */
async function networkFirstApi(request) {
    const cache = await caches.open(API_CACHE);

    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const headers = new Headers(networkResponse.headers);
            headers.set('sw-cached-at', String(Date.now()));
            const body = await networkResponse.clone().blob();
            cache.put(request, new Response(body, {
                status: networkResponse.status,
                statusText: networkResponse.statusText,
                headers
            }));
            trimApiCache(cache);
        }
        return networkResponse;
    } catch (error) {
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            const cachedAt = Number(cachedResponse.headers.get('sw-cached-at') || 0);
            if (Date.now() - cachedAt < API_MAX_AGE_MS) {
                return cachedResponse;
            }
        }
        return new Response(
            JSON.stringify({ error: 'Offline', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

async function trimApiCache(cache) {
    const keys = await cache.keys();
    if (keys.length <= API_MAX_ENTRIES) return;
    // Keys are in insertion order - drop the oldest
    const excess = keys.length - API_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
        await cache.delete(keys[i]);
    }
}

/**
 * Network-first for pages and app assets, falling back to cache offline.
 * Only navigations fall back to the app shell.
 */
async function networkFirstPage(request) {
    const cache = await caches.open(STATIC_CACHE);
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        let cachedResponse = await cache.match(request);
        if (!cachedResponse && request.mode === 'navigate') {
            cachedResponse = await cache.match('/index.html');
        }
        if (cachedResponse) return cachedResponse;
        return new Response('Offline', { status: 503 });
    }
}

/**
 * Stale-while-revalidate for static assets: serve cached immediately,
 * refresh in the background (nginx serves these with no-cache/etag so
 * the refresh picks up deploys).
 */
async function staleWhileRevalidate(request) {
    const cache = await caches.open(STATIC_CACHE);
    const cachedResponse = await cache.match(request);

    const networkFetch = fetch(request).then((networkResponse) => {
        if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    }).catch(() => null);

    if (cachedResponse) return cachedResponse;

    const networkResponse = await networkFetch;
    if (networkResponse) return networkResponse;
    return new Response('Offline', { status: 503 });
}
