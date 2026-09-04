#!/usr/bin/env python3
"""
RRFS/REFS point extractor service.

NOAA publishes no per-member REFS files, so a station "plume" is built from
two public products in the noaa-rrfs-ops-pds bucket:

  1. Deterministic RRFS station soundings: one ~117MB tarball per cycle
     (rrfs.tCCz.bufrsnd.tar.gz) holding a BUFR file per station. It is
     streamed, never stored: the wanted station files are picked out of
     the stream and decoded with NCEPLIBS-bufr's debufr into an hourly
     surface series.
  2. REFS ensemble products (ensprod/refs.tCCz.{mean,sprd}.fHH.conus.grib2):
     the needed fields are fetched by byte range using the .idx sidecars,
     every 3 hours to 60h. Each field is decoded in memory with ecCodes at
     the grid point nearest every known station, and only those point
     values are kept (a few MB per cycle).

    GET /plume?sid=744860&date=20260903&cycle=00
    GET /status?date=20260903&cycle=00   -> what a build in progress is doing
    GET /stations
    GET /health

Response:
{
  "sid": "744860", "rpid": "KJFK", "lat": 40.64, "lon": -73.78,
  "date": "20260903", "cycle": "00", "complete": true,
  "members": {
    "rrfs": { "ftimes": [0, 3600, ...],       # seconds from cycle time
              "t2ms": [...], "u10m": [...], "v10m": [...],
              "tp01": [...], "snfl": [...], "snra": [...],
              "wxts": [...], "wxtr": [...], "wxtz": [...], "wxtp": [...] }
  },
  "ens": { "hours": [3, 6, ...],              # forecast hour (3h steps)
           "mean": { "tmp": [K], "wnd": [m/s],
                     "qpf": [mm in the 3h bucket], "sno": [m in the 3h bucket] },
           "sprd": { same keys } }            # or null if unavailable

Environment:
  RRFS_TAR_URL   tarball URL template  ({date}, {cycle})
  REFS_GRIB_URL  ensprod URL template  ({date}, {cycle}, {prod}, {hh})
  REFS_HOT_SIDS  stations decoded together on any tarball pass (defaults)
  CACHE_DIR      decoded per-station and per-cycle JSON (14 days)
"""

import calendar
import json
import math
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import eccodes as ec
import numpy as np

PORT = int(os.environ.get('PORT', '3002'))
TAR_URL = os.environ.get(
    'RRFS_TAR_URL',
    'https://noaa-rrfs-ops-pds.s3.amazonaws.com/rrfs.{date}/{cycle}/rrfs.t{cycle}z.bufrsnd.tar.gz')
GRIB_URL = os.environ.get(
    'REFS_GRIB_URL',
    'https://noaa-rrfs-ops-pds.s3.amazonaws.com/refs.{date}/{cycle}/ensprod/refs.t{cycle}z.{prod}.f{hh}.conus.grib2')
# Stations pulled out of the tarball together, so the default airports cost
# one stream per cycle instead of one each
HOT_SIDS = [s for s in os.environ.get('REFS_HOT_SIDS', '744860,725030,725020').split(',') if s]
CACHE_DIR = os.environ.get('CACHE_DIR', '/data/refs-cache')
CACHE_MAX_AGE_DAYS = 14
ENS_STORE_MAX_AGE_DAYS = 3    # all-station point stores (~7MB each); plumes outlive them
PARTIAL_MAX_AGE_S = 600       # re-pull an incomplete cycle at most this often
FETCH_TIMEOUT = 60
USER_AGENT = 'SREF-Viewer-REFS/2.0 (Personal Weather Tool)'

ENS_HOURS = list(range(3, 61, 3))
ENS_PRODS = ('mean', 'sprd')
# .idx (name, level) -> series key; accumulations take the 3h bucket ending at h
ENS_FIELDS = {
    ('TMP', '2 m above ground'): 'tmp',
    ('WIND', '10 m above ground'): 'wnd',
    ('APCP', 'surface'): 'qpf',
    ('ASNOW', 'surface'): 'sno',
}
# GRIB2 (discipline, category, number) -> series key, for decoding
ENS_PARAMS = {(0, 0, 0): 'tmp', (0, 2, 1): 'wnd', (0, 1, 8): 'qpf', (0, 1, 29): 'sno'}

