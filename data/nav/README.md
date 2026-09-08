# VATFLOW navigation data (FAA NASR / CIFP)

Pre-processed US enroute navigation data for route expansion in FCA Builder and Tower Departures.

## Rebuild

```bash
node scripts/build-nav-data.mjs --faa-cycle 2026-08-06
```

Uses FAA FIX/NAV/PFR CSV for the requested cycle (AIRAC 2608 effective 6 Aug 2026) and @squawk airways/procedures for enroute SID/STAR/airway geometry (56-day CIFP package).

Fallback (prior @squawk-only snapshot):

```bash
node scripts/build-nav-data.mjs
```

Optional local NASR CSV override:

```bash
node scripts/build-nav-data.mjs --nasr-dir /path/to/CSV
```

Include `FIX_BASE.csv` or `FIX.csv`, `NAV_BASE.csv` or `NAV.csv`, `AWY_BASE.csv` or `AWY.csv`, and optionally `PFR_BASE.csv` or `PFR.csv` for preferred routes.

## Files

| File | Purpose |
|------|---------|
| `meta.json` | NASR cycle date, counts, CONUS bbox |
| `fixes.json` | Named fixes → `[[lat, lon], ...]` (multiple candidates when duplicated) |
| `navaids.json` | Navaid identifiers → coordinates |
| `airways.json` | Airway designation → ordered waypoint chain |
| `procedures.json` | SID/STAR identifiers → fix sequences |
| `preferred.json` | `DEP|ARR` → route string (from PFR when available) |
| `sid-runways.json` | ICAO → `{ SID: [runway, ...] }` published runway transitions |
| `runways.json` | ICAO → `[[end, lat, lon, hdgTrue, lengthFt], ...]` runway thresholds |

## Taxi-estimation data

`sid-runways.json` and `runways.json` back the IDST taxi-time estimate and its
departure-runway configuration. They are built separately from the NASR set:

```bash
node scripts/build-sid-runways.mjs     # from procedures.json, no network
node scripts/build-runway-index.mjs    # from OurAirports runways.csv
```

`runways.json` covers every 4-letter ICAO ident worldwide (~7,400 airports,
712 KB raw / ~265 KB gzipped). Coordinates are rounded to 4 decimal places —
about 11 m, far finer than a taxi estimate needs.

Rebuild `runways.json` when airports open, close, or renumber runways; there is
no cycle to track it against. `shared/taxi-runways.js` falls back to fetching
the OurAirports CSV live if the file is missing, so a stale build degrades to
slower rather than broken.

## Runtime

Loaded lazily by `shared/route-engine.js` on first route resolution.

Duplicate fix names are disambiguated by choosing the candidate nearest the previous route anchor.
