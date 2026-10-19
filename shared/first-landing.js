/**
 * First to Land pages: the untouched-field list (data/first-landing/fields.json, built by
 * scripts/build-first-landing.mjs) and the claims vatflow-hub records from the live feed
 * (first-landing.js in vatflow-hub).
 */
import { getAccessApiBase } from "./vatflow-access-api.js";

export const REFRESH_MS = 60000;
// fields.json row columns (scripts/lib/first-landing-core.mjs)
export const C = { ident: 0, name: 1, city: 2, state: 3, type: 4, lat: 5, lon: 6, elev: 7, rwy: 8, paved: 9, lit: 10,
  status: 11, deps: 12, local: 13, iata: 14, guard: 15, checked: 16 };
export const TYPES = { s: "Small airport", m: "Medium airport", l: "Large airport", w: "Seaplane base" };

export async function loadFields() {
  const r = await fetch("data/first-landing/fields.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("Field list HTTP " + r.status);
  return r.json();
}

async function hubGet(path) {
  const r = await fetch(getAccessApiBase() + path, { cache: "no-store" });
  if (!r.ok) throw new Error("Hub HTTP " + r.status);
  const body = await r.json();
  if (!body.ok) throw new Error("Hub error");
  return body;
}
/** { claims (newest first), fields: { count, asOf }, poll: { at, pilots, error } } */
export const loadClaims = () => hubGet("/first/claims");
/** { rows: [{ cid, count, callsigns, fields, firstAt, latestAt, reachedAt }], claims, poll } */
export const loadLeaderboard = () => hubGet("/first/leaderboard");

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

/** "2026-10-20 15:04Z" */
export function fmtUtc(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}
/** "just now", "12 min ago", "3 h ago", "4 days ago" */
export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!isFinite(s)) return "";
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400 * 2) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " days ago";
}

export const statsimUrl = (code) => `https://statsim.net/flights/airport/${encodeURIComponent(code)}/thisyear`;
export const skyvectorUrl = (code) => `https://skyvector.com/airport/${encodeURIComponent(code)}`;
export const airnavUrl = (code) => `https://www.airnav.com/airport/${encodeURIComponent(code)}`;
export const vatsimStatsUrl = (cid) => `https://stats.vatsim.net/stats/${encodeURIComponent(cid)}`;

/** The three pages' tab row. */
export function mountTabs(el, active) {
  const tabs = [["fields", "first-to-land.html", "Untouched fields"], ["firsts", "first-to-land-firsts.html", "Firsts"],
    ["leaderboard", "first-to-land-leaderboard.html", "Leaderboard"]];
  el.innerHTML = tabs.map(([id, href, label]) => `<a href="${href}"${id === active ? ' aria-current="page"' : ""}>${label}</a>`).join("");
}

/** The hub watcher's health, as one line for the page. */
export function watcherLine(el, body, err) {
  if (err) {
    el.className = "fl-status bad";
    el.innerHTML = `<i></i>Can't reach the VATFLOW hub right now. Landings are still recorded there; this page will retry.`;
    return;
  }
  const poll = body && body.poll;
  const fresh = poll && poll.at && Date.now() - Date.parse(poll.at) < 120000 && !poll.error;
  el.className = "fl-status" + (fresh ? "" : " bad");
  el.innerHTML = fresh
    ? `<i></i>Watching ${fmtNum(body.fields ? body.fields.count : null)} untouched fields · VATSIM feed read ${ago(poll.at)} · ${fmtNum(poll.pilots)} pilot${poll.pilots === 1 ? "" : "s"} online`
    : `<i></i>The hub isn't reading the VATSIM feed right now${poll && poll.error ? " (" + esc(poll.error) + ")" : ""}. Landings made now may not be recorded.`;
}
