/**
 * Dispatch Center live mode: the VATSIM feed, plus shared ops state on
 * vUSAlink-hub.
 *
 * Same interface as the demo store (aoc-demo.js). The feed alone gives the
 * whole read-only picture (map, board, phases, alerts); the hub adds the
 * shared notes, acknowledged alerts and telex. The hub is the authority on who
 * may write: a signed-in VATFLOW user whose whitelist entry has the
 * `dispatcher` role for this operator code (or a global admin). Everyone else
 * is read-only.
 *
 * Endpoints (vUSAlink-hub aoc.py; see docs/airline-ops-plan.md §5.4):
 *   POST /hub/aoc/state {op, watch, cid?, vatflowToken?} -> {ok, state, me, station, dryRun, hoppie}
 *   POST /hub/aoc/op    {op, cid, vatflowToken, o: {op: "note"|"ack", ...}}
 *   POST /hub/aoc/telex {op, cid, vatflowToken, to, text, force?}
 *
 * `hoppie` is {callsign: connected} from the hub's Hoppie ping of the
 * operator's online flights. A telex to a callsign Hoppie says is not
 * connected is refused (409, offline) unless sent with force.
 */
import { emptyState } from "./aoc-core.js";
import { rampHubBase } from "./ramp-live.js";
import { getSession, getStoredToken } from "./vatflow-auth.js";

const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const STATE_MS = 5000;
/** A hub without the Dispatch Center endpoints is asked again this rarely. */
const NO_HUB_MS = 120000;
const FEED_MS = 15000;

export function createLiveStore(W) {
  let state = emptyState(W.code);
  let feed = { pilots: [], prefiles: [] };
  let hoppie = {};
  let noEndpoints = false;
  const listeners = new Set();
  const store = {
    mode: "live",
    me: { canWrite: false, callsign: "", reason: "Connecting to the hub…" },
    status: { ok: false, text: "Connecting…" },
    feedStatus: { ok: false, text: "Loading the VATSIM feed…", at: 0 },
    station: W.station,
    dryRun: false,
    getState: () => state,
    getFeed: () => feed,
    getHistory: () => ({}),
    getHoppie: () => hoppie,
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
  let lastStatePull = 0;

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
      body: JSON.stringify({ op: W.code, watch: [...W.callsigns], ...authBody(), ...body }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (res.status === 404 && (!data || /unknown endpoint/i.test(data.error || ""))) {
      const e = new Error("The hub has no Dispatch Center endpoints yet.");
      e.noEndpoints = true;
      throw e;
    }
    if (!data) throw new Error(`hub HTTP ${res.status}`);
    return data;
  }

  async function pullState() {
    if (noEndpoints && Date.now() - lastStatePull < NO_HUB_MS) return;
    lastStatePull = Date.now();
    try {
      const d = await post("/hub/aoc/state", {});
      if (!d.ok) {
        // A hub without aoc.py refuses the unknown path (403 sign-in, or 404) before routing it.
        // Once deployed, the state read answers everyone, signed in or not (as /hub/ramp/state does).
        const e = new Error(`The hub has no Dispatch Center endpoints yet (${d.error || "refused"}).`);
        e.noEndpoints = true;
        throw e;
      }
      noEndpoints = false;
      state = d.state || emptyState(W.code);
      store.me = d.me || { canWrite: false, reason: "" };
      store.station = d.station || W.station;
      store.dryRun = !!d.dryRun;
      hoppie = d.hoppie || {};
      store.status = { ok: true, text: `Hub connected · telex station ${store.station || "?"}${store.dryRun ? " (dry run)" : ""}` };
    } catch (e) {
      noEndpoints = !!e.noEndpoints;
      store.status = { ok: false, text: e.message || String(e) };
      store.me = {
        canWrite: false, callsign: "",
        reason: noEndpoints
          ? "Telex, notes and alert acknowledgements arrive with the hub's Dispatch Center update. The board and map work from the VATSIM feed."
          : "Hub unreachable. The board and map still work from the VATSIM feed.",
      };
    }
    emit();
  }

  async function pullFeed() {
    try {
      const r = await fetch(VATSIM_URL, { cache: "no-store" });
      const d = await r.json();
      feed = { pilots: d.pilots || [], prefiles: d.prefiles || [] };
      store.feedStatus = { ok: true, text: `VATSIM feed ${d.general?.update_timestamp ? new Date(d.general.update_timestamp).toISOString().slice(11, 19) + "Z" : ""}`, at: Date.now() };
    } catch (e) {
      store.feedStatus = { ok: false, text: `VATSIM feed error: ${e.message || e}`, at: store.feedStatus.at };
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
      const d = await post("/hub/aoc/op", { o });
      if (d.ok && d.state) state = d.state;
      emit();
      return d.ok ? { ok: true } : { ok: false, error: d.error || "Rejected" };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  async function sendTelex(to, text, { force = false } = {}) {
    try {
      const d = await post("/hub/aoc/telex", force ? { to, text, force: true } : { to, text });
      if (d.state) state = d.state;
      emit();
      if (d.ok) return { ok: true, dryRun: !!d.dryRun };
      return { ok: false, error: d.error || "Send failed", offline: !!d.offline };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  return store;
}
