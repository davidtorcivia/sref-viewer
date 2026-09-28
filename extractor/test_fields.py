# Run: python3 test_fields.py (inside the extractor image, needs ecCodes)
# Offline check of the Lambert grid math and tile rendering on a synthetic
# grid shaped like RRFS CONUS: every grid point's lat/lon must map back to
# its own (i, j), and bilinear tiles must sample a linear field exactly.
import os
import sys
import tempfile

os.environ.setdefault('CACHE_DIR', tempfile.mkdtemp())
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
print(f'fields: ok (grid round trip within {err:.4f} cells)')
