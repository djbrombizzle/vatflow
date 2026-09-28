# Airline Operations Center (AOC) — plan

**Status:** phases 0–1 built: `aoc.html` (demo + live, read-only from the VATSIM feed), `shared/aoc-core.js`, `shared/aoc-demo.js`, `shared/aoc-live.js`, `data/aoc/operators.json`, tests in `scripts/test-aoc-core.mjs`. Nav: new **Dispatch Center → Airline Ops** menu. Filed routes via FCA builder's `route-engine.js`. **Phases 2–3 are written, not yet deployed:** vUSAlink-hub `aoc.py` (`/hub/aoc/*`, branch `claude/dispatch-center`, `AOC.md`) and the dispatcher role in vatflow-hub (`dispatch-access.js`, branch `claude/dispatch-center`), plus the Admin Access **Dispatch Center dispatchers** card here. Until both hubs are deployed, live mode is read-only and says so. See §12 for the deploy order.
**Origin:** follows on from Ramp Management (`ramp.html`, [plan](ramp-management-plan.md)). Ramp watches **one airport** and all its operators. The AOC watches **one operator** (AAL, DAL, UAL…) wherever its flights are in the world.

> Track every VATSIM callsign for a given operator. An operations map shows who is flying and where, a status board shows the state of each flight, and a TELEX panel talks to the pilot over the Hoppie network. Same look as the Ramp Management page, built for an airline ops desk.

---

## 1. What we are building

A new page, **Airline Ops** (`aoc.html?op=AAL`), under a new **Dispatch Center** menu. It is a dispatcher's view of one airline on the VATSIM network. `?watch=N123AB,XYZ42` adds single callsigns; `?mode=demo|live`.

| Area (same frame as Ramp) | What it does |
| --- | --- |
| **Header** | Operator name, DEMO / LIVE, counters, feed/hub pill, Zulu clock. |
| **Counters** | Scheduled · Ground · Enroute · Arriving · Arrived (last 2 h) · Alerts, the same groups as the board's tabs. |
| **Ops map** | World/regional Leaflet map on the existing dark basemap (`shared/vatflow-basemap.js`). Every flight as a heading-rotated icon coloured by phase, with a short datablock (callsign, FL, GS). The selected flight shows its flown track, its whole filed route (faint), what is left of it (dashed, from the aircraft), its fixes coloured by kind as in FCA builder, and the next fix labelled. Hubs are marked. |
| **Status board** (the "Flights" card) | One row per flight: callsign, type, reg (if filed in remarks), DEP→ARR, phase, **OOOI** times (Out/Off/On/In), STD/ETD, ETA, delay, FL/GS, ACARS dot, last telex. Tabs: All · Scheduled · Ground · Enroute · Arriving · Arrived · Alerts. Search. |
| **Selected flight** | Facts (route, filed vs. actual times, remaining distance, ETA), alerts, a TELEX composer with templates, and that flight's message log. |
| **TELEX / Messages** (third card, where Ramp has the push queue) | The ops station's inbox and outbox across all flights, newest first. Unread downlinks flash. Click one to select the flight. |
| **Left rail** | Operator code box (a list of the US airlines in the file, but **any code can be typed**, for the many fictional airlines on VATSIM), recent codes, an **Also watch callsigns** box for single callsigns from any operator, regional-partner toggle, hub filter, display toggles (labels, ground traffic, hubs, flown track), legend, permission box, activity log. |

Read-only for everyone. Only dispatchers the hub authorises (see §6) can send telex or change shared state.

---

## 2. What it reuses

