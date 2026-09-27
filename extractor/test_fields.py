# Run: python3 test_fields.py (inside the extractor image, needs ecCodes)
# Offline check of the Lambert -> Web Mercator remap on a synthetic grid
# shaped like RRFS CONUS: each pixel's grid point must lie within half a
# grid cell of the pixel center.
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
idx = X.mercator_remap(g)
lats = ec.codes_get_array(g, 'latitudes')
lons = ec.codes_get_array(g, 'longitudes') - 360

w, s, e, n = X.FIELD_BBOX
H, W = idx.shape
merc = lambda la: np.log(np.tan(np.pi / 4 + np.radians(la) / 2))
ys, xs = np.nonzero(idx >= 0)
assert len(ys) > 0.5 * idx.size, 'grid should cover most of the bbox'
plon = w + (xs + 0.5) / W * (e - w)
plat = np.degrees(2 * np.arctan(np.exp(merc(n) - (ys + 0.5) / H * (merc(n) - merc(s)))) - np.pi / 2)
k = idx[ys, xs]
err_km = np.hypot((lats[k] - plat) * 111.2, (lons[k] - plon) * 111.2 * np.cos(np.radians(plat)))
# Half the cell diagonal (0.707) plus km-conversion slack
assert err_km.max() < 12 * 0.72, f'remap off by {err_km.max():.1f}km'

for name, spec in X.FIELDS.items():
    png = X.render_field(name, [ec.codes_get_message(g)] * len(spec['grib']))
    assert png.startswith(b'\x89PNG') and len(png) > 1000, name
    assert len(X.field_palette(spec)) <= 255, f'{name}: palette collides with the transparent index'
print(f'fields: ok (max remap error {err_km.max():.1f}km of 12km grid)')
