# Ramp Management — plan

**Status:** proposal / planning. Nothing is built yet.
**Origin:** user-submitted idea (quoted below), with a UI concept mock-up. The mock-up's airport is not real; it only shows the layout and features.
**First test field:** KCVG, the Amazon and DHL cargo ramps, transcribed from the user-supplied ramp charts. Seed data is in [`data/ramp/KCVG.json`](../data/ramp/KCVG.json).

> A useful VatFlow addition would be a ramp/gate management tool for facilities with controlled terminal and/or cargo ramps. It could show aircraft and gate/stand assignments, track basic states such as inbound, parked, pushing, or taxiing out, and include a push-hold queue that preserves call order when departures need to be metered. For arriving aircraft that would normally receive parking from company ops by radio or ACARS, VatFlow could use its existing Hoppie integration to send ramp or gate assignments directly, improving situational awareness and reducing unnecessary frequency coordination.

---

## 1. What we are building

A new page, **Ramp** (`ramp.html`). It is one shared picture of a controlled ramp:

| Area (per the mock-up) | What it does |
| --- | --- |
| **Ramp map** | Every stand on the selected ramp(s), coloured by state: empty, assigned/reserved, occupied, push requested, push held. Aircraft icons use the live VATSIM position. |
| **Counters** | Inbound · Parked · Push Req · Push Held. |
| **Flights table** | Callsign, type, from→to, ramp/stand, status, ETA/ATD. Filter tabs and search. |
| **Selected flight** | Change stand, mark parked, send to ground, hold/release push. Also **Send ramp assignment via Hoppie**. |
| **Push queue** | Departures in **call order**. Hold toggle per aircraft, and "auto sort by call order". |
| **Left rail** | Airport picker, ramp filter (All / Terminal / DHL / Amazon), display toggles, legend. |

It is **shared across controllers**, the same way the IDST runway/SID config is today. Whoever works KCVG ramp, ground, or tower sees the same assignments and the same queue. Observers get a read-only view.

---

## 2. How it fits what VATFLOW already has

| Existing piece | Reused for |
| --- | --- |
| **vatflow-hub** (Railway, `DEFAULT_HUB_URL`) | Shared ramp state, the permission check, and the Hoppie send path. A browser cannot reach Hoppie directly; that is why the hub exists. |
| `shared/taxi-config-store.js` pattern | Model for `shared/ramp-store.js`. Synchronous reads against a cache, optimistic writes, hub is the authority, localStorage mirror for reloads and hub outages. |
| Hub permission model (`/taxi/permissions`) | Same live-position check, but narrower: only a controller on position at the field as **`_RMP`, `_GND`, or `_TWR`** can assign stands or work the queue. There are no ARTCC-editor writes and no company-ops role. Everyone else is read-only. |
| vUSAlink hub `/hub/send`, `/hub/poll` | Telex uplink of stand assignments, and reading pilot telex requests ("REQ STAND", "REQ PUSH"). |
| `shared/vusalink-clearance.js` style | DOM-free message composer (`shared/ramp-messages.js`) with the same 220-char Hoppie budget and unit tests. |
| `shared/taxi-estimate.js` + IDST RDY / FCA | The push queue shows the frozen release time (CFR/EDCT) and a **suggested push time = release − taxi estimate**. |
| `shared/vatflow-basemap.js` (Leaflet + OpenFreeMap) | Geo view of the ramp. OSM already draws the aprons and buildings at KCVG. |
| `shared/vusalink-test-traffic.js`, `record-vatsim-feed.mjs`, swim2vice demo feed | An offline **demo/test mode** that replays a scripted KCVG cargo bank (see §8). |
| `shared/vatflow-nav.js` | Nav entry under **Airport TMU → Ramp Management** (next to Runway Balancer). |

---

## 3. Stand data (the part that needs per-airport work)

### 3.1 Schema — `data/ramp/<ICAO>.json`

