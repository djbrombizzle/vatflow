# VATFLOW Ramp Control — Design Plan

**Working name:** `rampview.html` (VATFLOW → new "Ramp" nav group)
**Goal:** a browser-based ramp radar / ramp control position for VATSIM that reproduces
the look and workflow of an Aerobahn TaxiView-style surface display, driven entirely by
the public VATSIM datafeed.

> Look-alike, not a clone: we reproduce layout, colour language and workflow. No Saab/Aerobahn
> branding, logos, or proprietary data. Personal-use tool, consistent with the rest of VATFLOW.

---

## 1. What the reference system shows (from the screenshots)

| Element | Screenshot evidence | VATSIM feasibility |
| --- | --- | --- |
| Airport surface map (runways, taxiways, aprons, terminals, numbered stands) | All three | **Yes** — prebuilt GeoJSON from OSM / apt.dat |
| Live aircraft targets with heading, coloured by state | Cyan / green / yellow / red / magenta targets | **Yes** — datafeed lat/lon/hdg/GS |
| Plan-view aircraft silhouettes parked in stands | Img 3 | **Yes** — draw by wake/type category |
| Data tag: callsign + gate + SID/route + time | `DAL1234 / BANNG3`, `SKW3676 C86 21:04` | **Yes** — callsign, flight plan, our own stand match |
| Stand status boxes: gate id, callsign, countdown, `Occupied` | Img 1 (`D32 08:14 Occupied`) | **Yes** — derived stand-occupancy state machine |
| Stand fill colours: red occupied / green available / amber timer | Img 3 | **Yes** — derived |
| Ground vehicles (`DALTUG05`, `OPSS15`, `MEDIC4`, `AIRFF13`) | Img 2 | **Partial** — VATSIM has no vehicles; supported as *manual/observer-entered markers* only |
| Watch-list windows with a count (`NORTH 9`, `SOUTH 3`) | Img 1, 2 | **Yes** — user-defined polygon/filter counters |
| Config banner: active config, departure/arrival runways | Img 1 header | **Yes** — from VATFLOW airport config + ATIS |
| `Mode: Live` / `Mode: Playback  Speed x10` + clock | Img 1, 3 | **Yes** — snapshot recorder + scrubber |
| Arrival Manager list, conflict/stop alert panel | Img 3 left panels | **Yes** — arrival sequence + our conflict engine |
| Menu bar (System / Workspace / Settings / Tools / Reporting / Help), Legend, Search | Img 1 | **Yes** — UI shell |
| Status bar: cursor lat/lon, x/y, range, bearing | Img 1 footer | **Yes** — trivial from projection |

**Not feasible and deliberately out of scope:** real SMR/ASDE fusion, airline gate-planning
feeds, live pushback/handling messages, turnaround milestone (A-CDM) feeds. Everything the
reference system gets from an airport's own systems, we either *derive* from the datafeed or
let the ramp controller *enter by hand*.

---

## 2. Architecture

Follows existing VATFLOW conventions: static page on GitHub Pages, ES modules in `shared/`,
prebuilt JSON in `data/`, Firebase RTDB for multi-controller sync, VATSIM Connect for auth.

```
rampview.html                     page shell (menus, panels, windows)
shared/ramp-scope.js              canvas renderer: pan/zoom, layers, labels, hit-testing
shared/ramp-airport.js            airport surface model loader + local projection
shared/ramp-traffic.js            datafeed poll, target store, dead-reckoning
shared/ramp-stands.js             stand occupancy + turn state machine
shared/ramp-sequence.js           arrival manager, spot/queue watch lists
shared/ramp-conflict.js           alley / pushback / double-book conflict probe
shared/ramp-store.js              Firebase sync: assignments, closures, notes
shared/ramp-playback.js           IndexedDB snapshot ring buffer + scrubber
shared/ramp.css                   scope chrome
data/ramp/index.json              supported airports
data/ramp/KATL.json               surface geometry + stands + spots + areas
scripts/build-ramp-airport.mjs    OSM/apt.dat → data/ramp/<ICAO>.json
scripts/test-ramp-*.mjs           node tests, matching existing test-*.mjs style
```

