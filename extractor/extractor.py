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
    GET /mrms                        -> {"frames": [scan epochs]}, MRMS radar in RAM
    GET /mrms/<epoch>/<z>/<x>/<y>.png
    GET /mrms/<epoch>/crop.png?w=&s=&e=&n=[&step=]   -> raw scan crop (gray), X-Crop: bounds,step
    GET /mrms/<epoch>/flow.png?w=&s=&e=&n=[&step=][&mean=1]   -> motion (RGB), same bounds
    GET /mrms/palette.png

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

import bz2
import calendar
import functools
import gzip
import json
import math
import os
import re
import shutil
import struct
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
import urllib.error
import warnings
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import cv2
import eccodes as ec
import numpy as np

cv2.setNumThreads(1)                        # radar motion runs beside request threads; one core is ~0.3s a scan

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
    """True/False from the server; None when it could not say (timeout, 5xx, network)."""
    req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT):
            return True
    except urllib.error.HTTPError as err:
        return False if err.code in (403, 404) else None
    except (urllib.error.URLError, OSError):
        return None


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

stations_state = {'status': 'idle', 'attempted': 0}
INDEX_RETRY_S = 3600  # a failed build re-streams the whole tarball: not more than hourly


def find_available_cycle():
    for day_offset in (0, 1):
        date = time.strftime('%Y%m%d', time.gmtime(time.time() - day_offset * 86400))
        for cycle in ('12', '06', '00', '18'):
            if http_exists(TAR_URL.format(date=date, cycle=cycle)):
                return date, cycle
    return None, None


def build_station_index():
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
    """Rebuild the index when missing or older than STATIONS_MAX_AGE_DAYS.
    Called on every /health hit (the container healthcheck), so a long-running
    container keeps it fresh."""
    try:
        age = time.time() - os.path.getmtime(STATIONS_FILE)
        if age < STATIONS_MAX_AGE_DAYS * 86400:
            stations_state['status'] = 'ready'
            return
    except OSError:
        pass
    with _locks_guard:
        if stations_state['status'] == 'building' or time.time() - stations_state['attempted'] < INDEX_RETRY_S:
            return
        stations_state.update(status='building', attempted=time.time())
    threading.Thread(target=build_station_index, daemon=True).start()


# ============ Map fields (RRFS / RTMA 2D grids -> Web Mercator tiles) ============
# Deterministic RRFS forecasts (2dfld files) and RTMA rapid-update analyses
# (observations, every 15 minutes) fetched by .idx byte range and cached as
# the original GRIB messages (already compressed, ~1-6MB each), decoded on
# demand through a small in-memory LRU. A frame is (source, date, cycle, fh):
# RRFS cycles are 'HH', RTMA-RU analyses 'HHMM' with fh 0. Tiles are
# rendered per request: every pixel bilinearly samples the raw messages on
# the Lambert conformal grid, then the field's value() is applied and
# banded into an indexed PNG (palette alpha included). A coarse lat/lon
# grid of the same values feeds the page's map numbers and wind particles.
# The page draws its legends from the same FIELDS stops.

FIELD_URL = os.environ.get(
    'RRFS_FIELD_URL',
    'https://noaa-rrfs-ops-pds.s3.amazonaws.com/rrfs.{date}/{cycle}/rrfs.t{cycle}z.2dfld.3km.f{fh}.conus.grib2')
RTMA_URL = os.environ.get(
    'RTMA_RU_URL',
    'https://noaa-rtma-pds.s3.amazonaws.com/rtma2p5_ru.{date}/rtma2p5_ru.t{cycle}z.2dvaranl_ndfd.grb2')
# National Blend of Models, CONUS 2.5km (the RTMA grid): hourly to 36h, 3-hourly to 192h, 6-hourly to 264h
NBM_URL = os.environ.get(
    'NBM_URL',
    'https://noaa-nbm-grib2-pds.s3.amazonaws.com/blend.{date}/{cycle}/core/blend.t{cycle}z.core.f{fh}.co.grib2')
# 2dfld exists for 3-hourly cycles only: 00/06/12/18Z reach 84h, 03/09/15/21Z 18h.
# RRFS mode -> forecast hour whose publication makes a cycle usable ('now' is RTMA)
FIELD_MODES = {'hourly': 36, 'extended': 84}
RTMA_FRAMES = 9                             # 15-minute analyses: the last two hours
RTMA_TTL_S = 120
# Download every RRFS field's hours for the live cycles in the background, so
# any overlay opens without waiting on S3 (~1GB per 6-hourly cycle); 0 = on demand
FIELD_PRELOAD = os.environ.get('FIELD_PRELOAD', '1') == '1'
FIELD_BBOX = (-134.0, 21.0, -61.0, 53.0)   # west, south, east, north: covers the CONUS grid
FIELD_TILE = 512
FIELD_MAXZOOM = 9                           # ~0.25km/px at 40N; MapLibre overzooms past this
FIELD_GRID_STEP = 0.1                       # degrees, numbers/particles grid
FIELD_CYCLE_TTL_S = 600
FIELD_DIR = os.path.join(CACHE_DIR, 'fields')
CLOUD_LEVEL = 'entire atmosphere (considered as a single layer)'
ACCUMULATED = ('APCP', 'ASNOW')             # run totals from the cycle start


def rrfs_step(msg, fh):
    """The .idx step text: run totals read '0-N hour acc fcst', except whole
    days, which read '0-1 day acc fcst' (instantaneous fields stay in hours)."""
    if msg in ACCUMULATED:
        return f'0-{fh // 24} day acc fcst' if fh % 24 == 0 else f'0-{fh} hour acc fcst'
    return 'anl' if fh == 0 else f'{fh} hour fcst'


def nbm_step(msg, fh):
    """The NBM .idx step text, in hours throughout (no whole-day form): 12 h
    max/min temperature and PoP (probability of more than 0.254 mm, the
    descriptor that follows the step), 6 h amounts, the rest instantaneous."""
    if msg in ('TMAX', 'TMIN'):
        return f'{fh - 12}-{fh} hour {msg[1:].lower()} fcst'
    if msg == 'POP12':
        return f'{fh - 12}-{fh} hour acc fcst:prob >0.254'
    if msg in ('APCP', 'ASNOW', 'FICEAC'):
        return f'{fh - 6}-{fh} hour acc fcst'
    return f'{fh} hour fcst'
# source -> URL template, GRIB level per message name, idx step for a message
# and hour, and the .idx name where a message is not named after it
SOURCES = {
    'rrfs': {'url': FIELD_URL,
             'levels': {'TMP': '2 m above ground', 'DPT': '2 m above ground', 'UGRD': '10 m above ground',
                        'VGRD': '10 m above ground', 'TCDC': CLOUD_LEVEL, 'REFC': CLOUD_LEVEL,
                        'CSNOW': 'surface', 'SBTA1613': 'top of atmosphere', 'GUST': 'surface',
                        'APCP': 'surface', 'ASNOW': 'surface'},
             'step': rrfs_step},
    'rtma': {'url': RTMA_URL,
             'levels': {'TMP': '2 m above ground', 'DPT': '2 m above ground', 'UGRD': '10 m above ground',
                        'VGRD': '10 m above ground', 'GUST': '10 m above ground', 'TCDC': CLOUD_LEVEL},
             'step': lambda m, fh: 'anl'},
    'nbm': {'url': NBM_URL,
            'levels': {'TMAX': '2 m above ground', 'TMIN': '2 m above ground', 'POP12': 'surface',
                       'APCP': 'surface', 'ASNOW': 'surface', 'FICEAC': 'surface', 'TCDC': 'surface',
                       'WIND': '10 m above ground', 'GUST': '10 m above ground'},
            'names': {'POP12': 'APCP'},
            'step': nbm_step},
}
K_TO_F = lambda k: (k - 273.15) * 9 / 5 + 32

# TWC radar colors per 5 dBZ from 0 dBZ; radar.css draws the legend bars from the same hexes
RAIN_HEX = [None, None, '01b714', '088915', '11651a', '064307', 'ffee07', 'f8bb08', 'f38b08', 'f07108',
            'ea5e09', 'df370a', 'd3100c', 'c00d09', 'b80c08', 'b80c08']
SNOW_HEX = [None, '9fffff', '8fffff', '7fefff', '6fdfff', '5fcfff', '4fafff', '3f9fff', '2f8fff', '1f7fff',
            '0f6fff', '005fff', '004fff', '003fff', '002fff', '001fff']


def radar_stops():
    """Stops at 5 dBZ band centers, snow as negative dBZ, so each band paints its exact legend color."""
    rgba = lambda h: (0, 0, 0, 0) if h is None else (int(h[:2], 16), int(h[2:4], 16), int(h[4:], 16), 255)
    stops = [(-(2.5 + 5 * k), rgba(h)) for k, h in reversed(list(enumerate(SNOW_HEX)))]
    stops += [(2.5 + 5 * k, rgba(h)) for k, h in enumerate(RAIN_HEX)]
    return [(-80, stops[0][1])] + stops + [(80, stops[-1][1])]


# name -> GRIB messages, value(*sampled arrays), palette stops (value, RGBA)
# interpolated into `band`-wide steps; legend unit/label/ticks; `grid` feeds
# map numbers. `layers` composites the first field over the second.
FIELDS = {
    'tmp': {'grib': ['TMP'], 'value': K_TO_F, 'band': 2, 'grid': {'scale': 1, 'suffix': '°'},
            'unit': '°F', 'label': '2 m temperature', 'ticks': [0, 32, 50, 70, 90],
            'stops': [(-40, (255, 255, 255, 255)), (-20, (227, 198, 247, 255)), (0, (123, 91, 214, 255)),
                      (10, (62, 70, 201, 255)), (20, (47, 127, 224, 255)), (32, (94, 198, 242, 255)),
                      (40, (111, 211, 168, 255)), (50, (127, 211, 90, 255)), (60, (216, 224, 74, 255)),
                      (70, (245, 197, 66, 255)), (80, (242, 139, 48, 255)), (90, (226, 74, 42, 255)),
                      (100, (179, 31, 54, 255)), (120, (122, 16, 48, 255))]},
    'dpt': {'grib': ['DPT'], 'value': K_TO_F, 'band': 2, 'grid': {'scale': 1, 'suffix': '°'},
            'unit': '°F', 'label': '2 m dew point', 'ticks': [10, 30, 50, 60, 70],
            'stops': [(-10, (120, 85, 55, 255)), (20, (160, 125, 85, 255)), (35, (195, 170, 120, 255)),
                      (45, (170, 200, 120, 255)), (55, (90, 190, 90, 255)), (60, (40, 160, 80, 255)),
                      (65, (30, 150, 150, 255)), (70, (40, 110, 200, 255)), (75, (100, 60, 190, 255)),
                      (80, (170, 50, 170, 255))]},
    'wind': {'grib': ['UGRD', 'VGRD'], 'value': lambda u, v: np.hypot(u, v) * 2.23694, 'band': 2,
             'grid': {'scale': 1, 'suffix': '', 'peak': True, 'uv': True},
             'unit': 'mph', 'label': '10 m wind speed', 'ticks': [10, 20, 30, 40, 50],
             'stops': [(0, (70, 110, 170, 0)), (5, (70, 110, 170, 70)), (10, (40, 150, 160, 150)),
                       (20, (80, 190, 90, 220)), (30, (230, 210, 50, 235)), (40, (240, 140, 40, 245)),
                       (50, (220, 50, 50, 255)), (70, (170, 30, 160, 255))]},
    'cloud': {'grib': ['TCDC'], 'value': lambda c: c, 'band': 5,
              'unit': '%', 'label': 'Total cloud cover', 'ticks': [25, 50, 75, 100],
              'stops': [(0, (255, 255, 255, 0)), (10, (255, 255, 255, 0)), (20, (236, 240, 247, 60)),
                        (50, (242, 245, 250, 150)), (100, (255, 255, 255, 235))]},
    # Simulated composite reflectivity, snow (categorical, interpolated then thresholded) as negative dBZ
    'refc': {'grib': ['REFC', 'CSNOW'], 'band': 5, 'stops': radar_stops(),
             'value': lambda r, s: np.where(s >= 0.5, -1, 1) * np.clip(r, 0, 79.9)},
    # Simulated GOES band 13 (clean IR) brightness temperature, K: cold tops white, warm ground clear
    'sat': {'grib': ['SBTA1613'], 'value': lambda t: t, 'band': 2,
            'stops': [(180, (255, 255, 255, 250)), (210, (245, 247, 250, 240)), (240, (215, 220, 228, 210)),
                      (260, (180, 186, 196, 160)), (275, (140, 146, 156, 90)), (285, (120, 125, 135, 0)),
                      (330, (120, 125, 135, 0))]},
    'both': {'layers': ['refc', 'sat']},
    'gust': {'grib': ['GUST'], 'value': lambda g: g * 2.23694, 'band': 2,
             'grid': {'scale': 1, 'suffix': '', 'peak': True, 'uv': True},
             'unit': 'mph', 'label': 'Wind gusts', 'ticks': [10, 20, 30, 40, 50],
             'stops': [(0, (70, 110, 170, 0)), (10, (70, 110, 170, 70)), (20, (40, 150, 160, 150)),
                       (30, (80, 190, 90, 220)), (40, (230, 210, 50, 235)), (50, (240, 140, 40, 245)),
                       (60, (220, 50, 50, 255)), (80, (170, 30, 160, 255))]},
    # Run totals since the cycle started, banded on sqrt(inches) so light amounts get resolution
    'qpf': {'grib': ['APCP'], 'value': lambda a: a / 25.4, 'band': 0.02, 'sqrt': True, 'acc': True,
            'grid': {'scale': 10, 'suffix': '"', 'peak': True},
            'unit': 'in', 'label': 'Total precipitation since run start', 'ticks': [0.1, 1, 2, 4, 8],
            'stops': [(0, (0, 0, 0, 0)), (0.0099, (164, 220, 160, 0)), (0.01, (164, 220, 160, 170)),
                      (0.1, (100, 200, 110, 200)), (0.25, (40, 160, 80, 215)), (0.5, (20, 120, 70, 225)),
                      (1, (245, 225, 60, 235)), (1.5, (245, 165, 40, 240)), (2, (230, 90, 40, 245)),
                      (3, (195, 35, 60, 250)), (4, (150, 40, 160, 250)), (6, (110, 70, 205, 255)),
                      (10, (225, 200, 255, 255))]},
    'snowtot': {'grib': ['ASNOW'], 'value': lambda m: m * 39.37, 'band': 0.05, 'sqrt': True, 'acc': True,
                'grid': {'scale': 1, 'suffix': '"', 'peak': True},
                'unit': 'in', 'label': 'Total snowfall since run start', 'ticks': [1, 3, 6, 12, 24],
                'stops': [(0, (0, 0, 0, 0)), (0.099, (200, 225, 255, 0)), (0.1, (200, 225, 255, 190)),
                          (1, (130, 180, 240, 215)), (3, (70, 120, 220, 235)), (6, (90, 60, 200, 245)),
                          (12, (170, 60, 190, 250)), (24, (230, 120, 200, 255)), (48, (255, 220, 245, 255))]},
}

_newest = {}        # probe key -> (checked at, (date, cycle))
_newest_lock = threading.Lock()
_warm_pool = ThreadPoolExecutor(max_workers=4)
_warming = set()    # (src, date, cycle, fh, msg) already queued


def band_axis(spec, v):
    """Where a value sits on the field's banding axis: sqrt for totals, else the value."""
    return np.sqrt(np.maximum(v, 0)) if spec.get('sqrt') else v


def field_palette(spec):
    """RGBA per band from the first stop up."""
    vs = band_axis(spec, np.array([v for v, _ in spec['stops']], float))
    bands = np.arange(vs[0], vs[-1], spec['band']) + spec['band'] / 2
    return np.stack([np.interp(bands, vs, [c[k] for _, c in spec['stops']]) for k in range(4)], 1).astype(np.uint8)


def fetch_idx_fields(url, wanted, step):
    """GRIB messages for [(name, level)] by .idx byte range; None if the file
    is not published. The step matches the .idx step plus any descriptor after
    it ('prob >0.254', 'ens std dev'), so '6 hour fcst' is the plain value."""
    try:
        rows = [l.split(':') for l in http_get(url + '.idx').decode().splitlines()]
    except urllib.error.HTTPError as err:
        if err.code in (403, 404):
            return None
        raise
    out = []
    for name, level in wanted:
        i = next((i for i, r in enumerate(rows) if r[3] == name and r[4] == level
                  and ':'.join(r[5:7]).rstrip(':') == step), None)
        if i is None:
            raise RuntimeError(f'{name}:{level}:{step} not in {url}.idx')
        end = str(int(rows[i + 1][1]) - 1) if i + 1 < len(rows) else ''
        out.append(http_get(url, headers={'Range': f'bytes={rows[i][1]}-{end}'}, timeout=120))
    return out


GRID_KEYS = ('Nx', 'Ny', 'LoVInDegrees', 'LaDInDegrees', 'latitudeOfFirstGridPointInDegrees',
             'longitudeOfFirstGridPointInDegrees', 'DxInMetres', 'DyInMetres', 'radius')