```jsonc
{
  "icao": "KCVG",
  "version": 1,
  "ramps": [
    { "id": "DHL-N", "name": "DHL North Ramp", "group": "DHL",
      "polygon": [[lat, lon], ...],          // ramp area: occupancy + "left the ramp" detection
      "exits": ["N"],                         // spots / exit points, shown as N / S markers
      "operators": ["DHL"] }
  ],
  "stands": [
    { "id": "65", "ramp": "DHL-N",
      "lat": 39.05, "lon": -84.66, "hdg": 180,  // nose-in heading; push direction is derived from it
      "maxCode": null,                          // reserved for size checks (ICAO code letter); unused for now
      "taxiOut": "N",                           // optional: can also taxi straight out here instead of pushing
      "blocks": ["56"],                         // stands that cannot be used at the same time
      "pushTo": "TWY-A",                        // optional push-back instruction text
      "tags": ["power", "deice"] }
  ],
  "positions": [                              // who controls what, and on which frequency
    { "id": "AZN_RMP", "name": "Amazon Ramp Control", "freq": "130.500", "owns": ["AZN"] }
  ],
  "callSpots":  [{ "id": "74", "on": "N", "serves": "C" }],   // numbered handoff points out of the ramp
  "deiceSpots": [{ "id": "N1-2", "taxilane": "C" }],
  "operators": {                               // who normally parks where
    "DHL":    { "match": ["DHK", "BCS", "DAE"], "ramps": ["DHL-N", "DHL-S", "DHL-MAIN"] },
    "Amazon": { "match": [],                  "ramps": ["AZN"] },
    "shared": { "match": ["ABX", "ATN", "GTI", "SCX"],
                "ramps": ["DHL-N", "DHL-S", "DHL-MAIN", "AZN"] }
  }
}
```

**Operator mapping is ambiguous by design.** ABX, ATN (ATI), GTI (Atlas), and similar carriers fly for both DHL and Amazon. So the tool uses this order:
1. flight plan remarks (`AMAZON`, `PRIME AIR`, `DHL`)
2. the callsign match lists
3. **ask the controller**. The flight shows "ramp ?" until someone picks one.

**Stands and call spots are separate ID spaces.** At KCVG, DHL stands 55–59 and 65 share numbers with call spots 55–59 and 65. The page labels them "stand 57" and "spot 57". Every uplink says STAND or SPOT in full, never a bare number.

### 3.2 Where the stands come from

1. **OpenStreetMap import (primary).** `scripts/build-ramp-stands.mjs` queries Overpass for `aeroway=parking_position` (with `ref`) and `aeroway=apron` inside the airport boundary. It writes a draft `data/ramp/KCVG.json` with real coordinates. KCVG's cargo aprons are mapped in OSM. We need to check how complete the stand refs are.
2. **The user-supplied CVG ramp charts** (Amazon and DHL) are already transcribed into `data/ramp/KCVG.json` (see §8). Every stand has **chart pixel x/y** for the schematic view. The Amazon chart is evenly gridded in both lat and lon (about 1.7 m per pixel), so **Amazon stands and spots already have approximate lat/lon**, good to roughly ±20 m. DHL `lat`/`lon` stay `null` for now, because its grid spacing is uneven.
3. **Built-in stand editor** (`ramp.html?edit=1`, editors only). Click the basemap to add or move a stand, set its heading, code, and blocks, then export JSON for a PR. This way a new airport never needs hand-edited coordinates.

Later: import EuroScope GroundRadar stand files where a vACC/ARTCC already maintains them.

---

## 4. Aircraft state machine

Most of the state is derived from the VATSIM feed. The controller only sets the states a feed cannot see (push requested, held, approved).

```
ARRIVALS                                              DEPARTURES
INBOUND ── (on ground, <40 kt) ──► TAXI IN            PARKED (has flight plan out)
   │  stand assigned: ASSIGNED                           │  pilot calls, or telex "REQ PUSH"
   ▼                                                     ▼
TAXI IN ── (gs≈0 within ~35 m of a stand) ──► PARKED  PUSH REQ ─► PUSH HELD ⇄ PUSH REQ
                                                          │ controller approves
                                                          ▼
                                                        PUSHING (moving, heading ≈ stand hdg+180)
                                                          │ taxi speed on a ramp taxilane
                                                          ▼
                                                        RAMP TAXI ─► (DE-ICE at N1-1…N4, optional)
                                                          │ reaches call spot 71–76
                                                          ▼
                                                        AT SPOT ─► handed to N taxilane / ground
                                                          ▼
                                                        TAXI OUT ─► (airborne) removed
```

