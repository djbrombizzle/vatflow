/*
 * VATFLOW Tower Cab - SETUP screen (an app on any 1024x768 cab screen, via the screen
 * menu). Puts the cab in the tower and lets you move it there with on-screen buttons:
 *   PLACE IN TOWER    go to the spot (your saved one, the tower list, or OpenStreetMap's)
 *   arrows / UP / DN / TURN   nudge by the chosen step, frozen again after each move
 *   SAVE THIS SPOT    remember it for this airport (the sim's storage, per user)
 *   RELEASE           unfreeze (slew / fly it yourself)
 *   AUTO PLACE        go to the tower by itself when a flight starts at this airport
 *   VATSIM CID        your CID for the IDST (typed on the keypad, kept per user)
 * Plain DOM code, also used by the browser preview (where nothing can move).
 */
var SetupView = (function () {
  var STEPS = [[0.5, 1], [2, 5], [10, 15]];       // [meters / feet, degrees]
  var MONTHS = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(" ");

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var HTML =
    '<div class="su-root">' +
    '<div class="su-top"><span class="su-title">TOWER SETUP</span><span class="su-apt" data-f="apt">----</span><span class="su-zulu" data-f="zulu">----Z</span></div>' +
    '<div class="su-state" data-f="state">LOCATING AIRPORT...</div>' +
    '<div class="su-line"><span class="su-k">SPOT</span><span data-f="src">-</span></div>' +
    '<div class="su-line"><span class="su-k">TARGET</span><span data-f="target">-</span></div>' +
    '<div class="su-line"><span class="su-k">CAB NOW</span><span data-f="now">-</span></div>' +
    '<div class="su-main">' +
    '  <div class="su-col">' +
    '    <div class="su-btn su-big su-go" data-k="place">PLACE IN TOWER</div>' +
    '    <div class="su-btn su-big" data-k="save">SAVE THIS SPOT</div>' +
    '    <div class="su-btn" data-k="release">RELEASE</div>' +
    '    <div class="su-btn" data-k="forget">FORGET SAVED SPOT</div>' +
    '    <div class="su-btn su-check" data-k="auto"><span data-f="auto">[X]</span> AUTO PLACE ON SPAWN</div>' +
    '  </div>' +
    '  <div class="su-col su-pad">' +
    '    <div class="su-ph">MOVE THE CAB <span data-f="step"></span></div>' +
    '    <div class="su-steps"><div class="su-btn su-chip" data-k="step0">FINE</div><div class="su-btn su-chip" data-k="step1">MEDIUM</div><div class="su-btn su-chip" data-k="step2">BIG</div></div>' +
    '    <div class="su-grid">' +
    '      <div class="su-btn su-arrow" data-k="tl">TURN L</div><div class="su-btn su-arrow" data-k="fwd">FWD</div><div class="su-btn su-arrow" data-k="tr">TURN R</div>' +
    '      <div class="su-btn su-arrow" data-k="left">LEFT</div><div class="su-mid">CAB</div><div class="su-btn su-arrow" data-k="right">RIGHT</div>' +
    '      <div class="su-btn su-arrow" data-k="up">UP</div><div class="su-btn su-arrow" data-k="back">BACK</div><div class="su-btn su-arrow" data-k="down">DOWN</div>' +
    '    </div>' +
    '    <div class="su-hint">FWD / BACK / LEFT / RIGHT ARE AS SEEN LOOKING OUT THE FRONT WINDOW</div>' +
    '  </div>' +
    '</div>' +
    '<div class="su-cid su-brt"><span class="su-k">BRIGHTNESS</span><span data-f="brt">-</span>' +
    '  <div class="su-btn su-chip su-wide" data-k="dim">DIMMER</div><div class="su-btn su-chip su-wide" data-k="bright">BRIGHTER</div>' +
    '  <div class="su-btn su-chip su-wide su-check" data-k="brtauto"><span data-f="brtauto">[X]</span> AUTO</div>' +
    '  <div class="su-btn su-chip su-wide su-check" data-k="litauto"><span data-f="litauto">[X]</span> CAB LIGHTS</div></div>' +
    '<div class="su-cid"><span class="su-k">VATSIM CID</span><span data-f="cid">-</span><div class="su-btn su-chip" data-k="cid">EDIT</div>' +
    '  <div class="su-keys" data-f="keys"></div></div>' +
    '<div class="su-msg" data-f="msg"></div>' +
    "</div>";

  function SetupView(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    root.innerHTML = HTML;
    this.f = {};
    var fs = root.querySelectorAll("[data-f]");
    for (var i = 0; i < fs.length; i++) this.f[fs[i].getAttribute("data-f")] = fs[i];
    this.step = 1;
    this.site = null;
    this.data = null;
    this.tgt = null;
    this.msg = "";
    this.cidEdit = null;     // digits typed so far while editing
    this.preview = null;     // the cab's position in the browser preview (nothing moves there)
    var self = this;
    var btns = root.querySelectorAll("[data-k]");
    for (var j = 0; j < btns.length; j++) {
      (function (b) {
        b.addEventListener("mouseup", function (e) { if (e && e.stopPropagation) e.stopPropagation(); self.key(b.getAttribute("data-k")); });
      })(btns[j]);
    }
    if (typeof VatflowPlace !== "undefined") VatflowPlace.onState(function (state, msg) { self.say(msg); });
  }

  SetupView.prototype.start = function () {
    var self = this;
    VatflowSite.resolve(function (s) {
      self.site = s;
      self.refreshTarget();
      VatflowSite.loadData(function (d, err) {
        self.data = d;
        if (err) self.say("NO MAP DATA: " + err.message);
        self.refreshTarget();
      });
    });
  };

  SetupView.prototype.refreshTarget = function () {
    if (!this.site) return;
    this.tgt = VatflowPlace.target(this.site.icao, this.site, this.data);
  };

  SetupView.prototype.say = function (m) { this.msg = m || ""; this.msgAt = Date.now(); };

  /** Where the cab is: the sim's position, or (preview) the one we pretend to have. */
  SetupView.prototype.cab = function () {
    return VatflowPlace.here() || this.preview || (this.tgt && this.tgt.pos) || null;
  };

  SetupView.prototype.goTo = function (pos, small) {
    if (typeof SimVar === "undefined") { this.preview = pos; this.say("PREVIEW: NOTHING MOVES OUTSIDE THE SIM"); return; }
    VatflowPlace.place(pos, small);
  };

  SetupView.prototype.key = function (k) {
    var icao = this.site && this.site.icao;
    if (this.cidEdit !== null && k.indexOf("n") === 0) { this.cidKey(k.slice(1)); return; }
    if (k.indexOf("step") === 0) { this.step = +k.slice(4); return; }
    if (k === "cid") { this.cidEdit = this.cidEdit === null ? "" : null; return; }
    if (this.brightKey(k)) return;
    if (!icao || icao === "----") { this.say("NO AIRPORT FOUND NEAR THE CAB"); return; }
    if (k === "place") {
      this.refreshTarget();
      if (this.tgt) this.goTo(this.tgt.pos, false);
      return;
    }
    if (k === "release") { if (typeof SimVar !== "undefined") VatflowPlace.release(); else this.say("RELEASED (PREVIEW)"); return; }
    if (k === "save") {
      var cur = this.cab();
      if (!cur) return;
      VatflowPlace.save(icao, cur);
      this.refreshTarget();
      this.say("SAVED FOR " + icao + ": " + this.fmt(cur));
      return;
    }
    if (k === "forget") {
      VatflowPlace.forget(icao);
      this.refreshTarget();
      this.say("SAVED SPOT FORGOTTEN - NOW USING " + (this.tgt ? this.tgt.src : "-"));
      return;
    }
    if (k === "auto") { VatflowStore.set("AUTO_PLACE", !this.auto()); return; }
    var s = STEPS[this.step], base = this.cab();
    if (!base) return;
    var mv = {
      fwd: [s[0], 0, 0, 0], back: [-s[0], 0, 0, 0], left: [0, -s[0], 0, 0], right: [0, s[0], 0, 0],
      up: [0, 0, s[0] * 2, 0], down: [0, 0, -s[0] * 2, 0], tl: [0, 0, 0, -s[1]], tr: [0, 0, 0, s[1]]
    }[k];
    if (mv) this.goTo(VatflowPlace.move(base, mv[0], mv[1], mv[2], mv[3]), true);
  };

  /**
   * Brightness row: DIMMER / BRIGHTER move the ALL screens knob (L:VATFLOW_DIM_ALL, 0 .. 90 =
   * darkest), AUTO dims the screens at night, CAB LIGHTS switches the ceiling lights off and
   * the console lights on at night (common/dimmer.js). The AUTO choices are kept.
   */
  SetupView.prototype.brightKey = function (k) {
    var sim = typeof SimVar !== "undefined";
    if (k === "dim" || k === "bright") {
      var v = sim ? SimVar.GetSimVarValue("L:VATFLOW_DIM_ALL", "number") || 0 : (this.dimAll || 0);
      v = Math.max(0, Math.min(90, Math.round((v + (k === "dim" ? 10 : -10)) / 10) * 10));
      if (sim) SimVar.SetSimVarValue("L:VATFLOW_DIM_ALL", "number", v); else this.dimAll = v;
      return true;
    }
    if (k === "brtauto" || k === "litauto") {
      var key = k === "brtauto" ? "DIM_AUTO" : "LIGHTS_AUTO", on = VatflowStore.get(key, true) === false;
      VatflowStore.set(key, on);
      if (sim) SimVar.SetSimVarValue(k === "brtauto" ? "L:VATFLOW_DIM_MANUAL" : "L:VATFLOW_LIGHTS_MANUAL", "number", on ? 0 : 1);
      this.say(k === "brtauto" ? (on ? "SCREENS DIM BY THEMSELVES AT NIGHT" : "SCREENS: KNOBS ONLY")
        : (on ? "CAB LIGHTS: CONSOLE LIGHTS AT NIGHT, CEILING BY DAY (WITHIN 10 S)" : "CAB LIGHTS: ALWAYS ON"));
      return true;
    }
    return false;
  };

  SetupView.prototype.auto = function () { return VatflowStore.get("AUTO_PLACE", true) !== false; };

  SetupView.prototype.cidKey = function (d) {
    if (d === "ok") {
      VatflowStore.set("CID", this.cidEdit);
      if (this.cfg.idst) this.cfg.idst.cid = this.cidEdit;
      if (typeof SimVar !== "undefined") SimVar.SetSimVarValue("L:VATFLOW_CID_CHANGED", "number", Date.now() / 1000);
      this.say(this.cidEdit ? "CID " + this.cidEdit + " SAVED" : "CID CLEARED");
      this.cidEdit = null;
    } else if (d === "clr") this.cidEdit = "";
    else if (this.cidEdit.length < 8) this.cidEdit += d;
  };

  SetupView.prototype.fmt = function (p) {
    if (!p) return "-";
    return p.lat.toFixed(6) + "  " + p.lon.toFixed(6) + "   FLOOR " + Math.round(p.floorFtMsl) + " FT MSL   FACING " +
      VatflowFeed.pad(Math.round(p.headingTrue) % 360, 3) + " T";
  };

  SetupView.prototype.render = function () {
    var f = this.f, site = this.site, st = typeof SimVar !== "undefined" ? VatflowPlace.state() : 0;
    var z = VatflowDraw.zulu(VatflowDraw.zuluNow());
    f.zulu.textContent = z.hh + z.mm + "Z";
    f.apt.textContent = site ? site.icao + "  " + (site.name || "") : "----";
    var state;
    if (!site) state = "LOCATING AIRPORT...";
    else if (VatflowPlace.busy()) state = "MOVING THE CAB...";
    else if (st === 1) state = "IN THE TOWER - FROZEN" + (VatflowPlace.method() === 2 ? " (SLEW)" : "");
    else if (st === 2) state = "RELEASED - THE CAB IS FREE TO MOVE";
    else state = typeof SimVar === "undefined" ? "BROWSER PREVIEW" : "NOT IN THE TOWER YET - PRESS PLACE IN TOWER";
    f.state.textContent = state;
    f.state.className = "su-state" + (st === 1 ? " ok" : "");
    f.src.textContent = this.tgt ? this.tgt.src : (site ? "LOADING..." : "-");
    f.target.textContent = this.tgt ? this.fmt(this.tgt.pos) : "-";
    var cur = this.cab();
    var off = "";
    if (cur && this.tgt) {
      var e = VatflowPlace.error(this.tgt.pos, cur);
      off = "   (" + (e.distM < 0.3 && Math.abs(e.up) < 0.5 && Math.abs(e.turn) < 0.5 ? "ON TARGET" :
        Math.round(e.fwd * 10) / 10 + " M FWD, " + Math.round(e.right * 10) / 10 + " M RIGHT, " + Math.round(e.up) + " FT UP, " + Math.round(e.turn) + " DEG") + ")";
    }
    f.now.textContent = (VatflowPlace.here() ? this.fmt(cur) : "-") + (VatflowPlace.here() ? off : "");
    var s = STEPS[this.step];
    f.step.textContent = "- STEP " + s[0] + " M / " + s[0] * 2 + " FT / " + s[1] + " DEG";
    var chips = this.root.querySelectorAll(".su-chip[data-k^=step]");
    for (var i = 0; i < chips.length; i++) chips[i].className = "su-btn su-chip" + (i === this.step ? " on" : "");
    f.auto.textContent = this.auto() ? "[X]" : "[ ]";
    var sim = typeof SimVar !== "undefined", dimAuto = VatflowStore.get("DIM_AUTO", true) !== false;
    var dimAll = sim ? SimVar.GetSimVarValue("L:VATFLOW_DIM_ALL", "number") || 0 : (this.dimAll || 0);
    var night = sim ? SimVar.GetSimVarValue("L:VATFLOW_NIGHT", "number") || 0 : 0;
    var pct = Math.round(VatflowDimmer.level(dimAll, 0) * (dimAuto ? VatflowDimmer.autoFactor(night) : 1) * 100);
    f.brt.textContent = pct + "%" + (night >= 50 ? " NIGHT" : night > 0 ? " DUSK" : " DAY");
    f.brtauto.textContent = dimAuto ? "[X]" : "[ ]";
    f.litauto.textContent = VatflowStore.get("LIGHTS_AUTO", true) !== false ? "[X]" : "[ ]";
    var cid = VatflowStore.get("CID", "");
    f.cid.textContent = this.cidEdit !== null ? (this.cidEdit || "_") + "  (TYPE YOUR CID, THEN OK)" : (cid || "NOT SET - NEEDED TO ISSUE IDST RELEASES");
    var keys = "";
    if (this.cidEdit !== null) {
      "1234567890".split("").forEach(function (d) { keys += '<div class="su-btn su-num" data-n="' + d + '">' + d + "</div>"; });
      keys += '<div class="su-btn su-num" data-n="clr">CLR</div><div class="su-btn su-num su-go" data-n="ok">OK</div>';
    }
    if (keys !== this.lastKeys) {
      f.keys.innerHTML = keys;
      this.lastKeys = keys;
      var self = this, nb = f.keys.querySelectorAll("[data-n]");
      for (var j = 0; j < nb.length; j++) {
        (function (b) {
          b.addEventListener("mouseup", function (e) { if (e && e.stopPropagation) e.stopPropagation(); self.key("n" + b.getAttribute("data-n")); });
        })(nb[j]);
      }
    }
    if (this.msg && Date.now() - this.msgAt > 15000) this.msg = "";
    f.msg.textContent = this.msg;
  };

  SetupView.MONTHS = MONTHS;
  return SetupView;
})();
