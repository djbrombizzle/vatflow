/**
 * CPDLC usage stats card for Admin Access (vUSAlink hub /hub/stats).
 *
 * The hub decides who may read the stats: it confirms the VATFLOW sign-in
 * live and checks the CID against its VEDST_STATS_CIDS list. STATS_VIEWER_CIDS
 * here only decides whether the card is shown; keep it in step with the hub.
 */
import { rampHubBase } from "./ramp-live.js";

export const STATS_VIEWER_CIDS = ["816206"];

export const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 0, label: "Since start" },
];

export function canViewCpdlcStats(session) {
  return !!(session && session.cid && STATS_VIEWER_CIDS.includes(String(session.cid)));
}

export async function fetchCpdlcStats(token, days, { list = true, fetchFn = fetch, base } = {}) {
  const res = await fetchFn(`${base || rampHubBase()}/hub/stats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vatflowToken: token, days: days || 0, list }),
  });
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, error: `hub returned ${res.status}` };
  if (!res.ok && data.ok !== false) data.ok = false;
  return data;
}

const esc = v => String(v ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function pct(part, whole) {
  if (!whole) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** Fill in missing days so the chart shows quiet days as zero. */
export function fillDaily(daily, from, to) {
  if (!from || !to) return daily || [];
  const byDay = new Map((daily || []).map(d => [d.day, d]));
  const out = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) || { day, controllersOpened: 0, controllersSignedIn: 0, pilots: 0 });
  }
  return out;
}

function tile(label, value, sub) {
  return `<div class="cu-tile"><div class="cu-val">${esc(value)}</div>`
    + `<div class="cu-lbl">${esc(label)}</div>${sub ? `<div class="cu-sub">${esc(sub)}</div>` : ""}</div>`;
}

function chart(daily) {
  if (!daily.length) return "";
  const max = Math.max(1, ...daily.map(d => Math.max(d.pilots, d.controllersSignedIn)));
  const w = 100 / daily.length;
  const bars = daily.map((d, i) => {
    const hp = (d.pilots / max) * 100;
    const hc = (d.controllersSignedIn / max) * 100;
    const x = i * w;
    const title = `${d.day}: ${d.controllersSignedIn} controllers signed in`
      + ` (${d.controllersOpened} opened), ${d.pilots} pilots`;
    return `<g><title>${esc(title)}</title>`
      + `<rect x="${x + w * 0.08}%" y="${100 - hp}%" width="${w * 0.4}%" height="${hp}%" class="cu-bar-p"></rect>`
      + `<rect x="${x + w * 0.52}%" y="${100 - hc}%" width="${w * 0.4}%" height="${hc}%" class="cu-bar-c"></rect>`
      + `</g>`;
  }).join("");
  return `<div class="cu-legend"><span class="cu-key cu-bar-c"></span>Controllers signed in`
    + `<span class="cu-key cu-bar-p"></span>Pilots logged on <span class="muted">· per day, peak ${max}</span></div>`
    + `<svg class="cu-chart" width="100%" height="120" preserveAspectRatio="none" role="img"`
    + ` aria-label="Daily CPDLC controllers and pilots">${bars}</svg>`
    + `<div class="cu-axis"><span>${esc(daily[0].day)}</span><span>${esc(daily[daily.length - 1].day)}</span></div>`;
}

export function renderCpdlcStats(s) {
  if (!s || !s.ok) {
    return `<p class="muted">Could not load stats: ${esc((s && s.error) || "unknown error")}.</p>`;
  }
  const c = s.controllers || {};
  const p = s.pilots || {};
  if (!s.trackingSince) {
    return `<p class="muted">No CPDLC activity recorded yet. Counting starts once the hub with usage stats is deployed.</p>`;
  }
  const r = s.range || {};
  const head = `<p class="muted">Tracking since <b>${esc(s.trackingSince)}</b>`
    + (r.from ? ` · showing ${esc(r.from)} to ${esc(r.to)}` : " · no activity in this range") + `.</p>`;
  const tiles = `<div class="cu-tiles">`
    + tile("Controllers signed in", c.signedIn ?? 0, `${c.signInSessions ?? 0} sessions`)
    + tile("Controllers opened", c.opened ?? 0, `${pct(c.signedIn, c.opened)} went on to sign in`)
    + tile("Pilots logged on", p.unique ?? 0, `${p.logons ?? 0} logons`)
    + tile("Pilots per controller", c.signedIn ? (p.unique / c.signedIn).toFixed(1) : "—", "unique, this range")
    + `</div>`;
  const daily = fillDaily(s.daily, r.from, r.to);

  const arts = Object.entries(s.byArtcc || {})
    .sort((a, b) => (b[1].pilots - a[1].pilots) || (b[1].controllers - a[1].controllers));
  const artTable = arts.length
    ? `<h3>By ARTCC</h3><table><thead><tr><th>ARTCC</th><th>Controllers signed in</th><th>Pilots</th></tr></thead><tbody>`
      + arts.map(([a, v]) => `<tr><td><span class="chip">${esc(a)}</span></td><td>${esc(v.controllers)}</td><td>${esc(v.pilots)}</td></tr>`).join("")
      + `</tbody></table>`
    : "";

  const ctl = s.controllerList || [];
  const ctlTable = ctl.length
    ? `<h3>Controllers (${ctl.length})</h3><table><thead><tr><th>CID</th><th>Signed in</th><th>Sessions</th><th>Days</th><th>Positions</th></tr></thead><tbody>`
      + ctl.map(row => `<tr><td>${esc(row.cid)}</td><td>${row.signedIn ? "Yes" : '<span class="muted">Opened only</span>'}</td>`
        + `<td>${esc(row.signIns)}</td><td>${esc(row.days)}</td>`
        + `<td>${(row.callsigns || []).map(x => `<span class="chip">${esc(x)}</span>`).join("")}</td></tr>`).join("")
      + `</tbody></table>`
    : "";

  const plt = (s.pilotList || []).slice(0, 50);
  const pltTable = plt.length
    ? `<h3>Top pilots</h3><table><thead><tr><th>CID</th><th>Logons</th><th>Days</th><th>Callsigns</th></tr></thead><tbody>`
      + plt.map(row => `<tr><td>${row.id.startsWith("cs:") ? '<span class="muted">unknown</span>' : esc(row.id)}</td>`
        + `<td>${esc(row.logons)}</td><td>${esc(row.days)}</td>`
        + `<td>${(row.callsigns || []).map(x => `<span class="chip">${esc(x)}</span>`).join("")}</td></tr>`).join("")
      + `</tbody></table>`
    : "";

  return head + tiles + chart(daily) + artTable + ctlTable + pltTable;
}
