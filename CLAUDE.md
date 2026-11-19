# Notes for Claude

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
  - `status()`: returns `{signedIn, canControl, testMode, listMode, refreshMs}`.
- Behaviour behind `command()` (implemented in `mcaExecute(text, opts)`):
  - `source: 'crc'` or `'host'`: the FLID must be typed. Never fall back to the selected row
    (that could uplink to the wrong aircraft). Verbs other than QZ/QQ/QU/QS, or a missing
    FLID, return `{action: 'ignored'}` without touching the MCA feedback.
  - With `/U`: CPDLC uplink, same checks as the EDST MCA (NOT AUTH, NO TRACK, NO CPDLC).
  - Plain `QZ <alt> <FLID>` (no `/U`): local amendment only. It sets `assigned[cs]`, records
    `altAmended[cs]`, sends nothing, and returns `action: 'amend'`. The altitude menu
    (`openAltMenu`) opens with that altitude pre-selected (one-shot).
  - QQ/QU/QS without `/U`: reject with `REQUIRE /U`.
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

If one of these has to change, change it here and in the app together (the app checks
`version` on every page load). Older pages without the API trigger the app's legacy fallback.

Other users of `mcaExecute`: the EDST MCA itself, and the CRC `?cmd=` URL intent (aliases in
`vusalink/edst/crc-aliases.txt`, including `.QZA` for the amend-only form).
