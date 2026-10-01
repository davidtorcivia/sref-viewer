"""Offline regression: python3 -m unittest discover -s extractor -p test_forecast_crops.py.

Executes the production crop functions with a tiny synthetic grid and mocked upstream I/O.
AST loading avoids starting service globals or requiring cv2/ecCodes for cache logic tests.
The ordinary extractor/test_fields.py suite remains the full decoder/render integration test.
"""
import ast
from concurrent.futures import ThreadPoolExecutor
import functools
import json
import os
from pathlib import Path
import tempfile
import threading
import types
import unittest

import numpy as np


FUNCTIONS = {'blend_hourly', 'crop_path', 'nbm_has', 'build_crops', 'ensure_crops', 'load_crop', 'serving_run', 'crops_ready'}


def production_functions():
    tree = ast.parse(Path(__file__).with_name('extractor.py').read_text())
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
    ns = {'np': np, 'os': os, 'json': json, 'functools': functools, 'threading': threading}
    exec(compile(ast.Module(body=selected, type_ignores=[]), 'extractor.py', 'exec'), ns)
    return ns


class ForecastCropCompletenessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.addCleanup(self.pool.shutdown)
        self.ns = production_functions()
        self.tile = (40, -74)
        self.calls = []
        self.unavailable = set()
        raw = self.root / 'raw.grib2'
        raw.write_bytes(b'synthetic test message')

        def fetch(src, date, cycle, fh, msg):
            self.calls.append((msg, fh))
            return None if (msg, fh) in self.unavailable else str(raw)

        def frame_dir(src, date, cycle):
            folder = self.root / (src + date + cycle)
            folder.mkdir(exist_ok=True)
            return str(folder)

        self.ns.update(
            _crop_pool=self.pool, run_grid=lambda *args: {'Nx': 2, 'Ny': 2},
            crop_box=lambda *args: (0, 2, 0, 2), frame_dir=frame_dir,
            CROPS={'nbm': (('TMAX', 'TMIN'), range(6, 49, 6), self.ns['nbm_has'])},
            fetch_msg=fetch, ec=types.SimpleNamespace(codes_new_from_message=lambda b: b,
                                                    codes_release=lambda g: None),
            grid_values=lambda g, p: np.full((2, 2), 280.0),
            _crop_lock=threading.Lock(), _crop_building=set(), FORECAST_BATCH=16,
        )

    def path(self, cycle='00', date='20261001'):
        return self.ns['crop_path']('nbm', date, cycle, self.tile)

    def ensure(self, cycle='00'):
        return self.ns['ensure_crops']('nbm', '20261001', cycle, [self.tile])

    def test_missing_expected_message_never_publishes_and_retry_recovers(self):
        self.unavailable = {('TMAX', 24), ('TMIN', 36)}
        self.assertFalse(self.ensure())
        self.assertFalse(os.path.exists(self.path()))
        self.assertFalse(self.ns['_crop_building'])
        self.unavailable.clear()
        self.assertTrue(self.ensure())
        self.assertTrue(os.path.exists(self.path()))
        with np.load(self.path()) as crop:
            data = crop['data']
            for k, msg in enumerate(('TMAX', 'TMIN')):
                for n, fh in enumerate(range(6, 49, 6)):
                    self.assertEqual(bool(np.isfinite(data[k, n]).all()), self.ns['nbm_has']('00', msg, fh))
        self.assertGreaterEqual(self.calls.count(('TMAX', 24)), 2)

    def test_sparse_temperature_schedule_is_intentionally_absent_not_failed(self):
        for cycle, expected in [('00', {('TMAX', 24), ('TMAX', 48), ('TMIN', 12), ('TMIN', 36)}),
                                ('12', {('TMAX', 12), ('TMAX', 36), ('TMIN', 24), ('TMIN', 48)})]:
            self.calls.clear()
            self.assertTrue(self.ensure(cycle))
            self.assertEqual(set(self.calls), expected)
            self.assertEqual(len(self.calls), len(expected))

    def test_successful_decode_with_legitimate_grid_nan_is_not_download_failure(self):
        # Land/water or domain masks are different from a message which never arrived.
        self.ns['grid_values'] = lambda g, p: np.full((2, 2), np.nan)
        self.assertTrue(self.ensure())
        self.assertTrue(os.path.exists(self.path()))

    def test_unavailable_grid_does_not_report_success(self):
        self.ns['run_grid'] = lambda *args: None
        self.assertFalse(self.ensure())
        self.assertFalse(os.path.exists(self.path()))

    def test_previous_complete_run_kept_while_current_is_incomplete(self):
        # Build a complete prior run, then fail one expected field of the new run.
        self.ns['build_crops']('nbm', '20260930', '12', [self.tile])
        self.unavailable = {('TMAX', 24)}
        self.ns['forecast_runs'] = lambda src: (('20261001', '00'), ('20260930', '12'))
        # Execute the background build synchronously, keeping this test deterministic.
        class ImmediateThread:
            def __init__(self, target, args, daemon): self.target, self.args = target, args
            def start(self): self.target(*self.args)
        self.ns['threading'] = types.SimpleNamespace(Thread=ImmediateThread)
        self.assertEqual(self.ns['serving_run']('nbm', self.tile), (('20260930', '12'), False))
        self.assertFalse(os.path.exists(self.path()))
        self.assertFalse(self.ns['crops_ready']('nbm', '20261001', '00', [self.tile]))

    def test_unavailable_new_run_without_prior_data_remains_building(self):
        self.unavailable = {('TMAX', 24)}
        self.ns['forecast_runs'] = lambda src: (('20261001', '00'), None)
        class ImmediateThread:
            def __init__(self, target, args, daemon): self.target, self.args = target, args
            def start(self): self.target(*self.args)
        self.ns['threading'] = types.SimpleNamespace(Thread=ImmediateThread)
        self.assertEqual(self.ns['serving_run']('nbm', self.tile), (None, True))
        self.assertFalse(os.path.exists(self.path()))


