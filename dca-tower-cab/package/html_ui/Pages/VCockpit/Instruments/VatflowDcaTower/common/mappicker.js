/*
 * VATFLOW Tower Cab - MAPS button for the DBRITE and ASDE-X: turns the ARTCC's video maps
 * (common/vnas.js) on and off, like a STARS map selector. The choice is kept per airport
 * (VatflowStore "VMAPS_<app>_<ICAO>"). Presets, named after the facility's runway
 * configurations (WEST, EAST ...), store a set of maps: tap SAVE, then a preset, to store
 * what is on now; tap a preset to switch to its maps.
 *
 * opts: { app, icao, title, items: [{id, label}], multi, defaults: [ids], presets: [names],
 *         onChange(ids), note }
 */
var VatflowMapPicker = (function () {
  var ROWS = 24, COLS = 3;

  function MapPicker(host, opts) {
    this.host = host;
    this.o = opts;
    this.key = "VMAPS_" + opts.app + "_" + opts.icao;
    var saved = VatflowStore.get(this.key, null);
    this.sel = saved || (opts.defaults || []).slice();
    this.presets = VatflowStore.get("VPRESETS_" + opts.app + "_" + opts.icao, {});
    this.saveMode = false;
    this.page = 0;
    this.status = "";
    var doc = host.ownerDocument || document;
    this.doc = doc;
    this.tab = this.el("div", "position:absolute;right:90px;bottom:0;width:86px;height:34px;background:#1b2a3a;" +
      "border:2px solid #35506b;color:#cfe0f0;font:bold 18px monospace;display:flex;align-items:center;" +
      "justify-content:center;z-index:900;opacity:0.85;", "MAPS");
    this.panel = this.el("div", "position:absolute;left:0;top:0;right:0;bottom:0;background:rgba(6,10,15,0.97);" +
      "z-index:950;display:none;box-sizing:border-box;padding:14px 18px;font-family:monospace;color:#dfe7ef;");
    var self = this;
    this.on(this.tab, function () { self.show(true); });
  }

  MapPicker.prototype.el = function (tag, css, text) {
    var e = this.doc.createElement(tag);
    e.style.cssText = css;
    if (text) e.textContent = text;
    this.host.appendChild(e);
    return e;
  };

  MapPicker.prototype.on = function (e, fn) {
    e.addEventListener("mouseup", function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); fn(); });
  };

  MapPicker.prototype.selected = function () { return this.sel.slice(); };

  MapPicker.prototype.set = function (ids) {
    this.sel = ids.slice();
    VatflowStore.set(this.key, this.sel);
    if (this.o.onChange) this.o.onChange(this.selected());
    if (this.panel.style.display !== "none") this.render();
  };

  MapPicker.prototype.toggle = function (id) {
    var i = this.sel.indexOf(id), ids = this.sel.slice();
    if (!this.o.multi) ids = i >= 0 ? [] : [id];
    else if (i >= 0) ids.splice(i, 1);
    else ids.push(id);
    this.set(ids);
  };

  MapPicker.prototype.preset = function (name) {
    if (this.saveMode) {
      this.presets[name] = this.selected();
      VatflowStore.set("VPRESETS_" + this.o.app + "_" + this.o.icao, this.presets);
      this.saveMode = false;
      this.status = "SAVED " + this.sel.length + " MAPS AS " + name;
      this.render();
    } else if (this.presets[name]) {
      this.status = name;
      this.set(this.presets[name]);
    } else {
      this.status = name + " IS EMPTY - TURN MAPS ON, TAP SAVE, THEN " + name;
      this.render();
    }
  };

  MapPicker.prototype.setStatus = function (s) {
    this.status = s;
    if (this.panel.style.display !== "none") this.renderStatus();
  };

  MapPicker.prototype.show = function (on) {
    this.panel.style.display = on ? "block" : "none";
    if (on) this.render();
  };

  function btn(text, on, w) {
    return "display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:36px;" +
      "padding:0 12px;margin:0 8px 8px 0;font:bold 17px monospace;border:2px solid " + (on ? "#7fc8ff" : "#35506b") + ";" +
      "background:" + (on ? "#7fc8ff" : "#1b2a3a") + ";color:" + (on ? "#0a0f16" : "#e8f1fa") + ";" + (w ? "width:" + w + "px;" : "");
  }

  MapPicker.prototype.render = function () {
    var self = this, o = this.o, p = this.panel;
    p.innerHTML = "";
    var head = this.doc.createElement("div");
    head.style.cssText = "display:flex;align-items:center;font:bold 22px monospace;border-bottom:2px solid #23384d;padding-bottom:8px;margin-bottom:8px;";
    head.innerHTML = '<span style="color:#f5a623;margin-right:16px">VIDEO MAPS</span><span style="color:#7fc8ff;flex:1;white-space:nowrap;overflow:hidden">' +
      esc(o.title || "") + "</span>";
    p.appendChild(head);
    var bar = this.doc.createElement("div");
    p.appendChild(bar);
    var add = function (parent, text, on, fn, w) {
      var b = self.doc.createElement("div");
      b.style.cssText = btn(text, on, w);
      b.textContent = text;
      self.on(b, fn);
      parent.appendChild(b);
      return b;
    };
    add(bar, "CLOSE", false, function () { self.show(false); });
    if (o.multi) add(bar, "ALL OFF", false, function () { self.set([]); });
    var names = o.presets || [];
    if (names.length && o.multi) {
      add(bar, this.saveMode ? "SAVE: TAP A PRESET" : "SAVE", this.saveMode, function () { self.saveMode = !self.saveMode; self.render(); });
      for (var n = 0; n < names.length; n++) {
        (function (name) {
          add(bar, name + (self.presets[name] ? "" : " -"), false, function () { self.preset(name); });
        })(names[n]);
      }
    }
    var items = o.items || [];
    var per = ROWS * COLS, pages = Math.max(1, Math.ceil(items.length / per));
    if (this.page >= pages) this.page = 0;
    if (pages > 1) {
      add(bar, "PAGE " + (this.page + 1) + "/" + pages, false, function () { self.page = (self.page + 1) % pages; self.render(); });
    }
    this.statusEl = this.doc.createElement("div");
    this.statusEl.style.cssText = "height:22px;color:#ffd166;font-size:16px;white-space:nowrap;overflow:hidden;";
    p.appendChild(this.statusEl);
    this.renderStatus();
    var grid = this.doc.createElement("div");
    grid.style.cssText = "display:flex;flex-direction:column;flex-wrap:wrap;height:" + (ROWS * 23) + "px;align-content:flex-start;";
    p.appendChild(grid);
    if (!items.length) {
      grid.style.height = "auto";
      grid.innerHTML = '<div style="color:#7f93a8;font-size:18px;white-space:normal;line-height:1.5">' + esc(o.note || "NO MAPS") + "</div>";
      return;
    }
    var page = items.slice(this.page * per, (this.page + 1) * per);
    page.forEach(function (it) {
      var on = self.sel.indexOf(it.id) >= 0;
      var row = self.doc.createElement("div");
      row.style.cssText = "box-sizing:border-box;width:" + Math.floor(984 / COLS) + "px;height:23px;line-height:23px;font-size:15px;" +
        "white-space:nowrap;overflow:hidden;padding-left:6px;" + (on ? "background:#14532d;color:#b6f5c8;" : "color:#cfd8e2;");
      row.textContent = (on ? "[X] " : "[ ] ") + it.label;
      self.on(row, function () { self.toggle(it.id); });
      grid.appendChild(row);
    });
  };

  MapPicker.prototype.renderStatus = function () {
    if (this.statusEl) this.statusEl.textContent = this.status || (this.sel.length + " ON");
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  return MapPicker;
})();
