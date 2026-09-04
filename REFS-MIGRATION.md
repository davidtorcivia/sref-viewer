# REFS Migration Plan

## Why

**SREF is retired on October 6, 2026 at 12Z** (moved from Aug 31 by the updated
SCN 26-48, July 6 2026). Per NWS Service Change Notice 26-47,
NCEP discontinues NAM, SREF, HREF, HiresW, and NAM MOS on that date. The SPC SREF
plumes endpoint this app scrapes (`spc.noaa.gov/exper/sref/srefplumes/returndata.php`)
will stop receiving new runs.

The replacement is the **Rapid Refresh Forecast System (RRFS)** and its ensemble,
**REFS** (SCN 26-48). REFS is the functional successor for everything this app does:
it is an ensemble, so plumes, means, and percentile bands all still make sense.

- SCN 26-47 (retirements): https://www.weather.gov/media/notification/pdf_2026/scn26-47_Retirement_of_NAM_SREF_HREF_HiresW_NAM_MOS.pdf
- SCN 26-48 (RRFS/REFS implementation): https://www.weather.gov/media/notification/pdf_2026/scn26-48_RRFS_and_REFS_Implementation.pdf
- Real-time RRFS/REFS feeds have been on NOMADS since ~June 9, 2026.

## Key differences to plan around

| | SREF (today) | REFS |
|---|---|---|
| Cycles | 03Z / 09Z / 15Z / 21Z | 00Z / 06Z / 12Z / 18Z (hourly RRFS deterministic) |
| Range | 87 h | ~60 h (ensemble) |
| Cores | ARW + NMB (13 + 13) | Single FV3-based system, time-lagged/perturbed members |
| Point data | SPC plumes JSON endpoint | No plume JSON announced yet; grib2 on NOMADS |

Notes:
- The ARW/NMB core split (and the ARW-vs-NMB band toggle in the UI) has no REFS
  equivalent - that UI concept retires with SREF.
- Run schedule logic in `frontend/js/config.js` (`getLatestRunWithDate`,
  completion-time table) and `backend/server.js` (`validRuns`) must change to the
  REFS cycle times once real availability lag is measured.

## Status: REBUILT 2026-09-03 - deterministic RRFS line + REFS mean/spread band

The extractor now combines two public products from `noaa-rrfs-ops-pds`:

- `rrfs.YYYYMMDD/CC/rrfs.tCCz.bufrsnd.tar.gz`: the deterministic RRFS
  station sounding for the requested station, decoded with debufr as
  before, served as the single member line `RRFS` (hourly to 84h, with
  precip-type flags for the p-type strip).
- `refs.YYYYMMDD/CC/ensprod/refs.tCCz.{mean,sprd}.fHH.conus.grib2`: 2m
  temperature, 10m wind components, 3h APCP and 3h ASNOW pulled by byte
  range via the `.idx` sidecars for f03..f60 and read at the nearest grid
  point with ecCodes (Lambert 1799x1059 grid). The backend turns mean and
  spread into `Mean` points carrying p10/p25/p75/p90 (mean +/- 1.28 and
  0.67 spread; accumulations sum the 3h buckets and their spreads).

Per cycle the extractor pulls ~117MB (tarball) + ~230MB (grib fields),
but stores none of it: the tarball is streamed and only the requested
station plus the default airports (`REFS_HOT_SIDS`) are decoded from it,
and each grib field is decoded in memory at the nearest grid point of
every indexed station, so a cycle leaves a ~5MB point store on disk
(3 days) plus small per-station plume JSON (14 days). A custom station
on a cycle up to 3 days old re-streams the tarball (~10s) and reads the
store; older than that the grib fields are refetched too. The station
index is rebuilt monthly from the tarball headers.

## Previous status: BROKEN since ~2026-08-12 - member BUFR feed withdrawn

Findings from 2026-09-03 (SREF still publishing; REFS 404 for every cycle):

- The experimental `noaa-rrfs-pds/rrfs_a/rrfsens.*` prefix this app read is
  gone. Last cached REFS run on disk is 2026-08-12 06Z.
- NOAA's pre-operational parallel feed moved on 2026-08-14 to a new bucket,
  `noaa-rrfs-ops-pds` (mirrors NOMADS `com/rrfs/para/` and `com/refs/para/`).
- `refs.YYYYMMDD/CC/` on both contains **only `ensprod/`** grib2: `mean`,
  `sprd`, `prob`, `pmmn`, `lpmm`, `avrg`, `eas`, `ffri` for conus/ak/hi/pr.
  **No per-member files exist anywhere on S3 or NOMADS.** The five RRFS
  members are internal to the ensemble product generator.
- Deterministic RRFS does ship station soundings:
  `rrfs.YYYYMMDD/CC/rrfs.tCCz.bufrsnd.tar.gz` (~117MB, 1876 stations, every
  hourly cycle) plus `rrfs.tCCz.class1.bufr` (258MB). The per-station files
  inside (`bufr.744860.YYYYMMDDCC`) decode with the existing `debufr`
  pipeline: 88 forecast times, RPID/T2MS/TP01/SNFL/SNRA present.
