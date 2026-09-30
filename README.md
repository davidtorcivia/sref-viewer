# SREF Viewer

A self-hosted NYC area ensemble plume viewer with intelligent caching. View snowfall, precipitation, temperature, and wind forecasts from NOAA's SREF and REFS ensembles for JFK, LGA, EWR or any airport in the feeds. Includes a live radar map with a 60-minute nowcast.

> **Heads up:** NOAA retires the SREF model on **October 6, 2026 12Z**. Its successor
> **REFS** (RRFS ensemble) is supported via the model toggle and becomes the default
> once SREF is retired; SREF's last runs stay viewable from the cache until evicted
> (roughly 12 days, as REFS runs fill the 1000-entry cache).
> See [REFS-MIGRATION.md](REFS-MIGRATION.md).

## Features

- Server-side caching proxy that reduces load on NOAA servers
- Complete runs cached 14 days (immutable); partial/unavailable runs negative-cached briefly
- Radar map page (`/radar`) - MapLibre GL + OpenFreeMap basemap + LibreWXR radar tiles with ~2h history and 60-minute nowcast, no API keys; tiles are proxied, cached and pre-warmed by the backend so frames appear instantly
- Responsive design optimized for mobile devices (bands view + compact header on phones)
- PWA installable with offline support (self-hosted Chart.js/MapLibre, no CDNs)
- Auto light/dark mode based on system preference
- Wind speed toggle between knots and mph (saved to localStorage)
- Snow alert indicator when any ensemble member forecasts accumulation
- Overlays of the three previous runs' means, trend vs the previous run, and confidence band (P10-P90) views
- Precipitation-type timeline (REFS)
- Share links pinned to the run on screen; PNG export of any chart

## Quick Start

```bash
cp .env.example .env   # set ADMIN_PASSWORD to enable /admin
docker compose up -d
```

The app will be available at http://localhost:8091

## Architecture

```
frontend (nginx:alpine)
    - Serves static HTML/CSS/JS, proxies /api/* to backend
    - Resolves the real client IP from X-Forwarded-For (Cloudflare/tunnel/caddy)

backend (node:alpine)
    - Express caching proxy: SPC SREF plumes, REFS via the extractor,
      LibreWXR radar frames/tiles/alerts
    - Persistent cache (data/cache.json), warms the latest runs and radar tiles

extractor (debian + NCEPLIBS-bufr + ecCodes, internal)
    - Builds REFS station plumes from NOAA's RRFS soundings and REFS grib2
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| ADMIN_USERNAME | admin | Admin panel login |
| ADMIN_PASSWORD | (unset) | Admin panel password; `/admin` is disabled until set |
| PORT | 3001 | Backend server port |

### Admin panel

`/admin` edits the site name/description, favicon, analytics snippet, custom CSS
and the header's station buttons (which the backend also pre-fetches for every
new run). Any other airport can be loaded from the ICAO box in the header.

### Cloudflare Tunnel Deployment

```bash
# Start the app
docker compose up -d

# Create tunnel pointing to port 8091
cloudflared tunnel --url http://localhost:8091
```

## Development

### Local Development (without Docker)

Backend:
```bash
cd backend
npm install
npm test          # pure-logic checks
node server.js
```

Frontend:
```bash
cd frontend
# Serve with any static server, e.g.:
npx serve .
```

### Project Structure

```
sref-viewer/
  docker-compose.yml
  README.md
  LICENSE
  backend/
    server.js          # Express caching proxy
    test.js            # node test.js
  extractor/
    extractor.py       # REFS point extraction service
  frontend/
    index.html, radar.html, admin.html
    nginx.conf
    sw.js              # Service worker (offline shell + forecast data)
    css/               # styles.css (plumes), radar.css
    js/
      config.js        # Parameters, models, run-time math, preferences
      api.js           # Data fetching and ensemble statistics
      charts.js        # Chart.js rendering and PNG export
      app.js           # Plume page
      radar.js         # Radar page
      site.js          # Admin settings applied to both pages
  tools/
    gen-icons.js       # Regenerates the PWA icons
