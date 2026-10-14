/*
 * VATFLOW Tower Cab - voice switch panel on the console (screen $SCREEN_VSCS).
 * A grid of green line/frequency keys like the cab's touch panel. A key lights up
 * while that position (matched by callsign) is online on VATSIM.
 */
var VscsView = (function () {
  // label lines, callsign pattern that lights the key
  var KEYS = [
    ["LC", "119.100", /^DCA_(?:\w+_)?TWR$/], ["GC", "121.700", /^DCA_(?:\w+_)?GND$/], ["CD", "128.250", /^DCA_(?:\w+_)?DEL$/],
    ["ATIS", "132.650", /^KDCA_ATIS$/], ["PCT", "APP", /^PCT_(?:\w+_)?APP$/],
    ["PCT", "DEP", /^PCT_(?:\w+_)?DEP$/], ["ZDC", "CTR", /^DC_(?:\w+_)?CTR$/], ["ADW", "TWR", /^ADW_(?:\w+_)?TWR$/],
    ["IAD", "TWR", /^IAD_(?:\w+_)?TWR$/], ["BWI", "TWR", /^BWI_(?:\w+_)?TWR$/],
    ["DAA", "TWR", /^DAA_(?:\w+_)?TWR$/], ["TMU", "ZDC", /^DC_(?:\w+_)?TMU$/], ["FD", "", null], ["SUP", "", null], ["CIC", "", null],
    ["OVR", "", null], ["", "", null], ["HL", "", null], ["RLS", "", null], ["MON", "", null],
    ["", "", null], ["", "", null], ["RCV", "ALL", null], ["XMT", "", null], ["", "", null]
  ];

  function VscsView(root) {
    this.grid = root.querySelector("#vs-grid");
    this.online = [];
    this.render();
  }
  VscsView.prototype.setFeed = function (feed) {
    this.online = ((feed && feed.controllers) || []).map(function (c) { return c.callsign; })
      .concat(((feed && feed.atis) || []).map(function (a) { return a.callsign; }));
    this.render();
  };
  VscsView.prototype.render = function () {
    var html = "", on = this.online;
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i], lit = false;
      if (k[2]) for (var j = 0; j < on.length; j++) if (k[2].test(on[j])) lit = true;
      html += '<div class="vs-key' + (lit ? " on" : "") + (k[0] ? "" : " blank") + '">' + k[0] + "<br>" + k[1] + "</div>";
    }
    if (html !== this.last) { this.grid.innerHTML = html; this.last = html; }
  };
  return VscsView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowVscs extends BaseInstrument {
    get templateID() { return "VatflowVscs"; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      var view = this.view = new VscsView(this.querySelector("#vs-root"));
      var cfg = { feedUrl: VATFLOW_TWR.feedUrl, feedRefreshSec: 60 };
      (function tick() {
        VatflowFeed.httpGet(cfg.feedUrl, function (err, text) {
          if (!err) { try { view.setFeed(JSON.parse(text)); } catch (e) { /* keep last */ } }
          setTimeout(tick, cfg.feedRefreshSec * 1000);
        });
      })();
    }
    Update() {
      super.Update();
      this.dim();
    }
  }
  registerInstrument("vatflow-vscs", VatflowVscs);
}
