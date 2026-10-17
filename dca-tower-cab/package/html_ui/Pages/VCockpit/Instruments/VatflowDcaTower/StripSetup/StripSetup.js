/*
 * VATFLOW Tower Cab - STRIP BAYS screen (an app on any 1024x768 cab screen, via MENU).
 * For each of the three strip bays: its name (shown on the position sign under it),
 * where it sits (console face and how far along it) and up to six separators, typed on
 * the on-screen keyboard, each in one of the bay's three columns (C1 / C2 / C3). Also which bay / section new strips print into, and AUTO DROP.
 * Kept per airport (common/strips.js), so each tower can have its own layout.
 */
var StripSetupView = (function () {
  var MAXLEN = 16;
  var KEYS = ["1234567890", "QWERTYUIOP", "ASDFGHJKL/", "ZXCVBNM-.#"];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function StripSetupView(root) {
    this.root = root;
    this.icao = null;
    this.cfg = null;
    this.edit = null;          // {bay, what: "name" | "sep", idx, text}
    this.msg = "";
    var self = this;
    root.addEventListener("mouseup", function (e) {
      var t = e.target;
      while (t && t !== root && !(t.getAttribute && t.getAttribute("data-k"))) t = t.parentNode;
      if (t && t !== root) { if (e.stopPropagation) e.stopPropagation(); self.key(t.getAttribute("data-k")); }
    });
  }

  StripSetupView.prototype.start = function () {
    var self = this;
    VatflowSite.resolve(function (s) { self.icao = s.icao; self.cfg = VatflowStrips.config(s.icao); self.render(); });
  };

  StripSetupView.prototype.save = function (msg) {
    VatflowStrips.saveConfig(this.icao, this.cfg);
    this.msg = msg || "";
    this.render();
  };

  StripSetupView.prototype.key = function (k) {
    if (!this.cfg) return;
    var p = k.split(":"), cmd = p[0], b = +p[1], i = +p[2], cfg = this.cfg, bay = cfg.bays[b];
    var S = VatflowStrips;
    if (this.edit && cmd === "kb") {
      var e = this.edit, v = p.slice(1).join(":");
      if (v === "OK") {
        var text = e.text.replace(/\s+/g, " ").trim();
        if (e.what === "name") cfg.bays[e.bay].name = text || cfg.bays[e.bay].name;
        else if (text) {
          var eb = cfg.bays[e.bay];
          if (e.idx < eb.seps.length) eb.seps[e.idx] = text;
          else { eb.cols = VatflowStrips.cols(eb).concat([VatflowStrips.freeCol(eb)]); eb.seps.push(text); }
        }
        this.edit = null;
        this.save(text ? "SAVED: " + text : "");
        return;
      }
      if (v === "CANCEL") this.edit = null;
      else if (v === "DEL") e.text = e.text.slice(0, -1);
      else if (v === "CLR") e.text = "";
      else if (v === "SPACE") { if (e.text.length < MAXLEN) e.text += " "; }
      else if (e.text.length < MAXLEN) e.text += v;
      this.render();
      return;
    }
    if (cmd === "name") { this.edit = { bay: b, what: "name", text: bay.name }; this.render(); return; }
    if (cmd === "sep") { this.edit = { bay: b, what: "sep", idx: i, text: bay.seps[i] || "" }; this.render(); return; }
    if (cmd === "sepcol") {
      bay.cols = S.cols(bay);
      bay.cols[i] = (bay.cols[i] + 1) % S.COLS;
      this.save("SEPARATOR " + bay.seps[i] + " NOW IN COLUMN " + (bay.cols[i] + 1));
      return;
    }
    if (cmd === "sepdel") {
      bay.cols = S.cols(bay);
      bay.cols.splice(i, 1);
      bay.seps.splice(i, 1);
      if (cfg.newBay === b && cfg.newSec >= Math.max(1, bay.seps.length)) cfg.newSec = Math.max(0, bay.seps.length - 1);
      this.save("SEPARATOR REMOVED (ITS STRIPS MOVE UP INTO THE ONE ABOVE)");
      return;
    }
    if (cmd === "face") {
      var f = S.FACES, at = f.indexOf(bay.face);
      bay.face = f[(at + (i > 0 ? 1 : f.length - 1)) % f.length];
      this.save();
      return;
    }
    if (cmd === "slide") {
      bay.slide = Math.max(-S.SLIDE_MAX, Math.min(S.SLIDE_MAX, Math.round(((bay.slide || 0) + i * 0.1) * 10) / 10));
      this.save();
      return;
    }
    if (cmd === "newbay") { cfg.newBay = (cfg.newBay + (i > 0 ? 1 : 2)) % 3; cfg.newSec = 0; this.save(); return; }
    if (cmd === "newsec") {
      var n = Math.max(1, cfg.bays[cfg.newBay].seps.length);
      cfg.newSec = (cfg.newSec + (i > 0 ? 1 : n - 1)) % n;
      this.save();
      return;
    }
    if (cmd === "auto") { cfg.autoDrop = !cfg.autoDrop; this.save(); return; }
    if (cmd === "reset") { this.cfg = VatflowStrips.defaults(); this.save("BAYS RESET TO THE DEFAULT TMU / GROUND / LOCAL LAYOUT"); return; }
  };

  StripSetupView.prototype.render = function () {
    var cfg = this.cfg, S = VatflowStrips, h = "";
    var z = VatflowDraw.zulu(VatflowDraw.zuluNow());
    h += '<div class="ss-top"><span class="ss-title">STRIP BAYS</span><span class="ss-apt">' + esc(this.icao || "----") +
      '</span><span class="ss-zulu">' + z.hh + z.mm + "Z</span></div>";
    if (!cfg) { this.root.innerHTML = '<div class="ss-root">' + h + "</div>"; return; }
    h += '<div class="ss-cols">';
    for (var b = 0; b < 3; b++) {
      var bay = cfg.bays[b];
      h += '<div class="ss-col"><div class="ss-bayno">BAY ' + (b + 1) + "</div>";
      h += '<div class="ss-row"><span class="ss-name">' + esc(bay.name) + '</span><span class="ss-btn" data-k="name:' + b + '">EDIT</span></div>';
      h += '<div class="ss-lbl">WHERE (CONSOLE)</div>';
      h += '<div class="ss-row"><span class="ss-btn ss-arr" data-k="face:' + b + ':-1">◀</span><span class="ss-val">' +
        S.FACE_NAMES[bay.face] + '</span><span class="ss-btn ss-arr" data-k="face:' + b + ':1">▶</span></div>';
      var sl = bay.slide || 0;
      h += '<div class="ss-row"><span class="ss-btn ss-arr" data-k="slide:' + b + ':-1">◀</span><span class="ss-val">' +
        (sl === 0 ? "CENTRE" : Math.abs(sl).toFixed(1) + " M " + (sl < 0 ? "LEFT" : "RIGHT")) +
        '</span><span class="ss-btn ss-arr" data-k="slide:' + b + ':1">▶</span></div>';
      h += '<div class="ss-lbl">SEPARATORS (UP TO ' + S.MAX_SEPS + ") - C = COLUMN</div>";
      var bc = S.cols(bay);
      for (var i = 0; i < bay.seps.length; i++) {
        h += '<div class="ss-row ss-sep"><span class="ss-sepname" data-k="sep:' + b + ":" + i + '">' + (i + 1) + " " + esc(bay.seps[i]) +
          '</span><span class="ss-btn ss-colb" data-k="sepcol:' + b + ":" + i + '">C' + (bc[i] + 1) + '</span>' +
          '<span class="ss-btn ss-x" data-k="sepdel:' + b + ":" + i + '">✕</span></div>';
      }
      if (bay.seps.length < S.MAX_SEPS) h += '<div class="ss-row"><span class="ss-btn ss-add" data-k="sep:' + b + ":" + bay.seps.length + '">+ ADD SEPARATOR</span></div>';
      h += "</div>";
    }
    h += "</div>";
    var nb = cfg.bays[cfg.newBay], secName = nb.seps.length ? nb.seps[Math.min(cfg.newSec, nb.seps.length - 1)] : "(WHOLE BAY)";
    h += '<div class="ss-foot"><span class="ss-lbl2">NEW STRIPS PRINT INTO</span>' +
      '<span class="ss-btn ss-arr" data-k="newbay:0:-1">◀</span><span class="ss-val2">' + esc(nb.name) + '</span><span class="ss-btn ss-arr" data-k="newbay:0:1">▶</span>' +
      '<span class="ss-btn ss-arr" data-k="newsec:0:-1">◀</span><span class="ss-val2">' + esc(secName) + '</span><span class="ss-btn ss-arr" data-k="newsec:0:1">▶</span></div>';
    h += '<div class="ss-foot"><span class="ss-btn ss-check" data-k="auto">' + (cfg.autoDrop ? "[X]" : "[ ]") +
      ' AUTO DROP STRIPS ONCE AIRBORNE</span><span class="ss-btn" data-k="reset">RESET LAYOUT</span></div>';
    if (this.edit) {
      var e = this.edit;
      h += '<div class="ss-kb"><div class="ss-kbtitle">' + (e.what === "name" ? "BAY " + (e.bay + 1) + " NAME (POSITION SIGN)" :
        "BAY " + (e.bay + 1) + " SEPARATOR " + (e.idx + 1)) + '</div><div class="ss-kbtext">' + esc(e.text) + '<span class="ss-caret">_</span></div>';
      for (var r = 0; r < KEYS.length; r++) {
        h += '<div class="ss-kbrow">';
        for (var c = 0; c < KEYS[r].length; c++) h += '<span class="ss-key" data-k="kb:' + KEYS[r][c] + '">' + KEYS[r][c] + "</span>";
        h += "</div>";
      }
      h += '<div class="ss-kbrow"><span class="ss-key ss-wide" data-k="kb:SPACE">SPACE</span><span class="ss-key" data-k="kb:DEL">DEL</span>' +
        '<span class="ss-key" data-k="kb:CLR">CLR</span><span class="ss-key" data-k="kb:CANCEL">CANCEL</span><span class="ss-key ss-ok" data-k="kb:OK">OK</span></div></div>';
    }
    h += '<div class="ss-msg">' + esc(this.msg) + "</div>";
    this.root.innerHTML = '<div class="ss-root">' + h + "</div>";
  };

  return StripSetupView;
})();
