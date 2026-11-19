# Notes for Claude

## vUSAlink EDST: host API used by vUSALink App

`vusalink/edst/index.html` is also loaded by **vUSALink App**
(github.com/djbrombizzle/vUSALink-App), a Windows desktop app that runs next to CRC. The web
EDST is the standard; the app is a thin shell that passes commands typed in CRC to the page.
It relies on the parts below and nothing else. Everything else in the page is internal and
free to change.

**Keep stable**, or the app's CRC mirroring silently stops working:

- `window.vUSALinkEDST`, defined in the "Host API" section near the end of the page script:
  - `version`: currently `1`. Bump it if `command()` or `status()` change shape or meaning.
  - `command(text, {source})`: returns a Promise of
    `{ok, action: 'uplink' | 'amend' | 'ignored', flid, error}`.
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
- `shared/edst-mca-commands.js`: `parseMcaCommand(raw, {requireU: false})` must report
  `uplink` as whether `/U` was actually typed. Tests: `node scripts/test-edst-mca.mjs`.
- Traffic refresh is `vatsimRefreshMs()` (15 s; LIST windows 4 s). The app no longer
  overrides it, so the page owns the rate.

If one of these has to change, change it here and in the app together (the app checks
`version` on every page load). Older pages without the API trigger the app's legacy fallback.

Other users of `mcaExecute`: the EDST MCA itself, and the CRC `?cmd=` URL intent (aliases in
`vusalink/edst/crc-aliases.txt`, including `.QZA` for the amend-only form).