| Existing piece | Reused for |
| --- | --- |
| `ramp.html` layout and CSS tokens | The same frame: header counters, left rail, map on top, three cards below with the draggable split, same colours, same mobile layout. The page carries its own copy of Ramp's tokens for now; moving both to a shared stylesheet is a later cleanup. |
| `shared/ramp-live.js` / `ramp-demo.js` store interface | `shared/aoc-live.js` and `shared/aoc-demo.js` expose the same `getState / getPilots / subscribe / start / stop / op / sendTelex` shape. |
| vUSAlink-hub (Railway) | Shared AOC state, the permission check, the Hoppie telex send / poll, and the Hoppie "is this callsign connected" ping that Ramp already uses for its ACARS dot. |
| `composeStandTelex` / `parseDownlink` pattern in `ramp-core.js` | DOM-free `shared/aoc-messages.js`: templates with the same 220-char budget, downlink classifier, unit tests. |
| `shared/vatflow-basemap.js` + Leaflet | The ops map. |
| `data/nav/runways.json` | Airport reference points worldwide (runway thresholds → centroid) for great-circle distance, ETA and "at the airport" checks, with no new data file. |
| `shared/route-engine.js` | The FCA builder's route expander (FAA NASR fixes, navaids, airways, SIDs/STARs, preferred routes; `data/nav`). The page uses it unchanged through `createRouteResolver()` in `aoc-core.js` (cached per dep/arr/route). Outside US nav data it runs to the last US fix, then a great circle; unknown tokens are skipped and listed. |
| `data/ramp/*.json` + Ramp board state | At a Ramp airport (KCVG, KIAD, KDCA, KRDU) the AOC shows the arrival's assigned or proposed gate, and can telex it. See §7. |
| `shared/vatflow-auth.js` + whitelist | Sign-in, and a new `dispatcher` role scoped to operators (see §6). |
| `record-vatsim-feed.mjs` | Recording real feeds for the demo and for tests. |
| `shared/vatflow-nav.js` | New nav group **Dispatch Center → Airline Ops**. |

---

## 3. Which flights belong to an operator

### 3.1 Operator file — `data/aoc/operators.json`

```jsonc
{
  "AAL": {
    "name": "American Airlines", "telephony": "AMERICAN",
    "hubs": ["KDFW", "KCLT", "KORD", "KPHL", "KMIA", "KPHX", "KDCA", "KLAX", "KJFK"],
    "family": {                       // regional partners flying the brand
      "ENY": "Envoy", "PDT": "Piedmont", "PSA": "PSA",
      "RPA": { "name": "Republic", "shared": true },   // flies for AA, DL and UA
      "SKW": { "name": "SkyWest",  "shared": true }
    },
    "remarks": ["AMERICAN EAGLE", "OPR/AAL", "OPR/AMERICAN"],
    "station": "AALOPS"               // Hoppie telex station, see §5.1
  }
}
```

### 3.2 Matching order (same idea as Ramp's operator mapping)

1. **Callsign prefix**: `^AAL\d` is AAL mainline. Prefix + digits + optional letter, so `AAL1A` matches and `AALX` does not.
2. **Family prefix** that is not `shared`: `ENY`, `PDT`, `PSA` → AAL (shown as "Envoy for American").
3. **Shared carriers** (RPA, SKW, GJS…): only when the remarks say so (`AMERICAN EAGLE`, `OPR/AAL`, `DL CONNECTION`…). Otherwise they appear under their own code only.
4. **Any code** typed in the picker works, even one not in the file (virtual airlines with their own codes). It just gets no family or hubs, and its station defaults to `<CODE>OPS`.
5. **Watched callsigns**: exact callsigns added in the rail (saved per operator in the browser, and in the URL as `?watch=`) always match.

Default filter: mainline + non-shared family on. A rail toggle hides the regionals.

### 3.3 Prefiles and "scheduled" flights

The VATSIM feed has a `prefiles` array (flight plans filed by pilots not yet connected). Those, plus connected pilots who are on the ground with a plan and not moving, are the **Scheduled** list. VATSIM has no real schedule, so STD = the filed `deptime`.

---

## 4. Flight phase and OOOI

All derived from the feed, in a DOM-free `shared/aoc-core.js` (unit-tested like `ramp-core.js`).

```
SCHEDULED (prefile) ─ connects ─► AT GATE ─ moves >5 kt ─► TAXI OUT (OUT time)
   ─ gs >40 kt and climbing / alt > field+200 ─► DEPARTED (OFF time)
   ─► CLIMB ─► CRUISE (within 1500 ft of filed alt or level 5 min) ─► DESCENT
   ─► APPROACH (<40 nm to dest and < 12 000 ft AGL)
   ─ on ground at dest, gs <40 ─► LANDED (ON time) ─► TAXI IN ─ stopped 2 min ─► ARRIVED (IN time)
```

