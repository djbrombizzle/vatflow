# VATFLOW navigation data (FAA NASR / CIFP)

Pre-processed US enroute navigation data for route expansion in FCA Builder and Tower Departures.

## Rebuild

```bash
node scripts/build-nav-data.mjs
```

Uses [@squawk/fix-data](https://www.npmjs.com/package/@squawk/fix-data), [@squawk/navaid-data](https://www.npmjs.com/package/@squawk/navaid-data), [@squawk/airway-data](https://www.npmjs.com/package/@squawk/airway-data), and [@squawk/procedure-data](https://www.npmjs.com/package/@squawk/procedure-data) (FAA NASR / CIFP snapshots).

Optional local NASR CSV override:

```bash
node scripts/build-nav-data.mjs --nasr-dir /path/to/CSV
```

Include `FIX.csv`, `NAV.csv`, `AWY.csv`, and optionally `PFR.csv` for preferred routes.

## Files

| File | Purpose |
|------|---------|
| `meta.json` | NASR cycle date, counts, CONUS bbox |
| `fixes.json` | Named fixes → `[[lat, lon], ...]` (multiple candidates when duplicated) |
| `navaids.json` | Navaid identifiers → coordinates |
| `airways.json` | Airway designation → ordered waypoint chain |
| `procedures.json` | SID/STAR identifiers → fix sequences |
| `preferred.json` | `DEP|ARR` → route string (from PFR when available) |

## Runtime

Loaded lazily by `shared/route-engine.js` on first route resolution.

Duplicate fix names are disambiguated by choosing the candidate nearest the previous route anchor.