def grid_params(g):
    """Projection keys of a tangent Lambert conformal grid on a sphere (what RRFS CONUS uses)."""
    if ec.codes_get(g, 'gridType') != 'lambert' or ec.codes_get(g, 'Latin1InDegrees') != ec.codes_get(g, 'Latin2InDegrees') \
            or ec.codes_get(g, 'iScansNegatively') or not ec.codes_get(g, 'jScansPositively'):
        raise RuntimeError('Unsupported grid for map rendering')
    return {k: ec.codes_get(g, k) for k in GRID_KEYS}


def lambert_ij(p, lat, lon):
    """Fractional grid column/row of each lat/lon."""
    phi0, lam0, r = math.radians(p['LaDInDegrees']), math.radians(p['LoVInDegrees']), p['radius']
    n = math.sin(phi0)
    F = math.cos(phi0) * math.tan(math.pi / 4 + phi0 / 2) ** n / n

    def project(lat, lon):
        rho = r * F / np.tan(np.pi / 4 + np.radians(lat) / 2) ** n
        theta = n * (((np.radians(lon) - lam0 + np.pi) % (2 * np.pi)) - np.pi)
        return rho * np.sin(theta), -rho * np.cos(theta)

    x, y = project(lat, lon)
    x1, y1 = project(p['latitudeOfFirstGridPointInDegrees'], p['longitudeOfFirstGridPointInDegrees'])
    return (x - x1) / p['DxInMetres'], (y - y1) / p['DyInMetres']


def earth_winds(p, u, v, lon):
    """Grid-relative Lambert winds (uvRelativeToGrid=1 in RRFS) turned earth-relative."""
    t = math.sin(math.radians(p['LaDInDegrees'])) * np.radians((lon - p['LoVInDegrees'] + 180) % 360 - 180)
    return u * np.cos(t) + v * np.sin(t), -u * np.sin(t) + v * np.cos(t)


def sample(arrays, p, lat, lon):
    """Bilinear samples of each (ny, nx) array at lat/lon, and the on-grid mask."""
    fi, fj = lambert_ij(p, lat, lon)
    ny, nx = arrays[0].shape
    inside = (fi >= 0) & (fi <= nx - 1) & (fj >= 0) & (fj <= ny - 1)
    i0 = np.clip(np.floor(fi).astype(np.int64), 0, nx - 2)
    j0 = np.clip(np.floor(fj).astype(np.int64), 0, ny - 2)
    wi, wj = np.clip(fi - i0, 0, 1), np.clip(fj - j0, 0, 1)
    return [(a[j0, i0] * (1 - wi) + a[j0, i0 + 1] * wi) * (1 - wj)
            + (a[j0 + 1, i0] * (1 - wi) + a[j0 + 1, i0 + 1] * wi) * wj for a in arrays], inside


def paint(spec, arrays, p, lat, lon):
    """(palette indices, palette) of a field at lat/lon; index 255 off the grid."""
    vals, inside = sample(arrays, p, lat, lon)
    palette = field_palette(spec)
    lo = band_axis(spec, spec['stops'][0][0])
    band = np.clip((band_axis(spec, spec['value'](*vals)) - lo) // spec['band'], 0, len(palette) - 1)
    return np.where(inside, band, 255).astype(np.uint8), palette


def composite(top, base):
    """Top field's opaque pixels over the base field, palettes concatenated."""
    (tpx, tpal), (bpx, bpal) = top, base
    opaque = np.zeros(256, bool)
    opaque[:len(tpal)] = tpal[:, 3] > 0
    return np.where(opaque[tpx], tpx, np.where(bpx == 255, 255, bpx + len(tpal))).astype(np.uint8), np.vstack([tpal, bpal])


def png_chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def indexed_png(pixels, palette):
    """8-bit palette PNG from RGBA palette rows; index 255 is transparent."""
    h, w = pixels.shape
    raw = np.hstack([np.zeros((h, 1), np.uint8), pixels]).tobytes()   # filter byte 0 per row
    plte = np.zeros((256, 4), np.uint8)
    plte[:len(palette)] = palette
    return (b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 3, 0, 0, 0))
            + png_chunk(b'PLTE', plte[:, :3].tobytes()) + png_chunk(b'tRNS', plte[:, 3].tobytes())
            + png_chunk(b'IDAT', zlib.compress(raw, 9)) + png_chunk(b'IEND', b''))


def raw_png(pixels, level=6):
    """Gray (h, w), RGB (h, w, 3) or RGBA (h, w, 4) uint8 PNG with no color
    chunks, so a page can upload the bytes as texture data unchanged."""
    h, w = pixels.shape[:2]
    kind = {1: 0, 3: 2, 4: 6}[pixels.shape[2] if pixels.ndim == 3 else 1]
    raw = np.hstack([np.zeros((h, 1), np.uint8), pixels.reshape(h, -1)]).tobytes()
    return (b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, kind, 0, 0, 0))
            + png_chunk(b'IDAT', zlib.compress(raw, level)) + png_chunk(b'IEND', b''))


def newest_published(key, candidates, ttl):
    """First (date, cycle) of candidates [(date, cycle, url)] whose URL exists,
    cached for ttl. One thread refreshes while the others keep the cached
    answer; a probe S3 could not answer keeps it too, since falling back a
    cycle would purge the newer one."""
    at, value = _newest.get(key, (0, (None, None)))
    if time.time() - at < ttl or not _newest_lock.acquire(blocking=value[0] is None):
        return value
    try:
        # Another thread may have refreshed while this one waited for the lock
        at, value = _newest.get(key, (0, (None, None)))
        if time.time() - at < ttl:
            return value
        found = (None, None)
        for date, cycle, url in candidates:
            ok = http_exists(url)
            if ok is None:
                _newest[key] = (time.time() - ttl + 60, value)   # retry in a minute
                return value
            if ok:
                found = (date, cycle)
                break
        _newest[key] = (time.time(), found)
        return found
    finally:
        _newest_lock.release()


def field_cycle(mode):
    """Newest RRFS cycle with the mode's marker hour published."""
    now = time.time()
    cands = []
    for back in range(1, 13):
        t = time.gmtime(now - back * 3600)
        if t.tm_hour % 3 == 0:
            date, cycle = time.strftime('%Y%m%d', t), f'{t.tm_hour:02d}'
            cands.append((date, cycle, FIELD_URL.format(date=date, cycle=cycle, fh=f'{FIELD_MODES[mode]:03d}') + '.idx'))
    return newest_published(mode, cands, FIELD_CYCLE_TTL_S)


def rtma_frames():
    """(date, 'HHMM') of the last RTMA_FRAMES rapid-update analyses, oldest first."""
    now = int(time.time()) // 900 * 900
    cands = []
    for back in range(0, 5):   # published ~17 minutes after valid time
        t = time.gmtime(now - back * 900)
        date, cycle = time.strftime('%Y%m%d', t), time.strftime('%H%M', t)
        cands.append((date, cycle, RTMA_URL.format(date=date, cycle=cycle) + '.idx'))
    date, cycle = newest_published('rtma', cands, RTMA_TTL_S)
    if not date:
        return []
    t0 = calendar.timegm(time.strptime(date + cycle, '%Y%m%d%H%M'))
    return [(time.strftime('%Y%m%d', time.gmtime(t)), time.strftime('%H%M', time.gmtime(t)))
            for t in range(t0 - (RTMA_FRAMES - 1) * 900, t0 + 1, 900)]


def frame_time(src, date, cycle, fh):
    fmt = '%Y%m%d%H%M' if src == 'rtma' else '%Y%m%d%H'
    return calendar.timegm(time.strptime(date + cycle, fmt)) + fh * 3600


def field_msgs(name):
    return [m for n in FIELDS[name].get('layers', [name]) for m in FIELDS[n]['grib']]


def has_obs(name):
    return all(m in SOURCES['rtma']['levels'] for m in field_msgs(name))


def mode_frames(mode, name):
    """[(src, date, cycle, fh)] a mode shows for a field, oldest first."""
    if mode == 'now':
        return [('rtma', d, c, 0) for d, c in rtma_frames()] if has_obs(name) else []
    date, cycle = field_cycle(mode)
    if not date:
        return []
    last = FIELD_MODES[mode]
    return [('rrfs', date, cycle, fh) for fh in range(1 if FIELDS[name].get('acc') else 0, last + 1)]


def live_frames():
    """Every (src, date, cycle) some mode currently serves."""
    live = {('rrfs', d, c) for d, c in map(field_cycle, FIELD_MODES) if d}
    return live | {('rtma', d, c) for d, c in rtma_frames()}


def frame_dir(src, date, cycle):
    return os.path.join(FIELD_DIR, f'{src}{date}{cycle}')


def purge_fields():
    """Drop every cycle/analysis no mode serves, and anything but GRIB
    messages (older cache formats, abandoned writes) inside the live ones."""
    # One read of the cycle caches for both sets, so a refresh landing in
    # between cannot mark a new cycle known without keeping it
    cycles, rtma = [field_cycle(m) for m in FIELD_MODES], rtma_frames()
    live = {('rrfs', d, c) for d, c in cycles if d} | {('rtma', d, c) for d, c in rtma}
    # The last run's forecast crops serve until the new run's are cut
    nbm, nbm_prev = forecast_runs('nbm')
    live |= {(src, *run) for src, run in (('rrfs', forecast_runs('rrfs')[1]), ('nbm', nbm), ('nbm', nbm_prev))
             if run and run[0]}
    keep = {os.path.basename(frame_dir(*f)) for f in live}
    known = ({'rtma'} if rtma else set()) | ({'rrfs'} if all(d for d, _ in cycles) else set()) \
        | ({'nbm'} if nbm[0] else set())
    for old in os.listdir(FIELD_DIR) if os.path.isdir(FIELD_DIR) else []:
        src = re.match('[a-z]*', old).group()   # dirs are <src><date><cycle>; anything else is an older cache format
        if old not in keep and (src not in SOURCES or src in known):
            shutil.rmtree(os.path.join(FIELD_DIR, old), ignore_errors=True)
            continue
        # Kept dirs hold only GRIB messages and forecast crops, plus writes still in progress
        for f in os.scandir(os.path.join(FIELD_DIR, old)):
            try:
                if not f.name.endswith(('.grib2', '.npz', '.tmp')) or f.name.endswith('.tmp') and time.time() - f.stat().st_mtime > 600:
                    os.remove(f.path)
            except FileNotFoundError:
                pass   # renamed into place or removed by a concurrent purge
    # In place: warm_one may be discarding a failed key right now
    _warming.difference_update([k for k in list(_warming) if k[:3] not in live])


def msg_path(src, date, cycle, fh, msg):
    return os.path.join(frame_dir(src, date, cycle), f'{msg}_f{fh:03d}.grib2')


def fetch_msg(src, date, cycle, fh, msg):
    """Path of one cached GRIB message; None if that frame is not published."""
    path = msg_path(src, date, cycle, fh, msg)
    with file_lock(path):
        if not os.path.exists(path):
            s = SOURCES[src]
            raws = fetch_idx_fields(s['url'].format(date=date, cycle=cycle, fh=f'{fh:03d}'),
                                    [(s.get('names', {}).get(msg, msg), s['levels'][msg])], s['step'](msg, fh))
            if raws is None:
                return None
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + '.tmp', 'wb') as fp:
                fp.write(ccsds(raws[0]) if src == 'rtma' else raws[0])
            os.replace(path + '.tmp', path)
    return path


def ccsds(msg):
    """RTMA ships simple-packed (~6MB a message); CCSDS repacking is lossless
    and about half the size. Kept only if it decodes to identical values."""
    g = ec.codes_new_from_message(msg)
    try:
        h = ec.codes_clone(g)
        try:
            ec.codes_set(h, 'packingType', 'grid_ccsds')
            out = ec.codes_get_message(h)
        finally:
            ec.codes_release(h)
        back = ec.codes_new_from_message(out)
        try:
            same = np.array_equal(ec.codes_get_values(back), ec.codes_get_values(g))
        finally:
            ec.codes_release(back)
        return out if same and len(out) < len(msg) else msg
    except ec.GribInternalError:
        return msg
    finally:
        ec.codes_release(g)


def grid_values(g, p):
    """(ny, nx) values, each row west to east. NBM scans every other row
    east to west (alternativeRowScanning), and ecCodes returns them as stored."""
    a = ec.codes_get_values(g).reshape(p['Ny'], p['Nx'])
    if ec.codes_get(g, 'alternativeRowScanning'):
        a[1::2] = a[1::2, ::-1]
    return a


@functools.lru_cache(maxsize=24)   # 7.6MB (RRFS) to 15MB (RTMA, NBM) each
def decoded(path):
    with open(path, 'rb') as fp:
        g = ec.codes_new_from_message(fp.read())
    try:
        p = grid_params(g)
        return grid_values(g, p).astype(np.float32), p
    finally:
        ec.codes_release(g)


class NotPublished(Exception):
    pass


def field_arrays(name, frame, cached_only=False):
    """Decoded messages of one field for a frame, fetching unless cached_only."""
    if cached_only:
        paths = [msg_path(*frame, m) for m in FIELDS[name]['grib']]
        if not all(map(os.path.exists, paths)):
            raise NotPublished
    else:
        paths = [fetch_msg(*frame, m) for m in FIELDS[name]['grib']]
    if None in paths:
        raise NotPublished
    got = [decoded(path) for path in paths]
    return [a for a, _ in got], got[0][1]


def tile_png(name, frame, z, x, y):
    t = (np.arange(FIELD_TILE) + 0.5) / FIELD_TILE
    lon = ((x + t) / 2 ** z * 360 - 180)[None, :]
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y + t) / 2 ** z))))[:, None]
    parts = [paint(FIELDS[n], *field_arrays(n, frame), lat, lon) for n in FIELDS[name].get('layers', [name])]
    return indexed_png(*(composite(*parts) if len(parts) > 1 else parts[0]))


def grid_axes():
    w, s, e, n = FIELD_BBOX
    return np.arange(n, s - 1e-9, -FIELD_GRID_STEP), np.arange(w, e + 1e-9, FIELD_GRID_STEP)


@functools.lru_cache(maxsize=24)
def field_grid(name, frame):
    """int8 lat/lon grid (rows north to south), -128 off the grid: the field
    value times its grid scale, or for 'uv' fields earth-relative u then v in
    0.5 m/s. Gusts have no direction of their own: their vectors take the 10 m
    wind's direction at the gust's speed. Sent as pack_grid bytes."""
    lat, lon = grid_axes()
    if FIELDS[name]['grid'].get('uv'):
        wind, p = field_arrays('wind', frame)
        (u, v), inside = sample(wind, p, lat[:, None], lon[None, :])
        u, v = earth_winds(p, u, v, lon[None, :])
        if name != 'wind':
            arrays, p = field_arrays(name, frame)
            (g,), _ = sample(arrays, p, lat[:, None], lon[None, :])
            k = FIELDS[name]['value'](g) / 2.23694 / np.maximum(np.hypot(u, v), 0.1)
            u, v = u * k, v * k
        out, scale = [u, v], 2
    else:
        arrays, p = field_arrays(name, frame)
        vals, inside = sample(arrays, p, lat[:, None], lon[None, :])
        out, scale = [FIELDS[name]['value'](*vals)], FIELDS[name]['grid']['scale']
    q = [np.where(inside, np.clip(np.rint(a * scale), -127, 127), -128).astype(np.int8) for a in out]
    return pack_grid(np.concatenate([a.ravel() for a in q]))


def pack_grid(flat):
    """gzip of successive int8 differences (wrapping): smooth fields become
    runs of small numbers, ~10% smaller than gzip alone. radar.js loadGrid undoes it."""
    return gzip.compress(np.diff(flat, prepend=np.int8(0)).astype(np.int8).tobytes(), 9)


# Tap-to-inspect: these always (fetched if needed), the rest only when cached
POINT_BASE = ('tmp', 'dpt', 'wind')
POINT_FIELDS = ('tmp', 'dpt', 'wind', 'gust', 'cloud', 'refc', 'qpf', 'snowtot')


def point_values(frame, lat, lon, overlay, always=POINT_BASE):
    """Every inspectable field's value at one point, for the popup."""
    out = {}
    for name in POINT_FIELDS:
        if not all(m in SOURCES[frame[0]]['levels'] for m in FIELDS[name]['grib']) \
                or FIELDS[name].get('acc') and frame[3] == 0:
            continue
        try:
            arrays, p = field_arrays(name, frame, cached_only=name not in always and name != overlay)
        except NotPublished:
            continue
        vals, inside = sample(arrays, p, np.array([lat]), np.array([lon]))
        if not inside[0]:
            return {}
        if name == 'wind':
            u, v = earth_winds(p, *vals, lon)
            out['wind'] = {'mph': round(float(np.hypot(u, v)[0]) * 2.23694, 1),
                           'from': round(float(np.degrees(np.arctan2(-u, -v))[0]) % 360)}
        elif name == 'refc':
            out['refc'] = {'dbz': round(float(vals[0][0]), 1), 'snow': bool(vals[1][0] >= 0.5)}
        else:
            out[name] = round(float(FIELDS[name]['value'](*vals)[0]), 2)
    return out