- **Call spots are the ramp's boundary.** At KCVG, Amazon Ramp (130.5) runs the Amazon ramp out to spots 71–74. From there, N taxilane (130.375) belongs to **DHL Ramp**. DHL Ramp hands aircraft to ground at the outer spots (51, 52, 54, 55 on S, and 75/76 on D). The inbound flow is the reverse: the aircraft enters at a spot and is given its stand. So the stand uplink should name the entry spot (for C-row stands, spot 74 via taxilane C).
- **Occupancy:** nearest stand within a radius. A stand is occupied if any on-ground aircraft sits there, even one we never assigned. That catches pilots who park at the wrong spot. A **"wrong stand"** badge shows if it differs from the assignment.
- **Taxi-out stands:** where a stand has `taxiOut` (DHL 50–55), leaving forward counts the same as pushing. The page doesn't expect a reversed heading there, and the controller approves it the same way ("push/taxi approved").
- **Conflicts:** assigning a stand that is occupied, or blocked by an occupied `blocks` neighbour, gives a warning. The controller can override. **Aircraft size checks are deferred.** `maxCode` stays in the schema, but nothing reads it yet.
- **Auto-suggest:** the next free stand on the operator's ramp that fits the type. It prefers stands without blocked neighbours.
- **Reservations expire:** an assignment for an inbound that disconnects is released after N minutes (configurable). This matches how the taxi monitor treats closed tracks.

All of this goes in a DOM-free module, `shared/ramp-state.js`, and is unit-tested like `taxi-estimate.js`.

---

## 5. Push-hold queue (metering)

- **Call time** is stamped when the aircraft enters PUSH REQ. The controller can click, or a pilot telex `REQ PUSH` sets it automatically, using the message timestamp. The queue sorts by call time and **never reorders on its own**. Holding an aircraft keeps its place in line.
- **Metering controls:** "ramp hold all" (a ground stop for the ramp), plus an optional **push rate** (N per 5 min, or minimum spacing in seconds). The next eligible aircraft is highlighted as **READY**, and the rest show their expected wait.
- **Flow tie-in:** if the aircraft has a frozen release time in an active FCA (IDST RDY), the row shows it plus a suggested push time = release − taxi estimate. That estimate comes from the shared runway/SID config, so the ramp does not push someone 20 minutes early.
- **Manual reorder** is allowed (drag), but it is logged ("moved by KCVG_RMP") and shown with an icon, so call order is never changed silently.
- The queue lives on the hub, so a ground controller and a ramp controller at the same field work the same list.

---

## 6. Hoppie delivery (stand assignments to pilots)

### 6.1 Uplink
Assignments go as a **telex** (company-ops style, not a CPDLC clearance). So the pilot does **not** have to be logged on to KUSA CPDLC, only connected to Hoppie with an ACARS client.

- **From-station:** the field's Hoppie logon, **`KCVG`** for the test, sent by the hub. Controllers never handle a Hoppie logon code, same as vUSAlink.
- **Composer** (`shared/ramp-messages.js`, max 220 chars):
  - `KCVG AMAZON RAMP: PARK STAND C07. ENTER RAMP AT SPOT 74 VIA TAXILANE C. CTC AMAZON RAMP 130.5 AT SPOT 74.`
  - `KCVG AMAZON RAMP: STAND CHANGE. NEW STAND A03 VIA SPOT 72 TAXILANE A.`
  - `KCVG DHL RAMP: PARK STAND 21. ENTER AT SPOT 54 VIA N, DHL 2. CTC DHL RAMP 129.475.`
  - `KCVG RAMP: PUSH EXPECTED AT 1847Z. YOU ARE NUMBER 3. REQ PUSH WHEN READY.`
