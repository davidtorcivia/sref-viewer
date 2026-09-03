#!/usr/bin/env python3
"""
RRFS/REFS point extractor service.

NOAA publishes no per-member REFS files, so a station "plume" is built from
two public products in the noaa-rrfs-ops-pds bucket:

  1. Deterministic RRFS station soundings: one ~117MB tarball per cycle
     (rrfs.tCCz.bufrsnd.tar.gz) holding a BUFR file per station, decoded
     with NCEPLIBS-bufr's debufr into an hourly surface series.
  2. REFS ensemble products (ensprod/refs.tCCz.{mean,sprd}.fHH.conus.grib2):
     the needed fields are fetched by byte range using the .idx sidecars and
     read at the station's nearest grid point with ecCodes, every 3 hours
     to 60h.

    GET /plume?sid=744860&date=20260903&cycle=00
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
  CACHE_DIR      decoded JSON (14 days), tarballs and grib subsets (36 h)
"""

import calendar
import json
import os
import re
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import eccodes as ec

PORT = int(os.environ.get('PORT', '3002'))
TAR_URL = os.environ.get(
    'RRFS_TAR_URL',
    'https://noaa-rrfs-ops-pds.s3.amazonaws.com/rrfs.{date}/{cycle}/rrfs.t{cycle}z.bufrsnd.tar.gz')
GRIB_URL = os.environ.get(
    'REFS_GRIB_URL',
    'https://noaa-rrfs-ops-pds.s3.amazonaws.com/refs.{date}/{cycle}/ensprod/refs.t{cycle}z.{prod}.f{hh}.conus.grib2')
CACHE_DIR = os.environ.get('CACHE_DIR', '/data/refs-cache')
TAR_DIR = os.path.join(CACHE_DIR, 'tar')
GRIB_DIR = os.path.join(CACHE_DIR, 'grib')
CACHE_MAX_AGE_DAYS = 14
RAW_MAX_AGE_H = 36            # tarballs / grib subsets: enough for late custom-station requests
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

# Bump when the extracted field set changes so stale disk cache (JSON and
# grib subsets) is ignored
CACHE_VERSION = 'v4'

STATIONS_FILE = os.environ.get('STATIONS_FILE', '/data/refs-stations.json')
STATIONS_MAX_AGE_DAYS = 30

for d in (CACHE_DIR, TAR_DIR, GRIB_DIR):
    os.makedirs(d, exist_ok=True)

# One download at a time per file; concurrent requests for the same cycle wait
_locks_guard = threading.Lock()
_locks = {}


def file_lock(path):
    with _locks_guard:
        return _locks.setdefault(path, threading.Lock())


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


def download_to(url, path, timeout=600):
    """Stream url to path atomically. Raises HTTPError (404) when absent."""
    with file_lock(path):
        if os.path.exists(path):
            return path
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        tmp = path + '.tmp'
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(tmp, 'wb') as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(tmp, path)
        return path


# ============ Deterministic RRFS (BUFR soundings) ============

def tar_path(date, cycle):
    return os.path.join(TAR_DIR, f'{date}{cycle}.tar.gz')


def get_tarball(date, cycle):
    return download_to(TAR_URL.format(date=date, cycle=cycle), tar_path(date, cycle))


def read_station_bufr(date, cycle, sid):
    """Raw BUFR bytes for one station from the cycle tarball (None if absent)."""
    name = f'bufr.{sid}.{date}{cycle}'
    with tarfile.open(get_tarball(date, cycle), 'r:gz') as tf:
        for m in tf:
            if m.isfile() and os.path.basename(m.name) == name:
                return tf.extractfile(m).read()
    return None


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


# ============ REFS ensemble (grib byte ranges) ============

def grib_path(date, cycle, prod, h):
    return os.path.join(GRIB_DIR, f'{date}{cycle}_{prod}_f{h:02d}_{CACHE_VERSION}.grib2')


def fetch_grib_subset(date, cycle, prod, h):
    """Fetch just the wanted fields of one ensprod file. None if not published yet."""
    path = grib_path(date, cycle, prod, h)
    if os.path.exists(path):
        return path
    with file_lock(path):
        if os.path.exists(path):
            return path
        url = GRIB_URL.format(date=date, cycle=cycle, prod=prod, hh=f'{h:02d}')
        try:
            rows = [l.split(':') for l in http_get(url + '.idx').decode().splitlines()]
        except urllib.error.HTTPError as err:
            if err.code in (403, 404):
                return None
            raise
        want = []
        for i, r in enumerate(rows):
            key = ENS_FIELDS.get((r[3], r[4]))
            if not key:
                continue
            step = f'{h - 3}-{h} hour acc fcst' if key in ('qpf', 'sno') else f'{h} hour fcst'
            if r[5] == step:
                want.append(i)
        if len(want) != len(ENS_FIELDS):
            raise RuntimeError(f'{prod} f{h:02d}: found {len(want)}/{len(ENS_FIELDS)} fields in index')
        tmp = path + '.tmp'
        with open(tmp, 'wb') as f:
            for i in want:
                start = int(rows[i][1])
                end = str(int(rows[i + 1][1]) - 1) if i + 1 < len(rows) else ''
                f.write(http_get(url, headers={'Range': f'bytes={start}-{end}'}, timeout=120))
        os.replace(tmp, path)
        return path


