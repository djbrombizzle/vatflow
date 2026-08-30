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
| **Assignment** | Which specific stand does inbound DAL1438 get? | Per flight | **Allocated deterministically** by us from affinity + live occupancy, and overridable by the ramp controller. |

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
| **T3** | **Learned prior** — this operator/type has historically parked here at this field | Medium | Hatched fill, tag suffix `·?` | Controller assignment supersedes |
| **T4** | **Rule-based** — airline→concourse affinity + free-stand allocator | Medium‑low | Hatched fill, tag suffix `·?` | Controller assignment supersedes |
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
  "concourse": "D", "terminal": "DOMESTIC",
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

## 3. The allocator

### 3.1 When it runs

Not every poll. Assignment is **sticky by design**; an assignment that churns between polls is
useless to a controller and impossible to coordinate over voice. It runs only on:

- an inbound entering the assignment horizon (default 40 NM / ~15 min out),
- the assigned stand becoming unavailable (still occupied inside the ETA window, or closed),
- a controller clearing or reassigning,
- an aircraft-type change on the flight plan (size compatibility may break).

Once assigned, an assignment is **pinned** until one of those fires. A controller assignment is
pinned harder — the allocator will never silently move it, only raise a conflict.

### 3.2 Hard constraints (filter)

A candidate stand must be: not occupied and not reserved inside `[ETA − 5 min, ETA + turn]`; not
closed; not blocked by an in-use neighbour (`blockedBy`); size-compatible (`sizeCode` ≥ aircraft
ICAO code); ops-type compatible (cargo doesn't get a pax stand while cargo stands are free);
customs-capable if the flight is international.

### 3.3 Soft score (rank)

```
score = 100·operatorMatch          // exact ICAO airline code on the stand
      +  60·allianceOrConcourse    // same concourse as the operator's usual block
      +  25·learnedPrior           // P(stand | operator, sizeCode) from §5
      +  15·sizeFit                // penalise parking an E175 on a code-E stand
      -  10·taxiDistanceFromExit   // prefer the natural flow off the arrival runway
      -  30·neighbourBlocking      // penalise choices that sterilise adjacent stands
      -  50·pushConflictRisk       // penalise stands whose push envelope is busy
```

### 3.4 Deterministic tie-break

Ties resolve by `hash(callsign + date) mod n` over the tied set — **not** `Math.random()`. Three
reasons this matters more than it looks:

- Every browser watching the field computes the **same** suggestion without needing to sync it.
- The suggestion doesn't jitter between polls or across a page reload.
- Playback of a recorded period reproduces exactly what controllers saw at the time.

### 3.5 Release

An assignment is released when the aircraft goes `IN_BLOCK` (it becomes T0 observation), when the
flight is cancelled or the pilot disconnects outside the field, or 30 minutes after a missed ETA.

---

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
- **Use.** Priors with `n ≥ 20` feed the `learnedPrior` score term. Below that threshold they're
  ignored — a prior built from three observations is superstition.
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
- The allocator is idempotent: the same feed snapshot allocates identically across 100 runs and
  across two independent clients.
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