def warm_field(name, frames):
    """Queue every frame's messages in the background, nearest to now first,
    so tiles for the rest of the loop render without waiting on S3."""
    now = time.time()
    # Vector grids also need the 10 m wind (gust direction)
    msgs = field_msgs(name) + (field_msgs('wind') if FIELDS[name].get('grid', {}).get('uv') else [])
    for frame in sorted(frames, key=lambda f: abs(frame_time(*f) - now)):
        for m in dict.fromkeys(msgs):
            if frame + (m,) not in _warming:
                _warming.add(frame + (m,))
                _warm_pool.submit(warm_one, frame + (m,))


def warm_one(key):
    """Background fetch; a failure leaves the key out of _warming so the
    next preload pass or index request retries it."""
    try:
        ok = fetch_msg(*key) is not None
    except Exception as err:  # noqa: BLE001 - logged, retried later
        print(f'[WARM] {key}: {err}', flush=True)
        ok = False
    if not ok:
        _warming.discard(key)


def preload_fields():
    """Keep every RRFS field of the live cycles downloaded (FIELD_PRELOAD)."""
    while True:
        try:
            purge_fields()
            for name in FIELDS:
                if 'layers' not in FIELDS[name]:
                    warm_field(name, sorted({f for mode in FIELD_MODES for f in mode_frames(mode, name)}))
            # Only the tiles places asked for: an NBM run is ~400MB, fetched once any place needs it
            tiles = recent_tiles()
            for src in CROPS:
                (date, cycle), prev = forecast_runs(src)
                if not date:
                    continue
                ensure_crops(src, date, cycle, tiles)
                # Release the old run only once every place's new crop exists
                # (a request may still be cutting some of them)
                if prev and crops_ready(src, date, cycle, tiles):
                    with _forecast_run_lock:
                        if _forecast_run[src]['prev'] == prev:
                            _forecast_run[src]['prev'] = None
        except Exception as err:  # noqa: BLE001 - keep the loop alive
            print(f'[PRELOAD] {err}', flush=True)
        time.sleep(FIELD_CYCLE_TTL_S)


# ============ Point forecasts (overview page) ============
# A place's hourly RRFS series means one value from every message of every
# hour: ~850 full-grid decodes. So each run is cut once into small regional
# crops (1 degree tiles, all hours, all FORECAST_MSGS) stored next to the
# GRIB messages; a place then reads its series in milliseconds. Tiles that
# were asked for recently are re-cut after every preload pass, so saved
# places never wait; a new tile builds in the background (~7 s) while the
# page shows the observed conditions. The 10-day daily forecast comes the
# same way from NBM runs (6-hourly messages, see daily_rows).

FORECAST_MSGS = ('TMP', 'DPT', 'UGRD', 'VGRD', 'GUST', 'TCDC', 'APCP', 'ASNOW', 'CSNOW', 'REFC')
FORECAST_MODE = 'extended'                  # one run for all 85 hours
FORECAST_TILES_FILE = os.path.join(CACHE_DIR, 'forecast-tiles.json')   # tile -> last requested (epoch)
FORECAST_TILE_KEEP_S = 14 * 86400
FORECAST_TILES_MAX = 64                     # most recently requested tiles kept current
FORECAST_BATCH = 16                         # tiles cut per pass: bounds memory at ~100 MB
NOW_FIELDS = ('tmp', 'dpt', 'wind', 'gust', 'cloud')
_crop_pool = ThreadPoolExecutor(max_workers=4)   # decodes run ~2.4x faster on 4 threads
_crop_building = set()                           # (src, date, cycle, tile) being cut
_forecast_run = {'rrfs': {'cur': None, 'prev': None}, 'nbm': {'cur': None, 'prev': None}}
_forecast_run_lock = threading.Lock()
_crop_lock = threading.Lock()
_tiles_lock = threading.Lock()


# NBM messages for the daily forecast, every 6 hours to the last. 12 h
# windows (TMAX, TMIN, POP12) end at 00z and 12z only; amounts are 6 h.
DAILY_MSGS = ('TCDC', 'WIND', 'GUST', 'APCP', 'ASNOW', 'FICEAC', 'TMAX', 'TMIN', 'POP12')
DAILY_LAST = 264


def nbm_has(cycle, msg, fh):
    """Whether an NBM run publishes this message at this hour."""
    end = (int(cycle) + fh) % 24
    if msg in ('TMAX', 'TMIN', 'POP12'):
        return fh >= 12 and end in {'TMAX': (0,), 'TMIN': (12,), 'POP12': (0, 12)}[msg]
    return True


# source -> messages, forecast hours, whether (cycle, msg, fh) exists; the first message at the first hour gives the grid
CROPS = {'rrfs': (FORECAST_MSGS, range(FIELD_MODES[FORECAST_MODE] + 1), lambda c, m, fh: fh > 0 or m not in ACCUMULATED),
         'nbm': (DAILY_MSGS, range(6, DAILY_LAST + 1, 6), nbm_has)}


def daily_cycle():
    """Newest NBM 00z/12z run with its last hour published."""
    now = time.time()
    cands = []
    for back in range(0, 48):
        t = time.gmtime(now - back * 3600)
        if t.tm_hour % 12 == 0:
            date, cycle = time.strftime('%Y%m%d', t), f'{t.tm_hour:02d}'
            cands.append((date, cycle, NBM_URL.format(date=date, cycle=cycle, fh=f'{DAILY_LAST:03d}') + '.idx'))
    return newest_published('nbm', cands, FIELD_CYCLE_TTL_S)


def forecast_runs(src):
    """(current, previous or None) runs of a crop source. When the run
    changes, the previous one stays until preload has cut the new run's
    crops, so saved places keep a forecast through the switch."""
    cur = field_cycle(FORECAST_MODE) if src == 'rrfs' else daily_cycle()
    with _forecast_run_lock:
        run = _forecast_run[src]
        if cur[0] and cur != run['cur']:
            run['prev'], run['cur'] = run['cur'], cur
        return (run['cur'] or (None, None)), run['prev']


def run_grid(src, date, cycle):
    """Grid parameters of a run, None if it is not published."""
    msgs, hours, _ = CROPS[src]
    path = fetch_msg(src, date, cycle, hours[0], msgs[0])
    return path and decoded(path)[1]


def crops_ready(src, date, cycle, tiles):
    """Whether every tile the grid reaches has its crop cut for this run."""
    p = run_grid(src, date, cycle)
    return bool(p) and all(os.path.exists(crop_path(src, date, cycle, t)) for t in tiles if crop_box(p, t))


def forecast_tile(lat, lon):
    return math.floor(lat), math.floor(lon)


def crop_box(p, tile):
    """Grid index window (j0, j1, i0, i1) covering a 1-degree tile plus a cell of margin."""
    t = np.linspace(0, 1, 9)
    lat = np.concatenate([tile[0] + t, tile[0] + t, np.full(9, tile[0]), np.full(9, tile[0] + 1)])
    lon = np.concatenate([np.full(9, tile[1]), np.full(9, tile[1] + 1), tile[1] + t, tile[1] + t])
    fi, fj = lambert_ij(p, lat, lon)
    i0, i1 = max(0, int(np.floor(fi.min())) - 1), min(p['Nx'], int(np.ceil(fi.max())) + 2)
    j0, j1 = max(0, int(np.floor(fj.min())) - 1), min(p['Ny'], int(np.ceil(fj.max())) + 2)
    return (j0, j1, i0, i1) if i1 - i0 > 1 and j1 - j0 > 1 else None


def crop_path(src, date, cycle, tile):
    return os.path.join(frame_dir(src, date, cycle), f'fc_{tile[0]}_{tile[1]}.npz')


def build_crops(src, date, cycle, tiles):
    """Cut every tile's crop from one pass over the run's messages:
    (messages, hours, rows, columns), NaN where a message does not exist."""
    p = run_grid(src, date, cycle)
    if not p:
        return
    boxes = {t: b for t in tiles if (b := crop_box(p, t))}
    if not boxes:   # tiles off the grid: nothing to cut
        return
    msgs, hours, has = CROPS[src]
    out = {t: np.full((len(msgs), len(hours), j1 - j0, i1 - i0), np.nan, np.float32)
           for t, (j0, j1, i0, i1) in boxes.items()}

    def cut(job):
        k, n = job
        msg, fh = msgs[k], hours[n]
        if not has(cycle, msg, fh):
            return
        path = fetch_msg(src, date, cycle, fh, msg)
        if path is None:
            return
        with open(path, 'rb') as fp:   # plain decode: bulk work stays out of the tile LRU
            g = ec.codes_new_from_message(fp.read())
        try:
            arr = grid_values(g, p)
        finally:
            ec.codes_release(g)
        for t, (j0, j1, i0, i1) in boxes.items():
            out[t][k, n] = arr[j0:j1, i0:i1]

    list(_crop_pool.map(cut, [(k, n) for n in range(len(hours)) for k in range(len(msgs))]))
    for t, (j0, j1, i0, i1) in boxes.items():
        path = crop_path(src, date, cycle, t)
        with open(path + '.tmp', 'wb') as fp:
            np.savez_compressed(fp, data=out[t], i0=i0, j0=j0, grid=json.dumps(p))
        os.replace(path + '.tmp', path)


def ensure_crops(src, date, cycle, tiles):
    """Cut the tiles that have no crop yet for this run, unless already under
    way. True when nothing failed."""
    with _crop_lock:
        todo = [t for t in tiles if (src, date, cycle, t) not in _crop_building
                and not os.path.exists(crop_path(src, date, cycle, t))]
        _crop_building.update((src, date, cycle, t) for t in todo)
    if not todo:
        return True
    try:
        for k in range(0, len(todo), FORECAST_BATCH):
            build_crops(src, date, cycle, todo[k:k + FORECAST_BATCH])
        return True
    except Exception as err:  # noqa: BLE001 - a later request or preload pass retries
        print(f'[FORECAST] crops {src}{date}{cycle} {todo}: {err}', flush=True)
        return False
    finally:
        with _crop_lock:
            _crop_building.difference_update((src, date, cycle, t) for t in todo)


@functools.lru_cache(maxsize=16)
def load_crop(path):
    with np.load(path) as z:
        return z['data'], int(z['i0']), int(z['j0']), json.loads(str(z['grid']))


def crop_series(crop, lat, lon):
    """Bilinear value of every message at every hour at one point: (msgs, hours)."""
    data, i0, j0, p = crop
    fi, fj = lambert_ij(p, lat, lon)
    fi, fj = fi - i0, fj - j0
    ny, nx = data.shape[2:]
    if not (0 <= fi <= nx - 1 and 0 <= fj <= ny - 1):
        return None
    i, j = min(int(fi), nx - 2), min(int(fj), ny - 2)
    wi, wj = fi - i, fj - j
    d = data[:, :, j:j + 2, i:i + 2]
    return (d[..., 0, 0] * (1 - wi) + d[..., 0, 1] * wi) * (1 - wj) + (d[..., 1, 0] * (1 - wi) + d[..., 1, 1] * wi) * wj


def hourly_series(date, cycle, lat, lon):
    """Columnar hourly forecast for the overview, or None outside the grid."""
    crop = load_crop(crop_path('rrfs', date, cycle, forecast_tile(lat, lon)))
    s = crop_series(crop, lat, lon)
    if s is None:
        return None
    v = dict(zip(FORECAST_MSGS, s))
    p = crop[3]
    u, w = earth_winds(p, v['UGRD'], v['VGRD'], lon)
    # Run totals -> per-hour amounts (hour 0 has no total)
    per_hour = lambda acc: np.diff(np.nan_to_num(acc, nan=0.0), prepend=0.0).clip(0)
    r = lambda a, n=1: [None if np.isnan(x) else round(float(x), n) for x in a]
    return {
        'run': f'{date}{cycle}', 'start': frame_time('rrfs', date, cycle, 0), 'step': 3600,
        'tmp': r(K_TO_F(v['TMP'])), 'dpt': r(K_TO_F(v['DPT'])),
        'wind': r(np.hypot(u, w) * 2.23694), 'dir': r(np.degrees(np.arctan2(-u, -w)) % 360, 0),
        'gust': r(v['GUST'] * 2.23694), 'cloud': r(v['TCDC'], 0),
        'qpf': r(per_hour(v['APCP'] / 25.4), 2), 'snow': r(per_hour(v['ASNOW'] * 39.37), 2),
        'snowflag': [bool(x >= 0.5) for x in np.nan_to_num(v['CSNOW'])], 'dbz': r(v['REFC'], 0),
    }


DAILY_TZ = ZoneInfo('America/New_York')   # when the caller gives no usable zone
TZ_NAME = re.compile(r'[A-Za-z_]+/[A-Za-z_/+-]+')


def place_zone(name):
    """ZoneInfo for an IANA name like America/Denver, New York for anything else."""
    if name and len(name) <= 48 and TZ_NAME.fullmatch(name):
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return DAILY_TZ
DAILY_SPAN = {'TMAX': 12, 'TMIN': 12, 'POP12': 12, 'APCP': 6, 'ASNOW': 6, 'FICEAC': 6}   # hours before fh a value covers


def daily_rows(start, hours, v, tz=DAILY_TZ):
    """Daily summary per local calendar date in zone tz (a US zone) from NBM
    point series v {msg: value per forecast hour, NaN where absent}, start =
    run time (epoch). A value goes to the local date at the middle of the
    window it covers (instantaneous ones at their valid time), except the
    overnight TMIN and night PoP, which go to the date their window ends on:
    the morning the low happens (a midpoint of 06z is still the evening
    before west of Eastern time). So a date gets:
      hi        TMAX 12z-00z (8am-8pm EDT, 5am-5pm PDT), deg F
      lo        TMIN 00z-12z, ending that morning (8am EDT, 5am PDT), deg F
      pop_day   12 h PoP (>0.254 mm) 12z-00z, %
      pop_night 12 h PoP 00z-12z, the same night as lo, %
      qpf/snow  6 h amounts summed 06z-06z (2am-2am EDT, 11pm-11pm PDT), in
      wind/gust max of the 6-hourly 10 m speeds, mph; cloud their mean cover, %
      ptype     on days with 0.01 in or more: 'rain', 'snow' or 'ice' (freezing
                rain), whichever has the largest liquid share, snow at 10:1
    Days run from the first with a hi or lo to the last with a hi."""
    days = {}
    for msg, vals in v.items():
        for fh, x in zip(hours, vals):
            if np.isnan(x):
                continue
            key = msg if msg != 'POP12' else 'pop_day' if time.gmtime(start + fh * 3600).tm_hour == 0 else 'pop_night'
            back = 0 if key in ('TMIN', 'pop_night') else DAILY_SPAN.get(msg, 0) / 2
            days.setdefault(datetime.fromtimestamp(start + (fh - back) * 3600, tz).strftime('%Y-%m-%d'), {}).setdefault(key, []).append(float(x))
    rows = []
    for date, d in sorted(days.items()):
        pick = lambda k, f, n=0: None if k not in d else round(f(d[k]), n) if n else round(f(d[k]))
        qpf, snow, ice = pick('APCP', sum, 2), pick('ASNOW', sum, 4), pick('FICEAC', sum, 2)   # mm, m, mm
        ptype = None
        if qpf is not None and qpf >= 0.254:
            shares = {'snow': (snow or 0) * 100, 'ice': ice or 0}   # 1 m of snow ~ 100 mm of water
            shares['rain'] = qpf - sum(shares.values())
            ptype = max(shares, key=shares.get)
        rows.append({'date': date, 'hi': pick('TMAX', lambda a: K_TO_F(max(a))), 'lo': pick('TMIN', lambda a: K_TO_F(min(a))),
                     'pop_day': pick('pop_day', max), 'pop_night': pick('pop_night', max),
                     'qpf': None if qpf is None else round(qpf / 25.4, 2), 'snow': None if snow is None else round(snow * 39.37, 1),
                     'wind': pick('WIND', lambda a: max(a) * 2.23694), 'gust': pick('GUST', lambda a: max(a) * 2.23694),
                     'cloud': pick('TCDC', lambda a: sum(a) / len(a)), 'ptype': ptype})
    first = next((i for i, r in enumerate(rows) if r['hi'] is not None or r['lo'] is not None), len(rows))
    last = max((i for i, r in enumerate(rows) if r['hi'] is not None), default=-1)
    # The last day can end before its 2am-2am total does (a 00z run's final
    # hour is 8pm): a partial total would read as the whole day's, so drop it
    if last >= 0 and len(days[rows[last]['date']].get('APCP', [])) < 4:
        rows[last].update(qpf=None, snow=None, ptype=None)
    return rows[first:last + 1]


def daily_series(date, cycle, lat, lon, tz=DAILY_TZ):
    """NBM daily rows at a point on tz's calendar, or None outside the grid."""
    s = crop_series(load_crop(crop_path('nbm', date, cycle, forecast_tile(lat, lon))), lat, lon)
    return None if s is None else daily_rows(frame_time('nbm', date, cycle, 0), CROPS['nbm'][1], dict(zip(DAILY_MSGS, s)), tz)


def nearest_station(lat, lon):
    """REFS/SREF station key nearest a point, for the plume page link."""
    best, key = None, None
    for k, st in ((read_json(STATIONS_FILE) or {}).get('stations') or {}).items():
        d = (st['lat'] - lat) ** 2 + ((st['lon'] - lon) * math.cos(math.radians(lat))) ** 2
        if best is None or d < best:
            best, key = d, k
    return None if key is None else {'id': key, 'km': round(math.sqrt(best) * 111.2)}


