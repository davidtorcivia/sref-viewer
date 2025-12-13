# SREF Viewer

A self-hosted NYC area SREF ensemble plume viewer with intelligent caching. View snowfall, precipitation, temperature, and wind forecasts from NOAA's Short Range Ensemble Forecast model for JFK, LGA, and EWR airports.

## Features

- Server-side caching proxy that reduces load on NOAA servers
- Intelligent cache TTL aligned to model run schedules (03Z, 09Z, 15Z, 21Z)
- Run availability detection that only shows model runs with full data
- Responsive design optimized for mobile devices
- Auto light/dark mode based on system preference
- Wind speed toggle between knots and mph (saved to localStorage)
- Snow alert indicator when any ensemble member forecasts accumulation

## Quick Start

```bash
docker compose up -d
```

The app will be available at http://localhost:8080

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

# Create tunnel pointing to port 8080
cloudflared tunnel --url http://localhost:8080
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

### Frontend (port 8080)

- `GET /` - Main application
- `GET /api/*` - Proxied to backend

### Backend (port 3001)

- `GET /health` - Health check with cache stats
- `GET /api/cache-stats` - Detailed cache information
- `GET /api/sref/:station/:run/:param?date=YYYY-MM-DD` - Fetch SREF data

## Cache Behavior

The backend caches responses based on model run availability:

- Cache expires when the next model run should be available
- Processing delay of 2 hours is accounted for
- Minimum TTL: 1 hour
- Maximum TTL: 8 hours

Example: Data for 09Z run cached until approximately 17Z (when 15Z data should be ready)

## Browser Support

- Chrome, Firefox, Safari, Edge (latest versions)
- iOS Safari, Chrome for Android
- Requires JavaScript enabled

## Data Source

Weather data is sourced from NOAA's Storm Prediction Center:
https://www.spc.noaa.gov/exper/sref/

## License

MIT License. See LICENSE file for details.
