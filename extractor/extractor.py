#!/usr/bin/env python3
"""
REFS BUFR extractor service.

Fetches per-member RRFS/REFS station sounding BUFR files, decodes them
with NCEPLIBS-bufr's debufr, and serves the surface time series as JSON.

    GET /plume?sid=744860&date=20260721&cycle=00
    GET /health

Response:
{
  "sid": "744860", "rpid": "KJFK", "date": "20260721", "cycle": "00",
  "members": {
    "m001": { "ftimes": [0, 3600, ...],       # seconds from cycle time
              "t2ms": [...], "u10m": [...], "v10m": [...],
              "tp01": [...], "snfl": [...], "snra": [...] },  # null = missing
    ...
  }
}

The upstream URL template is configurable so the source can move from
the AWS Open Data experimental feed to NOMADS prod without code changes:
  REFS_BUFR_URL (default: AWS noaa-rrfs-pds rrfsens)
  REFS_MEMBERS  (default: m001,m002,m003,m004,m005)
"""

import json
import os
import re
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get('PORT', '3002'))
BUFR_URL = os.environ.get(
    'REFS_BUFR_URL',
    'https://noaa-rrfs-pds.s3.amazonaws.com/rrfs_a/rrfsens.{date}/{cycle}/{member}/bufr.{cycle}/bufr.{sid}.{date}{cycle}'
)
MEMBERS = os.environ.get('REFS_MEMBERS', 'm001,m002,m003,m004,m005').split(',')
CACHE_DIR = os.environ.get('CACHE_DIR', '/data/refs-cache')
CACHE_MAX_AGE_DAYS = 14
FETCH_TIMEOUT = 30

# Surface mnemonics we extract per forecast-time block
SURFACE_KEYS = ('t2ms', 'u10m', 'v10m', 'tp01', 'snfl', 'snra')
LINE_RE = re.compile(r'^\d{6}\s+(FTIM|T2MS|U10M|V10M|TP01|SNFL|SNRA|RPID)\s+(\S+)', re.M)

os.makedirs(CACHE_DIR, exist_ok=True)


def fetch_bufr(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'SREF-Viewer-REFS/1.0 (Personal Weather Tool)'})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        return resp.read()


def decode_bufr(raw):
    """Run debufr on raw BUFR bytes, return (rpid, series dict)."""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, 'in.bufr')
        out = os.path.join(tmp, 'out.txt')
        with open(src, 'wb') as f:
            f.write(raw)
        subprocess.run(['debufr', '-o', out, src], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=120)
        with open(out, 'r', errors='replace') as f:
            text = f.read()

    rpid = None
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
        if key == 'rpid':
            rpid = rpid or val
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

    return rpid, {'ftimes': ftimes, **series}


def cache_path(sid, date, cycle):
    return os.path.join(CACHE_DIR, f'{date}_{cycle}_{sid}.json')


def prune_cache():
    cutoff = time.time() - CACHE_MAX_AGE_DAYS * 86400
    try:
        for name in os.listdir(CACHE_DIR):
            p = os.path.join(CACHE_DIR, name)
            if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
    except OSError:
        pass


def build_plume(sid, date, cycle):
    path = cache_path(sid, date, cycle)
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f), True

    result = {'sid': sid, 'rpid': None, 'date': date, 'cycle': cycle, 'members': {}}

    def one(member):
        url = BUFR_URL.format(date=date, cycle=cycle, member=member, sid=sid)
        try:
            raw = fetch_bufr(url)
            rpid, series = decode_bufr(raw)
            return member, rpid, series
        except (urllib.error.HTTPError, urllib.error.URLError,
                subprocess.SubprocessError, OSError) as err:
            print(f'[EXTRACT] {member} {sid} {date}{cycle}: {err}', flush=True)
            return member, None, None

    with ThreadPoolExecutor(max_workers=len(MEMBERS)) as pool:
        for member, rpid, series in pool.map(one, MEMBERS):
            if series and series['ftimes']:
                result['members'][member] = series
                result['rpid'] = result['rpid'] or rpid

    # Only cache complete pulls: every member present with a full run of
    # forecast hours (partial cycles get re-fetched until complete)
    counts = [len(m['ftimes']) for m in result['members'].values()]
    complete = (len(result['members']) == len(MEMBERS)
                and counts and min(counts) == max(counts) and min(counts) >= 49)
    if complete:
        with open(path, 'w') as f:
            json.dump(result, f)
        prune_cache()

    return result, False


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
            return self.send_json(200, {'status': 'ok'})
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
                return self.send_json(404, {'error': 'No member data available'})
            self.send_json(200, result, cached)
        except Exception as err:  # noqa: BLE001 - report any failure upstream
            print(f'[ERROR] {sid} {date}{cycle}: {err}', flush=True)
            self.send_json(502, {'error': str(err)})


if __name__ == '__main__':
    print(f'REFS extractor on :{PORT}, members={MEMBERS}', flush=True)
    print(f'Source: {BUFR_URL}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
