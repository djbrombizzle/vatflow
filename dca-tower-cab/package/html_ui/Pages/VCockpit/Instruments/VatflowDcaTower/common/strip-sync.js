/*
 * VATFLOW Tower Cab - STRIP SYNC: several cabs at the same airport share their flight strips
 * through the VATFLOW hub (vatflow-hub cab-sync.js), so a strip the ground controller moves
 * to LOCAL turns up on the local controller's LOCAL bay.
 *
 * Turned on at TOWER SETUP > STRIP SYNC with a 6-digit code everyone in the tower types
 * (VatflowStore "STRIPSYNC" = {on, code}); the room is the airport plus the code
 * ("KATL-482913"). Shared: the strips, where they are (bay / section / order), deleted
 * strips, and the bay setup (names, separators, columns, new-strip section, AUTO DROP).
 * Kept to yourself: the strip you are holding and where your bays sit in your cab.
 *
 * The room is a key -> value store on the hub (last write of a key wins, every cab gets
 * every change in the same order):
 *   s:<id>   the strip (without its local "seen" time)
 *   p:<id>   {b, s, o}: bay, section, order (a number: between its neighbours, so moving one
 *            strip changes one key and two people moving different strips never clash)
 *   d:<id>   deleted by a controller (the flight plan revision; it doesn't print again)
 *   cfg      the shared part of the bay setup
 *
 * One screen runs it (strip bay 1, like the VATSIM strip reader): it notices local changes
 * by the strips revision (L:VATFLOW_STRIPS_REV), sends the keys that differ, and writes the
 * room's changes into the strips storage the bay screens already read. Status for TOWER
 * SETUP: VatflowStore "STRIPSYNC_STATUS" = {state, room, peers, error}.
 */
