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
import zlib
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
# source -> URL template, GRIB level per message name, idx step for a message and hour
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
    """GRIB messages for [(name, level)] by .idx byte range; None if the file is not published."""
    try:
        rows = [l.split(':') for l in http_get(url + '.idx').decode().splitlines()]
    except urllib.error.HTTPError as err:
        if err.code in (403, 404):
            return None
        raise
    out = []
    for name, level in wanted:
        i = next((i for i, r in enumerate(rows) if r[3] == name and r[4] == level and r[5] == step), None)
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


def indexed_png(pixels, palette):
    """8-bit palette PNG from RGBA palette rows; index 255 is transparent."""
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    h, w = pixels.shape
    raw = np.hstack([np.zeros((h, 1), np.uint8), pixels]).tobytes()   # filter byte 0 per row
    plte = np.zeros((256, 4), np.uint8)
    plte[:len(palette)] = palette
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 3, 0, 0, 0))
            + chunk(b'PLTE', plte[:, :3].tobytes()) + chunk(b'tRNS', plte[:, 3].tobytes())
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


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
    keep = {os.path.basename(frame_dir(*f)) for f in live}
    known = ({'rtma'} if rtma else set()) | ({'rrfs'} if all(d for d, _ in cycles) else set())
    for old in os.listdir(FIELD_DIR) if os.path.isdir(FIELD_DIR) else []:
        src = old[:4]   # dirs are <src><date><cycle>; anything else is an older cache format
        if old not in keep and (src not in SOURCES or src in known):
            shutil.rmtree(os.path.join(FIELD_DIR, old), ignore_errors=True)
            continue
        # Kept dirs hold only GRIB messages, plus writes still in progress
        for f in os.scandir(os.path.join(FIELD_DIR, old)):
            try:
                if not f.name.endswith(('.grib2', '.tmp')) or f.name.endswith('.tmp') and time.time() - f.stat().st_mtime > 600:
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
                                    [(msg, s['levels'][msg])], s['step'](msg, fh))
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


@functools.lru_cache(maxsize=24)   # 7.6MB (RRFS) to 15MB (RTMA) each
def decoded(path):
    with open(path, 'rb') as fp:
        g = ec.codes_new_from_message(fp.read())
    try:
        p = grid_params(g)
        return ec.codes_get_values(g).astype(np.float32).reshape(p['Ny'], p['Nx']), p
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


def point_values(frame, lat, lon, overlay):
    """Every inspectable field's value at one point, for the popup."""
    out = {}
    for name in POINT_FIELDS:
        if not all(m in SOURCES[frame[0]]['levels'] for m in FIELDS[name]['grib']) \
                or FIELDS[name].get('acc') and frame[3] == 0:
            continue
        try:
            arrays, p = field_arrays(name, frame, cached_only=name not in POINT_BASE and name != overlay)
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
        except Exception as err:  # noqa: BLE001 - keep the loop alive
            print(f'[PRELOAD] {err}', flush=True)
        time.sleep(FIELD_CYCLE_TTL_S)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if not self.path.startswith(('/health', '/status')):  # polled constantly
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
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