- Updated SCN: https://www.weather.gov/media/notification/pdf_2026/scn26-048_RRFS_and_REFS_Implementation.aab.pdf
- Bucket index: https://noaa-rrfs-ops-pds.s3.amazonaws.com/index.html

Repair options considered (options 1+2 were built, see above):

1. **Deterministic RRFS plume** - extractor pulls the 00/06/12/18Z tarball,
   keeps only wanted stations, serves as a single member. Hourly to 84h.
   Loses the ensemble spread; charts render but "Mean" = the one line.
2. **REFS ensprod bands** - fetch `mean` + `sprd` (and `prob` for snow) via
   NOMADS grib_filter subregion around each station, decode with wgrib2,
   show mean +/- spread as bands. No spaghetti; new grib decode path.
3. Both: deterministic line over ensprod band.

Changing `REFS_BUFR_URL` alone cannot fix this - there is no member URL
to point at.

## Status: IMPLEMENTED (July 2026) - via BUFR member soundings (superseded, see above)

Neither path below was used. During implementation we found a better
permanent source: **per-member station sounding BUFR files** (the BUFKIT
feed), published for every RRFS/REFS member. One small (~110KB) file per
station per member per cycle contains the complete hourly 0-60h series -
2m temp (T2MS), 10m wind (U10M/V10M), 1h precip (TP01), 1h snowfall
(SNFL) and snow ratio (SNRA). Five fetches per station-cycle replaces
hundreds of grib_filter requests, and the data is hourly instead of
3-hourly.

Architecture:
- `extractor/` container: NCEPLIBS-bufr (`debufr`) + Python HTTP service.
  Fetches member BUFR files, decodes, serves raw series JSON. Source URL
  is the `REFS_BUFR_URL` env template.
- `backend/server.js`: `/api/refs/:station/:run/:param` shapes raw series
  into the chart JSON format (cumulative totals, 3h buckets, ensemble
  mean) with the same cache/negative-cache logic as SREF.
- Frontend: SREF | REFS model toggle; REFS runs 00/06/12/18Z, members
  M01-M05, single "Members" group instead of ARW/NMB.

Current source (pre-operational): AWS Open Data
`noaa-rrfs-pds/rrfs_a/rrfsens.YYYYMMDD/CC/mNNN/bufr.CC/bufr.SSSSSS.YYYYMMDDCC`

**Post-cutover action (originally Aug 31, 2026):** the experimental `rrfs_a` prefix
will presumably stop updating when REFS goes operational. Switch
`REFS_BUFR_URL` in docker-compose.yml to the prod feed (NOMADS
`com/refs/prod/` or the operational AWS bucket - check layout when it
appears; ecCodes cannot decode these files, NCEPLIBS-bufr is required).

Notes/caveats:
- Snow depth = SNFL (liquid equivalent) x snow ratio (SNRA, 10:1
  fallback when missing/implausible). Unverified against real snow -
  revisit on the first winter event.
- ICAO->BUFR station map in server.js covers JFK/LGA/EWR/BOS; other
  stations can be added after verifying RPID, or queried directly by
  6-digit station number.
- 18Z cycle wasn't observed on the experimental feed at build time; the
  UI handles its absence via negative caching.

## Original migration paths (for reference - superseded)

### Path A - SPC (or another center) publishes a REFS plume product (preferred, low effort)

SPC has not announced a REFS plume viewer as of July 2026, but their SREF/HREF
viewers have historically been rebuilt for successor systems. If a
`returndata.php`-style JSON endpoint appears:

1. Point `fetchFromNOAA()` at the new endpoint, adjust the search/file params.
2. Update run times, member-count threshold (26 -> REFS member count), and
   param names.
3. Remove/repurpose the ARW/NMB toggles (e.g. become "Members" on/off).

**Action: check https://www.spc.noaa.gov/exper/ periodically through August 2026.**

### Path B - Extract point data from NOMADS grib2 ourselves (fallback, more effort)

NOMADS serves REFS with a `grib_filter` CGI that supports variable + subregion
filtering, so per-station downloads are small:

1. New service (or extend backend) that, per run:
   - Requests `ASNOW` (total snowfall), `APCP` (precip), `TMP` 2m, `UGRD`/`VGRD` 10m
     for a ~0.1 deg box around each station, for each REFS member, via grib_filter.
   - Decodes with `wgrib2` (tiny Alpine image) or Python `pygrib`/`cfgrib`.
   - Emits the same `{ member: [{x, y}] }` JSON shape the frontend already consumes -
     the charts, bands, and summaries then work unchanged.
2. Cache aggressively (runs are immutable once complete, same as today).
3. This also unlocks arbitrary lat/lon support instead of only SPC's station list.

## Suggested timeline

- **Now - mid-August 2026**: watch SPC for a REFS plumes product (Path A).
- **Mid-August 2026**: if nothing announced, build Path B; SREF keeps working
  until Oct 6 so there is a comparison window to validate against.
- **After Oct 6, 2026**: SREF endpoints go dark; historical cached runs in
  `data/cache.json` remain viewable.
