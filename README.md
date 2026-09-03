# SREF Viewer

A self-hosted NYC area SREF ensemble plume viewer with intelligent caching. View snowfall, precipitation, temperature, and wind forecasts from NOAA's Short Range Ensemble Forecast model for JFK, LGA, and EWR airports. Includes a live radar map with a 60-minute nowcast.

> **Heads up:** NOAA retires the SREF model on **October 6, 2026** (moved from Aug 31). Its successor
> **REFS** (RRFS ensemble, 5 members, hourly to 60h) is already supported via the
> model toggle. See [REFS-MIGRATION.md](REFS-MIGRATION.md) for details and the
> post-cutover source switch.

## Features

- Server-side caching proxy that reduces load on NOAA servers
- Complete runs cached 14 days (immutable); partial/unavailable runs negative-cached briefly
- Radar map page (`/radar`) - MapLibre GL + OpenFreeMap basemap + LibreWXR radar tiles with ~2h history and 60-minute nowcast, no API keys
- Responsive design optimized for mobile devices (bands view + compact header on phones)
- PWA installable with offline support (self-hosted Chart.js/MapLibre, no CDNs)
- Auto light/dark mode based on system preference
- Wind speed toggle between knots and mph (saved to localStorage)
- Snow alert indicator when any ensemble member forecasts accumulation
- Run-to-run comparison overlays and confidence band (P10-P90) views

## Quick Start

```bash
docker compose up -d
```

The app will be available at http://localhost:8091

## Architecture

```
frontend (nginx:alpine)
    - Serves static HTML/CSS/JS
    - Proxies /api/* requests to backend
    - Gzip compression enabled

backend (node:alpine)
    - Express.js caching proxy
    - Fetches from www.spc.noaa.gov
    - In-memory cache with smart TTL
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3001 | Backend server port |

### Adding Stations

Edit `frontend/js/config.js`:

```javascript
stations: ['JFK', 'LGA', 'EWR', 'BOS']  // Add more airports
```

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
    package.json
    Dockerfile
  frontend/
    index.html
    nginx.conf
    Dockerfile
    css/
      styles.css       # Mobile-first responsive styles
    js/
      config.js        # Configuration and preferences
      api.js           # Data fetching layer
      charts.js        # Chart.js rendering
      app.js           # Main application
```

## API Endpoints

### Frontend (port 8091)

- `GET /` - Main application
- `GET /radar` - Live radar map
- `GET /admin` - Admin panel
- `GET /api/*` - Proxied to backend

### Backend (port 3001)

- `GET /health` - Health check with cache stats
- `GET /api/cache-stats` - Detailed cache information
- `GET /api/sref/:station/:run/:param?date=YYYY-MM-DD` - Fetch SREF data
- `GET /api/refs/:station/:run/:param?date=YYYY-MM-DD` - Fetch REFS ensemble data
  (runs 00/06/12/18; any of ~1900 stations in the RRFS feed by ICAO, plus
  `param=ptype` for per-hour precip-type member fractions)
- `GET /api/radar/frames` - LibreWXR frame index (60s shared cache)
- `GET /api/radar/alerts?lat=&lon=&radius=` - Weather warning polygons (GeoJSON, 2min shared cache)

### Extractor (internal, port 3002)

- `GET /plume?sid=744860&date=YYYYMMDD&cycle=00` - Decoded per-member BUFR series
- `GET /stations` - ICAO -> BUFR station-number index (rebuilt monthly from the feed)

### Operational niceties

- The backend prefetches the latest run for JFK/LGA/EWR (both models) every
  10 minutes, so the first visitor after a new run gets instant charts.
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

- **Complete runs** (>= 10 members): cached 14 days, persisted to `data/cache.json`
- **Partial runs** (< 10 members, still publishing): cached 10 minutes
- **Failed fetches** (run/date doesn't exist upstream): negative-cached 5 minutes

Cache hits do not count against the per-IP rate limit.

## Browser Support

- Chrome, Firefox, Safari, Edge (latest versions)
- iOS Safari, Chrome for Android
- Requires JavaScript enabled

## License

MIT License. See LICENSE file for details.
