/**
 * Ramp Management live mode: shared state on vUSAlink-hub plus the VATSIM feed.
 *
 * Same interface as the demo store (ramp-demo.js), so the page does not care
 * which one it is driving. The hub is the authority on who may write: only a
 * controller signed in to VATFLOW and on position at the field as _RMP, _GND
 * or _TWR. Everyone else gets the read-only picture.
 *
 * Endpoints (vUSAlink-hub ramp.py):
 *   POST /hub/ramp/state  {icao, cid?, vatflowToken?}  -> {state, me, station, dryRun}
 *   POST /hub/ramp/op     {icao, cid, vatflowToken, op, ...}
 *   POST /hub/ramp/telex  {icao, cid, vatflowToken, to, text}
 */
import { emptyState } from "./ramp-core.js";
import { getSession, getStoredToken } from "./vatflow-auth.js";

export const DEFAULT_RAMP_HUB = "https://web-production-3d9fe.up.railway.app";
const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const STATE_MS = 3000;
const FEED_MS = 15000;

/**
 * Hub base: ?hub= on the page URL (localhost only), then localStorage
 * vatflow.rampHub, then the shared hub. The page sends the viewer's VATFLOW
 * sign-in token to the hub, so a link must never be able to point it at an
 * arbitrary server; ?hub= is only for testing against a hub on this machine.
 */
export function rampHubBase() {
  let url = "";
  try {
    const q = new URLSearchParams(location.search).get("hub") || "";
    if (isLocalHub(q)) url = q;
    url ||= localStorage.getItem("vatflow.rampHub") || "";
  } catch (_) {}
  return (url || DEFAULT_RAMP_HUB).replace(/\/+$/, "");
}

export function isLocalHub(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch (_) {
    return false;
  }
}

export function createLiveStore(L) {
  let state = emptyState(L.icao);
  let pilots = [];
  const listeners = new Set();
  const store = {
    mode: "live",
    me: { canWrite: false, callsign: "", reason: "Connecting to the hub…" },
    status: { ok: false, text: "Connecting…" },
    station: "",
    dryRun: false,
    getState: () => state,
    getPilots: () => pilots,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start,
    stop,
    op,
    sendTelex,
  };
  let stateTimer = null;
  let feedTimer = null;

  function emit() {
    for (const fn of listeners) fn();
  }

  function authBody() {
    const s = getSession();
    const token = getStoredToken();
    return s && s.cid && token ? { cid: String(s.cid), vatflowToken: token } : {};
  }

  async function post(path, body) {
    const res = await fetch(rampHubBase() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icao: L.icao, ...authBody(), ...body }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (res.status === 404 && (!data || /unknown endpoint/i.test(data.error || ""))) {
      throw new Error("This hub has no ramp endpoints yet (deploy the vUSAlink-hub ramp update).");
    }
    if (!data) throw new Error(`hub HTTP ${res.status}`);
    return data;
  }

  async function pullState() {
    try {
      const d = await post("/hub/ramp/state", {});
      if (!d.ok) throw new Error(d.error || "hub error");
      state = d.state || emptyState(L.icao);
      store.me = d.me || { canWrite: false, reason: "" };
      store.station = d.station || "";
      store.dryRun = !!d.dryRun;
      store.status = { ok: true, text: `Hub connected · telex station ${store.station || "?"}${store.dryRun ? " (dry run)" : ""}` };
    } catch (e) {
      store.status = { ok: false, text: e.message || String(e) };
      store.me = { canWrite: false, callsign: "", reason: "Hub unreachable" };
    }
    emit();
  }

  async function pullFeed() {
    try {
      const r = await fetch(VATSIM_URL, { cache: "no-store" });
      const d = await r.json();
      pilots = d.pilots || [];
    } catch (_) {
      /* keep the last feed */
    }
    emit();
  }

  function start() {
    pullState();
    pullFeed();
    stateTimer ||= setInterval(pullState, STATE_MS);
    feedTimer ||= setInterval(pullFeed, FEED_MS);
  }

  function stop() {
    clearInterval(stateTimer);
    clearInterval(feedTimer);
    stateTimer = feedTimer = null;
  }

  async function op(o) {
    try {
      const d = await post("/hub/ramp/op", o);
      if (d.state) state = d.state;
      emit();
      return d.ok ? { ok: true } : { ok: false, error: d.error || "rejected" };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  async function sendTelex(to, text) {
    try {
      const d = await post("/hub/ramp/telex", { to, text });
      if (d.state) state = d.state;
      emit();
      return d.ok ? { ok: true, dryRun: !!d.dryRun } : { ok: false, error: d.error || "rejected" };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  return store;
}