SURFACE_KEYS = ('t2ms', 'u10m', 'v10m', 'tp01', 'snfl', 'snra',
                'wxts', 'wxtr', 'wxtz', 'wxtp')
LINE_RE = re.compile(
    r'^\d{6}\s+(FTIM|T2MS|U10M|V10M|TP01|SNFL|SNRA|WXTS|WXTR|WXTZ|WXTP|RPID|CLAT|CLON)\s+(\S+)',
    re.M)

# Bump when the extracted field set changes so stale disk cache is ignored
CACHE_VERSION = 'v6'

STATIONS_FILE = os.environ.get('STATIONS_FILE', '/data/refs-stations.json')
GRID_INDEX_FILE = os.environ.get('GRID_INDEX_FILE', '/data/refs-grid-index.json')
STATIONS_MAX_AGE_DAYS = 30

os.makedirs(CACHE_DIR, exist_ok=True)
# Raw tarball/grib retention from the first version: nothing prunes these now
for _old in ('tar', 'grib'):
    shutil.rmtree(os.path.join(CACHE_DIR, _old), ignore_errors=True)

# One writer at a time per cache file; concurrent requests for the same
# cycle wait for the first instead of downloading twice
_locks_guard = threading.Lock()
_locks = {}


def file_lock(path):
    with _locks_guard:
        return _locks.setdefault(path, threading.Lock())


# Per-cycle build progress for the UI: {'YYYYMMDDCC': {'soundings': str, 'ensemble': str, 'since': epoch}}
progress = {}


def set_progress(date, cycle, **parts):
    key = f'{date}{cycle}'
    entry = progress.setdefault(key, {'since': time.time()})
    entry.update(parts)


def write_json(path, obj):
    tmp = f'{path}.{threading.get_ident()}.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def read_json(path, max_age=None):
    try:
        if max_age is not None and time.time() - os.path.getmtime(path) > max_age:
            return None
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def http_get(url, headers=None, timeout=FETCH_TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_exists(url):
    req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT):
            return True
    except (urllib.error.HTTPError, urllib.error.URLError, OSError):
        return False


# ============ Deterministic RRFS (BUFR soundings) ============

def stream_tarball(date, cycle):
    """Yield (sid, tar member stream) for every station file in the cycle tarball."""
    req = urllib.request.Request(TAR_URL.format(date=date, cycle=cycle),
                                 headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=600) as resp, \
            tarfile.open(fileobj=resp, mode='r|gz') as tf:
        for m in tf:
            mm = re.fullmatch(r'bufr\.(\d{6})\.\d{10}', os.path.basename(m.name))
            if m.isfile() and mm:
                yield mm.group(1), tf.extractfile(m)


def stream_station_bufrs(date, cycle, sids):
    """Raw BUFR bytes for the wanted stations from one pass over the tarball."""
    wanted = set(sids)
    found = {}
    for sid, stream in stream_tarball(date, cycle):
        if sid in wanted:
            found[sid] = stream.read()
            if len(found) == len(wanted):
                break
    return found


def decode_bufr(raw, header_only=False):
    """Run debufr on raw BUFR bytes, return (header dict, series dict)."""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, 'in.bufr')
        out = os.path.join(tmp, 'out.txt')
        with open(src, 'wb') as f:
            f.write(raw)
        # Truncated input (header_only) makes debufr exit non-zero after the
        # messages it could read - the output written first is what we need
        subprocess.run(['debufr', '-o', out, src], check=not header_only,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=120)
        with open(out, 'r', errors='replace') as f:
            text = f.read(65536) if header_only else f.read()

    header = {}
    ftimes = []
    series = {k: [] for k in SURFACE_KEYS}
    current = None  # values for the open FTIM block

    def close_block():
        if current is None:
            return
        for k in SURFACE_KEYS:
            series[k].append(current.get(k))

    for m in LINE_RE.finditer(text):
        key, val = m.group(1).lower(), m.group(2)
        if key in ('rpid', 'clat', 'clon'):
            if key not in header:
                header[key] = val if key == 'rpid' else float(val)
            continue
        if key == 'ftim':
            close_block()
            current = {}
            ftimes.append(int(val))
            continue
        if current is not None and key in SURFACE_KEYS:
            # Keep the first occurrence in each block (surface section
            # mnemonics appear once per forecast time)
            if key not in current:
                current[key] = None if val == 'MISSING' else float(val)
    close_block()

    return header, {'ftimes': ftimes, **series}