- **Airport elevation** comes from the runways file (thresholds carry elevation) so "on ground" works at KDEN as well as KMIA; fall back to `gs < 40` alone.
- **ETA** before departure: STD (or now, if later) + taxi + filed EET. **From takeoff until cruise: OFF + filed EET** (ground speed in the climb says nothing about the rest of the flight; if takeoff wasn't seen, the filed ETA). **From cruise on** (within 1,500 ft of the filed altitude, level in the flight levels below it, or descending): now + remaining distance **along the filed route** ÷ ground speed, smoothed (great circle when the route cannot be drawn). After landing: the ON time. Shown with the filed ETA so a late arrival stands out.
- **Delay** = OUT − STD (departure) and IN − (STD + filed EET) (arrival). Green ≤ 5 min, amber ≤ 15, red after.
- **Memory**: OOOI times need history. Phase 1 keeps them in the page (and `localStorage` per operator, as a convenience). Phase 2 moves them to the hub, which already polls the feed, so every dispatcher sees the same OOOI times even if they opened the page mid-flight.
- **Arrived** flights stay on the board for 2 h, then drop off. A pilot who disconnects is kept as **LOST** for 15 min (alert), in case they reconnect.

### 4.1 Alerts

Shown as badges on the row, counted in the header, listed under the Alerts tab:

| Alert | Rule |
| --- | --- |
| **Emergency squawk** | 7500 / 7600 / 7700 |
| **Diversion** | Flight plan arrival changed in flight, or landed somewhere other than the filed destination / alternate |
| **Lost contact** | Disconnected while airborne |
| **Late departure** | Still at gate > 15 min after STD |
| **Holding** | Heading changed through 360° within ~8 min below FL200 near dest |
| **Unanswered telex** | Uplink with a response template (e.g. `REPLY WILCO`) not answered in 10 min |

---

## 5. TELEX over Hoppie

### 5.1 Station

- Each operator gets its own Hoppie **telex station** (the "from" callsign), e.g. **`AALOPS`**, held by the hub. Dispatchers never see a logon code, same as Ramp and vUSAlink. A code typed in that is not in the file gets `<CODE>OPS`.
- Telex is company messaging, not CPDLC. The pilot only needs to be connected to Hoppie with an ACARS client (Hoppie ACARS, most 3rd-party FMCs, vPilot plugin), not logged on to any ATC CPDLC unit.
- The ACARS dot uses the hub's existing Hoppie ping. A telex to a pilot who isn't on Hoppie is refused unless sent anyway (same as Ramp).

### 5.2 Uplink templates (`shared/aoc-messages.js`, 220 chars max)

| Template | Example |
| --- | --- |
| Free text | `AAL OPS: ...` |
| Gate assignment | `AAL OPS: ARR GATE D24 KDFW. REPLY WILCO.` (at a Ramp airport, the gate the ramp assigned or proposed; see §7) |
| Destination weather | `AAL OPS: KDFW METAR 281753Z 18012KT 10SM FEW040 31/18 A2995.` (METAR fetched from `metar.vatsim.net`) |
| Delay / flow advisory | `AAL OPS: KORD GDP IN EFFECT. EXPECT EDCT 1845Z. ADVISE IF UNABLE.` |
| Reroute / diversion | `AAL OPS: DIVERT KSTL. ADVISE FUEL REMAINING.` |
| Connections / ops normal | `AAL OPS: 23 PAX CONNECTING. GATE HOLD NOT AUTHORIZED.` (flavour, not data we have) |
| Loadsheet (optional) | Short `LOADSHEET` block from the filed type; phase 4, and only if pilots ask for it |

Uplinks that expect an answer end with `REPLY WILCO` / `REPLY UNABLE` and start the unanswered-telex timer.

### 5.3 Downlink

The hub polls each active operator station. Pilot → ops messages go to the Messages card and the flight's log. `aoc-messages.js` classifies common requests:

- `REQ GATE`, `GATE?` → gate request flag (and a suggested reply at Ramp airports)
- `REQ WX <ICAO>`, `METAR <ICAO>` → one-click reply with the METAR
- `DELAY`, `DLA 20`, `MX`, `DIVERT`, `DIVERTING <ICAO>` → alert
- `WILCO` / `UNABLE` / `ROGER` → closes the pending uplink
- anything else → plain message

**Auto-reply is off at launch.** The page suggests a reply; a dispatcher presses Send. (Ramp made the same call.)

### 5.4 Hub work (vUSAlink-hub, outside this repo)

- `POST /hub/aoc/state {op}` → `{state, me, station, dryRun, hoppie}` (read; anyone)
- `POST /hub/aoc/op {op, cid, vatflowToken, ...}` → notes, flight "owner" dispatcher, acknowledge alert (writes, permission-checked)
- `POST /hub/aoc/telex {op, to, text, force?}` → send, rate-limited per station and per aircraft
- Hoppie poll for active operator stations only (an ops page open in the last N min), to keep poll volume low
- Server-side feed tracker for OOOI times (phase 2)
- The state read must answer everyone (signed in or not) with `ok: true` and `me.canWrite: false`, as `/hub/ramp/state` does. Until `aoc.py` is deployed the hub refuses the path (403 sign-in / 404), and the page shows "no Dispatch Center endpoints yet".
- No separate Hoppie approval is needed for the operator stations (decided).

---

## 6. Who can do what

Ramp could tie writes to a controller on position at the field. An airline desk has no VATSIM position to check, so this needs a new rule. Proposal:

| Who | Can |
| --- | --- |
| Anyone | Open any operator, see map, board, alerts, notes. Telex **text reads "(SIGN IN TO READ)"** unless signed in. |
| Signed-in VATFLOW user | Same, plus telex text. |
| **Dispatcher** (granted by a global admin, scoped to operator codes or `*`) | Send telex from that operator's station, save notes, acknowledge alerts. |
| Global admin | Everything, for any code; appoints dispatchers. |

Built as a separate `dispatchers` list in vatflow-hub's access file, **not** a whitelist role: whitelist entries grant full (editor) access, and a dispatcher should get nothing but the Airline Ops page. Claims carry `dispatchOps`. vUSAlink-hub checks it live at vatflow-hub `/auth/session` (60 s cache), so grants and revokes apply at once; a token vatflow-hub refuses (signed out) is refused; if vatflow-hub is unreachable it falls back to the signed JWT's claims. There is no VATSIM position check: an airline desk is not a position.

---

## 7. Tie-in with Ramp Management

- At a Ramp airport, the arrival row shows the **ramp's gate** (assigned on the board, or the proposed airline gate) and a "Gate" column links to `ramp.html?icao=…`.
- The gate template fills from that. If the ramp has already sent the stand telex, the AOC row shows `STAND SENT BY KIAD RAMP` so the pilot doesn't get two.
- The AOC never writes to the ramp board. Assigning gates stays with the controllers covering the field.
- Later, Ramp can show "AOC: gate request" when a pilot asked their ops for a gate.

---

## 8. Demo mode

`aoc.html?op=AAL&mode=demo`: ~40 scripted AAL + regional flights in all phases across the hubs, moving in real time, plus two alerts (a 7700 and a diversion) and a pilot that telexes `REQ GATE` and `REQ WX KDFW`. Built like `ramp-demo.js`. Telex in demo mode go to a local log, never the network.

---

## 9. Tests (`scripts/test-aoc-*.mjs`)

- callsign/operator matching (prefix, family, shared-with-remarks, custom code)
- phase machine and OOOI from recorded feed snapshots (`record-vatsim-feed.mjs`), including a go-around, a diversion and a reconnect
- ETA / delay maths
- template length budget, downlink classifier

---

## 10. Phases

| Phase | Scope | Result |
| --- | --- | --- |
| **0 — Data & core** | `operators.json` (15 US operators: AAL, DAL, UAL, SWA, JBU, ASA, HAL, NKS, FFT, AAY, SCX, MXY, FDX, UPS, GTI), `aoc-core.js` matching + phases + OOOI, tests | Flights grouped and phased from a feed · **built** |
| **1 — Read-only page** | `aoc.html`, Leaflet map, status board, selected flight, alerts, demo mode, nav entry | A useful ops picture with no hub changes · **built** |
| **2 — Hub & permissions** | `/hub/aoc/*`, dispatcher role, notes / acknowledge | Shared ops desk · **written, awaiting deploy** (server-side gate/air times still to do) |
| **3 — TELEX** | Station per operator, uplink templates, downlink peek + classifier, Messages card, rate limits | Two-way telex with pilots · **written, awaiting deploy** |
| **4 — Integrations** | Ramp gate tie-in, METAR/flow (FCA EDCT) in templates, loadsheet, public read endpoint | One picture across VATFLOW |

Phases 0–1 need no hub changes and can ship first.

---

## 11. Decisions

- **Dispatcher role**: a new whitelist role scoped to operator codes. Only dispatchers (and global admins) send telex, save notes or acknowledge alerts; everyone else is read-only.
- **Hoppie**: no separate approval needed for the operator stations.
- **Nav**: a new **Dispatch Center** menu, with **Airline Ops** in it.
- **Operators**: US airlines to start (15 in `operators.json`), plus a free-text code box for any operator (fictional/virtual airlines included) and a box to watch single callsigns.
- One page, one operator at a time (`?op=`). Leaflet geographic map, not a schematic like Ramp.
- Regionals shown under the brand only when they are not shared carriers, or the remarks say so.
- No auto-reply at launch. Arrived flights stay 2 h. Live mode is the default (the board works from the feed without the hub).
- Filed routes are expanded with FCA builder's `route-engine.js`: the map line, the Next column, distance to go and ETA along the route, and an **Off filed route** alert (more than 25 nm off, over 50 nm from both airports, only when every route token resolved, not for international routes past the last US fix, and not while diverting). Against the live feed, flights on fully resolved US routes sat 0–11 nm off them.
- The demo fleet files FAA preferred routes where the city pair has one and flies them. `route-engine.js` gained an additive `preferredRoute(dep, arr)` export for that: the preferred-route table is keyed by FAA ids (`ATL|DFW`), so its own fallback for DCT-filed plans never matches ICAO codes (`KATL|KDFW`). That fallback is left as it is here, because changing it would change FCA builder's and EDST's route lines.

**Hub side:** nothing for routes. Parsing runs in the browser from the static `data/nav` files.

---

## 12. Deploying phases 2–3

1. **vatflow-hub** (`claude/dispatch-center`): merge and deploy. No new variables. Admin Access then shows the Dispatchers card to global admins; `/auth/session` carries `dispatchOps`.
2. **vUSAlink-hub** (`claude/dispatch-center`): merge and deploy with `VEDST_AOC_DRYRUN=1` for the first test. Optional: `VEDST_AOC_STATE_FILE` on the volume, `VEDST_AOC_STATIONS` overrides, `VATFLOW_AUTH_URL` (defaults to the production vatflow-hub). It needs the existing `VATFLOW_JWT_SIGNING_KEY`, which must match vatflow-hub's `JWT_SIGNING_KEY`.
3. **This site**: merge the Dispatch Center PR.
4. Grant yourself or a tester a code on Admin Access, open `aoc.html?op=<CODE>&mode=live`, and check "Dispatching as <CODE>OPS/<cid>". Then drop `VEDST_AOC_DRYRUN` to send for real.

Checked end to end locally, with all three running (vatflow-hub, the vUSAlink-hub handler with a stubbed Hoppie and a real VATSIM feed snapshot, and this page in Chromium): the live role grant, ACARS dots from the Hoppie ping, a telex sent from AALOPS, the offline refusal and "Send anyway", a saved note, a pilot downlink with its Reply button, and read-only for a signed-in non-dispatcher.

---

## 13. SimBrief OFP (built) and dispatcher performance numbers (research)

### 13.1 Pilot's latest SimBrief OFP

The selected-flight panel has a **SimBrief OFP** section: type the pilot's SimBrief username (or numeric pilot ID), **Fetch latest**. The page calls SimBrief's public fetcher straight from the browser (`https://www.simbrief.com/api/xml.fetcher.php?username=<name>&json=1`; no API key, CORS open). `shared/aoc-simbrief.js` parses it:

- fuel: block, trip, taxi, min takeoff, contingency, alternate, reserve, extra (in the OFP's units, LBS or KGS);
- weights: pax, cargo, ZFW / TOW / LDW against the aircraft maximums (over a maximum shows red);
- times: scheduled out / in, air time, block time; route, cruise level, cost index, distance, registration;
- **runway analysis** (the TLR): takeoff runway, flaps, flex, V1/VR/V2, and landing runway, flaps, VREF, but only when the pilot had SimBrief's *Runway Analysis* option on.

It is the pilot's **latest** plan, so the panel checks it against the live flight (callsign, origin, destination, generated more than 18 h ago) and warns when it may be another flight's. The username stays in the dispatcher's browser (`vatflow.aoc.sb.<CODE>`), never on the hub. In demo mode the username `DEMO` makes a plan from the demo flight.

New telex templates, enabled once an OFP is loaded: **Loadsheet**, **Takeoff data** and **Landing data**, e.g.
`AAL OPS: T/O DATA KDFW RWY 17R. TOW 80.5. CONF 1+F. FLEX 48. V1 141 VR 143 V2 147. FROM SIMBRIEF, VERIFY.`

Not done yet: the pre-filled SimBrief planning link (deferred), and using the OFP's planned times for the board's ETA and delay.

### 13.2 How a dispatcher could produce fuel and performance numbers

| Option | What it gives | Fit for VATFLOW |
| --- | --- | --- |
| **SimBrief OFP + TLR** (above) | The pilot's own planned fuel, weights, and (with Runway Analysis on) V-speeds, flex, flaps, VREF for 100+ types | **Best first step.** Real numbers for the pilot's own aircraft profile and the flight they planned. SimBrief's calculators can't be re-run through the API with other inputs (another runway or weight); the pilot has to regenerate. |
| **EUROCONTROL Small Emitters Tool (SET)** | Trip fuel by aircraft type and distance: three straight-line segments per type, `fuel = a·d + b`, fitted to real flight data (Boeing's Cascade uses it, with +51 nm for routing) | A quick **fuel estimate with no OFP**, e.g. "trip ~9.8k lb" for a filed flight. Needs the per-type coefficient table from EUROCONTROL's SET (an Excel tool; check its terms before copying the coefficients). |
| **ICAO Carbon Emissions Calculator** | Fuel burn vs great-circle distance for ~300 equivalent types | Same kind of distance table as SET, published in the methodology PDF; coarser. |
| **OpenAP** (TU Delft, LGPL-3, Python) | Physics-based fuel flow per phase from mass, speed and altitude for common airliners | Could run on the vUSAlink hub (Python) as a `/hub/aoc/fuel` endpoint for climb/cruise/descent burn; more precise than SET, more work. BADA is the licensed alternative. |
| **FlyByWire flyPad** calculators (GPL-3) | A320neo takeoff (V1/VR/V2, flex) and landing distance from runway, weather, weight | Open code, but one type, and GPL-3 applies to anything that includes it. The FBW team call their flex numbers estimates. |
| **Flex Calculator TS** and similar web tools | A320-family / A220 / A330 takeoff numbers | Per-type community tools; useful references, not something to build on. |

Real airlines do this by the crew sending weights over ACARS and a performance server uplinking takeoff data (TOLD) to the FMC. Over Hoppie the nearest thing is a telex with the numbers, which is what the SimBrief templates send, marked "FROM SIMBRIEF, VERIFY".

Suggested order: SimBrief (done), then a SET-style fuel estimate for flights without an OFP, then OpenAP on the hub only if the estimate isn't good enough.

Sources: [Navigraph: fetching OFP data](https://developers.navigraph.com/docs/simbrief/fetching-ofp-data) · [Navigraph forum: XML fetching TLR](https://forum.navigraph.com/t/xml-fetching-tlr/17004) · [SimBrief performance calculators](https://fsnews.eu/simbrief-performance-calculators-released/) · [EUROCONTROL SET](https://www.eurocontrol.int/tool/small-emitters-tool-set) · [Boeing Cascade: fuel burn (SET formula)](https://docs.cascade.boeing.com/docs/baseCalculations/fuelBurnEnergyEmissions.html) · [ICAO calculator methodology v13.1](https://icec.icao.int/Documents/Methodology%20ICAO%20Carbon%20Emissions%20Calculator_v13_Final.pdf) · [OpenAP](https://github.com/junzis/openap) · [FlyByWire flyPad performance](https://docs.flybywiresim.com/aircraft/common/flypados3/performance/) · [FlyByWire aircraft (GPL-3)](https://github.com/flybywiresim/aircraft) · [Flex Calculator TS](https://github.com/jbud/Flex-Calculator-TS)
