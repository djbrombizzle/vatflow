/*
 * VATFLOW Tower Cab - VATSMART for KDCA on the TMU desk ($SCREEN_VATSMART): the overview
 * of vatflow.io/vatsmart.html?apt=KDCA fitted to one 1024x768 screen:
 *   KPI tiles     capacity, next 60 min, landed 60 min, peak demand, arrival queue,
 *                 inbound, taxi-out, TMI call (coloured as on the page)
 *   chart         arrivals by landing time: 15-minute slots stacked by gate against the
 *                 capacity line, one tick per aircraft at its ETA (hollow = prefiled),
 *                 "now" line, clock-hour totals
 *   recommendations and the gates MIT plan table
 * The analysis is the page's own: common/vatflow-smart.js bundles shared/vatsmart.js
 * (buildSituation) with the MIT monitor, NWS weather window, arrival tracking and the FCA
 * engine ETAs (nav data from vatflow.io). Data: VATSIM feed, VATFLOW hub programs, NWS
 * forecast grid, METAR. Not on the screen: the map, merge points, route advisories, TAF.
 *
 * VatsmartView is plain code (also used by preview/index.html); the MSFS wrapper is at
 * the bottom.
 */
var VatsmartView = (function () {
  var S = typeof VatflowSmart !== "undefined" ? VatflowSmart : null;
  var SITE = "https://vatflow.io/";

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function VatsmartView(root, canvas, cfg) {
    this.root = root;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cfg = cfg;
    this.st = { pilots: [], prefiles: [], hub: {}, feed: "wait", feedAt: 0, wxProps: null, wx: "wait", metar: "",
      arr: S ? S.createArrivalState(Date.now()) : null, nav: "wait", airports: false };
    this.sit = null;
    var q = function (id) { return root.querySelector("#vs-" + id); };
    this.el = { kpis: q("kpis"), recs: q("recs"), gates: q("gates"), pills: q("pills"), zulu: q("zulu"), icao: q("icao"), err: q("err") };
    this.el.icao.textContent = cfg.icao;
  }

  /** Starts the data: feed (30 s), hub, airports + nav data (ETAs), NWS (30 min), METAR (5 min). */
  VatsmartView.prototype.start = function () {
    var self = this, st = this.st, cfg = this.cfg;
    if (!S) { this.fail("VATSMART engine missing (vatflow-smart.js)"); return; }
    S.loadAirports(function () {
      st.airports = true;
      S.bindWindAirportLookup(S.getAirport);
      S.fetchWinds().catch(function () {});
    }).catch(function () {});
    S.loadNavData(SITE + "data/nav").then(function () { st.nav = "ok"; }, function () { st.nav = "bad"; });
    (function feed() {
      VatflowFeed.httpGet(cfg.feedUrl, function (err, text) {
        if (err) st.feed = "bad";
        else { try { self.setFeed(JSON.parse(text)); } catch (e) { st.feed = "bad"; } }
        setTimeout(feed, 30000);
      });
    })();
    if (typeof VatflowHub !== "undefined") VatflowHub.listen(function (h) { st.hub = h; });
    (function wx() {
      var ll = cfg.arp;
      fetch("https://api.weather.gov/points/" + ll.lat.toFixed(4) + "," + ll.lon.toFixed(4), { headers: { Accept: "application/geo+json" } })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (p) { return fetch(p.properties.forecastGridData, { headers: { Accept: "application/geo+json" } }); })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (g) { st.wxProps = g.properties; st.wx = "ok"; }, function () { st.wx = "bad"; });
      setTimeout(wx, 30 * 60000);
    })();
    (function metar() {
      VatflowFeed.httpGet(cfg.metarUrl, function (err, text) { if (!err) st.metar = String(text).trim(); setTimeout(metar, 5 * 60000); });
    })();
  };

  /** The VATSIM feed in the shape the page builds (fetchFeed in vatsmart.html). */
  VatsmartView.prototype.setFeed = function (d) {
    var st = this.st;
    st.pilots = (d.pilots || []).filter(function (p) { return typeof p.latitude === "number"; }).map(function (p) {
      var gs = p.groundspeed || 0;
      var o = { callsign: p.callsign, lat: p.latitude, lon: p.longitude, alt: p.altitude || 0, gs: gs, hdg: p.heading || 0,
        phase: gs < 50 ? "gnd" : "air", wake: S.wakeFromFp(p.flight_plan) };
      var f = S.fpFields(p.flight_plan);
      for (var k in f) o[k] = f[k];
      return o;
    });
    var conn = {};
    st.pilots.forEach(function (p) { conn[p.callsign] = true; });
    st.prefiles = (d.prefiles || []).filter(function (p) { return p.flight_plan && !conn[p.callsign]; }).map(function (p) {
      var o = { callsign: p.callsign, lat: null, lon: null, alt: 0, gs: 0, hdg: 0, phase: "gnd", prefile: true, wake: S.wakeFromFp(p.flight_plan) };
      var f = S.fpFields(p.flight_plan);
      for (var k in f) o[k] = f[k];
      return o;
    });
    st.feed = "ok";
    st.feedAt = Date.now();
    var ll = this.aptLL();
    if (st.arr && ll) S.updateArrivals(st.arr, st.pilots, this.cfg.icao, ll, st.feedAt);
  };

  VatsmartView.prototype.aptLL = function () {
    return (S && S.getAirport(this.cfg.icao)) || [this.cfg.arp.lat, this.cfg.arp.lon];
  };

  /** Runs the page's analysis (buildSituation) on the current data. */
  VatsmartView.prototype.analyse = function (now) {
    var st = this.st, cfg = this.cfg, airport = cfg.icao;
    var prog = S.normPrograms((st.hub && st.hub.rates) || {})[airport] || null;
    var wx = st.wxProps ? S.gridWindow(st.wxProps, now, now + S.HORIZON_MIN * 60000) : null;
    var etaFor = S.isNavReady() ? function (p, gate) { return S.gateEtaFor(p, gate, now); } : null;
    this.sit = S.buildSituation({ airport: airport, aptLL: this.aptLL(), prog: prog, localAar: 0,
      pilots: st.pilots, prefiles: st.prefiles, airportLL: S.getAirport, now: now, wx: wx, hub: st.hub || {}, taxi: null,
      events: [], pastEvents: [], routing: null, merge: null,
      config: { closed: [], runways: null, ends: [], wind: S.windFromMetar(st.metar) },
      actual: st.arr ? { rate: S.landingRate(st.arr, now), holding: S.holdingNow(st.arr, now), recent: st.arr.holds.filter(function (h) { return now - h.end < 2 * 3600000; }) } : null,
      etaFor: etaFor });
    return this.sit;
  };

  function kpi(k, v, s, cls) {
    return '<div class="vs-kpi ' + (cls || "") + '"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + "</div></div>";
  }
  function demandSplit(w) { return w.airborne + " air - " + (w.connected - w.airborne) + " gnd - " + w.prefiled + " pf"; }

  VatsmartView.prototype.renderKpis = function (s) {
    var c = s.cap, pw = s.peakWin, n = s.next60, fz = S.fmtZ;
    var over = function (x) { return !c.capacity ? "" : x > c.capacity ? "red" : x > c.capacity * 0.9 ? "amber" : "green"; };
    var tier = s.tier, tierCls = !tier ? "" : tier.id === "none" ? "green" : tier.id === "mit" ? "amber" : "red";
    var a = s.actual, r = a && a.rate, landed;
    if (!r || r.covered < 5) landed = kpi("Landed 60 min", "—", "counting since this screen started", "");
    else landed = kpi("Landed 60 min", r.last60 + "<small>" + (c.capacity ? " / " + c.capacity : "") + "</small>",
      (r.covered < 60 ? "in " + r.covered + " min watched" : "last hour") + (a.holding.length ? " - " + a.holding.length + " holding" : ""),
      a.holding.length ? "red" : !c.capacity || r.perHr == null ? "" : r.perHr < c.capacity * 0.75 ? "red" : r.perHr < c.capacity * 0.9 ? "amber" : "green");
    var h =
      kpi("Capacity", c.capacity ? c.capacity + "<small>/hr</small>" : "—",
        (c.source === "none" ? "No program" : c.source === "program" ? "Program AAR " + c.aar : "AAR " + c.aar) + (c.factor < 1 ? " - wx x" + c.factor.toFixed(2) : ""),
        c.factor < 1 ? "amber" : "") +
      kpi("Next 60 min", n.total + "<small>" + (c.capacity ? " / " + c.capacity : "") + "</small>", demandSplit(n), over(n.total)) +
      landed +
      kpi("Peak demand 60", pw.total + "<small> @ " + fz(pw.start) + "</small>", fz(pw.start) + "-" + fz(pw.end) + " - " + demandSplit(pw), over(pw.total)) +
      kpi("Arrival queue", s.queue.maxDelay ? s.queue.maxDelay + "<small> min</small>" : "0",
        s.queue.maxDelay ? "longest around " + fz(s.queue.maxAt) : "no queue projected", s.queue.maxDelay > 15 ? "red" : s.queue.maxDelay > 0 ? "amber" : "green") +
      kpi("Inbound", String(s.counts.airborne + s.counts.ground + s.counts.prefile),
        s.counts.airborne + " air - " + s.counts.ground + " gnd - " + s.counts.prefile + " prefile" + (s.counts.excluded ? " - " + s.counts.excluded + " excl" : ""), "") +
      kpi("Taxi-out", "—", "not timed in the cab", "") +
      kpi("TMI call", tier ? (tier.id === "none" ? "NONE" : tier.id === "mit" ? "MIT" : tier.id === "fca" ? "MIT + FCA" : "GDP") : "—",
        tier ? esc(tier.label) : "needs an AAR", tierCls);
    if (h !== this.lastK) { this.el.kpis.innerHTML = h; this.lastK = h; }
  };

  VatsmartView.prototype.renderRecs = function (s) {
    var h = (s.recs || []).slice(0, 4).map(function (r) {
      return '<div class="vs-rec"><span class="sev ' + r.sev + '">' + r.sev.toUpperCase() + '</span><span class="t">' + esc(r.title) +
        '</span><div class="w">' + esc(r.why) + "</div></div>";
    }).join("") || '<div class="vs-rec"><div class="w">Nothing to recommend yet.</div></div>';
    if ((s.recs || []).length > 4) h += '<div class="vs-more">+' + (s.recs.length - 4) + " more on vatsmart.html</div>";
    if (h !== this.lastR) { this.el.recs.innerHTML = h; this.lastR = h; }
  };

  VatsmartView.prototype.renderGates = function (s) {
    var wins = s.roll.windows, fz = S.fmtZ;
    var rows = s.gates.filter(function (g) { return g.inbound || g.peakDemand || g.nowNm; }).slice(0, 8);
    var h = '<div class="vs-gr vs-gh"><span class="g">GATE</span><span class="n">INB</span><span class="n">AIR</span><span class="n">N60</span><span class="n">PK</span><span class="n">MIT</span><span class="p">MIT PLAN</span></div>';
    h += rows.map(function (g) {
      var plan = g.mits.map(function (m, i) {
        return '<i class="' + (m ? (m >= 30 ? "m2" : "m") : "") + (i === s.roll.peak ? " pk" : "") + '">' + (m || "·") + "</i>";
      }).join("");
      return '<div class="vs-gr"><span class="g"><b style="background:' + g.color + '"></b>' + esc(g.name) + '</span><span class="n">' + (g.inbound || 0) +
        '</span><span class="n">' + (g.airborne || 0) + '</span><span class="n">' + (g.demand60 || 0) + '</span><span class="n">' + g.peakDemand +
        '</span><span class="n">' + (g.nowNm || "—") + '</span><span class="p">' + plan + "</span></div>";
    }).join("");
    if (rows.length) {
      h += '<div class="vs-gr vs-gt"><span class="g"></span><span class="n"></span><span class="n"></span><span class="n"></span><span class="n"></span><span class="n"></span><span class="p">' +
        wins.map(function (w, i) { return "<i>" + (i % 2 ? "" : fz(w.start).slice(0, 4)) + "</i>"; }).join("") + "</span></div>";
    } else h += '<div class="vs-rec"><div class="w">No arrivals with a filed route to ' + esc(s.airport) + " in the next 3 hours.</div></div>";
    if (h !== this.lastG) { this.el.gates.innerHTML = h; this.lastG = h; }
  };

  VatsmartView.prototype.renderPills = function (now) {
    var st = this.st, hub = typeof VatflowHub !== "undefined" ? VatflowHub.status() : "bad";
    var pill = function (state, text) { return '<span class="pill ' + state + '">● ' + text + "</span>"; };
    var h = pill(st.feed, st.feed === "ok" ? "VATSIM" : st.feed === "bad" ? "VATSIM DOWN" : "VATSIM ...") +
      pill(hub, hub === "ok" ? "PROGRAMS" : hub === "bad" ? "PROGRAMS OFF" : "PROGRAMS ...") +
      pill(st.wx, st.wx === "ok" ? "NWS" : st.wx === "bad" ? "NWS N/A" : "NWS ...") +
      pill(S && S.isNavReady() ? "ok" : st.nav, S && S.isNavReady() ? "FCA ETAS" : st.nav === "bad" ? "GC ETAS" : "ETAS ...");
    if (h !== this.lastP) { this.el.pills.innerHTML = h; this.lastP = h; }
    var z = new Date(now);
    this.el.zulu.textContent = VatflowFeed.pad(z.getUTCHours(), 2) + VatflowFeed.pad(z.getUTCMinutes(), 2) + "Z";
  };

  /** Arrivals by landing time (the page's renderChart, drawn on canvas). */
  VatsmartView.prototype.drawChart = function (s) {
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, fz = S.fmtZ;
    var padL = 30, padR = 8, padT = 22, stripH = 18, padB = 40;
    var SLOT = 15 * 60000, cap = s.cap.capacity, perSlot = cap / 4;
    var slots = S.landingSlots(s.live, s.now), nSlots = slots.length, t0 = slots[0].start, t1 = t0 + nSlots * SLOT;
    var colors = s.mon.colors;
    var colOf = function (g) { return !g || g === S.NO_GATE ? "#3a4654" : colors[g] || "#6b7a89"; };
    var maxV = Math.max.apply(null, [perSlot * 1.4 || 4, 4].concat(slots.map(function (sl) { return sl.total; }))) * 1.12;
    var plotB = H - padB - stripH;
    var y = function (v) { return padT + (plotB - padT) * (1 - v / maxV); };
    var xOf = function (t) { return padL + (W - padL - padR) * (t - t0) / (t1 - t0); };
    var bw = (W - padL - padR) / nSlots;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0e1319"; ctx.fillRect(0, 0, W, H);
    ctx.font = "12px monospace"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#8a97a3"; ctx.textAlign = "left";
    ctx.fillText("ARRIVALS BY LANDING TIME - landings per 15 min by gate - ▲ each aircraft at its ETA", padL, 14);
    var step = maxV > 24 ? 5 : maxV > 10 ? 2 : 1;
    ctx.textAlign = "right";
    for (var v = 0; v <= maxV; v += step) {
      ctx.strokeStyle = "#1a222c"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W - padR, y(v)); ctx.stroke();
      ctx.fillStyle = "#5c6b78"; ctx.fillText(String(v), padL - 5, y(v) + 4);
    }
    for (var hh = Math.ceil(t0 / 3600000) * 3600000 - 3600000; hh < t1; hh += 3600000) {        // hour shading
      if (Math.round(hh / 3600000) % 2) continue;
      var a = xOf(Math.max(t0, hh)), b = xOf(Math.min(t1, hh + 3600000));
      if (b > a) { ctx.fillStyle = "rgba(255,255,255,0.025)"; ctx.fillRect(a, padT, b - a, plotB + stripH - padT); }
    }
    ctx.textAlign = "center";
    slots.forEach(function (sl, i) {
      var x = padL + i * bw + bw * 0.16, wd = bw * 0.68, acc = 0;
      var parts = Object.keys(sl.gates).filter(function (g) { return g !== S.NO_GATE; }).map(function (g) { return [g, sl.gates[g]]; })
        .sort(function (p, q) { return q[1] - p[1]; });
      if (sl.gates[S.NO_GATE]) parts.push([S.NO_GATE, sl.gates[S.NO_GATE]]);
      parts.forEach(function (p) {
        ctx.globalAlpha = 0.88; ctx.fillStyle = colOf(p[0]);
        ctx.fillRect(x, y(acc + p[1]), wd, Math.max(0, y(acc) - y(acc + p[1]) - 1));
        ctx.globalAlpha = 1;
        acc += p[1];
      });
      if (sl.total) {
        ctx.fillStyle = perSlot && sl.total > perSlot ? "#e07070" : "#d4dde6"; ctx.font = "bold 13px monospace";
        ctx.fillText(String(sl.total), x + wd / 2, y(sl.total) - 4); ctx.font = "12px monospace";
      }
    });
    if (cap) {
      ctx.strokeStyle = "#e8a838"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(padL, y(perSlot)); ctx.lineTo(W - padR, y(perSlot)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#e8a838"; ctx.textAlign = "right";
      ctx.fillText("capacity " + cap + "/hr - " + (+perSlot.toFixed(1)) + " per 15 min", W - padR, y(perSlot) - 4);
    }
    var cy = plotB + stripH / 2;                                       // one tick per aircraft
    ctx.strokeStyle = "#1f2933"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, cy); ctx.lineTo(W - padR, cy); ctx.stroke();
    s.live.forEach(function (f) {
      if (f.eta >= t1) return;
      var x = xOf(Math.max(t0, f.eta)), c = colOf(f.gate);
      ctx.beginPath(); ctx.moveTo(x - 4, cy + 5); ctx.lineTo(x, cy - 5); ctx.lineTo(x + 4, cy + 5); ctx.closePath();
      if (f.prefiled) { ctx.strokeStyle = c; ctx.lineWidth = 1.2; ctx.stroke(); } else { ctx.fillStyle = c; ctx.fill(); }
    });
    var xn = xOf(s.now);                                                // now
    ctx.strokeStyle = "#4fb8d6"; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(xn, padT); ctx.lineTo(xn, plotB + stripH); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#4fb8d6"; ctx.textAlign = "left"; ctx.fillText("now", xn + 4, padT + 10);
    ctx.textAlign = "center";
    for (var i = 0; i <= nSlots; i++) {                                 // quarter-hour labels, hours bold
      var t = t0 + i * SLOT, xx = xOf(t), top = new Date(t).getUTCMinutes() === 0;
      if (i < nSlots || top) {
        ctx.font = top ? "bold 12px monospace" : "12px monospace";
        ctx.fillStyle = top ? "#d4dde6" : "#5c6b78";
        if (top || i % 2 === 0) ctx.fillText(fz(t), xx, plotB + stripH + 15);
      }
    }
    ctx.font = "12px monospace";
    for (var h0 = Math.floor(t0 / 3600000) * 3600000; h0 < t1; h0 += 3600000) {   // clock-hour totals
      var a0 = Math.max(t0, h0), b0 = Math.min(t1, h0 + 3600000);
      if (b0 - a0 < 30 * 60000) continue;
      var n = s.live.filter(function (f) { return (f.eta >= h0 || (h0 <= t0 && f.eta < h0 + 3600000)) && f.eta < h0 + 3600000; }).length;
      ctx.fillStyle = cap && n > cap ? "#e07070" : "#8a98a6";
      ctx.fillText(fz(h0).slice(0, 2) + "z hour: " + n + (cap ? " / " + cap : "") + (b0 < h0 + 3600000 ? " (part)" : ""), (xOf(a0) + xOf(b0)) / 2, H - 6);
    }
  };

  VatsmartView.prototype.fail = function (msg) { if (this.el.err) this.el.err.textContent = msg; };

  /** Called about once a second; the analysis runs every 10 s (and on new data). */
  VatsmartView.prototype.draw = function (now) {
    now = now || Date.now();
    this.renderPills(now);
    if (!S || !this.st.feedAt) return;
    if (!this.sit || now - this.sitAt > 10000 || this.st.feedAt !== this.sitFeedAt) {
      try { this.analyse(now); this.sitAt = now; this.sitFeedAt = this.st.feedAt; this.fail(""); }
      catch (e) { this.fail("VATSMART: " + ((e && e.message) || e)); return; }
    }
    var s = this.sit;
    this.renderKpis(s); this.renderRecs(s); this.renderGates(s); this.drawChart(s);
  };

  return VatsmartView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowVatsmart extends BaseInstrument {
    get templateID() { return "VatflowVatsmart"; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      this.view = new VatsmartView(this.querySelector("#vs-root"), this.querySelector("#vs-chart"), VATFLOW_TWR);
      this.view.start();
      this.tick = VatflowDraw.loop(this.view, 1000);
    }
    Update() {
      super.Update();
      this.dim();
      this.tick(false);
    }
  }
  registerInstrument("vatflow-vatsmart", VatflowVatsmart);
}