# ============ REFS ensemble (grib byte ranges, decoded in memory) ============

def fetch_grib_fields(date, cycle, prod, h):
    """Wanted fields of one ensprod file as {key: message bytes}. None if not published."""
    url = GRIB_URL.format(date=date, cycle=cycle, prod=prod, hh=f'{h:02d}')
    try:
        rows = [l.split(':') for l in http_get(url + '.idx').decode().splitlines()]
    except urllib.error.HTTPError as err:
        if err.code in (403, 404):
            return None
        raise
    fields = {}
    for i, r in enumerate(rows):
        key = ENS_FIELDS.get((r[3], r[4]))
        if not key:
            continue
        step = f'{h - 3}-{h} hour acc fcst' if key in ('qpf', 'sno') else f'{h} hour fcst'
        if r[5] != step:
            continue
        start = int(r[1])
        end = str(int(rows[i + 1][1]) - 1) if i + 1 < len(rows) else ''
        fields[key] = http_get(url, headers={'Range': f'bytes={start}-{end}'}, timeout=120)
    if len(fields) != len(ENS_FIELDS):
        raise RuntimeError(f'{prod} f{h:02d}: found {len(fields)}/{len(ENS_FIELDS)} fields in index')
    return fields


def station_points():
    """{sid: (lat, lon)} for every indexed station."""
    idx = read_json(STATIONS_FILE) or {}
    return {v['sid']: (v['lat'], v['lon']) for v in idx.get('stations', {}).values()
            if v.get('lat') is not None and v.get('lon') is not None}


OUTSIDE = -1  # station outside the grid domain


def grid_indices(g, points, known):
    """Nearest grid-point index for each station not already in `known`."""
    missing = {s: ll for s, ll in points.items() if s not in known}
    if not missing:
        return known
    lats = ec.codes_get_array(g, 'latitudes')
    lons = ec.codes_get_array(g, 'longitudes')
    lons = np.where(lons > 180, lons - 360, lons)
    nx, ny = ec.codes_get(g, 'Nx'), ec.codes_get(g, 'Ny')
    out = dict(known)
    for sid, (lat, lon) in missing.items():
        d = (lats - lat) ** 2 + ((lons - lon) * math.cos(math.radians(lat))) ** 2
        i = int(d.argmin())
        # A point off the domain snaps to the grid edge: reject it
        edge = i % nx in (0, nx - 1) or i // nx in (0, ny - 1)
        out[sid] = OUTSIDE if edge else i
    return out


def load_grid_index(g):
    """Cached station -> grid index map, discarded if the grid changed."""
    cached = read_json(GRID_INDEX_FILE) or {}
    if cached.get('points') == ec.codes_get(g, 'numberOfPoints'):
        return cached.get('index', {})
    return {}


def ens_store_path(date, cycle):
    return os.path.join(CACHE_DIR, f'{date}_{cycle}_ens_{CACHE_VERSION}.json')