### 2.1 Rendering

Custom **canvas 2D** scope rather than Leaflet. Reasons: we need metre-accurate stand polygons,
a black non-geographic surface look, thousands of label/silhouette draws at 30 fps, and
declutter rules by zoom. Leaflet's tile/DOM model fights all four.

- One `<canvas>` at `devicePixelRatio`, `requestAnimationFrame` loop.
- **Local ENU projection**: airport reference point → metres east/north (equirectangular with
  cos(lat) scaling; error < 0.1 m across a 10 km field). All geometry is projected once at load.
- View transform = pan (metres) + zoom (px/metre) + optional rotation so the ramp can be
  oriented like the tower's view. Status bar reads back cursor lat/lon, x/y, range, bearing.
- Layers, individually toggleable, drawn back to front: apron fill → terminal buildings →
  stand polygons (status-coloured) → taxiway centrelines + names → runways + hold-shorts →
  areas/watch polygons → parked silhouettes → moving targets + history dots → data tags →
  stand status boxes → alerts.
- **Label declutter**: tags are placed with a leader line, colliding tags fall back to
  short form then to a cluster count. Aerobahn overlaps its labels; ours should not.

### 2.2 Surface data

`scripts/build-ramp-airport.mjs --icao KATL` produces one JSON per airport:

```jsonc
{
  "icao": "KATL", "ref": [33.6367, -84.4281], "magvar": -5.3,
  "runways":  [{ "id": "08L/26R", "poly": [...], "thresholds": {...} }],
  "taxiways": [{ "ref": "B", "line": [[x,y],...], "width": 23 }],
  "aprons":   [ ... ], "buildings": [ ... ],
  "ramps":    [{ "id": "R3", "label": "Ramp 3", "concourses": ["C","D"], "freq": "131.32" }],
  "stands":   [{ "id": "D32", "point": [x,y], "hdg": 271, "poly": [...],
                 "maxWake": "H", "concourse": "D", "ramp": "R3", "operators": ["DAL"] }],
  "spots":    [{ "id": "SPOT 5", "line": [[x,y],[x,y]], "side": "north" }],
  "areas":    [{ "id": "NORTH", "poly": [...], "kind": "watch" }]
}
```

Sources, in order of preference:

1. **OpenStreetMap via Overpass** — `aeroway=runway|taxiway|apron|terminal|parking_position|gate`.
   ATL/DFW/ORD/LAX are mapped stand-by-stand with `ref` tags. This is the primary source.
2. **X-Plane `apt.dat`** rows `1300` (startup location: lat/lon/heading/type) and `1301`
   (aircraft class + operator hints) to fill stand heading, size class and airline where OSM
   lacks it.
3. **Hand-authored overlay** `data/ramp/overrides/<ICAO>.json`, merged last — this is where
   spots, movement/non-movement boundaries, alleys and watch areas live, since OSM does not
   model them.

Stand *polygons* are synthesised where only a node exists: a box sized by `maxWake`, oriented
on the stand heading, anchored at the nose point — exactly how the reference renders them.

Build runs locally or in a `ramp-data.yml` GitHub Action (Overpass is not reachable from the
sandboxed agent proxy, so it must not be a runtime dependency). Output is committed, so the
page loads one static file and works offline.

### 2.3 Traffic pipeline

- Poll `https://data.vatsim.net/v3/vatsim-data.json` every **15 s** (feed cadence), shared
  through one fetch for the whole page; reuse `shared/vatflow-refresh.js` conventions.
- Filter to a bounding box around the field, plus flight plans to/from it for the arrival list.
- **Dead reckoning between polls**: advance each target along its heading at its groundspeed
  each frame, then critically-damped-smooth onto the next real fix. Without this the scope
  visibly teleports every 15 s and stands flicker in and out of `Occupied`.
- Per-target state machine:
  `INBOUND → LANDED → TAXI_IN → IN_BLOCK → TURN → PUSHBACK → TAXI_OUT → HOLDING → DEPARTED`
  driven by GS, altitude AGL, stand containment and runway containment. Hysteresis on every
  edge (e.g. `IN_BLOCK` needs GS < 3 kt for 30 s inside a stand; `PUSHBACK` needs 20 m of
  movement) so a jittery position report cannot toggle a gate.