def ens_point(date, cycle, lat, lon):
    """Mean/spread series at the nearest grid point. Returns (ens, complete)."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(lambda ph: fetch_grib_subset(date, cycle, ph[0], ph[1]),
                              [(p, h) for h in ENS_HOURS for p in ENS_PRODS]))
    ens = {'hours': [], 'mean': {k: [] for k in ENS_PARAMS.values()},
           'sprd': {k: [] for k in ENS_PARAMS.values()}}
    idx = None
    for n, h in enumerate(ENS_HOURS):
        pair = paths[2 * n:2 * n + 2]
        if None in pair:
            break  # cycle still publishing
        vals = {}
        for prod, path in zip(ENS_PRODS, pair):
            with open(path, 'rb') as f:
                while True:
                    g = ec.codes_grib_new_from_file(f)
                    if g is None:
                        break
                    try:
                        if idx is None:
                            # Same grid in every message: locate the point once
                            idx = ec.codes_grib_find_nearest(g, lat, lon)[0].index
                        key = ENS_PARAMS.get((ec.codes_get(g, 'discipline'),
                                              ec.codes_get(g, 'parameterCategory'),
                                              ec.codes_get(g, 'parameterNumber')))
                        if key:
                            vals[(prod, key)] = float(ec.codes_get_values(g)[idx])
                    finally:
                        ec.codes_release(g)
        if len(vals) != 2 * len(ENS_PARAMS):
            raise RuntimeError(f'f{h:02d}: decoded {len(vals)} of {2 * len(ENS_PARAMS)} fields')
        ens['hours'].append(h)
        for (prod, key), v in vals.items():
            ens[prod][key].append(v)
    return ens, len(ens['hours']) == len(ENS_HOURS)


# ============ Plume assembly + cache ============

def cache_path(sid, date, cycle, partial=False):
    tag = f'{CACHE_VERSION}_partial' if partial else CACHE_VERSION
    return os.path.join(CACHE_DIR, f'{date}_{cycle}_{sid}_{tag}.json')


def prune_cache():
    now = time.time()
    for d, max_age in ((CACHE_DIR, CACHE_MAX_AGE_DAYS * 86400),
                       (TAR_DIR, RAW_MAX_AGE_H * 3600), (GRIB_DIR, RAW_MAX_AGE_H * 3600)):
        try:
            for name in os.listdir(d):
                p = os.path.join(d, name)
                if os.path.isfile(p) and now - os.path.getmtime(p) > max_age:
                    os.remove(p)
        except OSError:
            pass


def build_plume(sid, date, cycle):
    path = cache_path(sid, date, cycle)
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f), True
    partial = cache_path(sid, date, cycle, partial=True)
    try:
        if time.time() - os.path.getmtime(partial) < PARTIAL_MAX_AGE_S:
            with open(partial) as f:
                return json.load(f), True
    except OSError:
        pass

    result = {'sid': sid, 'rpid': None, 'lat': None, 'lon': None, 'date': date,
              'cycle': cycle, 'complete': False, 'members': {}, 'ens': None}

    raw = read_station_bufr(date, cycle, sid)
    if raw is None:
        raise FileNotFoundError(f'station {sid} not in {date}/{cycle}Z tarball')
    header, series = decode_bufr(raw)
    result['rpid'] = header.get('rpid')
    result['lat'] = header.get('clat')
    result['lon'] = header.get('clon')
    if series['ftimes']:
        result['members']['rrfs'] = series
    det_complete = len(series['ftimes']) >= 49

    ens_complete = False
    if result['lat'] is not None and result['lon'] is not None:
        try:
            result['ens'], ens_complete = ens_point(date, cycle, result['lat'], result['lon'])
        except Exception as err:  # noqa: BLE001 - deterministic data is still useful
            print(f'[ENS] {sid} {date}{cycle}: {err}', flush=True)

    # A cycle whose ensemble products never appear stops being retried
    # once it is old enough that they clearly are not coming
    cycle_age_h = (time.time() - calendar.timegm(time.strptime(f'{date}{cycle}', '%Y%m%d%H'))) / 3600
    # A transient ensemble failure (ens None) must still retry
    result['complete'] = det_complete and (ens_complete or (cycle_age_h > 12 and result['ens'] is not None))
    dest = path if result['complete'] else partial
    tmp = f'{dest}.{threading.get_ident()}.tmp'  # concurrent builds must not share a temp file
    with open(tmp, 'w') as f:
        json.dump(result, f)
    os.replace(tmp, dest)
    prune_cache()
    return result, False


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

        def members():
            with tarfile.open(get_tarball(date, cycle), 'r:gz') as tf:
                for m in tf:
                    mm = re.fullmatch(r'bufr\.(\d{6})\.\d{10}', os.path.basename(m.name))
                    if m.isfile() and mm:
                        yield mm.group(1), tf.extractfile(m).read(20480)

        index = {}
        done = 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            for info in pool.map(one, members()):
                done += 1
                if info:
                    index[info['rpid'].upper()] = {
                        'sid': info['sid'], 'lat': info['lat'], 'lon': info['lon']}
                if done % 250 == 0:
                    print(f'[STATIONS] {done} decoded', flush=True)

        payload = {'generated': int(time.time()), 'source': f'{date}/{cycle}Z',
                   'count': len(index), 'stations': index}
        with open(STATIONS_FILE, 'w') as f:
            json.dump(payload, f)
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
        if url.path == '/stations':
            try:
                with open(STATIONS_FILE) as f:
                    return self.send_json(200, json.load(f), cached=True)
            except OSError:
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