def update_ens_store(date, cycle, points):
    """
    Ensure the per-cycle point store holds every published (hour, product)
    for every station in `points` (plus the whole station index). Returns
    the store: { "HH:prod": { key: { sid: value } } }.
    """
    path = ens_store_path(date, cycle)
    with file_lock(path):
        store = read_json(path) or {}
        allpoints = {**station_points(), **points}
        outside = {s for s, i in ((read_json(GRID_INDEX_FILE) or {}).get('index', {})).items()
                   if i == OUTSIDE}
        need = [(h, p) for h in ENS_HOURS for p in ENS_PRODS
                if any(s not in store.get(f'{h:02d}:{p}', {}).get('tmp', {})
                       for s in points if s not in outside)]
        if not need:
            return store

        gidx = None
        points_n = None

        def decode(h, prod, fields):
            nonlocal gidx, points_n
            entry = {}
            for key, raw in fields.items():
                g = ec.codes_new_from_message(raw)
                try:
                    triplet = (ec.codes_get(g, 'discipline'), ec.codes_get(g, 'parameterCategory'),
                               ec.codes_get(g, 'parameterNumber'))
                    if ENS_PARAMS.get(triplet) != key:
                        raise RuntimeError(f'{prod} f{h:02d} {key}: unexpected parameter {triplet}')
                    if gidx is None:
                        gidx = load_grid_index(g)
                        points_n = ec.codes_get(g, 'numberOfPoints')
                    if any(s not in gidx for s in allpoints):
                        set_progress(date, cycle, ensemble='locating stations on the grid')
                        gidx = grid_indices(g, allpoints, gidx)
                        write_json(GRID_INDEX_FILE, {'generated': int(time.time()),
                                                     'points': points_n, 'index': gidx})
                    values = ec.codes_get_values(g)
                    # 4 decimals keeps the per-cycle store small (K, m/s, mm, m)
                    entry[key] = {s: round(float(values[gidx[s]]), 4)
                                  for s in allpoints if gidx[s] != OUTSIDE}
                finally:
                    ec.codes_release(g)
            return entry

        # Decode each file as soon as it lands so decoding overlaps the
        # downloads. One failed fetch must not discard the others: a
        # failure is a hole that the next pass fills, like an unpublished hour
        done = 0
        set_progress(date, cycle, ensemble=f'fetching 0/{len(need)}')
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(fetch_grib_fields, date, cycle, p, h): (h, p) for h, p in need}
            for fut in as_completed(futures):
                h, prod = futures[fut]
                done += 1
                set_progress(date, cycle, ensemble=f'fetching {done}/{len(need)}')
                if fut.exception():
                    print(f'[ENS] {date}{cycle} {prod} f{h:02d}: {fut.exception()}', flush=True)
                    continue
                fields = fut.result()
                if fields is not None:
                    store[f'{h:02d}:{prod}'] = decode(h, prod, fields)
        set_progress(date, cycle, ensemble='done')
        write_json(path, store)
        return store


def ens_from_store(store, sid):
    """Series for one station up to the first unpublished hour. (ens, complete)"""
    ens = {'hours': [], 'mean': {k: [] for k in ENS_PARAMS.values()},
           'sprd': {k: [] for k in ENS_PARAMS.values()}}
    for h in ENS_HOURS:
        entries = [store.get(f'{h:02d}:{p}') for p in ENS_PRODS]
        if any(e is None or sid not in e.get('tmp', {}) for e in entries):
            break
        ens['hours'].append(h)
        for prod, e in zip(ENS_PRODS, entries):
            for key in ENS_PARAMS.values():
                ens[prod][key].append(e[key][sid])
    return ens, len(ens['hours']) == len(ENS_HOURS)


# ============ Plume assembly + cache ============

def cache_path(sid, date, cycle, partial=False):
    tag = f'{CACHE_VERSION}_partial' if partial else CACHE_VERSION
    return os.path.join(CACHE_DIR, f'{date}_{cycle}_{sid}_{tag}.json')


def prune_cache():
    now = time.time()
    try:
        for name in os.listdir(CACHE_DIR):
            p = os.path.join(CACHE_DIR, name)
            days = ENS_STORE_MAX_AGE_DAYS if '_ens_' in name else CACHE_MAX_AGE_DAYS
            if os.path.isfile(p) and now - os.path.getmtime(p) > days * 86400:
                os.remove(p)
    except OSError:
        pass


def cached_plume(sid, date, cycle):
    return (read_json(cache_path(sid, date, cycle))
            or read_json(cache_path(sid, date, cycle, partial=True), PARTIAL_MAX_AGE_S))


def stale_plume(sid, date, cycle):
    """An expired partial result: its sounding is still valid, only the ensemble ages."""
    return read_json(cache_path(sid, date, cycle, partial=True))