- Colour by state, matching the reference: green = departure/outbound, cyan = arrival/inbound,
  yellow = holding/attention, red = alert or occupied stand, magenta = manual marker.

### 2.4 Stand occupancy

`ramp-stands.js` answers three questions each tick:

1. **Who is on which stand** — point-in-polygon against stand polys, else nearest stand within
   its size radius. Confidence is downgraded when two stands compete; the tag shows `?`.
2. **How long** — in-block timestamp → the `MM:SS` countdown/count-up in the stand box.
   Turn-time target comes from `data/ramp/<ICAO>.json` defaults, overridable per aircraft.
3. **What is coming** — inbound aircraft are matched to a *predicted* stand from (a) a manual
   assignment made by the ramp controller, else (b) a **seeded random draw** from the stands that
   airline actually uses and that are open and size-compatible, else (c) unassigned. Predicted
   stands render hatched, not solid, so a prediction is never mistaken for truth.

Inbound tags carry the **ramp number** ahead of the gate — `DAL1438 R1/T12` — because the ramp is
what says whose aircraft it is. Ramps are defined once per airport and stamped onto stands from
their concourse; a controller selects the ramp they work and everything outside it dims.

Stand box colour: **green** free, **amber** assigned/inbound with ETA, **red** occupied,
**flashing red** conflict (see below), **grey** closed by the controller.

Full subsystem spec — provenance tiers, the deterministic allocator, occupancy hysteresis and the
VATSIM-specific edge cases: **[RAMP-GATE-ASSIGNMENT.md](RAMP-GATE-ASSIGNMENT.md)**.

### 2.5 Sequencing, watch lists, arrival manager

- **Watch lists** (`NORTH 9`) are user-defined: a saved filter — polygon area, state, runway,
  concourse, operator — rendered as a small draggable window with a live count and, on click,
  the matching strip list. Saved per user in `localStorage`, shareable via the room.
- **Spot list**: aircraft in `TAXI_OUT` ordered by distance to their assigned spot, showing
  spot, SID, runway. This is the core ramp-controller product: who to release next.
- **Arrival Manager**: inbounds within ~40 NM ordered by ETA, showing runway, exit, predicted
  stand and gate-availability flag — the left panel in image 3.

### 2.6 Conflict probe (`ramp-conflict.js`)

Ramp-relevant, cheap, and deliberately conservative:

- **Stand double-book** — assigned stand occupied within the arrival's ETA window.
- **Alley conflict** — two targets converging within an alley polygon with closure < 60 s.
- **Pushback into flow** — a stand entering `PUSHBACK` while another target is inside the
  pushback envelope behind it.
- **Wake/size violation** — aircraft type exceeds the stand's `maxWake`.
- **Spot overload** — more than *n* aircraft queued to one spot.

Each produces a strip in the alert panel with time-to-conflict, matching the reference's
`Conflict / stop` list. Alerts are advisory; nothing is auto-actioned.

### 2.7 Multi-controller sync

Firebase RTDB under a new `ramp/<ICAO>/…` namespace (assignments, stand closures, tow markers,
manual notes, shared watch areas), following the existing `rooms/` pattern in
`database.rules.json` — the rules file needs a matching authenticated, validated node added.
Read is public/view-only; **writes require the VATSIM Connect session** (`shared/vatflow-auth.js`)
plus the existing controller unlock (`shared/vatflow-control-store.js`). Last-write-wins per
stand, with the writing CID and timestamp shown on hover.

### 2.8 Playback

Every datafeed snapshot, trimmed to the field, is appended to an IndexedDB ring buffer
(~6 h at ~40 KB/snapshot ≈ 60 MB, capped and pruned). Playback mode replays snapshots through
the same renderer with a scrubber and x1/x2/x5/x10 speeds, exactly as image 3. Recording keeps
running in Live mode so "what just happened at D3" is always answerable.

---

## 3. UI shell

Reproduce the chrome, because it is what makes it read as a ramp position:

