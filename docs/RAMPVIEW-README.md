# RampView — running it

Ramp radar / ramp control position for VATSIM. Open `rampview.html`; everything
else on this page is about getting an airport's surface geometry into it.

Design notes: [RAMP-CONTROL-PLAN.md](RAMP-CONTROL-PLAN.md) ·
[RAMP-GATE-ASSIGNMENT.md](RAMP-GATE-ASSIGNMENT.md)

## Getting a surface

The page looks for geometry in this order:

1. `data/ramp/<ICAO>.json` — committed by the build. Nothing to do.
2. The browser's IndexedDB cache from a previous fetch on this machine.
3. Nothing — it offers **Fetch surface**, which queries Overpass live and caches
   the result locally.

To commit a field so nobody has to fetch it:

```sh
node scripts/build-ramp-airport.mjs --icao KATL     # queries Overpass
node scripts/build-ramp-airport.mjs --all           # every field in the table
node scripts/build-ramp-airport.mjs --icao KATL --osm /tmp/katl.json   # offline
```

Or run the **Ramp surface data** workflow from the Actions tab, which does the
same thing and commits the output. The build prints a coverage report; stands
without an operator tag or a ramp are listed so an airport either ships or has a
visible to-do list.

Adding an airport means adding its reference point to
`shared/ramp-app-fields.mjs` and writing `data/ramp/overrides/<ICAO>.json`.

## The override file

Geometry always comes from the build. The override file carries only what no
machine-readable source publishes:

| Key | What it is |
| --- | --- |
| `ramps` | Ramp control areas and which concourses each owns. Stamped onto stands automatically |
| `concourses` | Labels, and which are international |
| `operatorBlocks` | Which airlines use which concourses — see the gate spec |
| `standPatches` | Per-stand corrections merged over the built geometry |

`data/ramp/overrides/KATL.json` is the worked example. Its ramp grouping and
frequencies are **placeholders** — correct them before using it for real.

## Using the scope

- **Drag** to pan, **wheel** to zoom, **click** a target or stand to select it.
- **Ramp** selector (or clicking a ramp counter) sets the ramp you're working:
  yours stays at full brightness, everything else dims.
- **Assign** takes a callsign and a stand. A manual assignment is pinned — the
  allocator will never redraw it, only flag a conflict.
- Clicking a stand offers **Close stand**, which takes it out of the draw.
- **Export** downloads the current surface as JSON, ready to commit.

## What the colours mean

Green stand available · red occupied · dashed amber assigned inbound · grey
closed. Cyan targets are arrivals, green departures, amber pushback or holding.
A `?` on a tag means the stand is a prediction, not an observation.

## Tests

```sh
node scripts/test-ramp-alloc.mjs    # the draw: constrained, seeded, spread
node scripts/test-ramp-stands.mjs   # occupancy: no flicker on a 15 s feed
node scripts/test-ramp-osm.mjs      # OSM extraction + the committed overrides
```

## Not built yet

Firebase sync of assignments between controllers, the conflict probe, playback,
and ground-vehicle markers. See the plan for where they fit.