def note_tile(tile):
    """Remember a requested tile so preload keeps its crop current."""
    with _tiles_lock:
        tiles = read_json(FORECAST_TILES_FILE) or {}
        key, now = f'{tile[0]},{tile[1]}', int(time.time())
        if now - tiles.get(key, 0) > 3600:   # write at most hourly per tile
            tiles[key] = now
            # Only the most recent tiles: anyone's request adds one
            write_json(FORECAST_TILES_FILE, dict(sorted(tiles.items(), key=lambda kv: -kv[1])[:FORECAST_TILES_MAX]))


def recent_tiles():
    now = time.time()
    return [tuple(map(int, k.split(','))) for k, t in (read_json(FORECAST_TILES_FILE) or {}).items()
            if now - t < FORECAST_TILE_KEEP_S]


def serving_run(src, tile):
    """(run, building) for a tile: the current run when its crop is cut,
    else the previous run's while this one's is cut in the background
    (building when there is none). (None, False) where the grid does not reach."""
    (date, cycle), prev = forecast_runs(src)
    p = date and run_grid(src, date, cycle)
    if not p or not crop_box(p, tile):
        return None, False
    if os.path.exists(crop_path(src, date, cycle, tile)):
        return (date, cycle), False
    # Own thread: the warm pool may hold a whole run's preload queue
    threading.Thread(target=ensure_crops, args=(src, date, cycle, [tile]), daemon=True).start()
    if prev and os.path.exists(crop_path(src, *prev, tile)):
        return prev, False
    return None, True


_now_pool = ThreadPoolExecutor(max_workers=6)   # RTMA downloads, apart from the preload queue


def now_frame():
    """The RTMA analysis to read "now" from without waiting on S3: the newest
    one once its messages are on disk; until then the latest one that is,
    while the newest downloads in the background (all messages at once). With
    nothing cached at all, the newest is fetched in parallel and waited for."""
    rtma = rtma_frames()
    if not rtma:
        return None
    msgs = [m for n in NOW_FIELDS for m in FIELDS[n]['grib']]
    ready = lambda d, c: all(os.path.exists(msg_path('rtma', d, c, 0, m)) for m in msgs)
    newest = rtma[-1]
    if ready(*newest):
        return ('rtma', *newest, 0)
    fetches = []
    for m in msgs:
        key = ('rtma', *newest, 0, m)
        if key not in _warming:
            _warming.add(key)
            fetches.append(_now_pool.submit(warm_one, key))
    cached = next((f for f in reversed(rtma[:-1]) if ready(*f)), None)
    if cached:
        return ('rtma', *cached, 0)
    for fut in fetches:
        fut.result()
    return ('rtma', *newest, 0)


def forecast(lat, lon, tz=DAILY_TZ):
    """Overview payload: observed now (RTMA), hourly RRFS series, daily NBM
    rows from today on the place's calendar (zone tz), nearest plume station."""
    frame = now_frame()
    now = None
    if frame:
        vals = point_values(frame, lat, lon, None, always=NOW_FIELDS)
        now = {**vals, 'time': frame_time(*frame)} if vals else None
    tile = forecast_tile(lat, lon)
    (hrun, building), (drun, daily_building) = serving_run('rrfs', tile), serving_run('nbm', tile)
    # Tiles the model grids do not reach get observations only, and are not kept
    if hrun or building or drun or daily_building:
        note_tile(tile)
    daily = drun and daily_series(*drun, lat, lon, tz)
    if daily:
        today = datetime.now(tz).strftime('%Y-%m-%d')
        daily = [d for d in daily if d['date'] >= today]
    return {'lat': lat, 'lon': lon, 'now': now, 'hourly': hrun and hourly_series(*hrun, lat, lon), 'building': building,
            'daily': daily or None, 'daily_run': ''.join(drun) if daily else None, 'daily_building': daily_building,
            'station': nearest_station(lat, lon)}


# ============ MRMS radar (observed reflectivity, 2-minute scans) ============
# SeamlessHSR (hybrid scan reflectivity mosaicked over CONUS) from the public
# noaa-mrms-pds bucket: a ~1.2MB gzipped GRIB2 every 2 minutes, published
# ~60s after the scan. The last MRMS_FRAMES scans live in RAM only, never on
# disk: uint8 in 0.5 dBZ steps (0 no echo, 255 no coverage), zlib-compressed
# in row strips so a tile inflates only the rows it spans. MRMS carries no
# precipitation type here: every echo paints the rain colors.
MRMS_URL = os.environ.get('MRMS_URL', 'https://noaa-mrms-pds.s3.amazonaws.com')
MRMS_PRODUCT = 'SeamlessHSR_00.00'
MRMS_STEP = 120
MRMS_LAG = 60                               # seconds after the scan S3 usually has it
MRMS_FRAMES = 60                            # 2 hours listed
MRMS_GRACE = 2                              # older scans kept for pages whose list predates the newest
MRMS_NY, MRMS_NX = 3500, 7000               # 0.01° cells, centers 54.995N..20.005N, 129.995W..60.005W
MRMS_NORTH, MRMS_WEST, MRMS_RES = 55.0, -130.0, 0.01   # outer cell edges
MRMS_STRIP = 50                             # rows per compressed strip
MRMS_MAXZOOM = 11                           # ~29 px per cell at 512px tiles, drawn smooth; the page overzooms past it
MRMS_CROP_MAX = 2048                        # crop texture side cap (pixels)
# Motion: Farneback between each scan and the one MRMS_FLOW_SPAN before it (2-minute
# pairs move under a pixel), on quarter-res images, kept at 1/MRMS_FLOW_RES res.
# Flow units (radar-gl.js reads the same): int8 v, v / MRMS_FLOW_SCALE
# = 0.01° grid cells moved per 2 minutes, x toward east, y toward south; served
# as bytes v + 128 (R = x, G = y). Forward motion: a scan's echo at p came from p - v.
# B = data age in MRMS_AGE_UNIT seconds: each radar updates every 4-10 minutes, so
# the mosaic repeats unchanged data for some 2-minute scans; the page moves each
# scan's echo from its data's time (scan time - age), not the scan time, so a
# repeated scan lines up with the one before it instead of ghosting.
MRMS_FLOW_SPAN = 600
MRMS_FLOW_RES = 8
MRMS_FLOW_SCALE = 8
MRMS_FLOW_MEAN = 1800                       # nowcast motion: mean of the fields over the last 30 minutes
MRMS_FLOW_NY, MRMS_FLOW_NX = 438, 875       # rows padded 3500 -> 3504 so 1/8 cells line up exactly
MRMS_AGE_UNIT = 10
MRMS_AGE_MAX = 36                           # 6 minutes: a radar in precipitation mode updates at least this often,
                                            # so data unchanged for longer is steady, not stale
MRMS_CHANGED = 2                            # mean |flow image change| per 1/8 cell (0.5 dBZ) that is new data
MRMS_KEY_RE = re.compile(r'MRMS_SeamlessHSR_00\.00_(\d{8}-\d{6})\.grib2\.gz')
# The TWC rain table the model radar and the legend use, per 5 dBZ from 0 (clear below 10)
MRMS_PALETTE = np.array([(0, 0, 0, 0) if h is None else (int(h[:2], 16), int(h[2:4], 16), int(h[4:], 16), 255)
                         for h in RAIN_HEX], np.uint8)
MRMS_LUT = np.clip(np.floor((np.arange(256) / 2 - 32) / 5), 0, len(RAIN_HEX) - 1).astype(np.uint8)
MRMS_LUT[MRMS_PALETTE[MRMS_LUT, 3] == 0] = 255   # clear bands use the transparent index
MRMS_LUT[[0, 255]] = 255
MRMS_BAND = np.where(MRMS_PALETTE[:, 3] > 0, np.arange(len(RAIN_HEX)), 255).astype(np.uint8)   # 5 dBZ band -> index
# Snow (NEXRAD's precip type) in the model radar's snow colors, same 5 dBZ bands, indexed after the rain ones
SNOW_PALETTE = np.array([(0, 0, 0, 0) if h is None else (int(h[:2], 16), int(h[2:4], 16), int(h[4:], 16), 255)
                         for h in SNOW_HEX], np.uint8)
SNOW_BAND = np.where(SNOW_PALETTE[:, 3] > 0, np.arange(len(SNOW_HEX)) + len(RAIN_HEX), 255).astype(np.uint8)
TILE_PALETTE = np.vstack([MRMS_PALETTE, SNOW_PALETTE])
_q_band = np.clip(np.floor((np.arange(256) / 2 - 32) / 5), 0, len(RAIN_HEX) - 1).astype(np.int64)
# Texture palette for the page's WebGL radar, indexed by q (0.5 dBZ steps): row 0 rain, row 1 snow
MRMS_PALETTE_PNG = raw_png(np.stack([np.where((MRMS_LUT == 255)[:, None], 0, MRMS_PALETTE[np.minimum(MRMS_LUT, len(RAIN_HEX) - 1)]),
                                     np.where(((np.arange(256) == 0) | (np.arange(256) == 255))[:, None], 0, SNOW_PALETTE[_q_band])])
                           .astype(np.uint8))
# Flow image: dBZ 5..64 as 20..256, weak echo and no coverage as nothing to track
_d = np.arange(256) / 2 - 32
MRMS_FLOW_LUT = np.where((_d >= 5) & (np.arange(256) < 255), np.clip(_d, 0, 63.75) * 4, 0).astype(np.uint8)
_mrms = {}                                  # scan epoch -> [zlib strip]
_mrms_small = {}                            # scan epoch -> zlib quarter-res flow image
_mrms_flow = {}                             # scan epoch -> zlib int8 motion field (MRMS_FLOW_NY, MRMS_FLOW_NX, 2)
_mrms_age = {}                              # scan epoch -> zlib uint8 (MRMS_FLOW_NY, MRMS_FLOW_NX) data age
_mrms_flow_lock = threading.RLock()         # one Farneback at a time (ages are computed under it too)
_mrms_lock = threading.Lock()
_mrms_decode_lock = threading.Lock()        # one ~200MB float64 decode at a time


def mrms_key(t):
    s = time.strftime('%Y%m%d-%H%M%S', time.gmtime(t))
    return f'CONUS/{MRMS_PRODUCT}/{s[:8]}/MRMS_{MRMS_PRODUCT}_{s}.grib2.gz'


def mrms_quantize(v):
    """uint8 in 0.5 dBZ steps, -31.5 (1) to 95 (254); 0 no echo (-99), 255 no coverage (-999 or missing)."""
    f = v.astype(np.float32)                # in place from here: a scan is 24.5M cells
    f *= 2
    f += 64.5                               # (dBZ + 32) * 2, +0.5 so the cast rounds
    echo, covered = f >= -132.5, f >= -935.5   # dBZ -99 is 2*-99+64.5 = -133.5; -999 -> -1933.5
    np.clip(f, 1, 254.5, out=f)
    q = f.astype(np.uint8)
    q[~echo] = 0
    q[~covered] = 255
    return q


def mrms_cells(lat, lon):
    """Nearest grid row/column of each lat/lon (may fall off the grid)."""
    return (np.floor((MRMS_NORTH - lat) / MRMS_RES).astype(np.int64),
            np.floor((lon - MRMS_WEST) / MRMS_RES).astype(np.int64))


def mrms_times():
    with _mrms_lock:
        return sorted(_mrms)


