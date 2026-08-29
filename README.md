# VATFLOW

**Call For Release (CFR) / Time-Based Flow Management for VATSIM.**

VATFLOW is a single-file web app that helps virtual air traffic controllers monitor arrival demand during VATSIM events. It pulls live traffic from the VATSIM data feed and meters arrivals against an airport rate so you can see recommended delay. **Issue a frozen release time only from an active FCA** (IDST, FCA Builder, or FCA Overview) — Airport TMU is tools and monitoring only.

Everything runs in one HTML file. No build step, no server, no install. 

Download or test via this link here https://vatflow.io/vatflow-tbfm%20v2.html (also https://djbrombizzle.github.io/vatflow/vatflow-tbfm%20v2.html)

**Operator guide:** [ACCESS-AND-ADMIN.md](ACCESS-AND-ADMIN.md) — permissions, whitelist, and admin setup after VATSIM OAuth.

---



---

## What It Does

- Reads **live VATSIM traffic** every 30 seconds.
- Meters arrivals to a field against its **Airport Arrival Rate (AAR)**.
- Shows **recommended delay** and suggested wheels-up from AAR / MIT (informational only).
- Applies **miles-in-trail (MIT)** and **minutes-in-trail** restrictions, including per-gate.
- Adjusts enroute estimates using **winds aloft** from the Aviation Weather Center.
- Syncs programs and restrictions across **multiple controllers**.
- **Call For Release (CFR) / RDY** is issued from an **active FCA** in IDST (or FCA Builder / Overview), not from Airport TMU.

---

## Pages

| Page | Purpose |
| --- | --- |
| **Home** | vNAS overview — flow program delays and departure taxi time averages from the Taxi Monitor. |
| **Apt Dashboard** | Full arrival picture for one airport: flight table, demand vs. AAR, and a live arrival ladder. |
| **My Dashboard** | Your personal set of up to 20 departure fields, shown as one combined list of pending departures (monitoring / recommended delay). |
| **TMU** | Set rate programs (AAR, trail/MIT, per-gate restrictions) for any airport — informational / monitoring. |
| **Restrictions** | Shared free-form restriction entries (requesting, providing, restriction, start/stop). |
| **Departures** | Single tower field view with recommended delay (info only). |
| **Taxi Monitor** | Monitor up to 5 departure fields at once; taxi times sync live via Firebase for all visitors. View-only — adding/removing fields is TMU (controller password) access only. |

---

## How to Use It

### 1. Set a program (TMU page)

On the **TMU** page, enter an airport and set its **AAR** (arrivals per hour). Optionally add:

- **Route Trail** — minutes-in-trail spacing.
- **MIT** — miles-in-trail (overrides minutes when set).
- **Gate restrictions** — up to 10 per program, each with its own spacing (e.g. `JJEDI4` at 20 MIT, `OZZZI2` at 10 MIT).

Programs apply everywhere as **monitoring**: the dashboards, recommended delay, and the departures view. They do not issue a release time.

### 2. Watch the arrivals (Apt Dashboard)

Enter the airport code to view its arrival flow. The table is sortable and filterable, and the arrival ladder on the right shows the sequence on a timeline (adjustable in 30-minute steps).

> Rates are set only on the TMU page. The Apt Dashboard is for viewing.

### 3. Issue releases (IDST — active FCA only)

Airport TMU does **not** issue a time. For any pending ground departure in an **active FCA**, open **IDST**, set the same tower / approach / center filters as My Dashboard, and press **RDY** to lock a speakable wheels-up. Optional ART **HHMMz** is the earliest floor.

Use **FCA Builder** or **FCA Overview** for the same RDY engine. Destination AAR / MIT on Airport TMU remains recommended delay for informational purposes only.

See the [Tower RDY guide](tower-rdy-guide.html) and [FCA How-To](FCA-howto.html).

### 4. Monitor taxi times (Taxi Monitor)

Add up to **5 departure airports** on the **Taxi Monitor** tab. The app watches ground departures at each field and times the roll from 7 kt groundspeed until 60 kt or altitude climb. Completed samples sync live via **Firebase** (`taximon/samples`) so every visitor sees the same data. Averages appear on **Home** with increasing/decreasing trend and volume context.

Adding or removing monitored airports is **TMU access only** — visitors see the monitor as read-only, and only an unlocked controller (control password) can change the fields. The monitored field list is shared globally via **Firebase** (`taximon/airports`), so every visitor sees the same airports and completed taxi samples.

---

## Multi-Controller Sync

VATFLOW can share state live across positions using Firebase Realtime Database.

1. Enter the same **room name** (e.g. the event name) on each controller's app.
2. Click **Connect**.

Shared across the room: rate programs and restriction entries. Your personal **My Dashboard** airport list stays local to this device.

Status indicator:

- `● LIVE` — connected and syncing.
- `LOCAL ONLY` — working solo (no sync).
- `SYNC ERROR` — check your connection or Firebase setup.

> To run sync, you need your own Firebase project (free tier is fine). Paste your Firebase config into the file, enable **Anonymous Authentication**, and deploy `database.rules.json` (`firebase deploy --only database`). Those rules require auth and only allow `/rooms/$room` and `/taximon/*` — never open root read/write.

---

## Winds Aloft

Enroute time estimates for not-yet-airborne flights are refined using winds-aloft forecasts from the **Aviation Weather Center**. The header shows a `WINDS` indicator with the number of stations loaded.

**Limitations:**

- **US / CONUS only.** Routes outside the coverage area use still-air estimates.
- **Forecast data**, not real-time. Refreshed hourly.
- **Applied only to ground and proposed flights.** Airborne aircraft already report true groundspeed.
- **Requires a CORS proxy.** The AWC API does not allow direct browser requests, so VATFLOW routes the request through a public proxy. If the proxy is unavailable, winds simply don't load and the app falls back to still-air estimates.

---

## Key Terms

| Term | Meaning |
| --- | --- |
| **CFR** | Call For Release — a controller-assigned wheels-up time issued from an **active FCA**. |
| **AAR** | Airport Arrival Rate — how many arrivals per hour a field can accept. |
| **MIT** | Miles in Trail — required distance between successive aircraft. |
| **TMU** | Traffic Management Unit — sets the rates and restrictions. |
| **Gate** | The arrival fix or STAR an aircraft uses to enter the terminal area. |
| **EDCT** | Expect Departure Clearance Time — the assigned wheels-up time. |

---

## Technical Notes

- **Single file.** All HTML, CSS, and JavaScript live in `vatflow-tbfm.html`. No dependencies to install.
- **Data sources:** the VATSIM data feed (live traffic), a global airport database (coordinates), and the Aviation Weather Center (winds aloft).
- **Sync (optional):** Firebase Realtime Database — room sync for programs/CFRs; global taxi sample sync for all visitors.
- **Browser-based.** Nothing is installed and no traffic data is stored.

---

## Disclaimer

VATFLOW is a tool for use on the **VATSIM network for simulation purposes only**. It is not for real-world air traffic control or flight planning.
