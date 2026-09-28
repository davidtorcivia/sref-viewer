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
def purge_with(cycles, rtma):
    X.field_cycle, X.rtma_frames = (lambda m: cycles[m]), (lambda: rtma)
    for d in ('rrfs2026092806', 'rrfs2026092812', 'rtma202609281600', 'rtma202609281615', '2026092812'):
        os.makedirs(os.path.join(X.FIELD_DIR, d), exist_ok=True)
    open(os.path.join(X.FIELD_DIR, 'rrfs2026092812', 'old.npy'), 'w').close()
    open(os.path.join(X.FIELD_DIR, 'rrfs2026092812', 'fc_40_-74.npz'), 'w').close()
    X.purge_fields()
    return sorted(os.listdir(X.FIELD_DIR))
live = {'hourly': ('20260928', '12'), 'extended': ('20260928', '12')}
assert purge_with(live, [('20260928', '1615')]) == ['rrfs2026092812', 'rtma202609281615']
assert os.listdir(os.path.join(X.FIELD_DIR, 'rrfs2026092812')) == ['fc_40_-74.npz'], 'crops kept, other files swept'
cold = {'hourly': (None, None), 'extended': ('20260928', '12')}
assert purge_with(cold, []) == ['rrfs2026092806', 'rrfs2026092812', 'rtma202609281600', 'rtma202609281615']

print(f'fields: ok (grid round trip within {err:.4f} cells)')