def mrms_small(q):
    """Quarter-res uint8 image of a scan for motion tracking (rows padded to 3504)."""
    img = np.zeros((MRMS_FLOW_NY * MRMS_FLOW_RES, MRMS_NX), np.uint8)
    img[:MRMS_NY] = MRMS_FLOW_LUT[q]
    return cv2.resize(img, (MRMS_NX // 4, MRMS_FLOW_NY * 2), interpolation=cv2.INTER_AREA)


def mrms_store(t, q, small=None):
    strips = [zlib.compress(q[r:r + MRMS_STRIP].tobytes(), 6) for r in range(0, MRMS_NY, MRMS_STRIP)]
    with _mrms_lock:
        _mrms[t] = strips
        if small is not None:
            _mrms_small[t] = zlib.compress(small.tobytes(), 6)
        for old in sorted(_mrms)[:-(MRMS_FRAMES + MRMS_GRACE)]:
            del _mrms[old]
        for d in (_mrms_small, _mrms_flow, _mrms_age):
            for old in [k for k in d if k not in _mrms]:
                del d[old]


def mrms_small_image(z):
    return np.frombuffer(zlib.decompress(z), np.uint8).reshape(MRMS_FLOW_NY * 2, MRMS_NX // 4)


def mrms_age_step(prev_age, a, b):
    """Data age after scan b (a: the scan before): zero where the 1/8 cell changed, else one step older."""
    diff = cv2.resize(cv2.absdiff(a, b), (MRMS_FLOW_NX, MRMS_FLOW_NY), interpolation=cv2.INTER_AREA)
    older = np.minimum(prev_age.astype(np.int16) + MRMS_STEP // MRMS_AGE_UNIT, MRMS_AGE_MAX).astype(np.uint8)
    return np.where(diff >= MRMS_CHANGED, 0, older).astype(np.uint8)


def mrms_age(t):
    """uint8 (MRMS_FLOW_NY, MRMS_FLOW_NX) age of scan t's data in MRMS_AGE_UNIT s. Walks
    forward from the last scan with a known age; unknown (the ring start, or past a
    scan the poller has given up on) is 0."""
    with _mrms_lock:
        done = _mrms_age.get(t)
    if done is not None:                    # no waiting on a Farneback in progress
        return np.frombuffer(zlib.decompress(done), np.uint8).reshape(MRMS_FLOW_NY, MRMS_FLOW_NX)
    with _mrms_flow_lock:
        with _mrms_lock:
            chain = [t]
            while chain[-1] not in _mrms_age and chain[-1] - MRMS_STEP in _mrms_small:
                chain.append(chain[-1] - MRMS_STEP)
            base, oldest = _mrms_age.get(chain[-1]), min(_mrms) if _mrms else t
        age = None
        if base is not None:
            age = np.frombuffer(zlib.decompress(base), np.uint8).reshape(MRMS_FLOW_NY, MRMS_FLOW_NX)
            if chain.pop() == t:
                return age
        for s in reversed(chain):
            with _mrms_lock:
                a, b = _mrms_small.get(s - MRMS_STEP), _mrms_small.get(s)
            if age is not None and a is not None and b is not None:
                age = mrms_age_step(age, mrms_small_image(a), mrms_small_image(b))
            elif s - MRMS_STEP >= oldest and not mrms_gap(s - MRMS_STEP, time.time()):
                age = None                  # a gap mid-ring may still fill (backfill lands newest first)
                continue
            else:
                age = np.zeros((MRMS_FLOW_NY, MRMS_FLOW_NX), np.uint8)
            with _mrms_lock:
                if s in _mrms:
                    _mrms_age[s] = zlib.compress(age.tobytes(), 6)
        return age if age is not None else np.zeros((MRMS_FLOW_NY, MRMS_FLOW_NX), np.uint8)


def mrms_age_view(age, b):
    """Age as served: change is only seen where there is echo, so blocks
    without echo take the age of the echo around them (radar update timing is
    regional), and none far from any echo."""
    echo = cv2.resize((b > 0).astype(np.float32), (MRMS_FLOW_NX, MRMS_FLOW_NY), interpolation=cv2.INTER_AREA) > 0
    w = echo.astype(np.float32)
    k = cv2.GaussianBlur(w, (0, 0), 4)
    near = cv2.GaussianBlur(age * w, (0, 0), 4) / np.maximum(k, 1e-6)
    return np.where(echo, age, np.where(k > 0.02, np.rint(near), 0)).astype(np.uint8)


def mrms_motion(a, b, span=None):
    """Motion from quarter-res image a to b (MRMS_FLOW_SPAN later): int8
    (h/2, w/2, 2) in flow units. span: seconds between the two images' data
    per 1/8 cell, when not MRMS_FLOW_SPAN. Farneback is noise where there is no echo, so
    the field is a normalized convolution weighted by echo: smooth inside
    storms and carried into the gaps around them, so an echo can move into
    empty cells; zero far from any echo."""
    fl = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 4, 15, 3, 5, 1.2, 0)   # quarter px per span
    size = (a.shape[1] // 2, a.shape[0] // 2)
    fl = cv2.resize(fl, size, interpolation=cv2.INTER_AREA)
    wt = cv2.resize(((a > 0) | (b > 0)).astype(np.float32), size, interpolation=cv2.INTER_AREA)
    if span is not None:
        fl *= (MRMS_FLOW_SPAN / span)[..., None]

    def smooth(sigma):
        k = cv2.GaussianBlur(wt, (0, 0), sigma)
        return cv2.GaussianBlur(fl * wt[..., None], (0, 0), sigma) / np.maximum(k, 1e-6)[..., None], k
    fine, kf = smooth(3)                    # ~25 km
    coarse, kc = smooth(20)                 # ~160 km: the flow a storm carries into clear air
    near = np.clip(kf / 0.1, 0, 1)[..., None]
    v = fine * near + coarse * np.clip(kc / 0.02, 0, 1)[..., None] * (1 - near)
    # quarter px per span -> cells per 2 minutes -> flow units
    return np.clip(np.rint(v * 4 * MRMS_STEP / MRMS_FLOW_SPAN * MRMS_FLOW_SCALE), -127, 127).astype(np.int8)


def mrms_flow_field(t):
    """Motion field of scan t (zlib int8); None while the scan MRMS_FLOW_SPAN before it is missing."""
    with _mrms_lock:
        done, a, b = _mrms_flow.get(t), _mrms_small.get(t - MRMS_FLOW_SPAN), _mrms_small.get(t)
    if done is not None or a is None or b is None:
        return done
    with _mrms_flow_lock:
        if t in _mrms_flow:
            return _mrms_flow[t]
        t0 = time.time()
        # the images' data are MRMS_FLOW_SPAN apart less what each had aged
        span = MRMS_FLOW_SPAN + MRMS_AGE_UNIT * (mrms_age(t - MRMS_FLOW_SPAN).astype(np.float32) - mrms_age(t))
        field = zlib.compress(mrms_motion(mrms_small_image(a), mrms_small_image(b), np.maximum(span, 240)).tobytes(), 6)
        with _mrms_lock:
            if t in _mrms:
                _mrms_flow[t] = field
        print(f'[MRMS] {time.strftime("%H:%MZ", time.gmtime(t))} flow {time.time() - t0:.2f}s {len(field) // 1024}KB', flush=True)
        return field


def mrms_flow_array(field):
    return np.frombuffer(zlib.decompress(field), np.int8).reshape(MRMS_FLOW_NY, MRMS_FLOW_NX, 2)


@functools.lru_cache(maxsize=4)
def mrms_mean_flow(t):
    """Nowcast motion at scan t: the mean field over the last MRMS_FLOW_MEAN seconds."""
    fields = [f for s in mrms_times() if t - MRMS_FLOW_MEAN < s <= t and (f := mrms_flow_field(s)) is not None]
    if not fields:
        raise NotPublished
    return zlib.compress(np.rint(np.mean([mrms_flow_array(f) for f in fields], 0, dtype=np.float32)).astype(np.int8).tobytes(), 6)


def mrms_fetch(t):
    """Scan t into the ring; False while S3 does not have it."""
    if t in _mrms:
        return True
    t0 = time.time()
    try:
        gz = http_get(f'{MRMS_URL}/{mrms_key(t)}')
    except urllib.error.HTTPError as err:
        if err.code in (403, 404):
            return False
        raise
    with _mrms_decode_lock:
        t1 = time.time()
        g = ec.codes_new_from_message(gzip.decompress(gz))
        try:
            if (ec.codes_get(g, 'Ni'), ec.codes_get(g, 'Nj')) != (MRMS_NX, MRMS_NY) \
                    or abs(ec.codes_get(g, 'latitudeOfFirstGridPointInDegrees') - 54.995) > 1e-3:
                raise RuntimeError(f'MRMS grid changed: {mrms_key(t)}')
            ec.codes_set(g, 'missingValue', -9999.0)
            q = mrms_quantize(ec.codes_get_values(g).reshape(MRMS_NY, MRMS_NX))
        finally:
            ec.codes_release(g)
    t2 = time.time()
    mrms_store(t, q, mrms_small(q))
    print(f'[MRMS] {time.strftime("%H:%MZ", time.gmtime(t))} +{t2 - t:.0f}s: fetch {t1 - t0:.2f}s '
          f'decode {t2 - t1:.2f}s pack {time.time() - t2:.2f}s', flush=True)
    return True


def mrms_backfill():
    """Fetch every scan S3 lists newer than the ring's newest, up to MRMS_FRAMES back."""
    times = mrms_times()
    since = max(times[-1] if times else 0, time.time() - MRMS_FRAMES * MRMS_STEP)
    listed = []
    for day in sorted({time.strftime('%Y%m%d', time.gmtime(d)) for d in (since, time.time())}):
        xml = http_get(f'{MRMS_URL}/?list-type=2&prefix=CONUS/{MRMS_PRODUCT}/{day}/'
                       f'&start-after={mrms_key(since)}').decode()
        listed += [calendar.timegm(time.strptime(s, '%Y%m%d-%H%M%S')) for s in MRMS_KEY_RE.findall(xml)]
    # Newest first: after a restart the ring's newest frame is current within seconds
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(mrms_fetch, sorted((t for t in set(listed) if t > since), reverse=True)[:MRMS_FRAMES]))


def mrms_gap(want, now):
    """True once scan want is overdue past any normal delay (p95 ~92s): S3
    skipped it, or an outage. A 403/404 before then is just not published yet."""
    return now - want > MRMS_LAG + MRMS_STEP


def mrms_next(want, newest):
    """Scan to poll after giving up on want: past it, and past anything a backfill found."""
    return int(max(want, newest or 0)) + MRMS_STEP


def mrms_backfill_safe():
    try:
        mrms_backfill()
    except Exception as err:  # noqa: BLE001 - keep polling through S3 trouble
        print(f'[MRMS] backfill: {err}', flush=True)
    times = mrms_times()
    try:
        for t in times:                     # backfill lands newest first: pairs complete at the end
            mrms_flow_field(t)
    except Exception as err:  # noqa: BLE001
        print(f'[MRMS] flow: {err}', flush=True)
    return times[-1] if times else None


def mrms_poller():
    """Each scan MRMS_LAG after its time, retrying every 10s. A scan still
    missing once overdue (mrms_gap) is a gap: catch up from the listing and
    move past it, so one skipped scan never holds back the newer ones."""
    newest = mrms_backfill_safe()
    want = mrms_next(newest or time.time() // MRMS_STEP * MRMS_STEP - MRMS_STEP, None)
    while True:
        # a stall (host suspend, clock jump) older than the ring: jump to the present in one catch-up
        if time.time() - want > MRMS_FRAMES * MRMS_STEP:
            want = mrms_next(time.time() // MRMS_STEP * MRMS_STEP - MRMS_FRAMES * MRMS_STEP, mrms_backfill_safe())
        wait = want + MRMS_LAG - time.time()
        if wait > 0:
            time.sleep(wait)
        try:
            ok = mrms_fetch(want)
        except Exception as err:  # noqa: BLE001
            print(f'[MRMS] {mrms_key(want)}: {err}', flush=True)
            ok = False
        if ok:
            try:
                mrms_flow_field(want)
            except Exception as err:  # noqa: BLE001 - the page falls back to a plain cross-fade
                print(f'[MRMS] flow {want}: {err}', flush=True)
            want += MRMS_STEP
        elif mrms_gap(want, time.time()):
            print(f'[MRMS] {mrms_key(want)}: missing, skipping', flush=True)
            want = mrms_next(want, mrms_backfill_safe())
        else:
            time.sleep(10)


def mrms_rows(strips, r0, r1):
    """Grid rows r0..r1 (inclusive) inflated from their strips; also the first row's offset."""
    s0, s1 = r0 // MRMS_STRIP, r1 // MRMS_STRIP
    return np.frombuffer(b''.join(zlib.decompress(strips[k]) for k in range(s0, s1 + 1)),
                         np.uint8).reshape(-1, MRMS_NX), s0 * MRMS_STRIP


def mrms_dbz(block, fr, fc):
    """Reflectivity per pixel at fractional cell-center coordinates (fr rows, fc
    columns of block, 1-D each, in range): bilinear in dBZ, with no echo as -32 dBZ
    so edges taper and no coverage left out of the weights; also the covered weight
    (clear once no coverage outweighs coverage)."""
    r = np.clip(np.floor(fr).astype(np.int64), 0, block.shape[0] - 1)
    c = np.clip(np.floor(fc).astype(np.int64), 0, block.shape[1] - 1)
    wr, wc = np.clip(fr - r, 0, 1).astype(np.float32), np.clip(fc - c, 0, 1).astype(np.float32)
    r1, c1 = np.minimum(r + 1, block.shape[0] - 1), np.minimum(c + 1, block.shape[1] - 1)
    num = np.zeros((len(fr), len(fc)), np.float32)
    den = np.zeros_like(num)
    for rr, fy in ((r, 1 - wr), (r1, wr)):
        for cc, fx in ((c, 1 - wc), (c1, wc)):
            q = block[np.ix_(rr, cc)]
            w = np.outer(fy, fx) * (q != 255)
            num += w * (q * np.float32(0.5) - 32)
            den += w
    return num / np.maximum(den, 1e-6), den


def mrms_bands(dbz, den, snow=None):
    """Palette index (TILE_PALETTE) of each pixel's 5 dBZ band; 255 clear or uncovered."""
    # +1e-4: an exact band edge (30 dBZ) must not land a hair under it in float32
    band = np.clip(np.floor(dbz / 5 + 1e-4), 0, len(RAIN_HEX) - 1).astype(np.int64)
    idx = MRMS_BAND[band] if snow is None else np.where(snow, SNOW_BAND[band], MRMS_BAND[band])
    return np.where(den >= 0.5, idx, 255).astype(np.uint8)


def mrms_bilinear(block, fr, fc):
    """Palette index of the bilinear reflectivity (mrms_dbz) per pixel."""
    return mrms_bands(*mrms_dbz(block, fr, fc))


@functools.lru_cache(maxsize=2048)          # 1-20KB each
def mrms_tile(t, z, x, y, nx=None):
    """Web-mercator tile of scan t, smooth: bilinear in dBZ between cell centers.
    nx: the NEXRAD frame's rev, drawn over MRMS where it has coverage (the rev only
    keys the cache). A scan that left the ring still serves its cached tiles until they age out of the LRU."""
    with _mrms_lock:
        strips = _mrms.get(t)
    if strips is None:
        raise NotPublished
    s = (np.arange(FIELD_TILE) + 0.5) / FIELD_TILE
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y + s) / 2 ** z))))
    lon = (x + s) / 2 ** z * 360 - 180
    fr, fc = (MRMS_NORTH - lat) / MRMS_RES, (lon - MRMS_WEST) / MRMS_RES
    ri, ci = np.flatnonzero((fr >= 0) & (fr < MRMS_NY)), np.flatnonzero((fc >= 0) & (fc < MRMS_NX))
    px = np.full((FIELD_TILE, FIELD_TILE), 255, np.uint8)
    if len(ri) and len(ci):
        rc = fr[ri] - 0.5                   # cell centers sit at +0.5
        block, base = mrms_rows(strips, max(int(np.floor(rc.min())), 0), min(int(np.floor(rc.max())) + 1, MRMS_NY - 1))
        dbz, den = mrms_dbz(block, rc - base, fc[ci] - 0.5)
        snow = None
        if nx is not None and z >= NX_TILE_MINZOOM:   # zoomed out, a tile spans too many NX cells
            got = nx_tile_sample(t, fr[ri] * NX_SUB - 0.5, fc[ci] * NX_SUB - 0.5)
            if got is not None:
                ndbz, nden, cov, snow = got
                both, only = (den >= 0.5) & (nden >= 0.5), (den < 0.5) & (nden >= 0.5)
                dbz = np.where(both, dbz + (ndbz - dbz) * cov, np.where(only, ndbz, dbz))
                den = np.maximum(den, nden)
                snow &= nden >= 0.5
        px[np.ix_(ri, ci)] = mrms_bands(dbz, den, snow)
    return indexed_png(px, TILE_PALETTE)


def mrms_crop_box(w, s, e, n, step=1):
    """Grid cell ranges (r0, r1, c0, c1) and step of a lat/lon box crop, or None
    off the grid. Snapped outward to whole flow texels (MRMS_FLOW_RES * step
    cells) so the flow crop of the same box lines up exactly, clamped to the
    grid rounded out the same way (the page masks the no-coverage padding),
    and the step raised until both sides fit MRMS_CROP_MAX pixels."""
    step = max(1, int(step))
    while True:
        u = MRMS_FLOW_RES * step
        out = lambda v, lo, hi: min(max(v, lo), hi) * u
        r0 = out(math.floor((MRMS_NORTH - n) / MRMS_RES / u + 1e-6), 0, math.ceil(MRMS_NY / u))
        r1 = out(math.ceil((MRMS_NORTH - s) / MRMS_RES / u - 1e-6), 0, math.ceil(MRMS_NY / u))
        c0 = out(math.floor((w - MRMS_WEST) / MRMS_RES / u + 1e-6), 0, math.ceil(MRMS_NX / u))
        c1 = out(math.ceil((e - MRMS_WEST) / MRMS_RES / u - 1e-6), 0, math.ceil(MRMS_NX / u))
        if r1 <= r0 or c1 <= c0:
            return None
        if max(r1 - r0, c1 - c0) <= MRMS_CROP_MAX * step:
            return r0, r1, c0, c1, step
        step += 1


def mrms_crop_bounds(r0, r1, c0, c1, step):
    """X-Crop header: west,south,east,north (outer cell edges, degrees),step."""
    return (f'{MRMS_WEST + c0 * MRMS_RES:.2f},{MRMS_NORTH - r1 * MRMS_RES:.2f},'
            f'{MRMS_WEST + c1 * MRMS_RES:.2f},{MRMS_NORTH - r0 * MRMS_RES:.2f},{step}')


def mrms_crop_query(q):
    """(w, s, e, n, step) from a crop query, or None if invalid."""
    try:
        w, s, e, n = (float(q[k][0]) for k in ('w', 's', 'e', 'n'))
        step = int(q.get('step', ['1'])[0])
    except (KeyError, ValueError):
        return None
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90 and 1 <= step <= 64):
        return None
    return w, s, e, n, step