def build_plume(sid, date, cycle):
    cached = cached_plume(sid, date, cycle)
    if cached:
        return cached, True

    # The ensemble fetch only needs station coordinates, which the index
    # already has for known stations: run it while the tarball streams
    known = station_points()
    prepoints = {s: known[s] for s in [sid] + HOT_SIDS if s in known}

    def ens_early():
        try:
            update_ens_store(date, cycle, prepoints)
        except Exception as err:  # noqa: BLE001 - retried below with exact coordinates
            print(f'[ENS] {date}{cycle} early: {err}', flush=True)
    ens_thread = threading.Thread(target=ens_early, daemon=True)
    ens_thread.start()
    try:
        return _build_plume(sid, date, cycle, ens_thread)
    finally:
        # Join before clearing progress: a still-running ensemble thread
        # would otherwise recreate the entry and leave the UI "busy" forever
        ens_thread.join()
        progress.pop(f'{date}{cycle}', None)


def _build_plume(sid, date, cycle, ens_thread):
    # Serialize the tarball pass per cycle so a warmer/user race streams it
    # once (the ensemble store has its own lock). ponytail: two concurrent requests for different non-hot stations
    # still stream it twice; merge wanted sets under the lock if that matters.
    with file_lock(f'tar:{date}{cycle}'):
        cached = cached_plume(sid, date, cycle)
        if cached:
            return cached, True

        # One pass over the tarball serves the requested station and any hot
        # station not yet decoded for this cycle. The sounding never changes
        # once published, so an expired partial result is reused as-is.
        decoded = {}
        need = []
        for s in [sid] + [x for x in HOT_SIDS if x != sid]:
            if s != sid and cached_plume(s, date, cycle):
                continue
            stale = stale_plume(s, date, cycle)
            if stale and stale['members'].get('rrfs'):
                decoded[s] = ({'rpid': stale['rpid'], 'clat': stale['lat'], 'clon': stale['lon']},
                              stale['members']['rrfs'])
            else:
                need.append(s)
        if need:
            set_progress(date, cycle, soundings='streaming')
        raws = stream_station_bufrs(date, cycle, need) if need else {}
        if sid not in raws and sid not in decoded:
            raise FileNotFoundError(f'station {sid} not in {date}/{cycle}Z tarball')
        set_progress(date, cycle, soundings='decoding')
        for s, raw in raws.items():
            decoded[s] = decode_bufr(raw)
        set_progress(date, cycle, soundings='done')

    points = {s: (h['clat'], h['clon']) for s, (h, _) in decoded.items()
              if h.get('clat') is not None and h.get('clon') is not None}
    ens_thread.join()
    store = None
    try:
        store = update_ens_store(date, cycle, points)
    except Exception as err:  # noqa: BLE001 - deterministic data is still useful
        print(f'[ENS] {date}{cycle}: {err}', flush=True)

    # A cycle whose ensemble products never appear stops being retried
    # once it is old enough that they clearly are not coming
    cycle_age_h = (time.time() - calendar.timegm(time.strptime(f'{date}{cycle}', '%Y%m%d%H'))) / 3600

    results = {}
    for s, (header, series) in decoded.items():
        result = {'sid': s, 'rpid': header.get('rpid'), 'lat': header.get('clat'),
                  'lon': header.get('clon'), 'date': date, 'cycle': cycle,
                  'complete': False, 'members': {}, 'ens': None}
        if series['ftimes']:
            result['members']['rrfs'] = series
        det_complete = len(series['ftimes']) >= 49
        ens_complete = False
        if store is not None and s in points:
            result['ens'], ens_complete = ens_from_store(store, s)
        # A transient ensemble failure (ens None) must still retry
        result['complete'] = det_complete and (
            ens_complete or (cycle_age_h > 12 and result['ens'] is not None))
        write_json(cache_path(s, date, cycle, partial=not result['complete']), result)
        results[s] = result
    prune_cache()
    return results[sid], False


# ============ Station index ============
# Maps report IDs (KJFK) to BUFR station numbers (plus lat/lon) by decoding
# the header of every station file in the most recent tarball.

stations_state = {'status': 'idle'}


def find_available_cycle():
    for day_offset in (0, 1):
        date = time.strftime('%Y%m%d', time.gmtime(time.time() - day_offset * 86400))
        for cycle in ('12', '06', '00', '18'):
            if http_exists(TAR_URL.format(date=date, cycle=cycle)):
                return date, cycle
    return None, None


