# Notes for Claude

## vusalink/edst/index.html: declare row state before start-up rendering

The page draws the board during start-up (`renderBoard` runs from top-level code and `onOAuthReady`), so
anything `renderRowEdst` and its helpers read must be declared with the board state near the top of the main
script, not in a later section. A `const`/`let` declared further down throws "Cannot access … before
initialization" on the first render and stops the whole script: no clock, dead buttons, no host API. This
broke the live EDST for signed-in controllers with traffic (Nov 2026). Test new row features with a row
present at load, for example a saved manual strip in `localStorage.vedst_manual`, not only in TEST MODE.

## vUSAlink EDST: host API used by vUSALink App

`vusalink/edst/index.html` is also loaded by **vUSALink App**
(github.com/djbrombizzle/vUSALink-App), a Windows desktop app that runs next to CRC. The web
EDST is the standard; the app is a thin shell that passes commands typed in CRC to the page.
It relies on the parts below and nothing else. Everything else in the page is internal and
free to change.

**Keep stable**, or the app's CRC mirroring silently stops working:

- `window.vUSALinkEDST`, defined in the "Host API" section near the end of the page script:
  - `version`: currently `2`. Bump it if `command()` or `status()` change shape or meaning.
    The app only sends ERAM handoff lines to pages that report version 2 or higher.
  - `command(text, {source})`: returns a Promise of
    `{ok, action: 'uplink' | 'amend' | 'handoff' | 'ignored', flid, error}`
    (`handoff` also carries `sector`, `facility`, `freq`).
  - `setCids({CALLSIGN: {cid, sector}})` (v2): replaces the table of CRC CIDs that the app learns from CRC
    QF readouts (`crcCidByCs`). The ACL shows the CID left of the callsign. It shows `(sector)` after the
    callsign only when another sector owns the track: never when the aircraft is on our voice frequency
    (`tunedToOurFreq`), and never for our own sector(s) (`mySectors`, from the vNAS feed or our `_NN_CTR`
    callsign). See `otherOwnerSector`.
  - `status()`: returns `{signedIn, canControl, testMode, listMode, refreshMs, mySectors}`.
- Behaviour behind `command()` (implemented in `mcaExecute(text, opts)`):
  - `source: 'crc'` or `'host'`: the FLID must be typed. Never fall back to the selected row
    (that could uplink to the wrong aircraft). Verbs other than QZ/QQ/QU/QS, or a missing
    FLID, return `{action: 'ignored'}` without touching the MCA feedback.
  - With `/U`: CPDLC uplink, same checks as the EDST MCA (NOT AUTH, NO TRACK, NO CPDLC).
  - Plain `QZ <alt> <FLID>` (no `/U`): local amendment only. It sets `assigned[cs]`, records
    `altAmended[cs]`, sends nothing, and returns `action: 'amend'`. The altitude menu
    (`openAltMenu`) opens with that altitude pre-selected (one-shot).
  - QQ/QU/QS without `/U`: reject with `REQUIRE /U`.
  - `UC <position> A<alt>|S<kt>|M.<nn> [/reason] <FLID>[/<FLID>…]` (ERAM crossing restriction; the command
    itself is the uplink, no `/U`): parsed positionally by `parseUcCommand` in `shared/edst-mca-commands.js`.
    An altitude crossing is coded under the ACL altitude (effects `alt`), and below FL180 the destination
    altimeter is appended. A speed or Mach crossing is coded under the speed (effects `spd`). Several FLIDs
    send one uplink each. vUSALink App clears UC lines from CRC's MCA (CRC has no UC) and only does that
    for v2 pages.
  - ERAM handoff `<sector> <FLID>` (e.g. `11 AAL004`; sector is 1-2 digits, a letter, or a
    letter + 1-2 digits; parsed by `crcHandoffParse`): if the aircraft is on CPDLC, the row
    shows `▶|` + `(sector)` (`crcHandoffs`, `crcHandoffHtml`). Clicking it sends CPDLC
    `CONTACT` via `sendHandoff` to the receiving sector, resolved from the vNAS public feed
    (`live.env.vnas.vatsim.net/data-feed/controllers.json`, `positions[].eramData.sectorId`)
    and falling back to an online `<prefix>_<sector>_CTR`. If it's unresolved, the click
    opens the HANDOFF menu. Right-click dismisses. Not a CPDLC aircraft or unknown, with
    source `crc`: `ignored`. `240 AAL004` (implied altitude) and `11 413` (a CID) are not
    handoffs.
- `shared/edst-mca-commands.js`: `parseMcaCommand(raw, {requireU: false})` must report
  `uplink` as whether `/U` was actually typed. Tests: `node scripts/test-edst-mca.mjs`.
- Traffic refresh is `vatsimRefreshMs()` (15 s; LIST windows 4 s). The app no longer
  overrides it, so the page owns the rate.

**vUSALink-Lite link** (`liteLink()` near the host API): vUSALink-Lite is a tray program (same repo as
the app) for controllers who keep the EDST in a CRC browser tab. The page connects to
`ws://localhost:47613/link`: it keeps retrying in a WebView2 host (CRC tab) or with `?link` / `vedst_link`,
and tries once in a plain browser. It sends `{t:'hello', page:'edst', api, list}` and handles
`{t:'cmd', id, text}` → `vUSALinkEDST.command(text, {source:'crc'})` → `{t:'result', id, ok, action, error,
flid, sector, facility, freq}`, plus `{t:'cids', map}` → `setCids(map)`. The `LINK` chips (`statLink`,
`crcStatLink`) show the connection. Keep these message shapes stable with the host API.

If one of these has to change, change it here and in the app together (the app checks
`version` on every page load). Older pages without the API trigger the app's legacy fallback.

Other users of `mcaExecute`: the EDST MCA itself, and the CRC `?cmd=` URL intent (aliases in
`vusalink/edst/crc-aliases.txt`, including `.QZA` for the amend-only form).