- **Send options:** a manual **Send** button (default), or optional **auto-send on stand assignment** or **when the inbound is within X min**. Nothing goes out by surprise.
- **Receipt:** telex has no delivery acknowledgement. The row shows **SENT hh:mmZ** and, if the pilot replies by telex, **ACK**.
- **CPDLC-connected aircraft** (on vUSAlink): same text, and vUSAlink shows it in that aircraft's message log. The pilot only receives it once.

### 6.2 Downlink (pilot → ramp)
The hub polls the ramp station and parses free text:
- `REQ STAND`, `REQ GATE`, `REQ PARKING` → flag the inbound as "requests stand"
- `REQ PUSH`, `READY PUSH`, `RDY FOR PUSH` → PUSH REQ, with call time = message time
- anything else → shown in the flight's message log

### 6.3 Hub work (outside this repo)
- `POST /ramp/state?icao=` (read), `/ramp/assign`, `/ramp/queue` (writes, permission-checked like `/taxi/config`)
- `POST /ramp/send`: composes or validates the text, sends the telex, **rate-limited** per field and per aircraft
- telex poll for the ramp stations, feeding the downlink parser
- **Confirm with Hoppie's owner** that per-field ramp telex stations and the expected message volume are OK. The KUSA hub approval covered CPDLC.

---

## 7. vUSAlink and other hubs

- **vUSAlink / EDST ground list:** add a **STAND** column, and colour it for push state. A controller working CPDLC clearances sees where the aircraft is parked.
- **DCL → push:** after a DCL WILCO in vUSAlink, the Ramp page can prompt "push next?". The two stay separate; neither sends for the other.
- **CPDLC Map / IDST:** show the stand and push state as a tag on ground aircraft.
- **Other hubs / external clients:** publish a read-only `GET /ramp/public?icao=` (stand + state per callsign). Pilot-side tools, a vACC site, or a Discord bot can then show "your stand is DHL 21" without Hoppie.

---

## 8. Test model — KCVG Amazon + DHL ramps

Both charts are transcribed in `data/ramp/KCVG.json`. That is **128 stands, 15 call spots, 6 de-ice spots, and 2 ramp positions**. Each stand and spot carries the chart it came from plus its pixel x/y on that chart, so the page can draw each ramp as its own schematic.

### Amazon Ramp (chart `AZN`) — 33 stands

| Item | Contents |
| --- | --- |
| Stands | **A01–A10**: east row along the Amazon building, pushing onto taxilane A. **B01–B08**: centre row, pushing onto **C**. **C01–C15**: west row, pushing onto C. |
| Taxilanes | A, B, C run north–south, with cross-lanes 1, 2, and 3. B ends at cross-lane 2. |
| Call spots | **71** (lane 1), **72** (A), **73** (B), **74** (C) on N taxilane. **75** at N/D, **76** on D near D1. |
| De-ice spots | N1-1, N1-2 (taxilane C) · N2-1, N2-2 (B) · N3 (A) · N4 (lane 1) |
| Position | **Amazon Ramp Control 130.5** |

### DHL (chart `DHL`) — 95 stands

| Ramp | Stands | Pushes onto |
| --- | --- | --- |
| DHL North Ramp | 56–65 | DHL 6 |
| DHL Ramp | 50–55 | push onto DHL 6, **or taxi straight out to N** (`taxiOut: "N"`) |
| DHL 3 / DHL 4 | 39–49, with A/B suffixes, and 42 | DHL 3 or DHL 4 |
| DHL Main Ramp | 25–38 (with 35A/B, 36A/B, 37A) west of DHL 2, 16–24 east of DHL 2 | DHL 2 / DHL 3 |
| DHL Sort (Bldg 2) | 3, 3A, 4, 4A, 5 | DHL 1 |
| DHL South Ramp | 1, 2, 6–15, 15A, 101–108 | DHL 5 / DHL 7 / DHL 1 |
| DHL Hangar | MX1–MX3 (maintenance; never auto-assigned) | DHL 7 |