@functools.lru_cache(maxsize=180)           # a view's loop; ~2-400KB each
def mrms_crop(t, r0, r1, c0, c1, step):
    """Gray PNG of raw scan values (q: 0 no echo, 255 no coverage), a cell every
    step, rows north to south; padding past the grid is no coverage."""
    with _mrms_lock:
        strips = _mrms.get(t)
    if strips is None:
        raise NotPublished
    rows, cols = np.arange(r0 + step // 2, r1, step), np.arange(c0 + step // 2, c1, step)
    ri, ci = np.flatnonzero(rows < MRMS_NY), np.flatnonzero(cols < MRMS_NX)
    px = np.full((len(rows), len(cols)), 255, np.uint8)
    if len(ri) and len(ci):
        block, base = mrms_rows(strips, rows[ri[0]], rows[ri[-1]])
        px[np.ix_(ri, ci)] = block[np.ix_(rows[ri] - base, cols[ci])]
    return raw_png(px)


@functools.lru_cache(maxsize=180)
def mrms_flow_crop(t, r0, r1, c0, c1, step, mean):
    """RGB PNG of scan t's motion (mean: the nowcast's) over the crop box, one
    texel per MRMS_FLOW_RES x MRMS_FLOW_RES crop pixels: R x, G y as flow units + 128,
    B scan t's data age."""
    if mean:
        field = mrms_mean_flow(t)
    else:
        # The oldest scans have no partner 10 minutes back: the nearest scan's motion stands in
        near = sorted((abs(s - t), s) for s in mrms_times() if abs(s - t) <= MRMS_FLOW_SPAN)
        field = next((f for _, s in near if (f := mrms_flow_field(s)) is not None), None)
    if field is None:
        raise NotPublished
    f = mrms_flow_array(field)
    u = MRMS_FLOW_RES
    rows = np.minimum(np.arange(r0 // u + step // 2, r1 // u, step), MRMS_FLOW_NY - 1)
    cols = np.minimum(np.arange(c0 // u + step // 2, c1 // u, step), MRMS_FLOW_NX - 1)
    v = f[np.ix_(rows, cols)].astype(np.int16) + 128
    with _mrms_lock:
        small = _mrms_small.get(t)
    age = mrms_age_view(mrms_age(t), mrms_small_image(small)) if small else np.zeros((MRMS_FLOW_NY, MRMS_FLOW_NX), np.uint8)
    return raw_png(np.dstack([v, age[np.ix_(rows, cols)]]).astype(np.uint8))


# ============ NEXRAD composite (WSR-88D Level III, 250 m) ============
# Each radar's lowest scan (0.5°) from the public unidata-nexrad-level3 bucket:
# N0B reflectivity (0.5° x 250 m), N0C correlation coefficient and N0H
# hydrometeor class (1° x 250 m) under the same key suffix, ~80 s after the
# scan, a scan every 4-6 minutes. RAM only, like MRMS. Each scan is cleaned on
# its polar grid (low CC or classed biological/clutter is not precipitation),
# then mapped onto a 0.0025° lat/lon lattice nested 4:1 in MRMS's (same
# origin), where overlapping radars blend by beam height. A frame every
# MRMS_STEP (the MRMS scan times) moves each radar's nearest scan to the frame
# time along the MRMS motion, so a frame is one moment rather than radars
# caught 0-5 minutes apart. The NYC radars are always on; others follow the
# views pages ask crops for, up to NX_CAP, and drop after NX_IDLE.
NX_URL = os.environ.get('NEXRAD_URL', 'https://unidata-nexrad-level3.s3.amazonaws.com')
# CONUS WSR-88Ds: id:lat:lon:height (feet above sea level), from the products' own headers
NX_SITES = {s: (float(la), float(lo), float(h) * 0.3048) for s, la, lo, h in (e.split(':') for e in '''
    ABR:45.456:-98.413:1383 ABX:35.150:-106.824:5951 AKQ:36.984:-77.008:254 AMA:35.233:-101.709:3703 AMX:25.611:-80.413:111 APX:44.906:-84.720:1561
    ARX:43.823:-91.191:1357 ATX:48.195:-122.496:642 BBX:39.496:-121.632:221 BGM:42.200:-75.985:1703 BHX:40.499:-124.292:2516 BIS:46.771:-100.760:1755
    BLX:45.854:-108.607:3703 BMX:33.172:-86.770:759 BOX:41.956:-71.137:231 BRO:25.916:-97.419:87 BUF:42.949:-78.737:790 BYX:24.597:-81.703:89
    CAE:33.949:-81.119:344 CBW:46.039:-67.806:859 CBX:43.490:-116.236:3171 CCX:40.923:-78.004:2486 CLE:41.413:-81.860:860 CLX:32.655:-81.042:228
    CRP:27.784:-97.511:142 CXX:44.511:-73.166:431 CYS:41.152:-104.806:6192 DAX:38.501:-121.678:144 DDC:37.761:-99.969:2671 DFX:29.273:-100.280:1196
    DGX:32.280:-89.984:609 DIX:39.947:-74.411:230 DLH:46.837:-92.210:1542 DMX:41.731:-93.723:1094 DOX:38.826:-75.440:163 DTX:42.700:-83.472:1216
    DVN:41.612:-90.581:851 DYX:32.538:-99.254:1581 EAX:38.810:-94.264:1092 EMX:31.894:-110.630:5319 ENX:42.586:-74.064:1934 EOX:31.460:-85.459:537
    EPZ:31.873:-106.698:4218 ESX:35.701:-114.891:4948 EVX:30.565:-85.922:222 EWX:29.704:-98.029:766 EYX:35.098:-117.561:2873 FCX:37.024:-80.274:2965
    FDR:34.362:-98.977:1315 FDX:34.634:-103.619:4698 FFC:33.363:-84.566:972 FSD:43.588:-96.729:1495 FSX:34.574:-111.198:7514 FTG:39.786:-104.546:5610
    FWS:32.573:-97.303:776 GGW:48.206:-106.625:2384 GJX:39.062:-108.214:10100 GLD:39.367:-101.700:3717 GRB:44.499:-88.111:822 GRK:30.722:-97.383:602
    GRR:42.894:-85.545:875 GSP:34.883:-82.220:1068 GWX:33.897:-88.329:589 GYX:43.891:-70.256:473 HDC:30.519:-90.407:157 HDX:33.077:-106.120:4270
    HGX:29.472:-95.079:115 HNX:36.314:-119.632:340 HPX:36.737:-87.285:613 HTX:34.931:-86.084:1859 ICT:37.654:-97.443:1400 ICX:37.591:-112.862:10756
    ILN:39.420:-83.822:1170 ILX:40.150:-89.337:730 IND:39.708:-86.280:887 INX:36.175:-95.564:749 IWA:33.289:-111.670:1426 IWX:41.359:-85.700:1055
    JAX:30.485:-81.702:159 JGX:32.675:-83.351:618 JKL:37.591:-83.313:1461 LBB:33.654:-101.814:3378 LCH:30.125:-93.216:136 LGX:47.116:-124.107:366
    LNX:41.958:-100.576:3112 LOT:41.604:-88.085:760 LRX:40.740:-116.803:6895 LSX:38.699:-90.683:721 LTX:33.989:-78.429:145 LVX:37.975:-85.944:833
    LWX:38.976:-77.487:404 LZK:34.836:-92.262:649 MAF:31.943:-102.189:2961 MAX:42.081:-122.717:7561 MBX:48.393:-100.864:1590 MHX:34.776:-76.876:144
    MKX:42.968:-88.551:1022 MLB:28.113:-80.654:149 MOB:30.679:-88.240:289 MPX:44.849:-93.565:1101 MQT:46.531:-87.548:1525 MRX:36.168:-83.402:1434
    MSX:47.041:-113.986:7978 MTX:41.263:-112.448:6593 MUX:37.155:-121.898:3550 MVX:47.528:-97.325:1083 MXX:32.537:-85.790:560 NKX:32.919:-117.041:1052
    NQA:35.345:-89.873:435 OAX:41.320:-96.367:1262 OHX:36.247:-86.563:676 OKX:40.865:-72.864:198 OTX:47.681:-117.626:2449 PAH:37.068:-88.772:505
    PBZ:40.532:-80.218:1266 PDT:45.691:-118.853:1580 POE:31.155:-92.976:472 PUX:38.460:-104.181:5363 RAX:35.665:-78.490:461 RGX:39.754:-119.462:8396
    RIW:43.066:-108.477:5633 RLX:38.311:-81.723:1212 RTX:45.715:-122.965:1728 SFX:43.106:-112.686:4539 SGF:37.235:-93.400:1375 SHV:32.451:-93.841:386
    SJT:31.371:-100.492:2004 SOX:33.818:-117.636:3105 SRX:35.290:-94.362:737 TBW:27.705:-82.402:122 TFX:47.460:-111.385:3804 TLH:30.398:-84.329:176
    TLX:35.333:-97.278:1277 TWX:38.997:-96.232:1415 TYX:43.756:-75.680:1960 UDX:44.125:-102.830:3194 UEX:40.321:-98.442:2057 VAX:30.890:-83.002:330
    VBX:34.839:-120.398:1354 VNX:36.741:-98.128:1258 VTX:34.412:-119.179:2807 VWX:38.260:-87.724:625 YUX:32.495:-114.656:239
'''.split())}
NX_DEFAULT = ('OKX', 'DIX', 'ENX', 'BGM', 'BOX', 'DOX')   # within ~275 km of NYC: never idle out
NX_CAP = 12                                 # active radars at most (CPU/RAM bound)
NX_VIEW = 6                                 # radars one view activates, nearest its center first
NX_IDLE = 1800                              # an on-demand radar nobody has viewed this long drops
NX_POLL = 30                                # seconds between bucket listings
NX_RES = 0.0025                             # degrees per cell; MRMS cell = NX_SUB x NX_SUB cells
NX_SUB = 4
NX_BLOCK = 400                              # frames are stored in 1° blocks (NX_BLOCK cells square)
NX_GATE = 250.0                             # m, Level III gate spacing
NX_RANGE = 230e3                            # m: past this the 0.5° beam is ~5 km up
NX_FADE = 30e3                              # coverage ramps in over the outer 30 km (MRMS shows through)
NX_SMOOTH = 1.0                             # cells: Gaussian sigma on the composite (gate noise), 0 for raw gates
NX_FILL_W = 1e-30                           # MRMS's weight in the blend: only where no radar here has data
NX_BEAM_H = 400.0                           # m: overlap weight exp(-beam height / this) - the lowest beam wins, seams blend
NX_CLASS_H = 2000.0                         # m above the radar: higher beams are above the melting layer in warm air, no type
NX_MAX_AGE = 600                            # a radar's scan further than this from a frame is not used in it
NX_KEEP = MRMS_FRAMES * MRMS_STEP + 1200    # scans kept (frames rebuild when a nearer scan or a new radar arrives)
NX_LAG = 60                                 # frame T exists from T + NX_LAG, like the MRMS scan
NX_ASIDE = 180                              # N0C/N0H not up this long after N0B: clean without them
NX_CROP_MAX = 2048
NX_TILE_MINZOOM = 6                         # raster tiles carry NEXRAD from here (radar-gl NX_MINZOOM)
NX_HOLD = 5 * NX_POLL                       # a radar viewed this recently is never evicted for another view
NX_MAXZOOM = 11                             # raster fallback tiles (the GPU layer samples crops to ~z13)
# QC: echo under NX_QC_DBZ with (smoothed) CC under NX_QC_CC, or classed biological
# or clutter, is removed; stronger echo always stays (hail and melting snow have low CC).
# Weak echo with no CC at all (below the CC SNR threshold) must be NX_QC_BARE dBZ to stay.
NX_QC_DBZ = 40.0
NX_QC_CC = 0.85
NX_QC_BARE = 15.0
NX_SPECKLE = 7                              # echo gates in the 5x5 around a gate for it to stay
NX_RAINING, NX_RAINING_BOX = 0.3, (31, 31)  # precipitation around a removed gate (gates x radials): it is unknown, not clear
NX_NEAR = 12                                # gates (3 km) around the radar with no usable data: the neighbors fill them
NX_BLOCKED_DB = 5.0                         # a radial this much weaker than its neighbors is blocked
NX_GAP = 4.0                                # degrees: nx_grid bridges a gap in the radials up to this (OKX blockage: 5-6 radials, a 3-3.5° gap)
NX_BI, NX_GC = 10, 20                       # N0H class codes: biological, ground clutter/AP
NX_SNOW, NX_MIX = (30, 40), (50,)           # ice crystals, dry snow; wet snow
NX_KEY_RE = re.compile(r'<Key>([A-Z]{3})_N0B_(\d{4}_\d\d_\d\d_\d\d_\d\d_\d\d)</Key>')
EARTH_R, EARTH_K = 6371e3, 4 / 3            # effective earth radius model for the beam
_nx_active = {s: math.inf for s in NX_DEFAULT}   # site -> last viewed (epoch); defaults never idle out
_nx_scans = {}                              # site -> {scan epoch: zlib uint16 site grid (q | class << 8)}
_nx_last = {}                               # site -> newest key suffix ingested
_nx_frames = {}                             # frame epoch -> {'blocks': {(br, bc): zlib}, 'sig': {...}, 'rev': int, 'snow': bool}
_nx_rev = [int(time.time())]                # revs never repeat across restarts (crop URLs are cached by rev)
_nx_lock = threading.Lock()
_nx_build_lock = threading.Lock()           # one ingest/build pass at a time
_nx_wake = threading.Event()                # a new radar was activated: poll now


def nx_decode(raw):
    """A Level III radial product (packet 16, bzip2 symbology): code, radar lat/lon,
    height (m), scan epoch, elevation, the threshold halfwords' bytes, radial start
    azimuths and widths (degrees) and data levels (radials, bins) uint8."""
    i = raw.index(b'\r\r\n', raw.index(b'\r\r\n') + 3) + 3   # past the WMO and AWIPS header lines
    hw = lambda k, f='>h': struct.unpack_from(f, raw, i + 18 + 2 * (k - 10))[0]   # description block halfword (ICD numbering)
    sym = raw[i + 120:]
    if hw(51) == 1:
        sym = bz2.decompress(sym)
    packet, _, nbins, _, _, _, nrad = struct.unpack_from('>7h', sym, 16)
    if packet != 16:
        raise ValueError(f'packet {packet}, not digital radial data')
    az, width = np.empty(nrad, np.float32), np.empty(nrad, np.float32)
    data = np.zeros((nrad, nbins), np.uint8)
    o = 30
    for r in range(nrad):
        nb, a, d = struct.unpack_from('>hhh', sym, o)
        az[r], width[r] = a / 10, d / 10
        n = min(nb, nbins)
        data[r, :n] = np.frombuffer(sym, np.uint8, n, o + 6)
        o += 6 + nb + (nb & 1)
    return {'code': hw(16), 'lat': hw(11, '>i') / 1000, 'lon': hw(13, '>i') / 1000, 'height': hw(15) * 0.3048,
            't': (hw(21) - 1) * 86400 + hw(22, '>i'), 'elev': hw(30) / 10,
            'thr': raw[i + 60:i + 92], 'az': az, 'width': width, 'data': data}


def nx_radials(p):
    """Radial index of each 0.1° of azimuth (3600) in product p: its radials start
    anywhere and are not all the same width (1° products run 0.9-1.1)."""
    lut = np.zeros(3600, np.int32)
    for r in np.argsort(p['width'])[::-1]:  # narrow radials last, so none is swallowed by a wide neighbor
        a0 = int(round(p['az'][r] * 10))
        lut[np.arange(a0, a0 + max(int(round(p['width'][r] * 10)), 1)) % 3600] = r
    return lut


def nx_q_levels(b):
    """N0B data level -> q (MRMS quantization: (dBZ + 32) * 2, 0 no echo); levels 0-1 are below threshold / range folded."""
    lo, inc = struct.unpack('>hh', b['thr'][:4])
    n = np.arange(256)
    q = np.clip(np.rint((lo / 10 + (n - 2) * inc / 10 + 32) * 2), 1, 254)
    return np.where(n >= 2, q, 0).astype(np.uint8)


def nx_cc_levels(c):
    """N0C data level -> correlation coefficient, NaN below threshold / range folded."""
    scale, offset = struct.unpack('>ff', c['thr'][:8])
    n = np.arange(256, dtype=np.float32)
    return np.where(n >= 2, (n - offset) / scale, np.nan).astype(np.float32)


def nx_beam(r, elev):
    """Beam center height above the radar (m) and ground distance (m) at slant range r, 4/3 earth."""
    re, th = EARTH_R * EARTH_K, np.radians(elev)
    h = np.sqrt(r * r + re * re + 2 * r * re * np.sin(th)) - re
    return h, re * np.arcsin(r * np.cos(th) / (re + h))


def nx_clean(b, c=None, h=None):
    """Cleaned reflectivity q and precip class (0 rain, 1 snow, 2 mix) on N0B's polar
    grid out to NX_RANGE, and the radials to keep (blocked ones dropped: nx_grid bridges
    a narrow gap from the radials either side, a wide one is left to other radars; left
    as unknown, it filled from far radars' higher beams, a bright stripe in stratiform).
    c, h: N0C and N0H of the same scan, when there are any."""
    gates = int(NX_RANGE // NX_GATE)
    q = nx_q_levels(b)[b['data'][:, :gates]]
    q = np.pad(q, ((0, 0), (0, gates - q.shape[1])))
    at = np.floor((b['az'] + b['width'] / 2) * 10).astype(np.int64) % 3600   # N0B radial centers, 0.1°

    def on_b(p, fill):                      # a 1° product's radials under N0B's
        d = p['data'][nx_radials(p)[at], :gates]
        return np.pad(d, ((0, 0), (0, gates - d.shape[1])), constant_values=fill)
    echo = q > 0
    dbz = q * np.float32(0.5) - 32
    weak = echo & (dbz < NX_QC_DBZ)
    bad = np.zeros_like(echo)
    if c is not None:
        cc = nx_cc_levels(c)[on_b(c, 0)]
        known = ~np.isnan(cc)
        # 3x3 mean of the known CC: single noisy gates at storm edges must not punch holes
        n = cv2.blur(known.astype(np.float32), (3, 3))
        cc_s = cv2.blur(np.where(known, cc, 0).astype(np.float32), (3, 3)) / np.maximum(n, 1e-6)
        bad |= weak & (n > 0) & (cc_s < NX_QC_CC)
        bad |= echo & (n == 0) & (dbz < NX_QC_BARE)
    cls = np.zeros(q.shape, np.uint8)
    if h is not None:
        hc = on_b(h, 0)
        bad |= weak & ((hc == NX_BI) | (hc == NX_GC))
        cls[np.isin(hc, NX_SNOW)] = 1
        cls[np.isin(hc, NX_MIX)] = 2
        # beyond this height the class is aloft, not what reaches the ground
        cls[:, nx_beam((np.arange(gates) + 0.5) * NX_GATE, b['elev'])[0] > NX_CLASS_H] = 0
    # Removed echo where it is raining around (clutter, birds in rain: a hole the filter
    # punched) is unknown, not clear: other radars, or MRMS, fill it. Removed echo out in
    # clear air (birds, insects) is clear.
    q[:, :NX_NEAR] = 0                      # the radar's own first gates: clutter-filtered, never data
    ok = ~bad
    ok[:, :NX_NEAR] = False
    met = (echo & ok).astype(np.float32)
    # precipitation makes up NX_RAINING of the usable gates around, and a third of that of all of them
    around = cv2.boxFilter(met, -1, NX_RAINING_BOX)
    raining = (around >= NX_RAINING * cv2.boxFilter(ok.astype(np.float32), -1, NX_RAINING_BOX)) & (around >= NX_RAINING / 3)
    q[bad] = np.where(raining, 255, 0)[bad]
    q[:, :NX_NEAR] = 255
    # speckle: lone gates and thin sprays in clear air are noise, not precipitation
    some = (q > 0).astype(np.float32)       # echo or unknown
    q[(q < 255) & (cv2.boxFilter(some, -1, (5, 5), normalize=False) < NX_SPECKLE)] = 0
    cls[(q == 0) | (q == 255)] = 0
    return q, cls, ~nx_blocked(q, b['az'] + b['width'] / 2)


def nx_blocked(q, az):
    """Radials a beam blockage (a tower, a ridge) leaves NX_BLOCKED_DB weaker than the
    radials around them, judged on their echo from 5-100 km: other radars fill them."""
    # ponytail: judged per scan, so a scan with no echo in 5-100 km flags nothing and a lone shower
    # there reads weak until the next one; a sticky per-site set of blocked azimuths if that shows
    echo = (q > 0) & (q < 255)
    band = slice(20, 400)
    d = np.where(echo[:, band], q[:, band] * np.float32(0.5) - 32, 0)
    n = echo[:, band].sum(1)
    mean = np.where(n >= 40, d.sum(1) / np.maximum(n, 1), np.nan)
    order = np.argsort(az)
    m = mean[order]
    k = len(m)
    w = max(1, round(k / 120))              # neighbors 2-6° each side: a blockage is 1-2° wide
    offs = np.array([j for j in range(-2 * w, 2 * w + 1) if abs(j) > w // 2])
    near = m[(np.arange(k)[:, None] + offs) % k]
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)   # radials with no echo around them: NaN, not blocked
        ref = np.nanmedian(near, 1)
    blocked = np.zeros(len(q), bool)
    blocked[order] = (ref - m) > NX_BLOCKED_DB
    return blocked


def nx_box(site):
    """(r0, r1, c0, c1) NX lattice cells covering a radar's range, snapped to MRMS cells."""
    lat, lon, _ = NX_SITES[site]
    dlat = NX_RANGE / (EARTH_R * math.pi / 180) + 0.01
    dlon = dlat / math.cos(math.radians(abs(lat) + dlat))
    snap = lambda v, up: (math.ceil(v / NX_SUB) if up else math.floor(v / NX_SUB)) * NX_SUB
    return (snap((MRMS_NORTH - lat - dlat) / NX_RES, False), snap((MRMS_NORTH - lat + dlat) / NX_RES, True),
            snap((lon - dlon - MRMS_WEST) / NX_RES, False), snap((lon + dlon - MRMS_WEST) / NX_RES, True))


def nx_polar_coords(site, lat, lon):
    """Ground distance (m) and azimuth (degrees) from a radar to lat/lon (float32,
    broadcast: a column of latitudes and a row of longitudes make the full grid)."""
    la0, lo0, _ = NX_SITES[site]
    p0, p1 = math.radians(la0), np.radians(lat).astype(np.float32)
    dl = np.radians(lon - lo0).astype(np.float32)
    sp, cp, cd = np.sin(p1), np.cos(p1), np.cos(dl)
    cosc = np.clip(math.sin(p0) * sp + math.cos(p0) * cp * cd, -1, 1)
    az = np.degrees(np.arctan2(np.sin(dl) * cp, math.cos(p0) * sp - math.sin(p0) * cp * cd))
    return np.float32(EARTH_R) * np.arccos(cosc), az % 360


def nx_grid(site, centers, elev, v):
    """A cleaned polar scan v (radials, gates; uint16 q | class << 8) on the radar's box
    of the NX lattice, 255 past range: bilinear in dBZ between the nearest two radials
    and gates (no echo as -32, unknown left out, as the tiles do), so gate edges (800 m
    across at 100 km) do not show as steps; class from the nearest gate.
    centers: the radials' center azimuths (degrees)."""
    r0, r1, c0, c1 = nx_box(site)
    lat = (MRMS_NORTH - (np.arange(r0, r1) + 0.5) * NX_RES)[:, None]
    lon = (MRMS_WEST + (np.arange(c0, c1) + 0.5) * NX_RES)[None, :]
    s, az = nx_polar_coords(site, lat, lon)
    gates = v.shape[1]
    ground = nx_beam((np.arange(gates) + 0.5) * NX_GATE, elev)[1].astype(np.float32)
    g = np.interp(s, ground, np.arange(gates, dtype=np.float32)).astype(np.float32)   # fractional gate
    inside = s < ground[-1] + NX_GATE / 2
    order = np.argsort(centers)
    j = np.searchsorted(centers[order], az)
    i0, i1 = order[(j - 1) % len(order)], order[j % len(order)]
    span = (centers[i1] - centers[i0]) % 360
    fa = (((az - centers[i0]) % 360) / np.maximum(span, 1e-6)).astype(np.float32)
    g0 = np.clip(np.floor(g).astype(np.int32), 0, gates - 1)
    g1 = np.minimum(g0 + 1, gates - 1)
    fg = np.clip(g - g0, 0, 1)
    q = (v & 255).astype(np.uint8)
    dbz = np.where(q == 0, -32, q * np.float32(0.5) - 32).astype(np.float32)
    ok = (q != 255).astype(np.float32)
    num = np.zeros(s.shape, np.float32)
    den = np.zeros(s.shape, np.float32)
    for rad, wa in ((i0, 1 - fa), (i1, fa)):
        for gate, wg in ((g0, 1 - fg), (g1, fg)):
            w = wa * wg * ok[rad, gate]
            num += w * dbz[rad, gate]
            den += w
    out = np.clip(np.rint((num / np.maximum(den, 1e-6) + 32) * 2), 0, 254).astype(np.uint16)
    out |= v[np.where(fa < 0.5, i0, i1), np.where(fg < 0.5, g0, g1)] & 0xFF00   # class of the nearest gate
    # a gap in the radials (a sector the scan lacks) is not bridged
    return np.where(inside & (den >= 0.5) & (span < NX_GAP), out, 255).astype(np.uint16)


def nx_suffix(t):
    return time.strftime('%Y_%m_%d_%H_%M_%S', time.gmtime(t))


def nx_get(key):
    """Object bytes, None if the bucket has no such key (yet)."""
    try:
        return http_get(f'{NX_URL}/{key}')
    except urllib.error.HTTPError as err:
        if err.code in (403, 404):
            return None
        raise


def nx_ingest(site, suffix, now):
    """One scan: fetch N0B/N0C/N0H, clean, keep the polar result. False while the
    CC/class products are not up yet (and the scan is young enough to wait for them)."""
    t = calendar.timegm(time.strptime(suffix, '%Y_%m_%d_%H_%M_%S'))
    t0 = time.time()
    raw = {p: nx_get(f'{site}_{p}_{suffix}') for p in ('N0B', 'N0C', 'N0H')}
    if raw['N0B'] is None:
        return True                         # listed, then gone: nothing to wait for
    if None in raw.values() and now - t < NX_ASIDE:
        return False
    t1 = time.time()
    b, c, h = (nx_decode(raw[p]) if raw[p] else None for p in ('N0B', 'N0C', 'N0H'))
    q, cls, keep = nx_clean(b, c, h)
    q, cls = np.ascontiguousarray(q[keep]), np.ascontiguousarray(cls[keep])
    scan = (b['elev'], ((b['az'] + b['width'] / 2) % 360)[keep], zlib.compress(q.tobytes(), 1),
            zlib.compress(cls.tobytes(), 1) if cls.any() else None, q.shape)
    with _nx_lock:
        if site in _nx_active:
            _nx_scans.setdefault(site, {})[t] = scan
    print(f'[NEXRAD] {site} {time.strftime("%H:%M:%SZ", time.gmtime(t))} +{now - t:.0f}s: fetch {t1 - t0:.2f}s '
          f'clean {time.time() - t1:.2f}s {sum(len(v) for v in raw.values() if v) // 1024}KB'
          + ('' if c and h else ' (no CC/class)'), flush=True)
    return True


def nx_site_grid(site, t):
    """A stored scan on the site's box: uint16 q | class << 8 (see nx_grid)."""
    with _nx_lock:
        elev, centers, zq, zc, shape = _nx_scans[site][t]
    v = np.frombuffer(zlib.decompress(zq), np.uint8).reshape(shape).astype(np.uint16)
    if zc is not None:
        v |= np.frombuffer(zlib.decompress(zc), np.uint8).reshape(shape).astype(np.uint16) << 8
    return nx_grid(site, centers, elev, v), elev


def nx_blocks(site):
    r0, r1, c0, c1 = nx_box(site)
    return {(br, bc) for br in range(r0 // NX_BLOCK, (r1 - 1) // NX_BLOCK + 1)
            for bc in range(c0 // NX_BLOCK, (c1 - 1) // NX_BLOCK + 1)}


def nx_nearest(times, T):
    """The scan time nearest T within NX_MAX_AGE (a later one wins a tie), or None."""
    best = min(times, key=lambda s: (abs(s - T), -s), default=None)
    return best if best is not None and abs(best - T) <= NX_MAX_AGE else None


def nx_flow_at(T):
    """(scan time, int8 field) of the MRMS motion nearest T within MRMS_FLOW_SPAN, or (None, None)."""
    for _, s in sorted((abs(s - T), s) for s in mrms_times() if abs(s - T) <= MRMS_FLOW_SPAN):
        with _mrms_lock:
            f = _mrms_flow.get(s)
        if f is not None:
            return s, mrms_flow_array(f)
    return None, None


def nx_block_flow(f, br, bc, pad=0):
    """Motion at each cell of a block (and pad cells around it) in NX cells per second
    (x east, y south), bilinear in the MRMS field."""
    u = NX_SUB * MRMS_FLOW_RES              # NX cells per flow texel
    y = ((br * NX_BLOCK + np.arange(-pad, NX_BLOCK + pad) + 0.5) / u - 0.5).astype(np.float32)
    x = ((bc * NX_BLOCK + np.arange(-pad, NX_BLOCK + pad) + 0.5) / u - 0.5).astype(np.float32)
    mx, my = np.meshgrid(x, y)
    v = cv2.remap(f.astype(np.float32), mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return v * np.float32(NX_SUB / MRMS_FLOW_SCALE / MRMS_STEP)


_nx_beam_table = np.arange(0, NX_RANGE + 20e3, 500.0)


def nx_weight(site, elev, br, bc, pad=0):
    """Blend weight exp(-beam height / NX_BEAM_H) x range ramp, and the ramp, per MRMS
    cell (1/NX_SUB res) of a block and pad MRMS cells around it."""
    n = NX_BLOCK // NX_SUB
    lat = MRMS_NORTH - (br * n + np.arange(-pad, n + pad) + 0.5) * MRMS_RES
    lon = MRMS_WEST + (bc * n + np.arange(-pad, n + pad) + 0.5) * MRMS_RES
    s, _ = nx_polar_coords(site, lat[:, None], lon[None, :])
    h, ground = nx_beam(_nx_beam_table, elev)
    height = np.interp(s, ground, h) + NX_SITES[site][2]   # above sea level: radars on hills see the same air higher
    ramp = np.clip((NX_RANGE - s) / NX_FADE, 0, 1).astype(np.float32)
    return (np.exp(-height / NX_BEAM_H) * ramp).astype(np.float32), ramp


def nx_mrms_block(T, br, bc, pad):
    """MRMS scan T under a block (and pad NX cells around it) in dBZ, bilinear, no echo
    and no coverage as -32; None if the ring does not have it."""
    with _mrms_lock:
        strips = _mrms.get(T)
    if strips is None:
        return None
    n, m = NX_BLOCK // NX_SUB, pad // NX_SUB + 1
    r0, c0 = br * n - m, bc * n - m
    rows, base = mrms_rows(strips, max(r0, 0), min(r0 + n + 2 * m, MRMS_NY) - 1)
    cells = np.full((n + 2 * m, n + 2 * m), 0, np.uint8)
    rr, cc = np.arange(r0, r0 + n + 2 * m), np.arange(c0, c0 + n + 2 * m)
    ri, ci = np.flatnonzero((rr >= 0) & (rr < MRMS_NY)), np.flatnonzero((cc >= 0) & (cc < MRMS_NX))
    cells[np.ix_(ri, ci)] = rows[np.ix_(rr[ri] - base, cc[ci])]
    d = np.where((cells == 0) | (cells == 255), -32, cells * np.float32(0.5) - 32).astype(np.float32)
    # NX cell centers in MRMS cell units, relative to the first fetched cell's center
    at = ((np.arange(-pad, NX_BLOCK + pad) + 0.5) / NX_SUB - 0.5 + m).astype(np.float32)
    mx, my = np.meshgrid(at, at)
    return cv2.remap(d, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def nx_block(br, bc, parts, f, fill=None):
    """One composite block: parts [(site, seconds from scan to frame, site grid, elevation)],
    f the MRMS motion (or None), fill the MRMS scan of the frame's time (nx_mrms_block) for
    cells in range no radar here has (a blocked beam, clutter in rain). zlib of q
    (NX_BLOCK^2), class (NX_BLOCK^2) and coverage (0-255 per MRMS cell: how far inside
    the present radars' range), and whether it has snow. Built NX_SUB cells wider on
    each side so the smoothing reads across block edges."""
    n, p = NX_BLOCK // NX_SUB, NX_SUB
    size = NX_BLOCK + 2 * p
    num = np.zeros((size, size), np.float32)
    den, best = np.zeros_like(num), np.zeros_like(num)
    cls = np.zeros((size, size), np.uint8)
    cov = np.zeros((n, n), np.float32)
    motion = nx_block_flow(f, br, bc, p) if f is not None else None
    reach = ()                              # max range ramp: > 0 in some present radar's range
    for site, dt, grid, elev in parts:
        r0, _, c0, _ = nx_box(site)
        mx, my = np.meshgrid(np.arange(-p, NX_BLOCK + p, dtype=np.float32) + (bc * NX_BLOCK - c0),
                             np.arange(-p, NX_BLOCK + p, dtype=np.float32) + (br * NX_BLOCK - r0))
        if motion is not None and dt:       # the echo at p at the frame time was at p - v dt at the scan
            mx -= motion[..., 0] * dt
            my -= motion[..., 1] * dt
        v = cv2.remap(grid, mx, my, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=255)
        w1, ramp = nx_weight(site, elev, br, bc, 1)
        has = v != 255
        w = np.where(has, cv2.resize(w1, (size, size), interpolation=cv2.INTER_LINEAR), 0)
        q = (v & 255).astype(np.float32)
        num += w * np.where(q > 0, q * np.float32(0.5) - 32, -32)   # no echo blends as -32 dBZ, like the tiles
        den += w
        top = w > best
        best[top] = w[top]
        cls[top] = (v >> 8)[top]
        cov = np.maximum(cov, ramp[1:-1, 1:-1])
        reach = np.maximum(reach, cv2.resize(ramp, (size, size), interpolation=cv2.INTER_LINEAR)) if len(reach) else \
            cv2.resize(ramp, (size, size), interpolation=cv2.INTER_LINEAR)
    if fill is not None and len(reach):     # MRMS where in range but nothing here: a vanishing weight, so it only fills
        gap = (reach > 0).astype(np.float32) * np.float32(NX_FILL_W)
        num += gap * fill
        den += gap
    # Gate noise (~1 dB a gate) mottles 5 dBZ bands at street zoom: a light blur, normalized
    # by the weights so uncovered cells and the radars' blend stay out of it
    if NX_SMOOTH:
        dbz = cv2.GaussianBlur(num, (0, 0), NX_SMOOTH) / np.maximum(cv2.GaussianBlur(den, (0, 0), NX_SMOOTH), 1e-30)
    else:
        dbz = num / np.maximum(den, 1e-30)
    q = np.where(den > 0, np.clip(np.rint((dbz + 32) * 2), 0, 254), 255).astype(np.uint8)[p:-p, p:-p]
    cls = cls[p:-p, p:-p]
    cls[(q == 0) | (q == 255)] = 0
    return zlib.compress(q.tobytes() + cls.tobytes() + np.rint(cov * 255).astype(np.uint8).tobytes(), 6), bool((cls == 1).any())


def nx_block_arrays(z):
    """q, class (NX_BLOCK square) and coverage (MRMS cells) of a stored block."""
    b, n = NX_BLOCK * NX_BLOCK, NX_BLOCK // NX_SUB
    a = np.frombuffer(zlib.decompress(z), np.uint8)
    return a[:b].reshape(NX_BLOCK, NX_BLOCK), a[b:2 * b].reshape(NX_BLOCK, NX_BLOCK), a[2 * b:].reshape(n, n)


def nx_frame_times(now):
    newest = int(now - NX_LAG) // MRMS_STEP * MRMS_STEP
    return list(range(newest - (MRMS_FRAMES - 1) * MRMS_STEP, newest + 1, MRMS_STEP))


def nx_update(now):
    """(Re)build every frame block whose inputs changed: which radars, which of their
    scans, which motion. Returns how many blocks were built."""
    times = nx_frame_times(now)
    with _nx_lock:
        for T in [T for T in _nx_frames if T < times[0]]:
            del _nx_frames[T]
        scans = {s: sorted(v) for s, v in _nx_scans.items() if v}
    cover = {}
    for s in scans:
        for blk in nx_blocks(s):
            cover.setdefault(blk, []).append(s)
    grids, built, t0 = {}, 0, time.time()
    for T in times:
        ft, f = nx_flow_at(T)
        use = {s: nx_nearest(v, T) for s, v in scans.items()}
        with _nx_lock:
            frame = _nx_frames.get(T) or {'blocks': {}, 'sig': {}, 'snow': {}, 'rev': 0}
        with _mrms_lock:
            has_mrms = T in _mrms
        sigs = {blk: (tuple((s, use[s]) for s in sorted(sites) if use[s] is not None), ft, has_mrms) for blk, sites in cover.items()}
        sigs = {blk: sig for blk, sig in sigs.items() if sig[0]}
        if sigs == frame['sig']:
            continue
        blocks, snow = dict(frame['blocks']), dict(frame['snow'])
        for blk in [b for b in blocks if b not in sigs]:
            del blocks[blk], snow[blk]
        for blk, sig in sigs.items():
            if frame['sig'].get(blk) == sig:
                continue
            parts = []
            for s, st in sig[0]:
                if (s, st) not in grids:
                    if len(grids) > len(scans) + 2:   # frames go in time order: the oldest scan is done with
                        del grids[next(iter(grids))]
                    grids[(s, st)] = nx_site_grid(s, st)
                g, elev = grids[(s, st)]
                parts.append((s, T - st, g, elev))
            blocks[blk], snow[blk] = nx_block(*blk, parts, f if ft is not None else None,
                                              nx_mrms_block(T, *blk, NX_SUB) if has_mrms else None)
            built += 1
        with _nx_lock:
            _nx_rev[0] += 1
            _nx_frames[T] = {'blocks': blocks, 'sig': sigs, 'snow': snow, 'rev': _nx_rev[0]}
    if built:
        print(f'[NEXRAD] built {built} blocks in {time.time() - t0:.1f}s', flush=True)
    return built


def nx_list(site, since, now):
    """N0B key suffixes for a radar after key suffix `since`, oldest first."""
    days = sorted({time.strftime('%Y_%m_%d', time.gmtime(d)) for d in (calendar.timegm(time.strptime(since[:10], '%Y_%m_%d')), now)})
    found = []
    for day in days:
        xml = http_get(f'{NX_URL}/?list-type=2&prefix={site}_N0B_{day}&start-after={site}_N0B_{since}').decode()
        found += [suf for s, suf in NX_KEY_RE.findall(xml) if s == site]
    return sorted(suf for suf in set(found) if suf <= nx_suffix(now))


def nx_poll(now):
    """Drop idle radars; fetch every active radar's new scans; rebuild what changed."""
    with _nx_lock:
        for s in [s for s, seen in _nx_active.items() if now - seen > NX_IDLE]:
            del _nx_active[s]
        for s in [s for s in _nx_scans if s not in _nx_active]:
            del _nx_scans[s]
            _nx_last.pop(s, None)
        for v in _nx_scans.values():
            for t in [t for t in v if t < now - NX_KEEP]:
                del v[t]
        active = list(_nx_active)
        since = {s: max(_nx_last.get(s) or '', nx_suffix(now - NX_KEEP)) for s in active}

    def site_pass(s):
        try:
            for suf in nx_list(s, since[s], now):
                try:
                    if not nx_ingest(s, suf, now):
                        break               # CC/class not up: this scan (and the ones after) next poll
                except Exception as err:  # noqa: BLE001 - a bad object must not stall the radar
                    print(f'[NEXRAD] {s} {suf}: {err}', flush=True)
                    if now - calendar.timegm(time.strptime(suf, '%Y_%m_%d_%H_%M_%S')) < NX_ASIDE:
                        break               # young: maybe still uploading, try again next poll
                with _nx_lock:
                    if s in _nx_active:
                        _nx_last[s] = suf
        except Exception as err:  # noqa: BLE001 - one radar's trouble must not stop the others
            print(f'[NEXRAD] {s}: {err}', flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(site_pass, active))
    nx_update(now)


def nx_poller():
    while True:
        _nx_wake.clear()
        with _nx_build_lock:
            try:
                nx_poll(time.time())
            except Exception as err:  # noqa: BLE001 - keep polling
                print(f'[NEXRAD] poll: {err}', flush=True)
        _nx_wake.wait(NX_POLL)


def nx_touch(w, s, e, n, now):
    """A page is viewing this box: the radars whose range reaches it (nearest its
    center first, NX_VIEW at most) become active; past NX_CAP the radar viewed
    longest ago goes, unless that was within NX_HOLD (two views far apart must not
    evict each other's radars on every request: the newer one shows MRMS alone).
    True when a radar was added."""
    if e - w > 12 or n - s > 8:             # zoomed out: MRMS is as sharp as the screen
        return False
    dlat = NX_RANGE / (EARTH_R * math.pi / 180)
    cx, cy = (w + e) / 2, (s + n) / 2
    near = sorted((math.hypot((lo - cx) * math.cos(math.radians(cy)), la - cy), site)
                  for site, (la, lo, _) in NX_SITES.items()
                  if s - dlat < la < n + dlat and w - dlat / math.cos(math.radians(la)) < lo < e + dlat / math.cos(math.radians(la)))
    added = False
    with _nx_lock:
        for _, site in near[:NX_VIEW]:
            if site in _nx_active:
                _nx_active[site] = max(_nx_active[site], now)
                continue
            if len(_nx_active) >= NX_CAP:
                seen, old = min((t, s) for s, t in _nx_active.items())
                if now - seen < NX_HOLD:
                    continue
                del _nx_active[old]
            _nx_active[site] = now
            added = True
    if added:
        _nx_wake.set()
    return added


def nx_crop_box(w, s, e, n, step=1):
    """NX cell ranges (r0, r1, c0, c1) and step of a lat/lon box, snapped outward to
    the step, the step raised until both sides fit NX_CROP_MAX; None off the grid."""
    step = max(1, int(step))
    while True:
        out = lambda v, lo, hi: min(max(v, lo), hi) * step
        r0 = out(math.floor((MRMS_NORTH - n) / NX_RES / step + 1e-6), 0, MRMS_NY * NX_SUB // step)
        r1 = out(math.ceil((MRMS_NORTH - s) / NX_RES / step - 1e-6), 0, MRMS_NY * NX_SUB // step)
        c0 = out(math.floor((w - MRMS_WEST) / NX_RES / step + 1e-6), 0, MRMS_NX * NX_SUB // step)
        c1 = out(math.ceil((e - MRMS_WEST) / NX_RES / step - 1e-6), 0, MRMS_NX * NX_SUB // step)
        if r1 <= r0 or c1 <= c0:
            return None
        if max(r1 - r0, c1 - c0) <= NX_CROP_MAX * step:
            return r0, r1, c0, c1, step
        step += 1


def nx_crop_bounds(r0, r1, c0, c1, step):
    """X-Crop header: west,south,east,north (outer cell edges, degrees),step."""
    return (f'{MRMS_WEST + c0 * NX_RES:.4f},{MRMS_NORTH - r1 * NX_RES:.4f},'
            f'{MRMS_WEST + c1 * NX_RES:.4f},{MRMS_NORTH - r0 * NX_RES:.4f},{step}')


def nx_sample(T, rows, cols):
    """q, class and coverage (0-255) of frame T at NX cells rows x cols (1-D, ascending);
    no coverage past the composite. None when the frame has no block there."""
    with _nx_lock:
        frame = _nx_frames.get(T)
    if frame is None:
        return None
    q = np.full((len(rows), len(cols)), 255, np.uint8)
    cls, cov = np.zeros_like(q), np.zeros_like(q)
    hit = False
    for br in np.unique(rows // NX_BLOCK):
        ri = np.flatnonzero(rows // NX_BLOCK == br)
        for bc in np.unique(cols // NX_BLOCK):
            z = frame['blocks'].get((int(br), int(bc)))
            if z is None:
                continue
            hit = True
            ci = np.flatnonzero(cols // NX_BLOCK == bc)
            bq, bcl, bcov = nx_block_arrays(z)
            lr, lc = rows[ri] - br * NX_BLOCK, cols[ci] - bc * NX_BLOCK
            q[np.ix_(ri, ci)] = bq[np.ix_(lr, lc)]
            cls[np.ix_(ri, ci)] = bcl[np.ix_(lr, lc)]
            cov[np.ix_(ri, ci)] = bcov[np.ix_(lr // NX_SUB, lc // NX_SUB)]
    return (q, cls, cov) if hit else None


def nx_tile_sample(T, fr, fc):
    """NEXRAD frame T at fractional NX cell-center coordinates (1-D rows, cols):
    bilinear dBZ and covered weight (as mrms_dbz), bilinear coverage (0-1) and snow
    (the nearest cell's class); None where the frame has nothing."""
    r0, c0 = int(np.floor(fr.min())), int(np.floor(fc.min()))
    rows, cols = np.arange(r0, int(np.floor(fr.max())) + 2), np.arange(c0, int(np.floor(fc.max())) + 2)
    got = nx_sample(T, np.clip(rows, 0, None), np.clip(cols, 0, None))
    if got is None:
        return None
    q, cls, cov = got
    dbz, den = mrms_dbz(q, fr - r0, fc - c0)
    cv, _ = mrms_dbz(np.minimum(cov, 254), fr - r0, fc - c0)   # coverage bilinear the same way (255 would read as uncovered)
    near = cls[np.ix_(np.clip(np.rint(fr - r0).astype(np.int64), 0, len(rows) - 1),
                      np.clip(np.rint(fc - c0).astype(np.int64), 0, len(cols) - 1))]
    return dbz, den, np.clip((cv + 32) * 2 / 255, 0, 1), near == 1


@functools.lru_cache(maxsize=180)
def nx_crop(T, rev, r0, r1, c0, c1, step):
    """RGB PNG of frame T over a crop box, a cell every step, rows north to south:
    R q (MRMS quantization, 255 no coverage), G coverage (0-255: MRMS shows through
    where low), B class (0 rain, 1 snow, 2 mix). rev keys the cache: frames are
    rebuilt when a nearer scan arrives."""
    got = nx_sample(T, np.arange(r0 + step // 2, r1, step), np.arange(c0 + step // 2, c1, step))
    if got is None:
        raise NotPublished
    q, cls, cov = got
    return raw_png(np.dstack([q, cov, cls]))


def nx_rev_is(T, rev):
    """Frame T has reached this rev: crops and tiles are cached by rev, so a rev the frame
    has not reached yet must not cache today's build under it (an older one is fine: revs
    only grow, and a page's frame list can be a minute behind the rebuilds)."""
    with _nx_lock:
        f = _nx_frames.get(T)
        return f is not None and f['rev'] >= rev and bool(f['blocks'])


def nx_index():
    with _nx_lock:
        frames = sorted(T for T, f in _nx_frames.items() if f['blocks'])
        return {'frames': frames, 'revs': [_nx_frames[T]['rev'] for T in frames],
                'snow': any(any(_nx_frames[T]['snow'].values()) for T in frames),
                'sites': sorted(s for s in _nx_active if _nx_scans.get(s))}



class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if not self.path.startswith(('/health', '/status', '/mrms', '/nexrad')):  # polled constantly
            print('[HTTP]', fmt % args, flush=True)

    def send_json(self, code, obj, cached=False):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('X-Cache', 'HIT' if cached else 'MISS')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_png(self, body, headers={}):
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/health':
            maybe_start_index_build()
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
        if url.path == '/forecast':
            q = parse_qs(url.query)
            try:
                lat, lon = float(q.get('lat', ['nan'])[0]), float(q.get('lon', ['nan'])[0])
            except ValueError:
                lat = lon = math.nan
            if not (FIELD_BBOX[1] <= lat <= FIELD_BBOX[3] and FIELD_BBOX[0] <= lon <= FIELD_BBOX[2]):
                return self.send_json(400, {'error': 'lat/lon outside the forecast area'})
            try:
                return self.send_json(200, forecast(round(lat, 4), round(lon, 4), place_zone(q.get('tz', [''])[0])))
            except Exception as err:  # noqa: BLE001 - report any failure upstream
                print(f'[FORECAST] {lat},{lon}: {err}', flush=True)
                return self.send_json(502, {'error': str(err)})
        if url.path == '/fields':
            q = parse_qs(url.query)
            mode, field = q.get('mode', ['hourly'])[0], q.get('field', [''])[0]
            if mode not in ('now', *FIELD_MODES) or field not in FIELDS:
                return self.send_json(400, {'error': 'Invalid mode/field'})
            frames = mode_frames(mode, field)
            if not frames:
                return self.send_json(503, {'error': 'No frames available'})
            purge_fields()
            warm_field(field, frames)
            legends = {k: {'stops': v['stops'], 'unit': v['unit'], 'label': v['label'], 'ticks': v['ticks'],
                           'sqrt': bool(v.get('sqrt'))} for k, v in FIELDS.items() if 'ticks' in v}
            lat, lon = grid_axes()
            return self.send_json(200, {
                'frames': [{'src': f[0], 'date': f[1], 'cycle': f[2], 'fh': f[3], 'time': frame_time(*f)} for f in frames],
                'bounds': FIELD_BBOX, 'tile': FIELD_TILE, 'maxzoom': FIELD_MAXZOOM,
                'grid': {'west': FIELD_BBOX[0], 'north': FIELD_BBOX[3], 'step': FIELD_GRID_STEP,
                         'nx': len(lon), 'ny': len(lat),
                         'fields': {k: v['grid'] for k, v in FIELDS.items() if v.get('grid')}},
                'fields': legends})
        m = re.fullmatch(r'/fields/([a-z]+)\.(png|grid|point)', url.path)
        if m and m.group(1) in FIELDS:
            name, kind = m.groups()
            q = parse_qs(url.query)
            src, date, cycle, fh, z, x, y = (q.get(k, ['0'])[0] for k in ('src', 'date', 'cycle', 'fh', 'z', 'x', 'y'))
            if src not in SOURCES or not re.fullmatch(r'\d{8}', date) or not re.fullmatch(r'\d{2}|\d{4}', cycle) \
                    or not all(v.isdigit() for v in (fh, z, x, y)) or int(fh) > 84 or int(z) > FIELD_MAXZOOM \
                    or int(x) >= 2 ** int(z) or int(y) >= 2 ** int(z) or (kind == 'grid' and not FIELDS[name].get('grid')):
                return self.send_json(400, {'error': 'Invalid request'})
            frame = (src, date, cycle, int(fh))
            if src == 'rtma' and frame[3]:   # analyses have no forecast hours; each fh would cache a copy
                return self.send_json(400, {'error': 'RTMA frames are fh 0'})
            # Live frames only: purge_fields drops the rest
            if frame[:3] not in live_frames():
                return self.send_json(404, {'error': 'Not a live frame'})
            if kind == 'point':
                try:
                    lat, lon = float(q.get('lat', ['nan'])[0]), float(q.get('lon', ['nan'])[0])
                except ValueError:
                    lat = lon = math.nan
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    return self.send_json(400, {'error': 'Invalid lat/lon'})
            try:
                if kind == 'point':
                    return self.send_json(200, point_values(frame, lat, lon, name))
                if kind == 'png':
                    body, ctype = tile_png(name, frame, int(z), int(x), int(y)), 'image/png'
                else:
                    body, ctype = field_grid(name, frame), 'application/octet-stream'
            except NotPublished:
                return self.send_json(404, {'error': 'Not published'})
            except Exception as err:  # noqa: BLE001 - report any failure upstream
                print(f'[FIELD] {name} {frame}: {err}', flush=True)
                return self.send_json(502, {'error': str(err)})
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if url.path == '/mrms':
            return self.send_json(200, {'frames': mrms_times()[-MRMS_FRAMES:]})
        if url.path == '/mrms/palette.png':
            return self.send_png(MRMS_PALETTE_PNG)
        m = re.fullmatch(r'/mrms/(\d{10})/(crop|flow)\.png', url.path)
        if m:
            q = parse_qs(url.query)
            box = mrms_crop_query(q)
            cells = box and mrms_crop_box(*box)
            if not cells:
                return self.send_json(400, {'error': 'Invalid crop'})
            t = int(m.group(1))
            try:
                body = mrms_crop(t, *cells) if m.group(2) == 'crop' \
                    else mrms_flow_crop(t, *cells, q.get('mean', [''])[0] == '1')
            except NotPublished:
                return self.send_json(404, {'error': 'Not in the radar ring'})
            return self.send_png(body, {'X-Crop': mrms_crop_bounds(*cells)})
        if url.path == '/nexrad':
            return self.send_json(200, nx_index())
        m = re.fullmatch(r'/nexrad/(\d{10})/crop\.png', url.path)
        if m:
            q = parse_qs(url.query)
            box = mrms_crop_query(q)
            cells = box and nx_crop_box(*box)
            rev = q.get('r', ['0'])[0]
            if not cells or not re.fullmatch(r'\d{1,12}', rev):
                return self.send_json(400, {'error': 'Invalid crop'})
            nx_touch(*box[:4], time.time())   # a view here: its radars come on (in the background)
            if not nx_rev_is(int(m.group(1)), int(rev)):
                return self.send_json(404, {'error': 'No NEXRAD frame there'})
            try:
                body = nx_crop(int(m.group(1)), int(rev), *cells)
            except NotPublished:
                return self.send_json(404, {'error': 'No NEXRAD frame there'})
            return self.send_png(body, {'X-Crop': nx_crop_bounds(*cells)})
        m = re.fullmatch(r'/mrms/(\d{10})/(\d{1,2})/(\d{1,4})/(\d{1,4})\.png', url.path)
        if m:
            t, z, x, y = map(int, m.groups())
            nx = parse_qs(url.query).get('nx', [None])[0]
            if z > MRMS_MAXZOOM or x >= 2 ** z or y >= 2 ** z or not (nx is None or re.fullmatch(r'\d{1,12}', nx)):
                return self.send_json(400, {'error': 'Invalid tile'})
            if nx is not None and z >= NX_TILE_MINZOOM and not nx_rev_is(t, int(nx)):
                return self.send_json(404, {'error': 'No NEXRAD frame there'})
            try:
                body = mrms_tile(t, z, x, y, None if nx is None else int(nx))
            except NotPublished:
                return self.send_json(404, {'error': 'Not in the radar ring'})
            return self.send_png(body)
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
    threading.Thread(target=preload_fields if FIELD_PRELOAD else purge_fields, daemon=True).start()
    threading.Thread(target=mrms_poller, daemon=True).start()
    threading.Thread(target=nx_poller, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
