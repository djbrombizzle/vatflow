# RampView — Gate Assignment & Gate Occupancy

Companion spec to [RAMP-CONTROL-PLAN.md](RAMP-CONTROL-PLAN.md). This is the subsystem that
decides **who is on a stand right now** and **which stand an inbound is going to**.

---

## 0. The short answer

**Nothing is random.** The problem splits cleanly into a volatile half and a stable half, and each
half has a real source:

| | Question | Volatility | Source |
| --- | --- | --- | --- |
| **Occupancy** | Who is physically on stand D32 right now? | Changes every minute | **Observed** — VATSIM datafeed position matched to stand geometry. This is ground truth, not a guess. |
| **Affinity** | Which airlines use which stands at this field? | Changes yearly | **Fetched once at build time** — OSM stand tags + X-Plane `apt.dat` airline codes + hand overrides, committed as static JSON. |
| **Assignment** | Which specific stand does inbound DAL1438 get? | Per flight | **Drawn at random from the legal candidates** — the airline's own block, open, free, size-compatible — with a seed that keeps the answer stable. Overridable by the ramp controller. |

Random is the right model for the third row, provided it is *constrained* (only stands that airline
actually uses, and only open ones) and *seeded* (the same flight doesn't get a new gate every poll).
See §3.

The thing people reach for first — *fetch the real-world gate for this flight* — is the one thing
worth rejecting outright, for three reasons:

1. **It's usually wrong data.** A VATSIM `DAL1438` frequently isn't the real DAL1438, and even when
   the number matches, the real-world flight is operating on a different day, at a different time,
   with a different aircraft. The real gate belongs to a different airplane.
2. **It's paid and restricted.** AeroAPI / FR24 expose `gate_destination` on commercial plans whose
   terms don't permit redistributing it to a public page.
3. **It doesn't answer the question we actually have.** Real-world data is only useful at the
   *concourse* level ("Delta mainline sits on A–D at ATL"), and that part is stable, free, and
   already in OSM and `apt.dat`. We take that part and allocate the specific stand ourselves.

So: fetch the stable part, observe the volatile part, allocate the rest — and let the controller
override anything.

---

## 1. Assignment provenance ladder

Every flight carries a `standAssignment { standId, source, confidence, byCid, at }`. Sources are
resolved top-down; the first that answers wins, and the **display always shows which tier answered**,
because a guess that looks like a fact is the failure mode that makes a ramp display untrustworthy.

| Tier | Source | Trust | How it renders | Who can change it |
| --- | --- | --- | --- | --- |
| **T0** | **Observed** — the aircraft is physically in the stand | Truth | Solid fill, plain tag `DAL1438 D32` | Nobody; it *is* the state |
| **T1** | **Pilot-declared** — gate parsed from flight-plan remarks (`GATE A12`, `/GATE:A12`, `STAND A12`) | High | Solid outline, tag suffix `·P` | Controller can override |
| **T2** | **Controller-assigned** — typed on the scope, synced to the room | High | Solid outline, tag suffix `·A`, hover shows assigning CID | Any unlocked controller |
| **T3** | **Learned prior** — weights the draw toward stands this operator/type actually uses here | Medium | Hatched fill, tag suffix `·?` | Controller assignment supersedes |
| **T4** | **Rule-based** — seeded random draw from the airline's open, compatible stands | Medium‑low | Hatched fill, tag suffix `·?` | Controller assignment supersedes |
| **T5** | **Unresolved** — no affinity data, no free compatible stand | — | Tag reads `UNASSIGNED`, flight lands in an "unassigned" bucket on the arrival manager | Controller must assign |

Two rules keep this honest:

- **T3/T4 never render like T0–T2.** Hatched vs solid, `?` on the tag. A prediction must be visibly
  a prediction at a glance, from across a room.
- **T5 is a real, visible state.** Silently inventing an assignment when we have nothing is worse
  than showing `UNASSIGNED` and letting the controller decide. The arrival manager surfaces the
  unassigned bucket as a work item, not an error.

---

## 2. Where the stable data comes from

`scripts/build-ramp-airport.mjs` emits, per stand:

```jsonc
{
  "id": "D32",
  "point": [x, y], "hdg": 271, "poly": [[x,y], ...],
  "sizeCode": "D",                  // ICAO A–F, drives compatibility
  "maxWake": "H",
  "concourse": "D", "ramp": "R3", "terminal": "DOMESTIC",
  "operators": ["DAL", "EDV"],      // ICAO airline codes, may be empty
  "opsType": "airline",             // airline | cargo | ga | military | none
  "intl": false,                    // customs/FIS-capable
  "blocks": ["D32A", "D32B"],       // stands made unusable when this one is used
  "blockedBy": ["D30"],             // and the reverse
  "pushEnvelope": [[x,y], ...]      // area that must be clear to push
}
```

**Sources, in merge order:**

1. **OpenStreetMap** (`aeroway=parking_position`) — `ref` gives the stand id, and where mapped,
   `operator`, `aircraft:type` and width. ODbL: attribute it, redistribution is fine. Primary source.
2. **X-Plane `apt.dat`** rows `1300` / `1301`. Row 1300 carries lat/lon/heading/type; row 1301 carries
   the ICAO **width code (A–F)**, an **operation type**, and a **list of ICAO airline codes** for that
   stand. This is exactly the airline→stand affinity table we need, and it is already authored for every
   major field. *Licensing caveat:* parse it from a local sim install or the Scenery Gateway at build
   time and commit only the derived `operators`/`sizeCode` fields — do not commit the source file.
3. **`data/ramp/overrides/<ICAO>.json`**, merged last and always winning. Concourse groupings,
   `blocks`/`blockedBy` pairs, push envelopes, cargo/RON areas, and any correction. Hand-authored,
   first-class, version-controlled.

The build prints a coverage report — stands with no `operators`, no `sizeCode`, no polygon — so an
airport is either good enough to ship or has a visible to-do list.

---

## 3. The allocator — a constrained random draw

**Random is the right model, as long as it is constrained and seeded.** A real ramp doesn't hand
every AAL arrival the same "best" gate; it fills whatever is open in that airline's block. A weighted
best-pick allocator would produce an unrealistically tidy ramp — the same stands used every time and
the far end of a concourse permanently empty. A draw across the legal candidates matches reality and
is far simpler to reason about.

Two properties are non-negotiable, and neither conflicts with randomness:

- **Constrained** — the draw only ever sees stands the airline actually uses, that are open, free and
  size-compatible. Nobody gets a random gate; they get a random *legal* gate.
- **Seeded** — the draw is `mulberry32(hash(callsign + dateUtc))`, never `Math.random()`. Same flight,
  same day, same gate — on every client, on every reload, and in playback. This is what lets two
  controllers see the same suggestion with zero sync traffic, and what stops the gate from changing
  under a pilot who already read it back.

### 3.1 Candidate filter

A stand is a candidate when **all** hold:

| Constraint | Rule |
| --- | --- |
| Operator | The stand's block belongs to this airline (§3.2) |
| Free | Unoccupied and unreserved across `[ETA − 5 min, ETA + turn]` |
| Open | Not closed by a controller, not blocked by an in-use neighbour |
| Size | `stand.sizeCode ≥ aircraft ICAO code` |
| Ops type | Cargo doesn't take a pax stand while cargo stands are free |
| Customs | International arrival requires an FIS-capable stand |

### 3.2 Airline → block affinity

Authored at airport level, which is far easier to maintain than tagging 200 stands individually.
Per-stand `operators` (from OSM / `apt.dat`) refines it where it exists.

```jsonc
// data/ramp/overrides/KATL.json
"operatorBlocks": {
  "DAL": { "concourses": ["T","A","B","C","D"], "intl": ["E","F"] },
  "AAL": { "concourses": ["T"] },
  "SWA": { "concourses": ["C"] },
  "UAL": { "concourses": ["T"] },
  "FDX": { "opsType": "cargo" },
  "*":   { "concourses": ["T"] }        // default block for unlisted carriers
}
```

Regional partners inherit their mainline block unless listed (`EDV`, `SKW` → Delta's block), because
on VATSIM they park where the mainline parks.

### 3.3 The draw

```
candidates = stands.filter(hard constraints)
if candidates is empty  → widen, in order:
     1. the airline's other listed concourses (e.g. DAL onto E/F)
     2. any common-use stand of the right size
     3. UNASSIGNED                       ← never widen into another airline's block
rng  = mulberry32(hash(callsign + dateUtc))
pick = weightedDraw(candidates, rng)
```

The one weight worth keeping: **size fit**. An unweighted draw will happily park an E175 on a code-E
widebody stand while narrowbody stands sit open, which looks wrong and wastes the ramp. Weighting the
draw toward the tightest compatible stand keeps the variety while stopping the silly outcomes. It is
a weight on a random draw, not a best-pick — two E175s arriving together still land on different stands.

### 3.4 Stickiness

The draw runs when an inbound crosses the assignment horizon (40 NM / ~15 min), and then **not again**
unless the stand becomes unavailable, a controller intervenes, or the filed type changes and breaks
size compatibility. A controller assignment is pinned harder — the allocator raises a conflict rather
than redrawing. An assignment that churns between polls is impossible to coordinate over voice.

Release is on `IN_BLOCK` (it becomes a T0 observation), on cancellation or off-field disconnect, or
30 minutes after a missed ETA.

---

## 3A. Ramp numbers

Big fields are split into ramp control areas, and the ramp number — not the concourse letter — is
what says *who owns this aircraft*. It becomes a first-class concept in the airport file:

```jsonc
"ramps": [
  { "id": "R1", "label": "Ramp 1", "concourses": ["T"],     "freq": "129.60" },
  { "id": "R2", "label": "Ramp 2", "concourses": ["A","B"], "freq": "129.75" },
  { "id": "R3", "label": "Ramp 3", "concourses": ["C","D"], "freq": "131.32" },
  { "id": "R4", "label": "Ramp 4", "concourses": ["E","F"], "freq": "118.02" }
]
```

The build stamps `ramp: "R1"` onto every stand from its concourse, so the mapping is authored once
per airport and never per stand.

**Where the ramp number shows up:**

- **Inbound data tag** — `DAL1438  R1/T12`. Ramp first: it answers "is this mine?" before the reader
  gets to the gate. Stand boxes keep the real gate id (`T12`) on the stand itself, because that's what
  the pilot reads off the signage and hears on frequency.
- **Arrival manager** — a Ramp column, and the list is filterable to one ramp.
- **My ramp** — a controller selects the ramp they're working; their stands and aircraft render at
  full brightness and everything else dims. This is the single feature that makes a multi-ramp field
  workable on one screen.
- **Watch lists** — the `NORTH 9` / `SOUTH 3` counters in the screenshots become per-ramp counters by
  default, which is almost certainly what they are on the real system.
- **Handoff** — an inbound crossing into another ramp's area highlights as handoff-pending, mirroring
  how real ramp positions pass aircraft between each other.

**Open point:** the gate's own id stays `T12` in this design — the ramp number labels the *area and
the position*, not the gate. If the intent is that gate labels themselves render as `R1-12`, that's a
one-line display change, but it diverges from what pilots see on the jetway and read back on frequency.
Confirm which you want.

## 4. Occupancy engine

Occupancy is observation, but observation of a noisy feed. Every rule below exists to stop a
single bad sample from flipping a gate.

### 4.1 Matching

1. Point-in-polygon against every stand polygon. If exactly one hits → matched, confidence `high`.
2. Otherwise nearest stand centre within `radius = 0.6 × standLength` (roughly 20–35 m), with
   heading within ±45° of the stand heading → confidence `medium`.
3. Two stands competing (nose-in stands can sit 25 m apart, and sim position jitter is a similar
   order) → take the closer, confidence `low`, tag shows `?`.
4. No match → the aircraft is `RAMP` or `TAXI`, **never** a wrong gate id.

### 4.2 Hysteresis

| Transition | Requires |
| --- | --- |
| → `IN_BLOCK` | GS < 3 kt for 30 s, continuously matched to the same stand |
| `IN_BLOCK` → `PUSHBACK` | 20 m of movement from the in-block position, or GS > 3 kt for 15 s |
| Stand → free | Aircraft 40 m clear of the polygon for 30 s, **or** disconnected for 60 s |

The 60-second disconnect delay matters: pilots drop and reconnect constantly. Freeing a gate the
instant a target vanishes, then re-occupying it 20 s later, produces exactly the flicker that makes
a display unusable. During that window the stand renders amber "vacating".

### 4.3 Timers

In-block timestamp drives the `MM:SS` in the stand box, counting **up** as time-at-gate. When the
flight plan has a departure time, the box switches to counting **down** to off-block once inside the
target turn time, and turns amber past it — the reference display's behaviour.

### 4.4 Cases that will actually happen on VATSIM

| Case | Handling |
| --- | --- |
| **Squatters** — a pilot connected at a hub gate for hours with no flight plan | After 90 min in-block with no filed plan, mark `DORMANT`. Still occupied (it really is), but de-emphasised, and the allocator treats it as *low-cost to displace* so the controller sees it as a candidate to move |
| **Off-stand parking** — parked on a taxiway, on grass, on the apron | No stand match; shows as `RAMP` with a position marker. Never invents a gate |
| **Two aircraft in one polygon** — overlapping spawns | Both listed on the stand box; raises a `stand double-occupancy` alert |
| **Multi-use stands** — one code-E stand or two code-C stands | `blocks` / `blockedBy` pairs; using one greys the others as `BLOCKED` rather than free |
| **Pushback into a busy alley** | Push envelope is checked as part of occupancy, feeding the conflict probe |
| **Mid-turn reconnect** | Callsign + stand + a 10-minute window re-attaches the previous in-block time, so the turn timer survives a dropout |
| **Gate held by a departure past its slot** | Inbound assigned to it flips to `conflict`; the arrival manager offers the top three alternates one keystroke away |

---

## 5. Learned priors (the part that gets better over time)

Static affinity gets us "DAL narrowbody belongs on concourse B". It does not know that *in practice*
on VATSIM, everyone spawns on B14–B26 and the far end of B sits empty all night. That's learnable
from our own observations, and it's how T3 beats T4.

- **Collect.** Each RampView client, on a confirmed `IN_BLOCK`, writes one anonymous observation to
  `ramp/<ICAO>/obs`: `{ operator, sizeCode, standId, hourUtc, intl }`. **No callsign, no CID, no
  route** — the aggregate is about stands, not people.
- **Aggregate.** A weekly GitHub Action (`ramp-priors.yml`, mirroring the existing
  `staffing-hist.yml` + Supabase upsert pattern) collapses observations into
  `data/ramp/priors/<ICAO>.json`: `P(stand | operator, sizeCode)` with a sample count.
- **Use.** Priors with `n ≥ 20` bias the *weights* of the draw — a stand nobody ever uses is drawn
  less often, one everybody uses is drawn more. They never collapse the draw to a single answer, and
  below that threshold they're ignored entirely: a prior built from three observations is superstition.
- **Cold start.** A brand-new airport runs on T4 rules alone and works fine; priors only sharpen it.

---

## 6. Telling the pilot

Assignment is worthless if it stays on the controller's screen. Three outlets, in order of effort:

1. **The scope tag and the stand box** — for the controller, to say it on frequency. Always available.
2. **A public read-only board** at `rampview.html?field=KATL&view=board` — a gate/stand table a pilot
   can leave open on a second monitor, no login. Reuses the same store.
3. **Optional:** a `?callsign=` deep link that shows just that flight's assigned stand and route in.

Pilot-declared gates (T1) flow the other way for free: a pilot who puts `GATE A12` in remarks is
honoured without anyone typing anything.

---

## 7. Acceptance tests

`scripts/test-ramp-stands.mjs` and `scripts/test-ramp-alloc.mjs`, in the repo's existing node test style:

- A 30-minute recorded KATL bank replays with **zero** spurious occupancy flips.
- A target disconnecting and reconnecting within 60 s keeps its stand and its turn timer.
- The draw is reproducible: the same callsign on the same day yields the same stand across 100 runs
  and two independent clients.
- The draw spreads: 200 simulated SWA arrivals at KATL fill concourse C broadly rather than
  clustering on the first few stands.
- No arrival is ever drawn into another airline's block — an AAL flight with concourse T full goes
  `UNASSIGNED`, never to a C gate.
- A code-C aircraft is never assigned a stand that `blocks` an occupied neighbour.
- With affinity data deleted, every inbound resolves to `UNASSIGNED` — and nothing crashes or invents.

---

## 8. Open questions

1. **Squatter policy** — should `DORMANT` stands be treated as available for allocation (realistic:
   the controller moves them) or held (safe: never double-assign)? Default proposed: held, but shown
   as displaceable.
2. **Remarks parsing** — how aggressive? `GATE A12` is unambiguous; a bare `A12` in a remarks blob is
   not. Proposed: only match explicit `GATE`/`STAND` prefixes.
3. **Observation collection** — opt-in per user, or on by default for anyone with the page open?
4. **Reservation window** — is 5 minutes before ETA the right hold, or should it scale with how far
   out the aircraft is?
5. **Ramp labelling** — does the gate id itself become `R1-12`, or does the gate stay `T12` with the
   ramp number shown alongside it as the position identifier? (§3A)
6. **ATL ramp map** — confirm the concourse→ramp grouping and which carriers sit where; the block
   table in §3.2 is a first cut from AAL→T, SWA→C, DAL→everywhere.
