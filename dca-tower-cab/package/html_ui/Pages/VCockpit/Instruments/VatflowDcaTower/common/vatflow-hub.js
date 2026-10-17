/*
 * VATFLOW Tower Cab - read-only connection to the VATFLOW hub (the same WebSocket
 * vatflow.io's Airport TMU / APT Dashboard and VATSMART pages listen to): Airport TMU
 * programs (AAR, MIT / trail, per-gate rules, expected demand), EDCTs, ground stops and
 * restrictions. No login: it only listens for {type: "state"}; nothing is ever sent.
 *
 *   VatflowHub.listen(function (state) { ... })   state = {rates, edcts, groundStops, restrictions}
 *   VatflowHub.status()                           "ok" | "wait" | "bad"
 */
var VatflowHub = (function () {
  var URL = "wss://vatflow-hub-production.up.railway.app";
  var listeners = [], state = null, status = "wait", retry = 0, started = false;

  function connect() {
    var ws;
    try { ws = new WebSocket(URL); } catch (e) { status = "bad"; return; }
    ws.onopen = function () { retry = 0; };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || m.type !== "state") return;
      state = { rates: m.rates || {}, edcts: m.edcts || {}, groundStops: m.groundStops || {}, restrictions: m.restrictions || {} };
      status = "ok";
      for (var i = 0; i < listeners.length; i++) { try { listeners[i](state); } catch (e) { /* a screen's problem */ } }
    };
    ws.onclose = function () {
      status = retry > 2 ? "bad" : "wait";
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 2000 * retry);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* closing anyway */ } };
  }

  return {
    listen: function (fn) {
      listeners.push(fn);
      if (state) fn(state);
      if (!started && typeof WebSocket !== "undefined") { started = true; connect(); }
      if (typeof WebSocket === "undefined") status = "bad";
    },
    status: function () { return status; },
    state: function () { return state; }
  };
})();
