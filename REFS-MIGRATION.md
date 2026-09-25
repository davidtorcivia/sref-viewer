# REFS Migration

## Why

**SREF is retired on October 6, 2026 at 12Z** (SCN 26-47, date moved from Aug 31
by the updated SCN 26-48). NCEP discontinues NAM, SREF, HREF, HiresW and NAM MOS
that day, so the SPC plume endpoint this app reads
(`spc.noaa.gov/exper/sref/srefplumes/returndata.php`) stops getting new runs.

The successor is **REFS**, the ensemble of the Rapid Refresh Forecast System (RRFS).

- SCN 26-47 (retirements): https://www.weather.gov/media/notification/pdf_2026/scn26-47_Retirement_of_NAM_SREF_HREF_HiresW_NAM_MOS.pdf
- SCN 26-48 (RRFS/REFS): https://www.weather.gov/media/notification/pdf_2026/scn26-048_RRFS_and_REFS_Implementation.aab.pdf

| | SREF | REFS |
|---|---|---|
| Cycles | 03Z / 09Z / 15Z / 21Z, ready ~5h20m later | 00Z / 06Z / 12Z / 18Z, ready ~3.5h later |
| Range | 87 h | 60 h ensemble products; deterministic RRFS to 84 h |
| Members | 26 (ARW + NMB cores) | not published: only ensemble products |
| Point data | SPC plume JSON | none: extracted by `extractor/` |

## What the app does

NOAA publishes **no per-member REFS files** (neither on S3 nor NOMADS), so the
REFS view combines two public products from the `noaa-rrfs-ops-pds` bucket:

- `rrfs.YYYYMMDD/CC/rrfs.tCCz.bufrsnd.tar.gz` (~117MB, ~1900 stations): the
  deterministic RRFS station sounding, decoded with NCEPLIBS-bufr's `debufr`
  and shown as the single `RRFS` line (hourly to 84h, with precip-type flags
  for the p-type strip). ecCodes cannot decode these files.
- `refs.YYYYMMDD/CC/ensprod/refs.tCCz.{mean,sprd}.fHH.conus.grib2`: 2m
  temperature, 10m wind, 3h APCP and 3h ASNOW, pulled by byte range via the
  `.idx` sidecars for f03..f60 and read at the nearest grid point with ecCodes.
  The backend turns mean and spread into `Mean` points carrying p10/p25/p75/p90
  (mean +/- 1.28 and 0.67 spread; accumulations sum the 3h buckets and their
  spreads).

Nothing raw is stored: the tarball is streamed and only the requested station
plus the default airports (`REFS_HOT_SIDS`) are decoded; each grib field is
decoded in memory at every indexed station. A cycle leaves a ~5MB point store
(3 days) and small per-station plume JSON (14 days). A custom station on a
cycle up to 3 days old re-streams the tarball (~10s) and reads the store.

## Open items

- **Operational source**: the extractor reads the pre-operational
  `noaa-rrfs-ops-pds` bucket. If NOAA moves REFS elsewhere at or after the
  cutover, point `RRFS_TAR_URL` / `REFS_GRIB_URL` (see `extractor/extractor.py`)
  at the new location in `docker-compose.yml`.
- **Snow ratio**: RRFS snow depth is SNFL (liquid equivalent) x SNRA (10:1
  fallback when missing or implausible). Unverified against real snow; revisit
  on the first winter event.
- **Retiring SREF entirely**: once its last cached runs age out (~Oct 20, 2026)
  the SREF model, its route and the ARW/NMB UI can be removed.

## History

- July 2026: first REFS support read per-member BUFR soundings from the
  experimental `noaa-rrfs-pds/rrfs_a/rrfsens.*` feed.
- ~Aug 12 2026: that feed was withdrawn; the parallel feed moved to
  `noaa-rrfs-ops-pds` with ensemble products only.
- Sep 3 2026: rebuilt as the deterministic RRFS line + REFS mean/spread band
  described above.
