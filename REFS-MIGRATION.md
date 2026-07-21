# REFS Migration Plan

## Why

**SREF is retired on August 31, 2026 at 12Z.** Per NWS Service Change Notice 26-47,
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

## Status: IMPLEMENTED (July 2026) - via BUFR member soundings

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

**Post-cutover action (Aug 31, 2026):** the experimental `rrfs_a` prefix
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
  until Aug 31 so there is a comparison window to validate against.
- **After Aug 31, 2026**: SREF endpoints go dark; historical cached runs in
  `data/cache.json` remain viewable.
