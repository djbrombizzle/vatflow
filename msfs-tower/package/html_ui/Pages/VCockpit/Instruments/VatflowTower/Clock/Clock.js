/*
 * VATFLOW Tower Cab - red LED Zulu clock on the console (screen $SCREEN_CLOCK).
 * Shows the sim's Zulu time (the PC clock in the browser preview).
 */
var ClockView = (function () {
  function ClockView(root) { this.el = root.querySelector("#ck-time"); }
  ClockView.prototype.render = function (zuluSec) {
    var pad = VatflowFeed.pad, z = Math.floor(zuluSec);
    var s = pad(Math.floor(z / 3600) % 24, 2) + ":" + pad(Math.floor(z / 60) % 60, 2) + ":" + pad(z % 60, 2);
    if (this.el.textContent !== s) this.el.textContent = s;
  };
  return ClockView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowClock extends BaseInstrument {
    get templateID() { return "VatflowClock"; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.view = new ClockView(this.querySelector("#ck-root"));
    }
    Update() {
      super.Update();
      this.view.render(SimVar.GetSimVarValue("E:ZULU TIME", "seconds"));
    }
  }
  registerInstrument("vatflow-clock", VatflowClock);
}