var VatflowStripSync = (function () {
  var HUB = "wss://vatflow-hub-production.up.railway.app";
  var MAX_SET = 300;
  var S = function () { return VatflowStrips; };

  // ---- strips <-> keys ------------------------------------------------------------------

  /** Longest run of strictly increasing numbers (indexes into ords; null entries skipped). */
  function lis(ords) {
    var idx = [], tails = [], prev = [];
    for (var i = 0; i < ords.length; i++) {
      if (ords[i] == null) continue;
      var lo = 0, hi = tails.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (ords[tails[mid]] < ords[i]) lo = mid + 1; else hi = mid; }
      prev[i] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = i;
    }
    for (var k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) idx.unshift(k);
    return idx;
  }

  /**
   * Order numbers for a section's ids (in their order), keeping the ones already in the room
   * where they still fit, so a move changes as few keys as possible.
   */
  function ordsFor(ids, b, s, kv) {
    var have = ids.map(function (id) {
      var p = kv["p:" + id];
      return p && p.b === b && p.s === s && typeof p.o === "number" ? p.o : null;
    });
    var keep = {}, out = [];
    lis(have).forEach(function (i) { keep[i] = true; });
    var last = null;
    for (var i = 0; i < ids.length; i++) {
      if (keep[i]) { out.push(have[i]); last = have[i]; continue; }
      var next = null;
      for (var j = i + 1; j < ids.length; j++) if (keep[j]) { next = have[j]; break; }
      var o = last == null ? (next == null ? 1 : next - 1) : (next == null ? last + 1 : (last + next) / 2);
      if (last != null && next != null && next - last < 1e-9) return ids.map(function (_, k) { return k + 1; });  // worn out: renumber
      out.push(o);
      last = o;
    }
    return out;
  }

  function sharedCfg(cfg) {
    return {
      bays: cfg.bays.map(function (b) { return { name: b.name, seps: b.seps.slice(), cols: S().cols(b) }; }),
      newBay: cfg.newBay, newSec: cfg.newSec, autoDrop: cfg.autoDrop !== false
    };
  }

  function stripValue(s) {
    var v = JSON.parse(JSON.stringify(s));
    delete v.seen;
    if (v.route && v.route.length > 1500) v.route = v.route.slice(0, 1500);
    return v;
  }

  /** What the room should hold for this airport's strips (kv: the room as we know it). */
  function toKv(st, cfg, kv) {
    var out = { cfg: sharedCfg(cfg) };
    for (var id in st.strips) out["s:" + id] = stripValue(st.strips[id]);
    for (var b = 0; b < st.bays.length; b++) {
      for (var s = 0; s < st.bays[b].length; s++) {
        var ids = st.bays[b][s], ords = ordsFor(ids, b, s, kv);
        for (var i = 0; i < ids.length; i++) out["p:" + ids[i]] = { b: b, s: s, o: ords[i] };
      }
    }
    for (var d in st.dismissed) out["d:" + d] = st.dismissed[d];
    return out;
  }

  /** JSON with object keys sorted, so the same data always compares equal. */
  function canon(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
  }
  function same(a, b) { return canon(a) === canon(b); }

  /** Keys to send to turn kv into want (null = delete). */
  function diff(want, kv) {
    var set = {}, n = 0;
    for (var k in want) if (!(k in kv) || !same(want[k], kv[k])) { set[k] = want[k]; n++; }
    for (var j in kv) if (!(j in want) && /^(s|p|d):/.test(j)) { set[j] = null; n++; }
    return n ? set : null;
  }

  function applySet(kv, set) {
    for (var k in set) { if (set[k] === null) delete kv[k]; else kv[k] = set[k]; }
  }

  /** The room's keys -> this cab's strips and bay setup (its own held strip and bay spots kept). */
  function fromKv(kv, localCfg, localSt, now) {
    var cfg = JSON.parse(JSON.stringify(localCfg)), c = kv.cfg;
    if (c && c.bays && c.bays.length === cfg.bays.length) {
      for (var b = 0; b < cfg.bays.length; b++) {
        cfg.bays[b].name = c.bays[b].name;
        cfg.bays[b].seps = (c.bays[b].seps || []).slice();
        cfg.bays[b].cols = (c.bays[b].cols || []).slice();
      }
      cfg.newBay = c.newBay; cfg.newSec = c.newSec; cfg.autoDrop = c.autoDrop;
    }
    var st = S().emptyState(), pos = [];
    st.bays = cfg.bays.map(function (bay) {
      var secs = [];
      for (var i = 0; i < Math.max(1, bay.seps.length); i++) secs.push([]);
      return secs;
    });
    for (var k in kv) {
      var id = k.slice(2);
      if (k.indexOf("s:") === 0) {
        var s = JSON.parse(JSON.stringify(kv[k]));
        var old = localSt.strips[id];
        s.seen = old && old.seen ? old.seen : now;
        st.strips[id] = s;
      } else if (k.indexOf("d:") === 0) st.dismissed[id] = kv[k];
    }
    for (var sid in st.strips) {
      var p = kv["p:" + sid] || { b: cfg.newBay, s: cfg.newSec, o: Infinity };
      var bb = Math.min(st.bays.length - 1, Math.max(0, p.b | 0));
      var ss = Math.min(st.bays[bb].length - 1, Math.max(0, p.s | 0));
      pos.push({ id: sid, b: bb, s: ss, o: typeof p.o === "number" ? p.o : Infinity });
    }
    pos.sort(function (x, y) { return x.o - y.o || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0); });
    pos.forEach(function (p) { st.bays[p.b][p.s].push(p.id); });
    st.held = localSt.held && st.strips[localSt.held] ? localSt.held : null;
    return { st: S().normalize(st, cfg), cfg: cfg };
  }

  // ---- the connection -------------------------------------------------------------------

  /**
   * opts: { icao, url?, WebSocket?, now? }
   * Call tick() often (the bay screen's Update); it connects, sends and applies by itself.
   */
  function Client(opts) {
    this.icao = opts.icao;
    this.url = opts.url || HUB;
    this.WS = opts.WebSocket || (typeof WebSocket !== "undefined" ? WebSocket : null);
    this.now = opts.now || function () { return Date.now(); };
    this.ws = null;
    this.room = null;          // the room we should be in
    this.joined = null;        // the room the hub has us in
    this.synced = null;        // the room the kv belongs to (kept over a reconnect)
    this.kv = {};
    this.lastRev = null;
    this.status = { state: "off", room: null, peers: [], error: "" };
    this.retry = 0;
    this.retryAt = 0;
    this.opN = 0;
  }

  Client.prototype.setStatus = function (patch) {
    var next = JSON.parse(JSON.stringify(this.status));
    for (var k in patch) next[k] = patch[k];
    if (same(next, this.status)) return;
    this.status = next;
    VatflowStore.set("STRIPSYNC_STATUS", next);
  };

  Client.prototype.wanted = function () {
    var s = VatflowStore.get("STRIPSYNC", null);
    return s && s.on && /^\d{6}$/.test(s.code || "") ? this.icao + "-" + s.code : null;
  };

  Client.prototype.tick = function () {
    var want = this.wanted();
    if (want !== this.room) {
      this.room = want;
      this.synced = null;
      this.kv = {};
      if (this.ws && this.joined) this.send({ type: "cab-leave" });
      this.joined = null;
      if (!want) { this.close(); this.setStatus({ state: "off", room: null, peers: [], error: "" }); return; }
      this.setStatus({ state: "connecting", room: want, peers: [], error: "" });
      if (this.ws && this.ws.readyState === 1) this.join();
    }
    if (!this.room) return;
    if (!this.ws && this.now() >= this.retryAt) this.connect();
    if (this.joined === this.room) this.pushLocal();
  };

  Client.prototype.connect = function () {
    if (!this.WS) { this.setStatus({ state: "error", error: "NO WEBSOCKET" }); return; }
    var self = this, ws;
    try { ws = new this.WS(this.url); } catch (e) { this.retryLater(); return; }
    this.ws = ws;
    ws.onopen = function () { self.retry = 0; if (self.room) self.join(); };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && typeof m.type === "string" && m.type.indexOf("cab-") === 0) self.onMessage(m);
    };
    ws.onclose = function () {
      if (self.ws !== ws) return;
      self.ws = null;
      self.joined = null;
      if (self.room) { self.setStatus({ state: "connecting", peers: [] }); self.retryLater(); }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* closing anyway */ } };
  };

  Client.prototype.retryLater = function () {
    this.retry = Math.min(this.retry + 1, 6);
    this.retryAt = this.now() + 2000 * this.retry;
  };

  Client.prototype.close = function () {
    var ws = this.ws;
    this.ws = null;
    this.joined = null;
    if (ws) { try { ws.close(); } catch (e) { /* gone */ } }
  };

  Client.prototype.send = function (m) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(m)); return true; } catch (e) { return false; }
  };

  Client.prototype.join = function () {
    this.send({ type: "cab-join", room: this.room, cid: String(VatflowStore.get("CID", "") || ""), name: "" });
  };

  Client.prototype.local = function () {
    var cfg = S().config(this.icao);
    return { cfg: cfg, st: S().normalize(S().state(this.icao), cfg) };
  };

  /** Sends what changed here (since the room as we know it), in pieces the hub accepts. */
  Client.prototype.sendDiff = function (set) {
    var keys = Object.keys(set);
    for (var i = 0; i < keys.length; i += MAX_SET) {
      var part = {};
      keys.slice(i, i + MAX_SET).forEach(function (k) { part[k] = set[k]; });
      this.send({ type: "cab-set", room: this.room, op: "o" + (++this.opN), set: part });
    }
    applySet(this.kv, set);
  };

  /** Local change (another screen bumped the strips revision): send it. */
  Client.prototype.pushLocal = function (force) {
    var r = S().rev();
    if (!force && r === this.lastRev) return;
    this.lastRev = r;
    var l = this.local(), set = diff(toKv(l.st, l.cfg, this.kv), this.kv);
    if (set) this.sendDiff(set);
  };

  /** The room's state -> the strips storage (and tell the screens). */
  Client.prototype.writeLocal = function () {
    var l = this.local(), out = fromKv(this.kv, l.cfg, l.st, this.now());
    var changed = false;
    if (!same(out.cfg, l.cfg)) { VatflowStore.set("STRIPCFG_" + this.icao, out.cfg); changed = true; }
    if (!same(out.st, l.st)) { VatflowStore.set("STRIPS_" + this.icao, out.st); changed = true; }
    if (changed) this.lastRev = S().bump();
  };

  Client.prototype.onMessage = function (m) {
    if (m.type === "cab-error") { this.setStatus({ error: String(m.error || "").toUpperCase() }); return; }
    if (m.room && m.room !== this.room) return;
    if (m.type === "cab-peers") { this.setStatus({ peers: (m.peers || []).map(function (p) { return p.cid || "?"; }) }); return; }
    if (m.type === "cab-snap") {
      var room = m.kv || {}, l = this.local();
      this.joined = this.room;
      this.setStatus({ state: "ok", error: "" });
      if (this.synced === this.room) {
        // back after a drop: what changed here meanwhile goes on top of the room
        var mine = diff(toKv(l.st, l.cfg, this.kv), this.kv);
        this.kv = JSON.parse(JSON.stringify(room));
        if (mine) this.sendDiff(mine);
        this.writeLocal();
      } else if (!Object.keys(room).length) {
        // a new room: this cab's strips start it
        this.kv = {};
        this.synced = this.room;
        this.pushLocal(true);
      } else {
        // joining a room in use: its strips replace ours
        this.kv = JSON.parse(JSON.stringify(room));
        this.synced = this.room;
        this.writeLocal();
      }
      this.lastRev = S().rev();
      return;
    }
    if (m.type === "cab-set" && this.joined === this.room) {
      this.pushLocal();                     // ours first, so a remote change can't wipe it
      applySet(this.kv, m.set || {});
      this.writeLocal();
    }
  };

  /** Starts the client for this airport (once per cab: strip bay 1's screen). */
  function start(icao) {
    if (start.client) return start.client;
    var c = start.client = new Client({ icao: icao });
    setInterval(function () { try { c.tick(); } catch (e) { if (typeof console !== "undefined") console.error("VATFLOW strip sync", e); } }, 500);
    return c;
  }

  /** A fresh random 6-digit code. */
  function newCode() { return String(100000 + Math.floor(Math.random() * 900000)); }

  return { toKv: toKv, fromKv: fromKv, diff: diff, applySet: applySet, ordsFor: ordsFor, lis: lis,
    same: same, Client: Client, start: start, newCode: newCode, HUB: HUB };
})();
