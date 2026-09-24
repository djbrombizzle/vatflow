# Ramp Management — plan

**Status:** proposal / planning. Nothing is built yet.
**Origin:** user-submitted idea (quoted below), with a UI concept mock-up. The mock-up's airport is not real; it only shows the layout and features.
**First test field:** KCVG Amazon Ramp, from the user-supplied CVG Amazon ramp chart. Seed data is in [`data/ramp/KCVG.json`](../data/ramp/KCVG.json). The DHL ramps come next.

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
| Hub permission model (`/taxi/permissions`) | Same rule: you can write if you are on position for the field (`KCVG_RMP`, `_GND`, `_TWR`, `_DEL`) or are an ARTCC editor (ZID). Everyone else is read-only. |
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
      "maxCode": "E",                           // ICAO aerodrome ref code (wingspan): B763 = D, B744/B748 = E, B77L = E
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

### 3.2 Where the stands come from

1. **OpenStreetMap import (primary).** `scripts/build-ramp-stands.mjs` queries Overpass for `aeroway=parking_position` (with `ref`) and `aeroway=apron` inside the airport boundary. It writes a draft `data/ramp/KCVG.json` with real coordinates. KCVG's cargo aprons are mapped in OSM. We need to check how complete the stand refs are.
2. **The CVG Amazon ramp chart** (user-supplied) is already transcribed into `data/ramp/KCVG.json`: 33 stands, 6 call spots, 6 de-ice spots, and 2 control positions (see §8). Stand positions are **chart pixel x/y**, enough for the schematic view. `lat`/`lon` stay `null` until the OSM import or the stand editor fills them. The chart shows no longitude grid, so it cannot be georeferenced by itself.
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
                                                        AT SPOT ─► handed to Taxilane N / ground
                                                          ▼
                                                        TAXI OUT ─► (airborne) removed
```

- **Call spots are the ramp's boundary.** At KCVG, Amazon Ramp (130.5) runs the ramp out to spots 71–74. Taxilane N Control (130.375) takes over from there, then ground. The inbound flow is the reverse: the aircraft enters at a spot and is given its stand. So the stand uplink should name the entry spot (for C-row stands, spot 74 via taxilane C).
- **Occupancy:** nearest stand within a radius. A stand is occupied if any on-ground aircraft sits there, even one we never assigned. That catches pilots who park at the wrong spot. A **"wrong stand"** badge shows if it differs from the assignment.
- **Conflicts:** assigning a stand that is occupied, blocked by an occupied `blocks` neighbour, or too small (`maxCode`) gives a warning. The controller can override.
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

- **From-station:** the field ramp station (for example `KCVG` or `CVGRMP`), sent by the hub. Controllers never handle a Hoppie logon code, same as vUSAlink.
- **Composer** (`shared/ramp-messages.js`, max 220 chars):
  - `KCVG AMAZON RAMP: PARK STAND C07. ENTER RAMP AT SPOT 74 VIA TAXILANE C. CTC AMAZON RAMP 130.5 AT SPOT 74.`
  - `KCVG AMAZON RAMP: STAND CHANGE. NEW STAND A03 VIA SPOT 72 TAXILANE A.`
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
- **Other hubs / external clients:** publish a read-only `GET /ramp/public?icao=` (stand + state per callsign). Pilot-side tools, a vACC site, or a Discord bot can then show "your stand is DHL 61" without Hoppie.

---

## 8. Test model — KCVG Amazon Ramp

What the chart gives us (all in `data/ramp/KCVG.json`):

| Item | Contents |
| --- | --- |
| Stands (33) | **A01–A10**: east row along the Amazon building, off taxilane A. **B01–B08**: centre row, off taxilane C. **C01–C15**: west row, off taxilane C. |
| Taxilanes | A, B, C run north–south, with cross-lanes 1, 2, and 3. B ends at cross-lane 2. |
| Call spots | **71** (lane 1), **72** (A), **73** (B), **74** (C) on taxilane N. **75** at N/D, **76** on D near D1. |
| De-ice spots | N1-1, N1-2 (taxilane C) · N2-1, N2-2 (B) · N3 (A) · N4 (lane 1) |
| Positions | **Amazon Ramp Control 130.5** (the ramp) · **Taxilane N Control 130.375** (taxilane N) |
| Nearby | RWY 18C/36C to the west, via taxiways D / D1 / D2 |

**Correction to the mock-up:** its "Amazon Ramp 71–75" row shows the **call spots** as parking stands. In the real layout, 71–76 are handoff spots on taxilane N/D. The stands are the A/B/C rows, which is what the mock-up's "C01–C15" column already hints at. The Ramp page should draw the spots as numbered circles, as the chart does.

**Two-controller test:** this field covers the queue handoff directly. Amazon Ramp works stands → spot. Taxilane N works spot → ground. The push queue is owned by `AZN_RMP`. Aircraft reaching a spot show up for `TWYN_CTL` as "at spot 7x, awaiting taxi".

**To verify on the chart** (flagged in the JSON `source` note): each row's nose direction and push taxilane. They are read off the lead-in lines, and B-row access to taxilane A is unclear. Also the aircraft size limit per stand, which the chart does not give. Until we know, every stand accepts B763/B767-size aircraft and warns on anything larger.

1. **Data:** schematic from the chart (done), then OSM import for lat/lon and the ramp polygon, then a check in the stand editor. The DHL ramps (North/South/Main) follow the same way once we have their chart.
2. **Demo mode** (`ramp.html?demo=KCVG`): a scripted cargo bank (about 17 aircraft, like the mock-up). Inbounds on final, taxi-ins, parked, and departures calling for push. Built like the vUSAlink test traffic, so the page can be tested with no one online. Hoppie sends in demo mode go to a local log, never the network.
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

## 10. Open questions

1. **KCVG stand details:** which stands take B744/B748/B77L-size aircraft? And do B-row stands push onto taxilane A or C? Do we have a DHL-ramp chart like the Amazon one?
2. **Who may assign:** only `_RMP` / `_GND` / `_TWR` on position (plus ZID editors)? Or also a designated "company ops" role for events with no ramp controller?
3. **Telex from-station name:** `KCVG`, `CVGRMP`, or one per operator (`DHLOPS`, `AMZOPS`) so it reads like company ops?
4. **Taxilane N Control:** is it a separate VATSIM position at KCVG (callsign?), or does KCVG ground usually cover it?
5. **Uncontrolled ramps:** at fields with no ramp controller, should the tool act only as company ops (stands only, no push queue)?
6. **Auto-send default:** off (manual Send only) is proposed for launch.