def build_station_index():
    stations_state['status'] = 'building'
    try:
        date, cycle = find_available_cycle()
        if not date:
            raise RuntimeError('No cycle available to index')
        print(f'[STATIONS] Indexing from {date}/{cycle}Z', flush=True)

        def one(item):
            sid, raw = item
            try:
                header, _ = decode_bufr(raw, header_only=True)
            except (subprocess.SubprocessError, OSError):
                return None
            if 'rpid' not in header:
                return None
            return {'sid': sid, 'rpid': header['rpid'],
                    'lat': header.get('clat'), 'lon': header.get('clon')}

        # Only the first 20KB of each file is needed for RPID/CLAT/CLON
        heads = ((sid, stream.read(20480)) for sid, stream in stream_tarball(date, cycle))

        index = {}
        done = 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            for info in pool.map(one, heads):
                done += 1
                if info:
                    index[info['rpid'].upper()] = {
                        'sid': info['sid'], 'lat': info['lat'], 'lon': info['lon']}
                if done % 250 == 0:
                    print(f'[STATIONS] {done} decoded', flush=True)

        write_json(STATIONS_FILE, {'generated': int(time.time()), 'source': f'{date}/{cycle}Z',
                                   'count': len(index), 'stations': index})
        stations_state['status'] = 'ready'
        print(f'[STATIONS] Index complete: {len(index)} stations', flush=True)
    except Exception as err:  # noqa: BLE001
        stations_state['status'] = f'error: {err}'
        print(f'[STATIONS] Index build failed: {err}', flush=True)


def maybe_start_index_build():
    try:
        age = time.time() - os.path.getmtime(STATIONS_FILE)
        if age < STATIONS_MAX_AGE_DAYS * 86400:
            stations_state['status'] = 'ready'
            return
    except OSError:
        pass
    if stations_state['status'] == 'building':
        return
    threading.Thread(target=build_station_index, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('[HTTP]', fmt % args, flush=True)

    def send_json(self, code, obj, cached=False):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('X-Cache', 'HIT' if cached else 'MISS')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/health':
            return self.send_json(200, {'status': 'ok', 'stations': stations_state['status']})
        if url.path == '/status':
            q = parse_qs(url.query)
            key = q.get('date', [''])[0] + q.get('cycle', [''])[0]
            entry = progress.get(key)
            # A build never takes this long; a stale entry must not read as busy
            if not entry or time.time() - entry['since'] > 600:
                return self.send_json(200, {'busy': False})
            return self.send_json(200, {'busy': True, 'elapsed': round(time.time() - entry['since']),
                                        'soundings': entry.get('soundings'),
                                        'ensemble': entry.get('ensemble')})
        if url.path == '/stations':
            idx = read_json(STATIONS_FILE)
            if idx:
                return self.send_json(200, idx, cached=True)
            return self.send_json(503, {'error': 'Station index not built yet',
                                        'status': stations_state['status']})
        if url.path != '/plume':
            return self.send_json(404, {'error': 'Not found'})

        q = parse_qs(url.query)
        sid = q.get('sid', [''])[0]
        date = q.get('date', [''])[0]
        cycle = q.get('cycle', [''])[0]
        if not re.fullmatch(r'\d{6}', sid) or not re.fullmatch(r'\d{8}', date) \
                or cycle not in ('00', '06', '12', '18'):
            return self.send_json(400, {'error': 'Invalid sid/date/cycle'})

        try:
            result, cached = build_plume(sid, date, cycle)
            if not result['members']:
                return self.send_json(404, {'error': 'No data available'})
            self.send_json(200, result, cached)
        except urllib.error.HTTPError as err:
            if err.code in (403, 404):
                return self.send_json(404, {'error': f'Cycle {date}/{cycle}Z not published'})
            print(f'[ERROR] {sid} {date}{cycle}: {err}', flush=True)
            self.send_json(502, {'error': str(err)})
        except FileNotFoundError as err:
            self.send_json(404, {'error': str(err)})
        except Exception as err:  # noqa: BLE001 - report any failure upstream
            print(f'[ERROR] {sid} {date}{cycle}: {err}', flush=True)
            self.send_json(502, {'error': str(err)})


if __name__ == '__main__':
    print(f'RRFS/REFS extractor on :{PORT}', flush=True)
    print(f'Soundings: {TAR_URL}\nEnsemble:  {GRIB_URL}', flush=True)
    maybe_start_index_build()
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
