# Run: python3 test_fields.py (inside the extractor image, needs ecCodes)
# Offline check of the Lambert grid math and tile rendering on a synthetic
# grid shaped like RRFS CONUS: every grid point's lat/lon must map back to
# its own (i, j), and bilinear tiles must sample a linear field exactly.
import os
import sys
import tempfile

# Always a scratch dir: the purge test below deletes cycle directories
os.environ['CACHE_DIR'] = tempfile.mkdtemp()
os.environ.setdefault('STATIONS_FILE', os.path.join(os.environ['CACHE_DIR'], 's.json'))
os.environ.setdefault('GRID_INDEX_FILE', os.path.join(os.environ['CACHE_DIR'], 'g.json'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import eccodes as ec
import numpy as np
import extractor as X

g = ec.codes_grib_new_from_samples('GRIB2')
ec.codes_set(g, 'gridDefinitionTemplateNumber', 30)   # Lambert conformal
for k, v in (('Nx', 450), ('Ny', 265), ('LoVInDegrees', 262.5), ('LaDInDegrees', 38.5),
             ('Latin1InDegrees', 38.5), ('Latin2InDegrees', 38.5), ('shapeOfTheEarth', 6),
             ('latitudeOfFirstGridPointInDegrees', 21.138123), ('longitudeOfFirstGridPointInDegrees', 237.280472),
             ('DxInMetres', 12000), ('DyInMetres', 12000), ('iScansNegatively', 0), ('jScansPositively', 1)):
    ec.codes_set(g, k, v)
ec.codes_set_values(g, np.full(450 * 265, 273.15))
p = X.grid_params(g)
lats = ec.codes_get_array(g, 'latitudes')
lons = ec.codes_get_array(g, 'longitudes')
fi, fj = X.lambert_ij(p, lats, lons)
k = np.arange(450 * 265)
err = max(np.abs(fi - k % 450).max(), np.abs(fj - k // 450).max())
assert err < 0.01, f'grid math off by {err:.3f} cells'
# NBM scans every other row east to west: grid_values must agree with
# ecCodes' own nearest-point lookup (which honours the scan) on odd and even rows
ec.codes_set(g, 'alternativeRowScanning', 1)
ec.codes_set_values(g, np.arange(450 * 265, dtype=float))
for k in (460, 1550, 905):
    assert ec.codes_grib_find_nearest(g, lats[k], lons[k])[0].value == X.grid_values(g, p)[k // 450, k % 450], k
ec.codes_set(g, 'alternativeRowScanning', 0)
assert X.grid_values(g, p)[1, 10] == 460

# Values equal to the column index: a bilinear sample must equal its fractional column
col = np.tile(np.arange(450, dtype=np.float32), (265, 1))
spec = {'band': 1, 'value': lambda c: c, 'stops': [(0, (0, 0, 0, 255)), (254, (0, 0, 0, 255))]}
lat = np.linspace(48, 41, 64)[:, None]    # Dakotas to Iowa: inside the grid
lon = np.linspace(-101, -90, 64)[None, :]
px, _ = X.paint(spec, [col], p, lat, lon)
want = np.floor(X.lambert_ij(p, lat, lon)[0])
assert (px != 255).all(), 'area over the grid has holes'
assert np.abs(px.astype(int) - np.minimum(want, 253)).max() <= 1, 'bilinear sample off'
assert (X.paint(spec, [col], p, np.array([[50.0]]), np.array([[10.0]]))[0] == 255).all(), 'Europe should be empty'

# Grid-relative winds: identity at LoV; a grid-east wind east of LoV points slightly south of east
ue, ve = X.earth_winds(p, 1.0, 0.0, 262.5)
assert abs(ue - 1) < 1e-9 and abs(ve) < 1e-9, 'rotation should vanish at LoV'
ue, ve = X.earth_winds(p, 1.0, 0.0, -74.0)
assert ue > 0.9 and -0.4 < ve < -0.1, f'rotation sign wrong: {ue:.2f}, {ve:.2f}'

# Radar bands paint the legend's exact colors, snow as negative dBZ
refc = X.FIELDS['refc']
pal = X.field_palette(refc)
band = lambda dbz, snow: int((refc['value'](np.float32(dbz), np.float32(snow)) - refc['stops'][0][0]) // refc['band'])
assert pal[band(12, 0)][:3].tolist() == [0x01, 0xb7, 0x14], 'rain 10-15 dBZ'
assert pal[band(7, 1)][:3].tolist() == [0x9f, 0xff, 0xff], 'snow 5-10 dBZ'
assert pal[band(7, 0)][3] == 0 and pal[band(-20, 0)][3] == 0, 'light rain / no echo should be clear'

for name, spec in X.FIELDS.items():
    layers = spec.get('layers', [name])
    assert sum(len(X.field_palette(X.FIELDS[n])) for n in layers) <= 255, f'{name}: palette collides with the transparent index'
    parts = [X.paint(X.FIELDS[n], [np.full((265, 450), 250, np.float32)] * len(X.FIELDS[n]['grib']), p, lat, lon)
             for n in layers]
    png = X.indexed_png(*(X.composite(*parts) if len(parts) > 1 else parts[0]))
    assert png.startswith(b'\x89PNG') and len(png) > 100, name

# Composite: radar where it has echo, satellite elsewhere, offset into the joint palette
top = (np.array([[band(0, 0), band(40, 0)]], np.uint8), pal)
base = (np.array([[3, 3]], np.uint8), X.field_palette(X.FIELDS['sat']))
px, joint = X.composite(top, base)
assert px.tolist() == [[len(pal) + 3, band(40, 0)]] and len(joint) == len(pal) + len(base[1])
# Totals band on sqrt(inches): a trace stays clear, a hundredth shows, heavy amounts stay distinct
qpf = X.FIELDS['qpf']
qpal = X.field_palette(qpf)
qband = lambda inches: int((X.band_axis(qpf, inches) - X.band_axis(qpf, 0)) // qpf['band'])
assert qpal[qband(0.005)][3] == 0 and qpal[qband(0.012)][3] > 0, 'trace vs hundredth'
assert qband(2) != qband(2.5) and qband(5) < len(qpal), 'heavy totals need their own bands'

# RTMA analyses are 'HHMM' at fh 0; RRFS cycles 'HH' plus forecast hours
assert X.frame_time('rtma', '20260928', '1615', 0) == X.frame_time('rrfs', '20260928', '16', 0) + 900
assert X.frame_time('rrfs', '20260928', '12', 30) == X.frame_time('rrfs', '20260929', '18', 0)
# .idx step text, as published: whole-day totals switch to days
assert [X.rrfs_step('APCP', h) for h in (23, 24, 48, 84)] == \
    ['0-23 hour acc fcst', '0-1 day acc fcst', '0-2 day acc fcst', '0-84 hour acc fcst']
assert X.rrfs_step('TMP', 0) == 'anl' and X.rrfs_step('TMP', 24) == '24 hour fcst'

# pack_grid round trip, including the -128 sentinel and wrapping differences
flat = np.array([-128, -128, 127, -127, 0, 5, 6, -128], np.int8)
d = np.frombuffer(X.gzip.decompress(X.pack_grid(flat)), np.int8)
assert np.array_equal(np.cumsum(d, dtype=np.int8), flat), 'pack_grid round trip'

# Forecast crops: a point read from a tile crop matches sampling the full grid
full = np.random.default_rng(1).normal(280, 5, (265, 450)).astype(np.float32)
lat0, lon0 = 41.3, -95.6
box = X.crop_box(p, X.forecast_tile(lat0, lon0))
j0, j1, i0, i1 = box
crop = (full[None, None, j0:j1, i0:i1], i0, j0, p)
want = X.sample([full], p, np.array([lat0]), np.array([lon0]))[0][0][0]
assert abs(X.crop_series(crop, lat0, lon0)[0, 0] - want) < 1e-3, 'crop sample differs from full grid'
assert X.crop_series(crop, lat0 + 3, lon0) is None, 'point outside the crop'
assert X.crop_box(p, X.forecast_tile(10.5, 40.5)) is None, 'a tile off the grid has no crop'

# Purge: stale cycles and old formats go, live ones stay, and a source whose
# newest cycle is unknown (S3 not answering yet) keeps its cache
def purge_with(cycles, rtma, nbm=('20260928', '00')):
    X.field_cycle, X.rtma_frames, X.daily_cycle = (lambda m: cycles[m]), (lambda: rtma), (lambda: nbm)
    for d in ('rrfs2026092806', 'rrfs2026092812', 'rtma202609281600', 'rtma202609281615', '2026092812',
              'nbm2026092712', 'nbm2026092800'):
        os.makedirs(os.path.join(X.FIELD_DIR, d), exist_ok=True)
    open(os.path.join(X.FIELD_DIR, 'rrfs2026092812', 'old.npy'), 'w').close()
    open(os.path.join(X.FIELD_DIR, 'rrfs2026092812', 'fc_40_-74.npz'), 'w').close()
    X.purge_fields()
    return sorted(os.listdir(X.FIELD_DIR))
live = {'hourly': ('20260928', '12'), 'extended': ('20260928', '12')}
assert purge_with(live, [('20260928', '1615')]) == ['nbm2026092800', 'rrfs2026092812', 'rtma202609281615']
assert os.listdir(os.path.join(X.FIELD_DIR, 'rrfs2026092812')) == ['fc_40_-74.npz'], 'crops kept, other files swept'
# Run switch: the previous run stays (its forecast crops serve) until preload releases it
switched = {'hourly': ('20260928', '18'), 'extended': ('20260928', '18')}
assert 'rrfs2026092812' in purge_with(switched, [('20260928', '1615')]), 'previous run kept through the switch'
X._forecast_run['rrfs']['prev'] = None
assert 'rrfs2026092812' not in purge_with(switched, [('20260928', '1615')]), 'released run purged'
# The NBM run switches the same way
assert 'nbm2026092800' in purge_with(switched, [('20260928', '1615')], ('20260928', '12')), 'previous NBM run kept'
X._forecast_run['nbm']['prev'] = None
assert 'nbm2026092800' not in purge_with(switched, [('20260928', '1615')], ('20260928', '12')), 'released NBM run purged'
cold = {'hourly': (None, None), 'extended': ('20260928', '12')}
X._forecast_run['nbm'] = {'cur': None, 'prev': None}
assert purge_with(cold, [], (None, None)) == ['nbm2026092712', 'nbm2026092800', 'rrfs2026092806',
                                              'rrfs2026092812', 'rtma202609281600', 'rtma202609281615']

# NBM .idx step text, as published: hours throughout, the probability descriptor after the step
assert [X.nbm_step(m, 24) for m in X.DAILY_MSGS] == \
    ['24 hour fcst', '24 hour fcst', '24 hour fcst', '18-24 hour acc fcst', '18-24 hour acc fcst',
     '18-24 hour acc fcst', '12-24 hour max fcst', '12-24 hour min fcst', '12-24 hour acc fcst:prob >0.254']
assert X.nbm_step('APCP', 6) == '0-6 hour acc fcst' and X.nbm_step('TMAX', 264) == '252-264 hour max fcst'
# 12 h windows end at 00z (TMAX, day PoP) and 12z (TMIN, night PoP), never before the run
has = lambda c, m: [fh for fh in range(6, 49, 6) if X.nbm_has(c, m, fh)]
assert has('00', 'TMAX') == [24, 48] and has('00', 'TMIN') == [12, 36] and has('00', 'POP12') == [12, 24, 36, 48]
assert has('12', 'TMAX') == [12, 36] and has('12', 'TMIN') == [24, 48] and has('06', 'TMAX') == [18, 42]
assert has('00', 'APCP') == list(range(6, 49, 6))

# .idx matching: a probability row listed before the plain one, percentile
# and std dev rows beside them; each wanted message gets its own byte range
idx = '\n'.join(f'{n}:{n * 100}:d=2026092800:{t}' for n, t in enumerate([
    'APCP:surface:18-24 hour acc fcst:prob >0.254:prob fcst 255/255',
    'APCP:surface:12-24 hour acc fcst:prob >0.254:prob fcst 255/255',
    'APCP:surface:18-24 hour acc@(fcst,dt=6 hour),missing=0:50% level',
    'APCP:surface:18-24 hour acc fcst:',
    'TMP:2 m above ground:24 hour fcst:ens std dev',
    'TMP:2 m above ground:24 hour fcst:',
    'WIND:10 m above ground:24 hour fcst:'], 1))
ranges = []


def fake_get(url, headers=None, timeout=None):
    if url.endswith('.idx'):
        return idx.encode()
    ranges.append(headers['Range'])
    return b''


real_get, X.http_get = X.http_get, fake_get
X.fetch_idx_fields('u', [('APCP', 'surface')], X.nbm_step('APCP', 24))
X.fetch_idx_fields('u', [('APCP', 'surface')], X.nbm_step('POP12', 24))
X.fetch_idx_fields('u', [('TMP', '2 m above ground'), ('WIND', '10 m above ground')], '24 hour fcst')
X.http_get = real_get
assert ranges == ['bytes=400-499', 'bytes=200-299', 'bytes=600-699', 'bytes=700-'], ranges

# Daily rows from a 00z run on 2026-09-28 (EDT, UTC-4), every message every 6 h where published
hours = list(X.CROPS['nbm'][1])
value = {'TMAX': lambda fh: 300 + fh / 12, 'TMIN': lambda fh: 280 + fh / 12, 'POP12': lambda fh: fh,
         'APCP': lambda fh: 2.54, 'ASNOW': lambda fh: 0.3 if fh == 42 else 0, 'FICEAC': lambda fh: 0,
         'TCDC': lambda fh: fh % 24 * 4, 'WIND': lambda fh: fh / 6, 'GUST': lambda fh: fh / 3}
series = lambda cycle, msgs: {m: np.array([value[m](fh) if X.nbm_has(cycle, m, fh) else np.nan for fh in hours])
                              for m in msgs}
rows = X.daily_rows(X.frame_time('nbm', '20260928', '00', 0), hours, series('00', X.DAILY_MSGS))
by = {r['date']: r for r in rows}
assert [r['date'] for r in rows] == [f'2026-09-{d}' for d in (28, 29, 30)] + [f'2026-10-{d:02d}' for d in range(1, 9)]
d = by['2026-09-28']
# TMAX 12z-00z ends at f024, TMIN 00z-12z at f012; day PoP ends at f024, night PoP at f012
assert (d['hi'], d['lo'], d['pop_day'], d['pop_night']) == (round(X.K_TO_F(302)), round(X.K_TO_F(281)), 24, 12), d
# 6 h amounts 06z-06z: f012..f030. The 00z-06z bucket (f006, middle 11pm on the 27th)
# makes a 27th with no hi or lo, which is left out
assert d['qpf'] == 0.4 and d['snow'] == 0 and d['ptype'] == 'rain', d
# Instantaneous values at valid time: 06z, 12z, 18z and 00z (8pm): f006..f024
assert (d['wind'], d['gust'], d['cloud']) == (round(4 * 2.23694), round(8 * 2.23694), 36), d
# 30 cm of snow (12z-18z on the 29th) outweighs 4 x 2.54 mm of rain as liquid
assert by['2026-09-29']['snow'] == 11.8 and by['2026-09-29']['ptype'] == 'snow', by['2026-09-29']
# A 00z run's last day ends at 8pm, before its 2am-2am total: no partial total
assert by['2026-10-08']['qpf'] is None and by['2026-10-08']['ptype'] is None and by['2026-10-08']['hi'] is not None
# The last day with a hi ends the list (f264 = 8pm Oct 8)
assert by['2026-10-08']['hi'] == round(X.K_TO_F(322))
# A 12z run has no TMIN for its own morning: today is listed with lo None; the last TMAX is f252
rows12 = X.daily_rows(X.frame_time('nbm', '20260928', '12', 0), hours, series('12', ('TMAX', 'TMIN')))
assert rows12[0]['date'] == '2026-09-28' and rows12[0]['lo'] is None and rows12[0]['hi'] == round(X.K_TO_F(301))
assert rows12[-1]['date'] == '2026-10-08', rows12[-1]
# Winter (EST, UTC-5): the same windows land on the same dates
w = X.daily_rows(X.frame_time('nbm', '20260115', '00', 0), hours, series('00', ('TMAX', 'TMIN')))
assert w[0]['date'] == '2026-01-15' and w[0]['lo'] == round(X.K_TO_F(281)) and w[0]['hi'] == round(X.K_TO_F(302))
# The New York zone passed explicitly gives the same rows as the default
ny = X.daily_rows(X.frame_time('nbm', '20260928', '00', 0), hours, series('00', X.DAILY_MSGS), X.place_zone('America/New_York'))
assert ny == rows
# Los Angeles (PDT, UTC-7): the overnight low (00z-12z, ending 5am) lands on that
# morning's date, not the evening before as its 06z midpoint would put it
la = X.daily_rows(X.frame_time('nbm', '20260928', '00', 0), hours, series('00', X.DAILY_MSGS),
                  X.place_zone('America/Los_Angeles'))
lb = {r['date']: r for r in la}
assert [r['date'] for r in la] == [r['date'] for r in rows], [r['date'] for r in la]
d = lb['2026-09-28']
assert (d['hi'], d['lo'], d['pop_day'], d['pop_night']) == (round(X.K_TO_F(302)), round(X.K_TO_F(281)), 24, 12), d
assert lb['2026-09-29']['lo'] == round(X.K_TO_F(283)) and lb['2026-10-08']['lo'] == round(X.K_TO_F(301))
# Pacific day: instantaneous values 12z, 18z, 00z, 06z (5am-11pm PDT) = f012..f030;
# 6 h amounts 06z-06z (11pm-11pm PDT) = f012..f030 too
assert (d['wind'], d['gust'], d['cloud'], d['qpf']) == (round(5 * 2.23694), round(10 * 2.23694), 36, 0.4), d
# Snow at f042 (12z-18z on the 29th) is the 29th in Los Angeles as well
assert lb['2026-09-29']['snow'] == 11.8
# Zone names: anything unusable falls back to New York
assert str(X.place_zone('America/Denver')) == 'America/Denver'
assert all(X.place_zone(n) is X.DAILY_TZ for n in ('', None, 'Nowhere/Land', '../etc/passwd', 'UTC', 'America/' + 'x' * 60))

print(f'fields: ok (grid round trip within {err:.4f} cells)')