class BlendHourlyTest(unittest.TestCase):
    def test_nbm_hours_replace_rrfs_by_valid_time(self):
        ns = production_functions()
        # NBM 12z f001..f003 over an RRFS 13z run: f001 is 13z, the run's hour 0
        series = np.full((5, 3), np.nan)
        series[0] = [273.15, 274.15, np.nan]   # TMP K, last hour missing
        series[2] = [50, 60, 70]               # TCDC
        ns.update(load_crop=lambda p: None, crop_path=lambda *a: '', forecast_tile=lambda *a: (0, 0),
                  crop_series=lambda c, lat, lon: series, frame_time=lambda s, d, c, fh: 12 * 3600 + fh * 3600,
                  BLEND_MSGS=('TMP', 'DPT', 'TCDC', 'WIND', 'GUST'), CROPS={'nbmh': (None, range(1, 4), None)},
                  K_TO_F=lambda k: (k - 273.15) * 9 / 5 + 32, BLEND_TAPER=2)
        hourly = {'start': 13 * 3600, 'tmp': [60.0, 61.0, 62.0, 63.0], 'dpt': [50.0] * 4,
                  'cloud': [0, 0, 0, 0], 'wind': [5.0] * 4, 'gust': [9.0] * 4, 'dir': [180] * 4, 'run': 'x'}
        out = ns['blend_hourly'](hourly, '20261001', '12', 40, -74)
        # past the last NBM hour the seam's difference fades (taper 2: half of it on the next hour)
        self.assertEqual(out['tmp'], [32.0, 33.8, 62.0, 63.0])
        self.assertEqual(out['cloud'], [50, 60, 70, 35])
        self.assertEqual(out['dpt'], [50.0] * 4)
        self.assertEqual(out['blend_until'], 15 * 3600)
        self.assertEqual(hourly['tmp'], [60.0, 61.0, 62.0, 63.0])   # the RRFS series is left alone


if __name__ == '__main__':
    unittest.main()
