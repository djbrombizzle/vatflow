# FAA Coded Departure Routes (CDR)

Pre-processed FAA CDR database for the vUSAlink clearance tab.

## Rebuild

```bash
node scripts/build-cdr-data.mjs
```

Reads `data/source/codedswap_db.csv` (the FAA CDR export). Override with
`--csv /path/to/codedswap_db.csv`.

## Layout

The full database is ~41k routes across 180 origin airports — too large to load
eagerly, so it is sharded one file per origin (largest ~115 KB). The client
fetches `index.json` once and then only the origin it needs.

- `index.json` — `{generated, source, routes, prefix}`. `prefix` maps the
  3-letter RCode prefix to its origin ICAO (1:1 across the whole database), so a
  typed code resolves to its shard without an index of every code.
- `<ICAO>.json` — `{ "<DEST ICAO>": [[code, depFix, route, navEqp, coordReq, play], ...] }`

`route` has the implied origin and destination stripped, so it drops straight
into a clearance. The full 8-character code is stored rather than its 2-char
suffix: suffixes repeat across destinations within an origin (2,763 cases), so a
suffix alone does not identify a route.

## Note on length

The longest CDR route string is 176 characters. A clearance wrapping one of
those will exceed the 220-character budget the clearance tab enforces — the
character counter turns red and the send is blocked.
