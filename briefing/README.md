# Flight release briefing tool

`briefing.html` at the repo root is the deliverable: **one self-contained file**
(~1.6 MB) with pdf.js inlined. It runs two ways from the same file:

- **iPad** — open the hosted URL once with wifi, then Add to Home Screen. A
  service worker caches the page, so it opens with no network.
- **PC** — open the file directly (`file://`). No server, no sibling assets.

A release PDF is parsed entirely on device. Nothing is uploaded.

## Build

`briefing.html` is generated — edit the sources here, never the built file:

```
node scripts/build-briefing.mjs
```

| Source | Purpose |
| --- | --- |
| `shell.html` | page skeleton with `{{TOKEN}}` slots |
| `app.css` | styles (night + day palettes, iPad-first) |
| `parse.js` | release parser — DOM-free, so it can be tested in Node |
| `app.js` | extraction, storage and rendering |
| `sw.js` | service worker, registered from an inlined blob |
| `vendor/` | pdf.js 3.11.174 legacy UMD build (`pdf.min.js` + worker) |

## Testing a release

```
node scripts/test-briefing.mjs path/to/release.pdf         # summary
node scripts/test-briefing.mjs path/to/release.pdf --json  # full model
```

Exits non-zero if the parser records warnings.

## How the parsing works

The release is a fixed-width teletype OFP rendered into a PDF in Courier, so:

1. **pdf.js emits a run of spaces as one item** whose *width* encodes the run
   length. Lines are rebuilt on a 6.0 pt/char grid, which restores the original
   column alignment the table parsers depend on.
2. The text carries NBSP padding and SOFT HYPHEN in place of `-`. pdf.js
   normalizes most of it; `normalizeText()` does it again defensively.
3. Pages are split into sections by their printed section header, not geometry.
4. The FD Pro deep link on the last page repeats origin/dest/route/registration
   and is used to cross-check the text parse; disagreements become warnings.

Supported profile: `icrew-mobile`. To add another carrier's format, write a new
section splitter + field extractors and detect it the way `parseRelease` does.

## NOTAM filtering

Three independent filters cut the NOTAM list down to what matters:

- **Runway** — the release scopes NOTAMs station → runway → category, so
  picking the landing runway shows only that runway's entries.
- **Wingspan** — entries restricted to spans above the 717's cannot apply.
- **Time window** — validity is parsed (`14AUG260330-04SEP260930Z`,
  `10JUL261341Z-UFN`), including a `DLY HHMM-HHMM` daily window from the body,
  and judged at wheels-up for the departure brief and touchdown for the
  arrival brief. The reference instants come from the release's own
  preparation date (the only place a four-digit year is printed) plus the
  planned OFF/ON times.

The briefing time itself is adjustable: a bar on the departure and arrival tabs
steps the whole brief by a delay (+15 through +3h) or takes a typed actual
wheels-up time, and re-evaluates every window against it. Flight time is held
constant, so touchdown moves with it, and the passenger tab's announced arrival
follows. If a shifted takeoff runs past the duty LATT from the flight plan
addendum, the bar says so.

Each filter hides entries behind a banner with a count and a "show them anyway"
button — nothing is silently dropped. A validity string that does not parse
cleanly counts as in force, so an unreadable window can never hide a NOTAM.

## NATS coverage

The arrival tab follows the company NATS briefing items:

- **N** — destination NOTAMs (runway/time filtered), flight plan remarks from
  the release, plus entry for ATIS advisories and chart change notices.
- **A** — destination METAR/TAF and wind components, arrival speed/altitude
  restrictions, and a full **approach plate briefing**: designated approach,
  Jeppesen chart number and date, navaid and frequency, inbound course, initial
  approach and FAP/FAF altitudes, baro altitude at the marker, minima,
  altimeter bugs, approach notes, configuration plan, automation level and the
  missed approach plan. A second block covers 10-9A runway information —
  lighting, usable landing distance, surface condition (auto-filled from the
  release's field conditions) and non-standard width.
- **T** — transition level, terrain, and a taxi plan covering runway exit
  point, hot spots, hold short points, runway crossings and abnormalities, with
  an automatic SMGCS prompt when destination visibility is low.
- **S** — engine out procedures and company pages.

The plate briefing is collapsed by default and **opens automatically when the
destination is not reporting VFR**, matching the rule that a full plate
briefing is required in actual IMC or night VMC. Entry-field placeholders
describe what to enter and never show a plausible value, so a blank field can
never be misread as briefed data.

## Aircraft assumption

Built for the **B717-200 only**. `WINGSPAN_FT` in `app.js` (93 ft) is what lets
the tool hide wingspan-restricted NOTAMs that cannot apply. Change it before
using this on another type.
