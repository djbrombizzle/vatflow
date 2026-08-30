# Where RampView's surface data can come from

Prompted by: *"VATSIM Radar's gate information is really good and accurate — can we use
their maps?"*

Short answer: **the accurate part isn't theirs to give.** Their gate and layout data is
Navigraph, fetched at runtime under a commercial server credential and a per-viewer
subscription. Nothing usable is committed to their repo. The part of that screenshot we
*can* have is the basemap, which is open OSM data — and we can get identical gate quality
by integrating Navigraph ourselves, the same way they did.

Everything below is read from
[VATSIM-Radar/vatsim-radar](https://github.com/VATSIM-Radar/vatsim-radar) at `d6b9bc1`.

---

## 1. What VATSIM Radar actually uses

| Layer in the screenshot | Source | Evidence |
| --- | --- | --- |
| Grey taxiways, aprons, terminal shapes | **Protomaps basemaps** — OSM-derived vector tiles they self-host | `app/components/map/layers/MapLayer.vue:117` and `:236`; tiles served from their own `/tiles.json` |
| Raster fallback | **OpenStreetMap** tiles | `MapLayer.vue:62` |
| Gate boxes and gate names | **Navigraph DFD** — `tbl_pb_gates` from a per-AIRAC SQLite database | `app/utils/server/navigraph/index.ts:167` |
| Parking stand areas, stand guidance lines, taxiway guidance lines, hold positions, thresholds | **Navigraph AMDB** via `@navigraph/amdb` | `server/api/data/navigraph/airport/[...icao]/index.ts`; `package.json:93` |
| FIR/airport reference data | **VAT-Spy** and **SimAware** — both open | `app/types/data/vatspy.ts`, `app/composables/render/idb.ts` |

Two gates on the Navigraph data, both load-bearing:

- **A commercial server credential.** They authenticate with
  `NAVIGRAPH_SERVER_ID` / `NAVIGRAPH_SERVER_SECRET` using `client_credentials` and the
  scope `fmsdata amdb` (`app/utils/server/navigraph/db.ts:106`). That is a Navigraph
  partner credential, not something that comes with an ordinary account.
- **The viewer's own subscription.** The detailed layout only renders when the logged-in
  user has both FMS data and charts — `!!user?.hasFms && user.hasCharts`
  (`server/api/data/navigraph/airport/[...icao]/index.ts:46`), i.e. Navigraph Unlimited.
  Users without it fall back to an older AIRAC cycle for gates only
  (`navigraphOutdatedDb`, `index.ts:167`).

The `.s3db` databases are downloaded at runtime and never committed. **There is no gate
dataset in that repository to copy**, and if there were, redistributing it would breach
Navigraph's licence rather than VATSIM Radar's.

## 2. What their licence does and doesn't allow

Their repository is **CC BY-NC 4.0** (`LICENSE`). For VATFLOW — free, personal-use — the
NonCommercial term is not a problem in itself, and we could read or adapt their *code*
with attribution. Two caveats worth stating plainly:

- CC BY-NC covers **their code**, not Navigraph's data. No licence they hold lets them
  sublicense Navigraph content, and none of it is in the repo anyway.
- Pulling CC BY-NC code into VATFLOW would put an explicit non-commercial restriction on
  that part of the tree. VATFLOW is personal-use already, but it is a constraint to take
  deliberately, not by accident.

**Ruled out:** calling their `/api/data/navigraph/airport/<icao>` endpoint from VATFLOW.
That is scraping a third party's licensed data through someone else's paid credential.
It breaches their terms and Navigraph's, and it would break the moment they notice.

## 3. What we can take from this, honestly

Three real takeaways:

1. **Their basemap is open, and it is most of why that screenshot looks good.** Protomaps
   basemaps is OSM-derived vector tiles with an open style. VATFLOW already ships a vector
   basemap (`shared/vatflow-basemap.js`, OpenFreeMap) — the aeroway layers are in there.
   We render our surface on black today; rendering it over an OSM aeroway basemap would
   close most of the visual gap at zero licensing cost.
2. **Their gate accuracy is a subscription, not a secret.** The route to identical data is
   to integrate Navigraph ourselves, per-user, exactly as they do.
3. **Their architecture confirms ours.** They also treat the surface as a swappable
   provider with a degraded fallback — the same shape as RampView's schematic / OSM
   selector.

## 4. Options for RampView

| Option | Data quality | Cost | Licence | Verdict |
| --- | --- | --- | --- | --- |
| **A. OSM (today)** | Good at major fields, uneven elsewhere; no ramp ownership | Free | ODbL, attribute | **Keep.** Already built |
| **B. Chart-derived schematic (today)** | Exact gate ids, ramp ownership, frequencies — but only where a ramp chart exists and someone transcribes it | A few hours per airport | Ours | **Keep.** Nothing else gives ramp ownership |
| **C. X-Plane `apt.dat`** | Gate positions, size class, airline codes per stand | Free | Parse locally, commit only derived fields | **Worth doing** — fills OSM's operator gap |
| **D. Navigraph, per-user OAuth** | Identical to VATSIM Radar | Navigraph developer app; each user needs their own subscription for layout | Navigraph's terms; data never redistributed | **The real answer for accuracy** |
| **E. Copy VATSIM Radar's data** | — | — | Not licensable | **No** |

### Recommended sequence

1. **Render over an OSM aeroway basemap.** Biggest visual gain per hour, no new
   dependency, uses the basemap module VATFLOW already has. The surface stays vector on
   top; the basemap supplies the taxiway and apron shapes we currently draw ourselves.
2. **Add `apt.dat` enrichment to the OSM build.** Rows `1300`/`1301` give stand heading,
   ICAO size code and airline codes — the three things OSM most often lacks. This is
   already described in `RAMP-GATE-ASSIGNMENT.md` §2 and never got built.
3. **Then Navigraph as a third surface source**, if the accuracy still matters. It slots
   into the existing `SOURCE_SCHEMATIC` / `SOURCE_OSM` selector as `SOURCE_NAVIGRAPH`:
   the user signs in with their own Navigraph account, RampView requests AMDB for the
   field, caches it in that browser only, and never commits or redistributes it.

### What Navigraph integration would actually take

- A Navigraph developer application (client id/secret) and acceptance of their terms.
  VATFLOW would need its own — VATSIM Radar's cannot be borrowed.
- OAuth PKCE in the browser against `identity.api.navigraph.com`, alongside the existing
  VATSIM Connect flow in `shared/vatflow-auth.js`.
- An AMDB → RampView model adapter: `parkingstandarea` + `standguidanceline` → stands,
  `taxiwayguidanceline` → taxiways, `apronelement` → aprons, `runwaythreshold` → runways.
  Roughly the shape of `shared/ramp-osm.js`, against a different schema.
- A hard rule: Navigraph geometry is cached per browser and **never** written to
  `data/ramp/`, never exported, never committed. The export button must refuse it.

The ramp overlay we add on top — ramp areas, frequencies, face-level ownership, SID sides
— stays ours in all three cases. That is the part no data vendor supplies, and it is what
makes RampView a ramp control position rather than a map.

## 5. Attribution we owe

- **OSM / Protomaps / OpenFreeMap** — © OpenStreetMap contributors, ODbL. Already in the
  page footer via `model.attribution`.
- **VATSIM Radar** — nothing owed unless we adapt their code, in which case CC BY-NC 4.0
  attribution and the NonCommercial term apply.
- **Navigraph** — if integrated, their attribution requirements apply and the data stays
  per-user.
