#!/usr/bin/env node
import assert from "assert";
import {
  parseStatsimCountryMarkdown,
  statsimResponseIsEmptyShell,
  periodFetchWindows
} from "./lib/staffing-hist-core.mjs";

const md = `
#### Departed (2)
|Callsign|Origin|Dest.|Departed|Aircraft|
|[AAL1](/flights/detail/1)|[KORD](/x)|[KJFK](/x)|2026-07-19 06:00|B738|
|[UAL2](/y)|KMIA|KATL|2026-07-19 07:00|A320|
#### Arrived (1)
|Callsign|Origin|Dest.|Arrived|Aircraft|
|DAL3|KDEN|KSEA|2026-07-19 08:00|B739|
`;
const rows = parseStatsimCountryMarkdown(md);
assert.equal(rows.length, 3);
assert.equal(rows[0].callsign, "AAL1");
assert.equal(rows[0].origin, "KORD");
assert.equal(rows[0].kind, "dep");
assert.equal(rows[2].kind, "arr");

assert.equal(statsimResponseIsEmptyShell("<h4>Departed (0)</h4><h4>Arrived (0)</h4>"), true);
assert.equal(statsimResponseIsEmptyShell("<h4>Departed (12)</h4><h4>Arrived (9)</h4>2026-07-19 06:00"), false);

const week = periodFetchWindows("thisweek");
assert.ok(week.length >= 6 && week.length <= 8);
assert.ok(week[0].toMs > week[0].fromMs);
assert.ok((week[0].toMs - week[0].fromMs) <= 86400000 + 1000);

console.log("ok");
