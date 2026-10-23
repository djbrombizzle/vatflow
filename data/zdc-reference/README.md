# ZDC Reference data

One JSON file per vZDC SOP, LOA or procedure, used by `zdc-reference.html`
(the private ZDC Reference page). Each file has a `doc` header and a list of
`items`, one per rule or table row. `scripts/build-zdc-reference.mjs` validates
the files and generates `shared/zdc-reference-data.js`. Edit the JSON, then
rebuild and run the tests:

```sh
node scripts/build-zdc-reference.mjs
node scripts/test-zdc-reference.mjs
```

The ZDC center SOP (vZDC-ZDC-P-01J) crossing tables are not in this folder. They
live in `shared/zdc-sop-data.js`, which ZDC Crossings shares.

## Item fields

| Field | Meaning |
|---|---|
| `ref` | Section, paragraph or attachment as printed (`3-2-1`, `Att A`) |
| `cat` | Departure, Arrival, Overflight, Handoff, Airspace, Runway config, Ground, Clearance, Coordination, Frequencies, SFRA, Special use, General |
| `title`, `text` | Short title and a faithful restatement of the rule |
| `restr` | The short answer a controller glances at (`AOB FL290`) |
| `from`, `to` | Giving and receiving facility |
| `dep`, `arr` | ICAO airports the rule applies to as a departure or arrival. A flight matches when either one hits |
| `both` | `true` means departure **and** arrival must both match (city-pair rules) |
| `fixes`, `fixMode` | Route tokens the filed route must contain: fixes, airways, SID/STAR names without the number. `any` (default) or `all` |
| `acft` | `jet`, `prop` (turboprop + piston), `tp`, `pn`, `heli`, or empty |
| `minAlt`, `maxAlt` | Filed altitude band, in feet |
| `fr` | `IFR` or `VFR` when the rule applies to only one of them |
| `flow` | Runway configuration the rule applies to (shown, not matched) |
| `live` | `true` when the rule is about a specific flight and should show on matching live traffic. Live items need at least one of dep/arr/fixes |
| `kw` | Extra search words |