```

## API Endpoints

### Frontend (port 8091)

- `GET /` - Main application
- `GET /radar` - Live radar map
- `GET /admin` - Admin panel
- `GET /api/*` - Proxied to backend

### Backend (port 3001)

- `GET /health` - Health check with cache stats
- `GET /api/cache-stats` - Cache contents (admin auth)
- `GET /api/settings` - Public site settings
- `GET /api/sref/:station/:run/:param?date=YYYY-MM-DD` - Fetch SREF data
- `GET /api/refs/:station/:run/:param?date=YYYY-MM-DD` - Fetch REFS ensemble data
  (runs 00/06/12/18; any of ~1900 stations in the RRFS feed by ICAO, plus
  `param=ptype` for per-hour precip-type member fractions)
- `GET /api/refs/status/:run?date=YYYY-MM-DD` - what the extractor is doing for a
  cycle being built (drives the status-bar progress while a cold cycle loads)
- `GET /api/radar/frames` - LibreWXR frame index (60s shared cache)
- `GET /api/radar/tile/:time/:z/:x/:y.png?fc=` - Radar tile proxy: cached 3h, and the
  NYC viewport (z7-8) is pre-rendered for every new frame within a couple of minutes of it appearing
- `GET /api/radar/alerts?lat=&lon=&radius=` - Weather warning polygons (GeoJSON, 2min shared cache)
- `GET /api/nowcast?lat=&lon=` - Rain and snow in the next 2 hours, a minute at a time from the
  newest radar scan (`time`, epoch s): the radar moved along its motion, handing over to HRRR's
  15-minute forecast between 60 and 120 min. `rate[121]` (liquid-equivalent mm/h, the median of a
  patch that widens with the lead; wet at 0.45+), `dbz[121]` (its rain-equivalent reflectivity),
  `p[121]` (share of the patch wet), `kind[121]` (only when any is not rain: rain | snow | wet snow |
  sleet | freezing rain; the radar's type from NEXRAD or MRMS PrecipFlag, sleet and freezing rain
  from HRRR only), `snow[121]` (only when any is snow or wet snow), and
  `rain: {start, end, kind, rate, peak} | null` (epoch s; start null = falling now, end null = past
  2 hours; kind the spell's worst; rate its peak mm/h; peak light | moderate | heavy, snow on its own
  scale). `hrrr: {run, step: 900, times, rate, dbz, p, kind?, snow?} | null` is HRRR alone every 15
  minutes to 6 hours ahead. Cached 60 s; `{stale: true}` when the radar feed is behind.
- `GET /api/nowcast/notify?lat=&lon=&within=20` - For app notifications: `{notify, raining, text,
  start, end, peak, kind, rate, snow, scan}`. `notify` is true when rain, snow or ice starts within
  `within` minutes (5-60) and it is dry now; `text` is the page's sentence ("Heavy snow starting in
  12 min, for about 40 min, up to 1.2 in an hour"). Notify once per wet spell: after notifying, wait
  until `raining` has been true and `raining` and `notify` have gone false before notifying again.
  503 when the radar is stale (never notify then).
  Poll no more than every 2 minutes (a scan every 2).

### Extractor (internal, port 3002)

- `GET /plume?sid=744860&date=YYYYMMDD&cycle=00` - Deterministic RRFS series plus REFS mean/spread at the station
- `GET /status?date=YYYYMMDD&cycle=00` - Build progress for a cycle
- `GET /stations` - ICAO -> BUFR station-number index (rebuilt monthly from the feed)
- `GET /nowcast/score` - How the nowcasts verified (`data/nowcast-score.json`), for `radar` alone,
  `hrrr` alone and the served `blend`: per lead `{hit, miss, false, dry}` out to 2 hours, onset error
  (`abs_err / n` = mean minutes off), `type` per lead `{same, diff}` (snow or not, where both were
  wet), and the same per training place under `places` (New York,
  Atlanta, Athens GA, Augusta GA/SC, Los Angeles). Radar vs HRRR per lead sets the handoff (`NC_BLEND`).

### Operational niceties

- The backend prefetches the latest run for the default stations (both models,
  SREF until its retirement) every 5 minutes, so the first visitor after a new
  run gets instant charts.
- The extractor rebuilds its station index monthly (checked on each healthcheck).
- Asset URLs are stamped with a per-build version at Docker build time -
  deploys are immediately visible through CDNs/browser caches with no manual
  cache busting.

## Data Sources

- SREF plumes: [NOAA Storm Prediction Center](https://www.spc.noaa.gov/exper/sref/)
- RRFS station soundings and REFS ensemble products: [NOAA RRFS on AWS Open Data](https://registry.opendata.aws/noaa-rrfs/) (BUFR decoded with NCEPLIBS-bufr, grib2 read with ecCodes)
- Radar tiles: [LibreWXR](https://librewxr.net/) (CC-BY-4.0, self-hostable)
- Basemap: [OpenFreeMap](https://openfreemap.org/) (OpenMapTiles / OpenStreetMap)

## Cache Behavior

Completed model runs never change, so the backend caches by completeness:

- **Complete runs** (SREF >= 10 members; REFS full soundings + ensemble): cached 14 days, persisted to `data/cache.json` (at most 1000 entries, oldest evicted first)
- **Partial runs** (still publishing): cached 10 minutes
- **Failed fetches** (run/date doesn't exist upstream): negative-cached 5 minutes

Only cache misses count against the per-IP rate limit.

## Browser Support

- Chrome, Firefox, Safari, Edge (latest versions)
- iOS Safari, Chrome for Android
- Requires JavaScript enabled

## License

MIT License. See LICENSE file for details.