- **Call spots:** 51, 52, 54, 55 on taxiway S (to RWY 18L/36R). 56 (DHL 2), 57 (DHL 3), 58 (DHL 4), and 59 (DHL 6) on N. 65 at the west end of N, toward the Amazon side.
- **Position:** **DHL Ramp Control 129.475**, which also works **N taxilane on 130.375**.
- **Geo reference:** unlike the Amazon chart, this chart has both lat and lon grid lines. They are stored in `charts.DHL`, so a script can derive approximate stand coordinates. The chart is not to scale between grid lines, so treat those as a first guess for the stand editor to correct, not as occupancy-grade positions.

### How the test runs

- **Correction to the mock-up:** its "Amazon Ramp 71–75" row shows **call spots** as parking stands. The real stands are the A/B/C rows. The page draws spots as numbered circles, as the charts do.
- **Two-controller handoff:** `AZN_RMP` works the Amazon ramp, stand → spot 71–74, then hands the aircraft to `DHL_RMP` on N taxilane. `DHL_RMP` owns its own push queue and N taxilane, and hands to ground at the outer spots. An Amazon departure appears on DHL Ramp's list as "at spot 7x".
- **Telex station:** everything goes out from the Hoppie logon **`KCVG`**.
- **Still to verify on the DHL chart:** nose direction for every DHL stand, and the push lane for stand 42.

1. **Data:** schematics from both charts (done), then OSM import (plus the DHL chart grid) for lat/lon and the ramp polygons, then a check in the stand editor.
2. **Demo mode** (`ramp.html?demo=KCVG`): a scripted cargo bank across both operators (about 25 aircraft), including stands 50–55 taxiing straight out to N. Inbounds on final, taxi-ins, parked, and departures calling for push. Built like the vUSAlink test traffic, so the page can be tested with no one online. Hoppie sends in demo mode go to a local log, never the network.
3. **Live test:** a KCVG event or a quiet session with a few pilots on Hoppie. Check: stands auto-detected correctly, telex received and understood in real ACARS clients, queue order held under pressure.
4. **Unit tests** (`scripts/test-ramp-*.mjs`, same runner as the existing tests):
   - state machine transitions from recorded feed snapshots
   - stand occupancy / wrong-stand / blocked-neighbour / size checks
   - queue: call-order stability across holds and releases, rate metering, manual moves logged
   - message composer length budget and downlink parser

---

## 9. Phases

| Phase | Scope | Result |
| --- | --- | --- |
| **0 — Data** | Schema, OSM import script, KCVG draft, stand editor | KCVG stands on a map |
| **1 — Read-only board** | `ramp.html`, live feed, derived states, map + flights table, demo mode | Useful picture with no writes |
| **2 — Shared control** | Hub `/ramp/*`, `ramp-store.js`, assignments, push queue + holds, permissions | Multi-controller ramp management |
| **3 — Hoppie** | Telex uplink, downlink parsing, send log, rate limits | Stand assignments reach pilots |
| **4 — Integrations** | vUSAlink STAND column, IDST/FCA release tie-in, public read endpoint | One consistent picture across tools |
| **5 — More fields** | Terminal gates (same schema), other cargo hubs (e.g. KMEM, KSDF, KONT, PANC) | Generalised tool |

Phases 0–1 need no hub changes and can ship first.

---

## 10. Decisions and open questions

**Decided:**
- **Aircraft size checks are deferred.** Any aircraft can be assigned any stand for now.
- Amazon B-row stands push onto taxilane C.
- DHL stands 50–55 push onto DHL 6 or taxi straight out to N.
- N taxilane (130.375) is worked by DHL Ramp. There is no separate N taxilane position.
- **Only `_RMP`, `_GND`, and `_TWR` on position may assign stands** or work the push queue. There is no company-ops role. So a ramp with none of those positions online is read-only: the board still shows derived states, but no stands are assigned and no telex is sent.
- The test telex station is the Hoppie logon `KCVG`.

**Open:**
1. **DHL stand 42:** does it push onto DHL 3 or DHL 4?
2. **Auto-send default:** off (manual Send only) is proposed for launch.