- **Title bar**: `VATFLOW Ramp :: RampView :: Hartsfield–Jackson Atlanta International`.
- **Menu bar**: System · Workspace · Settings · Tools · Reporting · Help, plus Legend,
  Playback, Pause, Search — each a real, small feature (Workspace = save/restore window layout;
  Reporting = CSV export of turn times and spot releases; Search = callsign/stand jump).
- **Config banner**: active airport config and departure/arrival runways, seeded from the ATIS
  text in the datafeed and overridable.
- **Mode strip**: `Mode: Live | 03/22/2025 21:08:43 EDT` right-aligned.
- **Floating windows**: watch lists, arrival manager, alerts — draggable, dockable, closable,
  layout persisted.
- **Status bar**: cursor lat/lon, x/y metres, range and bearing from the reference point.
- Dark scope palette on near-black; monospace tags; VATFLOW's existing `--amber` accent for
  chrome so it still belongs in the suite.

---

## 4. Delivery phases

| Phase | Scope | Done when |
| --- | --- | --- |
> **Ground use:** the whole-field view exists so ground controllers can see which ramp each
> arrival is headed for and hand it to the right one — routing lines coloured by ramp, the
> entry spot on the tag, and a Ground / Ramp Entry list carrying ramp, frequency, spot and gate.
>
> **Build status (this branch):** P0–P4 are implemented — build script, canvas scope,
> traffic pipeline with dead reckoning, stand occupancy, the seeded draw, ramp numbers,
> arrival manager and spot list. P5 (conflict probe), P6 (Firebase sync) and P7 (playback)
> are not started. Running notes: [RAMPVIEW-README.md](RAMPVIEW-README.md).

| **P0 — Data** | `build-ramp-airport.mjs`, `data/ramp/KATL.json`, overrides format, unit tests | KATL geometry validates: every stand has id, heading, polygon |
| **P1 — Scope** | Canvas renderer, projection, pan/zoom/rotate, layers, status bar | KATL surface renders and navigates at 60 fps |
| **P2 — Targets** | Datafeed poll, dead reckoning, state machine, tags, silhouettes | Live traffic moves smoothly, tags legible at ramp zoom |
| **P3 — Stands** | Occupancy, timers, stand boxes/colours, manual assignment | Stand boxes match reality during a live ATL bank |
| **P4 — Position** | Spot list, arrival manager, watch lists, config banner | A controller can run a bank from the page alone |
| **P5 — Alerts** | Conflict probe + alert panel | Probes fire on replayed real scenarios, no false storm |
| **P6 — Shared** | Firebase sync, auth gating, rules update | Two browsers agree on assignments and closures |
| **P7 — Playback** | Recorder, scrubber, speeds, CSV reporting | 6 h replay of an event, x10, no frame drops |
| **P8 — Fleet** | Second/third airport (KDFW, KCLT), nav + README + how-to page | New airport added by running one build command |

P0–P3 is the demonstrable core; ship that first behind the nav as "Ramp (beta)".

---

## 5. Key risks and the decisions that answer them

| Risk | Decision |
| --- | --- |
| 15 s feed makes gate state flicker | Dead reckoning + hysteresis on every state edge; never trust a single sample |
| OSM stand coverage is uneven | Build script reports coverage; `overrides/` file is a first-class, supported input, not a hack |
| Pilots park off-stand / on the taxiway | Nearest-stand match has a hard radius; unmatched aircraft show as `RAMP` not a wrong gate |
| Predicted vs actual stand confusion | Different fill (hatched vs solid) and an explicit `?` on the tag |
| Playback storage growth | Ring buffer with a hard cap and age prune, same policy as the taxi-monitor history |
| Looking like a certified system | Persistent "simulation / VATSIM only — not for real-world use" footer, as elsewhere in VATFLOW |
| Overpass unavailable at runtime | It is a build-time dependency only; the page ships static JSON |

---

## 6. Open questions for you

1. **First airport** — KATL (matches the screenshots) confirmed, and which two after?
2. **Ground vehicles** — leave as manual markers, or skip entirely for v1?
3. **Write access** — VATSIM Connect + controller unlock, or should ramp writes be open to
   anyone in the room during an event?
4. **Scope rotation** — do you want the tower-view rotation, or always north-up?
