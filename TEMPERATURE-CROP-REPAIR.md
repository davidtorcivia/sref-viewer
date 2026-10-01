# Prepared NBM temperature cache repair

Deployment status: not deployed or verified on production. Prepared for review as a draft PR.
Base: davidtorcivia/sref-viewer `432bacd5d951feb3af7f4df954f6b3baefe39407`.
Scope: `extractor/extractor.py`, a new offline regression suite, and this note. No radar/nowcast/rain algorithms, endpoints, frontend, or daily-date assignment are changed.

## Confirmed defect and limits of the diagnosis

In `extractor.py`:

1. `fetch_idx_fields` returns `None` for upstream index HTTP 403/404; `fetch_msg` propagates it.
2. `build_crops` initializes its arrays to NaN. When an expected `fetch_msg` returns `None`, its `cut` worker previously returned silently, leaving that whole message/hour plane missing.
3. The function still saved the crop. `ensure_crops`, `crops_ready`, and `serving_run` use crop existence as the readiness signal, so the incomplete crop was never retried. `daily_building` became false. `load_crop` could also keep the defective array in its LRU.
4. `daily_rows` skips NaNs, leaving null highs/lows even though the day still has cloud/wind/rain values.

A reproduction using these exact production functions and mocked unavailable expected messages confirmed: `ensure_crops=True`, an all-NaN crop written, and zero fetch retries on a second call. The new suite fails five of seven scenarios on the base code and passes all seven with this patch.

This proves a cache-publication/retry defect. It does **not** prove which upstream request failed in the affected production crop: the production `daily_run`, crop arrays, and request logs have not been retrieved. Do not describe a specific NOAA outage or production error as established.

## NOAA evidence: reported missing dates are normal forecast products

Read on 2026-10-01 around 18:35–18:37 UTC from NOAA's current 2026-10-01 12Z CONUS NBM inventory. All four expected plain messages are present, with selectors matching the current code:

- Saturday Oct 3 morning low: f048, `TMIN:2 m above ground:36-48 hour min fcst`
- Saturday Oct 3 high: f060, `TMAX:2 m above ground:48-60 hour max fcst`
- Wednesday Oct 7 morning low: f144, `TMIN:2 m above ground:132-144 hour min fcst`
- Wednesday Oct 7 high: f156, `TMAX:2 m above ground:144-156 hour max fcst`

Sources:
- https://nomads.ncep.noaa.gov/pub/data/nccf/com/blend/prod/blend.20261001/12/core/blend.t12z.core.f048.co.grib2.idx
- https://nomads.ncep.noaa.gov/pub/data/nccf/com/blend/prod/blend.20261001/12/core/blend.t12z.core.f060.co.grib2.idx
- https://nomads.ncep.noaa.gov/pub/data/nccf/com/blend/prod/blend.20261001/12/core/blend.t12z.core.f144.co.grib2.idx
- https://nomads.ncep.noaa.gov/pub/data/nccf/com/blend/prod/blend.20261001/12/core/blend.t12z.core.f156.co.grib2.idx

These inventory files rotate. This checks expected product availability, not the affected production run or a decoded grid point. NOAA documents guidance through 264 hours: https://nomads.ncep.noaa.gov/txt_descriptions/BLEND_txt.html . The configured S3 mirror timed out from this research executor; the authoritative NOMADS inventory above succeeded.

Today's missing morning low on a 12Z run is different: that already-ended minimum window is legitimately absent. The Android patch uses remaining hourly forecasts through the place's midnight and labels the period; it does not require filling that past NBM window.

## Repair behavior

- The existing `nbm_has` schedule stays unchanged. Only messages that the source is expected to publish are required.
- If an expected message is unavailable, collect its name/hour and fail the build before writing any crop. `ensure_crops` reports failure and releases its in-progress lock, allowing the next request or preload pass to retry. The existing preload cadence is 10 minutes; this patch adds no polling loop.
- A downloaded/decoded grid may legitimately contain NaN masks. It is still a completed fetch, so the patch does not confuse masked cells with a missing file.
- Previously verified runs continue serving when present. Without any verified crop, keep the existing building state.
- New NBM crops use `fc_v2_<lat>_<lon>.npz`. Old NBM crops cannot satisfy readiness or collide with a cached `load_crop` key. Cached GRIB files are reused. RRFS crop filenames remain unchanged. The completeness guard itself protects the shared builder for both existing crop sources.
- Do not bump the separate `CACHE_VERSION`; it versions plume JSON, not these forecast crops. No destructive cache purge is required.

## Tests run locally

Passed:
- `python3 -m unittest discover -s extractor -p test_forecast_crops.py`: 7/7
- `python3 -m py_compile extractor/extractor.py extractor/test_forecast_crops.py`
- `git diff --check`

The tests execute unmodified production functions loaded from the AST, with upstream I/O and a tiny grid mocked. They cover missing-message recovery, both 00Z/12Z sparse schedules, legitimate grid NaNs, missing grid failure, prior-run retention, building state, and legacy disk/LRU isolation.

Not run here: the full `extractor/test_fields.py` decoder/render suite, because this executor lacks cv2 and ecCodes. Run it in the existing extractor image before deployment. No production deployment or backend integration pass is claimed.

## Rollout after explicit deployment approval

1. Coordinate this small patch with the other backend owner before applying it. Confirm the deployed revision and inspect the diff against it.
2. Save the affected location's current `/api/forecast` response, `daily_run`, timezone, and missing dates. Inspect that run's existing crop at the expected TMAX/TMIN planes and compare the matching NOAA inventory. This establishes whether the demonstrated failure path caused the production gap.
3. Apply the patch in staging, run the seven offline tests and the existing full extractor `test_fields.py` suite inside the extractor image, then build the replacement extractor image using the existing deployment process.
4. Preserve the data volume. On rollout, v1 NBM crops are intentionally bypassed, so previously requested tiles need one recut; cached raw GRIBs are reused. Allow temporary `daily_building` where no verified v2 crop exists. First forecast requests or `preload_fields` trigger the rebuild. Prewarm affected/saved locations and wait for verified v2 crops before declaring recovery. Leave old crops and raw files in place for the normal cycle-retention cleanup.
5. Fetch fresh responses for the affected coordinates and another saved place. Verify the exact intended run, expected highs/lows, unchanged date/timezone semantics, `daily_building=false` after completion, and no repeated missing-field errors. Check the actual Android daily rows after refresh. Explicit unknowns remain appropriate for truly unavailable point data.
6. Exercise a staged missing expected message: verify no ready crop is created, a prior verified crop remains served (or building remains true), and a later successful request fills the gap.
7. Keep the previous image for rollback. Be aware that rolling back also restores the old readiness defect and may show old incomplete v1 crops. Do not claim the temperature problem is repaired solely because a rollback starts successfully.
